"""Chrome native-messaging registration and transport (macOS/Linux)."""

import base64
import hashlib
import json
import os
import selectors
import shlex
import socket
import struct
import sys
from pathlib import Path

from platformdirs import user_data_path

HOST_NAME = "com.spotalert.bridge"
EXTENSION_DIRECTORY = Path(__file__).parent / "chrome_extension"
MAX_MESSAGE = 1024 * 1024


def extension_id() -> str:
    """Derive Chrome's stable extension ID from its public manifest key."""
    manifest = json.loads((EXTENSION_DIRECTORY / "manifest.json").read_text())
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    return "".join(chr(ord("a") + int(character, 16)) for character in digest)


def bridge_directory() -> Path:
    """Use a short, private directory suitable for macOS Unix socket limits."""
    directory = Path("/tmp") / f"spotalert-{os.getuid()}"
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if directory.is_symlink() or info.st_uid != os.getuid() or not directory.is_dir():
        raise ValueError("SpotAlert bridge directory is not owned by this user")
    directory.chmod(0o700)
    return directory


def encode_message(message: dict) -> bytes:
    payload = json.dumps(message).encode("utf-8")
    if len(payload) > MAX_MESSAGE:
        raise ValueError("Chrome bridge message exceeds 1 MB")
    return struct.pack("=I", len(payload)) + payload


def install_native_host() -> Path:
    """Register this Python environment as Chrome's per-user native host."""
    if sys.platform == "darwin":
        location = Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts"
    elif sys.platform.startswith("linux"):
        location = Path.home() / ".config/google-chrome/NativeMessagingHosts"
    else:
        raise ValueError("The Chrome extension bridge currently supports macOS and Linux")
    data_directory = user_data_path("SpotAlert")
    data_directory.mkdir(parents=True, exist_ok=True)
    launcher = data_directory / "chrome-native-host"
    # Keep the virtualenv's interpreter path, including when it is a symlink.
    launcher.write_text(
        "#!/bin/sh\nexec " + shlex.quote(sys.executable)
        + " -m SpotAlert.native_host \"$@\"\n",
        encoding="utf-8",
    )
    launcher.chmod(0o700)
    location.mkdir(parents=True, exist_ok=True)
    manifest_path = location / f"{HOST_NAME}.json"
    manifest_path.write_text(json.dumps({
        "name": HOST_NAME,
        "description": "SpotAlert Chrome bridge",
        "path": str(launcher),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id()}/"],
    }, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def main() -> int:
    """Relay Chrome's framed messages to the active TUI's private socket."""
    if len(sys.argv) < 2 or sys.argv[1] != f"chrome-extension://{extension_id()}/":
        print("SpotAlert native host: unexpected extension origin", file=sys.stderr)
        return 1
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(str(bridge_directory() / "bridge.sock"))
            connection.sendall(encode_message({"type": "hello", "version": 1}))
            with selectors.DefaultSelector() as selector:
                selector.register(sys.stdin.buffer, selectors.EVENT_READ)
                selector.register(connection, selectors.EVENT_READ)
                while True:
                    for key, _ in selector.select():
                        data = os.read(key.fd, 65536)
                        if not data:
                            return 0
                        if key.fileobj is connection:
                            sys.stdout.buffer.write(data)
                            sys.stdout.buffer.flush()
                        else:
                            connection.sendall(data)
    except (OSError, ValueError) as error:
        print(f"SpotAlert native host: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
