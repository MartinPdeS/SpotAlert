"""Check a tab in the user's normal Chrome profile through the extension."""

import json
import socket
import struct
import subprocess
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict
from threading import Event
from urllib.parse import urlsplit

from SpotAlert.checker import AvailabilityResult, _matches_rule
from SpotAlert.native_host import MAX_MESSAGE, bridge_directory, encode_message
from SpotAlert.profiles import RuleType, SiteProfile

OURDOMAIN_ORIGIN = "https://thisisourdomain.securerc.co.uk"


class BridgeStopped(ValueError):
    """The user stopped a pending extension operation."""


class ChromeExtensionSession:
    """Own one TUI bridge; Chrome and its tab remain open when it closes."""

    def __init__(
        self, profile: SiteProfile, stop_event: Event | None = None,
        on_refresh: Callable[[], None] | None = None,
    ):
        self.profile = profile
        self.stop_event = stop_event or Event()
        self.on_refresh = on_refresh
        self._lock = None
        self._server = None
        self._connection = None
        self._buffer = bytearray()
        self._socket_path = None
        self._owns_lock = False

    def __enter__(self):
        if sys.platform != "darwin" and not sys.platform.startswith("linux"):
            raise ValueError("The Chrome extension bridge supports macOS and Linux")
        import fcntl

        origin = urlsplit(self.profile.url)
        if f"{origin.scheme}://{origin.netloc}" != OURDOMAIN_ORIGIN:
            raise ValueError("The Chrome extension currently supports OurDomain only")
        if self.profile.rule.type is RuleType.JSON:
            raise ValueError("The Chrome extension supports text and CSS rules, not JSON")
        if self.profile.capture_on_available:
            raise ValueError(
                "Extension checks do not support captures yet; disable capture-on-available"
            )
        directory = bridge_directory()
        self._socket_path = directory / "bridge.sock"
        try:
            self._lock = (directory / "bridge.lock").open("a")
            try:
                fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ValueError("Another SpotAlert extension check or watch is running") from error
            self._owns_lock = True
            self._socket_path.unlink(missing_ok=True)
            self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._server.bind(str(self._socket_path))
            self._socket_path.chmod(0o600)
            self._server.listen(1)
            self._server.settimeout(0.2)
            self._open_chrome()
            return self
        except BaseException:
            self.__exit__()
            raise

    def _open_chrome(self):
        try:
            if sys.platform == "darwin":
                subprocess.run(
                    ["open", "-a", "Google Chrome", self.profile.url], check=True,
                    capture_output=True,
                )
            else:
                subprocess.Popen(
                    ["google-chrome", self.profile.url],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
        except (OSError, subprocess.SubprocessError) as error:
            raise ValueError(f"Unable to open Google Chrome: {error}") from error

    def __exit__(self, *_args):
        if self._connection is not None:
            self._connection.close()
        if self._server is not None:
            self._server.close()
        if self._owns_lock:
            self._socket_path.unlink(missing_ok=True)
        if self._lock is not None:
            self._lock.close()

    def _ensure_connection(self, deadline):
        if self._connection is not None:
            return
        while time.monotonic() < deadline:
            self._raise_if_stopped()
            try:
                self._connection, _ = self._server.accept()
                self._connection.settimeout(0.2)
                self._buffer.clear()
                hello = self._receive(deadline)
                if hello != {"type": "hello", "version": 1}:
                    raise ValueError("Invalid Chrome extension handshake")
                return
            except socket.timeout:
                continue
        raise ValueError(
            "Chrome extension not connected. Load SpotAlert at chrome://extensions "
            "in the Chrome profile that opened, then click its toolbar icon and retry. "
            "Register the bridge first with: spotalert extension setup"
        )

    def _raise_if_stopped(self):
        if self.stop_event.is_set():
            raise BridgeStopped("Stopped watching")

    def _receive(self, deadline):
        while time.monotonic() < deadline:
            self._raise_if_stopped()
            if len(self._buffer) >= 4:
                length = struct.unpack("=I", self._buffer[:4])[0]
                if length > MAX_MESSAGE:
                    raise ValueError("Chrome extension response exceeds 1 MB")
                if len(self._buffer) >= length + 4:
                    payload = bytes(self._buffer[4:length + 4])
                    del self._buffer[:length + 4]
                    message = json.loads(payload)
                    if not isinstance(message, dict):
                        raise ValueError("Invalid Chrome extension response")
                    return message
            try:
                data = self._connection.recv(65536)
            except socket.timeout:
                continue
            if not data:
                raise ValueError("Chrome extension disconnected; check Chrome is still open")
            self._buffer.extend(data)
        raise ValueError("Timed out waiting for Chrome; check the listing tab and retry")

    def check(self) -> AvailabilityResult:
        """Request one refresh and evaluate the extracted visible text in Python."""
        deadline = time.monotonic() + 45
        try:
            self._ensure_connection(deadline)
            request_id = uuid.uuid4().hex
            self._connection.sendall(encode_message({
                "type": "check", "id": request_id,
                "profile": self.profile.name, "url": self.profile.url,
                "rule": asdict(self.profile.rule),
            }))
            while True:
                response = self._receive(deadline)
                if response.get("id") != request_id:
                    raise ValueError("Chrome extension returned a mismatched request")
                if response.get("type") != "refreshing":
                    break
                if self.on_refresh:
                    self.on_refresh()
            if response.get("id") != request_id:
                raise ValueError("Chrome extension returned a mismatched request")
            if "error" in response:
                raise ValueError(str(response["error"]))
            texts = response.get("texts")
            url = response.get("url")
            if not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
                raise ValueError("Chrome extension returned invalid page text")
            if not isinstance(url, str) or urlsplit(url).netloc != urlsplit(self.profile.url).netloc:
                raise ValueError("Chrome tab navigated away from the configured website")
            if not texts or any(not text.strip() for text in texts):
                raise ValueError("Availability elements were not found; check the page or selector")
            return AvailabilityResult(
                url=url, available=any(_matches_rule(text, self.profile.rule) for text in texts),
            )
        except (OSError, ValueError) as error:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
            self._buffer.clear()
            if isinstance(error, ValueError):
                raise
            raise ValueError(f"Chrome extension connection failed: {error}") from error
