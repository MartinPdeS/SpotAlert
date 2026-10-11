import json
from http.server import HTTPServer
from threading import Thread
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from SpotAlert.email_bridge import DeliveryError, configure, make_handler, send_email

CONFIG = {'sender': 'sender@gmail.com', 'recipient': 'recipient@gmail.com', 'api_key': 're_fake', 'token': 'test-token'}


def test_resend_uses_api_key_and_fixed_recipient():
    with patch('SpotAlert.email_bridge.urlopen') as http:
        from io import BytesIO
        http.return_value.__enter__.return_value = BytesIO(b'{"id":"email-123"}')
        assert send_email(CONFIG, 'SpotAlert', 'Studio · €900') == 'email-123'
        request = http.call_args.args[0]
        assert request.full_url == 'https://api.resend.com/emails'
        assert request.get_header('Authorization') == 'Bearer re_fake'
        payload = json.loads(request.data)
        assert payload['to'] == [CONFIG['recipient']]
        assert payload['text'] == 'Studio · €900'


def test_resend_errors_do_not_expose_provider_details():
    with patch('SpotAlert.email_bridge.urlopen', side_effect=HTTPError('https://api.resend.com/emails', 403, 'private details', {}, None)):
        try:
            send_email(CONFIG, 'SpotAlert', 'Test')
        except DeliveryError as error:
            assert 'verified domain' in str(error)
            assert 'private details' not in str(error)
        else:
            raise AssertionError('Provider error was ignored')


def test_bridge_auth_recipient_dedup_and_failures():
    send = MagicMock()
    server = HTTPServer(('127.0.0.1', 0), make_handler(CONFIG, send))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    def post(data, token='test-token'):
        request = Request(f'http://127.0.0.1:{server.server_port}/send', json.dumps(data).encode(), headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        try:
            response = urlopen(request, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())
    payload = {'id': 'arrival-1', 'to': CONFIG['recipient'], 'subject': 'Studio', 'body': 'Available'}
    try:
        assert post(payload, 'wrong')[0] == 401
        assert post({**payload, 'to': 'other@example.com'})[0] == 400
        assert post({**payload, 'subject': 'Bad\r\nBcc: other@example.com'})[0] == 400
        assert post(payload)[0] == 200
        assert post(payload)[1]['duplicate']
        send.assert_called_once()
        send.side_effect = DeliveryError('Resend authentication failed. Check the API key.')
        status, result = post({**payload, 'id': 'arrival-2'})
        assert status == 502
        assert 'API key' in result['error']
        assert 'private details' not in result['error']
        send.side_effect = None
        assert post({**payload, 'id': 'arrival-2'})[0] == 200
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_configuration_keeps_credentials_in_private_file(tmp_path):
    path = tmp_path / '.env.gmail'
    with patch('builtins.input', side_effect=['sender@gmail.com', '']), patch('getpass.getpass', return_value='re_fake'), patch('builtins.print'):
        configure(path)
    config = json.loads(path.read_text())
    assert config['recipient'] == 'sender@gmail.com'
    assert config['api_key'] == 're_fake'
    assert config['sender'] == 'onboarding@resend.dev'
    assert len(config['token']) >= 32
    assert path.stat().st_mode & 0o777 == 0o600
