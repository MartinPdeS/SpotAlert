import {SUPPORTED_SITES} from "./sites/index.js";
import {createNavigation} from "./panel-navigation.js";
import {createApplicationView} from "./panel-application.js";
import {element} from "./panel-dom.js";
import {mountProfileFields} from "./panel-profile-fields.js";
import {createDiagnosticsView} from "./panel-diagnostics.js";
import {createMaintenanceView} from "./panel-maintenance.js";
import {diagnosticReport, diagnosticText} from './diagnostics.js';
import {createSearchView} from "./panel-searches.js";
import {createDeliveryView} from "./panel-delivery.js";
import {APPLICATION_BUILD} from "./application-diagnostics.js";
import {STORAGE_KEY, siteError, listingKey, safeListingUrl, sitePattern, validateMonitor} from "./core.js";

import {UI_KEY, freshness, availabilityTotals, cleanError, resultStatus, monitoringScope, errorRecovery} from "./ui.js";
import {PROFILE_KEY, PROFILES_KEY, PROFILE_FIELDS, profileReadinessForSite, validateProfile, generateRegistrationPassword} from "./profile.js";

const $ = (selector) => document.querySelector(selector);
const {switchTab, hasVisited} = createNavigation($);
let value = {monitors: []};
let selectedId = null;
let showAllSamples = false;
let listingFilter = "all";
let technicalOpen = false;
let toastTimer;
const pendingMonitorActions = new Set();
const recentErrors = [];
function rememberError(operation, error) {
  recentErrors.push({at: Date.now(), operation, message: diagnosticText(error?.message || error)});
  if (recentErrors.length > 20) recentErrors.shift();
}
function reportText() {
  return JSON.stringify(diagnosticReport(value, recentErrors, {version: chrome.runtime.getManifest().version, browser: navigator.userAgent}), null, 2);
}
async function copyDiagnostics() {
  try { await navigator.clipboard.writeText(reportText()); toast("Diagnostic report copied."); }
  catch { downloadDiagnostics(); toast("Diagnostic report downloaded."); }
}
function downloadDiagnostics() {
  const url = URL.createObjectURL(new Blob([reportText()], {type: "application/json"}));
  element("a", {href: url, download: "spotalert-diagnostics.json"}).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
let loadingState = false;
let reloadState = false;
let personalProfile = {};
let readinessLocationId = SUPPORTED_SITES[0].id;
let applicantLibrary = {profiles: []};
let compactView = false;
let checkBuildingIds = new Set();
let buildingSelectionWrites = 0;
let changingSelectedMonitoring = false;
let uiPreferenceWrites = Promise.resolve();
function saveUiPreferences(patch) {
  uiPreferenceWrites = uiPreferenceWrites.catch(() => {}).then(async () => {
    const stored = (await chrome.storage.local.get(UI_KEY))[UI_KEY] || {};
    await chrome.storage.local.set({[UI_KEY]: {...stored, ...patch}});
  });
  return uiPreferenceWrites;
}
function buildingCheckbox(monitor, picker) {
  const checkbox = element('input', {type: 'checkbox', 'data-check-building-id': monitor.id, 'data-check-picker': picker, title: 'Use this building for Check now and monitoring', 'aria-label': `Select ${monitor.name}`});
  checkbox.checked = checkBuildingIds.has(monitor.id);
  checkbox.disabled = value.checkBatch?.status === 'running';
  checkbox.addEventListener('change', guard(async () => {
    if (checkbox.checked) checkBuildingIds.add(monitor.id); else checkBuildingIds.delete(monitor.id);
    const ids = [...checkBuildingIds];
    buildingSelectionWrites++;
    render();
    try { await saveUiPreferences({checkBuildingIds: ids}); } finally { buildingSelectionWrites--; }
  }));
  return checkbox;
}
import {EMAIL_KEY, CONTACT_KEY} from "./email.js";
let contactsLoaded = false;
let personalDirty = false;

const busy = (monitor) => ["queued", "refreshing", "reading", "capturing"].includes(monitor.phase);
const clock = (timestamp) => timestamp ? new Date(timestamp).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"}) : "—";
const interval = (seconds) => seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${seconds / 60}m` : `${seconds / 3600}h`;
const domain = (url) => { try { return new URL(url).hostname; } catch { return url; } };
const selected = () => value.monitors.find((monitor) => monitor.id === selectedId);

async function request(message) {
  try {
    const response = await chrome.runtime.sendMessage({...message, dashboardBuild: APPLICATION_BUILD});
    if (!response?.ok) throw Object.assign(new Error(response?.error || "SpotAlert could not connect to its background worker. Reload the extension."), response?.details);
    return response.result;
  } catch (error) { rememberError(message.type, error); throw error; }
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const node = $("#toast");
  node.replaceChildren(element("span", {}, message));
  node.setAttribute("role", error ? "alert" : "status");
  if (error) {
    rememberError("dashboard", message);
    node.append(element("button", {type: "button", class: "text-button", onclick: copyDiagnostics}, "Copy diagnostics"), element("button", {type: "button", class: "text-button", onclick: () => { node.hidden = true; }}, "Dismiss"));
  }
  node.classList.toggle("error", error);
  node.hidden = false;
  if (!error) toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
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
      if (!personalDirty) for (const field of PROFILE_FIELDS) {
        const input = $(`#personal-${field}`);
        if (field === "noMiddleName") input.checked = personalProfile[field] === "Yes";
        else input.value = personalProfile[field] || "";
      }
      compactView = Boolean(preferences[UI_KEY]?.compact);
      if (!buildingSelectionWrites) checkBuildingIds = new Set(Array.isArray(preferences[UI_KEY]?.checkBuildingIds) ? preferences[UI_KEY].checkBuildingIds.filter(id => state.monitors.some(monitor => monitor.id === id)) : state.monitors.map(monitor => monitor.id));
      if (!contactsLoaded) {
        $("#client-reply-to").value = preferences[CONTACT_KEY]?.email || "";
        $("#email-api-key").value = preferences[EMAIL_KEY]?.apiKey || "";
        $("#email-sender").value = preferences[EMAIL_KEY]?.sender || "onboarding@resend.dev";
        contactsLoaded = true;
      }
      if (!value.monitors.some((monitor) => monitor.id === selectedId)) selectedId = value.monitors[0]?.id || null;
      render();
      if (!hasVisited() && value.searches?.length) switchTab("searches");
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
  renderDiagnostics();
  renderSettings();
  renderClientOverview();
  const batch = value.checkBatch;
  const batchRunning = batch?.status === 'running';
  const included = value.monitors.filter(monitor => checkBuildingIds.has(monitor.id));
  $('#check-all-buildings').disabled = batchRunning || !included.length;
  $('#check-all-buildings').setAttribute('aria-busy', String(batchRunning));
  $('#check-all-buildings').textContent = batchRunning ? `Checking ${Math.min(batch.completed + 1, batch.total)}/${batch.total}…` : 'Check now';
  $('#building-selection-count').textContent = included.length ? `${included.length} ${included.length === 1 ? 'building' : 'buildings'} selected` : 'Select buildings below';
  const allMonitoring = included.length && included.every(monitor => monitoringScope(monitor, value.searches).general);
  const monitorSelected = $('#monitor-selected-buildings');
  monitorSelected.textContent = changingSelectedMonitoring ? 'Updating…' : allMonitoring ? 'Stop monitoring' : 'Start monitoring';
  monitorSelected.className = allMonitoring ? 'danger-button' : 'secondary-button';
  monitorSelected.disabled = !included.length || changingSelectedMonitoring;
  monitorSelected.setAttribute('aria-busy', String(changingSelectedMonitoring));
  monitorSelected.title = allMonitoring ? 'Stop general monitoring for the selected buildings' : 'Start general monitoring for the selected buildings';
  $('#check-all-buildings').title = 'Check the ticked buildings once. Does not start recurring monitoring.';
  $('#cancel-all-checks').hidden = !batchRunning;
  const batchProgress = $('#building-check-progress');
  batchProgress.hidden = !batch;
  if (batch) {
    const current = value.monitors.find(monitor => monitor.id === batch.currentId);
    batchProgress.textContent = batchRunning ? `${batch.completed} of ${batch.total} checked${current ? ` · ${current.name}` : ''}` : `${batch.status === 'cancelled' ? 'Cancelled' : batch.status === 'interrupted' ? 'Interrupted by extension restart' : 'Finished'} · ${batch.completed} of ${batch.total} checked${batch.failed ? ` · ${batch.failed} failed; review the affected building` : ''}`;
  }
  const totals = availabilityTotals(value.monitors);
  $("#apartment-count").textContent = `${totals.unknownCounts ? "≥" : ""}${totals.apartments}`;
  $("#apartment-count-note").hidden = !totals.unknownCounts;
  $("#apartment-count").title = totals.unknownCounts ? "At least one apartment per available floor plan; some sites do not publish exact unit counts. Totals use the last successful results." : "Published unit counts from the last successful results.";
  $("#stop-all").disabled = !value.monitors.some(monitor => monitor.enabled || busy(monitor) || monitor.application?.status === "running");
  $("#stop-all").hidden = $("#stop-all").disabled;
  $("#active-count").textContent = value.monitors.filter((monitor) => monitor.enabled).length;
  $("#available-count").textContent = totals.websites;
  $("#check-count").textContent = value.monitors.reduce((sum, monitor) => sum + monitor.checks, 0);
  $("#monitor-count").textContent = value.monitors.length;
  const locationPicker = $("#location-picker");
  const locationOptions = value.monitors.map(monitor => [monitor.id, monitor.name]);
  if (JSON.stringify([...locationPicker.options].map(option => [option.value, option.textContent])) !== JSON.stringify(locationOptions)) {
    locationPicker.replaceChildren(...locationOptions.map(([id, name]) => element("option", {value: id}, name)));
  }
  locationPicker.value = selectedId;
  const focusedCheckbox = document.activeElement?.dataset.checkBuildingId;
  const focusedPicker = document.activeElement?.dataset.checkPicker;
  $("#monitors").replaceChildren(...value.monitors.map((monitor) => element("div", {class: `monitor-choice${checkBuildingIds.has(monitor.id) ? " included" : ""}`}, buildingCheckbox(monitor, "desktop"), element("button", {
    class: `monitor-card${monitoringScope(monitor, value.searches).general ? " watching" : ""}${monitor.id === selectedId ? " selected" : ""}`,
    "aria-pressed": String(monitor.id === selectedId),
    onclick: () => selectLocation(monitor.id),
  },
  element("span", {class: "monitor-title"}, monitor.name),
  element("span", {class: "monitor-bottom"}, element("span", {class: `building-card-result ${resultStatus(monitor).kind}`}, resultStatus(monitor).label), monitoringScope(monitor, value.searches).general && element("span", {class: "monitoring-indicator"}, "● Monitoring")),
  element("span", {class: "freshness", "data-freshness": monitor.id}),

  ))));
  $('#mobile-check-selection-summary').textContent = `Choose buildings · ${included.length} of ${value.monitors.length}`;
  $('#mobile-check-options').replaceChildren(...value.monitors.map(monitor => element('label', {class: 'checkbox-label'}, buildingCheckbox(monitor, 'mobile'), monitor.name)));
  if (focusedCheckbox) document.querySelector(`[data-check-building-id="${focusedCheckbox}"][data-check-picker="${focusedPicker}"]`)?.focus({preventScroll: true});
  if (!value.monitors.length) $("#monitors").append(element("p", {class: "empty-note"}, "No supported websites are available."));
  renderDetail();
  updateFreshness();
}
function actionButton(label, type, monitor, className = "secondary-button") {
  const key = `${monitor.id}:${type}`;
  const button = element('button', {class: className, 'data-action': type, onclick: guard(async () => {
    if (pendingMonitorActions.has(key)) return;
    pendingMonitorActions.add(key);
    button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = type === 'check' ? 'Checking…' : type === 'cancel-check' ? 'Cancelling…' : 'Updating…';
    try { await request({type, id: monitor.id}); }
    finally { pendingMonitorActions.delete(key); await loadState(); }
  })}, pendingMonitorActions.has(key) ? 'Updating…' : label);
  button.disabled = pendingMonitorActions.has(key) || (type === 'check' && busy(monitor));
  button.setAttribute('aria-busy', String(pendingMonitorActions.has(key)));
  return button;
}
function renderDetail() {
  const monitor = selected();
  const root = $("#detail");
  const diagnosticsOpen = root.querySelector('.application-diagnostics')?.open;
  const optionsOpen = root.querySelector('.monitor-options')?.open;
  const focusedAction = root.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  root.replaceChildren();
  if (!monitor) {
    root.append(element("div", {class: "empty-state"}, element("h2", {}, "Select a website")));
    return;
  }
  const scope = monitoringScope(monitor, value.searches);
  const controlPanel = element('section', {class: 'building-control-panel', 'aria-label': 'Building controls'});
  const controlHeading = element('div', {class: 'building-control-heading'}, element('h3', {}, monitor.name));
  const toolbar = element('div', {class: 'building-action-row'});
  controlPanel.append(controlHeading, toolbar);
  root.append(controlPanel);
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
  const options = element("details", {class: "monitor-options"}, element("summary", {}, "Options"));
  options.open = Boolean(optionsOpen);
  options.append(element("div", {class: "monitor-options-content"}, element("label", {class: "refresh-control"}, "Check every", refresh), element("button", {id: "configure-monitor", class: "small-button", onclick: () => { options.open = false; openEditor(monitor); }}, "Configure monitor")));
  options.addEventListener("keydown", event => { if (event.key === "Escape") { options.open = false; options.querySelector("summary").focus(); } });
  toolbar.append(element("div", {class: "building-secondary-actions"}, element("button", {class: "text-button detail-url", title: monitor.url, onclick: guard(() => request({type: "open", id: monitor.id}))}, "Open website ↗"), options));
  if (monitor.application?.message) {
    const app = monitor.application;
    if (app.status === 'running') root.append(element('div', {class: 'application-progress', role: 'status'}, element('span', {}, `Application in progress · ${app.stage || 'Preparing'}…`), actionButton('Cancel application', 'stop-application', monitor)));

    const details = element("details", {class: "application-diagnostics", "data-application-build": APPLICATION_BUILD}, element("summary", {}, "Application activity"));
    details.open = !!diagnosticsOpen;
    details.append(element('p', {class: 'helper'}, `Last application attempt for ${monitor.name}${app.applicantName ? ` · ${app.applicantName}` : ''}${app.listingName ? ` · ${app.listingName}` : ''}${app.updatedAt ? ` · ${new Date(app.updatedAt).toLocaleString()}` : ''}. Separate from availability checks.`));
    details.append(element("p", {class: "helper application-result"}, app.message));
    if (app.moveInDate) details.append(element("p", {class: "helper move-in-feedback"}, `Move-in date: ${app.moveInDate}`));
    if (app.build !== APPLICATION_BUILD) details.append(element("p", {class: "form-error"}, "This run used an older build. Reload SpotAlert at chrome://extensions, reopen the dashboard, and try Apply again."));
    if (app.tabId) details.append(element("button", {type: "button", class: "secondary-button", onclick: guard(() => request({type: "open-application-tab", id: monitor.id}))}, "Open application tab ↗"));
    details.append(element("button", {type: "button", class: "text-button", onclick: () => { renderDiagnostics(); switchTab("diagnostics"); }}, "View diagnostics"));
    root.append(details);
  }

  const attention = monitor.error ? element("section", {class: "attention-card", "aria-label": "Monitoring status"}) : null;
  if (attention) {
    attention.append(element("h3", {class: "attention-title"}, "Needs attention"));
    if (monitor.error) {
      const titles = {verification: "Complete website verification", login: "Sign in to the website", loading: "Website did not finish loading", selector: "Update the availability rule", permission: "Allow website access", navigation: "Return to the monitored page"};
      const row = element("div", {class: "attention-monitor", role: "alert"}, element("h4", {}, titles[monitor.errorKind] || "Monitoring check failed"), element("p", {}, cleanError(monitor.name, monitor.url, monitor.error)));
      const actions = element("div", {class: "control-row"}, actionButton("Open affected tab ↗", "open-affected", monitor));
      if (["permission", "selector"].includes(monitor.errorKind)) actions.append(element("button", {class: "secondary-button", onclick: () => openEditor(monitor)}, monitor.errorKind === "permission" ? "Review website access" : "Edit rule"));
      actions.append(element("button", {type: "button", class: "text-button", onclick: copyDiagnostics}, "Copy diagnostics"));
      row.append(element("p", {class: "helper"}, `Last successful check: ${monitor.lastCheckedAt ? new Date(monitor.lastCheckedAt).toLocaleString() : "None yet"} · Consecutive failures: ${monitor.consecutiveErrors || 0}`));
      row.append(element('p', {class: 'helper'}, 'Availability could not be confirmed. Previous successful results are retained.'), element('p', {class: 'helper'}, errorRecovery(monitor.errorKind)));
      actions.prepend(actionButton('Retry check', 'check', monitor));
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
      }}, "Edit profile"));
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
  if (!filterText && !floors && !monitor.hours?.enabled) root.querySelector(".watch-summary").remove();
  let caption = "Monitoring paused";
  let symbol = "Ⅱ";
  let sub = "";
  if (busy(monitor)) { caption = monitor.readMethod === "background" ? "Fetching listing data in background…" : monitor.phase === "capturing" ? "Capturing application page…" : monitor.phase === "reading" ? "Reading availability elements…" : monitor.phase === "queued" ? "Waiting for the previous check…" : "Refreshing browser tab…"; symbol = "↻"; sub = ""; }
  else if (monitor.error) { caption = {verification: "Verification required", login: "Sign in required", loading: "Page still loading", selector: "Rule needs updating", permission: "Website access required", navigation: "Tab navigated away"}[monitor.errorKind] || "The last check failed"; symbol = "!"; sub = monitor.enabled ? `Retry scheduled after ${monitor.consecutiveErrors || 1} failed ${monitor.consecutiveErrors === 1 ? "check" : "checks"}.` : "Fix the rule or page access, then try again."; }
  else if (monitor.phase === "waiting-hours" && monitor.enabled) { caption = "Waiting for monitoring hours"; symbol = "◷"; }
  else if (monitor.enabled) { caption = "Watching for availability"; symbol = "✓"; sub = ""; }
  const statusRow = element("div", {class: "monitor-status telemetry", role: "status"});
  root.setAttribute("aria-busy", String(busy(monitor)));
  if (busy(monitor) || (monitor.phase === "waiting-hours" && monitor.enabled)) statusRow.append(element("span", {class: `activity-caption${busy(monitor) ? " spinning" : ""}`}, caption));
  if (monitor.lastCheckedAt && !resultStatus(monitor).historical) statusRow.append(element("span", {class: "freshness", "data-freshness": monitor.id}));
  if (scope.general) statusRow.append(element("span", {}, "Next check ", element("span", {"data-next": monitor.id}, nextLabel(monitor))));
  const resultsState = resultStatus(monitor);
  if (!busy(monitor)) statusRow.append(element('strong', {class: `result-status ${resultsState.kind}`}, resultsState.label));
  if (resultsState.historical && monitor.samples.length) statusRow.append(element('span', {class: 'helper'}, `Previous results${monitor.lastCheckedAt ? ` from ${new Date(monitor.lastCheckedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}` : ''}; availability unconfirmed.`));

  controlHeading.append(statusRow);
  const technical = element("details", {class: "technical-details"}, element("summary", {}, "Technical details & activity"));
  if (monitor.readFallbackReason) technical.append(element('p', {class: 'helper read-fallback'}, `Browser fallback: ${monitor.readFallbackReason}. Background requests retry after ${monitor.backgroundRetryAt ? new Date(monitor.backgroundRetryAt).toLocaleTimeString() : 'the cooldown'}.`));
  if (monitor.readMethod) technical.prepend(element('p', {class: 'helper read-method'}, monitor.readMethod === 'background' ? 'Background check' : 'Browser check'));
  technical.open = technicalOpen;
  technical.addEventListener("toggle", () => { technicalOpen = technical.open; });
  technical.append(element("section", {class: "detail-section"},
    element("div", {class: "section-heading"}, element("h3", {}, "Availability rule"), badge(monitor)),
    element("div", {class: "rule-block"}, element("div", {class: "rule-code"}, monitor.rule.type === "text" ? "document.body.innerText" : monitor.rule.selector), element("div", {class: "rule-meta"},
      "Available when text ", element("code", {}, {contains: "contains", equals: "equals", not_equals: "does not equal"}[monitor.rule.mode]), " ", element("code", {}, JSON.stringify(monitor.rule.expected)), element("br"),
      `Case insensitive · Every ${interval(monitor.intervalSeconds)}`)),
  ));
  const sampleSection = element("section", {class: "detail-section"});
  const sampleHeader = element("div", {class: "section-heading"}, element("h3", {}, `Floor plans ${monitor.samples.length ? `· ${monitor.samples.filter((sample) => sample.included !== false).length}` : ""}`));
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
    const details = [["Bedrooms", {studio: "Studio", "1-bedroom": "1", "2-bedroom": "2", "3-plus": sample.beds || "3+"}[sample.apartmentType] || sample.beds], ["Size", sample.size], ["Bathrooms", sample.baths]].filter(([, value]) => value);
    return element("article", {class: `sample${sample.matched ? " matched" : ""}`},
      element("div", {class: "sample-top"}, element("h4", {class: "sample-name"}, sample.name || "Floor plan description unavailable"), element("span", {class: `pill${sample.matched ? " available" : ""}`}, sample.included === false ? "Filtered out" : sample.matched ? resultStatus(monitor).historical ? "Previously available" : "Available" : resultStatus(monitor).historical ? "Previous result" : "Not available")),
      element("p", {class: "listing-rent"}, sample.rent || "Rent not published"),
      element("p", {class: "listing-location"}, monitor.name),
      element("p", {class: "sample-type"}, {studio: "Studio", "1-bedroom": "1 bedroom", "2-bedroom": "2 bedrooms", "3-plus": "3+ bedrooms"}[sample.apartmentType] || ""),
      details.length ? element("dl", {class: "listing-details"}, ...details.map(([label, value]) => element("div", {}, element("dt", {}, label), element("dd", {}, value)))) : element("p", {class: "sample-context"}, "Check again to load apartment details."),
      Boolean(sample.preferenceReasons?.length) && element("p", {class: "sample-context"}, sample.preferenceReasons.join(" · ")),
      element("div", {class: "listing-actions"},
        element("a", {class: "secondary-button", href: safeListingUrl(sample.pageUrl || sample.applicationUrl, monitor.url) || monitor.url, target: "_blank", rel: "noopener noreferrer"}, "View apartment ↗"),
        sample.matched && listingButton(monitor, sample)));
  })));
  root.append(sampleSection);
  technical.append(element("button", {type: "button", class: "text-button", onclick: () => { renderDiagnostics(); switchTab("diagnostics"); }}, "View activity in Diagnostics"));
  root.append(technical);
  let applicationActivity = root.querySelector('.application-diagnostics');
  if (!applicationActivity) applicationActivity = element('details', {class: 'application-diagnostics'}, element('summary', {}, 'Application activity'), element('p', {class: 'helper'}, 'No application attempt recorded for this building. Availability checks do not create an application.'));
  applicationActivity.open = !!diagnosticsOpen;
  root.append(applicationActivity);

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
$(".brand").addEventListener("click", (event) => { event.preventDefault(); switchTab("searches"); window.scrollTo({top: 0, behavior: "instant"}); });
function listingButton(monitor, sample) {
  const button = element("button", {class: "primary-button listing-link", onclick: guard(async () => {
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
mountProfileFields($);
const {showApplyConfirmation} = createApplicationView({
  $, element, guard, request, toast, getLibrary: () => applicantLibrary,
  isPersonalDirty: () => personalDirty,
});
const viewContext = {$, element, guard, request, loadState, switchTab, toast, openProfile, openLocation: id => { selectLocation(id); switchTab("monitoring"); }, showApplyConfirmation, getState: () => value, getLibrary: () => applicantLibrary, isPersonalDirty: () => personalDirty};
const {renderSearches} = createSearchView(viewContext);
const {renderSettings} = createDeliveryView(viewContext);
const {renderDebug} = createMaintenanceView({...viewContext, clock});
const {render: renderDiagnostics} = createDiagnosticsView({...viewContext, getRecentErrors: () => recentErrors});
$("#diagnostics-tab").addEventListener("click", renderDiagnostics);
loadState().catch((error) => toast(error.message, true));

function updateProfilePresentation() {
  const name = $("#profile-name").value.trim();
  $("#profile-avatar").textContent = name.split(/\s+/).map(word => word[0]).slice(0, 2).join("").toUpperCase() || "＋";
  const draft = readProfile();
  const site = SUPPORTED_SITES.find(site => site.id === readinessLocationId) || SUPPORTED_SITES[0];
  const requirements = profileReadinessForSite(draft, site);
  const required = new Set(requirements.fields);
  const missingFields = new Set(requirements.missingFields.map(field => field.key));
  for (const group of document.querySelectorAll(".profile-group")) {
    const requiredKeys = group.dataset.fields.split(",").filter(key => required.has(key));
    const missing = requiredKeys.filter(key => missingFields.has(key)).length;
    const marker = group.querySelector(".profile-section-count");
    marker.textContent = missing ? `${missing} needed` : requiredKeys.length ? "" : "Optional";
    marker.hidden = !marker.textContent;
  }
  for (const wrapper of document.querySelectorAll("[data-profile-field]")) {
    const key = wrapper.dataset.profileField;
    wrapper.querySelector(".field-requirement").textContent = required.has(key) ? "*" : "";
    wrapper.querySelector(".field-requirement").setAttribute("aria-label", required.has(key) ? "Required" : "");
    wrapper.querySelector(".field-requirement").classList.toggle("is-required", required.has(key));
    wrapper.hidden = key === "middleName" && draft.noMiddleName === "Yes" || ["Retired", "Never employed"].includes(draft.employmentStatus) && ["jobTitle", "employer", "employedSince", "employerCountry", "employerAddress", "employerAddressLine2", "employerPostalCode", "employerCity", "employerPhone"].includes(key);
  }
  const active = applicantLibrary.profiles.find(entry => entry.id === applicantLibrary.activeId);
  $("#test-profile-badge").hidden = !active?.testProfile;
  renderClientOverview();
  $("#profile-save-status").textContent = personalDirty ? "Unsaved changes" : "All changes saved";
  $("#profile-save-status").classList.toggle("unsaved", personalDirty);
}
$("#profile-name").addEventListener("invalid", () => { $("#profile-rename").open = true; });
$("#saved-profile").addEventListener("change", guard(async () => {
  if (personalDirty) {
    $("#saved-profile").value = $("#saved-profile").dataset.activeId;
    toast("Save your changes before switching applicants.", true);
    return;
  }
  await request({type: "select-profile", id: $("#saved-profile").value});
  await loadState();
  $("#profile-rename").open = false;
}));
$("#new-profile").addEventListener("click", guard(async () => {
  if (personalDirty) { toast("Save your changes before creating an applicant.", true); return; }
  await request({type: "create-profile"});
  await loadState();
  $("#profile-rename").open = true;
  $("#profile-name").focus(); $("#profile-name").select();
}));
$("#personal-form").addEventListener("input", event => {
  const id = event.target.id;
  if (id === "profile-readiness-location") return;
  if (id === "personal-noMiddleName" && event.target.checked) $("#personal-middleName").value = "";
  if (!["saved-profile", "signature-consent"].includes(id)) personalDirty = true;
  updateProfilePresentation();
});
$("#generate-registration-details").addEventListener("click", () => {
  const details = {registrationPassword: generateRegistrationPassword()};
  for (const [key, value] of Object.entries(details)) {
    const input = $(`#personal-${key}`);
    input.value = value;
    input.closest("details").open = true;
  }
  personalDirty = true;
  updateProfilePresentation();
  toast("Password generated. Save personal information to use it.");
});
$("#create-test-profiles").addEventListener("click", guard(async () => {
  if (personalDirty) throw new Error("Save your profile changes before creating test profiles.");
  await request({type: "create-test-profiles", regenerate: true});
  await loadState();
  toast("Two realistic fictional profiles generated. Select either profile to review its details.");
}));
$("#personal-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const profile = readProfile();
    await request({type: "save-profile", profile, name: $("#profile-name").value});
    personalDirty = false;
    $("#personal-error").hidden = true;
    await loadState();
    toast("Applicant saved.");
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
  toast("Applicant deleted.");
}));
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
  await saveUiPreferences({compact: compactView});
}));

