import {exclusionReasons, searchClaimKey, claimActionId} from "./searches.js";
import {siteForUrl} from './sites/index.js';
import {clientQuestionnaire, parseClientReply, CLIENT_FIELDS} from "./clients.js";
import {APPLICATION_BUILD, applicationReport} from "./application-diagnostics.js";
import {STORAGE_KEY, siteError, listingKey, safeListingUrl, sitePattern, validateMonitor} from "./core.js";

import {UI_KEY, freshness, availabilityTotals} from "./ui.js";
import {PROFILE_KEY, PROFILES_KEY, PROFILE_FIELDS, PROFILE_SECTIONS, profileCompleteness, temporaryRegistrationDetails} from "./profile.js";

const $ = (selector) => document.querySelector(selector);
let value = {monitors: []};
let selectedId = null;
let workspaceVisited = false;
let showAllSamples = false;
let historyFilter = "all";
let listingFilter = "all";
let technicalOpen = false;
let toastTimer;
let loadingState = false;
let reloadState = false;
let personalProfile = {};
let applicantLibrary = {profiles: []};
let pendingApplication = null;
let compactView = false;
import {EMAIL_KEY, CONTACT_KEY} from "./email.js";
let contactsLoaded = false;
let personalDirty = false;

function element(tag, attributes = {}, ...children) {
  const item = document.createElement(tag);
  for (const [key, attr] of Object.entries(attributes)) {
    if (key === "class") item.className = attr;
    else if (key === "onclick") item.addEventListener("click", attr);
    else item.setAttribute(key, attr);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && typeof child !== "boolean") item.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return item;
}
const busy = (monitor) => ["queued", "refreshing", "reading", "capturing"].includes(monitor.phase);
const clock = (timestamp) => timestamp ? new Date(timestamp).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"}) : "—";
const interval = (seconds) => seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${seconds / 60}m` : `${seconds / 3600}h`;
const domain = (url) => { try { return new URL(url).hostname; } catch { return url; } };
const selected = () => value.monitors.find((monitor) => monitor.id === selectedId);

async function request(message) {
  const response = await chrome.runtime.sendMessage({...message, dashboardBuild: APPLICATION_BUILD});
  if (!response?.ok) throw Object.assign(new Error(response?.error || "SpotAlert could not connect to its background worker. Reload the extension."), response?.details);
  return response.result;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, error ? 9000 : 4500);
}
const guard = (task) => async (event) => {
  try { await task(event); } catch (error) { toast(error.message, true); }
};
async function grant(url) {
  // Called immediately from a button gesture, before any other awaited API.
  const granted = await chrome.permissions.request({origins: [sitePattern(url)]});
  if (!granted) throw new Error("Website access was not granted. This page was not added or inspected.");
}
async function loadState() {
  if (loadingState) { reloadState = true; return; }
  loadingState = true;
  try {
    do {
      reloadState = false;
      const [state, preferences] = await Promise.all([request({type: "state"}), chrome.storage.local.get([PROFILE_KEY, UI_KEY, CONTACT_KEY, EMAIL_KEY])]);
      value = state;
      personalProfile = preferences[PROFILE_KEY] || {};
      const library = await request({type: "profiles"});
      applicantLibrary = library;
      const folder = await request({type: "profile-folder-status"});
      $("#profile-folder-status").textContent = folder.enabled ? `Saved to ${folder.path}/profiles.json` : "Keep a JSON copy alongside SpotAlert.";
      $("#enable-profile-folder").hidden = folder.enabled;
      $("#open-profile-folder").hidden = !folder.enabled;
      personalProfile = library.profiles.find(item => item.id === library.activeId)?.details || personalProfile;
      if (!personalDirty) {
        $("#saved-profile").replaceChildren(...library.profiles.map(item => element("option", {value: item.id}, item.name)));
        $("#saved-profile").value = library.activeId;
        $("#saved-profile").dataset.activeId = library.activeId;
        $("#profile-name").value = library.profiles.find(item => item.id === library.activeId)?.name || "";
        $("#personal-registrationPassword").type = "password";
        const reveal = document.querySelector(".password-reveal");
        reveal.textContent = "Show"; reveal.setAttribute("aria-pressed", "false"); reveal.setAttribute("aria-label", "Show account password");
      }
      if (!personalDirty) for (const field of PROFILE_FIELDS) $(`#personal-${field}`).value = personalProfile[field] || "";
      compactView = Boolean(preferences[UI_KEY]?.compact);
      if (!contactsLoaded) {
        $("#client-reply-to").value = preferences[CONTACT_KEY]?.email || "";
        $("#email-api-key").value = preferences[EMAIL_KEY]?.apiKey || "";
        $("#email-sender").value = preferences[EMAIL_KEY]?.sender || "onboarding@resend.dev";
        contactsLoaded = true;
      }
      if (!value.monitors.some((monitor) => monitor.id === selectedId)) selectedId = value.monitors[0]?.id || null;
      render();
      if (!workspaceVisited && value.searches?.length) switchTab("searches");
      updateProfilePresentation();
    } while (reloadState);
  } finally { loadingState = false; }
}
function badge(monitor) {
  if (busy(monitor)) return element("span", {class: "pill busy"}, monitor.phase === "capturing" ? "Capturing" : monitor.phase === "reading" ? "Reading" : monitor.phase === "queued" ? "Queued" : "Refreshing");
  if (monitor.error) return element("span", {class: "pill error"}, "Check failed");
  if (monitor.available === true) return element("span", {class: "pill available"}, "● Available");
  if (monitor.available === false) return element("span", {class: "pill"}, "Not available");
  return element("span", {class: "pill"}, "Not checked");
}
function updateFreshness() {
  for (const node of document.querySelectorAll("[data-freshness]")) {
    const monitor = value.monitors.find(item => item.id === node.dataset.freshness);
    if (!monitor) continue;
    const result = freshness(monitor);
    node.textContent = result.text;
    node.title = result.title;
    node.classList.toggle("stale", result.stale);
  }
}
function render() {
  document.body.classList.toggle("compact", compactView);
  $("#compact-view").checked = compactView;
  renderSearches();
  renderDebug();
  renderSettings();
  renderClientOverview();
  const totals = availabilityTotals(value.monitors);
  $("#apartment-count").textContent = `${totals.unknownCounts ? "≥" : ""}${totals.apartments}`;
  $("#apartment-count-note").hidden = !totals.unknownCounts;
  $("#apartment-count").title = totals.unknownCounts ? "At least one apartment per available floor plan; some sites do not publish exact unit counts. Totals use the last successful results." : "Published unit counts from the last successful results.";
  $("#stop-all").disabled = !value.monitors.some(monitor => monitor.enabled || busy(monitor) || monitor.application?.status === "running");
  $("#active-count").textContent = value.monitors.filter((monitor) => monitor.enabled).length;
  $("#available-count").textContent = totals.websites;
  $("#check-count").textContent = value.monitors.reduce((sum, monitor) => sum + monitor.checks, 0);
  $("#monitor-count").textContent = value.monitors.length;
  $("#monitors").replaceChildren(...value.monitors.map((monitor) => element("button", {
    class: `monitor-card${monitor.enabled ? " watching" : ""}${monitor.id === selectedId ? " selected" : ""}`,
    "aria-pressed": String(monitor.id === selectedId),
    onclick: () => { selectedId = monitor.id; showAllSamples = false; listingFilter = "all"; render(); },
  },
  element("span", {class: "monitor-title"}, monitor.name),
  element("span", {class: "monitor-bottom"}, element("span", {class: "pill"}, monitor.error ? "Check failed" : monitor.enabled ? "Watching" : "Paused"), `${monitor.samples.filter(sample => sample.matched).length} available`),
  element("span", {class: "freshness", "data-freshness": monitor.id}),
  monitor.error && element("span", {class: "monitor-error", title: siteError(monitor, monitor.error)}, siteError(monitor, monitor.error)),
  )));
  if (!value.monitors.length) $("#monitors").append(element("p", {class: "empty-note"}, "No supported websites are available."));
  renderDetail();
  updateFreshness();
}
function actionButton(label, type, monitor, className = "secondary-button") {
  const button = element("button", {class: className, "data-action": type, onclick: guard(async () => {
    button.disabled = true;
    try { const result = await request({type, id: monitor.id}); if (type === "test-alert" && result.errors?.length) toast(result.errors.join(" "), true); await loadState(); }
    finally { button.disabled = false; }
  })}, label);
  if (["check", "start"].includes(type) && busy(monitor)) button.disabled = true;
  return button;
}
function renderDetail() {
  const monitor = selected();
  const root = $("#detail");
  const diagnosticsOpen = root.querySelector('.application-diagnostics')?.open;
  const focusedAction = root.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  root.replaceChildren();
  if (!monitor) {
    root.append(element("div", {class: "empty-state"}, element("h2", {}, "Select a website")));
    return;
  }
  root.append(element("div", {class: "detail-head"},
    element("div", {class: "detail-title"}, element("h2", {}, monitor.name))));
  root.append(element("button", {class: "text-button detail-url", title: "Open monitored tab", onclick: guard(() => request({type: "open", id: monitor.id}))}, `${monitor.url} ↗`));
  const toolbar = element("div", {class: "control-row monitor-toolbar"}, actionButton(monitor.enabled ? "Ⅱ Pause monitoring" : "▶ Start watching", monitor.enabled ? "pause" : "start", monitor, "primary-button"), actionButton("↻ Check now", "check", monitor));
  const refresh = element("select", {id: "refresh-interval", "aria-label": "Refresh interval"});
  const presets = [[5, "5 seconds"], [30, "30 seconds"], [60, "1 minute"], [300, "5 minutes"], [600, "10 minutes"], [1800, "30 minutes"], [3600, "1 hour"]];
  if (!presets.some(([seconds]) => seconds === monitor.intervalSeconds)) presets.push([monitor.intervalSeconds, `${monitor.intervalSeconds} seconds`]);
  refresh.append(...presets.map(([seconds, label]) => element("option", {value: String(seconds)}, label)));
  refresh.value = String(monitor.intervalSeconds);
  refresh.addEventListener("change", guard(async () => {
    refresh.disabled = true;
    try {
      await request({type: "set-interval", id: monitor.id, intervalSeconds: Number(refresh.value)});
      await loadState();
    } finally { refresh.disabled = false; }
  }));
  toolbar.append(element("label", {class: "refresh-control"}, "Refresh every", refresh), element("button", {id: "configure-monitor", class: "small-button", onclick: () => openEditor(monitor)}, "Configure monitor"));
  root.append(toolbar);
  if (monitor.application?.message) {
    const app = monitor.application;

    const details = element("details", {class: "application-diagnostics", "data-application-build": APPLICATION_BUILD}, element("summary", {}, "Application diagnostics"));
    details.open = !!diagnosticsOpen;
    const report = applicationReport(app);
    details.append(element("p", {class: "helper application-result"}, app.message));
    if (app.moveInDate) details.append(element("p", {class: "helper move-in-feedback"}, `Move-in date: ${app.moveInDate}`));
    details.append(element("p", {class: "helper"}, `Dashboard build ${APPLICATION_BUILD} · Run build ${report.build} · ${report.status}${report.kind ? ` (${report.kind})` : ""}`));
    if (app.build !== APPLICATION_BUILD) details.append(element("p", {class: "form-error"}, "This run used an older build. Reload SpotAlert at chrome://extensions, reopen the dashboard, and try Apply again."));
    const list = element("ol", {class: "application-trace"});
    for (const item of report.trace) {
      const {at, event, ...metadata} = item;
      list.append(element("li", {}, `${clock(at)} · ${event.replaceAll("-", " ")}`, Object.keys(metadata).length ? element("code", {}, JSON.stringify(metadata)) : ""));
    }
    details.append(list, element("div", {class: "control-row"}, app.tabId ? element("button", {type: "button", class: "secondary-button", onclick: guard(() => request({type: "open-application-tab", id: monitor.id}))}, "Open application tab ↗") : "", element("button", {type: "button", class: "secondary-button", onclick: () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type: "application/json"}));
      element("a", {href: url, download: "spotalert-application-debug.json"}).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}, "Download debug report")));
    root.append(details);
  }

  const attention = monitor.error ? element("section", {class: "attention-card", "aria-label": "Monitoring status"}) : null;
  if (attention) {
    attention.append(element("h3", {class: "attention-title"}, "Needs attention"));
    if (monitor.error) {
      const titles = {verification: "Complete website verification", login: "Sign in to the website", loading: "Website did not finish loading", selector: "Update the availability rule", permission: "Allow website access", navigation: "Return to the monitored page"};
      const row = element("div", {class: "attention-monitor", role: "alert"}, element("h4", {}, titles[monitor.errorKind] || "Monitoring check failed"), element("p", {}, monitor.error));
      const actions = element("div", {class: "control-row"}, actionButton("Open affected tab ↗", "open-affected", monitor));
      if (["permission", "selector"].includes(monitor.errorKind)) actions.append(element("button", {class: "secondary-button", onclick: () => openEditor(monitor)}, monitor.errorKind === "permission" ? "Review website access" : "Edit rule"));
      row.append(actions);
      attention.append(row);
    }
    root.append(attention);
  }
  if (monitor.application) {
    const app = monitor.application;
    const card = root.querySelector('.application-diagnostics');
    const actions = element("div", {class: "control-row"});
    if (card && app.missingFields?.length) {
      const list = element("ul", {class: "application-missing"});
      for (const field of app.missingFields) list.append(element("li", {}, element("strong", {}, field.label), element("span", {}, field.reason === "invalid" ? "Needs correction" : "Required")));
      card.append(list, element("p", {class: "helper"}, "Update saved details below, or complete fields directly on the website. Continue directly on the website."));
      actions.append(element("button", {class: "secondary-button", onclick: () => {
        $("#personal-tab").click();
        document.querySelectorAll(".profile-group").forEach(group => { group.open = true; });
        $("#personal-view").scrollIntoView({behavior: "smooth"});
      }}, "Edit personal information"));
    }
    if (card && app.structure) {
      const details = element("details", {class: "application-structure"}, element("summary", {}, `Unfamiliar form · ${app.structure.fields.length} fields`));
      const list = element("ul", {});
      for (const field of app.structure.fields) list.append(element("li", {}, `${field.label} · ${field.type}${field.required ? " · required" : ""}`));
      details.append(element("p", {class: "helper"}, "Field labels and types only. Entered values and URL tracking parameters are excluded."), list);
      card.append(details);
      actions.append(element("button", {class: "secondary-button", onclick: () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(app.structure, null, 2)], {type: "application/json"}));
        element("a", {href: url, download: "spotalert-form-structure.json"}).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}, "Download form structure"));
    }
    if (card) card.append(actions);
  }
  const filterLabels = {studio: "Studios", "1-bedroom": "1 bedroom", "2-bedroom": "2 bedrooms", "3-plus": "3+ bedrooms"};
  const filterText = (monitor.filters?.types || []).map((type) => filterLabels[type]).join(", ");
  const floors = monitor.filters?.floorplans?.length || 0;
  root.append(element("p", {class: "watch-summary"}, filterText || "All apartment types", floors ? ` · ${floors} selected floor ${floors === 1 ? "plan" : "plans"}` : "",
    monitor.hours?.enabled ? ` · ${monitor.hours.start}–${monitor.hours.end} (${monitor.hours.timeZone})` : ""));
  let caption = "Monitoring paused";
  let symbol = "Ⅱ";
  let sub = "";
  if (busy(monitor)) { caption = monitor.phase === "capturing" ? "Capturing application page…" : monitor.phase === "reading" ? "Reading availability elements…" : monitor.phase === "queued" ? "Waiting for the previous check…" : "Refreshing browser tab…"; symbol = "↻"; sub = ""; }
  else if (monitor.error) { caption = {verification: "Verification required", login: "Sign in required", loading: "Page still loading", selector: "Rule needs updating", permission: "Website access required", navigation: "Tab navigated away"}[monitor.errorKind] || "The last check failed"; symbol = "!"; sub = monitor.enabled ? `Retry scheduled after ${monitor.consecutiveErrors || 1} failed ${monitor.consecutiveErrors === 1 ? "check" : "checks"}.` : "Fix the rule or page access, then try again."; }
  else if (monitor.phase === "waiting-hours" && monitor.enabled) { caption = "Waiting for monitoring hours"; symbol = "◷"; }
  else if (monitor.enabled) { caption = "Watching for availability"; symbol = "✓"; sub = ""; }
  if (!monitor.error || busy(monitor)) root.append(element("div", {class: "activity-line", role: "status"}, element("span", {class: `activity-symbol${busy(monitor) ? " spinning" : ""}`, "aria-hidden": "true"}, symbol), element("div", {}, element("div", {class: "activity-caption"}, caption), sub && element("div", {class: "activity-sub"}, sub))));
  root.append(element("div", {class: "telemetry"},
    element("div", {}, element("span", {}, "Last successful check"), element("strong", {}, clock(monitor.lastCheckedAt)), element("span", {class: "freshness", "data-freshness": monitor.id})),
    element("div", {}, element("span", {}, "Next refresh"), element("strong", {"data-next": monitor.id}, nextLabel(monitor))),
    element("div", {}, element("span", {}, "Check duration"), element("strong", {}, monitor.lastDurationMs === null ? "—" : `${(monitor.lastDurationMs / 1000).toFixed(1)}s`)),
  ));
  const technical = element("details", {class: "technical-details"}, element("summary", {}, "Technical details & activity"));
  technical.open = technicalOpen;
  technical.addEventListener("toggle", () => { technicalOpen = technical.open; });
  technical.append(element("section", {class: "detail-section"},
    element("div", {class: "section-heading"}, element("h3", {}, "Availability rule"), badge(monitor)),
    element("div", {class: "rule-block"}, element("div", {class: "rule-code"}, monitor.rule.type === "text" ? "document.body.innerText" : monitor.rule.selector), element("div", {class: "rule-meta"},
      "Available when text ", element("code", {}, {contains: "contains", equals: "equals", not_equals: "does not equal"}[monitor.rule.mode]), " ", element("code", {}, JSON.stringify(monitor.rule.expected)), element("br"),
      `Case insensitive · Every ${interval(monitor.intervalSeconds)}`)),
  ));
  const sampleSection = element("section", {class: "detail-section"});
  const sampleHeader = element("div", {class: "section-heading"}, element("h3", {}, `Floor plans ${monitor.samples.length ? `· ${monitor.samples.filter((sample) => sample.included !== false).length}/${monitor.samples.length}` : ""}`));
  const visibleSamples = [...monitor.samples].filter(sample => listingFilter === "all" || (listingFilter === "available" ? sample.matched : sample.apartmentType === listingFilter))
    .sort((a, b) => Number(Boolean(b.matched)) - Number(Boolean(a.matched)) || a.index - b.index);
  if (visibleSamples.length > 8) sampleHeader.append(element("button", {class: "text-button", onclick: () => { showAllSamples = !showAllSamples; renderDetail(); }}, showAllSamples ? "Show fewer" : `Show all ${visibleSamples.length}`));
  sampleSection.append(sampleHeader);
  const chips = element("div", {class: "listing-filters", role: "group", "aria-label": "Filter floor plans"});
  for (const [key, label] of [["all", "All"], ["available", "Available"], ["studio", "Studios"], ["1-bedroom", "1 bedroom"], ["2-bedroom", "2 bedrooms"], ["3-plus", "3+ bedrooms"]]) {
    chips.append(element("button", {class: "filter-chip", "data-action": `filter-${key}`, "aria-pressed": String(listingFilter === key), onclick: () => { listingFilter = key; showAllSamples = false; renderDetail(); }}, label));
  }
  sampleSection.append(chips);
  if (!monitor.samples.length) sampleSection.append(element("p", {class: "empty-note"}, "Check this website to load its floor plans."));
  else if (!visibleSamples.length) sampleSection.append(element("p", {class: "empty-note"}, "No floor plans match this view."));
  else sampleSection.append(element("div", {class: "sample-grid"}, ...visibleSamples.slice(0, showAllSamples ? 100 : 8).map((sample) => {
    const details = [["Rent", sample.rent], ["Bedrooms", {studio: "Studio", "1-bedroom": "1", "2-bedroom": "2", "3-plus": sample.beds || "3+"}[sample.apartmentType] || sample.beds], ["Size", sample.size], ["Bathrooms", sample.baths]].filter(([, value]) => value);
    return element("article", {class: `sample${sample.matched ? " matched" : ""}`},
      element("div", {class: "sample-top"}, element("h4", {class: "sample-name"}, sample.name || "Floor plan description unavailable"), element("span", {class: `pill${sample.matched ? " available" : ""}`}, sample.included === false ? "Filtered out" : sample.matched ? "Available" : "Not available")),
      element("p", {class: "sample-type"}, {studio: "Studio", "1-bedroom": "1 bedroom", "2-bedroom": "2 bedrooms", "3-plus": "3+ bedrooms"}[sample.apartmentType] || ""),
      details.length ? element("dl", {class: "listing-details"}, ...details.map(([label, value]) => element("div", {}, element("dt", {}, label), element("dd", {}, value)))) : element("p", {class: "sample-context"}, "Check again to load apartment details."),
      Boolean(sample.preferenceReasons?.length) && element("p", {class: "sample-context"}, sample.preferenceReasons.join(" · ")),
      sample.matched && listingButton(monitor, sample));
  })));
  root.append(sampleSection);
  const filter = element("select", {"aria-label": "Filter activity", style: "width:auto;margin:0;padding:4px 7px;font-size:10px"}, element("option", {value: "all"}, "All events"), element("option", {value: "changes"}, "Changes & errors"));
  filter.value = historyFilter;
  filter.addEventListener("change", () => { historyFilter = filter.value; renderDetail(); });
  const events = monitor.history.filter((event) => historyFilter === "all" || event.kind !== "check" || event.changed).slice(0, 20);
  const historySection = element("section", {class: "detail-section"}, element("div", {class: "section-heading"}, element("h3", {}, "Recent activity"), filter));
  if (!events.length) historySection.append(element("p", {class: "empty-note"}, "Checks, changes, and errors will appear here."));
  else historySection.append(element("ol", {class: "history-list"}, ...events.map((event) => element("li", {class: "history-item"},
    element("span", {class: `history-dot${event.available ? " positive" : ["error", "warning"].includes(event.kind) ? " error" : ""}`, "aria-hidden": "true"}),
    element("div", {class: "history-content"}, element("strong", {}, event.message), element("p", {}, event.kind === "check" ? `${event.matchedCount}/${event.totalCount} elements matched${event.changed ? " · Text changed" : ""}` : new Date(event.at).toLocaleDateString())),
    element("time", {datetime: new Date(event.at).toISOString()}, clock(event.at)),
  ))));
  technical.append(historySection);
  root.append(technical);

  updateFreshness();
  if (focusedAction) root.querySelector(`[data-action="${focusedAction}"]`)?.focus({preventScroll: true});
}
function nextLabel(monitor) {
  if (!monitor.enabled) return "Paused";
  if (busy(monitor)) return "In progress";
  if (!monitor.nextCheckAt) return "Scheduling…";
  const seconds = Math.max(0, Math.ceil((monitor.nextCheckAt - Date.now()) / 1000));
  if (!seconds) return "Due · Chrome may delay";
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}
function openEditor(monitor = null) {
  $("#editor-title").textContent = monitor?.id ? "Edit monitor" : "New monitor";
  $("#monitor-id").value = monitor?.id || "";
  $("#monitor-name").value = monitor?.name || "";
  $("#monitor-url").value = monitor?.url || "";
  $("#rule-type").value = monitor?.rule?.type || "css";
  $("#rule-selector").value = monitor?.rule?.selector || "";
  $("#rule-mode").value = monitor?.rule?.mode || "equals";
  $("#rule-expected").value = monitor?.rule?.expected || "Available";
  const seconds = monitor?.intervalSeconds || 300;
  if (![...$("#interval").options].some((option) => Number(option.value) === seconds)) $("#interval").append(element("option", {value: String(seconds)}, `${seconds} seconds`));
  $("#interval").value = String(seconds);
  document.querySelectorAll('[name="apartment-type"]').forEach((input) => { input.checked = monitor?.filters?.types?.includes(input.value) || false; });
  const known = monitor?.samples?.length ? monitor.samples : monitor?.knownFloorplans || [];
  const choices = new Map(known.map((sample) => [listingKey(sample), sample.name || `Floor plan ${sample.index}`]));
  (monitor?.filters?.floorplans || []).forEach((id) => { if (!choices.has(id)) choices.set(id, id); });
  $("#floorplan-filters").replaceChildren(...[...choices].map(([id, name]) => {
    const input = element("input", {type: "checkbox", name: "floorplan", value: id});
    input.checked = monitor?.filters?.floorplans?.includes(id) || false;
    return element("label", {class: "checkbox-label"}, input, name);
  }));
  if (!choices.size) $("#floorplan-filters").append(element("p", {class: "helper"}, "Run Check now to load floor-plan choices."));
  $("#hours-enabled").checked = Boolean(monitor?.hours?.enabled);
  $("#hours-start").value = monitor?.hours?.start || "08:00";
  $("#hours-end").value = monitor?.hours?.end || "22:00";
  $("#hours-timezone").value = monitor?.hours?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("#preview-result").hidden = true;
  $("#form-error").hidden = true;
  updateRuleType();
  $("#editor").showModal();
}
function config() {
  return {
    id: $("#monitor-id").value || undefined,
    ...validateMonitor({
      name: $("#monitor-name").value, url: $("#monitor-url").value,
      intervalSeconds: $("#interval").value, notify: false, sound: false,
      filters: {types: [...document.querySelectorAll('[name="apartment-type"]:checked')].map((input) => input.value), floorplans: [...document.querySelectorAll('[name="floorplan"]:checked')].map((input) => input.value)},
      hours: {enabled: $("#hours-enabled").checked, start: $("#hours-start").value, end: $("#hours-end").value, timeZone: $("#hours-timezone").value},
      rule: {type: $("#rule-type").value, selector: $("#rule-selector").value, mode: $("#rule-mode").value, expected: $("#rule-expected").value},
    }),
  };
}
function updateRuleType() { $("#selector-label").hidden = $("#rule-type").value === "text"; }
function formError(error) { $("#form-error").textContent = siteError({name: $("#monitor-name").value, url: $("#monitor-url").value}, error); $("#form-error").hidden = false; }

