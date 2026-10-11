"""Keyboard-driven terminal interface for SpotAlert."""

from dataclasses import replace
from datetime import datetime
from threading import Event

import httpx
from playwright.sync_api import Error as PlaywrightError
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.widgets import (
    Footer,
    Header,
    Label,
    ListItem,
    ListView,
    LoadingIndicator,
    Static,
)

from SpotAlert.checker import AvailabilityChecker, AvailabilityResult
from SpotAlert.profiles import FetchMode, ProfileStore, RuleType, SiteProfile
from SpotAlert.watch import watch_profile


class SpotAlertApp(App[None]):
    """Provide a keyboard-only interface for saved availability profiles."""

    TITLE = "SpotAlert"
    SUB_TITLE = "Studio availability monitor"

    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("ctrl+c", "quit", "Quit"),
        Binding("q", "quit", "Quit", priority=True),
    ]

    CSS = """
    Screen {
        align: center middle;
    }

    .panel {
        width: 72;
        max-width: 90%;
        padding: 1 2;
        border: round $primary;
    }

    .panel > Static {
        margin-bottom: 1;
    }

    ListView {
        height: auto;
        max-height: 16;
    }

    ListItem {
        padding: 0 1;
    }

    #status {
        min-height: 3;
        margin-top: 1;
    }

    #refresh-spinner {
        height: 1;
    }
    """

    def __init__(self, profile_store: ProfileStore | None = None) -> None:
        super().__init__()
        self.profile_store = profile_store or ProfileStore()
        self.profiles: dict[str, SiteProfile] = {}
        self.profile_error: str | None = None
        self.selected_action = "check"
        self.selected_profile: SiteProfile | None = None
        self.watch_stop_event: Event | None = None
        self.exit_after_watch_stops = False
        self.current_panel = "main-menu"
        self.last_watch_status = ""
        self.completed_checks = 0
        self.last_checked_at = "—"
        self._load_profiles()

    def compose(self) -> ComposeResult:
        """Create the application layout."""
        yield Header()
        with Vertical(classes="panel", id="main-menu"):
            yield Static("Use Up/Down arrows, then Enter.")
            yield ListView(
                ListItem(Label("Check a website once"), id="check"),
                ListItem(Label("Watch a website for availability"), id="watch"),
                ListItem(Label("Quit"), id="quit"),
                id="action-list",
            )
        with Vertical(classes="panel", id="website-picker"):
            yield Static("Which website would you like to use?", id="picker-title")
            yield ListView(*self._profile_items(), id="profile-list")
            yield Static(self._profile_message(), id="profile-message")
        with Vertical(classes="panel", id="profile-action"):
            yield Static(id="selected-profile")
            yield Static(id="profile-rule")
            yield ListView(
                ListItem(Label("Check this website now"), id="check-now"),
                ListItem(Label("Start watching this website"), id="start-watch"),
                ListItem(Label("Use separate Chrome (Playwright)"), id="use-browser"),
                ListItem(Label("Choose another website"), id="choose-another"),
                id="profile-action-list",
            )
        with Vertical(classes="panel", id="delay-picker"):
            yield Static("How often should SpotAlert check for updates?")
            yield ListView(
                ListItem(Label("100 milliseconds"), id="delay-100ms"),
                ListItem(Label("1 second"), id="delay-1s"),
                ListItem(Label("10 seconds"), id="delay-10s"),
                ListItem(Label("1 minute"), id="delay-1m"),
                ListItem(Label("5 minutes"), id="delay-5m"),
                id="delay-list",
            )
            yield Static("Press Esc to choose another website.")
        with Vertical(classes="panel", id="watch-active"):
            yield Static(id="watch-status")
            yield LoadingIndicator(id="refresh-spinner")
            yield Static("Waiting to start...", id="refresh-cue", markup=False)
            yield ListView(
                ListItem(Label("Return home and stop watching"), id="stop-watch"),
                id="watch-active-list",
            )
        yield Static("", id="status")
        yield Footer()

    def on_mount(self) -> None:
        """Start at the compact action menu."""
        self._show_panel("main-menu")
        self.query_one("#refresh-spinner", LoadingIndicator).display = False

    def action_quit(self) -> None:
        """Stop an active watch before allowing the terminal application to exit."""
        if self.watch_stop_event is not None:
            self._request_watch_stop(exit_after_stop=True)
            return
        self.exit()

    def on_unmount(self) -> None:
        """Request browser cleanup if the terminal closes by another route."""
        if self.watch_stop_event is not None:
            self.watch_stop_event.set()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        """Handle the selected keyboard menu item."""
        list_id = event.list_view.id
        item_id = event.item.id
        if list_id == "action-list":
            self._select_action(str(item_id))
        elif list_id == "profile-list":
            self._select_profile(str(item_id))
        elif list_id == "profile-action-list":
            self._select_profile_action(str(item_id))
        elif list_id == "delay-list":
            self._start_watch(_delay_seconds(str(item_id)))
        elif list_id == "watch-active-list":
            self._request_watch_stop()

    def action_back(self) -> None:
        """Return to the previous menu when possible."""
        if self.current_panel == "main-menu":
            return
        if self.current_panel == "watch-active":
            self._request_watch_stop()
            return
        if self.current_panel == "delay-picker":
            self._show_panel("website-picker")
            return
        self._show_panel("main-menu")

    def _load_profiles(self) -> None:
        try:
            self.profiles = {
                profile.name: profile for profile in self.profile_store.load()
            }
        except ValueError as error:
            self.profile_error = str(error)

    def _profile_items(self) -> list[ListItem]:
        if not self.profiles:
            return [ListItem(Label("No saved profiles"), id="no-profiles")]
        return [
            ListItem(Label(profile.name), id=profile.name)
            for profile in self.profiles.values()
        ]

    def _profile_message(self) -> str:
        if self.profile_error:
            return f"Unable to load saved profiles: {self.profile_error}"
        if not self.profiles:
            return "Add a profile with: spotalert profile add --help"
        return "Press Esc to return to the main menu."

    def _select_action(self, action: str) -> None:
        if action == "quit":
            self.exit()
            return
        self.selected_action = action
        verb = "watch" if action == "watch" else "check"
        self.query_one("#picker-title", Static).update(
            f"Which website would you like to {verb}?"
        )
        self._show_panel("website-picker")

    def _select_profile(self, profile_name: str) -> None:
        if profile_name == "no-profiles":
            self._set_status("Add a profile from the terminal before using the TUI.")
            return
        self.selected_profile = self.profiles[profile_name]
        profile = self.selected_profile
        self.query_one("#selected-profile", Static).update(
            f"Selected website: {profile.name}"
        )
        self.query_one("#profile-rule", Static).update(
            f"{profile.rule.type.value.upper()} / {profile.rule.match_mode.value}: "
            f"{profile.rule.query}\nBrowser mode: {profile.fetch_mode.value}"
        )
        from SpotAlert.chrome_bridge import OURDOMAIN_ORIGIN

        extension_supported = (
            profile.url.startswith(OURDOMAIN_ORIGIN + "/")
            and profile.rule.type is not RuleType.JSON
        )
        self.query_one("#use-browser", ListItem).display = extension_supported
        action_list = self.query_one("#profile-action-list", ListView)
        self.query_one("#check-now", ListItem).display = self.selected_action == "check"
        self.query_one("#start-watch", ListItem).display = (
            self.selected_action == "watch"
        )
        action_list.index = 1 if self.selected_action == "watch" else 0
        self._show_panel("profile-action")

    def _select_profile_action(self, action: str) -> None:
        if action == "choose-another":
            self._show_panel("website-picker")
            return
        if self.selected_profile is None:
            self._set_status("Select a website before starting an action.")
            return
        if action == "use-browser":
            profile = replace(
                self.selected_profile,
                fetch_mode=FetchMode.BROWSER,
                browser_headless=False,
                capture_on_available=False,
            )
            try:
                self.profile_store.save(profile)
            except (OSError, ValueError) as error:
                self._set_status(f"Unable to save browser choice: {error}")
                return
            self.profiles[profile.name] = profile
            self._select_profile(profile.name)
            self._set_status("Separate Chrome selected.")
            return
        if action == "check-now":
            self._set_status("Checking listing page...")
            self.check_profile(self.selected_profile)
        elif action == "start-watch":
            self._show_panel("delay-picker")

    def _start_watch(self, interval_seconds: float) -> None:
        if self.selected_profile is None:
            self._set_status("Select a website before starting an action.")
            return
        self.watch_stop_event = Event()
        self.last_watch_status = ""
        self.completed_checks = 0
        self.last_checked_at = "—"
        self._refresh_activity("checking")
        self.query_one("#watch-status", Static).update(
            f"Watching {self.selected_profile.name} every "
            f"{_format_interval(interval_seconds)}.\n"
            "Select Return home to stop watching."
        )
        self._show_panel("watch-active")
        self.watch_selected_profile(
            self.selected_profile.name,
            interval_seconds,
            self.watch_stop_event,
        )

    def _request_watch_stop(self, exit_after_stop: bool = False) -> None:
        """Keep the TUI active until the watch worker closes its browser session."""
        if self.watch_stop_event is None:
            self._show_panel("main-menu")
            return
        self.exit_after_watch_stops = exit_after_stop
        self.watch_stop_event.set()
        self._refresh_activity("stopping")
        self.query_one("#watch-status", Static).update(
            "Stopping watch..."
        )
        self.query_one("#watch-active-list", ListView).disabled = True

    def _show_panel(self, panel_id: str) -> None:
        self.current_panel = panel_id
        for candidate in (
            "main-menu",
            "website-picker",
            "profile-action",
            "delay-picker",
            "watch-active",
        ):
            self.query_one(f"#{candidate}", Vertical).display = candidate == panel_id
        self.query_one("#status", Static).update("")
        focus_target = {
            "main-menu": "#action-list",
            "website-picker": "#profile-list",
            "profile-action": "#profile-action-list",
            "delay-picker": "#delay-list",
            "watch-active": "#watch-active-list",
        }.get(panel_id)
        if focus_target:
            self.query_one(focus_target, ListView).focus()

    @work(exclusive=True, thread=True)
    def check_profile(self, profile: SiteProfile) -> None:
        """Check a saved website without blocking the TUI."""
        try:
            result = AvailabilityChecker(profile.rule.expected_text).check_profile(profile)
        except (ValueError, httpx.HTTPError, PlaywrightError) as error:
            self.call_from_thread(self._set_status, f"Unable to check listing: {error}")
        else:
            self.call_from_thread(self._show_result, result)

    @work(exclusive=True, thread=True)
    def watch_selected_profile(
        self,
        profile_name: str,
        interval_seconds: float,
        stop_event: Event,
    ) -> None:
        """Watch a saved profile and notify on new availability."""
        try:
            watch_profile(
                profile_name,
                interval_seconds=interval_seconds,
                stop_event=stop_event,
                profile_store=self.profile_store,
                on_status=lambda message: self.call_from_thread(self._watch_status, message),
                on_activity=lambda phase: self.call_from_thread(self._refresh_activity, phase),
            )
        except (ValueError, httpx.HTTPError, PlaywrightError) as error:
            self.call_from_thread(self._watch_status, f"Unable to watch listing: {error}")
        finally:
            self.call_from_thread(self._watch_finished)

    def _watch_finished(self) -> None:
        """Return home or exit only after the watch worker has closed Chromium."""
        self.watch_stop_event = None
        self.query_one("#refresh-spinner", LoadingIndicator).display = False
        self.query_one("#watch-active-list", ListView).disabled = False
        if self.exit_after_watch_stops:
            self.exit_after_watch_stops = False
            self.exit()
            return
        self._show_panel("main-menu")
        if self.last_watch_status:
            self._set_status(self.last_watch_status)

    def _watch_status(self, message: str) -> None:
        self.last_watch_status = message
        self._set_status(message)

    def _refresh_activity(self, phase: str) -> None:
        """Show browser activity separately from the availability result."""
        if self.watch_stop_event is not None and self.watch_stop_event.is_set():
            phase = "stopping"
        busy = phase in {"checking", "refreshing"}
        self.query_one("#refresh-spinner", LoadingIndicator).display = busy
        if phase == "completed":
            self.completed_checks += 1
            self.last_checked_at = datetime.now().astimezone().strftime("%H:%M:%S")
        labels = {
            "checking": "Checking listing...",
            "refreshing": "↻ Refreshing Chrome...",
            "completed": "✓ Check complete · Waiting for the next refresh",
            "failed": "! Check failed · Waiting to retry",
            "stopping": "Stopping refreshes...",
        }
        self.query_one("#refresh-cue", Static).update(
            f"{labels[phase]}\nLast checked: {self.last_checked_at} · Checks: {self.completed_checks}"
        )

    def _show_result(self, result: AvailabilityResult) -> None:
        message = (
            f"Availability found at {result.url}"
            if result.available
            else f"No availability found at {result.url}"
        )
        self._set_status(message)

    def _set_status(self, message: str) -> None:
        self.query_one("#status", Static).update(message)


def _format_interval(interval_seconds: float) -> str:
    """Format a fixed watch interval for the active-watch screen."""
    labels = {
        0.1: "100 milliseconds",
        1.0: "1 second",
        10.0: "10 seconds",
        60.0: "1 minute",
        300.0: "5 minutes",
    }
    return labels[interval_seconds]


def _delay_seconds(delay_id: str) -> float:
    """Map a delay menu item to its fixed interval in seconds."""
    delays = {
        "delay-100ms": 0.1,
        "delay-1s": 1.0,
        "delay-10s": 10.0,
        "delay-1m": 60.0,
        "delay-5m": 300.0,
    }
    return delays[delay_id]
