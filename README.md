# SpotAlert

A standalone Chrome extension for monitoring website availability in your
normal browser session. Create a search for a saved profile, select locations,
and choose auto-apply, email, or both. **Monitoring and applications run entirely in Chrome.** Python is optional for
[local profile backups](docs/PROFILE_HELPER.md), browser development tests, and the
[legacy CLI/TUI](docs/PYTHON.md).

## Install or update

Requires Google Chrome 120 or newer.

1. Open `chrome://extensions` in your regular Chrome profile.
2. Enable **Developer mode**, choose **Load unpacked**, and select
   [`SpotAlert/chrome_extension`](SpotAlert/chrome_extension).
3. Pin SpotAlert to the toolbar and click its icon to open the dashboard.

If you installed the earlier bridge extension, click **Reload** on its existing
card instead. The extension ID is unchanged. Chrome may ask you to approve the
updated permissions or reenable it. The previous Python bridge is no longer used;
you can close the TUI. No terminal command is needed to use the extension.

The expand button opens the same interface as a full-page developer workspace.

## Workspace

Navigation follows **My searches, Websites, Applicants, Clients, Settings**.
**My searches** manages applicant-specific matching and email/application actions.
**Websites** manages general website monitoring without applicant criteria.
**Applicants** holds saved applicant details and preferences; **Clients** handles
questionnaires and replies. Reload is available in **Settings → Extension**; an
update-required notice still appears above navigation when needed. Search result
links and availability carry more emphasis than timing and check telemetry.
The shared action bar groups **Start/Stop monitoring** and **Check now** above
the buildings. Each detail panel shows availability and settings. **Stop monitoring** leaves profile searches running; pausing
the last profile search leaves general monitoring running if it is on. Page reads
are shared across both modes.

Tick the checkboxes on building cards to choose the batch scope. All buildings
are selected initially; your choices are saved. On mobile, use **Choose buildings**.
One shared **Check now** and **Start/Stop monitoring** pair uses the ticked
buildings. A selection count shows their scope; both buttons are disabled when
none are selected. If some selected buildings are already monitored, Start
monitoring enables the remaining ones. Stop monitoring stops the entire selection. Viewing a building does not change its checkbox.

**Check now** runs one availability check for the ticked buildings
and shows progress, failures, and a **Cancel checks** control. It does not turn
recurring monitoring on. The building detail panel shows results and settings without duplicate action buttons.

Each building has an **Application activity** section: it shows the last application
attempt or an explicit empty state. Availability checks do not create these records.
Technical traces and report downloads are nested inside the recorded attempt.

While a manual batch is running, **Cancel checks** stops it and keeps any future
scheduled checks. **Stop monitoring** stops recurring general checks for the selection.
**Stop all** stops both general monitoring and every profile search. Running
applications have a separate **Cancel application** control; cancellation cannot
undo requests already sent to a website.

Failed, pending, and outdated checks are distinct from a successful check with no
matches. Previous results remain visible with an unconfirmed label. Error panels
explain the impact, give recovery steps, and offer **Retry check**.

Searches opens first. Each row shows the applicant, configured criteria, match
count, and Start/Pause. Edit and Delete are in the row’s **•••** menu. Open the
match count or **Details** for apartments, location status, exclusions, delivery
history, and duplicate protection. Each apartment has separate **View apartment**
and **Apply** actions.

Click **Needs attention** to see specific recovery tasks: complete an applicant
profile, open an application, review a location, or inspect a failed email and
its settings. Successful subsequent attempts replace older failure notices.

Profiles combine the applicant selector, name, and readiness in one header.
Missing required details link directly to the matching field; optional fields
sit in collapsible sections. Required fields use an asterisk. The no-middle-name checkbox hides and clears the middle
name; employment details hide when the applicant is retired or never employed.
Partial profiles can be saved, and the Save profile bar stays visible while
scrolling. Fictional applicants carry a **Test profile** badge.