$("#close-editor").addEventListener("click", () => $("#editor").close());
$("#rule-type").addEventListener("change", updateRuleType);
$("#monitor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const input = config();
    await grant(input.url);
    const result = await request({type: "save", monitor: input});
    selectedId = result.id;
    $("#editor").close();
    await loadState();
    toast("Monitor saved. Start watching when you're ready.");
  } catch (error) { formError(error); }
});
$("#preview-rule").addEventListener("click", async () => {
  const button = $("#preview-rule");
  try {
    const input = config();
    const permission = grant(input.url);
    button.disabled = true;
    button.textContent = "Reading page…";
    await permission;
    const preview = await request({type: "preview", monitor: input});
    const root = $("#preview-result");
    root.replaceChildren(element("strong", {}, `${preview.available ? "Available" : "Not available"} · ${preview.matches.filter((sample) => sample.matched).length}/${preview.matches.length} elements matched`), element("pre", {}, preview.matches.slice(0, 5).map((sample) => `${sample.matched ? "✓" : "·"} ${sample.text.slice(0, 300)}`).join("\n")));
    root.hidden = false;
    $("#form-error").hidden = true;
  } catch (error) { formError(error); }
  finally { button.disabled = false; button.textContent = "Preview rule"; }
});
$("#expand").addEventListener("click", () => chrome.tabs.create({url: chrome.runtime.getURL("panel.html")}));
$("#export").addEventListener("click", () => {
  const rules = {version: 3, monitors: value.monitors.map(({name, url, rule, intervalSeconds, notify, sound, filters, hours}) => ({name, url, rule, intervalSeconds, notify, sound, filters, hours}))};
  const blob = new Blob([JSON.stringify(rules, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const link = element("a", {href: url, download: "spotalert-rules.json"});
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$(".brand").addEventListener("click", (event) => { event.preventDefault(); window.scrollTo({top: 0, behavior: "smooth"}); });
function listingButton(monitor, sample) {
  const button = element("button", {class: "text-button listing-link", onclick: guard(async () => {
    showApplyConfirmation(monitor, sample);
  })}, "Apply ↗");
  button.disabled = monitor.application?.status === "running";
  if (button.disabled) button.textContent = "Applying…";
  return button;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[PROFILE_KEY] || changes[PROFILES_KEY] || changes[UI_KEY])) loadState().catch(error => toast(error.message, true));
  if (area === "local" && changes[STORAGE_KEY]) {
    loadState().catch((error) => toast(error.message, true));
  }
});
setInterval(() => {
  const monitor = selected();
  const node = document.querySelector("[data-next]");
  if (monitor && node) node.textContent = nextLabel(monitor);
  updateFreshness();
}, 1000);
const orderedSections = [...PROFILE_SECTIONS].sort((a, b) => {
  const order = ["Identity & contact", "Moving preferences", "Account password"];
  return (order.indexOf(a.title) < 0 ? 99 : order.indexOf(a.title)) - (order.indexOf(b.title) < 0 ? 99 : order.indexOf(b.title));
});
for (const [sectionIndex, section] of orderedSections.entries()) {
  const details = element("details", {class: "profile-group"});
  details.open = section.title === "Identity & contact";
  details.dataset.fields = section.fields.map(([key]) => key).join(",");
  details.append(element("summary", {}, element("span", {class: "profile-section-number"}, String(sectionIndex + 1).padStart(2, "0")), element("span", {class: "profile-section-title"}, section.title), element("span", {class: "profile-section-count"})));
  if (section.helper) details.append(element("p", {class: "helper"}, section.helper));
  const grid = element("div", {class: "profile-fields"});
  for (const [key, label, type] of section.fields) {
    const wrapper = element("label", {}, label);
    const input = Array.isArray(type) ? element("select", {id: `personal-${key}`}) : element("input", {id: `personal-${key}`, type: type || "text", maxlength: "200"});
    if (Array.isArray(type)) for (const choice of ["", ...type]) input.append(element("option", {value: choice}, choice || "Choose…"));
    if (type === "number") { input.min = "0"; input.step = "0.01"; }
    if (type === "password") {
      const reveal = element("button", {type: "button", class: "password-reveal", "aria-label": "Show account password", "aria-pressed": "false", onclick: () => {
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        reveal.textContent = show ? "Hide" : "Show";
        reveal.setAttribute("aria-label", show ? "Hide account password" : "Show account password");
        reveal.setAttribute("aria-pressed", String(show));
      }}, "Show");
      wrapper.append(element("div", {class: "profile-password"}, input, reveal));
    } else wrapper.append(input);
    grid.append(wrapper);
  }
  details.append(grid);
  $("#profile-sections").append(details);
}
loadState().catch((error) => toast(error.message, true));

function updateProfilePresentation() {
  const name = $("#profile-name").value.trim();
  $("#profile-avatar").textContent = name.split(/\s+/).map(word => word[0]).slice(0, 2).join("").toUpperCase() || "＋";
  for (const group of document.querySelectorAll(".profile-group")) {
    const keys = group.dataset.fields.split(",");
    const count = keys.filter(key => $(`#personal-${key}`).value.trim()).length;
    group.querySelector(".profile-section-count").textContent = `${count}/${keys.length}`;
  }
  $("#profile-save-status").textContent = personalDirty ? "Unsaved changes" : "All changes saved";
  $("#profile-save-status").classList.toggle("unsaved", personalDirty);
}
$("#saved-profile").addEventListener("change", guard(async () => {
  if (personalDirty) {
    $("#saved-profile").value = $("#saved-profile").dataset.activeId;
    toast("Save your changes before loading another profile.", true);
    return;
  }
  await request({type: "select-profile", id: $("#saved-profile").value});
  await loadState();
  toast("Profile loaded. Apply will use these details.");
}));
$("#new-profile").addEventListener("click", guard(async () => {
  if (personalDirty) { toast("Save your changes before creating a profile.", true); return; }
  await request({type: "create-profile"});
  await loadState();
  $("#profile-name").focus(); $("#profile-name").select();
}));
$("#personal-form").addEventListener("input", event => { if (!["saved-profile", "signature-consent"].includes(event.target.id)) personalDirty = true; updateProfilePresentation(); });
$("#generate-registration-details").addEventListener("click", () => {
  const details = temporaryRegistrationDetails();
  for (const [key, value] of Object.entries(details)) {
    const input = $(`#personal-${key}`);
    input.value = value;
    input.closest("details").open = true;
  }
  personalDirty = true;
  updateProfilePresentation();
  toast("Temporary details generated. Save personal information to use them.");
});
$("#personal-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const profile = Object.fromEntries(PROFILE_FIELDS.map(field => [field, $(`#personal-${field}`).value]));
    await request({type: "save-profile", profile, name: $("#profile-name").value});
    personalDirty = false;
    $("#personal-error").hidden = true;
    await loadState();
    toast("Personal information saved.");
  } catch (error) {
    $("#personal-error").textContent = error.message;
    $("#personal-error").hidden = false;
  }
});
$("#clear-personal").addEventListener("click", guard(async () => {
  await request({type: "clear-profile"});
  personalDirty = false;
  await loadState();
  $("#personal-error").hidden = true;
  toast("Profile deleted.");
}));
$("#open-extension-settings").addEventListener("click", guard(() => chrome.tabs.create({url: "chrome://extensions"})));
$("#reload-dashboard").addEventListener("click", () => location.reload());
async function checkExtensionVersion() {
  try {
    const info = await request({type: "engine-info"});
    $("#extension-version").textContent = `SpotAlert ${info.version} · Application build ${APPLICATION_BUILD}`;
    const source = await (await fetch(chrome.runtime.getURL('application-diagnostics.js'), {cache: 'no-store'})).text();
    const diskBuild = source.match(/APPLICATION_BUILD\s*=\s*['"]([^'"]+)/)?.[1];
    $("#extension-update").hidden = info.build === APPLICATION_BUILD && (!diskBuild || diskBuild === info.build);
  } catch {
    $("#extension-update").hidden = false;
  }
}
checkExtensionVersion();
setInterval(checkExtensionVersion, 15000);

$("#stop-all").addEventListener("click", guard(async () => {
  $("#stop-all").disabled = true;
  try {
    await request({type: "stop-all"});
    await loadState();
    toast("All monitoring stopped.");
  } finally { $("#stop-all").disabled = !value.monitors.some(monitor => monitor.enabled || busy(monitor)); }
}));

$("#compact-view").addEventListener("change", guard(async () => {
  compactView = $("#compact-view").checked;
  document.body.classList.toggle("compact", compactView);
  await chrome.storage.local.set({[UI_KEY]: {compact: compactView}});
}));

function renderDebug() {
  const debug = value.debug || {enabled: false, captures: []};
  const captures = debug.captures || [];
  $("#debug-mode").checked = Boolean(debug.enabled);
  $("#debug-count").textContent = captures.length;
  $("#debug-status").textContent = debug.enabled ? "On · watches direct links in your matching listings. Latest 20 captures are kept." : "Debug capture is off.";
  $("#export-debug").disabled = !captures.length;
  $("#clear-debug").disabled = !captures.length;
  const opened = new Set([...$("#debug-captures").querySelectorAll("details[open]")].map(node => node.dataset.captureId));
  $("#debug-captures").replaceChildren(...captures.slice(0, 5).map(capture => {
    const card = element("details", {class: "debug-capture", "data-capture-id": capture.id},
    element("summary", {}, capture.listingName, element("span", {class: "muted"}, ` · ${capture.status === "opening" ? "Opening…" : capture.status === "error" ? "Failed" : capture.snapshot?.pageKind || "Captured"}`)),
    element("p", {class: "helper"}, `${capture.site} · ${clock(capture.at)}`),
    capture.error && element("p", {class: "form-error"}, capture.error),
    capture.tabId && element("button", {class: "text-button", onclick: guard(() => request({type: "open-debug", captureId: capture.id}))}, "Open captured tab ↗"),
    capture.snapshot && element("pre", {class: "debug-output"}, JSON.stringify(capture.snapshot, null, 2)),
    );
    card.open = opened.has(capture.id);
    return card;
  }));
}
$("#debug-mode").addEventListener("change", guard(async () => {
  const button = $("#debug-mode");
  button.disabled = true;
  try { await request({type: "set-debug", enabled: button.checked}); await loadState(); }
  finally { button.disabled = false; }
}));
$("#clear-debug").addEventListener("click", guard(async () => {
  await request({type: "clear-debug"}); await loadState();
}));
$("#export-debug").addEventListener("click", () => {
  const captures = (value.debug?.captures || []).map(({tabId, ...capture}) => capture);
  const blob = new Blob([JSON.stringify({version: 1, captures}, null, 2)], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  element("a", {href: url, download: "spotalert-debug-captures.json"}).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const workspaceTabs = ["searches", "monitoring", "settings", "personal", "clients"];
function switchTab(name) {
  workspaceVisited = true;
  for (const tab of workspaceTabs) {
    const active = tab === name;
    $(`#${tab}-tab`).setAttribute("aria-selected", String(active));
    $(`#${tab}-tab`).tabIndex = active ? 0 : -1;
    $(`#${tab}-view`).hidden = !active;
  }
}
for (const name of workspaceTabs) {
  $(`#${name}-tab`).addEventListener("click", () => switchTab(name));
  $(`#${name}-tab`).addEventListener("keydown", event => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? workspaceTabs[0] : event.key === "End" ? workspaceTabs.at(-1) : workspaceTabs[(workspaceTabs.indexOf(name) + (event.key === "ArrowRight" ? 1 : workspaceTabs.length - 1)) % workspaceTabs.length];
      switchTab(next);
      $(`#${next}-tab`).focus();
    }
  });
}
function renderSettings() {
  const picker = $('#email-test-profile');
  const previous = picker.value;
  const profiles = applicantLibrary.profiles;
  const options = profiles.map(profile => [profile.id, `${profile.name} · ${profile.details.email || 'No email saved'}`]);
  if (JSON.stringify([...picker.options].map(option => [option.value, option.textContent])) !== JSON.stringify([['', 'Select a profile'], ...options])) {
    picker.replaceChildren(element('option', {value: ''}, 'Select a profile'), ...options.map(([id, name]) => element('option', {value: id}, name)));
    picker.value = profiles.some(profile => profile.id === previous) ? previous : '';
  }
}
async function saveEmailSettings() {
  const sender = $('#email-sender').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) throw new Error('Enter a valid sender email.');
  await chrome.storage.local.set({[EMAIL_KEY]: {apiKey: $('#email-api-key').value.trim(), sender}});
  $('#email-save-status').textContent = 'Settings saved';
}
$('#email-delivery-form').addEventListener('submit', guard(async event => {
  event.preventDefault();
  await saveEmailSettings();
  toast('Email delivery settings saved.');
}));
$('#test-email').addEventListener('click', guard(async () => {
  const button = $('#test-email');
  button.disabled = true;
  try {
    if (!$('#email-test-profile').value) throw new Error('Select a recipient profile for the test.');
    await saveEmailSettings();
    await request({type: 'test-email', profileId: $('#email-test-profile').value});
    toast('Test email accepted by the provider.');
  } finally { button.disabled = false; }
}));
for (const id of ['email-api-key', 'email-sender']) $(`#${id}`).addEventListener('input', () => { $('#email-save-status').textContent = 'Unsaved changes'; });

function updateQuestionnaire() { $("#client-questionnaire").textContent = clientQuestionnaire($("#client-name").value); }
$("#client-name").addEventListener("input", updateQuestionnaire);
updateQuestionnaire();
$("#copy-client-questionnaire").addEventListener("click", guard(async () => {
  await navigator.clipboard.writeText(clientQuestionnaire($("#client-name").value)); toast("Questionnaire copied.");
}));
$("#send-client-questionnaire").addEventListener("click", guard(async () => {
  const button = $("#send-client-questionnaire"); button.disabled = true;
  try {
    await request({type: "send-client-questionnaire", name: $("#client-name").value, to: $("#client-email").value, replyTo: $("#client-reply-to").value});
    $("#client-send-status").textContent = "Email sent. Paste their reply here when it arrives.";
  } finally { button.disabled = false; }
}));
let reviewedClientReply = null;
$("#client-reply").addEventListener("input", () => { reviewedClientReply = null; $("#import-client-profile").hidden = true; $("#client-import-preview").hidden = true; });
$("#review-client-reply").addEventListener("click", guard(() => {
  reviewedClientReply = null; $("#import-client-profile").hidden = true;
  const profile = parseClientReply($("#client-reply").value);
  const preview = $("#client-import-preview");
  const list = element("dl", {class: "client-answer-list"});
  for (const [key, label] of CLIENT_FIELDS) if (profile[key]) list.append(element("dt", {}, label), element("dd", {}, key === "registrationPassword" ? "Password provided · hidden" : profile[key]));
  preview.replaceChildren(element("h4", {}, "Review extracted answers"), list); preview.hidden = false;
  reviewedClientReply = $("#client-reply").value; $("#import-client-profile").hidden = false;
}));
$("#import-client-profile").addEventListener("click", guard(async () => {
  if (personalDirty) throw new Error("Save your edits in Personal information before importing a profile.");
  if (!reviewedClientReply || reviewedClientReply !== $("#client-reply").value) throw new Error("Review the answers first.");
  const button = $("#import-client-profile"); button.disabled = true;
  try {
    await request({type: "import-client-profile", name: $("#client-profile-name").value, reply: reviewedClientReply});
    reviewedClientReply = null; button.hidden = true;
    $("#client-import-status").textContent = "Profile created and selected.";
    await loadState(); switchTab("personal"); toast("Client profile created. Review the details before applying.");
  } finally { button.disabled = false; }
}));

$("#enable-profile-folder").addEventListener("click", guard(async () => {
  if (personalDirty) throw new Error("Save your profile changes first.");
  await request({type: "enable-profile-folder"}); await loadState(); toast("Profiles saved to the local SpotAlert folder.");
}));
$("#open-profile-folder").addEventListener("click", guard(() => request({type: "open-profile-folder"})));

let applicationChoice = null;
function showApplyConfirmation(monitor, sample) {
  applicationChoice = {monitor, sample};
  $("#signature-consent").checked = false;
  $("#apply-agreements").hidden = !siteForUrl(monitor.url)?.application.agreementSignature;
  pendingApplication = null;
  const picker = $("#apply-profile");
  picker.replaceChildren(element("option", {value: ""}, "Choose a profile…"), ...applicantLibrary.profiles.map(entry => element("option", {value: entry.id}, entry.name)));
  picker.value = "";
  updateApplyConfirmation();
  $("#apply-confirmation").showModal();
}
function updateApplyConfirmation() {
  const list = $("#apply-confirmation-details"); list.replaceChildren();
  const applicant = applicantLibrary.profiles.find(item => item.id === $("#apply-profile").value);
  pendingApplication = null;
  $("#confirm-apply").disabled = true;
  if (!applicationChoice) return;
  const {monitor, sample} = applicationChoice;
  for (const [label, detail] of [["Location", monitor.name], ["Apartment", sample.name || sample.context || "Selected apartment"], ["Rent", sample.rent || "Not published"]]) list.append(element("dt", {}, label), element("dd", {}, detail));
  if (!applicant) {
    $("#apply-confirmation-note").textContent = "Choose the profile to use for this application.";
    return;
  }
  if (personalDirty && applicant.id === applicantLibrary.activeId) {
    $("#apply-confirmation-note").textContent = "Save this profile’s changes in Personal information before applying.";
    return;
  }
  const preferred = applicant.details.moveInFrom;
  let dateLabel = "First allowed weekday";
  if (preferred) {
    const date = new Date(`${preferred}T12:00:00`);
    while ([0, 6].includes(date.getDay())) date.setDate(date.getDate() + 1);
    dateLabel = `On or after ${date.getFullYear()}-${String(date.getMonth()+1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  for (const [label, detail] of [["Applicant", applicant.name], ["Name", [applicant.details.firstName, applicant.details.lastName].filter(Boolean).join(" ") || "Not provided"], ["Email", applicant.details.email || "Not provided"], ["Move-in", dateLabel]]) list.append(element("dt", {}, label), element("dd", {}, detail));
  pendingApplication = {id: monitor.id, listingId: listingKey(sample), profileId: applicant.id};
  $("#confirm-apply").disabled = false;
  $("#apply-confirmation-note").textContent = "This profile is used for this application only. The move-in date is checked against the website calendar. Review agreements and final submission on the website.";
}
$("#apply-profile").addEventListener("change", updateApplyConfirmation);
$("#cancel-apply").addEventListener("click", () => $("#apply-confirmation").close());
$("#confirm-apply").addEventListener("click", guard(async () => {
  updateApplyConfirmation();
  if (!pendingApplication) return;
  const signatureConsent = $("#signature-consent").checked;
  const command = {...pendingApplication, createAccount: $("#apply-create-account").checked, signatureConsent, screening: signatureConsent};
  if (signatureConsent) {
    $("#signature-consent").checked = false;
  }
  pendingApplication = null; $("#apply-confirmation").close();
  const result = await request({type: "open-listing", ...command});
  if (result.moveInMessage) toast(result.moveInMessage);
}));
function renderClientOverview() {
  const list = $("#client-overview-list"); list.replaceChildren();
  for (const entry of applicantLibrary.profiles.filter(profile => profile.id === applicantLibrary.activeId)) {
    const readiness = profileCompleteness(entry.details);
    const hasDetails = Object.values(entry.details).some(Boolean);
    const status = readiness.ready ? "Ready to apply" : hasDetails ? "Missing details" : "Awaiting information";
    const card = element("div", {class: "client-overview-row"}, element("div", {}, element("strong", {}, entry.name)), element("span", {id: "application-readiness", class: `pill${readiness.ready ? " available" : ""}`, role: "status"}, status));
    const details = element("details", {}, element("summary", {}, `${readiness.complete}/${readiness.total} required details`), element("p", {class: "helper"}, readiness.ready ? "Website requirements may vary." : `Still needed: ${readiness.missing.join(", ")}`));
    card.append(details, element("button", {type: "button", class: "secondary-button", onclick: () => {
      const group = document.querySelector(".profile-group");
      if (group) { group.open = true; group.scrollIntoView({behavior: "smooth", block: "start"}); }
    }}, "Edit profile"));
    list.append(card);
  }
}
function renderSearches() {
  const root = $("#search-list");
  const searches = value.searches || [];
  const matchEntries = search => Object.entries(search.results || {}).flatMap(([id, result]) => result.matches.filter(item => item.matched).map(listing => ({id, listing})));
  const needsAttention = search => search.error || search.activity?.some(item => ['review', 'failed', 'interrupted'].includes(item.status)) || search.enabled && search.locationIds.some(id => value.monitors.find(monitor => monitor.id === id)?.error);
  $('#search-active-total').textContent = searches.filter(search => search.enabled).length;
  $('#search-match-total').textContent = searches.reduce((total, search) => total + matchEntries(search).length, 0);
  $('#search-review-total').textContent = searches.filter(needsAttention).length;
  $('#search-total').textContent = searches.length;
  const filter = $('#search-profile-filter');
  const selectedProfile = filter.value;
  const profiles = applicantLibrary?.profiles || [];
  if (JSON.stringify([...filter.options].map(option => [option.value, option.textContent])) !== JSON.stringify([['', 'All profiles'], ...profiles.map(profile => [profile.id, profile.name])])) {
    filter.replaceChildren(element('option', {value: ''}, 'All profiles'), ...profiles.map(profile => element('option', {value: profile.id}, profile.name)));
    filter.value = profiles.some(profile => profile.id === selectedProfile) ? selectedProfile : '';
  }
  filter.disabled = !searches.length;
  const expanded = new Map([...root.querySelectorAll('.search-card')].map(card => [card.dataset.searchId, Object.fromEntries([...card.querySelectorAll('details[data-disclosure]')].map(item => [item.dataset.disclosure, item.open]))]));
  const focusedCard = document.activeElement?.closest('.search-card')?.dataset.searchId;
  const focusedLabel = root.contains(document.activeElement) ? document.activeElement.textContent : null;
  root.replaceChildren();
  for (const search of searches.filter(search => !filter.value || search.profileId === filter.value)) {
    const profile = profiles.find(item => item.id === search.profileId);
    const criteria = profile?.details || {};
    const matches = matchEntries(search);
    const errors = search.locationIds.map(id => value.monitors.find(item => item.id === id)).filter(monitor => monitor?.error);
    const button = (label, task, className = 'secondary-button') => element('button', {class: className, onclick: guard(async event => {
      event.currentTarget.disabled = true;
      try { await task(); } finally { await loadState(); }
    })}, label);
    const initials = (profile?.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    const card = element('article', {class: `search-card${search.enabled ? ' is-active' : ''}`, 'data-search-id': search.id, 'aria-labelledby': `search-title-${search.id}`},
      element('div', {class: 'search-card-heading'}, element('div', {class: 'search-identity'}, element('span', {class: 'search-avatar', 'aria-hidden': 'true'}, initials), element('div', {}, element('p', {class: 'search-owner'}, profile?.name || 'Deleted profile'), element('h3', {id: `search-title-${search.id}`}, search.name))), element('span', {class: `search-status${search.enabled ? ' active' : ''}${search.enabled && errors.length ? ' attention' : ''}`}, element('span', {'aria-hidden': 'true'}), search.enabled ? errors.length ? 'Check needed' : 'Searching' : 'Paused')),
      element('div', {class: 'search-location-tags'}, ...search.locationIds.map(id => element('span', {}, value.monitors.find(item => item.id === id)?.name || id))),
      element('dl', {class: 'search-criteria'}, ...[
        ['Monthly budget', criteria.maxRent ? `Up to €${criteria.maxRent}` : 'Any budget'],
        ['Minimum size', criteria.minSize ? `${criteria.minSize} m²` : 'Any size'],
        ['Apartment', ({studio: 'Studio', '1-bedroom': '1 bedroom', '2-bedroom': '2 bedrooms', '3-plus': '3+ bedrooms'})[criteria.preferredApartmentType] || 'Any type'],
        ['Move in', criteria.moveInFrom || 'First available date'],
      ].map(([label, text]) => element('div', {}, element('dt', {}, label), element('dd', {}, text)))),
      element('div', {class: 'search-channel-summary'}, element('span', {class: 'search-channel-label'}, 'On a match'), search.actions.autoApply && element('span', {class: 'search-channel'}, 'Auto-apply'), search.actions.email && element('span', {class: 'search-channel', title: profile?.details.email || 'Missing email'}, 'Email profile holder')));
    if (search.actions.email) card.append(element('p', {class: 'search-recipient-caption'}, `Email: ${profile?.details.email || 'Missing email'}`));
    const overview = element('div', {class: `search-match-summary${matches.length ? ' has-matches' : ''}`}, element('strong', {}, Object.keys(search.results || {}).length ? `${matches.length} matching ${matches.length === 1 ? 'floor plan' : 'floor plans'}` : 'Ready for the first check'), element('span', {}, search.error || (errors.length && search.enabled ? 'A location needs attention. See location status below.' : matches.length ? 'From the latest successful location checks.' : search.enabled ? 'Actions run when an apartment matches.' : 'Start this search to check for matching apartments.')));
    card.append(overview);
    if (matches.length) card.append(element('div', {class: 'search-match-previews'}, ...matches.slice(0, 2).map(({id, listing}) => {
      const monitor = value.monitors.find(item => item.id === id);
      const url = safeListingUrl(listing.applicationUrl || listing.pageUrl, monitor.url) || monitor.url;
      return element('a', {class: 'search-listing-link', href: url, target: '_blank', rel: 'noopener noreferrer'}, element('span', {}, element('strong', {}, listing.name || listing.context || 'Apartment'), element('small', {}, [listing.rent, listing.size].filter(Boolean).join(' · ')), listingClaimBadges(search, id, listing)), element('span', {'aria-hidden': 'true'}, '↗'));
    })));
    if (search.error) card.append(element('p', {class: 'form-error'}, search.error));
    const results = element('details', {class: 'search-results'}, element('summary', {}, matches.length ? `View ${matches.length} ${matches.length === 1 ? 'match' : 'matches'} & location status` : 'Location status'));
    for (const id of search.locationIds) {
      const monitor = value.monitors.find(item => item.id === id);
      const result = search.results?.[id];
      const listings = result?.matches.filter(item => item.matched) || [];
      results.append(element('div', {class: 'search-location-status'}, element('strong', {}, monitor?.name || id), element('p', {class: 'helper'}, monitor?.error || (result ? `${listings.length} matches · Checked ${new Date(result.at).toLocaleString()}` : 'Waiting for the first successful check'))));
      for (const listing of listings) {
        const url = safeListingUrl(listing.applicationUrl || listing.pageUrl, monitor.url) || monitor.url;
        results.append(element('a', {class: 'search-listing-link', href: url, target: '_blank', rel: 'noopener noreferrer'}, element('span', {}, element('strong', {}, listing.name || listing.context || 'Apartment'), element('small', {}, [listing.rent, listing.size].filter(Boolean).join(' · ')), listingClaimBadges(search, id, listing)), element('span', {'aria-hidden': 'true'}, '↗')));
      }
    }
    const excluded = element('details', {class: 'search-exclusions'}, element('summary', {}, `Excluded & unavailable (${Object.values(search.results || {}).reduce((total, result) => total + result.matches.filter(item => !item.matched).length, 0)})`));
    for (const [monitorId, result] of Object.entries(search.results || {})) for (const listing of result.matches.filter(item => !item.matched)) {
      excluded.append(element('div', {class: 'search-excluded-item'}, element('strong', {}, listing.name || listing.context || 'Apartment'), element('small', {}, value.monitors.find(item => item.id === monitorId)?.name || monitorId), element('ul', {}, ...exclusionReasons(listing).map(reason => element('li', {}, reason)))));
    }
    if (!excluded.querySelector('.search-excluded-item')) excluded.append(element('p', {class: 'helper'}, 'After a successful check, apartments that do not match will appear here with the reason.'));
    const records = searchClaimRecords(search);
    const duplicates = element('details', {class: 'search-duplicates'}, element('summary', {}, `Previous actions & duplicate protection (${records.length})`));
    duplicates.append(element('p', {class: 'helper'}, 'These records belong to this profile across all its searches, including deleted searches. Another attempt requires explicit authorization.'));
    for (const record of records) {
      const location = value.monitors.find(item => item.id === record.monitorId);
      const latest = search.results?.[record.monitorId];
      const matched = latest?.matches.some(listing => listing.matched && listingKey(listing) === record.listingId);
      const busy = ['queued', 'running'].includes(record.status);
      const fresh = latest && !location?.error && Date.now() - latest.at <= Math.max(60000, (location?.intervalSeconds || 300) * 3000);
      const row = element('div', {class: 'search-prior-action'}, element('strong', {}, record.listingName || record.listingId), element('p', {}, `${record.channel === 'email' ? 'Email' : 'Auto-apply'} · ${actionOutcome(record)} · ${record.at ? new Date(record.at).toLocaleString() : 'Date unavailable (older record)'}`), element('p', {class: 'helper'}, record.message || 'Previous attempt recorded.'));
      const retry = button(record.channel === 'email' ? 'Authorize another email' : 'Authorize another application', () => showRepeatSearch(search, record));
      retry.disabled = !search.enabled || !search.actions[record.channel] || !matched || !fresh || busy;
      const reason = busy ? 'This action is already queued or running.' : !search.enabled ? 'Start this search before authorizing another attempt.' : !search.actions[record.channel] ? 'Enable this action when starting the search.' : !matched ? 'The apartment must match the search again.' : !fresh ? 'Run a fresh successful location check first.' : '';
      if (reason) row.append(element('p', {class: 'helper'}, reason));
      row.append(retry);
      if (record.previousAttempts?.length) row.append(element('details', {class: 'search-earlier-attempts'}, element('summary', {}, `Earlier attempts (${record.previousAttempts.length})`), ...record.previousAttempts.map(attempt => element('p', {class: 'helper'}, `${attempt.at ? new Date(attempt.at).toLocaleString() : 'Older record'} · ${actionOutcome(attempt)} · ${attempt.message}`))));
      duplicates.append(row);
    }
    if (!records.length) duplicates.append(element('p', {class: 'helper'}, 'No previous actions recorded for this profile at these locations.'));
    const activity = element('details', {class: 'search-activity'}, element('summary', {}, `Action history (${search.activity?.length || 0})`));
    if (!search.activity?.length) activity.append(element('p', {class: 'helper'}, 'Emails and application results will appear here after a match.'));
    for (const item of search.activity || []) {
      const status = ({review: 'Needs review', failed: 'Failed', interrupted: 'Interrupted', sent: 'Email sent', running: 'In progress', queued: 'Queued', cancelled: 'Cancelled'})[item.status] || item.status;
      const row = element('div', {class: 'delivery-row'}, element('div', {}, element('strong', {}, `${item.channel === 'email' ? 'Email' : 'Auto-apply'} · ${item.listingName}`), element('p', {class: 'helper'}, `${new Date(item.at).toLocaleString()} · ${status}`), element('p', {}, item.message)));
      if (item.tabId) row.append(button('Open application', () => request({type: 'open-application-target', tabId: item.tabId})));
      activity.append(row);
    }
    const actions = element('div', {class: 'search-card-actions'}, button(search.enabled ? 'Pause search' : 'Start search', () => search.enabled ? request({type: 'set-search-enabled', id: search.id, enabled: false}) : showStartSearch(search), search.enabled ? 'secondary-button' : 'primary-button'), button('Edit search', () => showSearchEditor(search)));
    const more = element('details', {class: 'search-more'}, element('summary', {'aria-label': `More actions for ${search.name}`}, '•••'), button('Delete search', () => request({type: 'delete-search', id: search.id}), 'search-delete'));
    actions.append(more);
    card.append(results, excluded, duplicates, activity, actions);
    [results, excluded, duplicates, activity, more].forEach(details => { details.dataset.disclosure = details.className; details.open = expanded.get(search.id)?.[details.className] || false; });
    root.append(card);
    if (focusedCard === search.id && focusedLabel) [...card.querySelectorAll('button, summary')].find(item => item.textContent === focusedLabel)?.focus({preventScroll: true});
  }
  if (!root.childNodes.length) {
    const empty = element('div', {class: 'search-empty'}, element('span', {class: 'search-empty-icon', 'aria-hidden': 'true'}, '⌕'), element('h3', {}, searches.length ? 'No searches for this profile' : 'No saved searches'), element('p', {}, 'Create a search with a profile, locations, criteria and actions.'), element('button', {class: 'primary-button', onclick: () => showSearchEditor()}, 'Create a search'));
    root.append(empty);
  }
}
$('#search-profile-filter').addEventListener('change', renderSearches);
function searchProfilePreferences() {
  const profile = applicantLibrary.profiles.find(item => item.id === $('#search-profile').value);
  $('#search-recipient').textContent = profile?.details.email ? `Emails go to ${profile.details.email}.` : 'Save an email address in this profile to receive matches.';
  return profile?.details || {};
}
function showProfileSearchCriteria(details) {
  $('#search-profile-preferences').replaceChildren(...[
    ['Monthly budget', details.maxRent ? `Up to €${details.maxRent}` : 'Any budget'],
    ['Minimum size', details.minSize ? `${details.minSize} m²` : 'Any size'],
    ['Apartment', ({studio:'Studio', '1-bedroom':'1 bedroom', '2-bedroom':'2 bedrooms', '3-plus':'3+ bedrooms'})[details.preferredApartmentType] || 'Any type'],
    ['Earliest move-in', details.moveInFrom || 'First available date'],
  ].map(([label, text]) => element('div', {}, element('dt', {}, label), element('dd', {}, text))));
}
function showSearchEditor(search = null) {
  $('#search-form').reset();
  $('#search-editor-title').textContent = search ? 'Edit profile search' : 'Create a profile search';
  $('#search-id').value = search?.id || '';
  $('#search-name').value = search?.name || '';
  $('#search-profile').replaceChildren(...applicantLibrary.profiles.map(profile => element('option', {value: profile.id}, profile.name)));
  $('#search-profile').value = search?.profileId || $('#search-profile-filter').value || applicantLibrary.activeId;
  const defaults = searchProfilePreferences();
  showProfileSearchCriteria(defaults);
  $('#search-locations').replaceChildren(...value.monitors.map(monitor => element('label', {class: 'checkbox-label'}, element('input', {type: 'checkbox', name: 'search-location', value: monitor.id, ...(search?.locationIds.includes(monitor.id) ? {checked: ''} : {})}), monitor.name)));
  $('#search-email').checked = search?.actions.email ?? true;
  $('#search-auto-apply').checked = search?.actions.autoApply ?? false;
  $('#search-create-account').checked = search?.createAccount ?? false;
  $('#search-account-options').hidden = !$('#search-auto-apply').checked;
  $('#search-error').hidden = true;
  $('#search-editor').showModal();
  $('#search-name').focus();
}
$('#search-auto-apply').addEventListener('change', () => { $('#search-account-options').hidden = !$('#search-auto-apply').checked; });
$('#new-search').addEventListener('click', () => showSearchEditor());
$('#search-profile').addEventListener('change', () => showProfileSearchCriteria(searchProfilePreferences()));
$('#cancel-search').addEventListener('click', () => $('#search-editor').close());
$('#search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    await request({type: 'save-search', search: {
      id: $('#search-id').value || undefined, name: $('#search-name').value, profileId: $('#search-profile').value,
      locationIds: [...document.querySelectorAll('input[name="search-location"]:checked')].map(item => item.value),
      actions: {email: $('#search-email').checked, autoApply: $('#search-auto-apply').checked}, createAccount: $('#search-auto-apply').checked && $('#search-create-account').checked,
    }});
    $('#search-editor').close();
    await loadState();
    switchTab('searches');
  } catch (error) { $('#search-error').textContent = error.message; $('#search-error').hidden = false; $('#search-error').scrollIntoView({block: 'center'}); }
  finally { if (submit) submit.disabled = false; }
});

function actionOutcome(record) {
  return ({sent: 'Accepted by email provider', review: 'Application attempted — needs review', failed: 'Attempt failed', interrupted: 'Interrupted — outcome uncertain', running: 'In progress', queued: 'Queued', cancelled: 'Cancelled after starting', recorded: 'Previous attempt recorded'})[record.status] || 'Previous attempt recorded';
}
function searchClaimRecords(search) {
  return Object.entries(value.searchClaims || {}).flatMap(([key, claim]) => {
    let parts;
    try { parts = JSON.parse(key); } catch { return []; }
    if (!Array.isArray(parts) || parts[0] !== search.profileId || !search.locationIds.includes(parts[1])) return [];
    return [{...(typeof claim === 'string' ? {id: claim, status: 'recorded'} : claim), monitorId: parts[1], listingId: parts[2], channel: parts[3]}];
  }).sort((a, b) => (b.at || 0) - (a.at || 0));
}
function listingClaimBadges(search, monitorId, listing) {
  return element('span', {class: 'listing-claim-badges'}, ...['autoApply', 'email'].flatMap(channel => {
    const claim = value.searchClaims?.[searchClaimKey(search.profileId, monitorId, listingKey(listing), channel)];
    return claim ? [element('span', {}, `${channel === 'email' ? 'Email' : 'Auto-apply'}: ${actionOutcome(claim)}`)] : [];
  }));
}
let startSearchSelection = null;
let readinessRequest = 0;
function startSearchActions() {
  return {autoApply: $('#start-auto-apply').checked, email: $('#start-email').checked, sms: $('#start-sms').checked};
}
async function showStartSearch(search) {
  startSearchSelection = {id: search.id, generation: search.generation};
  const profile = applicantLibrary.profiles.find(profile => profile.id === search.profileId);
  $('#start-search-title').textContent = `Start search for ${profile?.name || 'this profile'}`;
  $('#start-search-description').textContent = `${search.name} · ${profile?.details.email || 'No profile email saved'}`;
  $('#start-auto-apply').checked = search.actions.autoApply;
  $('#start-email').checked = search.actions.email;
  $('#start-sms').checked = false;
  $('#start-create-account').checked = search.createAccount;
  $('#start-search-error').hidden = true;
  $('#start-search-dialog').showModal();
  await updateStartReadiness();
}
async function updateStartReadiness() {
  if (!startSearchSelection || !$('#start-search-dialog').open) return;
  const version = ++readinessRequest;
  $('#start-account-options').hidden = !$('#start-auto-apply').checked;
  const confirm = $('#confirm-start-search');
  confirm.disabled = true;
  confirm.textContent = 'Checking…';
  const root = $('#start-search-readiness');
  try {
    const report = await request({type: 'search-readiness', id: startSearchSelection.id, actions: startSearchActions(), createAccount: $('#start-auto-apply').checked && $('#start-create-account').checked});
    if (version !== readinessRequest || !$('#start-search-dialog').open) return;
    root.replaceChildren(element('h3', {}, report.canStart ? report.ready ? 'Ready to start' : 'Can start · website input expected' : 'Complete these checks first'));
    if (report.blockers.length) root.append(element('ul', {class: 'readiness-blockers'}, ...report.blockers.map(text => element('li', {}, text))));
    for (const location of report.locations) {
      const details = element('details', {}, element('summary', {}, `${location.name} · ${location.ready ? 'Checked' : 'Needs details'}`));
      if (location.missingRequired?.length) details.append(element('p', {}, `Needed before starting: ${location.missingRequired.join(', ')}.`));
      if (location.missing?.length) details.append(element('p', {}, `Website input expected: ${location.missing.join(', ')}.`));
      details.append(element('p', {class: 'helper'}, location.note));
      if (location.missing?.length || location.missingRequired?.length) details.open = true;
      root.append(details);
    }
    for (const text of report.warnings) root.append(element('p', {class: 'readiness-warning'}, text));
    root.append(element('button', {type: 'button', class: 'text-button', onclick: guard(async () => {
      const search = value.searches.find(search => search.id === startSearchSelection.id);
      if (search && applicantLibrary.profiles.some(profile => profile.id === search.profileId)) await request({type: 'select-profile', id: search.profileId});
      $('#start-search-dialog').close();
      await loadState();
      switchTab('personal');
    })}, 'Review profile details →'));
    confirm.disabled = !report.canStart;
    confirm.textContent = report.canStart && !report.ready ? 'Start search — review needed' : 'Start search';
  } catch (error) {
    if (version !== readinessRequest) return;
    root.replaceChildren(element('p', {class: 'form-error'}, error.message));
    confirm.textContent = 'Start search';
  }
}
for (const id of ['start-auto-apply', 'start-email', 'start-sms', 'start-create-account']) $(`#${id}`).addEventListener('change', updateStartReadiness);
$('#cancel-start-search').addEventListener('click', () => $('#start-search-dialog').close());
$('#start-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#confirm-start-search').disabled = true;
  try {
    await request({type: 'set-search-enabled', id: startSearchSelection.id, expectedGeneration: startSearchSelection.generation, enabled: true, actions: startSearchActions(), createAccount: $('#start-auto-apply').checked && $('#start-create-account').checked});
    $('#start-search-dialog').close();
    await loadState();
  } catch (error) {
    $('#start-search-error').textContent = error.message;
    $('#start-search-error').hidden = false;
    $('#start-search-error').scrollIntoView({block: 'center'});
    await updateStartReadiness();
  }
});
let repeatSearchSelection = null;
function showRepeatSearch(search, record) {
  repeatSearchSelection = {id: search.id, monitorId: record.monitorId, listingId: record.listingId, channel: record.channel, expectedClaimId: claimActionId(record)};
  $('#repeat-search-form').reset();
  $('#repeat-search-title').textContent = record.channel === 'email' ? 'Authorize another email' : 'Authorize another application';
  $('#repeat-search-details').replaceChildren(...[
    ['Profile', applicantLibrary.profiles.find(profile => profile.id === search.profileId)?.name || 'Deleted profile'],
    ['Apartment', record.listingName || record.listingId],
    ['Previous outcome', actionOutcome(record)],
    ['Recorded', record.at ? new Date(record.at).toLocaleString() : 'Date unavailable'],
    ['Details', record.message || 'Previous attempt recorded.'],
  ].map(([label, text]) => element('div', {}, element('dt', {}, label), element('dd', {}, text))));
  $('#repeat-search-warning').textContent = record.channel === 'email' ? 'The profile holder may already have received this apartment. This authorizes one additional email.' : 'An application or reservation may already exist. Inspect the previous tab first. This authorizes one additional application attempt.';
  $('#repeat-search-error').hidden = true;
  $('#repeat-search-dialog').showModal();
}
$('#cancel-repeat-search').addEventListener('click', () => $('#repeat-search-dialog').close());
$('#repeat-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#confirm-repeat-search');
  submit.disabled = true;
  try {
    await request({type: 'repeat-search-action', ...repeatSearchSelection, confirmed: $('#repeat-search-consent').checked});
    $('#repeat-search-dialog').close();
    await loadState();
  } catch (error) { $('#repeat-search-error').textContent = error.message; $('#repeat-search-error').hidden = false; }
  finally { submit.disabled = false; }
});
