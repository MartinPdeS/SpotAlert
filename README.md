# SpotAlert

A standalone Chrome extension for monitoring website availability in your
normal browser session. Open the side panel, select a supported website, inspect the
matched elements, and watch for changes. **No Python process, TUI, native
messaging bridge, or remote-debugging setup is needed.**

## Install or update

Requires Google Chrome 120 or newer.

1. Open `chrome://extensions` in your regular Chrome profile.
2. Enable **Developer mode**, choose **Load unpacked**, and select
   [`SpotAlert/chrome_extension`](SpotAlert/chrome_extension).
3. Pin SpotAlert to the toolbar and click its icon to open the side panel.

If you installed the earlier bridge extension, click **Reload** on its existing
card instead. The extension ID is unchanged. Chrome may ask you to approve the
updated permissions or reenable it. The previous Python bridge is no longer used;
you can close the TUI. No terminal command is needed to use the extension.

The expand button opens the same interface as a full-page developer workspace.

## Debug application links

Expand **Debug capture** in the sidebar and enable **Open and capture application
links**. This is off by default. After a successful refresh it opens matching,
available direct HTTP(S) application links in background tabs and inspects their
loaded pages. Opening a link may itself start a reservation on the provider's site.
JavaScript-only buttons are not automatically clicked, and no application forms
are filled or submitted by debug capture.

Each link is opened once per availability period, with up to three new captures
per check. Repeated checks and worker restarts do not reopen an unchanged link.
The latest 20 captures are stored in Chrome extension storage; the sidebar shows
the latest five. **Export captures** downloads all retained captures as JSON.
**Clear captures** deletes saved output without reopening already-seen links.

Captures contain page text, URL, form field labels/types/required flags, file-upload
accept rules, form actions, and button labels. Input values, raw HTML, cookies,
screenshots and document contents are excluded. Saved contact details and email
addresses are redacted from text; most query values are redacted from URLs.
Visible page text can still contain personal information, so review exports before
sharing them. Debug exports are ignored by Git. Capture failures and verification
pages are recorded without changing successful availability results. Destination
tabs stay open for inspection. Redirects beyond the supported hosts require manual
inspection. Disabling debug mode or Stop all cancels pending capture work.

## Prepare application details

Open **Personal information** in the sidebar to save your first and last name,
email, phone, street address, postal code, and city. These details stay in
Chrome local extension storage, separate from monitor history and rule exports.
**Delete saved details** clears them. An application readiness badge checks that first name, last name, valid email, and phone are saved; address fields remain optional. Additional application requirements still need review.

Personal information includes identity and contact details, moving preferences,
current housing, employment and income, emergency contacts, education, application
choices, and optional identification/bank details. A completeness indicator tracks
fields required by the current Canvas applicant form. Existing profiles are preserved.

For all supported locations, **Apply** opens the selected floor plan in a separate tab, follows **Book now**,
selects the first allowed move-in date on or after your preference (or the earliest
allowed date if none is saved), clicks **Start Application**, and fills supported application
steps from saved details. It follows ordinary Next/Continue actions until the website
needs missing information, documents, verification, agreements, registration/login,
payment, lease review, or final submission. Registration fields (including a saved
password) are filled, but account creation is manual. A progress card shows where
it stopped, opens the application tab, and offers Continue application after you
complete the manual step. Stop application and Stop all halt automation. Calendar limits and excluded weekends are respected. The
flow waits for Canvas's background form updates and leaves monitoring on its original
tab. Login or verification prompts may require manual completion.

Use **Fill application form** to fill an application already open in the active tab.
Known RentCafe applicant and registration fields use explicit mappings to keep applicant, employer and emergency-contact
details separate. Existing entries are preserved except repeated applicant birth-date
fields, which are synchronized with your saved date. Consent agreements and final
application submission remain manual. Other supported sites use common English/Dutch
labels and autocomplete attributes; unusual or embedded fields may need manual entry.

## Monitor supported housing websites

OurDomain Amsterdam Diemen, Amsterdam South East, and Canvas Rotterdam Blaak monitors are included, initially paused. Select one
and press **Check now** to inspect the rule, or **Start watching** to monitor it.
SpotAlert opens or reuses a tab in your current Chrome profile.

Diemen reads `td[data-selenium-id^="Availability_"]`. South East reads
`td[data-selenium-id^="Apply_"] [data-selenium-id="ApplyNow"]`. Both treat
**Get Notified** as unavailable. Any nonempty matching element with different
text counts as availability. Hidden responsive duplicates are ignored. South East also reads collapsed floor-plan
button labels and deduplicates desktop/mobile copies by listing ID. Verify the actual cells in **Floor plans**.

The interface shows:

