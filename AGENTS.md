# SpotAlert Contributor Guide

## Product and architecture

- Treat the Manifest V3 Chrome extension in `SpotAlert/chrome_extension/` as
  the primary application. Monitoring, profile searches, email delivery, and
  application assistance run in the user's normal Chrome profile.
- Keep the Python package deliberately separate. Its CLI/TUI and HTTP or
  Playwright availability checks are legacy, independent tools; do not make a
  change to one imply a change to the other unless the feature explicitly
  requires both.
- The optional Python native host in `SpotAlert/profile_host.py` only mirrors
  applicant profiles to a local file on macOS/Linux. It is not required for
  extension monitoring or applications. The old monitoring bridge modules
  remain only for compatibility.
- Supported websites and their provider-specific selectors, parsing, and
  application configuration live in `SpotAlert/chrome_extension/sites/`.
  Add or alter site behavior there rather than spreading provider conditionals
  through the engine or UI.
- Preserve the extension's orchestration boundaries:
  `background.js` validates and routes Chrome events; `engine.js` coordinates
  persisted state and commands; `scheduler.js` owns timers and alarms;
  `page.js` reads listings; `search-actions.js` performs profile actions; and
  `application-runner.js` runs application assistance.

## Safety and user control

- Availability results are not proof that a unit can be reserved. Never invent
  an application URL or substitute a guessed application action for one
  extracted from the page.
- Keep reservation, consent, document upload, payment, lease review, and final
  submission under explicit user control. Application automation must stop
  clearly when it reaches an unfamiliar or sensitive step.
- Treat applicant records, passwords, email settings, API keys, native-host
  tokens, page captures, diagnostics, and browser-storage data as sensitive.
  Do not log, export, or add fixtures containing real values.
- Preserve the existing diagnostic redaction and bounded-storage behavior.
  Reports must exclude profile data, credentials, request bodies, and page
  contents unless a user has explicitly enabled a documented debug capture.
- Respect the extension manifest's least-privilege host permissions. Add a
  host permission only when the new supported-site functionality requires it.

## Extension conventions

- The extension uses plain ES modules, HTML, and CSS: do not introduce a build
  step, bundler, or npm dependency without an explicit project decision.
- Persist extension state through the existing Chrome-storage helpers and
  engine mutation flow; do not add parallel stores or write ad hoc state from
  UI modules.
- Keep monitoring semantics distinct: a failed, pending, or stale check is not
  the same as a confirmed check with no matches. Preserve retry, cancellation,
  alarm recovery, and browser-fallback behavior when changing check flows.
- Reuse shared validation and normalization helpers from `core.js`, profile
  helpers from `profile.js`, and supported-site definitions from `sites/`.
  Validate incoming runtime messages before dispatching actions.
- Maintain the explicit separation between general location monitoring and
  applicant-specific searches. Monitoring itself must not start emails,
  notifications, or applications.

## Python conventions

- Support Python 3.10+ and follow the Ruff configuration in `pyproject.toml`
  (88-character lines; E4, E7, E9, F, and I rules).
- Keep profile and watch-state data compatible with existing on-disk JSON.
  Validate file data and surface malformed data as clear errors rather than
  silently discarding it.
- Browser-mode Python checks use a separate persistent Chrome profile, not the
  user's everyday Chrome session. Do not blur this boundary.

## Testing and validation

- For extension logic changes, run the focused Node behavior test:
  `node --test tests/chrome_extension.test.cjs`.
- For Python changes, run the affected `pytest` tests. Use
  `python -m pytest` when a focused test is not sufficient.
- Run `python -m ruff check .` for Python changes. `make check` runs Ruff,
  Python tests, and the extension behavior test together.
- Use the Playwright browser scripts only for the relevant browser-facing
  behavior. They run against isolated local fixtures and must not access a
  developer's real Chrome profile or live rental site.
- Update `README.md` and the focused docs under `docs/` when changing
  user-facing extension behavior, safety boundaries, setup, or legacy Python
  behavior.

## Useful references

- `README.md`: primary extension workflow, supported sites, privacy boundaries,
  and development commands.
- `docs/PYTHON.md`: legacy CLI/TUI behavior and setup.
- `docs/PROFILE_HELPER.md`: optional local applicant-profile helper and its
  privacy model.
- `docs/application-flow-investigation.md`: verified versus unverified
  application-flow findings; do not treat its unconfirmed routes as contracts.
