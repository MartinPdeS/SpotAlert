# Extension development

The Manifest V3 extension is the primary app. It runs directly from its source
files: plain ES modules, HTML, and CSS, with no build step or npm dependencies.
The optional Python tools remain independent.

## Ownership and dependencies

- `background.js` accepts messages only from the extension workspace and routes
  Chrome events. `contracts.js` validates command envelopes before engine
  dispatch; command handlers retain domain-specific validation and build checks.
- `engine.js` coordinates commands, page reads, cancellation, and scheduling.
  `engine-store.js` owns its single serialized storage mutation queue. An update
  must complete and persist before the next update begins. Callers receive write
  failures; the queue remains available for subsequent work. Updates operate on
  storage snapshots and must not call `state()` or nest another mutation.
- `engine-recovery.js` migrates saved monitoring/search state and marks unfinished
  work after a worker restart. It preserves duplicate-protection claims. It does
  not schedule timers, open tabs, send mail, or run applications.
- `scheduler.js` owns timers and alarms; `page.js` owns listing reads;
  `search-actions.js` owns applicant-specific matching and action queues;
  `application-runner.js` owns application assistance. `application-context.js`
  shares tab locking and application-tab selection across manual and automatic
  runs. Provider-specific behavior stays in `sites/`.
- `debug-capture.js` owns optional, bounded page captures. It receives the same
  engine mutation and generation guards; a capture failure does not turn a
  successful availability check into a failed check.
- `panel.js` coordinates UI state and drafts. `panel-searches.js`,
  `panel-delivery.js`, `panel-application.js`, and `panel-maintenance.js` own their
  focused views. `panel-navigation.js` owns accessible tab selection.
  `panel-profile-fields.js` constructs applicant inputs without persisting data.
  `panel-dom.js` constructs elements with text nodes, never interpreting applicant
  or website text as HTML. View controllers receive state getters and commands.

Persist application data through existing engine commands. UI preferences retain
their existing dedicated Chrome-storage key. Do not introduce a second engine
store or mutate persisted application data from a view controller.

## State contracts

`contracts.js` contains shared JSDoc types for commands, monitors, searches,
results, and action records. These document the boundary without changing the
stored JSON format or replacing runtime validation. Update the types and relevant
validators together when adding a command or changing a state shape.

Monitoring progresses from `paused` or `waiting` through `queued`, `refreshing`,
`reading`, and optionally `capturing`. A successful check returns to `waiting`
when recurring monitoring is enabled, or `paused` after a one-off check. Scheduled
checks outside the configured window wait in `waiting-hours`. Failures enter
`error` and use existing retry/backoff scheduling. Cancellation preserves the last
successful observation; it does not establish current availability.

Presentation derives `current`, `checking`, `unchecked`, `failed`, and `outdated`
from the check phase, error, and last successful result time. Only `current`
represents a confirmed result. Historical matches are not evidence of current
availability. Use `ui.js` calculations rather than inventing another status model.

Search actions are claimed before execution and progress from `queued` to
`running`, then `sent`, `review`, or `failed`. Restarted unfinished attempts become
`interrupted`; their claims remain. Cancelled, unstarted work releases its new
claim or restores the previous claim for an explicitly authorized repeat.
Applications use `application-state.js` stages and stop for user review at
sensitive or unfamiliar steps; an attempt is not a final submission.

## Workspace presentation

Search cards use `searchOverview()` in `ui.js` for current, pending, failed, and
historical outcomes. Preserve the distinction between a recurring search being
Running and its results being current. Scheduling details live in the results
dialog; the Start dialog summarizes saved options and hides optional changes.
Starting still requires the existing engine readiness and generation checks.

`profileReadinessForSite()` in `profile.js` reads a site's declared required and
review fields without making optional bank or identification details mandatory.
Applicant sections, missing-field links, and the attention list reuse these
requirements. Selecting a readiness location is presentation state, not a draft
edit or an assignment of that applicant to a website.

## Styles

`panel.css` is the dashboard's single stylesheet. Shared color, type, spacing, and
radius tokens live at the top. Slate foundation tokens (`--bg`, `--surface`,
`--raised`, `--field`) keep surfaces neutral. Use `--accent` for interaction and
focus, `--success` for confirmed positive states, `--amber` for attention, and
`--red` for errors. Each status has a matching subtle surface and border token.
Keep text/action contrast when changing these tokens. Component rules and responsive overrides preserve
the cascade's ordering. Superseded declarations have been removed. Edit existing
component rules rather than appending a new override sheet. Keep responsive
behavior with the relevant rule group where cascade order permits, and verify
both desktop and narrow layouts after moving declarations.

## Tests

Run all extension behavior tests with the stable entrypoint:

```sh
node --test tests/chrome_extension.test.cjs
```

The entrypoint loads focused suites in `tests/chrome_extension/`: monitoring,
reading, applications, profiles, searches, presentation, and contracts. Shared
Chrome fakes and setup live in `fixtures.cjs`. Focus one area with, for example:

```sh
node --test tests/chrome_extension/searches.cases.cjs
```

Browser scripts use `scripts/browser_helpers.py` for temporary profiles, extension
launch, native-host disabling, worker setup, and cleanup. `isolated_extension()`
owns that lifecycle. Restart suites use the lower-level launch helpers with their
own temporary profile. Unmatched HTTP(S) browser requests and external DNS resolution are blocked;
register synthetic routes explicitly. Worker HTTP(S) fetches are blocked unless
a suite installs its own explicit response stub. Hybrid-reader tests opt into background parsing and
supply their own worker fetch responses. Never use a real Chrome profile, real
applicant details, live rental pages, or actual email delivery in tests.

```sh
make extension-browser-test PYTHON=.venv/bin/python
make check PYTHON=.venv/bin/python
```

The first command covers isolated browser flows; the second runs Ruff, Python
unit tests, and the complete extension behavior suite. Tests that exercise legacy
local bridges need permission to create local sockets.

## CI and release artifacts

The repository's GitHub Actions checks use the shared MPSActions quality and
Python-test workflows alongside the extension behavior suite, isolated Chromium
fixtures, and a Python distribution build. The wheel asset check compares its
contents with the extension source tree. Tag builds retain the distributions and
an extension zip as Actions artifacts after all checks pass. The Python package
tag and Chrome manifest version are independent; see `CONTRIBUTING.md` for the
release process and artifact retention.