Locations keeps its overview collapsed and puts the interval and monitor
configuration under **Options**. Display settings and totals sit below the results. Narrow windows use a location dropdown. Debug captures, build information, rule exports, and the
optional local profile helper are under **Settings → Advanced**.

Error notices include **Copy diagnostics** and stay visible until dismissed or
replaced by a new notification. **Settings → Advanced → Error diagnostics** also
lets you copy or download a report. It includes the extension/build versions,
location failure categories and check times, application traces, and the latest
20 dashboard errors from the current session. Monitor status survives reopening
the dashboard. Reports omit profile records, email settings, request bodies, and
page contents; common credentials, email addresses, and URL paths in error text
are masked. Review the report before sharing it.

## Hybrid availability checks

Availability checks try a direct background HTML request first. Complete,
recognizable floor-plan data is parsed in a detached extension document without
opening a website tab, executing website scripts, or loading its resources.
Profile searches use the same results and keep their existing criteria and actions.

Blocked requests, login/verification pages, custom selectors, missing controls,
conflicting listing data, or missing previously observed plans fall back to the
browser reader. Failed direct attempts have a five-minute cooldown; browser checks
continue at the configured interval during that time. Direct requests have a
five-second timeout and a 2 MB response limit. Cancel check cancels either method.
**Background check** or **Browser check** appears beside the location status;
**Technical details & activity** and diagnostic reports include the fallback reason.

This uses Chrome's **offscreen** permission for HTML parsing. Reload the extension
and accept the permission change if Chrome requests it. Applications and optional
application debug captures still use real browser pages. Existing website tabs are
kept open. Polling intervals and Chrome alarm limitations are unchanged.

Direct requests to all three portals returned HTTP 403 in our initial environment
check, so tab-free operation depends on what the portal allows from your Chrome
session. The browser fallback remains essential; faster live refreshes are not yet
verified. `scripts/test_hybrid_browser.py` covers both paths using isolated fixtures.

## Debug application links

Open **Settings → Advanced → Debug capture** and enable **Open and capture application
links**. This is off by default. After a successful refresh it opens matching,
available direct HTTP(S) application links in background tabs and inspects their
loaded pages. Opening a link may itself start a reservation on the provider's site.
JavaScript-only buttons are not automatically clicked, and no application forms
are filled or submitted by debug capture.

Each link is opened once per availability period, with up to three new captures
per check. Repeated checks and worker restarts do not reopen an unchanged link.
The latest 20 captures are stored in Chrome extension storage; Advanced settings show
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

## Apply with a saved profile

Click **Apply** on an apartment, choose a profile, and confirm. For Canvas, the dialog has an optional **Include Canvas agreements & signature** toggle. It checks the screening agreement (`chkTandCAgree`), bottom agreement (`chkAgreement`), and selects **Signature Type 1**. Review the terms before enabling; Save and final submission remain manual. The toggle starts off for each application. Run `.venv/bin/python scripts/test_signature_browser.py` to check the selections against isolated synthetic pages.

Open **Applicants** to save your first and last name,
email, phone, street address, postal code, and city. These details stay in
Chrome local extension storage, separate from monitor history and rule exports.
**Delete saved details** clears them. An application readiness badge checks that first name, last name, valid email, and phone are saved; address fields remain optional. Additional application requirements still need review.

Profiles include identity and contact details, moving preferences,
current housing, employment and income, emergency contacts, education, application
choices, and optional identification/bank details. A completeness indicator tracks
fields required by the current Canvas applicant form. Existing profiles are preserved.

