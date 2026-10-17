# Legacy Python tools

The main SpotAlert app is a [standalone Chrome extension](../README.md).
For optional applicant-file storage, see [the profile helper](PROFILE_HELPER.md).
The CLI/TUI below are legacy tools, independent of extension profiles and searches. These Python
commands remain available for HTTP/API and separate-browser checks. Saved
profiles using `fetch_mode: extension` should be changed to `browser`; the
current extension no longer communicates with the Python bridge.

**SpotAlert** monitors a studio-rental listing page and alerts you when a
studio becomes available.

The Python tools provide configurable availability checks, recurring monitoring,
an interactive terminal interface, and macOS desktop notifications.

## Requirements

- Python 3.10 or newer

## Installation

Create and activate a virtual environment, then install the project in editable
mode with its development dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev,testing]"
```

The package installs a `spotalert` terminal command. You can also run the same
entry point directly from Python:

```bash
spotalert --help
python -m SpotAlert --help
```

## Check a listing page

Run a one-time check. The command exits with status `0` when the supplied
availability text is found and `1` otherwise.

```bash
spotalert check \
  "https://example.com/studios" \
  --available-text "Available"
```

Use `--timeout` to change the HTTP timeout in seconds:

```bash
spotalert check "https://example.com/studios" --available-text "Available" --timeout 20
```

## Interactive terminal interface

Launch the guided terminal interface:

```bash
spotalert tui
```

Choose Check or Watch from the first screen, then select a saved profile. Create and update profiles
manually from the terminal, not from the TUI. Press `q` or `Ctrl+C` to exit.

## Saved website profiles

SpotAlert stores profiles at the operating system's user configuration location
(`~/Library/Application Support/SpotAlert/profiles.json` on macOS). A profile
defines how its website exposes availability:

- `text` searches visible page text.
- `css` searches the text inside elements matching a CSS selector.
- `json` reads a dot-separated path from a JSON API response.

Rules normally use `contains`. Use `not_equals` when a cell has a known
unavailable value and any different value means availability.

By default, profiles use fast HTTP requests. Set `--fetch-mode browser` for
JavaScript-rendered or bot-protected sites. Browser checks use Google Chrome,
which must be installed on your machine.

Browser profiles run headlessly by default. When a site blocks headless
browsers, add `--headed`; Chrome will be visible while SpotAlert performs
the check.

SpotAlert opens a regular Chrome window when `--headed` is set and keeps a
separate persistent browser profile for each saved website profile. Cookies
and logins are retained between runs under SpotAlert's user-data folder in
`browser-profiles`. Log in once in that window if needed. Your everyday Chrome
profile's existing logins and extensions are not imported. Only one check or
watch can use the same saved profile at a time.

Use `--capture-on-available` with a browser/CSS profile to save timestamped
evidence when availability first appears. SpotAlert saves HTML and a full-page
screenshot before clicking the first button or link in the newly available
cell, then saves HTML and a screenshot after the resulting popup or page
opens. It never submits a form. Captures are saved under the operating
system's SpotAlert user-data folder.

Create or replace a profile:

```bash
spotalert profile add dance-studios "https://example.com/studios" \
  --rule-type css \
  --query ".studio-card .availability" \
  --expected-text "Available"
```

For a JSON API, use a dot-separated path:

```bash
spotalert profile add city-studios "https://api.example.com/listings" \
  --rule-type json \
  --query "data.availability.status" \
  --expected-text "available"
```

For a page-wide text search, the query is the text that marks availability:

```bash
spotalert profile add local-studio "https://example.com/studios" \
  --rule-type text \
  --query "Studio available"
```

For a bot-protected listing page:

```bash
spotalert profile add protected-site "https://example.com/studios" \
  --rule-type css \
  --query ".availability" \
  --expected-text "Apply Now" \
  --fetch-mode browser \
  --headed
```

List saved profiles with `spotalert profile list`. Open `spotalert tui` and
choose any saved profile from the first field; its appropriate rule is then
used automatically.

## Watch for availability

### Use a separate automated browser

Watch a saved profile every five minutes and receive a terminal plus macOS
desktop notification when its availability changes from unavailable to
available:

```bash
spotalert watch ourdomain-amsterdam-diemen
```

Use a custom interval in seconds, or run one check without keeping the process
open:

```bash
spotalert watch ourdomain-amsterdam-diemen --interval 600
spotalert watch ourdomain-amsterdam-diemen --once
```

Browser-backed profiles launch Chrome once per watch session. SpotAlert then
reloads the same page for every check while requesting cache revalidation with
`Cache-Control: no-cache` and `Pragma: no-cache` headers.

From the TUI, select **Return home and stop watching**, press `Esc`, `Q`, or
`Ctrl+C` to stop an active watch. SpotAlert keeps the TUI responsive while it
closes the browser session, then returns home or exits.

The OurDomain profile treats `Get Notified` as unavailable. Configure it with:

```bash
spotalert profile add ourdomain-amsterdam-diemen \
  "https://thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-diemen2/floorplans.aspx" \
  --rule-type css \
  --query 'td[data-selenium-id^="Availability_"]' \
  --expected-text "Get Notified" \
  --match-mode not_equals \
  --fetch-mode browser \
  --headed \
  --capture-on-available
```

## Development

The repository provides Make targets following the same developer workflow as
PyMieSim:

```bash
make help
make editable
make browser
make check
```

Run the test suite:

```bash
python -m pytest
```

The Chrome extension behavior tests additionally use Node's built-in runner:

```bash
node --test tests/chrome_extension.test.cjs
```

Run the linter:

```bash
python -m ruff check .
```

Install the repository hooks:

```bash
pre-commit install
```
