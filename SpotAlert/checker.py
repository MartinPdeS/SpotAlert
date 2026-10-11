"""Retrieve rental listings and identify availability markers."""

import json
from dataclasses import dataclass
from hashlib import sha256

import httpx
from bs4 import BeautifulSoup
from platformdirs import user_data_path

from SpotAlert.captures import AvailabilityCapture, CaptureStore
from SpotAlert.profiles import (
    AvailabilityRule,
    FetchMode,
    MatchMode,
    RuleType,
    SiteProfile,
)


@dataclass(frozen=True)
class AvailabilityResult:
    """The outcome of checking one rental-listing page."""

    url: str
    available: bool


class AvailabilityChecker:
    """Check a listing page for a case-insensitive availability marker."""

    def __init__(self, available_text: str, timeout: float = 10.0) -> None:
        normalized_text = available_text.strip()
        if not normalized_text:
            raise ValueError("available_text must not be empty")
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")

        self.available_text = normalized_text.casefold()
        self.timeout = timeout

    def check(self, url: str) -> AvailabilityResult:
        """Fetch *url* and report whether the configured marker is present."""
        response = httpx.get(url, timeout=self.timeout, follow_redirects=True)
        response.raise_for_status()
        return self._check_response(response, AvailabilityRule.text(self.available_text))

    def check_profile(self, profile: SiteProfile) -> AvailabilityResult:
        """Fetch a saved profile and evaluate its availability rule."""
        if profile.fetch_mode is FetchMode.EXTENSION:
            raise ValueError(
                "Normal Chrome monitoring now runs in the standalone SpotAlert extension. "
                "Click its Chrome toolbar icon, or use fetch-mode browser for Python checks."
            )
        if profile.fetch_mode is FetchMode.BROWSER:
            return BrowserAvailabilityChecker(timeout=self.timeout).check_profile(profile)

        response = httpx.get(
            profile.url,
            timeout=self.timeout,
            follow_redirects=True,
        )
        response.raise_for_status()
        return self._check_response(response, profile.rule)

    def _check_response(
        self,
        response: httpx.Response,
        rule: AvailabilityRule,
    ) -> AvailabilityResult:
        if rule.type is RuleType.TEXT:
            page_text = BeautifulSoup(response.text, "html.parser").get_text(" ")
            available = _matches_rule(page_text, rule)
        elif rule.type is RuleType.CSS:
            page = BeautifulSoup(response.text, "html.parser")
            matches = page.select(rule.query)
            available = any(_matches_rule(match.get_text(" "), rule) for match in matches)
        else:
            payload = response.json()
            value = _get_json_value(payload, rule.query)
            available = _matches_rule(str(value), rule)

        return AvailabilityResult(
            url=str(response.url),
            available=available,
        )


class BrowserAvailabilityChecker:
    """Check browser-rendered listing pages using Playwright."""

    def __init__(self, timeout: float = 30.0) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        self.timeout = timeout

    def check_profile(self, profile: SiteProfile) -> AvailabilityResult:
        """Render a profile in Chromium and evaluate its availability rule."""
        with BrowserProfileSession(profile, timeout=self.timeout) as session:
            return session.check()


