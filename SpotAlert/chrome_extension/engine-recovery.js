import {SUPPORTED_SITES, defaultMonitor, validateMonitor} from "./core.js";

const UNFINISHED_ACTIONS = new Set(['queued', 'running']);
const IN_FLIGHT_CHECKS = new Set(['queued', 'refreshing', 'reading', 'capturing']);

function recoverSearchActions(value) {
  value.searches ||= [];
  value.searchClaims ||= {};
  for (const search of value.searches) {
    // Profile preferences are authoritative; retire copied search overrides.
    delete search.preferences;
    for (const item of search.activity || []) {
      if (!UNFINISHED_ACTIONS.has(item.status)) continue;
      item.status = 'interrupted';
      item.message = 'Worker restarted. Review the application tab before taking further action.';
    }
  }
  for (const [key, claim] of Object.entries(value.searchClaims)) {
    if (typeof claim === 'string') {
      const owner = value.searches.find(search => search.activity?.some(item => item.id === claim));
      const action = owner?.activity.find(item => item.id === claim);
      value.searchClaims[key] = action ? {...action, searchId: owner.id} : {
        id: claim,
        status: 'recorded',
        at: null,
        message: 'Previous action recorded; detailed history is no longer available.',
      };
    }
    const record = value.searchClaims[key];
    if (UNFINISHED_ACTIONS.has(record.status)) {
      record.status = 'interrupted';
      record.message = 'Chrome restarted. Check the prior application or delivery before authorizing another attempt.';
    }
  }
}

function recoverApplications(monitors, now) {
  for (const monitor of monitors) {
    if (monitor.application?.status !== 'running') continue;
    const timestamp = now();
    const trace = [...(monitor.application.trace || []), {
      at: timestamp,
      event: 'background-restarted',
    }].slice(-80);
    Object.assign(monitor.application, {
      status: 'stopped',
      stage: 'failed',
      kind: 'interrupted',
      message: 'The extension background worker restarted during this application. Open the application tab to check its progress.',
      updatedAt: timestamp,
      trace,
    });
  }
}

function restoreMonitor(site, previous, alertPreferences, history) {
  const existing = previous.find(monitor => monitor.id === site.id && monitor.url === site.url)
    || previous.find(monitor => monitor.url === site.url);
  const monitor = existing ? {
    ...defaultMonitor(site.id),
    ...existing,
    ...validateMonitor(existing),
    id: site.id,
    name: site.name,
  } : defaultMonitor(site.id);
  // Migrate only known shipped rules, preserving user-defined rules.
  const migration = existing && site.ruleMigrations?.find(item =>
    Object.entries(item.from).every(([key, value]) => existing.rule[key] === value));
  if (migration) {
    Object.assign(monitor, {
      rule: {...site.rule},
      available: null,
      samples: [],
      error: null,
      lastCheckedAt: null,
      lastDurationMs: null,
    });
    history(monitor, {kind: 'updated', message: migration.message});
  }
  delete monitor.profileId;
  monitor.snoozedUntil = null;
  monitor.alert = null;
  monitor.pendingArrivals = [];
  Object.assign(monitor, alertPreferences);
  return monitor;
}

/** Restore persisted state without starting browser work or releasing action claims.
 * @param {import('./contracts.js').EngineState} value
 */
export function recoverEngineState(value, now, history) {
  if (value.checkBatch?.status === 'running') {
    Object.assign(value.checkBatch, {
      status: 'interrupted', currentId: null, finishedAt: now(),
    });
  }
  recoverSearchActions(value);
  value.alertPreferences = {notify: false, popup: false, desktop: false, sound: false};
  value.debug ||= {enabled: false, captures: [], seen: {}};
  for (const capture of value.debug.captures || []) {
    if (capture.status !== 'opening') continue;
    capture.status = 'error';
    capture.error = 'Chrome restarted before capture completed.';
  }
  const previous = value.monitors || [];
  recoverApplications(previous, now);
  value.monitors = SUPPORTED_SITES.map(site =>
    restoreMonitor(site, previous, value.alertPreferences, history));
  const retained = new Set(value.monitors.map(monitor => monitor.id));
  const archived = previous.filter(monitor =>
    !retained.has(monitor.id) || !SUPPORTED_SITES.some(site => site.url === monitor.url));
  value.archivedMonitors = [
    ...(value.archivedMonitors || []),
    ...archived.map(monitor => ({
      ...monitor, enabled: false, phase: 'paused', nextCheckAt: null,
    })),
  ];
  value.initialized = true;
  for (const monitor of value.monitors) {
    if (!IN_FLIGHT_CHECKS.has(monitor.phase)) continue;
    monitor.phase = monitor.enabled ? 'waiting' : 'paused';
    history(monitor, {
      kind: 'interrupted',
      message: 'Chrome restarted the worker; the interrupted check will retry.',
    });
  }
}
