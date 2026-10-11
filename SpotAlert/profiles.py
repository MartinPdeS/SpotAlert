"""Saved website profiles and their availability rules."""

import json
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from platformdirs import user_config_path


class RuleType(str, Enum):
    """The response format used by an availability rule."""

    TEXT = "text"
    CSS = "css"
    JSON = "json"


class FetchMode(str, Enum):
    """The client used to retrieve a website."""

    HTTP = "http"
    BROWSER = "browser"
    EXTENSION = "extension"


class MatchMode(str, Enum):
    """How a rule compares extracted website content."""

    CONTAINS = "contains"
    NOT_EQUALS = "not_equals"


@dataclass(frozen=True)
class AvailabilityRule:
    """A rule for recognizing availability in a website response."""

    type: RuleType
    query: str
    expected_text: str
    match_mode: MatchMode = MatchMode.CONTAINS

    def __post_init__(self) -> None:
        if not self.query.strip():
            raise ValueError("rule query must not be empty")
        if not self.expected_text.strip():
            raise ValueError("rule expected_text must not be empty")

    @classmethod
    def text(cls, expected_text: str) -> "AvailabilityRule":
        """Create a rule that searches all visible page text."""
        return cls(
            type=RuleType.TEXT,
            query=expected_text,
            expected_text=expected_text,
        )


@dataclass(frozen=True)
class SiteProfile:
    """A named website and the rule used to check it."""

    name: str
    url: str
    rule: AvailabilityRule
    fetch_mode: FetchMode = FetchMode.HTTP
    browser_headless: bool = True
    capture_on_available: bool = False

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("profile name must not be empty")
        if not self.url.startswith(("http://", "https://")):
            raise ValueError("profile URL must start with http:// or https://")


class ProfileStore:
    """Read and write named website profiles in the user configuration folder."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or user_config_path("SpotAlert") / "profiles.json"

    def load(self) -> list[SiteProfile]:
        """Return profiles sorted by name."""
        if not self.path.exists():
            return []

        try:
            raw_profiles = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid profile file {self.path}: {error}") from error

        if not isinstance(raw_profiles, list):
            raise ValueError(f"Profile file {self.path} must contain a JSON list")
        return sorted((_profile_from_dict(item) for item in raw_profiles), key=lambda p: p.name)

    def save(self, profile: SiteProfile) -> None:
        """Create or replace a profile identified by its name."""
        profiles = {existing.name: existing for existing in self.load()}
        profiles[profile.name] = profile
        self.path.parent.mkdir(parents=True, exist_ok=True)
        serialized = [
            asdict(existing)
            for existing in sorted(profiles.values(), key=lambda item: item.name)
        ]
        self.path.write_text(
            json.dumps(serialized, indent=2) + "\n",
            encoding="utf-8",
        )


def _profile_from_dict(value: object) -> SiteProfile:
    if not isinstance(value, dict):
        raise ValueError("Each profile must be a JSON object")

    rule_data = value.get("rule")
    if not isinstance(rule_data, dict):
        raise ValueError("Each profile must contain a rule object")

    try:
        rule = AvailabilityRule(
            type=RuleType(rule_data["type"]),
            query=_require_string(rule_data, "query"),
            expected_text=_require_string(rule_data, "expected_text"),
            match_mode=MatchMode(
                rule_data.get("match_mode", MatchMode.CONTAINS.value)
            ),
        )
        return SiteProfile(
            name=_require_string(value, "name"),
            url=_require_string(value, "url"),
            rule=rule,
            fetch_mode=FetchMode(value.get("fetch_mode", FetchMode.HTTP.value)),
            browser_headless=_optional_bool(value, "browser_headless", default=True),
            capture_on_available=_optional_bool(
                value,
                "capture_on_available",
                default=False,
            ),
        )
    except KeyError as error:
        raise ValueError(f"Profile is missing required field {error.args[0]!r}") from error


def _require_string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str):
        raise ValueError(f"Profile field {key!r} must be a string")
    return value


def _optional_bool(data: dict[str, Any], key: str, default: bool) -> bool:
    value = data.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"Profile field {key!r} must be a boolean")
    return value
