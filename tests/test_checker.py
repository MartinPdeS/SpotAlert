from unittest.mock import MagicMock

import httpx
import pytest

from SpotAlert.checker import AvailabilityChecker, BrowserProfileSession
from SpotAlert.profiles import AvailabilityRule, FetchMode, SiteProfile


def test_browser_profile_is_persistent_and_reuses_initial_tab(monkeypatch, tmp_path):
    import playwright.sync_api

    runtime = MagicMock()
    context = runtime.chromium.launch_persistent_context.return_value
    page = MagicMock()
    context.pages = [page]
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", lambda: runtime)
    runtime.start.return_value = runtime
    monkeypatch.setattr("SpotAlert.checker.user_data_path", lambda _name: tmp_path)
    profile = SiteProfile(
        name="../../ourdomain",
        url="https://example.com/studios",
        rule=AvailabilityRule.text("Available"),
        fetch_mode=FetchMode.BROWSER,
        browser_headless=False,
    )

    directories = []
    for _ in range(2):
        with BrowserProfileSession(profile) as session:
            assert session._page is page
            args, kwargs = runtime.chromium.launch_persistent_context.call_args
            directories.append(args[0])
            assert kwargs["channel"] == "chrome"
            assert kwargs["headless"] is False
        context.new_page.assert_not_called()

    assert directories[0] == directories[1]
    from pathlib import Path

    assert Path(directories[0]).parent == tmp_path / "browser-profiles"
    assert context.close.call_count == 2
    assert runtime.stop.call_count == 2


def test_failed_browser_launch_stops_playwright(monkeypatch, tmp_path):
    import playwright.sync_api

    runtime = MagicMock()
    runtime.start.return_value = runtime
    runtime.chromium.launch_persistent_context.side_effect = RuntimeError("launch failed")
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", lambda: runtime)
    monkeypatch.setattr("SpotAlert.checker.user_data_path", lambda _name: tmp_path)
    profile = SiteProfile(
        name="ourdomain",
        url="https://example.com/studios",
        rule=AvailabilityRule.text("Available"),
    )
    with pytest.raises(RuntimeError, match="launch failed"):
        with BrowserProfileSession(profile):
            pass
    runtime.stop.assert_called_once()


def test_check_reports_available_when_marker_is_in_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def get(*_args: object, **_kwargs: object) -> httpx.Response:
        return httpx.Response(
            200,
            text="<html><body><h1>Studio now AVAILABLE</h1></body></html>",
            request=httpx.Request("GET", "https://example.com/studios"),
        )

    monkeypatch.setattr(httpx, "get", get)

    result = AvailabilityChecker("available").check("https://example.com/studios")

    assert result.available is True
    assert result.url == "https://example.com/studios"


def test_check_reports_unavailable_when_marker_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def get(*_args: object, **_kwargs: object) -> httpx.Response:
        return httpx.Response(
            200,
            text="<html><body><h1>All studios are booked</h1></body></html>",
            request=httpx.Request("GET", "https://example.com/studios"),
        )

    monkeypatch.setattr(httpx, "get", get)

    result = AvailabilityChecker("available").check("https://example.com/studios")

    assert result.available is False


@pytest.mark.parametrize(
    ("available_text", "timeout"),
    [
        ("", 10.0),
        ("   ", 10.0),
        ("available", 0.0),
        ("available", -1.0),
    ],
)
def test_checker_rejects_invalid_configuration(
    available_text: str,
    timeout: float,
) -> None:
    with pytest.raises(ValueError):
        AvailabilityChecker(available_text, timeout)
