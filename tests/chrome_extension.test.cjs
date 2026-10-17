const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {webcrypto} = require("node:crypto");
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const modules = Promise.all([
  import("../SpotAlert/chrome_extension/core.js"),
  import("../SpotAlert/chrome_extension/engine.js"),
  import("../SpotAlert/chrome_extension/page.js"),
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

test("manifest allows optional native messaging for local profile storage", async () => {
  const manifest = JSON.parse(fs.readFileSync("SpotAlert/chrome_extension/manifest.json"));
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.deepEqual(manifest.host_permissions, ["https://thisisourdomain.securerc.co.uk/*", "https://southeast-thisisourdomain.securerc.co.uk/*", "https://api.resend.com/*", "https://canvas-world.securerc.co.uk/*", "https://www.canvas-world.com/*"]);
  assert.equal(manifest.side_panel.default_path, "panel.html");
});

test("rules normalize whitespace and reject missing or empty elements", async () => {
  const [core] = await modules;
  const rule = core.defaultMonitor().rule;
  assert.equal(core.evaluateRule([{text: " GET   NOTIFIED "}], rule).available, false);
  assert.equal(core.evaluateRule([{text: "Get Notified"}, {text: "Apply Now"}], rule).available, true);
  assert.throws(() => core.evaluateRule([], rule), /No elements/);
  assert.throws(() => core.evaluateRule([{text: "  "}], rule), /empty/);
});

test("configuration rejects restricted URLs, credentials, and overly fast schedules", async () => {
  const [core] = await modules;
  const base = core.defaultMonitor();
  assert.throws(() => core.validateMonitor({...base, url: "chrome://settings"}), /HTTP/);
  assert.throws(() => core.validateMonitor({...base, url: "https://user:secret@example.com"}), /credentials/);
  assert.throws(() => core.validateMonitor({...base, intervalSeconds: 1}), /5 seconds/);
  assert.equal(core.sitePattern("http://localhost:8080/page"), "http://localhost/*");
});

test("a check refreshes the tab, persists results, and schedules without Python", async () => {
  const {engine, api, id} = await setup();
  await engine.setEnabled(id, true);
  const monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.enabled, true);
  assert.equal(monitor.checks, 1);
  assert.equal(monitor.available, false);
  assert.equal(monitor.phase, "waiting");
  assert.equal(api.reloads[0].bypassCache, true);
  assert.equal(api.alarmsMap.get(`spotalert:${id}`).when, 1300000);
  assert.equal(monitor.nextCheckAt, 1300000);
  assert.equal(api.tabs.onUpdated.listeners.size, 0);
});

test("Monitoring observations never send desktop notifications", async () => {
  const {engine, api, id} = await setup();
  api.pageSamples[0].text = "Apply Now";
  await engine.check(id);
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 0);
  api.pageSamples[0].text = "Get Notified";
  await engine.check(id);
  api.pageSamples[0].text = "Apply Now";
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 0);
});

test("a failed check preserves the last successful observation and retries", async () => {
  const {engine, api, id} = await setup();
  await engine.setEnabled(id, true);
  api.readError = "Login required";
  await engine.check(id);
  const monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.checks, 1);
  assert.equal(monitor.lastCheckedAt, 1000000);
  assert.equal(monitor.available, false);
  assert.equal(monitor.phase, "error");
  assert.equal(monitor.history[0].kind, "error");
  assert.equal(monitor.error, "OurDomain · Amsterdam Diemen (thisisourdomain.securerc.co.uk): Login required");
  assert.ok(api.alarmsMap.has(`spotalert:${id}`));
});

test("pause cancels an in-flight reload and leaves the browser tab open", async () => {
  const {engine, api, id} = await setup();
  api.completeReload = false;
  const pending = engine.setEnabled(id, true);
  while (!api.reloads.length) await new Promise((resolve) => setTimeout(resolve, 1));
  await engine.setEnabled(id, false);
  await pending;
  const monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.enabled, false);
  assert.equal(monitor.phase, "paused");
  assert.equal(monitor.checks, 0);
  assert.equal(api.alarmsMap.size, 0);
  assert.equal(api.tabs.onUpdated.listeners.size, 0);
});

test("restart restores missing alarms without losing monitor history", async () => {
  const {engine, api, id, createEngine} = await setup();
  await engine.setEnabled(id, true);
  api.alarmsMap.clear();
  const restarted = createEngine(api, () => 1100000);
  await restarted.initialize();
  const monitor = (await restarted.state()).monitors[0];
  assert.equal(monitor.checks, 1);
  assert.equal(monitor.available, false);
  assert.equal(monitor.history[0].kind, "check");
  assert.ok(api.alarmsMap.has(`spotalert:${id}`));
});

test("unsupported websites cannot be saved", async () => {
  const {engine, api, core} = await setup();
  api.allowed = false;
  await assert.rejects(engine.save({...core.defaultMonitor(), id: undefined, url: "https://example.com"}), /supported website list/);
  assert.equal((await engine.state()).monitors.length, core.SUPPORTED_SITES.length);
});

test("editing a running monitor pauses it and clears the old result", async () => {
  const {engine, id} = await setup();
  await engine.setEnabled(id, true);
  const monitor = (await engine.state()).monitors[0];
  await engine.save({...monitor, name: "New rule"});
  const saved = (await engine.state()).monitors[0];
  assert.equal(saved.enabled, false);
  assert.equal(saved.available, null);
  assert.equal(saved.samples.length, 0);
  assert.equal(saved.lastCheckedAt, null);
});

test("page reader returns selector errors instead of false unavailability", async () => {
  const [, , {readPage}] = await modules;
  const context = vm.createContext({
    document: {querySelectorAll: () => { throw new Error("invalid selector"); }},
    location: {href: "https://example.com"}, Date, setTimeout,
  });
  const result = await vm.runInContext(`(${readPage.toString()})({type:'css',selector:'['},0)`, context);
  assert.match(result.error, /Invalid CSS selector/);
});

test("changing the interval reschedules an active watch without resetting results", async () => {
  const {engine, api, id} = await setup();
  await engine.setEnabled(id, true);
  const before = (await engine.state()).monitors[0];
  await engine.dispatch({type: "set-interval", id, intervalSeconds: 60});
  const after = (await engine.state()).monitors[0];
  assert.equal(after.enabled, true);
  assert.equal(after.intervalSeconds, 60);
  assert.equal(after.checks, before.checks);
  assert.equal(after.available, before.available);
  assert.deepEqual(after.samples, before.samples);
  assert.equal(after.lastCheckedAt, before.lastCheckedAt);
  assert.equal(api.alarmsMap.get(`spotalert:${id}`).when, 1060000);
  assert.equal(after.history[0].kind, "interval");
  await engine.setEnabled(id, false);
  await engine.dispatch({type: "set-interval", id, intervalSeconds: 600});
  assert.equal(api.alarmsMap.size, 0);
  assert.equal((await engine.state()).monitors[0].nextCheckAt, null);
  await assert.rejects(engine.dispatch({type: "set-interval", id, intervalSeconds: 1}), /5 seconds/);
});

test("fixed catalog preserves supported history and archives unsupported watches", async () => {
  const {core, createEngine, api, engine, id} = await setup();
  await engine.check(id);
  const previous = await engine.state();
  previous.monitors.push({...core.defaultMonitor("custom"), url: "https://example.com/", enabled: true});
  api.data[core.STORAGE_KEY] = previous;
  api.alarmsMap.set(core.ALARM_PREFIX + "custom", {name: core.ALARM_PREFIX + "custom"});
  const restarted = createEngine(api);
  await restarted.initialize();
  const state = await restarted.state();
  assert.equal(state.monitors.length, core.SUPPORTED_SITES.length);
  assert.equal(state.monitors[0].checks, 1);
  assert.equal(state.archivedMonitors[0].enabled, false);
  assert.equal(state.archivedMonitors[0].url, "https://example.com/");
  assert.equal(api.alarmsMap.has(core.ALARM_PREFIX + "custom"), false);
  await assert.rejects(restarted.dispatch({type: "discover"}), /Unknown/);
  await assert.rejects(restarted.save({...core.defaultMonitor(), url: "https://example.com/"}), /supported website list/);
  await restarted.initialize();
  assert.equal((await restarted.state()).archivedMonitors.length, 1);
});

test("revoked supported-site permission blocks saving", async () => {
  const {core, api, engine} = await setup();
  api.allowed = false;
  await assert.rejects(engine.save(core.defaultMonitor()), /Allow access/);
});

test("adding South East preserves Diemen settings and checks the separate URL", async () => {
  const {core, createEngine, api, engine, id} = await setup();
  await engine.check(id);
  const oldState = await engine.state();
  oldState.monitors = oldState.monitors.filter(monitor => monitor.id === id);
  oldState.monitors[0].intervalSeconds = 60;
  api.data[core.STORAGE_KEY] = oldState;
  const upgraded = createEngine(api);
  await upgraded.initialize();
  const state = await upgraded.state();
  assert.equal(state.monitors[0].checks, 1);
  assert.equal(state.monitors[0].intervalSeconds, 60);
  const southEast = state.monitors.find(monitor => monitor.id === "ourdomain-amsterdam-south-east");
  assert.equal(southEast.url, core.SUPPORTED_SITES[1].url);
  assert.equal(southEast.enabled, false);
  api.url = southEast.url;
  await upgraded.check(southEast.id);
  const checked = (await upgraded.state()).monitors;
  assert.equal(checked[1].checks, 1);
  assert.equal(checked[1].available, false);
  assert.equal(checked[0].checks, 1);
});

test("five-second timers refresh with a recovery alarm, cancel on pause, and restore on restart", async () => {
  const {core, createEngine, api, id} = await setup();
  let currentTime = 1000000;
  let timerId = 0;
  const pending = new Map();
  const timers = {
    setTimeout: (callback, delay) => { const id = ++timerId; pending.set(id, {callback, delay}); return id; },
    clearTimeout: id => pending.delete(id),
  };
  const engine = createEngine(api, () => currentTime, timers);
  await engine.initialize();
  await engine.dispatch({type: "set-interval", id, intervalSeconds: 5});
  await engine.setEnabled(id, true);
  assert.equal([...pending.values()][0].delay, 5000);
  assert.equal(api.alarmsMap.get(core.ALARM_PREFIX + id).when, 1030000);
  assert.equal((await engine.state()).monitors[0].nextCheckAt, 1005000);
  const [key, timer] = [...pending.entries()][0];
  pending.delete(key);
  currentTime += 5000;
  await timer.callback();
  assert.equal((await engine.state()).monitors[0].checks, 2);
  assert.equal(pending.size, 1);
  await engine.dispatch({type: "set-interval", id, intervalSeconds: 60});
  assert.equal(pending.size, 0);
  await engine.dispatch({type: "set-interval", id, intervalSeconds: 5});
  assert.equal(pending.size, 1);
  await engine.setEnabled(id, false);
  assert.equal(pending.size, 0);
  assert.equal(api.alarmsMap.size, 0);
  await engine.setEnabled(id, true);
  pending.clear(); // Worker suspension discards timer memory, but preserves the alarm.
  const restarted = createEngine(api, () => currentTime, timers);
  await restarted.initialize();
  assert.equal(pending.size, 1);
  assert.equal([...pending.values()][0].delay, 5000);
  await restarted.setEnabled(id, false);
});

test("pop-ups report new completed availability transitions and respect notification settings", async () => {
  const [core] = await modules;
  const unavailable = {...core.defaultMonitor(), checks: 1, available: false};
  delete unavailable.alert; // Legacy state without persisted per-listing alert events.
  const available = {...unavailable, checks: 2, available: true};
  assert.deepEqual(core.availabilityArrivals([unavailable], [available]), [available]);
  assert.deepEqual(core.availabilityArrivals([available], [{...available, checks: 3}]), []);
  assert.deepEqual(core.availabilityArrivals([unavailable], [{...available, notify: false}]), []);
  assert.deepEqual(core.availabilityArrivals([unavailable], [{...available, checks: 1}]), []);
  assert.deepEqual(core.availabilityArrivals([], [available]), [available]);
  assert.deepEqual(core.availabilityArrivals([], [core.defaultMonitor()]), []);
});

test("unreadable South East checks and previews identify the affected site", async () => {
  const {engine, api, core} = await setup();
  const monitor = core.defaultMonitor("ourdomain-amsterdam-south-east");
  api.url = monitor.url;
  api.readError = "No readable elements matched. Check the page for a login or verification prompt, or edit the selector.";
  await engine.check(monitor.id);
  const failed = (await engine.state()).monitors.find(item => item.id === monitor.id);
  assert.equal(failed.error, `OurDomain · Amsterdam South East (southeast-thisisourdomain.securerc.co.uk): ${api.readError}`);
  assert.equal(failed.history[0].message, failed.error);
  assert.equal(core.siteError(failed, failed.error), failed.error);
  await assert.rejects(engine.dispatch({type: "preview", monitor}), /OurDomain · Amsterdam South East \(southeast-thisisourdomain.securerc.co.uk\): No readable elements matched/);
});

