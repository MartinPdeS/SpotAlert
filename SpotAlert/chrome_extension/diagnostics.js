import {APPLICATION_BUILD, applicationReport} from './application-diagnostics.js';

export function diagnosticText(value) {
  return String(value || '').replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    try { return new URL(raw).origin + '/[path omitted]'; } catch { return '[URL omitted]'; }
  }).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email omitted]')
    .replace(/\b(?:re_[\w-]+|Bearer\s+[^\s,;]+)/gi, '[credential omitted]')
    .replace(/((?:password|token|api[_ -]?key|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[omitted]').slice(0, 1500);
}

/** Deliberate allowlist: never export profiles, settings, page contents or request bodies. */
export function diagnosticReport(state = {}, recent = [], environment = {}) {
  return {
    format: 1, generatedAt: new Date().toISOString(), build: APPLICATION_BUILD,
    version: environment.version || 'unknown', browser: environment.browser || 'unknown',
    buildingChecks: state.checkBatch ? Object.fromEntries(['status', 'total', 'completed', 'failed', 'currentId', 'startedAt', 'finishedAt'].filter(key => state.checkBatch[key] !== undefined).map(key => [key, state.checkBatch[key]])) : null,
    recentErrors: recent.slice(-20).map(item => ({at: item.at, operation: diagnosticText(item.operation), message: diagnosticText(item.message)})),
    locations: (state.monitors || []).map(item => ({
      id: item.id, site: (() => { try { return new URL(item.url).hostname; } catch { return 'unknown'; } })(),
      readMethod: item.readMethod || null, readFallbackReason: diagnosticText(item.readFallbackReason), backgroundRetryAt: item.backgroundRetryAt || null,
      enabled: !!item.enabled, phase: item.phase, errorKind: item.errorKind || null,
      error: diagnosticText(item.error), consecutiveErrors: item.consecutiveErrors || 0,
      lastCheckedAt: item.lastCheckedAt || null, nextCheckAt: item.nextCheckAt || null,
      lastDurationMs: item.lastDurationMs ?? null, checks: item.checks || 0,
      recentEvents: (item.history || []).slice(0, 10).map(event => ({at: event.at, kind: event.kind})),
      application: item.application ? applicationReport(item.application) : null,
    })),
    searches: (state.searches || []).map(item => ({id: item.id, enabled: !!item.enabled,
      recentActions: (item.activity || []).slice(0, 10).map(action => ({at: action.at, channel: action.channel, status: action.status, monitorId: action.monitorId})),
    })),
  };
}

/** Build a bounded timeline from control metadata, never page or applicant text. */
export function diagnosticActivity(state = {}, recent = []) {
  const labels = {
    saved: 'Monitoring rule saved', started: 'Monitoring started', paused: 'Monitoring stopped',
    cancelled: 'Check cancelled', interval: 'Check interval changed', check: 'Check completed',
    error: 'Check failed', warning: 'Monitoring needs attention',
  };
  const applicationLabels = {
    started: 'Application started', stopped: 'Application stopped',
    'page-inspected': 'Application page inspected', 'booking-retry': 'Booking retried',
    'booking-retry-result': 'Booking retry completed', 'booking-advanced': 'Booking advanced',
    'date-selected': 'Move-in date selected', 'booking-click-result': 'Booking action completed',
    'navigation-interrupted-script': 'Application navigation interrupted',
  };
  const events = [];
  const add = (at, category, location, severity, message, details = '') => {
    const time = typeof at === 'number' ? at : Date.parse(at);
    if (Number.isFinite(time) && time > 0) events.push({at: time, category, location, severity, message, details});
  };
  for (const monitor of state.monitors || []) {
    for (const event of (monitor.history || []).slice(0, 80)) {
      if (Object.hasOwn(labels, event.kind)) add(event.at, 'monitoring', monitor.id, ['error', 'warning'].includes(event.kind) ? 'attention' : 'info', labels[event.kind]);
    }
    for (const event of (monitor.application?.trace || []).slice(-80)) {
      const details = ['attempt', 'ajaxWaits', 'dateWaits', 'buttonWaits', 'dateMatches', 'visibleButtons', 'enabledButtons']
        .filter(key => Number.isFinite(event[key]) && event[key] >= 0)
        .map(key => `${key}: ${event[key]}`).join(' · ');
      if (Object.hasOwn(applicationLabels, event.event)) add(event.at, 'application', monitor.id, event.event === 'stopped' || event.event === 'navigation-interrupted-script' ? 'attention' : 'info', applicationLabels[event.event], details);
    }
  }
  const actionLabels = {queued: 'Search action queued', running: 'Search action running', sent: 'Search action sent', review: 'Search action needs review', failed: 'Search action failed', interrupted: 'Search action interrupted', cancelled: 'Search action cancelled'};
  for (const search of state.searches || []) {
    for (const action of (search.activity || []).slice(0, 80)) {
      if (Object.hasOwn(actionLabels, action.status)) add(action.at, 'search', action.monitorId || '', ['failed', 'review', 'interrupted'].includes(action.status) ? 'attention' : 'info', actionLabels[action.status]);
    }
  }
  for (const error of recent.slice(-20)) add(error.at, 'dashboard', '', 'attention', 'Dashboard error recorded');
  return events.sort((a, b) => b.at - a.at).slice(0, 100);
}
