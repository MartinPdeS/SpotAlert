import {clientQuestionnaire, parseClientReply, CLIENT_FIELDS} from "./clients.js";
import {STORAGE_KEY, availabilityArrivals, siteError, listingKey, safeListingUrl, sitePattern, validateMonitor} from "./core.js";

import {UI_KEY, freshness, availabilityTotals} from "./ui.js";
import {PROFILE_KEY, PROFILES_KEY, PROFILE_FIELDS, PROFILE_SECTIONS, profileCompleteness, temporaryRegistrationDetails} from "./profile.js";

const $ = (selector) => document.querySelector(selector);
let value = {monitors: []};
let selectedId = null;
let showAllSamples = false;
let historyFilter = "all";
let listingFilter = "all";
let technicalOpen = false;
let toastTimer;
let loadingState = false;
const availabilityQueue = [];
let activeAvailability = null;
let reloadState = false;
let personalProfile = {};
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
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "SpotAlert could not connect to its background worker. Reload the extension.");
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
        $("#notification-phone").value = preferences[CONTACT_KEY]?.phone || "";
        $("#notification-email").value = preferences[CONTACT_KEY]?.email || "";
        $("#client-reply-to").value = preferences[CONTACT_KEY]?.email || "";
        $("#email-enabled").checked = Boolean(preferences[EMAIL_KEY]?.enabled);
        $("#email-api-key").value = preferences[EMAIL_KEY]?.apiKey || "";
        $("#email-sender").value = preferences[EMAIL_KEY]?.sender || "onboarding@resend.dev";
        contactsLoaded = true;
      }
      if (!value.monitors.some((monitor) => monitor.id === selectedId)) selectedId = value.monitors[0]?.id || null;
      render();
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
  const readiness = profileCompleteness(personalProfile);
  $("#application-readiness").textContent = readiness.ready ? "Application details ready" : `${readiness.complete}/${readiness.total} details prepared`;
  $("#application-readiness").classList.toggle("available", readiness.ready);
  $("#readiness-description").textContent = readiness.ready ? "Canvas applicant details prepared. Review the website form and agreements before submitting." : `Still needed: ${readiness.missing.slice(0, 6).join(", ")}${readiness.missing.length > 6 ? `, and ${readiness.missing.length - 6} more` : ""}. Based on the current Canvas form; employment and optional fields may also apply.`;
  renderDebug();
  renderNotifications();
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
  if (monitor.application?.missingFields?.length || monitor.application?.structure) {
    const app = monitor.application;
    const card = element("section", {class: "application-progress", role: "status"}, element("h4", {}, app.missingFields?.length ? "Missing application details" : "Unfamiliar application form"), element("p", {}, app.message));
    const actions = element("div", {class: "control-row"}, element("button", {class: "secondary-button", onclick: guard(() => request({type: "open-application-tab", id: monitor.id}))}, "Open application tab ↗"));
    if (app.missingFields?.length) {
      const list = element("ul", {class: "application-missing"});
      for (const field of app.missingFields) list.append(element("li", {}, element("strong", {}, field.label), element("span", {}, field.reason === "invalid" ? "Needs correction" : "Required")));
      card.append(list, element("p", {class: "helper"}, "Update saved details below, or complete fields directly on the website. Continue directly on the website."));
      actions.append(element("button", {class: "secondary-button", onclick: () => {
        $("#personal-tab").click();
        document.querySelectorAll(".profile-group").forEach(group => { group.open = true; });
        $("#personal-view").scrollIntoView({behavior: "smooth"});
      }}, "Edit personal information"));
    }
    if (app.structure) {
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
    card.append(actions);
    root.append(card);
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
      `Case insensitive · Every ${interval(monitor.intervalSeconds)} · ${monitor.notify ? "Notifications on" : "Notifications off"}`)),
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
  $("#notify").checked = monitor?.notify !== false;
  $("#alert-sound").checked = Boolean(monitor?.sound);
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
      intervalSeconds: $("#interval").value, notify: $("#notify").checked, sound: $("#alert-sound").checked,
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
    const result = await request({type: "open-listing", id: monitor.id, listingId: listingKey(sample)});
    if (result.moveInMessage) toast(result.moveInMessage);
  })}, "Apply ↗");
  button.disabled = monitor.application?.status === "running";
  return button;
}
$("#editor-test-alert").addEventListener("click", guard(async () => {
  const button = $("#editor-test-alert");
  button.disabled = true;
  try {
    const result = await request({type: "test-alert", id: $("#monitor-id").value, sound: $("#alert-sound").checked});
    if (result.errors?.length) toast(result.errors.join(" "), true);
  } finally { button.disabled = false; }
}));
function showNextAvailability() {
  if (activeAvailability || !availabilityQueue.length) return;
  activeAvailability = availabilityQueue.shift();
  $("#availability-site").textContent = activeAvailability.name;
  $("#availability-title").textContent = activeAvailability.alert?.test ? "Test notification" : "New availability";
  const listings = activeAvailability.alert?.listings || activeAvailability.samples.filter((sample) => sample.matched);
  const test = activeAvailability.alert?.test;
  $("#availability-listings").replaceChildren(...listings.map((sample) =>
    element("div", {class: "availability-listing"}, element("strong", {}, sample.name || sample.text),
      sample.name && element("p", {}, sample.text),
      sample.context && element("p", {class: "muted"}, sample.context), !test && listingButton(activeAvailability, sample))));
  $("#availability-popup").showModal();
}
$("#availability-popup").addEventListener("close", () => {
  activeAvailability = null;
  showNextAvailability();
});
$("#dismiss-availability").addEventListener("click", () => $("#availability-popup").close());
$("#open-availability").addEventListener("click", guard(async () => {
  const monitor = activeAvailability;
  if (!monitor) return;
  const listing = monitor.alert?.listings?.[0];
  await request(listing && !monitor.alert.test ? {type: "open-listing", id: monitor.id, listingId: listingKey(listing)} : {type: "open", id: monitor.id});
  selectedId = monitor.id;
  render();
  $("#availability-popup").close();
}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[PROFILE_KEY] || changes[PROFILES_KEY] || changes[UI_KEY])) loadState().catch(error => toast(error.message, true));
  if (area === "local" && changes[STORAGE_KEY]) {
    const change = changes[STORAGE_KEY];
    availabilityQueue.push(...availabilityArrivals(change.oldValue?.monitors, change.newValue?.monitors).filter(m => m.alert?.test || change.newValue?.alertPreferences?.popup !== false));
    showNextAvailability();
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
  let filled = 0;
  for (const group of document.querySelectorAll(".profile-group")) {
    const keys = group.dataset.fields.split(",");
    const count = keys.filter(key => $(`#personal-${key}`).value.trim()).length;
    filled += count;
    group.querySelector(".profile-section-count").textContent = `${count}/${keys.length}`;
  }
  $("#profile-section-progress").textContent = `${filled} details added`;
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
$("#personal-form").addEventListener("input", event => { if (event.target.id !== "saved-profile") personalDirty = true; updateProfilePresentation(); });
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
$("#fill-application").addEventListener("click", guard(async () => {
  if (personalDirty) { toast("Save your changes before filling an application.", true); return; }
  const button = $("#fill-application");
  button.disabled = true;
  try {
    const result = await request({type: "fill-application"});
    toast(result.moveInMessage || (result.count ? `Filled ${result.count} ${result.count === 1 ? "field" : "fields"}. Review the form before submitting.` : "No empty matching fields found. Open the application form and try again."));
  } finally { button.disabled = false; }
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

const workspaceTabs = ["monitoring", "notifications", "personal", "clients"];
function switchTab(name) {
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
function renderNotifications() {
  const root = $("#notification-sites");
  if (root.contains(document.activeElement)) return;
  const prefs = value.alertPreferences || {notify: true, sound: false};
  const notify = element("input", {type: "checkbox", "aria-label": "Pop-up alerts for all locations"});
  notify.checked = prefs.popup ?? prefs.notify;
  notify.setAttribute("role", "switch");
  const sound = element("input", {type: "checkbox", "aria-label": "Sound for all locations"});
  sound.checked = Boolean(prefs.sound);
  sound.setAttribute("role", "switch");
  const desktop = element("input", {type: "checkbox", role: "switch", "aria-label": "Desktop alerts for all locations"});
  desktop.checked = prefs.desktop ?? prefs.notify;
  const save = guard(async () => {
    await request({type: "set-alerts", notify: notify.checked || desktop.checked || sound.checked, popup: notify.checked, desktop: desktop.checked, sound: sound.checked});
    await loadState();
  });
  notify.addEventListener("change", save);
  sound.addEventListener("change", save);
  desktop.addEventListener("change", save);
  const monitor = value.monitors[0];
  const heading = (icon, title, caption, control) => element("div", {class: "channel-heading"},
    element("span", {class: "channel-icon", "aria-hidden": "true"}, icon),
    element("div", {}, element("h3", {}, title), element("span", {class: "channel-caption"}, caption)), control);
  const toggle = input => element("label", {class: "channel-switch"}, input, element("span"));
  root.replaceChildren(
    element("section", {class: "notification-card", "aria-label": "Pop-up notifications"},
      heading("▣", "Pop-up", "See availability as it happens", toggle(notify)),
      element("p", {class: "helper"}, "Apartment details and a direct link, inside SpotAlert and on your monitored website pages."),
      element("p", {class: "channel-footnote"}, "Appears only for real availability on website pages")),
    element("section", {class: "notification-card", "aria-label": "Desktop notifications"},
      heading("◇", "Desktop", "Stay informed with the panel closed", toggle(desktop)),
      element("p", {class: "helper"}, "Chrome shows a notification even when you’re browsing another tab."),
      element("p", {class: "channel-footnote"}, "Independent of pop-ups · Chrome must be running")),
    element("section", {class: "notification-card", "aria-label": "Sound notifications"},
      heading("♫", "Sound", "An audible heads-up", toggle(sound)),
      element("p", {class: "helper"}, "A short chime accompanies new availability."),
      element("p", {class: "channel-footnote"}, "Independent of pop-up and desktop alerts")),
    element("div", {class: "alert-controls notification-shared-controls"}, element("span", {class: "channel-footnote"}, "Want to hear and see an example?"), monitor && actionButton("Test notification", "test-alert", monitor)));

}
async function saveNotificationSettings() {
  if ($("#email-enabled").checked && (!$("#notification-email").value.trim() || !$("#email-api-key").value.trim())) throw new Error("Enter an email destination and Resend API key first.");
  await chrome.storage.local.set({[EMAIL_KEY]: {enabled: $("#email-enabled").checked, apiKey: $("#email-api-key").value.trim(), sender: $("#email-sender").value.trim() || "onboarding@resend.dev"}, [CONTACT_KEY]: {
    phone: $("#notification-phone").value.trim(), email: $("#notification-email").value.trim(),
  }});
  $("#notification-save-status").textContent = "Settings saved";
}
$("#notification-contact-form").addEventListener("submit", guard(async event => {
  event.preventDefault();
  await saveNotificationSettings();
  toast("Notification settings saved.");
}));
$("#email-enabled").addEventListener("change", guard(async () => {
  const toggle = $("#email-enabled");
  const enabled = toggle.checked;
  toggle.disabled = true;
  try { await saveNotificationSettings(); }
  catch (error) { toggle.checked = !enabled; throw error; }
  finally { toggle.disabled = false; }
}));

$("#test-email").addEventListener("click", guard(async () => {
  const button = $("#test-email");
  button.disabled = true;
  try { await request({type: "test-email"}); toast("Test email sent. Check your inbox and spam folder."); }
  finally { button.disabled = false; }
}));

$("#notification-contact-form").addEventListener("input", () => {
  $("#notification-save-status").textContent = "Unsaved changes";
});

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
