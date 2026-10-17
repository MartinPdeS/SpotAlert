import {searchClaimKey} from "./searches.js";
import {profileCompleteness} from "./profile.js";

/** Presentation calculations shared by the side panel and workspace. */
export const UI_KEY = "spotalert.ui.v1";

export function applicationReadiness(profile = {}) {
  const fields = {firstName: "first name", lastName: "last name", email: "email", phone: "phone"};
  const missing = Object.entries(fields).filter(([key]) => !String(profile[key] || "").trim() || (key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile[key]))).map(([, label]) => label);
  return {ready: !missing.length, missing};
}

export function freshness(monitor, now = Date.now()) {
  if (!Number.isFinite(monitor.lastCheckedAt) || !monitor.lastCheckedAt) return {stale: false, text: "Not checked", title: "No successful availability check yet."};
  const seconds = Math.max(0, Math.floor((now - monitor.lastCheckedAt) / 1000));
  const stale = seconds > Math.max(60, (monitor.intervalSeconds || 300) * 3);
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
  return {stale, text: `${stale ? "Stale · " : "Checked "}${age} ago`, title: `${stale ? "Results may be out of date. " : ""}Last successful check: ${new Date(monitor.lastCheckedAt).toLocaleString()}`};
}

export function availabilityTotals(monitors = []) {
  let apartments = 0;
  let unknownCounts = 0;
  for (const monitor of monitors) {
    const seen = new Set();
    for (const sample of monitor.samples || []) {
      if (!sample.matched || sample.included === false) continue;
      const key = sample.id || sample.floorplanId || sample.name || sample.index;
      if (key !== undefined && seen.has(key)) continue;
      seen.add(key);
      if (Number.isInteger(sample.availableCount) && sample.availableCount > 0) apartments += sample.availableCount;
      else { apartments++; unknownCounts++; }
    }
  }
  return {websites: monitors.filter(monitor => monitor.available === true).length, apartments, unknownCounts};
}

/** Concrete recovery tasks for the attention list, without triggering actions. */
export function attentionItems(state, library) {
  const items = [];
  const profiles = library.profiles || [];
  const latestActions = new Map();
  const seenActions = new Set();
  for (const search of state.searches || []) for (const record of search.activity || []) {
    const key = searchClaimKey(search.profileId, record.monitorId, record.listingId, record.channel);
    if (!latestActions.has(key) || (record.at || 0) > (latestActions.get(key).at || 0)) latestActions.set(key, record);
  }
  for (const monitor of state.monitors || []) if (monitor.error) items.push({
    id: `location:${monitor.id}`, title: monitor.name, message: cleanError(monitor.name, monitor.url, monitor.error),
    action: 'location', monitorId: monitor.id, label: 'Review location',
  });
  const missingProfiles = new Set();
  for (const search of state.searches || []) {
    const profile = profiles.find(entry => entry.id === search.profileId);
    if (search.enabled && search.actions.autoApply && profile && !missingProfiles.has(profile.id)) {
      const missing = profileCompleteness(profile.details).missingFields;
      if (missing.length) {
        items.push({id: `profile:${profile.id}`, title: profile.name, message: `${missing.length} applicant details still needed.`, action: 'profile', profileId: profile.id, field: missing[0].key, label: 'Complete profile'});
        missingProfiles.add(profile.id);
      }
    }
    if (search.error) items.push({id: `search:${search.id}`, title: search.name, message: search.error, action: profile ? 'search' : 'edit-search', searchId: search.id, label: profile ? 'Review search' : 'Choose a profile'});
    for (const record of search.activity || []) if (['review', 'failed', 'interrupted'].includes(record.status)) {
      const key = searchClaimKey(search.profileId, record.monitorId, record.listingId, record.channel);
      const claim = state.searchClaims?.[key];
      const claimId = typeof claim === 'string' ? claim : claim?.id;
      if (seenActions.has(key) || latestActions.get(key).id !== record.id || (claimId && claimId !== record.id)) continue;
      seenActions.add(key);
      items.push({
        id: `action:${record.id}`, title: `${search.name} · ${record.listingName || 'Apartment'}`, message: record.message || 'Review the previous attempt.',
        action: record.tabId ? 'application' : 'search', tabId: record.tabId, searchId: search.id, profileId: search.profileId,
        section: 'search-activity', channel: record.channel,
        label: record.tabId ? 'Open application' : record.channel === 'email' ? 'Review email failure' : 'Review application',
      });
    }
  }
  return items;
}

/** The location name is already visible beside an error in the workspace. */
export function cleanError(name, url, message) {
  try {
    const prefix = `${name} (${new URL(url).hostname}): `;
    return String(message).startsWith(prefix) ? String(message).slice(prefix.length) : String(message);
  } catch { return String(message); }
}

/** One entry per attempt, with earlier attempts retained under their current record. */
export function mergeActionHistory(records = [], activity = []) {
  const recorded = new Set(records.flatMap(record => [record.id, ...(record.previousAttempts || []).map(item => item.id)]));
  const timeline = [...records];
  for (const item of activity) if (!recorded.has(item.id)) { recorded.add(item.id); timeline.push(item); }
  return timeline.sort((a, b) => (b.at || 0) - (a.at || 0));
}


export function resultStatus(monitor = {}, result = undefined, now = Date.now()) {
  if (['queued', 'refreshing', 'reading', 'capturing'].includes(monitor.phase)) return {kind: 'checking', label: 'Checking…', historical: true};
  if (monitor.error) return {kind: 'failed', label: 'Check failed', historical: true};
  const at = result === null ? null : result ? result.at : monitor.lastCheckedAt;
  if (!at) return {kind: 'unchecked', label: 'Not checked yet', historical: true};
  if (now - at > Math.max(60000, (monitor.intervalSeconds || 300) * 3000)) return {kind: 'outdated', label: 'Results outdated', historical: true};
  const count = result ? result.matches.filter(item => item.matched).length : (monitor.samples || []).filter(item => item.matched && item.included !== false).length;
  return {kind: 'current', label: count ? `${count} ${result ? 'match' : 'available floor plan'}${count === 1 ? '' : 's'}` : result ? 'No matches' : 'No availability', historical: false};
}

export function monitoringScope(monitor, searches = []) {
  return {general: !!monitor.enabled && !monitor.searchManaged, searches: searches.filter(search => search.enabled && search.locationIds.includes(monitor.id))};
}

export function errorRecovery(kind) {
  return ({verification: 'Open the website, complete verification, then retry the check.', login: 'Open the website, sign in, then retry the check.', permission: 'Review website access, save the monitor to grant access, then retry.', selector: 'Open the website and review its availability rule before retrying.', navigation: 'Open the affected tab and return to the saved floor-plan page, then retry.', loading: 'Open the website to confirm it loads, then retry the check.'})[kind] || 'Open the affected tab to inspect the page, then retry. Copy diagnostics if it fails again.';
}
