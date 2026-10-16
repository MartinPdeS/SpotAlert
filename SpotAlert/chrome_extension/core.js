import {preferenceMatch} from "./preferences.js";
/** Shared, browser-independent rule validation and evaluation. */
import {SUPPORTED_SITES} from './sites/index.js';
export {SUPPORTED_SITES} from './sites/index.js';
export const DEFAULT_URL = SUPPORTED_SITES[0].url;
export const OURDOMAIN = new URL(DEFAULT_URL).origin;
export function supportedSite(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return SUPPORTED_SITES.find((site) => site.url === parsed.href) || null;
}
export function validateSupportedMonitor(input) {
  const config = validateMonitor(input);
  const site = supportedSite(config.url);
  if (!site) throw new Error("This website is not in the supported website list.");
  return {...config, name: site.name};
}
export const STORAGE_KEY = "spotalert.monitors.v2";
export const ALARM_PREFIX = "spotalert:";
export const normalize = (value) => String(value).replace(/\s+/g, " ").trim().toLowerCase();

export function sitePattern(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Use an HTTP or HTTPS page URL without embedded credentials.");
  }
  // Chrome host match patterns apply to all ports on the same hostname.
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export function validateMonitor(input) {
  if (!input || typeof input !== "object") throw new Error("Invalid monitor configuration.");
  sitePattern(input.url);
  const parsed = new URL(input.url);
  parsed.hash = "";
  const name = String(input.name || "").trim();
  if (!name || name.length > 100) throw new Error("Give the monitor a name (up to 100 characters).");
  const interval = Number(input.intervalSeconds);
  if (!Number.isFinite(interval) || interval < 5 || interval > 86400) {
    throw new Error("Choose a refresh interval between 5 seconds and 24 hours.");
  }
  const rule = input.rule;
  if (!rule || !["css", "text"].includes(rule.type)) throw new Error("Choose a CSS or page-text rule.");
  if (!["contains", "equals", "not_equals"].includes(rule.mode)) throw new Error("Choose a supported match rule.");
  const selector = rule.type === "css" ? String(rule.selector || "").trim() : "body";
  if (!selector || selector.length > 1000) throw new Error("Enter a CSS selector (up to 1,000 characters).");
  const expected = String(rule.expected || "").trim();
  if (!expected || expected.length > 500) throw new Error("Enter the expected text (up to 500 characters).");
  const filters = input.filters || {};
  const types = filters.types || [];
  const floorplans = filters.floorplans || [];
  if (!Array.isArray(types) || types.some((type) => !["studio", "1-bedroom", "2-bedroom", "3-plus"].includes(type))) throw new Error("Choose supported apartment types.");
  if (!Array.isArray(floorplans) || floorplans.length > 100 || floorplans.some((id) => typeof id !== "string" || id.length > 300)) throw new Error("Choose up to 100 floor plans.");
  const hours = input.hours || {};
  const timeZone = hours.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat("en", {timeZone}); } catch { throw new Error("Choose a valid monitoring timezone."); }
  const start = hours.start || "08:00", end = hours.end || "22:00";
  if (![start, end].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || (hours.enabled && start === end)) throw new Error("Choose different, valid monitoring start and end times.");
  return {
    name, url: parsed.href, intervalSeconds: interval,
    filters: {types: [...new Set(types)], floorplans: [...new Set(floorplans)]},
    hours: {enabled: Boolean(hours.enabled), start, end, timeZone},
    sound: Boolean(input.sound),
    rule: {type: rule.type, selector, mode: rule.mode, expected},
    notify: input.notify !== false,
  };
}

export function evaluateRule(samples, rule, filters = {}) {
  if (!Array.isArray(samples) || !samples.length) throw new Error("No elements matched. Check the selector, login, or verification prompt.");
  const expected = normalize(rule.expected);
  const matches = samples.map((sample) => {
    const value = normalize(sample.text);
    if (!value) throw new Error("A matching element is empty. The page may still be loading.");
    const matched = rule.mode === "contains" ? value.includes(expected)
      : rule.mode === "equals" ? value === expected : value !== expected;
    const type = apartmentType(sample);
    const id = listingKey(sample);
    const preference = preferenceMatch({...sample, apartmentType: type}, filters.clientPreferences);
    const included = preference.included && (!(filters.types || []).length || filters.types.includes(type))
      && (!(filters.floorplans || []).length || filters.floorplans.includes(id));
    return {...sample, id, apartmentType: type, included, preferenceReasons: preference.reasons, ruleMatched: matched, matched: matched && included};
  });
  return {available: matches.some((sample) => sample.matched), matches};
}

