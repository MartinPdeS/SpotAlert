"""Persist availability evidence for later inspection."""

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from platformdirs import user_data_path


@dataclass(frozen=True)
class AvailabilityCapture:
    """The files saved for one detected availability event."""

    directory: Path
    listing_html: Path
    listing_screenshot: Path
    action_html: Path
    action_screenshot: Path


class CaptureStore:
    """Create timestamped availability captures in the user data folder."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or user_data_path("SpotAlert") / "captures"

    def create(self, profile_name: str) -> AvailabilityCapture:
        """Create an empty capture directory and return its planned file paths."""
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", profile_name).strip("-")
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        directory = self.path / safe_name / timestamp
        directory.mkdir(parents=True, exist_ok=False)
        return AvailabilityCapture(
            directory=directory,
            listing_html=directory / "listing.html",
            listing_screenshot=directory / "listing.png",
            action_html=directory / "action.html",
            action_screenshot=directory / "action.png",
        )
