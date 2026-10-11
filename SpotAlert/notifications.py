"""Local notification delivery for SpotAlert."""

import subprocess
import sys


def send_macos_notification(title: str, message: str) -> None:
    """Display a macOS notification using the system notification center."""
    if sys.platform != "darwin":
        raise RuntimeError("macOS desktop notifications require macOS")

    script = (
        f'display notification "{_escape_applescript(message)}" '
        f'with title "{_escape_applescript(title)}"'
    )
    subprocess.run(["osascript", "-e", script], check=True)


def _escape_applescript(value: str) -> str:
    """Escape text embedded in an AppleScript string literal."""
    return value.replace("\\", "\\\\").replace('"', '\\"')