test("reader ignores hidden responsive duplicates while retaining visible empty-element errors", async () => {
  const [, , {readPage}] = await modules;
  const visible = {innerText: "Get Notified", getClientRects: () => [{}], closest: () => null};
  const hidden = {innerText: "", getClientRects: () => [], closest: () => null};
  const context = vm.createContext({document: {querySelectorAll: () => [visible, hidden]}, location: {href: "https://example.com"}, Date, setTimeout});
  const result = await vm.runInContext(`(${readPage.toString()})({type:'css',selector:'button'},0)`, context);
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].text, "Get Notified");
  visible.innerText = "";
  const empty = await vm.runInContext(`(${readPage.toString()})({type:'css',selector:'button'},0)`, context);
  assert.match(empty.error, /No readable/);
});

test("South East rule correction migrates the old default and preserves custom settings", async () => {
  const {core, engine, api, createEngine} = await setup();
  const previous = await engine.state();
  const southEast = previous.monitors[1];
  southEast.rule = {...core.defaultMonitor().rule};
  southEast.enabled = true;
  southEast.intervalSeconds = 5;
  southEast.notify = false;
  southEast.error = "No readable elements matched";
  southEast.checks = 12;
  api.data[core.STORAGE_KEY] = previous;
  const restarted = createEngine(api, () => 1000000);
  await restarted.initialize();
  const updated = (await restarted.state()).monitors[1];
  assert.equal(updated.rule.selector, 'td[data-selenium-id^="Apply_"] [data-selenium-id="ApplyNow"]');
  assert.equal(updated.enabled, true);
  assert.equal(updated.intervalSeconds, 5);
  assert.equal(updated.notify, false);
  assert.equal(updated.checks, 12);
  assert.equal(updated.error, null);
  assert.equal(updated.history[0].kind, "updated");
  await restarted.setEnabled(updated.id, false);
  await restarted.save({...updated, rule: {...updated.rule, selector: ".custom"}});
  await createEngine(api).initialize();
  assert.equal((await restarted.state()).monitors[1].rule.selector, ".custom");
});

test("South East reads collapsed floorplans and deduplicates responsive application buttons", async () => {
  const [core, , {readPage}] = await modules;
  const button = (id, label, visible) => ({
    innerText: visible ? label : "", textContent: label,
    getClientRects: () => visible ? [{}] : [],
    closest: selector => selector.startsWith("td[") ? {getAttribute: () => id} : {innerText: visible ? label : "", textContent: label},
  });
  const elements = [button("Apply_1", "Get Notified", true), button("Apply_1", "Get Notified", false), button("Apply_2", "Apply Now", false), button("Apply_2", "Apply Now", false)];
  const context = vm.createContext({document: {querySelectorAll: () => elements}, location: {href: core.SUPPORTED_SITES[1].url}, Date, setTimeout});
  const result = await vm.runInContext(`(${readPage.toString()})(${JSON.stringify(core.SUPPORTED_SITES[1].rule)},0,${JSON.stringify(core.SUPPORTED_SITES[1].reader)})`, context);
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples[1].text, "Apply Now");
  assert.equal(core.evaluateRule(result.samples, core.SUPPORTED_SITES[1].rule).available, true);
});

test("floor-plan names fall back to RentCafe contact IDs when the heading is missing", async () => {
  const [core, , {readPage}] = await modules;
  const button = {
    id: "ContactUs13_2 Bedroom Superior (monthly income required)_mobile",
    innerText: "Get Notified", textContent: "Get Notified",
    getClientRects: () => [{}], matches: () => true,
    getAttribute: () => null,
    closest: selector => selector.startsWith("td[") ? {getAttribute: () => "Apply_1"} : null,
  };
  const context = vm.createContext({document: {querySelectorAll: () => [button]}, location: {href: core.SUPPORTED_SITES[1].url}, Date, setTimeout});
  const result = await vm.runInContext(`(${readPage.toString()})(${JSON.stringify(core.SUPPORTED_SITES[1].rule)},0,${JSON.stringify(core.SUPPORTED_SITES[1].reader)})`, context);
  assert.equal(result.samples[0].name, "2 Bedroom Superior (monthly income required)");
  assert.equal(core.evaluateRule(result.samples, core.SUPPORTED_SITES[1].rule).matches[0].apartmentType, "2-bedroom");
});

test("apartment filters restrict matching by type and by stable floor-plan ID", async () => {
  const [core] = await modules;
  const samples = [
    {id: "studio", name: "Superior Studio", beds: "Studio", text: "Apply Now"},
    {id: "one", name: "1 Bedroom", beds: "1", text: "Apply Now"},
    {id: "two", name: "2 Bedroom", beds: "2", text: "Get Notified"},
  ];
  const result = core.evaluateRule(samples, core.defaultMonitor().rule, {types: ["studio"], floorplans: ["studio"]});
  assert.equal(result.available, true);
  assert.deepEqual(result.matches.filter(sample => sample.matched).map(sample => sample.id), ["studio"]);
  assert.equal(result.matches[1].included, false);
  assert.equal(core.evaluateRule(samples, core.defaultMonitor().rule, {types: ["studio"], floorplans: ["one"]}).available, false);
  assert.throws(() => core.validateMonitor({...core.defaultMonitor(), filters: {types: ["penthouse"]}}), /apartment types/);
  assert.throws(() => core.validateMonitor({...core.defaultMonitor(), hours: {enabled: true, start: "08:00", end: "08:00"}}), /different/);
  assert.throws(() => core.validateMonitor({...core.defaultMonitor(), hours: {timeZone: "Invalid/Timezone"}}), /timezone/);
});



test("retry delays grow after failures and reset after a successful check", async () => {
  const {core, api, engine, id} = await setup();
  await engine.dispatch({type: "set-interval", id, intervalSeconds: 5});
  await engine.setEnabled(id, true);
  api.readError = "Page load timed out";
  await engine.check(id);
  let monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.errorKind, "loading");
  assert.equal(monitor.consecutiveErrors, 1);
  assert.equal(monitor.nextCheckAt, 1030000);
  await engine.check(id);
  monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.nextCheckAt, 1060000);
  assert.equal(core.retrySeconds({...monitor, consecutiveErrors: 20}), 900);
  api.readError = null;
  await engine.check(id);
  monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.consecutiveErrors, 0);
  assert.equal(monitor.nextCheckAt, 1005000);
  await engine.setEnabled(id, false);
});

test("monitoring windows support overnight schedules and daylight-saving changes", async () => {
  const [core] = await modules;
  const hours = {enabled: true, start: "22:00", end: "06:00", timeZone: "Europe/Amsterdam"};
  assert.equal(core.inMonitoringHours(Date.parse("2026-10-11T21:00:00Z"), hours), true);
  assert.equal(core.inMonitoringHours(Date.parse("2026-10-11T12:00:00Z"), hours), false);
  assert.equal(core.nextMonitoringTime(Date.parse("2026-10-11T12:00:00Z"), hours), Date.parse("2026-10-11T20:00:00Z"));
  const spring = {enabled: true, start: "02:30", end: "03:30", timeZone: "Europe/Amsterdam"};
  assert.equal(core.nextMonitoringTime(Date.parse("2026-03-29T00:00:00Z"), spring), Date.parse("2026-03-29T01:00:00Z"));
});

test("scheduled checks wait for hours, while Check now remains available", async () => {
  const {core, api, createEngine, id} = await setup();
  const time = Date.parse("2026-10-11T20:00:00Z");
  const engine = createEngine(api, () => time);
  await engine.initialize();
  await engine.save({...core.defaultMonitor(), hours: {enabled: true, start: "08:00", end: "18:00", timeZone: "UTC"}});
  await engine.setEnabled(id, true);
  assert.equal(api.reloads.length, 0);
  let monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.phase, "waiting-hours");
  assert.equal(monitor.nextCheckAt, Date.parse("2026-10-12T08:00:00Z"));
  await engine.check(id);
  assert.equal(api.reloads.length, 1);
  await engine.setEnabled(id, false);
});

test("reader distinguishes verification, login, selector errors and empty loading elements", async () => {
  const [, , {readPage}] = await modules;
  const read = (document) => vm.runInContext(`(${readPage.toString()})({type:'css',selector:'.availability'},0)`, vm.createContext({document, location: {href: "https://example.com"}, Date, setTimeout}));
  assert.equal((await read({title: "Just a moment..."})).errorKind, "verification");
  assert.equal((await read({title: "Sign in", querySelector: selector => selector.includes("password") ? {} : null})).errorKind, "login");
  assert.equal((await read({readyState: "complete", querySelectorAll: () => []})).errorKind, "selector");
  assert.equal((await read({querySelectorAll: () => [{getClientRects: () => [{}], innerText: "", closest: () => null}]})).errorKind, "loading");
});




test("Open affected tab reuses a login or redirected tab rather than overwriting it", async () => {
  const {api, engine, id} = await setup();
  await engine.check(id);
  api.url = "https://thisisourdomain.securerc.co.uk/login";
  const updates = [];
  api.tabs.update = async (tabId, config) => updates.push({tabId, ...config});
  api.tabs.create = async () => { throw new Error("Should reuse the affected tab"); };
  await engine.dispatch({type: "open-affected", id});
  assert.deepEqual(updates, [{tabId: 7, active: true}]);
});



test("JavaScript application buttons open their floorplan and never click Get Notified", async () => {
  const [, , {openApplication}] = await modules;
  let applied = 0, expanded = 0;
  const section = {id: "FP_Detail_101", querySelector: () => null, getAttribute: () => "Apply_1"};
  const toggle = {getAttribute: () => "#FP_Detail_101", click: () => expanded++};
  const button = {innerText: "Apply Now", textContent: "Apply Now", getAttribute: () => "", closest: () => section, getClientRects: () => [], click: () => applied++};
  const document = {querySelectorAll: selector => selector === "a[href]" ? [toggle] : [button]};
  const context = vm.createContext({document});
  let result = vm.runInContext(`(${openApplication.toString()})({id:'floorplan:101'})`, context);
  assert.equal(result.opened, true);
  assert.equal(applied, 1);
  assert.equal(expanded, 1);
  button.innerText = button.textContent = "Get Notified";
  result = vm.runInContext(`(${openApplication.toString()})({id:'floorplan:101'})`, context);
  assert.equal(result.opened, false);
  assert.equal(applied, 1);
});

test("opening a floorplan fragment keeps checks attached to the same website tab", async () => {
  const {core, api, engine, id} = await setup();
  api.url = core.DEFAULT_URL + "#FP_Detail_101";
  await engine.check(id);
  const monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.checks, 1);
  assert.equal(monitor.error, null);
  assert.equal(monitor.tabId, 7);
});

test("personal details validate, persist separately, delete, and never enter monitor state", async () => {
  const {api, engine} = await setup();
  const {PROFILE_KEY, validateProfile} = await import("../SpotAlert/chrome_extension/profile.js");
  assert.throws(() => validateProfile({email: "invalid"}), /valid email/);
  assert.throws(() => validateProfile({moveInFrom: "2026-02-30"}), /move-in/);
  assert.throws(() => validateProfile({firstName: "a".repeat(201)}), /200/);
  await engine.dispatch({type: "save-profile", profile: {firstName: " Alex ", lastName: "Example", email: "alex@example.com", moveInFrom: "2026-10-20", password: "ignored"}});
  assert.equal((await engine.dispatch({type: "profile"})).moveInFrom, "2026-10-20");
  assert.equal(api.data[PROFILE_KEY].firstName, "Alex");
  assert.equal(api.data[PROFILE_KEY].password, undefined);
  assert.equal((await engine.dispatch({type: "profile"})).email, "alex@example.com");
  assert.doesNotMatch(JSON.stringify(await engine.state()), /alex@example/);
  api.url = "https://example.com/application";
  await assert.rejects(engine.dispatch({type: "fill-application"}), /supported housing application/);
  await engine.dispatch({type: "clear-profile"});
  assert.equal((await engine.dispatch({type: "profile"})).firstName, "");
  await assert.rejects(engine.dispatch({type: "fill-application"}), /Save your personal/);
});