For all supported locations, **Apply** opens the selected floor plan in a separate tab, follows **Book now**,
selects the first allowed move-in date on or after your preference (or the earliest
allowed date if none is saved), clicks **Start Application**, and fills supported application
steps from saved details. It follows ordinary Next/Continue actions until the website
needs missing information, documents, verification, agreements, registration/login,
payment, lease review, or final submission. Registration fields (including a saved
password) are filled. Review **Create an account if needed** in the Apply
confirmation or profile search: enabling it allows account creation; otherwise
registration stays manual. Existing-account messages stop automation so you can log in. Application activity show where
it stopped and open the application tab so you can complete the remaining steps. Stop application and Stop all halt automation. Calendar limits and excluded weekends are respected. The
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
- Available listings first, with All, Available, and room-type filter chips. These view filters do not change profile searches; edit criteria in the applicant profile.
- A collapsible **Technical details & activity** section containing the selector, comparison rule, and check history.
- Errors naming the affected site and recovery actions.
- Responsive cards and a sticky monitoring toolbar in narrow side panels.
- A **Compact view** toggle that remembers your preference and reduces listing spacing.
- Separate available-website and available-apartment totals. Apartment totals show **≥** when a website provides floor-plan availability without exact unit counts. Totals reflect the last successful results.
- Live freshness labels on website cards and selected results. Results become stale after three refresh intervals, with a minimum of one minute.

Monitoring records location availability and schedules shared checks. It does not
send emails, pop-ups, desktop notifications or sound alerts. Profile searches own
matching, automatic applications and notifications.

## Location filters

**Configure monitor** retains optional apartment-type and floor-plan filters for
the Websites view. Profile searches independently evaluate raw location results
using the selected profile’s preferences. Saving location configuration pauses it;
active searches will restart any location they still require.

## Supported websites

The workspace lists known websites with built-in availability rules. Currently,
**OurDomain Amsterdam Diemen**, **OurDomain Amsterdam South East**, and **Canvas Rotterdam Blaak** are supported. There is no current-tab discovery,
custom-site creation, or element picker. Switching tabs does not change which
website is monitored.

Use **Configure monitor** to review the rule, change scheduling, or preview
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

See [the development guide](docs/DEVELOPMENT.md) for module ownership, shared
command/state contracts, restart transitions, the consolidated stylesheet, and
focused behavior suites. The existing `node --test tests/chrome_extension.test.cjs`
command still runs every extension behavior test. Browser suites share isolated
setup in `scripts/browser_helpers.py` and block unmatched browser requests.

- [`sites/`](SpotAlert/chrome_extension/sites/): provider-specific rules and application configuration.
- [`core.js`](SpotAlert/chrome_extension/core.js): shared validation and matching.
- [`engine.js`](SpotAlert/chrome_extension/engine.js): monitor state and command coordination.
- [`scheduler.js`](SpotAlert/chrome_extension/scheduler.js): fast timers and recovery alarms.
- [`profile-store.js`](SpotAlert/chrome_extension/profile-store.js): Chrome storage and optional profile-folder synchronization.
- [`application-runner.js`](SpotAlert/chrome_extension/application-runner.js): application runs, cancellation, and diagnostics.
- [`search-actions.js`](SpotAlert/chrome_extension/search-actions.js): profile matching, duplicate claims, and queued delivery/application actions.
- [`page.js`](SpotAlert/chrome_extension/page.js): page extraction and listing actions.
- [`background.js`](SpotAlert/chrome_extension/background.js): Chrome event routing and message validation.
- [`panel.js`](SpotAlert/chrome_extension/panel.js): monitoring and profile workspace, with search UI in [`panel-searches.js`](SpotAlert/chrome_extension/panel-searches.js) and email/client UI in [`panel-delivery.js`](SpotAlert/chrome_extension/panel-delivery.js).

Start with `make extension` for installation instructions and `make extension-test`
for behavior checks. `make install` installs the optional Python developer tools.

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
test also exercises location filters, monitoring hours, verification/login recovery,
profile editing, and debug captures. Search and email tests run with:

```bash
python scripts/test_searches_browser.py
python scripts/test_email_browser.py
python scripts/test_panel_browser.py
python scripts/test_profile_browser.py
python scripts/test_application_browser.py
python scripts/test_workspace_browser.py
```
It saves UI screenshots under `artifacts/extension`. Your Chrome profile and
rental website are not accessed. The Python runtime is needed only for browser tests, optional helpers, and legacy tools.

