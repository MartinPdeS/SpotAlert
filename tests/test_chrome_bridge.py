import json
import socket
import struct
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread

import pytest

from SpotAlert.chrome_bridge import BridgeStopped, ChromeExtensionSession
from SpotAlert.native_host import MAX_MESSAGE, encode_message, extension_id
from SpotAlert.profiles import (
    AvailabilityRule,
    FetchMode,
    MatchMode,
    RuleType,
    SiteProfile,
)


@pytest.fixture
def profile():
    return SiteProfile(
        name="ourdomain",
        url="https://thisisourdomain.securerc.co.uk/onlineleasing/floorplans.aspx",
        rule=AvailabilityRule(
            RuleType.CSS, ".availability", "Get Notified", MatchMode.NOT_EQUALS,
        ),
        fetch_mode=FetchMode.EXTENSION,
    )


@pytest.fixture
def bridge(monkeypatch):
    with TemporaryDirectory(prefix="sa-", dir="/private/tmp") as directory:
        path = Path(directory)
        monkeypatch.setattr("SpotAlert.chrome_bridge.bridge_directory", lambda: path)
        monkeypatch.setattr(ChromeExtensionSession, "_open_chrome", lambda _: None)
        yield path


def read_frame(connection):
    def read_exact(length):
        result = b""
        while len(result) < length:
            chunk = connection.recv(length - len(result))
            assert chunk
            result += chunk
        return result

    length = struct.unpack("=I", read_exact(4))[0]
    return json.loads(read_exact(length))


def reply_once(directory, url, texts):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(str(directory / "bridge.sock"))
        # Verify the server handles fragmented framing, not just whole packets.
        hello = encode_message({"type": "hello", "version": 1})
        connection.sendall(hello[:2])
        connection.sendall(hello[2:])
        request = read_frame(connection)
        assert request["type"] == "check"
        connection.sendall(encode_message({"id": request["id"], "url": url, "texts": texts}))
        connection.settimeout(2)
        assert connection.recv(1) == b""


@pytest.mark.parametrize("texts, available", [
    (["Get Notified"], False),
    (["Get Notified", "Apply Now"], True),
])
def test_extension_evaluates_normal_chrome_response(profile, bridge, texts, available):
    with ChromeExtensionSession(profile) as session:
        worker = Thread(target=reply_once, args=(bridge, profile.url, texts))
        worker.start()
        assert session.check().available is available
    worker.join(timeout=3)
    assert not worker.is_alive()
    assert not (bridge / "bridge.sock").exists()


def test_stopping_connection_wait_is_immediate(profile, bridge):
    stopped = Event()
    with ChromeExtensionSession(profile, stopped) as session:
        stopped.set()
        with pytest.raises(BridgeStopped):
            session.check()


def test_second_session_does_not_remove_first_socket(profile, bridge):
    with ChromeExtensionSession(profile):
        with pytest.raises(ValueError, match="Another SpotAlert"):
            with ChromeExtensionSession(profile):
                pass
        assert (bridge / "bridge.sock").exists()


@pytest.mark.parametrize("changes, error", [
    ({"url": "https://other.example.com"}, "OurDomain only"),
    ({"rule": AvailabilityRule(RuleType.JSON, "data.status", "Available")}, "not JSON"),
    ({"capture_on_available": True}, "do not support captures"),
])
def test_unsupported_profiles_fail_before_opening_chrome(profile, changes, error):
    with pytest.raises(ValueError, match=error):
        with ChromeExtensionSession(replace(profile, **changes)):
            pass


def test_bridge_rejects_oversized_response(profile, bridge):
    with ChromeExtensionSession(profile) as session:
        left, right = socket.socketpair()
        session._connection = left
        right.sendall(struct.pack("=I", MAX_MESSAGE + 1))
        with right, pytest.raises(ValueError, match="exceeds 1 MB"):
            session.check()


def test_bridge_rejects_redirect_away_from_listing(profile, bridge):
    with ChromeExtensionSession(profile) as session:
        worker = Thread(target=reply_once, args=(bridge, "https://other.example.com", ["Apply Now"]))
        worker.start()
        with pytest.raises(ValueError, match="navigated away"):
            session.check()
    worker.join(timeout=3)


