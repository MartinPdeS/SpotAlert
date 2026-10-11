"""Command-line interface for SpotAlert."""

import argparse
from collections.abc import Sequence

import httpx

from SpotAlert.checker import AvailabilityChecker
from SpotAlert.profiles import (
    AvailabilityRule,
    FetchMode,
    MatchMode,
    ProfileStore,
    RuleType,
    SiteProfile,
)
from SpotAlert.tui import SpotAlertApp
from SpotAlert.watch import watch_profile


def build_parser() -> argparse.ArgumentParser:
    """Create the SpotAlert command-line parser."""
    parser = argparse.ArgumentParser(
        prog="spotalert",
        description="Check a studio-rental listing page for availability.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    check_parser = subparsers.add_parser(
        "check",
        help="check one listing page for an availability marker",
    )
    check_parser.add_argument("url", help="listing page URL")
    check_parser.add_argument(
        "--available-text",
        required=True,
        help="text that indicates a studio is available",
    )
    check_parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="HTTP timeout in seconds (default: 10)",
    )
    subparsers.add_parser("tui", help="open the interactive terminal interface")
    extension_parser = subparsers.add_parser("extension", help="show standalone Chrome extension setup")
    extension_parser.add_argument("action", choices=["setup"])

    watch_parser = subparsers.add_parser(
        "watch",
        help="repeatedly check a profile and notify on newly detected availability",
    )
    watch_parser.add_argument("name", help="saved profile name")
    watch_parser.add_argument(
        "--interval",
        type=float,
        default=300.0,
        help="seconds between checks (default: 300)",
    )
    watch_parser.add_argument(
        "--once",
        action="store_true",
        help="check once without waiting for the next interval",
    )

    profile_parser = subparsers.add_parser("profile", help="manage saved websites")
    profile_subparsers = profile_parser.add_subparsers(dest="profile_command", required=True)
    profile_subparsers.add_parser("list", help="list saved website profiles")
    add_parser = profile_subparsers.add_parser("add", help="create or update a profile")
    add_parser.add_argument("name", help="unique profile name")
    add_parser.add_argument("url", help="listing page or API URL")
    add_parser.add_argument(
        "--rule-type",
        choices=[rule_type.value for rule_type in RuleType],
        required=True,
        help="response structure used by the availability rule",
    )
    add_parser.add_argument(
        "--query",
        required=True,
        help="text to find, CSS selector, or dot-separated JSON path",
    )
    add_parser.add_argument(
        "--expected-text",
        help="text that marks the selected text or JSON value as available",
    )
    add_parser.add_argument(
        "--match-mode",
        choices=[mode.value for mode in MatchMode],
        default=MatchMode.CONTAINS.value,
        help="compare extracted content by containment or exact inequality",
    )
    add_parser.add_argument(
        "--fetch-mode",
        choices=[mode.value for mode in FetchMode],
        default=FetchMode.HTTP.value,
        help="http, separate browser, or extension in normal Chrome (OurDomain only)",
    )
    add_parser.add_argument(
        "--headed",
        action="store_true",
        help="show Chrome instead of running headlessly (needed by some bot-protected sites)",
    )
    add_parser.add_argument(
        "--capture-on-available",
        action="store_true",
        help="save page and action-popup HTML/screenshots when availability is detected",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the SpotAlert command-line interface."""
    args = build_parser().parse_args(argv)
    if args.command == "tui":
        SpotAlertApp().run()
        return 0
    if args.command == "extension":
        from SpotAlert.native_host import EXTENSION_DIRECTORY, extension_id

        print("SpotAlert now runs entirely inside Chrome; no Python bridge is required.")
        print("Open chrome://extensions, enable Developer mode, and choose Load unpacked.")
        print(f"Select folder: {EXTENSION_DIRECTORY}")
        print(f"Expected extension ID: {extension_id()}")
        print("Reload SpotAlert if it is already installed, then click its icon to open the side panel.")
        return 0
    if args.command == "profile":
        return _run_profile_command(args)
    if args.command == "watch":
        return _run_watch_command(args)

    checker = AvailabilityChecker(
        available_text=args.available_text,
        timeout=args.timeout,
    )

    try:
        result = checker.check(args.url)
    except httpx.HTTPError as error:
        print(f"Unable to check {args.url}: {error}")
        return 2

    if result.available:
        print(f"Studio availability found at {result.url}")
        return 0

    print(f"No studio availability found at {result.url}")
    return 1


def _run_profile_command(args: argparse.Namespace) -> int:
    store = ProfileStore()
    try:
        if args.profile_command == "list":
            profiles = store.load()
            if not profiles:
                print("No saved profiles. Add one with: spotalert profile add --help")
                return 0
            for profile in profiles:
                print(
                    f"{profile.name}: {profile.url} "
                    f"({profile.rule.type.value}, {profile.fetch_mode.value}, "
                    f"{'headless' if profile.browser_headless else 'headed'}, "
                    f"{'capture' if profile.capture_on_available else 'no capture'})"
                )
            return 0

        expected_text = args.expected_text or args.query
        store.save(
            SiteProfile(
                name=args.name,
                url=args.url,
                rule=AvailabilityRule(
                    type=RuleType(args.rule_type),
                    query=args.query,
                    expected_text=expected_text,
                    match_mode=MatchMode(args.match_mode),
                ),
                fetch_mode=FetchMode(args.fetch_mode),
                browser_headless=not args.headed,
                capture_on_available=args.capture_on_available,
            )
        )
    except ValueError as error:
        print(f"Unable to save profile: {error}")
        return 2

    print(f"Saved profile {args.name!r} to {store.path}")
    return 0


def _run_watch_command(args: argparse.Namespace) -> int:
    try:
        return watch_profile(
            profile_name=args.name,
            interval_seconds=args.interval,
            once=args.once,
        )
    except ValueError as error:
        print(f"Unable to watch profile: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