test("Stop all pauses every monitor, cancels in-flight checks and alarms, and preserves results", async () => {
  const {engine, api, id, core} = await setup();
  await engine.setEnabled(id, true);
  const previous = (await engine.state()).monitors[0];
  api.completeReload = false;
  const pending = engine.setEnabled(core.SUPPORTED_SITES[1].id, true);
  while (api.reloads.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  await engine.dispatch({type: "stop-all"});
  await pending;
  const value = await engine.state();
  assert.ok(value.monitors.every(monitor => !monitor.enabled && monitor.phase === "paused" && monitor.nextCheckAt === null));
  assert.deepEqual(value.monitors[0].samples, previous.samples);
  assert.equal(value.monitors[0].checks, previous.checks);
  assert.equal(api.alarmsMap.size, 0);
  assert.equal(api.tabs.onUpdated.listeners.size, 0);
  await engine.initialize();
  assert.ok((await engine.state()).monitors.every(monitor => !monitor.enabled));
});

test("application readiness requires contact details, without requiring an address", async () => {
  const {applicationReadiness} = await import("../SpotAlert/chrome_extension/ui.js");
  assert.deepEqual(applicationReadiness({}).missing, ["first name", "last name", "email", "phone"]);
  assert.equal(applicationReadiness({firstName: "Alex", lastName: "Example", email: "alex@example.com", phone: "+31612345678"}).ready, true);
  assert.equal(applicationReadiness({firstName: "Alex", lastName: "Example", email: "invalid", phone: " "}).ready, false);
});

test("freshness uses the last successful check and accounts for refresh intervals", async () => {
  const {freshness} = await import("../SpotAlert/chrome_extension/ui.js");
  assert.equal(freshness({lastCheckedAt: null}, 100000).text, "Not checked");
  assert.equal(freshness({lastCheckedAt: 100000, intervalSeconds: 5}, 159000).stale, false);
  assert.equal(freshness({lastCheckedAt: 100000, intervalSeconds: 5}, 161000).stale, true);
  assert.equal(freshness({lastCheckedAt: 100000, intervalSeconds: 3600}, 3700000).stale, false);
  assert.equal(freshness({lastCheckedAt: 100000, intervalSeconds: 300}, 1100000).text, "Stale · 16m ago");
});

test("available website totals differ from apartment units and unknown counts remain explicit", async () => {
  const {availabilityTotals} = await import("../SpotAlert/chrome_extension/ui.js");
  const monitors = [{available: true, samples: [{id: "a", matched: true, availableCount: 3}, {id: "a", matched: true, availableCount: 3}, {id: "b", matched: true}, {id: "c", matched: false, availableCount: 7}]}];
  assert.deepEqual(availabilityTotals(monitors), {websites: 1, apartments: 4, unknownCounts: 1});
  monitors.push({available: true, samples: [{id: "d", matched: true, availableCount: 2}, {id: "e", matched: true, included: false}]});
  assert.deepEqual(availabilityTotals(monitors), {websites: 2, apartments: 6, unknownCounts: 1});
});

test("debug capture is opt-in, opens matching direct links once, and preserves monitoring results", async () => {
  const {api, engine, id, core} = await setup();
  const created = [];
  const create = api.tabs.create;
  api.tabs.create = async options => { created.push(options); return create(options); };
  const execute = api.scripting.executeScript;
  api.scripting.executeScript = async options => options.func.name === "inspectApplicationPage"
    ? [{result: {pageKind: "form", title: "Apply", fields: [{name: "firstName", required: true}], text: "Application"}}] : execute(options);
  api.pageSamples = [{id: "studio", name: "Studio", beds: "Studio", text: "Apply Now", applicationUrl: core.OURDOMAIN + "/onlineleasing/apply.aspx?myUnitId=123"}];
  await engine.check(id);
  assert.equal(created.length, 0);
  await engine.dispatch({type: "set-debug", enabled: true});
  await engine.check(id);
  assert.equal(created.length, 1);
  assert.equal(created[0].active, false);
  assert.equal(created[0].url, "about:blank");
  assert.equal((await engine.state()).debug.captures[0].snapshot.pageKind, "form");
  await engine.check(id);
  assert.equal(created.length, 1);
  api.pageSamples[0].text = "Get Notified";
  await engine.check(id);
  api.pageSamples[0].text = "Apply Now";
  await engine.check(id);
  assert.equal(created.length, 2);
  assert.equal((await engine.state()).debug.captures.length, 2);
  await engine.dispatch({type: "clear-debug"});
  await engine.check(id);
  assert.equal(created.length, 2);
  await engine.dispatch({type: "set-debug", enabled: false});
  assert.equal((await engine.state()).debug.enabled, false);
});

test("debug capture failures do not mark successful availability checks as failed", async () => {
  const {api, engine, id, core} = await setup();
  await engine.dispatch({type: "set-debug", enabled: true});
  api.pageSamples = [{id: "studio", text: "Apply Now", applicationUrl: core.OURDOMAIN + "/apply"}];
  const execute = api.scripting.executeScript;
  api.scripting.executeScript = async options => {
    if (options.func.name === "inspectApplicationPage") throw new Error("Website verification blocked inspection");
    return execute(options);
  };
  await engine.check(id);
  const state = await engine.state();
  assert.equal(state.monitors[0].available, true);
  assert.equal(state.monitors[0].error, null);
  assert.equal(state.debug.captures[0].status, "error");
  assert.match(state.debug.captures[0].error, /verification/);
});

test("Stop all cancels a loading debug capture without clearing successful results", async () => {
  const {api, engine, id, core} = await setup();
  await engine.dispatch({type: "set-debug", enabled: true});
  api.pageSamples = [{id: "studio", text: "Apply Now", applicationUrl: core.OURDOMAIN + "/apply"}];
  const get = api.tabs.get;
  api.tabs.get = async tabId => ({...await get(tabId), status: tabId === 8 ? "loading" : "complete"});
  const pending = engine.check(id);
  while (!(await engine.state()).debug.captures.length || !api.tabs.onUpdated.listeners.size) await new Promise(resolve => setTimeout(resolve, 1));
  await engine.dispatch({type: "stop-all"});
  await pending;
  const state = await engine.state();
  assert.equal(state.debug.captures[0].status, "error");
  assert.equal(state.monitors[0].phase, "paused");
  assert.equal(state.monitors[0].available, true);
  assert.equal(api.tabs.onUpdated.listeners.size, 0);
});



test("Resend requires an explicit profile recipient and reports provider failures", async () => {
  const {sendEmailAlert, EMAIL_KEY, CONTACT_KEY} = await import("../SpotAlert/chrome_extension/email.js");
  let settings = {[EMAIL_KEY]: {apiKey: "re_test"}, [CONTACT_KEY]: {email: "legacy@example.com"}};
  const api = {storage: {local: {get: async () => settings}}};
  await assert.rejects(sendEmailAlert(api, {id:"test"}, "Subject", "Body"), /profile email recipient/);
  const delivery = {to:'recipient@example.com'};
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(options.headers.Authorization, "Bearer re_test");
      assert.deepEqual(JSON.parse(options.body).to, ["recipient@example.com"]);
      return {ok: true, json: async () => ({id: "test-email"})};
    };
    assert.equal((await sendEmailAlert(api, {id:"test"}, "Subject", "Body", delivery)).sent, true);
    globalThis.fetch = async () => ({ok:false,status:401,json:async()=>({})});
    await assert.rejects(sendEmailAlert(api, {id:"test"}, "Subject", "Body", delivery), /API key/);
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(sendEmailAlert(api, {id:"test"}, "Subject", "Body", delivery), /reach Resend/);
  } finally { globalThis.fetch = previousFetch; }
});







test("Canvas Blaak is added without replacing OurDomain history and matches positive availability only", async () => {
  const {engine, api, id, core} = await setup();
  const canvas = (await engine.state()).monitors.find(m => m.id === "canvas-rotterdam-blaak");
  assert.ok(canvas.url.startsWith("https://canvas-world.securerc.co.uk/"));
  const result = core.evaluateRule([
    {index: 1, name: "1 Bedroom Executive", beds: "1", rent: "€ 1.724 – € 1.733", text: "Check availability"},
    {index: 2, name: "Standard Studio", beds: "Studio", text: "Get Notified"},
    {index: 3, name: "Executive Studio", text: "Contact for Availability"},
  ], canvas.rule);
  assert.deepEqual(result.matches.map(m => m.matched), [true, false, false]);
  api.url = canvas.url;
  api.pageSamples = result.matches;
  await engine.check(canvas.id);
  const state = await engine.state();
  assert.equal(state.monitors.find(m => m.id === canvas.id).available, true);
  assert.equal(state.monitors.find(m => m.id === id).checks, 0);
  assert.equal(api.notificationsLog.length, 0);
});

test("move-in selection respects the earliest preference, calendar limits, and excluded weekdays", async () => {
  const {selectMoveInDate} = await import("../SpotAlert/chrome_extension/profile.js");
  const input = {value: "17-10-2026", getClientRects: () => [1], dispatchEvent() {}};
  const config = "$('#sMoveInDate').datepicker({minDate: '17-10-2026', maxDate: '30-10-2026'}); var excludedDays = [0,6];";
  const context = {document: {querySelector: () => input, scripts: [{textContent: config}]}, HTMLInputElement: {prototype: {}}, Event: class {}, setTimeout: callback => callback()};
  Object.defineProperty(context.HTMLInputElement.prototype, 'value', {set(value) {this.value = value;}});
  const choose = date => vm.runInNewContext(`(${selectMoveInDate.toString()})({moveInFrom: ${JSON.stringify(date)}})`, context);
  assert.equal(choose("").moveInDate, "19-10-2026");
  assert.equal(choose("2026-10-01").moveInDate, "19-10-2026");
  assert.equal(choose("2026-10-20").moveInDate, "20-10-2026");
  assert.equal(choose("2026-10-24").moveInDate, "26-10-2026");
  assert.equal(choose("2026-10-30").moveInDate, "30-10-2026");
  assert.equal(choose("2026-10-31").count, 0);
  assert.equal(input.value, "30-10-2026");
  context.document.scripts = [{textContent: config.replace('[0,6]', '[]')}];
  assert.equal(choose('2026-10-24').moveInDate, '26-10-2026');
  assert.equal(choose('2026-10-25').moveInDate, '26-10-2026');
  context.document.scripts = [{textContent: config.replace('[0,6]', '[1]')}];
  assert.equal(choose('2026-10-24').moveInDate, '27-10-2026');
  context.document.scripts = [];
  assert.match(choose("2026-10-20").moveInMessage, /Could not determine/);
  assert.equal(input.value, "27-10-2026");
});

test("Canvas Book chooses the earliest unit in the selected floor plan and never starts an application", async () => {
  const {canvasBookingLink} = await import('../SpotAlert/chrome_extension/page.js');
  let clicked = null;
  const button = (id, floorplan, date) => ({value: 'Book now', getAttribute: () => `return ApplyNowClick('${id}','${floorplan}','186511','${date}','termsandotheritems.aspx');`, click: () => {clicked = id;}});
  const context = {location: {pathname: '/availableunits.aspx'}, document: {querySelectorAll: () => [button('450280', '502', '16-10-2026'), button('450348', '501', '6-11-2026'), button('450281', '501', '17-10-2026')]}, Date};
  const result = await vm.runInNewContext(`(${canvasBookingLink.toString()})({floorplanId:'501'}, 0)`, context);
  assert.equal(result.opened, true);
  assert.equal(clicked, '450281');
  clicked = null;
  const ambiguous = await vm.runInNewContext(`(${canvasBookingLink.toString()})({}, 0)`, context);
  assert.match(ambiguous.error, /Choose a floor plan/);
  assert.equal(clicked, null);
});

test('Start Application requires the selected date and an enabled button, and clicks once', async () => {
  const {startCanvasApplication} = await import('../SpotAlert/chrome_extension/profile.js');
  const input = {value:'26-10-2026'};
  let clicks = 0;
  const button = {innerText:'Start Application', disabled:false, getAttribute:()=>null, getClientRects:()=>[1], click:()=>clicks++};
  const context = {document:{querySelector:()=>input, querySelectorAll:()=>[button]}, Date, setTimeout: callback=>callback()};
  const run = () => vm.runInNewContext(`(${startCanvasApplication.toString()})('26-10-2026',0)`,context);
  assert.equal((await run()).started,true);
  assert.equal(clicks,1);
  input.value='27-10-2026';
  assert.equal((await run()).started,false);
  input.value='26-10-2026';
  button.disabled=true;
  assert.equal((await run()).started,false);
  assert.equal(clicks,1);
});

test('expanded profiles validate choices, dates and zero income, and count Canvas requirements', async () => {
  const {validateProfile, profileCompleteness, PROFILE_FIELDS} = await import('../SpotAlert/chrome_extension/profile.js');
  const profile = validateProfile({firstName:'Alex', dateOfBirth:'1995-03-04', monthlyHousingCost:'0', monthlyIncome:'1234.50', hasPets:'No', noMiddleName:'Yes'});
  assert.equal(profile.monthlyHousingCost,'0');
  assert.equal(profile.hasPets,'No');
  assert.throws(()=>validateProfile({dateOfBirth:'1995-02-30'}),/valid date/);
  assert.throws(()=>validateProfile({monthlyIncome:'-10'}),/non-negative/);
  assert.throws(()=>validateProfile({hasPets:'maybe'}),/valid pets/);
  assert.throws(()=>validateProfile({middleName:'Example',noMiddleName:'Yes'}),/Clear/);
  assert.ok(!profileCompleteness(profile).missing.includes('Middle name'));
  assert.ok(profileCompleteness({}).missing.includes('Middle name'));
  const all=Object.fromEntries(PROFILE_FIELDS.map(key=>[key,'prepared']));
  all.noMiddleName='Yes';
  assert.equal(profileCompleteness(all).ready,true);
});

