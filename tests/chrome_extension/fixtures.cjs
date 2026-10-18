const assert = require("node:assert/strict");
const {webcrypto} = require("node:crypto");
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const modules = Promise.all([
  import("../../SpotAlert/chrome_extension/core.js"),
  import("../../SpotAlert/chrome_extension/engine.js"),
  import("../../SpotAlert/chrome_extension/page.js"),
]);

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => { for (const listener of [...listeners]) listener(...args); },
    listeners,
  };
}
function fakeChrome() {
  const data = {};
  const alarms = new Map();
  const notifications = [];
  const reloads = [];
  const api = {
    data, alarmsMap: alarms, notificationsLog: notifications, reloads,
    pageSamples: [{index: 1, text: "Get Notified", context: "Studio A"}],
    allowed: true, completeReload: true,
    storage: {local: {
      get: async (key) => Array.isArray(key) ? Object.fromEntries(key.map(item => [item, structuredClone(data[item])])) : ({[key]: structuredClone(data[key])}),
      set: async (items) => { Object.assign(data, structuredClone(items)); },
    }},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {}},
    permissions: {contains: async () => api.allowed},
    alarms: {
      create: async (name, info) => alarms.set(name, {name, ...info}),
      getAll: async () => [...alarms.values()],
      clear: async (name) => alarms.delete(name),
    },
    notifications: {create: async (id, info) => notifications.push({id, ...info})},
    runtime: {getURL: (path) => `chrome-extension://test/${path}`},
    tabs: {
      onUpdated: event(), onRemoved: event(),
      get: async (id) => ({id, url: api.url, title: "OurDomain", status: "complete"}),
      query: async () => [{id: 7, url: api.url, title: "OurDomain", status: "complete"}],
      create: async ({url}) => ({id: 8, url, status: "complete"}),
      update: async () => {},
      reload: async (id, options) => {
        reloads.push({id, ...options});
        if (api.completeReload) queueMicrotask(() => api.tabs.onUpdated.emit(id, {status: "complete"}));
      },
    },
    scripting: {executeScript: async ({func, args}) => {
      if (api.deferredRead) await api.deferredRead;
      if (api.readError) return [{result: {error: api.readError}}];
      return [{result: {url: api.url, samples: structuredClone(api.pageSamples)}}];
    }},
  };
  return api;
}
async function setup() {
  const [core, {createEngine}] = await modules;
  const api = fakeChrome();
  api.url = core.DEFAULT_URL;
  const engine = createEngine(api, () => 1000000);
  await engine.initialize();
  return {core, createEngine, api, engine, id: "ourdomain-amsterdam-diemen"};
}

async function waitForSearch(engine, predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await engine.state();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Search did not reach the expected state');
}
async function saveSearch(engine, profileId, locationId, options = {}) {
  await engine.dispatch({type: 'save-search', search: {name: 'Apartment search', profileId, locationIds: [locationId], actions: {email: true}, ...options}});
  return (await engine.state()).searches.at(-1);
}

function backgroundFixture(api, result) {
  api.offscreen = {createDocument: async () => { api.parserCreated = true; }};
  api.runtime.getContexts = async () => api.parserCreated ? [{documentUrl: api.runtime.getURL('parser.html')}] : [];
  api.runtime.sendMessage = async message => { api.parsedHtml = message.html; return {result}; };
}
function htmlResponse(url, text = '<html>listing fixture</html>', status = 200) {
  const response = new Response(text, {status, headers: {'content-type': 'text/html'}});
  Object.defineProperty(response, 'url', {value: url});
  return response;
}


module.exports = {modules, event, fakeChrome, setup, waitForSearch, saveSearch, backgroundFixture, htmlResponse};
