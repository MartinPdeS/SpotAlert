.DEFAULT_GOAL := help

PYTHON ?= python3
PROFILE ?= ourdomain-amsterdam-diemen
INTERVAL ?= 300

.PHONY: help install editable browser tui watch test quality check clean extension-test extension-browser-test extension

help:
	@echo "SpotAlert: Chrome extension (primary app), optional Python tools"
	@echo ""
	@echo "  make extension             Show Chrome extension installation instructions"
	@echo "  make install               Install optional Python tools and test dependencies"
	@echo "  make editable              Install the package in editable mode"
	@echo "  make browser               Install Google Chrome for browser checks"
	@echo "  make tui                   Open the terminal user interface"
	@echo "  make watch                 Watch PROFILE=$(PROFILE) every INTERVAL=$(INTERVAL) seconds"
	@echo "  make test                  Run the test suite"
	@echo "  make extension-test        Run standalone extension behavior tests"
	@echo "  make extension-browser-test  Test the extension in isolated Chromium"
	@echo "  make quality               Run static checks"
	@echo "  make check                 Run quality and tests"
	@echo "  make clean                 Remove generated Python artifacts"

extension:
	@echo "Open chrome://extensions, enable Developer mode, and Load unpacked:"
	@echo "  $(CURDIR)/SpotAlert/chrome_extension"
	@echo "See README.md; Python is not required to run the extension."

install:
	$(PYTHON) -m pip install ".[dev,testing]"

editable:
	$(PYTHON) -m pip install -e ".[dev,testing]"

browser:
	$(PYTHON) -m playwright install chrome

tui:
	$(PYTHON) -m SpotAlert tui

watch:
	$(PYTHON) -m SpotAlert watch "$(PROFILE)" --interval "$(INTERVAL)"

test:
	$(PYTHON) -m pytest

quality:
	$(PYTHON) -m ruff check .

extension-test:
	node --test tests/chrome_extension.test.cjs

extension-browser-test:
	$(PYTHON) scripts/test_extension_browser.py
	$(PYTHON) scripts/test_extension_features.py
	$(PYTHON) scripts/test_searches_browser.py
	$(PYTHON) scripts/test_email_browser.py
	$(PYTHON) scripts/test_panel_browser.py
	$(PYTHON) scripts/test_profile_browser.py
	$(PYTHON) scripts/test_application_browser.py
	$(PYTHON) scripts/test_workspace_browser.py
	$(PYTHON) scripts/test_page_read_browser.py
	$(PYTHON) scripts/test_hybrid_browser.py

check: quality test extension-test

clean:
	rm -rf .pytest_cache .ruff_cache htmlcov .coverage build dist
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