test('toolbar icon opens the dashboard in a full Chrome tab', async () => {
  const clicked = event();
  const opened = [];
  const behavior = [];
  const chrome = {
    sidePanel: {setPanelBehavior: async settings => behavior.push(settings)},
    action: {onClicked: clicked},
    tabs: {create: async tab => opened.push(tab)},
    runtime: {getURL: path => `chrome-extension://test/${path}`, onMessage: event(), onStartup: event()},
    alarms: {onAlarm: event()}, notifications: {onClicked: event()},
  };
  const source = fs.readFileSync('SpotAlert/chrome_extension/background.js', 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, {chrome, console, ALARM_PREFIX: 'test', createEngine: () => ({initialize: async () => {}, dispatch: async () => {}})});
  clicked.emit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(behavior[0].openPanelOnActionClick, false);
  assert.equal(opened[0].url, 'chrome-extension://test/panel.html');
  assert.equal(opened[0].active, true);
});

test('saved applicants migrate, switch independently and retain their own passwords', async () => {
  const {engine, api} = await setup();
  const {PROFILE_KEY, PROFILES_KEY} = await import('../SpotAlert/chrome_extension/profile.js');
  delete api.data[PROFILES_KEY]; // Simulate a pre-library installation.
  api.data[PROFILE_KEY] = {firstName: 'Alex', registrationPassword: 'AlexPassword123!'};
  const original = await engine.dispatch({type: 'profiles'});
  assert.equal(original.profiles[0].details.firstName, 'Alex');
  await engine.dispatch({type: 'create-profile'});
  await engine.dispatch({type: 'save-profile', name: 'Sam', profile: {firstName: 'Sam', registrationPassword: 'SamPassword123!'}});
  const secondId = api.data[PROFILES_KEY].activeId;
  await engine.dispatch({type: 'select-profile', id: original.activeId});
  assert.equal(api.data[PROFILE_KEY].registrationPassword, 'AlexPassword123!');
  await engine.dispatch({type: 'select-profile', id: secondId});
  assert.equal(api.data[PROFILE_KEY].registrationPassword, 'SamPassword123!');
  assert.ok(!JSON.stringify(await engine.state()).includes('SamPassword'));
  await engine.dispatch({type: 'clear-profile'});
  assert.equal(api.data[PROFILE_KEY].firstName, 'Alex');
  assert.equal(api.data[PROFILES_KEY].profiles.length, 1);
});

test('Start Application refuses weekend move-in dates', async () => {
  const {startCanvasApplication} = await import('../SpotAlert/chrome_extension/profile.js');
  assert.equal((await startCanvasApplication('24-10-2026', 0)).started, false);
  assert.equal((await startCanvasApplication('25-10-2026', 0)).started, false);
});

test('client questionnaire imports answers and optional existing account passwords', async () => {
  const {clientQuestionnaire, parseClientReply} = await import('../SpotAlert/chrome_extension/clients.js');
  const blank = clientQuestionnaire('Alex');
  assert.ok(blank.includes('Password:'));
  assert.match(blank, /Otherwise leave it blank/);
  assert.ok(!blank.includes('IBAN:'));
  assert.throws(() => parseClientReply(blank), /no completed/);
  const reply = blank.replace('First name: ', 'First name: Alex').replace('Email: ', 'Email: alex@example.com');
  assert.equal(parseClientReply(reply).firstName, 'Alex');
  assert.throws(() => parseClientReply(reply.replace('First name: Alex', 'First name: Alex\nFirst name: Sam')), /more than once/);
  assert.throws(() => parseClientReply(reply.replace('First name: Alex', 'Unknown field: secret')), /Unrecognized/);
  const withPassword = reply.replace('Password: ', 'Password: ClientExisting123!');
  assert.equal(parseClientReply(withPassword).registrationPassword, 'ClientExisting123!');
  const {engine, api} = await setup();
  const {PROFILE_KEY, PROFILES_KEY} = await import('../SpotAlert/chrome_extension/profile.js');
  await engine.dispatch({type:'import-client-profile', name:'Alex client', reply});
  assert.equal(api.data[PROFILE_KEY].email, 'alex@example.com');
  assert.equal(api.data[PROFILES_KEY].profiles.length, 2);
  assert.ok(!JSON.stringify(await engine.state()).includes('alex@example.com'));
});

test('local profile folder mirrors saves and restores after Chrome storage removal', async () => {
  const {engine, api} = await setup();
  let disk = null;
  api.runtime.sendNativeMessage = async (host, message) => {
    assert.equal(host, 'com.spotalert.profiles');
    if (message.command === 'write') disk = structuredClone(message.library);
    return {ok:true, library:disk, folder:'/test/SpotAlert/local_profiles'};
  };
  await engine.dispatch({type:'enable-profile-folder'});
  await engine.dispatch({type:'save-profile', name:'Alex', profile:{firstName:'Alex'}});
  assert.equal(disk.profiles[0].details.firstName, 'Alex');
  const {PROFILES_KEY, PROFILE_KEY} = await import('../SpotAlert/chrome_extension/profile.js');
  delete api.data[PROFILES_KEY]; delete api.data[PROFILE_KEY];
  const {createEngine} = await import('../SpotAlert/chrome_extension/engine.js');
  const restored = await createEngine(api).dispatch({type:'profiles'});
  assert.equal(restored.profiles[0].details.firstName, 'Alex');
  api.runtime.sendNativeMessage = async () => {throw new Error('unavailable');};
  await assert.rejects(engine.dispatch({type:'save-profile', profile:{firstName:'Sam'}}), /helper unavailable/);
  assert.equal(api.data[PROFILE_KEY].firstName, 'Alex');
});

test('client apartment preferences check budget, types, sizes and unknown details', async () => {
  const {preferenceMatch} = await import('../SpotAlert/chrome_extension/preferences.js');
  const profile = {maxRent:'1800', minSize:'35', preferredApartmentType:'1-bedroom'};
  assert.equal(preferenceMatch({rent:'€ 1.724,27', size:'40 m²', apartmentType:'1-bedroom'}, profile).included, true);
  assert.equal(preferenceMatch({rent:'€1,600 – €2,000', size:'40 m²', apartmentType:'1-bedroom'}, profile).included, false);
  assert.ok(preferenceMatch({rent:'€2,000', size:'30 m²', apartmentType:'studio'}, profile).reasons.length === 3);
  assert.equal(preferenceMatch({rent:'€1,700', size:'400 sq ft', apartmentType:'1-bedroom'}, profile).included, true);
  assert.ok(preferenceMatch({apartmentType:'1-bedroom'}, profile).reasons.includes('Rent not published'));
});



test('Start Application handles delegated handlers, hidden duplicates and unpadded dates', async () => {
  const {startCanvasApplication} = await import('../SpotAlert/chrome_extension/profile.js');
  let clicks=0;
  const hidden={innerText:'Start Application',disabled:false,getAttribute:()=>null,getClientRects:()=>[],click:()=>{throw new Error('hidden button clicked');}};
  const button={...hidden,getClientRects:()=>[1],click:()=>clicks++};
  const context={document:{querySelector:()=>({value:'2-11-2026'}),querySelectorAll:()=>[hidden,button]},jQuery:{active:0,_data:()=>({})},Date,setTimeout:callback=>callback()};
  const result=await vm.runInNewContext(`(${startCanvasApplication.toString()})('02-11-2026',0)`,context);
  assert.equal(result.started,true);assert.equal(clicks,1);
});

test('application debug reports exclude profile values, passwords and URL queries', async () => {
  const {applicationReport, APPLICATION_BUILD} = await import('../SpotAlert/chrome_extension/application-diagnostics.js');
  const report = applicationReport({build:APPLICATION_BUILD,status:'stopped',kind:'waiting',profile:{email:'private@example.com'},password:'secret-password',message:'private content',trace:[{at:123,event:'page-inspected',path:'/termsandotheritems.aspx?token=secret-token',step:'',kind:'ready',password:'secret-password',pageContent:'private content'}]});
  const encoded=JSON.stringify(report);
  assert.equal(report.build,APPLICATION_BUILD);
  assert.equal(report.trace[0].path,'/termsandotheritems.aspx');
  assert.ok(!/secret|private/.test(encoded));
});

test('application preparation holds one tab lock and releases it after completion', async () => {
  const {api, engine, core, id} = await setup();
  await engine.dispatch({type:'save-profile',profile:{firstName:'Alex'}});
  api.url=core.DEFAULT_URL.replace('floorplans.aspx','oleapplication.aspx?stepname=IntApplicantInfo');
  let release;
  api.deferredRead=new Promise(resolve=>{release=resolve;});
  const first=engine.dispatch({type:'prepare-application'});
  // Wait for the persisted running state, which is recorded after acquiring the lock.
  for(let i=0;i<100;i++) {
    if((await engine.state()).monitors.find(m=>m.id===id).application?.status==='running') break;
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  await assert.rejects(engine.dispatch({type:'prepare-application'}), /already running/);
  await assert.rejects(engine.dispatch({type:'continue-application',id}), /one pass/);
  release();await first;
  await engine.dispatch({type:'prepare-application'});
  assert.equal((await engine.state()).monitors.find(m=>m.id===id).application.stage,'awaiting-review');
});

test('failed preparation releases its lock and identifies the affected tab', async () => {
  const {api, engine, core} = await setup();
  await engine.dispatch({type:'save-profile',profile:{firstName:'Alex'}});
  api.url=core.DEFAULT_URL.replace('floorplans.aspx','oleapplication.aspx?stepname=IntApplicantInfo');
  const original=api.scripting.executeScript;
  api.scripting.executeScript=async()=>{throw new Error('Website unavailable');};
  await assert.rejects(engine.dispatch({type:'prepare-application'}),error=>error.tabId===7 && /Website unavailable/.test(error.message));
  api.scripting.executeScript=original;
  await engine.dispatch({type:'prepare-application'});
});

test('Stop all cancels preparation before further page changes and releases its lock', async () => {
  const {api, engine, core, id}=await setup();
  await engine.dispatch({type:'save-profile',profile:{firstName:'Alex'}});
  api.url=core.DEFAULT_URL.replace('floorplans.aspx','oleapplication.aspx?stepname=IntApplicantInfo');
  let release, entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{release=resolve;});
  const original=api.scripting.executeScript;
  let calls=0;
  api.scripting.executeScript=async args=>{if(++calls===1){entered();await pending;}return original(args);};
  const work=engine.dispatch({type:'prepare-application'});
  const failure=assert.rejects(work,/automation stopped/);
  await started;
  await engine.dispatch({type:'stop-all'});
  release();await failure;
  assert.equal((await engine.state()).monitors.find(m=>m.id===id).application.stage,'cancelled');
  await engine.dispatch({type:'prepare-application'});
});

test('stale dashboard writes are rejected and stopped applications cannot resume', async () => {
  const {engine}=await setup();
  await assert.rejects(engine.dispatch({type:'prepare-application',dashboardBuild:'old'}),/versions do not match/);
  const info=await engine.dispatch({type:'engine-info'});
  assert.equal(info.build,(await import('../SpotAlert/chrome_extension/application-diagnostics.js')).APPLICATION_BUILD);
  const {applicationStage,applicationRecovery}=await import('../SpotAlert/chrome_extension/application-state.js');
  assert.equal(applicationStage({status:'stopped',kind:'verification'}),'verification');
  assert.equal(applicationStage({status:'stopped',kind:'missing'}),'needs-details');
  assert.equal(applicationRecovery({status:'stopped',kind:'signature'}).retry,false);
  assert.equal(applicationRecovery({status:'stopped',kind:'verification'}).retry,false);
});

test('opening a closed application clears its stale tab and explains how to start fresh', async () => {
  const {engine,api,core,id}=await setup();
  api.data[core.STORAGE_KEY].monitors.find(m=>m.id===id).application={status:'stopped',stage:'failed',tabId:123,listingId:'studio',message:'Old run'};
  api.tabs.update=async()=>{throw new Error('No tab with id: 123.');};
  await assert.rejects(engine.dispatch({type:'open-application-tab',id}),/tab was closed.*Use Apply/);
  const application=(await engine.state()).monitors.find(m=>m.id===id).application;
  assert.equal(application.tabId,null);
  assert.equal(application.stage,'failed');
  assert.equal(application.listingId,'studio');
  await assert.rejects(engine.dispatch({type:'continue-application',id}),/one pass/);
});

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

test('searches preserve existing watches and validate profiles, locations, channels and preferences', async () => {
  const {engine, id} = await setup();
  assert.deepEqual((await engine.state()).searches, []);
  const {validateSearch} = await import('../SpotAlert/chrome_extension/searches.js');
  const profiles = [{id: 'a', details: {email: 'a@example.com', maxRent: '1400'}}];
  const input = {name: 'A', profileId: 'a', locationIds: [id], actions: {email: true}};
  assert.equal(Object.hasOwn(validateSearch(input, profiles), 'preferences'), false);
  assert.throws(() => validateSearch({...input, profileId: 'missing'}, profiles), /profile/);
  assert.throws(() => validateSearch({...input, locationIds: ['unknown']}, profiles), /location/);
  assert.throws(() => validateSearch({...input, actions: {}}, profiles), /Choose email/);
  assert.throws(() => validateSearch({...input, actions: {autoApply: true}}, profiles), /contact details/);
  assert.equal(Object.hasOwn(validateSearch({...input, preferences:{maxRent:'-1'}}, profiles), 'preferences'), false, 'copied overrides are ignored');
});

