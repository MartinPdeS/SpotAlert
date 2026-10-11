import httpx
import pytest

from SpotAlert.checker import (
    AvailabilityChecker,
    AvailabilityResult,
    BrowserAvailabilityChecker,
    _is_html_rule_available,
)
from SpotAlert.profiles import (
    AvailabilityRule,
    FetchMode,
    MatchMode,
    ProfileStore,
    RuleType,
    SiteProfile,
)


def test_profile_store_saves_and_loads_a_profile(tmp_path) -> None:
    store = ProfileStore(tmp_path / "profiles.json")
    profile = SiteProfile(
        name="dance-studios",
        url="https://example.com/studios",
        rule=AvailabilityRule(
            type=RuleType.CSS,
            query=".availability",
            expected_text="Available",
        ),
        browser_headless=False,
    )

    store.save(profile)

    assert store.load() == [profile]


def test_profile_store_replaces_a_profile_with_the_same_name(tmp_path) -> None:
    store = ProfileStore(tmp_path / "profiles.json")
    first_profile = SiteProfile(
        name="dance-studios",
        url="https://example.com/studios",
        rule=AvailabilityRule.text("Unavailable"),
    )
    replacement_profile = SiteProfile(
        name="dance-studios",
        url="https://example.com/new-studios",
        rule=AvailabilityRule.text("Available"),
    )

    store.save(first_profile)
    store.save(replacement_profile)

    assert store.load() == [replacement_profile]


def test_css_profile_checks_selected_element_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = SiteProfile(
        name="dance-studios",
        url="https://example.com/studios",
        rule=AvailabilityRule(
            type=RuleType.CSS,
            query=".availability",
            expected_text="Available",
        ),
    )

    monkeypatch.setattr(
        httpx,
        "get",
        lambda *_args, **_kwargs: httpx.Response(
            200,
            text='<span class="availability">Available now</span>',
            request=httpx.Request("GET", profile.url),
        ),
    )

    result = AvailabilityChecker("unused").check_profile(profile)

    assert result.available is True


def test_json_profile_checks_configured_path(monkeypatch: pytest.MonkeyPatch) -> None:
    profile = SiteProfile(
        name="city-studios",
        url="https://api.example.com/listings",
        rule=AvailabilityRule(
            type=RuleType.JSON,
            query="data.status",
            expected_text="open",
        ),
    )

    monkeypatch.setattr(
        httpx,
        "get",
        lambda *_args, **_kwargs: httpx.Response(
            200,
            json={"data": {"status": "Open for booking"}},
            request=httpx.Request("GET", profile.url),
        ),
    )

    result = AvailabilityChecker("unused").check_profile(profile)

    assert result.available is True


def test_json_profile_reports_a_missing_path(monkeypatch: pytest.MonkeyPatch) -> None:
    profile = SiteProfile(
        name="city-studios",
        url="https://api.example.com/listings",
        rule=AvailabilityRule(
            type=RuleType.JSON,
            query="data.status",
            expected_text="open",
        ),
    )

    monkeypatch.setattr(
        httpx,
        "get",
        lambda *_args, **_kwargs: httpx.Response(
            200,
            json={"data": {}},
            request=httpx.Request("GET", profile.url),
        ),
    )

    with pytest.raises(ValueError, match="JSON path"):
        AvailabilityChecker("unused").check_profile(profile)


def test_browser_profile_uses_browser_checker(monkeypatch: pytest.MonkeyPatch) -> None:
    profile = SiteProfile(
        name="protected-site",
        url="https://example.com/studios",
        rule=AvailabilityRule.text("Available"),
        fetch_mode=FetchMode.BROWSER,
    )
    expected_result = AvailabilityResult(url=profile.url, available=True)

    monkeypatch.setattr(
        BrowserAvailabilityChecker,
        "check_profile",
        lambda _self, _profile: expected_result,
    )

    result = AvailabilityChecker("unused").check_profile(profile)

    assert result == expected_result


def test_browser_css_rule_uses_only_selected_element_text() -> None:
    rule = AvailabilityRule(
        type=RuleType.CSS,
        query='td[data-selenium-id^="Availability_"]',
        expected_text="Apply Now",
    )

    available = _is_html_rule_available(
        '<td data-selenium-id="Availability_1">Get Notified</td>'
        '<p>Availability</p>',
        rule,
    )

    assert available is False


def test_not_equals_css_rule_detects_changed_availability_text() -> None:
    rule = AvailabilityRule(
        type=RuleType.CSS,
        query='td[data-selenium-id^="Availability_"]',
        expected_text="Get Notified",
        match_mode=MatchMode.NOT_EQUALS,
    )

    unavailable = _is_html_rule_available(
        '<td data-selenium-id="Availability_1">Get Notified</td>',
        rule,
    )
    available = _is_html_rule_available(
        '<td data-selenium-id="Availability_1">Apply Now</td>',
        rule,
    )

    assert unavailable is False
    assert available is True