export function defaultMonitor(id = "ourdomain-amsterdam-diemen") {
  const site = SUPPORTED_SITES.find((site) => site.id === id) || SUPPORTED_SITES[0];
  return {
    ...validateMonitor({name: site.name, url: site.url, intervalSeconds: 300,
      rule: site.rule, notify: true}),
    id, enabled: false, phase: "paused", available: null, checks: 0,
    lastCheckedAt: null, nextCheckAt: null, lastDurationMs: null,
    samples: [], history: [], error: null, errorKind: null, consecutiveErrors: 0, tabId: null,
    snoozedUntil: null, pendingArrivals: [], alert: null,
  };
}

/** Alert events survive worker suspension; panel updates never reconstruct alerts. */
export function availabilityArrivals(previous = [], current = []) {
  return current.filter((monitor) => {
    const before = previous.find((item) => item.id === monitor.id);
    if (Object.prototype.hasOwnProperty.call(monitor, "alert")) return Boolean(monitor.alert) && monitor.alert.id !== before?.alert?.id && (monitor.alert.test || monitor.notify);
    // Compatibility for states saved before per-listing alerts existed.
    return monitor.notify && monitor.available === true && before?.available !== true
      && monitor.checks > (before?.checks || 0);
  });
}

export function siteError(monitor, error) {
  let host;
  try { host = new URL(monitor.url).hostname; } catch { host = monitor.url || "Unknown website"; }
  const prefix = `${monitor.name || "Website"} (${host}): `;
  const message = String(error?.message || error);
  return message.startsWith(prefix) ? message : prefix + message;
}

export function listingKey(sample) {
  return String(sample.id || sample.floorplanId || normalize(sample.name || sample.context) || `element:${sample.index}`).slice(0, 300);
}
export function apartmentType(sample) {
  const beds = normalize(sample.beds || "");
  const name = normalize(sample.name || "");
  if (beds === "studio" || (!beds && /studio/.test(name))) return "studio";
  const number = Number.parseInt(beds || name.match(/(\d+)\s*bed(?:room)?/)?.[1], 10);
  return number === 1 ? "1-bedroom" : number === 2 ? "2-bedroom" : number >= 3 ? "3-plus" : "unknown";
}
export function newListings(previous, current) {
  const before = new Map(previous.filter((sample) => sample.matched).map((sample) => [listingKey(sample), sample]));
  const legacyNames = new Set(previous.filter((sample) => sample.matched && !sample.id && sample.name).map((sample) => normalize(sample.name)));
  return current.filter((sample) => {
    if (!sample.matched) return false;
    const old = before.get(listingKey(sample));
    if (!old) return !legacyNames.has(normalize(sample.name || ""));
    return Number.isFinite(sample.availableCount) && Number.isFinite(old.availableCount) && sample.availableCount > old.availableCount;
  }).map((sample) => ({...sample, arrivalBaselineCount: before.get(listingKey(sample))?.availableCount ?? null}));
}
export function safeListingUrl(candidate, pageUrl) {
  if (!candidate) return null;
  try {
    const url = new URL(candidate, pageUrl), page = new URL(pageUrl);
    return url.origin === page.origin && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function inMonitoringHours(timestamp, hours) {
  if (!hours?.enabled) return true;
  const parts = new Intl.DateTimeFormat("en-GB", {timeZone: hours.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(new Date(timestamp));
  const time = `${parts.find((part) => part.type === "hour").value}:${parts.find((part) => part.type === "minute").value}`;
  return hours.start < hours.end ? time >= hours.start && time < hours.end : time >= hours.start || time < hours.end;
}
export function nextMonitoringTime(timestamp, hours) {
  if (inMonitoringHours(timestamp, hours)) return timestamp;
  // Test real instants in the selected timezone, including DST transitions.
  let next = Math.ceil(timestamp / 60000) * 60000;
  for (let minute = 0; minute < 2880; minute++, next += 60000) if (inMonitoringHours(next, hours)) return next;
  throw new Error("Could not schedule the next monitoring window.");
}
export function retrySeconds(monitor) {
  if (!monitor.consecutiveErrors) return monitor.intervalSeconds;
  const base = Math.max(monitor.intervalSeconds, ["verification", "login"].includes(monitor.errorKind) ? 60 : 30);
  return Math.min(Math.max(900, monitor.intervalSeconds), base * 2 ** Math.min(monitor.consecutiveErrors - 1, 10));
}
export function errorKind(error) {
  if (error.kind) return error.kind;
  const message = String(error.message || error).toLowerCase();
  if (/verification|just a moment|captcha/.test(message)) return "verification";
  if (/login|sign in/.test(message)) return "login";
  if (/timed out|still be loading|no readable/.test(message)) return "loading";
  if (/selector|no elements/.test(message)) return "selector";
  if (/access|permission/.test(message)) return "permission";
  if (/navigated/.test(message)) return "navigation";
  return "unknown";
}

export function samePage(candidate, expected) {
  try {
    const first = new URL(candidate), second = new URL(expected);
    first.hash = second.hash = "";
    return first.href === second.href;
  } catch { return false; }
}