test('shared location reads match each profile independently and email its holder only once', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {apiKey: 'test', enabled: false};
  const original = globalThis.fetch;
  const emails = [];
  globalThis.fetch = async (url, options) => { emails.push(JSON.parse(options.body)); return {ok: true, json: async () => ({id: 'sent'})}; };
  try {
    await engine.dispatch({type: 'save-profile', name: 'Alex', profile: {email: 'alex@example.com', maxRent: '1500'}});
    const firstId = (await engine.dispatch({type: 'profiles'})).activeId;
    const a = await saveSearch(engine, firstId, id);
    await saveSearch(engine, firstId, id, {name: 'Overlapping search'});
    await engine.dispatch({type: 'create-profile'});
    await engine.dispatch({type: 'save-profile', name: 'Bea', profile: {email: 'bea@example.com', maxRent: '1000'}});
    const secondId = (await engine.dispatch({type: 'profiles'})).activeId;
    const b = await saveSearch(engine, secondId, id);
    // Keep the location manually enabled so starting searches does not cause extra reads.
    await engine.dispatch({type: 'start', id});
    for (const search of (await engine.state()).searches) await engine.dispatch({type: 'set-search-enabled', id: search.id, enabled: true});
    api.pageSamples = [{id: 'unit', index: 0, name: 'Studio A', text: 'Apply Now', rent: '€1,200', size: '30 m²', beds: '0'}];
    await engine.check(id);
    await waitForSearch(engine, value => value.searches.find(s => s.id === a.id).activity.some(item => item.status === 'sent'));
    assert.deepEqual(emails.map(email => email.to), [['alex@example.com']]);
    const value = await engine.state();
    assert.equal(value.monitors[0].available, true, 'Monitoring observations do not depend on the selected profile');
    assert.equal(value.searches.find(s => s.id === a.id).results[id].matches[0].matched, true);
    assert.equal(value.searches.find(s => s.id === b.id).results[id].matches[0].matched, false);
    await engine.check(id);
    assert.equal(emails.length, 1);
    const [{createEngine}] = await Promise.all([import('../SpotAlert/chrome_extension/engine.js')]);
    const restarted = createEngine(api, () => 1000000);
    await restarted.initialize();
    await restarted.check(id);
    assert.equal(emails.length, 1, 'claims survive worker restart');
    await restarted.dispatch({type: 'stop-all'});
  } finally { globalThis.fetch = original; }
});

test('search start and pause share scheduling and Stop all disables every search', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {apiKey: 'test'};
  await engine.dispatch({type: 'save-profile', profile: {email: 'a@example.com'}});
  const a = await saveSearch(engine, 'default', id);
  const b = await saveSearch(engine, 'default', id);
  assert.equal(a.enabled, false);
  await engine.dispatch({type: 'set-search-enabled', id: a.id, enabled: true});
  await waitForSearch(engine, value => value.monitors[0].checks === 1);
  const before = api.reloads.length;
  await engine.dispatch({type: 'set-search-enabled', id: b.id, enabled: true});
  assert.equal(api.reloads.length, before);
  await engine.dispatch({type: 'set-search-enabled', id: a.id, enabled: false});
  assert.equal((await engine.state()).monitors[0].enabled, true);
  await engine.dispatch({type: 'pause', id});
  assert.equal((await engine.state()).monitors[0].enabled, true, 'profile checks continue after stopping general monitoring');
  assert.equal((await engine.state()).monitors[0].searchManaged, true);
  await engine.dispatch({type: 'set-search-enabled', id: b.id, enabled: false});
  assert.equal((await engine.state()).monitors[0].enabled, false);
  await engine.dispatch({type: 'set-search-enabled', id: a.id, enabled: true});
  await engine.dispatch({type: 'stop-all'});
  const value = await engine.state();
  assert.ok(value.searches.every(search => !search.enabled));
  assert.ok(value.monitors.every(monitor => !monitor.enabled));
});

test('failed search emails are recorded without failing location checks or automatically resending', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {apiKey: 'test', enabled: false};
  await engine.dispatch({type: 'save-profile', profile: {email: 'holder@example.com'}});
  const search = await saveSearch(engine, 'default', id);
  await engine.dispatch({type: 'set-search-enabled', id: search.id, enabled: true});
  await waitForSearch(engine, value => value.monitors[0].checks === 1);
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => { sends++; throw new Error('offline'); };
  try {
    api.pageSamples = [{id: 'a', text: 'Apply Now'}];
    await engine.check(id);
    const value = await waitForSearch(engine, value => value.searches[0].activity[0]?.status === 'failed');
    assert.equal(value.monitors[0].error, null);
    assert.match(value.searches[0].activity[0].message, /Resend/);
    await engine.check(id);
    assert.equal(sends, 1);
    await engine.dispatch({type: 'stop-all'});
  } finally { globalThis.fetch = original; }
});

