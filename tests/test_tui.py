import asyncio
from threading import Event

from textual.containers import Vertical
from textual.widgets import ListView

from SpotAlert.profiles import AvailabilityRule, ProfileStore, SiteProfile
from SpotAlert.tui import SpotAlertApp


def test_tui_uses_keyboard_menu_navigation() -> None:
    async def check_menu_flow() -> None:
        app = SpotAlertApp()

        async with app.run_test() as pilot:
            assert app.query_one("#main-menu", Vertical).display is True
            assert app.query_one("#website-picker", Vertical).display is False

            await pilot.press("enter")

            assert app.query_one("#website-picker", Vertical).display is True

    asyncio.run(check_menu_flow())


def test_tui_opens_delay_menu_for_a_selected_watch_profile(tmp_path) -> None:
    async def check_watch_flow() -> None:
        store = ProfileStore(tmp_path / "profiles.json")
        store.save(
            SiteProfile(
                name="test-studios",
                url="https://example.com/studios",
                rule=AvailabilityRule.text("Available"),
            )
        )
        app = SpotAlertApp(profile_store=store)

        async with app.run_test() as pilot:
            await pilot.press("down", "enter")
            await pilot.press("enter")
            await pilot.press("enter")

            assert app.query_one("#delay-picker", Vertical).display is True

    asyncio.run(check_watch_flow())


def test_tui_waits_for_watch_cleanup_before_returning_home() -> None:
    async def check_watch_shutdown() -> None:
        app = SpotAlertApp()

        async with app.run_test():
            app.watch_stop_event = Event()
            app._show_panel("watch-active")
            app._request_watch_stop()

            assert app.query_one("#watch-active", Vertical).display is True
            assert app.query_one("#watch-active-list", ListView).disabled is True
            assert app.watch_stop_event.is_set() is True

            app._watch_finished()

            assert app.query_one("#main-menu", Vertical).display is True
            assert app.watch_stop_event is None

    asyncio.run(check_watch_shutdown())


def test_tui_can_choose_separate_chrome(tmp_path) -> None:
    from textual.widgets import Static

    from SpotAlert.profiles import FetchMode

    async def switch_mode():
        store = ProfileStore(tmp_path / "profiles.json")
        store.save(SiteProfile(
            name="ourdomain",
            url="https://thisisourdomain.securerc.co.uk/listings",
            rule=AvailabilityRule.text("Available"),
            fetch_mode=FetchMode.EXTENSION,
            capture_on_available=True,
        ))
        app = SpotAlertApp(profile_store=store)
        async with app.run_test():
            app._select_profile("ourdomain")
            app._select_profile_action("use-browser")
            saved = store.load()[0]
            assert saved.fetch_mode is FetchMode.BROWSER
            assert saved.capture_on_available is False
            assert app.selected_profile == saved
            assert "Separate Chrome selected" in str(app.query_one("#status", Static).render())

    asyncio.run(switch_mode())


def test_refresh_cue_tracks_success_failure_and_stop() -> None:
    from textual.widgets import LoadingIndicator, Static

    async def check_cue():
        app = SpotAlertApp()
        async with app.run_test():
            app.watch_stop_event = Event()
            app._show_panel("watch-active")
            app._refresh_activity("refreshing")
            assert app.query_one("#refresh-spinner", LoadingIndicator).display
            assert "Refreshing Chrome" in str(app.query_one("#refresh-cue", Static).render())

            app._refresh_activity("completed")
            assert not app.query_one("#refresh-spinner", LoadingIndicator).display
            assert app.completed_checks == 1
            assert app.last_checked_at != "—"
            last_success = app.last_checked_at

            app._refresh_activity("checking")
            app._refresh_activity("failed")
            assert app.completed_checks == 1
            assert app.last_checked_at == last_success
            assert "Check failed" in str(app.query_one("#refresh-cue", Static).render())

            app.watch_stop_event.set()
            app._refresh_activity("refreshing")
            assert not app.query_one("#refresh-spinner", LoadingIndicator).display
            assert "Stopping" in str(app.query_one("#refresh-cue", Static).render())

    asyncio.run(check_cue())
