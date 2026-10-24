"""Tools for monitoring studio-rental availability."""

from SpotAlert.checker import AvailabilityChecker, AvailabilityResult

from ._version import __version__ as __version__

__all__ = ["AvailabilityChecker", "AvailabilityResult"]
