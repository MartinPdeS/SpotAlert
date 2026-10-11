"""Recurring profile checks with state-change notifications."""

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from threading import Event

import httpx
from platformdirs import user_config_path
from playwright.sync_api import Error as PlaywrightError

from SpotAlert.captures import AvailabilityCapture
from SpotAlert.checker import (
    AvailabilityChecker,
    AvailabilityResult,
    BrowserProfileSession,
)
from SpotAlert.notifications import send_macos_notification
from SpotAlert.profiles import FetchMode, ProfileStore, SiteProfile


@dataclass(frozen=True)
class WatchState:
    """The last observed availability result for a profile."""

    available: bool


class WatchStateStore:
    """Persist latest profile states so repeated checks do not re-alert."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or user_config_path("SpotAlert") / "watch-state.json"

    def get(self, profile_name: str) -> WatchState | None:
        """Return the last saved state for a profile."""
        if not self.path.exists():
            return None
        try:
            states = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid watch state file {self.path}: {error}") from error
        if not isinstance(states, dict):
            raise ValueError(f"Watch state file {self.path} must contain a JSON object")
        value = states.get(profile_name)
        if value is None:
            return None
        if not isinstance(value, dict) or not isinstance(value.get("available"), bool):
            raise ValueError(f"Invalid saved state for profile {profile_name!r}")
        return WatchState(available=value["available"])

    def save(self, profile_name: str, state: WatchState) -> None:
        """Save the latest availability state for a profile."""
        states: dict[str, object] = {}
        if self.path.exists():
            try:
                states = json.loads(self.path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"Invalid watch state file {self.path}: {error}"
                ) from error
            if not isinstance(states, dict):
                raise ValueError(
                    f"Watch state file {self.path} must contain a JSON object"
                )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        states[profile_name] = {"available": state.available}
        self.path.write_text(json.dumps(states, indent=2) + "\n", encoding="utf-8")


def watch_profile(
    profile_name: str,
    interval_seconds: float,
    *,
    once: bool = False,
    profile_store: ProfileStore | None = None,
    state_store: WatchStateStore | None = None,
    stop_event: Event | None = None,
    on_status: Callable[[str], None] | None = None,
    on_activity: Callable[[str], None] | None = None,
) -> int:
    """Check a saved profile repeatedly and notify on new availability."""
    if interval_seconds <= 0:
        raise ValueError("interval must be greater than zero")

    profile = _get_profile(profile_name, profile_store or ProfileStore())
    states = state_store or WatchStateStore()
    stop_event = stop_event or Event()
    checker = AvailabilityChecker(profile.rule.expected_text)
    try:
        if profile.fetch_mode is FetchMode.EXTENSION:
            raise ValueError(
                "Normal Chrome monitoring now runs in the standalone SpotAlert extension. "
                "Click its Chrome toolbar icon, or use fetch-mode browser for Python checks."
            )
        if profile.fetch_mode is FetchMode.BROWSER:
            with BrowserProfileSession(profile, timeout=checker.timeout) as session:
                return _watch_loop(
                    profile,
                    interval_seconds,
                    states,
                    stop_event,
                    once,
                    lambda _: session.check(),
                    lambda: session.capture_availability()
                    if profile.capture_on_available
                    else None,
                    on_status,
                    on_activity,
                )
        return _watch_loop(
            profile,
            interval_seconds,
            states,
            stop_event,
            once,
            checker.check_profile,
            None,
            on_status,
            on_activity,
        )
    except KeyboardInterrupt:
        print("\nStopped watching.")
        return 0


def _watch_loop(
    profile: SiteProfile,
    interval_seconds: float,
    states: WatchStateStore,
    stop_event: Event,
    once: bool,
    check_profile: Callable[[SiteProfile], AvailabilityResult],
    capture_availability: Callable[[], AvailabilityCapture | None] | None,
    on_status: Callable[[str], None] | None = None,
    on_activity: Callable[[str], None] | None = None,
) -> int:
    """Check until stopped, retaining the supplied browser session if any."""
    while not stop_event.is_set():
        if on_activity:
            on_activity("refreshing" if profile.fetch_mode is FetchMode.BROWSER else "checking")
        succeeded = _check_once(profile, states, check_profile, capture_availability, on_status)
        if on_activity:
            on_activity("completed" if succeeded else "failed")
        if once:
            return 0
        if stop_event.wait(interval_seconds):
            return 0
    return 0


def _get_profile(profile_name: str, store: ProfileStore) -> SiteProfile:
    for profile in store.load():
        if profile.name == profile_name:
            return profile
    raise ValueError(f"No saved profile named {profile_name!r}")


def _check_once(
    profile: SiteProfile,
    states: WatchStateStore,
    check_profile: Callable[[SiteProfile], AvailabilityResult],
    capture_availability: Callable[[], AvailabilityCapture | None] | None,
    on_status: Callable[[str], None] | None = None,
) -> bool:
    report = on_status or print
    try:
        result = check_profile(profile)
    except (ValueError, httpx.HTTPError, PlaywrightError) as error:
        report(f"Unable to check {profile.name}: {error}")
        return False

    previous_state = states.get(profile.name)
    current_state = WatchState(available=result.available)
    states.save(profile.name, current_state)
    if result.available and (previous_state is None or not previous_state.available):
        message = f"Availability detected at {result.url}"
        if capture_availability is not None:
            try:
                capture = capture_availability()
            except (OSError, PlaywrightError, ValueError) as error:
                report(f"Availability detected but capture failed: {error}")
            else:
                if capture is not None:
                    message = f"{message}\nSaved capture: {capture.directory}"
        report(message)
        send_macos_notification("SpotAlert", message)
        return True

    status = "available" if result.available else "not available"
    report(f"{profile.name}: {status}")
    return True
