export const APPLICATION_BUILD = '2026.10.12.3';

/** Only application-control metadata: no profile, page content or tracked URLs. */
export function applicationReport(application = {}) {
  return {
    format: 1,
    build: application.build || 'older version',
    status: application.status || 'unknown',
    kind: application.kind || null,
    updatedAt: application.updatedAt || null,
    trace: (application.trace || []).slice(-80).map(item => Object.fromEntries(
      ['at', 'event', 'path', 'step', 'kind', 'date', 'started', 'attempt', 'ajaxWaits', 'dateWaits', 'buttonWaits', 'dateMatches', 'visibleButtons', 'enabledButtons'].filter(key => item[key] !== undefined).map(key => [key, key === 'path' ? String(item[key]).split('?')[0] : item[key]])
    )),
  };
}