test('auto-apply snapshots the search profile, and combined email includes its outcome', async () => {
  const {api, engine, id, core} = await setup();
  const {EMAIL_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {apiKey: 'test', enabled: false};
  await engine.dispatch({type: 'save-profile', name: 'Alex', profile: {firstName: 'Alex', lastName: 'Example', phone: '+31612345678', email: 'alex@example.com', maxRent: '1500', moveInFrom: '2026-11-02'}});
  const search = await saveSearch(engine, 'default', id, {actions: {email: true, autoApply: true}});
  await engine.dispatch({type: 'set-search-enabled', id: search.id, enabled: true});
  await waitForSearch(engine, value => value.monitors[0].checks === 1);
  const baseRead = api.scripting.executeScript;
  const baseGet = api.tabs.get;
  api.tabs.get = async tabId => tabId === 8 ? {id: 8, url: core.DEFAULT_URL.replace('floorplans.aspx', 'oleapplication.aspx'), status: 'complete'} : baseGet(tabId);
  let inspected;
  const blocked = new Promise(resolve => { inspected = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const filled = [];
  api.scripting.executeScript = async options => {
    if (options.func.name === 'readPage') return baseRead(options);
    if (options.func.name === 'applicationStep') {
      if (!options.args[0]) { inspected(); await gate; }
      return [{result: {kind: 'missing', message: 'Needs documents', key: 'applicant'}}];
    }
    if (options.func.name === 'fillApplicationForm') filled.push(options.args[0]);
    return [{result: {count: 1}}];
  };
  const original = globalThis.fetch;
  const emails = [];
  globalThis.fetch = async (url, options) => { emails.push(JSON.parse(options.body)); return {ok: true, json: async () => ({id: 'sent'})}; };
  try {
    api.pageSamples = [{id: 'a', name: 'Studio A', text: 'Apply Now', rent: '1200'}];
    await engine.check(id);
    await blocked;
    await engine.dispatch({type: 'save-profile', name: 'Changed', profile: {firstName: 'Changed', email: 'changed@example.com'}});
    release();
    const value = await waitForSearch(engine, value => value.searches[0].activity.some(item => item.status === 'sent'));
    assert.equal(filled[0].firstName, 'Alex');
    assert.equal(filled[0].maxRent, '1500');
    assert.equal(filled[0].moveInFrom, '2026-11-02');
    assert.deepEqual(emails[0].to, ['alex@example.com']);
    assert.match(emails[0].text, /Needs documents/);
    assert.equal(value.searches[0].activity.find(item => item.channel === 'autoApply').status, 'review');
    await engine.check(id);
    assert.equal(filled.length, 1);
    await engine.dispatch({type: 'stop-all'});
  } finally { release(); globalThis.fetch = original; }
});

test('auto-applications queue separately per profile and pausing cancels unstarted work', async () => {
  const {api, engine, id} = await setup();
  const contact = {firstName: 'Alex', lastName: 'Example', phone: '+31612345678', email: 'alex@example.com'};
  await engine.dispatch({type: 'save-profile', name: 'Alex', profile: contact});
  const a = await saveSearch(engine, 'default', id, {actions: {autoApply: true}});
  await engine.dispatch({type: 'create-profile'});
  const secondId = (await engine.dispatch({type: 'profiles'})).activeId;
  await engine.dispatch({type: 'save-profile', name: 'Bea', profile: {...contact, firstName: 'Bea', email: 'bea@example.com'}});
  const b = await saveSearch(engine, secondId, id, {actions: {autoApply: true}});
  await engine.dispatch({type: 'set-search-enabled', id: a.id, enabled: true});
  await waitForSearch(engine, value => value.monitors[0].checks === 1);
  await engine.dispatch({type: 'set-search-enabled', id: b.id, enabled: true});
  const baseRead = api.scripting.executeScript;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const applicants = [];
  api.scripting.executeScript = async options => {
    if (options.func.name === 'readPage') return baseRead(options);
    if (options.func.name === 'applicationStep') {
      applicants.push((await engine.state()).monitors[0].application.applicantName);
      started();
      await gate;
      return [{result: {kind: 'verification', message: 'Complete verification'}}];
    }
    return [{result: {}}];
  };
  try {
    api.pageSamples = [{id: 'unit', name: 'Studio A', text: 'Apply Now'}];
    await engine.check(id);
    await entered;
    assert.deepEqual(applicants, ['Alex']);
    await engine.dispatch({type: 'set-search-enabled', id: b.id, enabled: false});
    release();
    await waitForSearch(engine, value => value.searches.find(s => s.id === b.id).activity[0]?.status === 'cancelled');
    assert.deepEqual(applicants, ['Alex']);
    await engine.dispatch({type: 'set-search-enabled', id: b.id, enabled: true});
    await engine.check(id);
    await waitForSearch(engine, value => value.searches.find(s => s.id === b.id).activity.some(item => item.status === 'review'));
    assert.deepEqual(applicants, ['Alex', 'Bea']);
    await engine.dispatch({type: 'stop-all'});
  } finally { release(); }
});

test('exclusions explain budget and size gaps, unknown details and unavailable apartments', async () => {
  const {preferenceMatch} = await import('../SpotAlert/chrome_extension/preferences.js');
  const {exclusionReasons} = await import('../SpotAlert/chrome_extension/searches.js');
  const result = preferenceMatch({rent: '€1,550', size: '23 m²', apartmentType: '1-bedroom'}, {maxRent: '1400', minSize: '30', preferredApartmentType: 'studio'});
  assert.match(result.reasons.join(' '), /€150 over budget/);
  assert.match(result.reasons.join(' '), /7 m² below minimum/);
  assert.match(result.reasons.join(' '), /wants studio/);
  assert.deepEqual(preferenceMatch({}, {maxRent: '1400', minSize: '30'}).reasons, ['Rent not published', 'Size not published']);
  assert.deepEqual(exclusionReasons({matched: false, ruleMatched: false, preferenceReasons: result.reasons}), ['Not currently available']);
  assert.deepEqual(exclusionReasons({ruleMatched: true, matched: false, preferenceReasons: result.reasons}), result.reasons);
  assert.equal(preferenceMatch({rent: '€1.250,00 - €1.600,00', size: '323 sq ft'}, {maxRent: '1500', minSize: '30'}).included, false);
});

test('preflight reports location-specific details, account credentials and email setup', async () => {
  const {searchReadiness} = await import('../SpotAlert/chrome_extension/searches.js');
  const contact = {firstName: 'Alex', lastName: 'Example', phone: '+31612345678', email: 'alex@example.com'};
  const search = {profileId: 'p', locationIds: ['ourdomain-amsterdam-diemen', 'canvas-rotterdam-blaak'], actions: {autoApply: true, email: true}};
  const report = searchReadiness(search, [{id: 'p', details: contact}], {apiKey: 'test'});
  assert.equal(report.canStart, true);
  assert.equal(report.ready, false);
  assert.ok(report.locations[0].missing.includes('Street address'));
  assert.ok(!report.locations[0].missing.includes('University'));
  assert.ok(report.locations[1].missing.includes('University'));
  assert.ok(report.locations[1].missing.includes('Middle name'));
  assert.match(report.warnings.join(' '), /verified sender/);
  const blocked = searchReadiness({...search, createAccount: true}, [{id: 'p', details: contact}], {});
  assert.equal(blocked.canStart, false);
  assert.match(blocked.blockers.join(' '), /password/);
  assert.match(blocked.blockers.join(' '), /API key/);
  const noMiddle = searchReadiness(search, [{id: 'p', details: {...contact, noMiddleName: 'Yes'}}], {apiKey: 'test'});
  assert.ok(!noMiddle.locations[1].missing.includes('Middle name'));
});

test('starting can change actions independently and rejects unsupported SMS or stale dialog settings', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {apiKey: 'test'};
  await engine.dispatch({type:'save-profile', profile:{firstName:'Alex', lastName:'Example', email:'alex@example.com', phone:'+31612345678'}});
  const search = await saveSearch(engine, 'default', id);
  await assert.rejects(engine.dispatch({type:'set-search-enabled', id:search.id, enabled:true, actions:{sms:true}}), /SMS is unavailable/);
  await assert.rejects(engine.dispatch({type:'set-search-enabled', id:search.id, enabled:true, actions:{}}), /Choose email/);
  await assert.rejects(engine.dispatch({type:'set-search-enabled', id:search.id, enabled:true, expectedGeneration:'stale', actions:{autoApply:true}}), /search changed/);
  await engine.dispatch({type:'set-search-enabled', id:search.id, enabled:true, expectedGeneration:search.generation, actions:{autoApply:true, email:false}});
  const saved = (await engine.state()).searches[0];
  assert.equal(saved.actions.autoApply, true);
  assert.equal(saved.actions.email, false);
  await engine.dispatch({type:'stop-all'});
  api.allowed = false;
  const readiness = await engine.dispatch({type:'search-readiness', id:search.id, actions:{email:true}});
  assert.equal(readiness.canStart, false);
  assert.match(readiness.blockers.join(' '), /website access/);
});

test('duplicate action records survive deletion and require one explicit, fresh authorization', async () => {
  const {api, engine, id, core} = await setup();
  const {EMAIL_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  const {searchClaimKey} = await import('../SpotAlert/chrome_extension/searches.js');
  api.data[EMAIL_KEY] = {apiKey:'test', enabled:false};
  await engine.dispatch({type:'save-profile', profile:{email:'holder@example.com'}});
  const first = await saveSearch(engine, 'default', id);
  await engine.dispatch({type:'set-search-enabled', id:first.id, enabled:true});
  await waitForSearch(engine, value => value.monitors[0].checks === 1);
  const original = globalThis.fetch;
  const requests = [];
  let finish;
  let pending = null;
  globalThis.fetch = async (url, options) => {
    requests.push(options.headers['Idempotency-Key']);
    if (pending) await pending;
    return {ok:true, json:async()=>({id:'sent'})};
  };
  try {
    api.pageSamples = [{id:'a', name:'Studio A', text:'Apply Now'}];
    await engine.check(id);
    let state = await waitForSearch(engine, value => value.searches[0].activity[0]?.status === 'sent');
    const key = searchClaimKey('default', id, 'a', 'email');
    const prior = state.searchClaims[key];
    assert.equal(prior.status, 'sent');
    assert.equal(prior.listingName, 'Studio A');
    assert.equal(prior.at, 1000000);
    await engine.dispatch({type:'delete-search', id:first.id});
    assert.equal((await engine.state()).searchClaims[key].id, prior.id);
    const second = await saveSearch(engine, 'default', id);
    await engine.dispatch({type:'set-search-enabled', id:second.id, enabled:true});
    await waitForSearch(engine, value => value.searches[0].results[id]);
    assert.equal(requests.length, 1, 'new searches retain duplicate protection');
    const retry = {type:'repeat-search-action', id:second.id, monitorId:id, listingId:'a', channel:'email', expectedClaimId:prior.id};
    await assert.rejects(engine.dispatch(retry), /explicitly authorize/);
    await assert.rejects(engine.dispatch({...retry, confirmed:true, expectedClaimId:'stale'}), /previous action changed/);
    pending = new Promise(resolve=>{finish=resolve;});
    await engine.dispatch({...retry, confirmed:true});
    await assert.rejects(engine.dispatch({...retry, confirmed:true}), /previous action changed/);
    finish();
    state = await waitForSearch(engine, value => value.searchClaims[key].status === 'sent' && value.searchClaims[key].id !== prior.id);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0], requests[1]);
    assert.equal(state.searches[0].activity[0].repeatedFrom, prior.id);
    await engine.check(id);
    assert.equal(requests.length, 2);
    // A stale result cannot be used to deliberately start another action.
    const currentId = state.searchClaims[key].id;
    api.data[core.STORAGE_KEY].searches[0].results[id].at = 1;
    await assert.rejects(engine.dispatch({...retry, expectedClaimId:currentId, confirmed:true}), /fresh location check/);
    await engine.dispatch({type:'stop-all'});
  } finally { finish?.(); globalThis.fetch = original; }
});

test('legacy duplicate claims migrate to visible records without releasing their protection', async () => {
  const {api, engine, core, createEngine} = await setup();
  const {searchClaimKey} = await import('../SpotAlert/chrome_extension/searches.js');
  const key = searchClaimKey('default', 'ourdomain-amsterdam-diemen', 'a', 'email');
  api.data[core.STORAGE_KEY].searchClaims[key] = 'old-email';
  const restarted = createEngine(api, () => 1000000);
  await restarted.initialize();
  const claim = (await restarted.state()).searchClaims[key];
  assert.equal(claim.id, 'old-email');
  assert.equal(claim.status, 'recorded');
  assert.equal(claim.at, null);
  await engine.dispatch({type:'stop-all'});
});

test('another automatic application requires the matching profile, active channel and a fresh result', async () => {
  const {api, engine, id, core} = await setup();
  const {searchClaimKey} = await import('../SpotAlert/chrome_extension/searches.js');
  await engine.dispatch({type:'save-profile', name:'Alex', profile:{firstName:'Alex', lastName:'Example', email:'alex@example.com', phone:'+31612345678'}});
  const search = await saveSearch(engine, 'default', id, {actions:{autoApply:true}});
  await engine.dispatch({type:'set-search-enabled', id:search.id, enabled:true});
  await waitForSearch(engine, value => value.monitors[0].checks === 1);
  const key = searchClaimKey('default', id, 'a', 'autoApply');
  api.data[core.STORAGE_KEY].searchClaims[key] = {id:'previous-application', at:999000, status:'interrupted', message:'Check the prior application tab.'};
  api.data[core.STORAGE_KEY].searches[0].results[id] = {at:1000000, matches:[{id:'a', name:'Studio A', text:'Apply Now', matched:true, ruleMatched:true}]};
  const baseRead = api.scripting.executeScript;
  let attempts = 0;
  api.scripting.executeScript = async options => {
    if (options.func.name === 'readPage') return baseRead(options);
    if (options.func.name === 'applicationStep') { attempts++; return [{result:{kind:'verification', message:'Needs verification'}}]; }
    return [{result:{}}];
  };
  const repeat = {type:'repeat-search-action', id:search.id, channel:'autoApply', monitorId:id, listingId:'a', expectedClaimId:'previous-application', confirmed:true};
  await assert.rejects(engine.dispatch({...repeat, channel:'email'}), /action enabled/);
  await assert.rejects(engine.dispatch({...repeat, monitorId:'canvas-rotterdam-blaak'}), /not part of the search/);
  await engine.dispatch(repeat);
  const value = await waitForSearch(engine, value => value.searchClaims[key].status === 'review');
  assert.equal(attempts, 1);
  assert.equal(value.searchClaims[key].attemptCount, 2);
  assert.equal(value.searchClaims[key].previousAttempts[0].status, 'interrupted');
  assert.equal(value.searchClaims[key].previousAttempts[0].id, 'previous-application');
  await assert.rejects(engine.dispatch(repeat), /previous action changed/);
  await engine.dispatch({type:'stop-all'});
});

test('cancelling an authorized repeat before it runs restores the original duplicate protection', async () => {
  const {api, engine, id, core} = await setup();
  const {EMAIL_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  const {searchClaimKey} = await import('../SpotAlert/chrome_extension/searches.js');
  api.data[EMAIL_KEY] = {apiKey:'test',enabled:false};
  await engine.dispatch({type:'save-profile', profile:{email:'holder@example.com'}});
  const search = await saveSearch(engine, 'default', id);
  await engine.dispatch({type:'set-search-enabled', id:search.id, enabled:true});
  await waitForSearch(engine, value => value.monitors[0].checks === 1);
  const key = searchClaimKey('default', id, 'b', 'email');
  const prior = {id:'already-sent',at:999000,status:'sent',message:'Previously sent'};
  api.data[core.STORAGE_KEY].searchClaims[key] = prior;
  const original = globalThis.fetch;
  let release;
  const gate = new Promise(resolve=>{release=resolve;});
  let started;
  const entered = new Promise(resolve=>{started=resolve;});
  let sends = 0;
  globalThis.fetch = async () => { sends++; started(); await gate; return {ok:true,json:async()=>({id:'sent'})}; };
  try {
    api.pageSamples = [{id:'a',text:'Apply Now'}, {id:'b',text:'Apply Now'}];
    await engine.check(id);
    await entered;
    await engine.dispatch({type:'repeat-search-action',id:search.id,monitorId:id,listingId:'b',channel:'email',expectedClaimId:prior.id,confirmed:true});
    await engine.dispatch({type:'set-search-enabled',id:search.id,enabled:false});
    release();
    await waitForSearch(engine, value => value.searches[0].activity.some(action=>action.channel==='email' && action.listingId==='b' && action.status==='cancelled'));
    assert.deepEqual((await engine.state()).searchClaims[key], prior);
    await engine.dispatch({type:'set-search-enabled',id:search.id,enabled:true});
    await engine.check(id);
    assert.equal(sends,1,'resuming must not repeat the previously delivered email');
    await engine.dispatch({type:'stop-all'});
  } finally { release(); globalThis.fetch=original; }
});

test('Monitoring never sends general alerts, including after migrating enabled legacy settings', async () => {
  const {api, engine, core, createEngine, id} = await setup();
  const {EMAIL_KEY, CONTACT_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  const legacy = await engine.state();
  legacy.alertPreferences = {notify:true,popup:true,desktop:true,sound:true};
  legacy.monitors[0].notify = true;
  legacy.monitors[0].sound = true;
  legacy.monitors[0].alert = {id:'old-alert',at:1000000,listings:[{text:'Apply Now'}]};
  legacy.monitors[0].pendingArrivals = [{text:'Apply Now'}];
  api.data[core.STORAGE_KEY] = legacy;
  api.data[EMAIL_KEY] = {apiKey:'test',enabled:true};
  api.data[CONTACT_KEY] = {email:'legacy-recipient@example.com'};
  const restarted = createEngine(api,()=>1000000);
  await restarted.initialize();
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {sends++;throw new Error('Monitoring must not send email');};
  try {
    api.pageSamples = [{id:'a',text:'Apply Now'}];
    await restarted.check(id);
    await restarted.check(id);
    const state = await restarted.state();
    assert.equal(state.monitors[0].available,true);
    assert.equal(state.monitors[0].alert,null);
    assert.deepEqual(state.monitors[0].pendingArrivals,[]);
    assert.equal(state.alertPreferences.notify,false);
    assert.equal(api.notificationsLog.length,0);
    assert.equal(sends,0);
    await assert.rejects(restarted.dispatch({type:'set-alerts',notify:true,sound:true}), /per profile search/);
    const manifest=JSON.parse(fs.readFileSync('SpotAlert/chrome_extension/manifest.json'));
    assert.ok(!manifest.permissions.includes('notifications'));
    assert.ok(manifest.permissions.includes('offscreen'), 'Detached listing parser needs DOM_PARSER; monitoring does not use audio');
    assert.equal(manifest.content_scripts,undefined);
  } finally {globalThis.fetch=original;}
});

test('searches use live profile criteria and re-evaluate results immediately after a profile edit', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {apiKey:'test'};
  const profile = {email:'alex@example.com',maxRent:'1400',minSize:'30',preferredApartmentType:'studio',moveInFrom:'2026-11-02'};
  await engine.dispatch({type:'save-profile',profile});
  const search = await saveSearch(engine,'default',id,{preferences:{maxRent:'9999',minSize:'1',preferredApartmentType:'1-bedroom'}});
  assert.equal(Object.hasOwn(search,'preferences'),false);
  await engine.dispatch({type:'set-search-enabled',id:search.id,enabled:true});
  await waitForSearch(engine,value=>value.monitors[0].checks===1);
  api.pageSamples = [{id:'a',text:'Apply Now',rent:'€1200',size:'32 m²',beds:'Studio'}];
  const original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>({id:'sent'})});
  try {
    await engine.check(id);
    await waitForSearch(engine,value=>value.searches[0].activity[0]?.status==='sent');
    const checks=(await engine.state()).monitors[0].checks;
    assert.equal((await engine.state()).searches[0].results[id].matches[0].matched,true);
    await engine.dispatch({type:'save-profile',profile:{...profile,minSize:'35'}});
    const state=await engine.state();
    assert.equal(state.monitors[0].checks,checks,'profile changes do not require an extra website request');
    assert.equal(state.searches[0].results[id].matches[0].matched,false);
    assert.match(state.searches[0].results[id].matches[0].preferenceReasons.join(' '),/3 m² below minimum/);
    assert.equal(state.monitors[0].available,true,'Monitoring remains independent of profile criteria');
    await engine.dispatch({type:'save-profile',profile:{...profile,maxRent:'900'}});
    assert.match((await engine.state()).searches[0].results[id].matches[0].preferenceReasons.join(' '),/€300 over budget/);
    await engine.dispatch({type:'stop-all'});
  } finally {globalThis.fetch=original;}
});

test('migrating copied search preferences preserves profiles and matches against their current criteria', async () => {
  const {api,engine,core,createEngine,id}=await setup();
  const {EMAIL_KEY}=await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY]={apiKey:'test'};
  await engine.dispatch({type:'save-profile',profile:{email:'alex@example.com',maxRent:'1400'}});
  await saveSearch(engine,'default',id);
  const legacy=await engine.state();
  legacy.searches[0].preferences={maxRent:'900'};
  legacy.searches[0].results[id]={at:1000000,matches:[{id:'a',text:'Apply Now',rent:'€1200',matched:false,preferenceReasons:['Over budget']}]};
  api.data[core.STORAGE_KEY]=legacy;
  const restarted=createEngine(api,()=>1000000);
  await restarted.initialize();
  const migrated=(await restarted.state()).searches[0];
  assert.equal(Object.hasOwn(migrated,'preferences'),false);
  assert.equal(migrated.results[id].matches[0].matched,true);
  assert.equal((await restarted.dispatch({type:'profiles'})).profiles[0].details.maxRent,'1400');
});