The older HTTP/API checker and TUI remain available as
[legacy Python tools](docs/PYTHON.md). Their `browser` mode uses a separate
persistent Chrome profile; their former `extension` mode now directs users to
the standalone app. The old monitoring bridge modules remain for compatibility tests. The separate
optional applicant-profile helper uses native messaging only for local file storage;
see [profile helper setup](docs/PROFILE_HELPER.md).

### Email delivery settings

**Settings → Email delivery** contains the shared Resend API key and sender used
by profile searches and client questionnaires. There is no general notification
recipient or global email switch. Enable email for each profile search; it sends
to that profile’s saved email address. SMS remains unavailable.

To test delivery, select a saved profile in Settings and click **Send test email**.
The test uses that profile’s email explicitly. A verified sender is required for
other recipients; `onboarding@resend.dev` only emails the Resend account owner.
Keys are stored locally and excluded from rule exports. Provider failures appear
in the search action history. Requests use idempotency keys. Chrome must remain
running, though the dashboard can be closed.

Canvas Rotterdam Blaak is monitored through its [RentCafe floor-plan portal](https://canvas-world.securerc.co.uk/onlineleasing/andre-van-der-louwbrug-4-rotterdam-3011-wm/floorplans.aspx), linked from the [Canvas location page](https://www.canvas-world.com/nl/locations/netherlands/rotterdam/blaak). The marketing page’s permanent “View apartment” links are not availability signals. The reader supports RentCafe Apply/Availability cells, including collapsed floorplans and responsive duplicates. Canvas supports profile searches, application details, and debug capture controls. If Chrome shows a verification prompt, open the affected tab and complete it before checking again.

Click the SpotAlert toolbar icon to open the dashboard in a full-width Chrome tab. Application results, missing fields, and form structure are available inside the collapsed Application activity. Continue the application directly on the website; the dashboard has no resume controls. Unfamiliar application forms stop automatically and offer a downloadable field-structure report (labels and types, without entered values or URL tracking parameters) to help add support.

If Apply stalls, expand Application activity under the selected location, then Technical trace & report. It shows the dashboard/run build, inspected pages, date selection, Start Application click and retry results, and stopping reason. Download debug report exports only control metadata; it excludes profile details, passwords, page content and URL query strings. Reload the unpacked extension at chrome://extensions and reopen the dashboard before reproducing a failure on a new build. Background-worker restarts are recorded separately from website failures.

Profiles support named saved applicant profiles. Create or select a profile, then save its details. Apply and Fill application form use the selected saved profile, including its account password. Existing details migrate into My profile; profiles stay in Chrome local storage.

The Clients tab prepares an email questionnaire using the configured Resend sender, with a client recipient and your reply-to address. Preview or copy it before sending. Paste the completed details block to review answers and create a new selected profile. The questionnaire includes an optional existing account password, stored with the imported profile and masked in the review preview. Identification numbers and banking details are not requested by email. Email replies are imported manually; Gmail access is not required.

Local profile storage is an optional macOS/Linux helper. See [setup, storage format, and privacy details](docs/PROFILE_HELPER.md). Monitoring and applications work without it.

### Two realistic fictional test profiles

In **Applicants → Profile actions**, click
**Generate two realistic test profiles**. This adds two clearly named fictional
applicants and selects the first one. Both have generated passwords, birth dates, and different housing
preferences. Their emails use `example.com`; identification and bank fields
stay empty. Use them with synthetic forms, rather than real applications or email delivery.
Each click regenerates only the two marked test profiles, without adding duplicates.
Other saved applicants are preserved. Names, addresses, careers, income and moving
preferences are coherent fictional examples.
**Generate password** changes only the password of the selected profile; it leaves
birth dates and other identity details untouched.

Apply asks you to choose a saved profile for each application. Moving preferences include a maximum published monthly rent, minimum size in square metres, apartment type, and earliest move-in date. These preferences filter profile-search results; unknown rent/size does not pass a configured limit. Rent ranges use the highest published amount. Apply confirms the applicant, apartment, rent and move-in preference before filling, then reports the date selected from the actual website calendar. Profiles show only the selected profile’s readiness and missing details, without listing locations. Each search shows its application and email history, with explicit authorization required for another attempt. Email Sent means the provider accepted the request, not that the recipient read it.

Apply confirmation includes Create an account if needed. When enabled, the supported registration form is filled and Create My Account is clicked once after required details pass validation. Existing-email errors stop the flow and direct you to log in. Verification, application agreements, charges and final submission remain manual. Account creation accepts the website account Terms and Privacy Policy; marketing subscriptions are left untouched.

Telephone fields with a country selector use the website's phone-widget API during autofill so international prefixes select the correct country and number format. The saved profile retains the original phone number. Website field validation is checked before advancing; invalid fields appear in the missing-details checklist instead of only a generic validation warning.

Start Application waits for the selected date, an idle lease update, and a stable enabled button, then uses the website’s form validation before clicking. SpotAlert confirms arrival at the applicant page, waits 15 seconds before retrying an idle booking form, and limits the run to three click attempts. Active page updates and visible verification prompts prevent retries. Application activity distinguish click attempts from confirmed navigation. Run `.venv/bin/python scripts/test_booking_browser.py` for delayed-handler, replaced-form, lost-click, slow-request, validation and verification fixtures.

### Location configuration

Location definitions live in `SpotAlert/chrome_extension/sites/`: `diemen.js`, `south-east.js`, and `canvas-blaak.js`, registered in `index.js`. Each definition owns its catalog identity, URL, availability rule, collapsed-plan reader behavior, and application capabilities. South East also owns its shipped-rule migration. `rentcafe.js` supplies the common booking paths, wait times and retry limits; Canvas overrides the floor-plan entry behavior and declares its agreement/signature controls.

The shared engine handles navigation, validation, retries, monitoring and profiles. It passes serializable site capabilities into injected page functions, which cannot access module imports. Custom selectors retain ordinary visibility filtering. Existing monitor IDs, stored settings, profile data and histories stay compatible. To add a location, register its module and declare its hosts in the extension manifest; no build step is required.

### Application workflow and recovery

Apply is the dashboard’s application action. It asks which saved profile to use for that run and offers the Canvas agreement/signature opt-in in the same dialog. Choosing a profile for Apply does not change the active profile or assign it to the location. Apply shows Applying while its single run executes. The dashboard has no ongoing application card; run results and technical details remain in collapsed Application activity. Verification and missing-detail stops offer a button to the affected tab; each Apply runs continuously and stops at review or when input is required. There are no resume or retry controls; start a fresh run with Apply. Signing, payment and final submission still require review on the website.

Application operations hold a per-tab lock across asynchronous work; duplicate preparation or retry requests cannot change that tab concurrently. Locks release after success, cancellation or failure. Worker restarts mark interrupted runs for review. Settings → Advanced displays the extension version and application build, checks its worker and source build periodically, and offers extension-settings and dashboard-reload buttons if they differ. Application writes from a stale dashboard are rejected before execution.

### Profile-oriented searches

Open **My searches** and choose **New search**. Select a saved applicant profile,
choose locations, and select **Email the profile holder**, **Auto-apply**, or both.
Budget, minimum size, apartment type and move-in date are read directly from the
profile and displayed as a read-only summary. Edit them once in **Applicants**; all searches for that profile use the updated values. Existing
copied search overrides are retired without changing the saved profile.
Saving creates or updates a paused search. **Start search** opens an action dialog
with separate auto-apply, email and SMS switches. Each switch has an explicit On/Off
label, a distinct thumb position and an enabled checkmark. Choose the actions and
confirm to begin; cancelling leaves the search paused. SMS is visibly unavailable
until an SMS provider is added. **Pause search** stops that search without
interrupting other profiles.

Locations share one page read across active searches. When starting a search,
choose its refresh interval; new searches default to **5 seconds**. A shared
location uses the fastest interval requested by its active searches or general
monitoring. Search matching uses the location’s availability rule and its
assigned profile’s current preferences, independently of location filters and
the currently selected dashboard profile. Monitoring hours and error backoff
remain configured in **Websites**.

Each search card shows its effective interval, next-check countdown, and a
compact check/match/action timeline. Use its **Check now**, refresh selector,
or Start/Pause controls without opening the details view. Location-health
indicators in search details identify healthy, delayed, checking, or
attention-needed locations; select one to open that location and its recovery
guidance.
Standalone location watches continue checking without sending notifications.
A location started by searches pauses when its last search pauses; a location
that was already being watched independently continues checking. **Stop all**
pauses every search and location and cancels running application automation.

Profile emails use the address saved in the applicant profile, rather than the
general recipient. Configure a Resend API key and verified sender in
**Settings → Email delivery** first. The search email action is its only notification
switch. With both actions selected, the email includes the application
outcome. Provider acceptance is recorded in the search’s action history.

Auto-apply opens a separate tab and uses a snapshot of the profile, including its
preferences, captured when the match was found. Switching or editing profiles does
not change an already queued application. Applications run in sequence, separately
for each applicant. Account creation is a separate opt-in on the search; account
Terms and Privacy Policy apply when enabled. Canvas agreements/signature, verification,
missing details, payments, and final application submission require manual review.
Open the application from its search action history to continue on the website.

Emails and automatic applications are deduplicated permanently by profile,
location, and listing, including overlapping searches and worker restarts. A
listing disappearing and returning does not trigger another automatic application
or email for that profile. Failed or interrupted actions remain visible for review
and are not automatically retried. Actions cancelled before execution can be picked
up by a later successful check after restarting the search. Worker restarts mark
unfinished actions as interrupted, preserving their claims to prevent duplicate
applications. Deleting a search does not erase these duplicate-prevention records.

Run `node --test tests/chrome_extension.test.cjs` for search matching and delivery
behavior, and `.venv/bin/python scripts/test_searches_browser.py` for the isolated
search-editor browser test. The latter uses no real housing pages or email delivery.

#### Understand exclusions and readiness

Expand **Excluded & unavailable** on a search to see why apartments were skipped:
not currently available, a different apartment type, missing published rent/size,
or the exact amount over budget or below minimum size. These explanations use the
assigned profile’s current preferences.

Before a search starts, the action dialog checks the chosen profile, contact
information, location permissions, email credentials/sender and, when selected,
the account password. Missing setup blocks Start. It also lists location-specific
applicant fields: the common RentCafe details for OurDomain, and the expanded
known Canvas requirements for Canvas. Missing website fields are shown as expected
manual input; you can start with review steps. These checks do not establish an
active login, verify the sender with Resend or guarantee the live website will
accept an application. Review profile details from the dialog to fix missing data.

#### Review duplicate protection and authorize another attempt

Listing badges and the **Activity** timeline show the latest
email/application attempt, date and outcome for that profile and location across
all searches, including deleted searches. Older records without retained details
are labeled accordingly. An email accepted by the provider is not proof of inbox
delivery; an application attempt is not a final submission.

To deliberately repeat an action, start the search with that channel enabled,
obtain a fresh successful result where the apartment still matches, then choose
**Send again** or **Try again** in Activity. Review the previous outcome and explicitly
check the authorization box. This schedules one additional attempt and preserves
duplicate protection. Concurrent clicks and outdated dialogs cannot schedule the
same authorization twice. Pausing before an authorized repeat executes restores
the original protection. The latest ten earlier attempts remain with its record.
