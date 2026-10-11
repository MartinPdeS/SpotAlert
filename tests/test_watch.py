from SpotAlert.captures import AvailabilityCapture
from SpotAlert.checker import AvailabilityChecker, AvailabilityResult
from SpotAlert.profiles import (
    AvailabilityRule,
    FetchMode,
    ProfileStore,
    SiteProfile,
)
from SpotAlert.watch import WatchState, WatchStateStore, _check_once, watch_profile


def test_watch_notifies_when_availability_changes(
    monkeypatch,
    tmp_path,
) -> None:
    profile = SiteProfile(
        name="ourdomain",
        url="https://example.com/studios",
        rule=AvailabilityRule.text("Available"),
    )
    profiles = ProfileStore(tmp_path / "profiles.json")
    states = WatchStateStore(tmp_path / "watch-state.json")
    profiles.save(profile)
    notifications: list[tuple[str, str]] = []
    result = AvailabilityResult(url=profile.url, available=False)

    monkeypatch.setattr(
        AvailabilityChecker,
        "check_profile",
        lambda _self, _profile: result,
    )
    monkeypatch.setattr(
        "SpotAlert.watch.send_macos_notification",
        lambda title, message: notifications.append((title, message)),
    )

    assert watch_profile(
        profile.name,
        interval_seconds=1,
        once=True,
        profile_store=profiles,
        state_store=states,
    ) == 0
    assert notifications == []

    result = AvailabilityResult(url=profile.url, available=True)

    assert watch_profile(
        profile.name,
        interval_seconds=1,
        once=True,
        profile_store=profiles,
        state_store=states,
    ) == 0
    assert notifications == [("SpotAlert", f"Availability detected at {profile.url}")]


def test_watch_stops_when_stop_event_is_set(tmp_path) -> None:
    from threading import Event

    profile = SiteProfile(
        name="ourdomain",
        url="https://example.com/studios",
        rule=AvailabilityRule.text("Available"),
    )
    profiles = ProfileStore(tmp_path / "profiles.json")
    profiles.save(profile)
    stop_event = Event()
    stop_event.set()

    assert watch_profile(
        profile.name,
        interval_seconds=1,
        profile_store=profiles,
        state_store=WatchStateStore(tmp_path / "watch-state.json"),
        stop_event=stop_event,
    ) == 0


def test_browser_watch_reuses_one_browser_session(monkeypatch, tmp_path) -> None:
    profile = SiteProfile(
        name="ourdomain",
        url="https://example.com/studios",
        rule=AvailabilityRule.text("Available"),
        fetch_mode=FetchMode.BROWSER,
    )
    profiles = ProfileStore(tmp_path / "profiles.json")
    profiles.save(profile)
    lifecycle: list[str] = []

    class FakeBrowserSession:
        def __init__(self, *_args, **_kwargs) -> None:
            lifecycle.append("created")

        def __enter__(self) -> "FakeBrowserSession":
            lifecycle.append("opened")
            return self

        def __exit__(self, *_args: object) -> None:
            lifecycle.append("closed")

        def check(self) -> AvailabilityResult:
            lifecycle.append("checked")
            return AvailabilityResult(url=profile.url, available=False)

    monkeypatch.setattr("SpotAlert.watch.BrowserProfileSession", FakeBrowserSession)

    assert watch_profile(
        profile.name,
        interval_seconds=1,
        once=True,
        profile_store=profiles,
        state_store=WatchStateStore(tmp_path / "watch-state.json"),
    ) == 0
    assert lifecycle == ["created", "opened", "checked", "closed"]


def test_watch_captures_only_when_availability_is_new(monkeypatch, tmp_path) -> None:
    profile = SiteProfile(
        name="ourdomain",
        url="https://example.com/studios",
        rule=AvailabilityRule.text("Available"),
    )
    states = WatchStateStore(tmp_path / "watch-state.json")
    capture = AvailabilityCapture(
        directory=tmp_path / "capture",
        listing_html=tmp_path / "capture" / "listing.html",
        listing_screenshot=tmp_path / "capture" / "listing.png",
        action_html=tmp_path / "capture" / "action.html",
        action_screenshot=tmp_path / "capture" / "action.png",
    )
    captured = 0
    notifications: list[str] = []

    def capture_availability() -> AvailabilityCapture:
        nonlocal captured
        captured += 1
        return capture

    monkeypatch.setattr(
        "SpotAlert.watch.send_macos_notification",
        lambda _title, message: notifications.append(message),
    )

    _check_once(
        profile,
        states,
        lambda _profile: AvailabilityResult(url=profile.url, available=True),
        capture_availability,
    )
    states.save(profile.name, WatchState(available=True))
    _check_once(
        profile,
        states,
        lambda _profile: AvailabilityResult(url=profile.url, available=True),
        capture_availability,
    )

    assert captured == 1
    assert notifications == [f"Availability detected at {profile.url}\nSaved capture: {capture.directory}"]


def test_legacy_extension_profile_points_to_standalone_app(tmp_path):
    import pytest

    profile = SiteProfile(
        name="ourdomain",
        url="https://thisisourdomain.securerc.co.uk/listings",
        rule=AvailabilityRule.text("Available"),
        fetch_mode=FetchMode.EXTENSION,
    )
    profiles = ProfileStore(tmp_path / "profiles.json")
    profiles.save(profile)
    with pytest.raises(ValueError, match="standalone SpotAlert extension"):
        watch_profile(profile.name, 300, once=True, profile_store=profiles)