test('Settings test email requires a selected profile and never falls back to the old general recipient', async () => {
  const {api,engine}=await setup();
  const {EMAIL_KEY,CONTACT_KEY}=await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY]={apiKey:'test',sender:'sender@example.com',enabled:false};
  api.data[CONTACT_KEY]={email:'legacy@example.com'};
  await engine.dispatch({type:'save-profile',profile:{email:'alex@example.com'}});
  await assert.rejects(engine.dispatch({type:'test-email'}),/Select a saved profile/);
  await assert.rejects(engine.dispatch({type:'test-email',profileId:'missing'}),/Select a saved profile/);
  const original=globalThis.fetch;
  const bodies=[];
  globalThis.fetch=async(url,options)=>{bodies.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:'test'})};};
  try {
    await engine.dispatch({type:'test-email',profileId:'default'});
    assert.equal(bodies.length,1);
    assert.deepEqual(bodies[0].to,['alex@example.com']);
    assert.equal(bodies[0].from,'sender@example.com');
  } finally {globalThis.fetch=original;}
});

test('password generation leaves identity data separate from fictional test applicants', async () => {
  const {generateRegistrationPassword, validateProfile, profileCompleteness} = await import('../SpotAlert/chrome_extension/profile.js');
  const {createTestProfile} = await import('../SpotAlert/chrome_extension/test-profiles.js');
  const password = generateRegistrationPassword();
  assert.equal(typeof password, 'string');
  assert.match(password, /^Aa7!.{24}$/);
  const first = createTestProfile(1), second = createTestProfile(2);
  assert.notEqual(first.id, second.id);
  for (const entry of [first, second]) {
    assert.equal(entry.testProfile, true);
    assert.match(entry.name, /^Test profile [12] · /);
    assert.match(entry.details.email, /@example\.com$/);
    assert.deepEqual(validateProfile(entry.details), entry.details);
    assert.equal(profileCompleteness(entry.details).ready, true);
    assert.equal(entry.details.socialSecurityNumber, '');
    assert.equal(entry.details.iban, '');
  }
  assert.notEqual(first.details.registrationPassword, second.details.registrationPassword);
});

test('creating two test profiles preserves real applicants and edits across repeated requests and restarts', async () => {
  const [, {createEngine}] = await modules;
  const api = fakeChrome();
  const engine = createEngine(api);
  await engine.initialize();
  await engine.dispatch({type: 'save-profile', name: 'Real applicant', profile: {firstName: 'Actual', dateOfBirth: '1995-03-04'}});
  const original = (await engine.dispatch({type: 'profiles'})).profiles[0];
  let library = await engine.dispatch({type: 'create-test-profiles'});
  assert.equal(library.profiles.length, 3);
  assert.deepEqual(library.profiles[0], original);
  assert.equal(library.profiles.filter(entry => entry.testProfile).length, 2);
  await engine.dispatch({type: 'save-profile', name: 'Test profile 1 edited', profile: {...library.profiles[1].details, firstName: 'Edited'}});
  library = await engine.dispatch({type: 'create-test-profiles'});
  assert.equal(library.profiles.length, 3);
  assert.equal(library.profiles[1].details.firstName, 'Edited');
  const restarted = createEngine(api);
  await restarted.initialize();
  assert.deepEqual(await restarted.dispatch({type: 'profiles'}), library);
  await restarted.dispatch({type: 'select-profile', id: 'spotalert-test-profile-2'});
  await restarted.dispatch({type: 'clear-profile'});
  library = await restarted.dispatch({type: 'create-test-profiles'});
  assert.equal(library.profiles.length, 3);
  assert.equal(library.profiles[1].details.firstName, 'Edited');
  assert.deepEqual(library.profiles[0], original);
});

test('profile readiness provides field targets and leaves optional fields out of required navigation', async () => {
  const {profileCompleteness, requiredProfileFields} = await import('../SpotAlert/chrome_extension/profile.js');
  const result = profileCompleteness({firstName: 'Alex', noMiddleName: 'Yes'});
  assert.ok(result.missingFields.some(field => field.key === 'nationality' && field.label === 'Nationality'));
  assert.ok(!result.missingFields.some(field => ['firstName', 'middleName', 'iban', 'registrationPassword'].includes(field.key)));
  assert.ok(requiredProfileFields({noMiddleName: 'No'}).includes('middleName'));
});

test('attention tasks point to recoverable actions and retire superseded failures', async () => {
  const {attentionItems} = await import('../SpotAlert/chrome_extension/ui.js');
  const {searchClaimKey} = await import('../SpotAlert/chrome_extension/searches.js');
  const profile = {id: 'alex', name: 'Alex', details: {firstName: 'Alex'}};
  const failed = {id: 'failed', at: 1, listingId: 'studio', monitorId: 'diemen', channel: 'email', status: 'failed', message: 'Sender rejected'};
  const search = {id: 'search', name: 'Amsterdam', profileId: profile.id, enabled: true, actions: {autoApply: true, email: true}, activity: [failed]};
  const state = {monitors: [{id: 'diemen', name: 'Diemen', error: 'Verification required'}], searches: [search, {...search, id: 'overlap', activity: []}], searchClaims: {}};
  let items = attentionItems(state, {profiles: [profile]});
  assert.equal(items.filter(item => item.action === 'profile').length, 1, 'Overlapping searches share one missing-profile task');
  assert.ok(items.some(item => item.action === 'location' && item.monitorId === 'diemen'));
  assert.ok(items.some(item => item.label === 'Review email failure' && item.section === 'search-activity'));
  const sent = {...failed, id: 'sent', at: 2, status: 'sent'};
  search.activity.unshift(sent);
  state.searchClaims[searchClaimKey(profile.id, 'diemen', 'studio', 'email')] = sent;
  items = attentionItems(state, {profiles: [profile]});
  assert.ok(!items.some(item => item.channel === 'email'), 'A successful repeat resolves the older email failure');
  search.activity.unshift({...failed, id: 'application', at: 3, channel: 'autoApply', status: 'review', tabId: 8});
  items = attentionItems(state, {profiles: [profile]});
  assert.ok(items.some(item => item.action === 'application' && item.tabId === 8));
});

test('regenerating realistic fixtures preserves actual applicant details', async () => {
  const [, {createEngine}] = await modules;
  const engine = createEngine(fakeChrome());
  await engine.initialize();
  await engine.dispatch({type:'save-profile', name:'Actual applicant', profile:{firstName:'Actual'}});
  const original = (await engine.dispatch({type:'profiles'})).profiles[0];
  const before = await engine.dispatch({type:'create-test-profiles'});
  const after = await engine.dispatch({type:'create-test-profiles',regenerate:true});
  assert.equal(after.profiles.length,3);
  assert.deepEqual(after.profiles[0],original);
  for (let index=1;index<=2;index++) {
    const details=after.profiles[index].details;
    assert.notEqual(details.registrationPassword,before.profiles[index].details.registrationPassword);
    assert.ok(!details.lastName.includes('Example'));
    assert.equal(details.employerCity,details.city);
    assert.ok(Number(details.monthlyIncome)>Number(details.maxRent)*2);
    assert.match(details.phone,/^\+316\d{8}$/);
    assert.match(details.postalCode,/^\d{4} [A-Z]{2}$/);
  }
});

test('Canvas retries an empty injection result without treating it as missing site access', async () => {
  const {api,engine}=await setup();
  const canvas=(await engine.state()).monitors.find(item=>item.id==='canvas-rotterdam-blaak');
  api.url=canvas.url; api.pageSamples=[{index:1,text:'Check availability',name:'Studio'}];
  const original=api.scripting.executeScript;
  let reads=0;
  api.scripting.executeScript=async options=>{
    if(options.func.name==='readPage' && ++reads===1) return [{frameId:0}];
    if(options.func.name==='inspectReadState') return [{frameId:0,result:{verification:false,login:false}}];
    return original(options);
  };
  await engine.check(canvas.id);
  const result=(await engine.state()).monitors.find(item=>item.id===canvas.id);
  assert.equal(reads,2); assert.equal(result.error,null); assert.equal(result.available,true);
});

test('persistent empty page reads preserve results and report loading rather than permissions', async () => {
  const {api,engine,id}=await setup();
  api.pageSamples=[{index:1,text:'Apply Now',name:'Studio'}];
  await engine.check(id);
  api.scripting.executeScript=async options=>options.func.name==='inspectReadState' ? [{result:{verification:false,login:false}}] : [];
  await engine.check(id);
  const result=(await engine.state()).monitors.find(item=>item.id===id);
  assert.equal(result.errorKind,'loading');
  assert.match(result.error,/no page data after retrying/);
  assert.equal(result.available,true);
  assert.ok(!result.error.includes('permissions'));
});

test('an empty result on a verification screen identifies the actual website prompt', async () => {
  const {api,engine,id}=await setup();
  api.scripting.executeScript=async options=>options.func.name==='inspectReadState' ? [{result:{verification:true,login:false}}] : [];
  await engine.check(id);
  assert.equal((await engine.state()).monitors.find(item=>item.id===id).errorKind,'verification');
});

test('actual Chrome scripting permission errors remain permission errors', async () => {
  const {api,engine,id}=await setup();
  api.scripting.executeScript=async ()=>{throw new Error('Cannot access contents of url. Extension manifest must request permission.');};
  await engine.check(id);
  const result=(await engine.state()).monitors.find(item=>item.id===id);
  assert.equal(result.errorKind,'permission');
  assert.match(result.error,/Site access/);
});

test('a loaded page snapshot returns its data synchronously without an injected Promise', async () => {
  const [, , {readPage}] = await modules;
  const context=vm.createContext({document:{querySelectorAll:()=>{throw new Error('Invalid selector');}}, location:{href:'https://example.com'}});
  const result=vm.runInContext('('+readPage.toString()+')({type:"css",selector:"["},0)',context);
  assert.equal(result.errorKind,'selector');
  assert.equal(typeof result.then,'undefined');
});

test('late listing snapshots wait in the worker and cancellation stops further injections', async () => {
  const {api,engine,id}=await setup();
  const original=api.scripting.executeScript;
  let reads=0;
  api.scripting.executeScript=async options=>{
    if(options.func.name==='readPage') {
      reads++;
      assert.equal(options.args[1],0);
      if(reads===1) return [{result:{pending:true,error:'Still loading',errorKind:'loading'}}];
    }
    return original(options);
  };
  await engine.check(id);
  assert.equal(reads,2);
  assert.equal((await engine.state()).monitors.find(item=>item.id===id).error,null);
  reads=0;
  api.scripting.executeScript=async ()=>{reads++;return [{result:{pending:true,error:'Still loading',errorKind:'loading'}}];};
  const pending=engine.check(id);
  while(reads<1) await new Promise(resolve=>setTimeout(resolve,1));
  await engine.dispatch({type:'stop-all'});
  await pending;
  assert.equal(reads,1);
});


test('one activity timeline deduplicates current records and retains previous attempts once', async () => {
  const {mergeActionHistory, cleanError}=await import('../SpotAlert/chrome_extension/ui.js');
  const previous={id:'first',at:1,status:'failed'};
  const current={id:'second',at:2,status:'sent',previousAttempts:[previous]};
  const unclaimed={id:'cancelled',at:3,status:'cancelled'};
  const timeline=mergeActionHistory([current],[previous,current,unclaimed,unclaimed]);
  assert.deepEqual(timeline,[unclaimed,current]);
  assert.deepEqual(timeline[1].previousAttempts,[previous]);
  assert.equal(cleanError('Canvas','https://example.com','Canvas (example.com): No page data.'),'No page data.');
  assert.equal(cleanError('Canvas','https://example.com','Provider error: detail'),'Provider error: detail');
});

test('diagnostics allowlists metadata and masks credentials, URLs and email addresses', async () => {
  const {diagnosticReport, diagnosticText} = await import('../SpotAlert/chrome_extension/diagnostics.js');
  const report = diagnosticReport({profiles: [{password: 'private-profile'}], apiKey: 'private-setting', monitors: [{id: 'canvas', url: 'https://canvas.example/private?token=secret', error: 'Failed https://canvas.example/private?token=secret contact alex@example.com Bearer private-auth apiKey=private-key', history: Array.from({length: 15}, (_, at) => ({at, kind: 'error', message: 'private-history'})), samples: ['private-page']}], searches: [{id: 'search', activity: [{status: 'failed', message: 'private-delivery', email: 'private-recipient'}]}]}, [{at: 1, operation: 'check', message: 'password=private-password'}], {version: '1'});
  const text = JSON.stringify(report);
  for (const secret of ['private-profile', 'private-setting', 'private-auth', 'private-key', 'private-password', 'private-page', 'private-history', 'private-delivery', 'private-recipient', 'alex@example.com', '?token=secret', '/private']) assert.ok(!text.includes(secret), secret);
  assert.equal(report.locations[0].site, 'canvas.example');
  assert.equal(report.locations[0].recentEvents.length, 10);
  assert.equal(report.locations[0].recentEvents[0].at, 0);
  assert.equal(diagnosticText('re_supersecret'), '[credential omitted]');
  assert.equal(diagnosticReport({}, Array.from({length: 25}, (_, at) => ({at}))).recentErrors.length, 20);
});


