/**
 * Shared runtime and persisted-state vocabulary. These types describe serializable
 * data; runtime validators remain authoritative at the extension boundary.
 *
 * @typedef {'paused'|'waiting'|'waiting-hours'|'queued'|'refreshing'|'reading'|'capturing'|'error'} MonitorPhase
 * @typedef {'queued'|'running'|'sent'|'review'|'failed'|'interrupted'|'cancelled'|'recorded'} ActionStatus
 * @typedef {'current'|'checking'|'unchecked'|'failed'|'outdated'} ResultKind
 * @typedef {Object} SearchActions
 * @property {boolean} email
 * @property {boolean} autoApply
 * @property {boolean} [sms]
 *
 * @typedef {Object} SearchConfig
 * @property {string} [id]
 * @property {string} name
 * @property {string} profileId
 * @property {string[]} locationIds
 * @property {number} [intervalSeconds]
 * @property {SearchActions} actions
 * @property {boolean} [createAccount]
 *
 * @typedef {Object} Listing
 * @property {string} [id]
 * @property {string} [floorplanId]
 * @property {number} [index]
 * @property {boolean} [matched]
 * @property {string} [name]
 * @property {string} [applicationUrl]
 *
 * @typedef {{at: number, matches: Listing[]}} SearchResult
 * @typedef {{kind: ResultKind, label: string, historical: boolean}} ResultStatus
 *
 * @typedef {Object} ActionRecord
 * @property {string} id
 * @property {'email'|'autoApply'} channel
 * @property {ActionStatus} status
 * @property {number|null} at
 * @property {string} [monitorId]
 * @property {string} [listingId]
 * @property {string} [message]
 * @property {number} [tabId]
 * @property {ActionRecord[]} [previousAttempts]
 *
 * @typedef {Object} Monitor
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {boolean} enabled
 * @property {MonitorPhase} phase
 * @property {Listing[]} samples
 * @property {number|null} lastCheckedAt
 * @property {string|null} error
 *
 * @typedef {SearchConfig & {
 *   id: string, enabled: boolean, generation: string,
 *   results: Object<string, SearchResult>, activity: ActionRecord[]
 * }} SavedSearch
 *
 * @typedef {Object} EngineState
 * @property {number} version
 * @property {Monitor[]} monitors
 * @property {SavedSearch[]} [searches]
 * @property {Object<string, ActionRecord|string>} [searchClaims]
 *
 * @typedef {Object} RuntimeCommand
 * @property {CommandType} type
 * @property {string} [dashboardBuild]
 * @property {string} [id]
 * @property {string[]} [ids]
 * @property {boolean} [enabled]
 * @property {number|string} [intervalSeconds]
 * @property {SearchConfig} [search]
 * @property {SearchActions} [actions]
 * @property {Object<string, string>} [profile]
 * @property {Object} [monitor]
 * @property {string} [listingId]
 * @property {string} [monitorId]
 * @property {string} [profileId]
 * @property {number} [tabId]
 * @property {boolean} [createAccount]
 * @property {boolean} [signatureConsent]
 * @property {boolean} [screening]
 * @property {string} [expectedGeneration]
 * @property {boolean} [confirmed]
 * @property {string} [channel]
 * @property {string} [captureId]
 * @property {string} [name]
 * @property {string} [to]
 * @property {string} [replyTo]
 * @property {string} [reply]
 */

export const COMMAND_TYPES = /** @type {const} */ ([
  'search-readiness', 'repeat-search-action', 'save-search', 'set-search-enabled',
  'set-search-interval', 'delete-search', 'set-alerts', 'test-alert', 'snooze',
  'snooze-all', 'retry-delivery', 'set-debug', 'clear-debug', 'open-debug', 'profile',
  'assign-profile', 'profiles', 'profile-folder-status', 'enable-profile-folder',
  'open-profile-folder', 'create-test-profiles', 'create-profile', 'select-profile',
  'save-profile', 'clear-profile', 'prepare-canvas-signature', 'prepare-application',
  'fill-application', 'send-client-questionnaire', 'import-client-profile',
  'test-email', 'engine-info', 'open-application-target', 'state', 'save', 'start',
  'stop-all', 'pause', 'cancel-check', 'set-buildings-monitoring', 'check-all',
  'cancel-all-checks', 'check', 'set-interval', 'preview', 'open', 'open-affected',
  'open-listing', 'continue-application', 'open-application-tab', 'stop-application',
]);

/** @typedef {typeof COMMAND_TYPES[number]} CommandType */
const COMMANDS = new Set(COMMAND_TYPES);

export const BUILD_SENSITIVE_COMMANDS = new Set([
  'repeat-search-action', 'save-search', 'set-search-enabled',
  'set-search-interval', 'delete-search', 'prepare-application', 'fill-application',
  'prepare-canvas-signature', 'open-listing', 'continue-application',
]);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate the envelope before dispatch; domain modules validate field values. */
export function validateCommand(message) {
  if (!isRecord(message) || typeof message.type !== 'string') {
    throw new Error('Invalid SpotAlert command.');
  }
  if (!COMMANDS.has(message.type)) throw new Error('Unknown SpotAlert command.');
  for (const key of ['dashboardBuild', 'id', 'profileId', 'listingId', 'captureId', 'expectedGeneration']) {
    if (message[key] !== undefined && typeof message[key] !== 'string') {
      throw new Error(`Invalid command field: ${key}.`);
    }
  }
  for (const key of ['enabled', 'createAccount', 'signatureConsent', 'screening']) {
    if (message[key] !== undefined && typeof message[key] !== 'boolean') {
      throw new Error(message.type === 'set-buildings-monitoring' && key === 'enabled'
        ? 'Choose a valid monitoring status.' : `Invalid command field: ${key}.`);
    }
  }
  for (const key of ['search', 'profile', 'monitor', 'actions']) {
    if (message[key] !== undefined && !isRecord(message[key])) {
      throw new Error(`Invalid command field: ${key}.`);
    }
  }
  if (message.ids !== undefined && (!Array.isArray(message.ids) || message.ids.some(id => typeof id !== 'string'))) {
    throw new Error(['check-all', 'set-buildings-monitoring'].includes(message.type)
      ? 'Select at least one supported building.' : 'Invalid command field: ids.');
  }
  if (message.tabId !== undefined && (!Number.isInteger(message.tabId) || message.tabId < 0)) {
    throw new Error('Invalid command field: tabId.');
  }
  return message;
}