- Green cards for actively monitored websites; neutral cards for paused sites.
- Live browser refresh and reading activity, plus a next-check countdown.
- A red **Stop all** button in the header pauses every monitor and cancels pending checks while preserving tabs, settings, and results.
- A single monitoring toolbar with start/pause, Check now, refresh interval, and settings.
- Last successful check, availability, and total completed checks.
- Prominent floor-plan names and room types, with rent, bedrooms, size, and bathrooms in separate rows where provided by the website.
- Available listings first, with All, Available, and room-type filter chips. These view filters do not change monitoring or alerts; configure apartment preferences in settings.
- A collapsible **Technical details & activity** section containing the selector, comparison rule, and check history.
- Errors naming the affected site, recovery actions, and notification failures.
- Responsive cards and a sticky monitoring toolbar in narrow side panels.
- A **Compact view** toggle that remembers your preference and reduces listing spacing.
- Separate available-website and available-apartment totals. Apartment totals show **≥** when a website provides floor-plan availability without exact unit counts. Totals reflect the last successful results.
- Live freshness labels on website cards and selected results. Results become stale after three refresh intervals, with a minimum of one minute.

Alerts track individual floor plans, so a newly available listing alerts even
while another listing is already available. When the site publishes a unit
count, an increase also triggers an alert. Repeated results do not repeat alerts.

Pop-ups and desktop notifications include the apartment name, rent, and listing
link. Each pop-up offers an **Apply** link when the website exposes an application
URL. For JavaScript-only actions, **Open application** uses the site's actual
application button, including opening collapsed floor-plan sections. It never
submits an application or clicks **Get Notified**. Desktop notification clicks
keep the original listing target even if a newer alert arrives.

## Apartment filters and alerts

In **Configure monitor**, select studios, one-bedroom, two-bedroom, or larger
apartments, and optionally choose specific floor plans. Run **Check now** first
to load floor-plan choices. No selection means all listings; type and floor-plan
filters both apply. Excluded listings remain visible as **Filtered out** but do
not affect availability or alerts. Saving configuration pauses monitoring.

**Test notification** previews the pop-up and desktop alert without changing
availability results. The optional **Play a sound with alerts** setting uses an
offscreen audio document, so sound works with the panel closed. Chrome may ask
you to approve the added `offscreen` permission when reloading this update.
Desktop notification delivery also depends on your operating system settings;
delivery failures are recorded in activity.

**Pause monitoring** stops refreshes and leaves the website tab open.

## Supported websites

The workspace lists known websites with built-in availability rules. Currently,
**OurDomain Amsterdam Diemen**, **OurDomain Amsterdam South East**, and **Canvas Rotterdam Blaak** are supported. There is no current-tab discovery,
custom-site creation, or element picker. Switching tabs does not change which
website is monitored.

Use **Configure monitor** to review the rule, change notifications, or preview
its results. The website name and URL are fixed. Saving pauses monitoring.
Refresh presets are available directly in the monitor controls.

Existing OurDomain settings and history are preserved. Previous custom monitors
are paused and archived locally, rather than deleted.

Matching ignores case and extra whitespace. Missing or empty elements are an
error. **Export rules as JSON** saves configuration without check history.

## Scheduling and storage

Refresh intervals start at **5 seconds**. Intervals below 30 seconds use a
background worker timer with a 30-second recovery alarm; longer intervals use
Chrome alarms. Fast checks continue with the panel closed, but worker suspension
can delay a check until the recovery alarm fires. The panel can be closed while monitoring continues. Enabled
monitors and results survive worker suspension and Chrome restarts. Interrupted
checks retry, and missing alarms are recreated.

Chrome must be running. Alarms can be delayed by sleep, browser throttling, or
a long-running check; the countdown shows the scheduled time, not a guarantee.
Monitors are checked one at a time, and the next interval begins after each
check completes. Closed monitored tabs are recreated at the next check.

The **Refresh every** dropdown beside the monitoring controls offers 5 seconds, 30 seconds,
1 minute, 5 minutes, 10 minutes, 30 minutes, and 1 hour. Changes apply to active
watches without pausing them or clearing their results and history.

Optional **Monitoring hours** run daily in the chosen IANA timezone, including
overnight windows and daylight-saving changes. Automatic checks wait until the
next allowed time; **Check now** still works outside the schedule. The default
is unrestricted monitoring in your browser's timezone.

Errors distinguish verification prompts, sign-in pages, loading failures, and
broken selectors. **Open affected tab** brings the actual failed tab forward,
including a redirected login page. SpotAlert retries with increasing delays:
at least 30 seconds after ordinary errors or 60 seconds for verification/login,
up to 15 minutes (or the chosen interval if longer). Successful checks restore
the normal interval. Backoff and monitoring hours survive worker suspension.

Configuration, results, and up to 80 history entries per monitor are stored in
`chrome.storage.local`, for supported websites. Data is not sent to a server or
synced to another device. Access to supported websites is declared upfront.

## Development

The extension uses plain JavaScript modules, HTML, and CSS. No build step or npm
installation is required; edit the files and reload the extension in Chrome.

- [`core.js`](SpotAlert/chrome_extension/core.js): validation, matching, and the OurDomain adapter.
- [`engine.js`](SpotAlert/chrome_extension/engine.js): persisted monitoring state, alarms, tab refreshes, and notifications.
- [`page.js`](SpotAlert/chrome_extension/page.js): page text extraction.
- [`alerts.js`](SpotAlert/chrome_extension/alerts.js), [`audio.html`](SpotAlert/chrome_extension/audio.html), [`audio.js`](SpotAlert/chrome_extension/audio.js): optional background audio playback.
- [`background.js`](SpotAlert/chrome_extension/background.js): Chrome event routing and extension-message validation.
- [`panel.html`](SpotAlert/chrome_extension/panel.html), [`panel.css`](SpotAlert/chrome_extension/panel.css), [`panel.js`](SpotAlert/chrome_extension/panel.js): side panel and full-page workspace.