class BrowserProfileSession:
    """Keep one Playwright page open while repeatedly checking a profile."""

    def __init__(self, profile: SiteProfile, timeout: float = 30.0) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        self.profile = profile
        self.timeout_ms = int(timeout * 1000)
        self._playwright = None
        self._context = None
        self._page = None
        self._loaded = False

    def __enter__(self) -> "BrowserProfileSession":
        """Open installed Chrome with a persistent, site-specific profile."""
        from playwright.sync_api import sync_playwright

        self._playwright = sync_playwright().start()
        profile_id = sha256(self.profile.name.encode("utf-8")).hexdigest()
        profile_directory = user_data_path("SpotAlert") / "browser-profiles" / profile_id
        try:
            self._context = self._playwright.chromium.launch_persistent_context(
                str(profile_directory),
                channel="chrome",
                headless=self.profile.browser_headless,
                no_viewport=True,
                extra_http_headers={
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache",
                },
            )
            self._page = (
                self._context.pages[0]
                if self._context.pages
                else self._context.new_page()
            )
        except BaseException:
            self.__exit__()
            raise
        return self

    def __exit__(self, *_args: object) -> None:
        """Release browser resources after the watch stops."""
        try:
            if self._context is not None:
                self._context.close()
        finally:
            if self._playwright is not None:
                self._playwright.stop()

    def check(self) -> AvailabilityResult:
        """Load once, then reload the same page with cache revalidation."""
        if self._page is None:
            raise RuntimeError("Browser session has not been started")

        if self._loaded:
            self._page.reload(wait_until="domcontentloaded", timeout=self.timeout_ms)
        else:
            self._page.goto(
                self.profile.url,
                wait_until="domcontentloaded",
                timeout=self.timeout_ms,
            )
            self._loaded = True

        if self.profile.rule.type is RuleType.CSS:
            self._page.wait_for_selector(
                self.profile.rule.query,
                timeout=self.timeout_ms,
            )
        else:
            self._page.wait_for_selector("body", timeout=self.timeout_ms)
        if self.profile.rule.type is RuleType.JSON:
            payload = json.loads(
                self._page.locator("body").inner_text(timeout=self.timeout_ms)
            )
            value = _get_json_value(payload, self.profile.rule.query)
            available = _matches_rule(str(value), self.profile.rule)
        else:
            available = _is_html_rule_available(
                self._page.content(),
                self.profile.rule,
            )
        return AvailabilityResult(url=self._page.url, available=available)

    def capture_availability(
        self,
        capture_store: CaptureStore | None = None,
    ) -> AvailabilityCapture:
        """Save the listing and the result of its first available-unit action."""
        if self._page is None:
            raise RuntimeError("Browser session has not been started")
        if self.profile.rule.type is not RuleType.CSS:
            raise ValueError("Availability captures require a CSS profile rule")

        capture = (capture_store or CaptureStore()).create(self.profile.name)
        capture.listing_html.write_text(self._page.content(), encoding="utf-8")
        self._page.screenshot(path=str(capture.listing_screenshot), full_page=True)

        action = self._first_available_action()
        if action is None:
            raise ValueError(
                "No button or link was found in the available availability cell"
            )
        action.click(timeout=self.timeout_ms)
        self._page.wait_for_timeout(250)
        capture.action_html.write_text(self._page.content(), encoding="utf-8")
        self._page.screenshot(path=str(capture.action_screenshot), full_page=True)
        return capture

    def _first_available_action(self):
        """Return the first actionable control in a matching availability element."""
        if self._page is None:
            raise RuntimeError("Browser session has not been started")

        cells = self._page.locator(self.profile.rule.query)
        for index in range(cells.count()):
            cell = cells.nth(index)
            if _matches_rule(cell.inner_text(timeout=self.timeout_ms), self.profile.rule):
                actions = cell.locator("button, a")
                if actions.count():
                    return actions.first
        return None


def _is_html_rule_available(html: str, rule: AvailabilityRule) -> bool:
    """Evaluate a text or CSS availability rule against rendered HTML."""
    page = BeautifulSoup(html, "html.parser")
    if rule.type is RuleType.TEXT:
        return _matches_rule(page.get_text(" "), rule)
    if rule.type is RuleType.CSS:
        return any(_matches_rule(match.get_text(" "), rule) for match in page.select(rule.query))
    raise ValueError("JSON rules require a JSON response")


def _matches_rule(value: str, rule: AvailabilityRule) -> bool:
    """Compare extracted content to a rule's expected text."""
    normalized_value = " ".join(value.split()).casefold()
    normalized_expected = " ".join(rule.expected_text.split()).casefold()
    if rule.match_mode is MatchMode.CONTAINS:
        return normalized_expected in normalized_value
    return normalized_value != normalized_expected


def _get_json_value(payload: object, path: str) -> object:
    """Resolve a dot-separated mapping path in a JSON response."""
    value = payload
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            raise ValueError(f"JSON path {path!r} was not found in the response")
        value = value[key]
    return value
