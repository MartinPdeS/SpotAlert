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