test('result status distinguishes pending, failed, outdated and genuine empty results', async () => {
  const {resultStatus, monitoringScope, errorRecovery} = await import('../SpotAlert/chrome_extension/ui.js');
  const monitor = {id: 'location', enabled: true, searchManaged: true, lastCheckedAt: 100000, intervalSeconds: 30, samples: []};
  assert.equal(resultStatus(monitor, undefined, 100001).label, 'No availability');
  assert.equal(resultStatus(monitor, {at: 100000, matches: []}, 100001).label, 'No matches');
  assert.equal(resultStatus(monitor, null, 100001).kind, 'unchecked');
  assert.equal(resultStatus(monitor, undefined, 200001).kind, 'outdated');
  assert.equal(resultStatus({...monitor, error: 'failed'}, undefined, 100001).kind, 'failed');
  assert.equal(resultStatus({...monitor, phase: 'reading', error: 'old failure'}).kind, 'checking');
  const scope = monitoringScope(monitor, [{enabled: true, locationIds: ['location']}]);
  assert.equal(scope.general, false); assert.equal(scope.searches.length, 1);
  assert.match(errorRecovery('verification'), /complete verification/);
});

test('general monitoring and profile searches can be stopped independently', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {apiKey: 'test'};
  await engine.dispatch({type: 'save-profile', profile: {email: 'a@example.com'}});
  const search = await saveSearch(engine, 'default', id);
  await engine.dispatch({type: 'start', id});
  await engine.dispatch({type: 'set-search-enabled', id: search.id, enabled: true});
  await engine.dispatch({type: 'set-search-enabled', id: search.id, enabled: false});
  assert.equal((await engine.state()).monitors[0].enabled, true, 'general monitoring continues');
  await engine.dispatch({type: 'set-search-enabled', id: search.id, enabled: true});
  await engine.dispatch({type: 'pause', id});
  let value = await engine.state();
  assert.equal(value.searches[0].enabled, true);
  assert.equal(value.monitors[0].searchManaged, true);
  await engine.dispatch({type: 'cancel-check', id});
  value = await engine.state();
  assert.equal(value.monitors[0].enabled, true);
  assert.ok(value.monitors[0].nextCheckAt, 'cancellation preserves the next scheduled check');
  await engine.dispatch({type: 'set-search-enabled', id: search.id, enabled: false});
  assert.equal((await engine.state()).monitors[0].enabled, false);
});

test('Cancel check aborts a reload, retains successful results and keeps general monitoring scheduled', async () => {
  const {engine, api, id} = await setup();
  await engine.setEnabled(id, true);
  const before = (await engine.state()).monitors[0];
  api.completeReload = false;
  const count = api.reloads.length;
  const pending = engine.check(id);
  while (api.reloads.length === count) await new Promise(resolve => setTimeout(resolve, 1));
  await engine.dispatch({type: 'cancel-check', id});
  await pending;
  const after = (await engine.state()).monitors[0];
  assert.equal(after.enabled, true);
  assert.equal(after.phase, 'waiting');
  assert.equal(after.checks, before.checks);
  assert.deepEqual(after.samples, before.samples);
  assert.ok(after.nextCheckAt);
  assert.equal(api.tabs.onUpdated.listeners.size, 0);
  await engine.dispatch({type: 'pause', id});
});

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

test('background reader fetches without cache, uses a detached parser and rejects incomplete data', async () => {
  const {readBackground} = await import('../SpotAlert/chrome_extension/background-reader.js');
  const {api, engine, id} = await setup();
  const monitor = (await engine.state()).monitors.find(item => item.id === id);
  const result = {url: monitor.url, samples: [{id: 'floorplan:1', name: 'Studio', text: 'Apply Now'}]};
  backgroundFixture(api, result);
  let options;
  const fetcher = async (url, config) => { options = config; return htmlResponse(url); };
  assert.deepEqual((await readBackground(api, monitor, new AbortController().signal, fetcher)).result, result);
  assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error');
  assert.ok(api.parserCreated && api.parsedHtml);
  const incomplete = {...monitor, knownFloorplans: [{id: 'floorplan:missing'}]};
  assert.match((await readBackground(api, incomplete, new AbortController().signal, fetcher)).fallback, /omits/);
  assert.match((await readBackground(api, monitor, new AbortController().signal, async url => htmlResponse(url, '', 403))).fallback, /HTTP 403/);
  assert.match((await readBackground(api, monitor, new AbortController().signal, async () => htmlResponse('https://other.example/'))).fallback, /changed page/);
});

test('background reader rejects oversized payloads and supports cancellation during parsing', async () => {
  const {readBackground} = await import('../SpotAlert/chrome_extension/background-reader.js');
  const {api, engine} = await setup(); const monitor = (await engine.state()).monitors[0];
  backgroundFixture(api, {samples: []});
  const oversized = await readBackground(api, monitor, new AbortController().signal, async url => htmlResponse(url, 'x'.repeat(2_000_001)));
  assert.match(oversized.fallback, /size limit/);
  let parsing; const started = new Promise(resolve => { parsing = resolve; });
  api.runtime.sendMessage = () => { parsing(); return new Promise(() => {}); };
  const controller = new AbortController();
  const pending = readBackground(api, monitor, controller.signal, async url => htmlResponse(url));
  await started; controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('hybrid checks avoid tab reloads on success and use browser fallback with a cooldown', async () => {
  const {api, engine, id} = await setup();
  const original = globalThis.fetch;
  const samples = [{id: 'floorplan:1', name: 'Studio', text: 'Apply Now'}];
  backgroundFixture(api, {url: api.url, samples});
  let requests = 0;
  globalThis.fetch = async url => { requests++; return htmlResponse(url); };
  try {
    await engine.check(id);
    let monitor = (await engine.state()).monitors[0];
    assert.equal(monitor.readMethod, 'background'); assert.equal(monitor.available, true); assert.equal(api.reloads.length, 0);
    api.runtime.sendMessage = async () => ({fallback: 'Direct HTML has incomplete floor plans'});
    await engine.check(id);
    monitor = (await engine.state()).monitors[0];
    assert.equal(monitor.readMethod, 'browser'); assert.match(monitor.readFallbackReason, /incomplete/); assert.equal(api.reloads.length, 1);
    const count = requests; await engine.check(id);
    assert.equal(requests, count); assert.equal(api.reloads.length, 2);
    assert.ok(monitor.backgroundRetryAt > 1000000);
  } finally { globalThis.fetch = original; }
});

test('Check all covers every building once, shares duplicate requests and leaves schedules unchanged', async () => {
  const {api, engine} = await setup();
  // Return the URL of each selected tab rather than the default fixture's single URL.
  const {SUPPORTED_SITES} = await import('../SpotAlert/chrome_extension/sites/index.js');
  api.tabs.query = async ({url}) => [{id: SUPPORTED_SITES.findIndex(site => url === new URL(site.url).origin + '/*') + 10, status: 'complete', url: SUPPORTED_SITES.find(site => url === new URL(site.url).origin + '/*').url}];
  api.scripting.executeScript = async ({target}) => [{result: {url: SUPPORTED_SITES[target.tabId - 10].url, samples: [{id: 'studio', text: 'Get Notified'}]}}];
  const first = engine.dispatch({type: 'check-all'});
  const second = engine.dispatch({type: 'check-all'});
  await Promise.all([first, second]);
  const value = await engine.state();
  assert.equal(value.checkBatch.status, 'completed');
  assert.equal(value.checkBatch.completed, 3);
  assert.equal(value.checkBatch.failed, 0);
  assert.ok(value.monitors.every(monitor => monitor.checks === 1 && !monitor.enabled));
  assert.equal(api.reloads.length, 3);
});

test('Cancel all checks aborts the current building and skips remaining buildings', async () => {
  const {api, engine} = await setup();
  api.completeReload = false;
  const pending = engine.dispatch({type: 'check-all'});
  while (!api.reloads.length) await new Promise(resolve => setTimeout(resolve, 1));
  await engine.dispatch({type: 'cancel-all-checks'});
  await pending;
  const value = await engine.state();
  assert.equal(value.checkBatch.status, 'cancelled');
  assert.equal(value.checkBatch.completed, 0);
  assert.equal(api.reloads.length, 1);
  assert.ok(value.monitors.every(monitor => !monitor.checks && !monitor.enabled));
});

test('Check all continues after a building fails and restart marks interrupted batches', async () => {
  const {api, engine, createEngine} = await setup();
  api.permissions.contains = async () => false;
  await engine.dispatch({type: 'check-all'});
  let value = await engine.state();
  assert.equal(value.checkBatch.completed, 3);
  assert.equal(value.checkBatch.failed, 3);
  assert.ok(value.monitors.every(monitor => monitor.error));
  value.checkBatch.status = 'running'; value.checkBatch.currentId = value.monitors[0].id;
  const {STORAGE_KEY} = await import('../SpotAlert/chrome_extension/core.js');
  api.data[STORAGE_KEY] = value;
  const restarted = createEngine(api, () => 1000001);
  await restarted.initialize();
  value = await restarted.state();
  assert.equal(value.checkBatch.status, 'interrupted');
  assert.equal(value.checkBatch.currentId, null);
});

test('batch checking validates the requested buildings and checks only the selected subset', async () => {
  const {api, engine} = await setup();
  const {SUPPORTED_SITES} = await import('../SpotAlert/chrome_extension/sites/index.js');
  api.tabs.query = async ({url}) => {
    const index = SUPPORTED_SITES.findIndex(site => url === new URL(site.url).origin + '/*');
    return [{id: index + 10, status: 'complete', url: SUPPORTED_SITES[index].url}];
  };
  api.scripting.executeScript = async ({target}) => [{result: {url: SUPPORTED_SITES[target.tabId - 10].url, samples: [{id: 'studio', text: 'Get Notified'}]}}];
  for (const ids of [[], ['unknown'], 'all', [null]]) await assert.rejects(engine.dispatch({type: 'check-all', ids}), /Select at least one supported building/);
  assert.equal(api.reloads.length, 0);
  const ids = [SUPPORTED_SITES[2].id, SUPPORTED_SITES[0].id, SUPPORTED_SITES[2].id];
  await engine.dispatch({type: 'check-all', ids});
  const value = await engine.state();
  assert.deepEqual(value.monitors.map(monitor => monitor.checks), [1, 0, 1]);
  assert.equal(value.checkBatch.total, 2);
  assert.equal(value.checkBatch.completed, 2);
  assert.equal(api.reloads.length, 2);
});

test('shared monitoring controls start and stop only the ticked buildings', async () => {
  const {api, engine} = await setup();
  const ids = (await engine.state()).monitors.map(monitor => monitor.id);
  api.completeReload = false;
  await assert.rejects(engine.dispatch({type: 'set-buildings-monitoring', ids: [], enabled: true}), /Select at least one/);
  await assert.rejects(engine.dispatch({type: 'set-buildings-monitoring', ids: [ids[0]], enabled: 'yes'}), /valid monitoring status/);
  await engine.dispatch({type: 'set-buildings-monitoring', ids: [ids[0], ids[2]], enabled: true});
  assert.deepEqual((await engine.state()).monitors.map(monitor => monitor.enabled), [true, false, true]);
  await engine.dispatch({type: 'set-buildings-monitoring', ids: [ids[0]], enabled: false});
  assert.deepEqual((await engine.state()).monitors.map(monitor => monitor.enabled), [false, false, true]);
  await engine.dispatch({type: 'stop-all'});
});

test('pending local test applicants merge with existing Chrome profiles without changing the active applicant', async () => {
  const {api, engine, createEngine} = await setup();
  const {PROFILES_KEY} = await import('../SpotAlert/chrome_extension/profile.js');
  api.data[PROFILES_KEY] = {activeId: 'existing', profiles: [{id: 'existing', name: 'Existing applicant', details: {email: 'real@example.com'}}]};
  const pending = {id: 'local-test', name: 'Fictional test applicant', testProfile: true, details: {email: 'test@example.com'}};
  let written;
  api.runtime.sendNativeMessage = async (_, message) => message.command === 'read' ? {ok: true, folder: '/private/test-profiles', library: null, pendingLibrary: {activeId: pending.id, profiles: [pending]}} : (written = message.library, {ok: true});
  const restarted = createEngine(api);
  await restarted.initialize();
  const library = await restarted.dispatch({type: 'profiles'});
  assert.equal(library.activeId, 'existing');
  assert.equal(library.profiles.length, 2);
  assert.equal(library.profiles[0].details.email, 'real@example.com');
  assert.equal(library.profiles[1].testProfile, true);
  assert.equal(written.profiles.length, 2);
  await engine.dispatch({type: 'stop-all'});
});