Behavior tests use Node 20 or newer:

```bash
node --test tests/chrome_extension.test.cjs
```

For a real-browser integration test, install the optional Python developer
runtime and Playwright Chromium using the [Python setup](docs/PYTHON.md), then:

```bash
playwright install chromium
python scripts/test_extension_browser.py
python scripts/test_extension_features.py
```

This test runs an isolated browser profile against a local listing fixture. It
exercises preview, extraction, refresh, availability transitions, fixed website selection,
invalid selectors, actual Chrome alarms, browser restart, and pause. The feature
test also exercises apartment filters, per-listing alerts, real application links,
offscreen sound playback, snooze, monitoring hours, and verification/login recovery.
It saves UI screenshots under `artifacts/extension`. Your Chrome profile and
rental website are not accessed. The Python runtime is only needed for this test.

The older HTTP/API checker and TUI remain available as
[legacy Python tools](docs/PYTHON.md). Their `browser` mode uses a separate
persistent Chrome profile; their former `extension` mode now directs users to
the standalone app. The native bridge modules remain for compatibility tests
and are not used by the standalone extension.

Notification settings are grouped in the **Notifications** tab: independent global pop-up and desktop alerts, sound, test alerts. Changes take effect without pausing monitoring. You can save a phone number and email destination separately from application details; SMS delivery is not implemented yet. Resend email delivery runs directly in the extension.

The **Personal information** tab contains your application details, readiness badge, and the Fill application form action. Unsaved edits remain intact during monitoring refreshes.

### Resend email alerts

Reload the extension, then open **Notifications**. Enter your recipient, paste your Resend API key, enable email, and save. The sender defaults to `onboarding@resend.dev`, which can only email the address registered with Resend. Use a sender from a verified domain for other recipients. Click **Send test email** to check delivery.

Emails are sent directly by the extension’s background worker to Resend; no local bridge or Python process is needed. The key is saved in Chrome local storage, separate from rules and exports, and is not included in extension source or the ZIP. Chrome must keep running; closing the panel is fine. Pop-up, desktop, sound, and email channels have independent global switches. Provider failures appear in activity without changing successful availability results. Failed sends are not automatically retried. Requests use Resend idempotency keys to prevent duplicate sends of the same alert.

Notification settings apply to every monitored location. Availability pop-ups also appear on open supported housing website pages, including while the panel is closed. Recent alerts (up to ten minutes old) survive page reloads until dismissed; dismissal is shared across website tabs. Reload existing website tabs after reloading the extension to install its page pop-up script.

Canvas Rotterdam Blaak is monitored through its [RentCafe floor-plan portal](https://canvas-world.securerc.co.uk/onlineleasing/andre-van-der-louwbrug-4-rotterdam-3011-wm/floorplans.aspx), linked from the [Canvas location page](https://www.canvas-world.com/nl/locations/netherlands/rotterdam/blaak). The marketing page’s permanent “View apartment” links are not availability signals. The reader supports RentCafe Apply/Availability cells, including collapsed floorplans and responsive duplicates. Canvas also receives the global notifications, filters, application details, and debug capture controls. If Chrome shows a verification prompt, open the affected tab and complete it before checking again.

Click the SpotAlert toolbar icon to open the dashboard in a full-width Chrome tab. Applications that need more details show a complete missing-field checklist, with shortcuts to Personal information and the application tab. Continue the application directly on the website; the dashboard has no resume controls. Unfamiliar application forms stop automatically and offer a downloadable field-structure report (labels and types, without entered values or URL tracking parameters) to help add support.

Personal information supports named saved applicant profiles. Create or select a profile, then save its details. Apply and Fill application form use the selected saved profile, including its account password. Existing details migrate into My profile; profiles stay in Chrome local storage.

The Clients tab prepares an email questionnaire using the configured Resend sender, with a client recipient and your reply-to address. Preview or copy it before sending. Paste the completed details block to review answers and create a new selected profile. The questionnaire includes an optional existing account password, stored with the imported profile and masked in the review preview. Identification numbers and banking details are not requested by email. Email replies are imported manually; Gmail access is not required.

Local profile storage (macOS/Linux): run `.venv/bin/python -m SpotAlert.profile_host --install` once, then reload the extension. The installed helper migrates Chrome's saved applicants into `SpotAlert/local_profiles/profiles.json`, mirrors subsequent profile saves, and restores that file on extension startup. Personal information includes See profile folder to open it in Finder/file manager. The folder and machine-specific launcher are ignored by Git. This JSON file contains personal details and passwords in plain text with owner-only file permissions; back it up privately. If the checkout or virtual environment moves, rerun the installer. Removing the extension or clearing its storage leaves this folder intact.
