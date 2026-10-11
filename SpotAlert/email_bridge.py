"""Local Resend sender for the Chrome extension; credentials stay on this computer."""

import argparse
import getpass
import hmac
import json
import os
import re
import secrets
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

DEFAULT_CONFIG = Path('.env.resend')


def valid_email(value):
    return isinstance(value, str) and len(value) <= 254 and bool(re.fullmatch(r'[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', value))


def configure(path):
    recipient = input('Email address registered with Resend: ').strip()
    sender = input('Sender (Enter for onboarding@resend.dev): ').strip() or 'onboarding@resend.dev'
    api_key = getpass.getpass('Resend API key: ').strip()
    if not valid_email(sender) or not valid_email(recipient) or not api_key.startswith('re_'):
        raise ValueError('Enter valid email addresses and a Resend API key.')
    config = {'sender': sender, 'recipient': recipient, 'api_key': api_key, 'token': secrets.token_urlsafe(32)}
    # Refuse accidental credential overwrites.
    with open(path, 'x', opener=lambda name, flags: os.open(name, flags, 0o600)) as file:
        json.dump(config, file)
    print(f'Saved {path}. Paste this bridge token into SpotAlert: {config["token"]}')


class DeliveryError(Exception):
    """Sanitized provider error safe to display in the extension."""


def send_email(config, subject, body):
    payload = {'from': config['sender'], 'to': [config['recipient']], 'subject': subject, 'text': body}
    request = Request('https://api.resend.com/emails', json.dumps(payload).encode(), headers={
        'Authorization': 'Bearer ' + config['api_key'], 'Content-Type': 'application/json', 'User-Agent': 'SpotAlert/0.3',
    })
    try:
        with urlopen(request, timeout=15) as response:
            result = json.load(response)
            if not result.get('id'):
                raise DeliveryError('Resend did not confirm the email request.')
            return result['id']
    except HTTPError as error:
        messages = {
            401: 'Resend authentication failed. Check the API key in the bridge configuration.',
            403: 'Resend rejected the sender or recipient. The test sender can only email your Resend account address; other recipients need a verified domain.',
            422: 'Resend rejected the email. Check the configured sender and recipient.',
            429: 'Resend sending limit reached. Try again later.',
        }
        raise DeliveryError(messages.get(error.code, 'Resend rejected the email request. Check the Resend dashboard.')) from None
    except (OSError, ValueError):
        raise DeliveryError('Could not reach Resend. Check your internet connection and try again.') from None


def make_handler(config, send=send_email):
    sent = set()
    attempts = deque()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log message bodies, addresses or credentials.

        def respond(self, status, result):
            data = json.dumps(result).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
                return self.respond(403, {'error': 'Invalid bridge host.'})
            if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + config['token']).encode()):
                return self.respond(401, {'error': 'Check your bridge token.'})
            if self.path != '/send':
                return self.respond(404, {'error': 'Unknown endpoint.'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 20000:
                    raise ValueError()
                data = json.loads(self.rfile.read(length))
                subject, body, message_id = data['subject'], data['body'], data['id']
                if not isinstance(subject, str) or not 0 < len(subject) <= 200 or '\n' in subject or '\r' in subject:
                    raise ValueError()
                if not isinstance(body, str) or not 0 < len(body) <= 12000 or not isinstance(message_id, str) or not 0 < len(message_id) <= 200:
                    raise ValueError()
                if data.get('to') != config['recipient']:
                    return self.respond(400, {'error': 'Email destination must match the recipient configured in the email bridge.'})
            except (ValueError, KeyError, TypeError):
                return self.respond(400, {'error': 'Invalid email request.'})
            if message_id in sent:
                return self.respond(200, {'sent': True, 'duplicate': True})
            now = time.monotonic()
            while attempts and attempts[0] < now - 86400:
                attempts.popleft()
            if len(attempts) >= 100:
                return self.respond(429, {'error': 'Bridge daily limit reached (100 attempts). Try again tomorrow.'})
            attempts.append(now)
            try:
                send(config, subject, body)
            except DeliveryError as error:
                return self.respond(502, {'error': str(error)})
            except OSError:
                return self.respond(502, {'error': 'Email delivery failed. Check the connection and Resend dashboard.'})
            sent.add(message_id)
            if len(sent) > 1000:
                sent.clear()
                sent.add(message_id)
            return self.respond(200, {'sent': True})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--configure', action='store_true')
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--show-token', action='store_true', help='Print the local bridge token, not the Resend API key.')
    args = parser.parse_args()
    if args.configure:
        configure(args.config)
        return
    try:
        config = json.loads(args.config.read_text())
        if not all(config.get(key) for key in ['sender', 'recipient', 'api_key', 'token']):
            raise ValueError()
    except (OSError, ValueError):
        parser.error('Configure Resend first: python -m SpotAlert.email_bridge --configure')
    if args.show_token:
        print(config['token'])
        return
    server = HTTPServer(('127.0.0.1', 8766), make_handler(config))
    # Bound stalled clients, while keeping sends serialized for deduplication.
    original = server.get_request
    def get_request():
        sock, address = original()
        sock.settimeout(20)
        return sock, address
    server.get_request = get_request
    print('SpotAlert email bridge listening on 127.0.0.1:8766. Keep this terminal open.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