$("#enable-profile-folder").addEventListener("click", guard(async () => {
  if (personalDirty) throw new Error("Save your profile changes first.");
  await request({type: "enable-profile-folder"}); await loadState(); toast("Profiles saved to the local SpotAlert folder.");
}));
$("#open-profile-folder").addEventListener("click", guard(() => request({type: "open-profile-folder"})));

function readProfileField(key) {
  const input = $(`#personal-${key}`);
  return key === "noMiddleName" ? input.checked ? "Yes" : "No" : input.value;
}
function readProfile() {
  return Object.fromEntries(PROFILE_FIELDS.map(key => [key, readProfileField(key)]));
}
function focusProfileField(key) {
  const input = $(`#personal-${key}`);
  if (!input) return;
  for (let group = input.closest("details"); group; group = group.parentElement.closest("details")) group.open = true;
  input.scrollIntoView({block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
  input.focus({preventScroll: true});
}
async function openProfile(id, key = null) {
  if (personalDirty && id !== applicantLibrary.activeId) throw new Error("Save your profile changes before loading another profile.");
  document.querySelector("dialog[open]")?.close();
  if (id !== applicantLibrary.activeId) {
    await request({type: "select-profile", id});
    await loadState();
  }
  switchTab("personal");
  if (key) focusProfileField(key);
}
function selectLocation(id) {
  selectedId = id; showAllSamples = false; listingFilter = "all"; render();
}
const narrowWorkspace = matchMedia("(max-width: 719px)");
function adaptLocationOverview() { $("#location-overview").open = false; }
narrowWorkspace.addEventListener("change", adaptLocationOverview);
adaptLocationOverview();
$("#location-picker").addEventListener("change", event => selectLocation(event.target.value));
function renderClientOverview() {
  const list = $('#client-overview-list');
  const expanded = list.querySelector('details')?.open || false;
  const focusedKey = list.contains(document.activeElement) ? document.activeElement.dataset.field : null;
  const pickerFocused = document.activeElement?.id === 'profile-readiness-location';
  const draft = readProfile();
  const site = SUPPORTED_SITES.find(site => site.id === readinessLocationId) || SUPPORTED_SITES[0];
  const readiness = profileReadinessForSite(draft, site);
  let searchLabel = 'Ready to search';
  try {
    validateProfile(Object.fromEntries(['maxRent', 'minSize', 'preferredApartmentType', 'moveInFrom'].map(key => [key, draft[key]])));
  } catch { searchLabel = 'Review search preferences'; }
  const picker = element('select', {id: 'profile-readiness-location', 'aria-label': 'Application requirements for location'},
    ...SUPPORTED_SITES.map(location => element('option', {value: location.id}, location.name)));
  picker.value = site.id;
  picker.addEventListener('change', () => { readinessLocationId = picker.value; updateProfilePresentation(); });
  const card = element('div', {class: 'profile-readiness'},
    element('strong', {class: 'profile-search-readiness'}, searchLabel),
    element('label', {class: 'profile-readiness-picker'}, 'Application details for', picker));
  const status = readiness.ready ? 'Known details complete' : `${readiness.missingFields.length} ${readiness.missingFields.length === 1 ? 'detail' : 'details'} needed`;
  const details = element('details', {class: 'missing-profile-fields'},
    element('summary', {}, element('span', {id: 'application-readiness', role: 'status'}, status)));
  details.open = expanded;
  if (readiness.ready) details.append(element('p', {class: 'helper'}, 'Live forms may request additional details. Agreements and final submission remain manual.'));
  else details.append(element('div', {class: 'missing-field-links'}, ...readiness.missingFields.map(({key, label}) =>
    element('button', {type: 'button', class: 'text-button', 'data-field': key, onclick: () => focusProfileField(key)}, `${label} →`))));
  card.append(details);
  list.replaceChildren(card);
  if (pickerFocused) picker.focus({preventScroll: true});
  if (focusedKey) list.querySelector(`[data-field="${focusedKey}"]`)?.focus({preventScroll: true});
}

chrome.tabs.getCurrent().then(tab => { $("#expand").hidden = Boolean(tab); }).catch(() => {});

$("#copy-diagnostics").addEventListener("click", copyDiagnostics);
$("#download-diagnostics").addEventListener("click", downloadDiagnostics);
window.addEventListener("error", event => {
  const error = event.error || event.message;
  rememberError("dashboard-script", error);
  toast(`Unexpected dashboard error: ${diagnosticText(error?.message || error)}`, true);
});
window.addEventListener("unhandledrejection", event => {
  rememberError("dashboard-promise", event.reason);
  toast(`Dashboard action failed: ${diagnosticText(event.reason?.message || event.reason)}`, true);
});

$('#check-all-buildings').addEventListener('click', guard(async () => {
  $('#check-all-buildings').disabled = true;
  try { await request({type: 'check-all', ids: value.monitors.filter(monitor => checkBuildingIds.has(monitor.id)).map(monitor => monitor.id)}); } finally { await loadState(); }
}));
$('#cancel-all-checks').addEventListener('click', guard(async () => {
  $('#cancel-all-checks').disabled = true;
  $('#cancel-all-checks').textContent = 'Cancelling…';
  try { await request({type: 'cancel-all-checks'}); } finally { $('#cancel-all-checks').disabled = false; $('#cancel-all-checks').textContent = 'Cancel checks'; await loadState(); }
}));

$('#monitor-selected-buildings').addEventListener('click', guard(async () => {
  const included = value.monitors.filter(monitor => checkBuildingIds.has(monitor.id));
  if (!included.length || changingSelectedMonitoring) return;
  const enabled = !included.every(monitor => monitoringScope(monitor, value.searches).general);
  changingSelectedMonitoring = true;
  render();
  try { await request({type: 'set-buildings-monitoring', ids: included.map(monitor => monitor.id), enabled}); }
  finally { changingSelectedMonitoring = false; await loadState(); }
}));