def test_native_host_rejects_other_extension_origins():
    process = subprocess.run(
        [sys.executable, "-m", "SpotAlert.native_host", "chrome-extension://other/"],
        capture_output=True,
    )
    assert process.returncode == 1
    assert process.stdout == b""
    assert b"unexpected extension origin" in process.stderr


def test_extension_has_stable_id_and_restricted_permissions():
    from SpotAlert.native_host import EXTENSION_DIRECTORY

    manifest = json.loads((EXTENSION_DIRECTORY / "manifest.json").read_text())
    assert len(extension_id()) == 32
    assert all("a" <= character <= "p" for character in extension_id())
    assert manifest["host_permissions"] == [
        "https://thisisourdomain.securerc.co.uk/*",
        "https://southeast-thisisourdomain.securerc.co.uk/*",
        "https://api.resend.com/*",
        "https://canvas-world.securerc.co.uk/*",
        "https://www.canvas-world.com/*",
    ]
    # The optional applicant-profile folder uses the native helper; monitoring
    # itself still runs entirely inside Chrome.
    assert set(manifest["permissions"]) == {
        "storage", "nativeMessaging", "sidePanel", "scripting", "alarms", "tabs",
    }
    assert "sidePanel" in manifest["permissions"]


def test_native_host_relays_chrome_frames_in_both_directions(bridge):
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(bridge / "native-test.sock"))
    listener.listen(1)
    listener.settimeout(3)
    # Override only the socket location in the subprocess, avoiding user config.
    script = (
        "import sys; from pathlib import Path; import SpotAlert.native_host as host; "
        f"host.bridge_directory = lambda: Path({str(bridge)!r}); "
        "sys.argv = ['host', 'chrome-extension://' + host.extension_id() + '/']; "
        "raise SystemExit(host.main())"
    )
    (bridge / "native-test.sock").rename(bridge / "bridge.sock")
    process = subprocess.Popen(
        [sys.executable, "-c", script], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        with listener, listener.accept()[0] as connection:
            connection.settimeout(3)
            assert read_frame(connection) == {"type": "hello", "version": 1}
            command = {"type": "check", "id": "test"}
            packet = encode_message(command)
            connection.sendall(packet)
            assert process.stdout.read(len(packet)) == packet
            reply = {"id": "test", "texts": ["Get Notified"]}
            process.stdin.write(encode_message(reply))
            process.stdin.flush()
            assert read_frame(connection) == reply
        assert process.wait(timeout=3) == 0
        assert process.stderr.read() == b""
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def test_setup_registers_only_this_extension(monkeypatch, tmp_path):
    from SpotAlert.native_host import install_native_host

    monkeypatch.setattr("SpotAlert.native_host.Path.home", lambda: tmp_path)
    monkeypatch.setattr("SpotAlert.native_host.user_data_path", lambda _: tmp_path / "SpotAlert")
    monkeypatch.setattr("SpotAlert.native_host.sys.platform", "darwin")
    path = install_native_host()
    manifest = json.loads(path.read_text())
    assert manifest["allowed_origins"] == [f"chrome-extension://{extension_id()}/"]
    launcher = Path(manifest["path"])
    assert launcher.stat().st_mode & 0o700 == 0o700
    assert "-m SpotAlert.native_host" in launcher.read_text()


def test_refresh_acknowledgement_precedes_completed_result(profile, bridge):
    events = []

    def extension():
        with socket.socket(socket.AF_UNIX) as connection:
            connection.connect(str(bridge / "bridge.sock"))
            connection.sendall(encode_message({"type": "hello", "version": 1}))
            command = read_frame(connection)
            connection.sendall(encode_message({"id": command["id"], "type": "refreshing"}))
            connection.sendall(encode_message({"id": command["id"], "url": profile.url, "texts": ["Get Notified"]}))
            connection.settimeout(2)
            assert connection.recv(1) == b""

    with ChromeExtensionSession(profile, on_refresh=lambda: events.append("refreshing")) as session:
        worker = Thread(target=extension)
        worker.start()
        result = session.check()
        events.append("completed")
    worker.join(timeout=3)
    assert result.available is False
    assert events == ["refreshing", "completed"]
