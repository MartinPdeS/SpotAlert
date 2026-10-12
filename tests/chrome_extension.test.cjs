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

test("desktop notifications occur only on transitions to availability", async () => {
  const {engine, api, id} = await setup();
  api.pageSamples[0].text = "Apply Now";
  await engine.check(id);
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 1);
  api.pageSamples[0].text = "Get Notified";
  await engine.check(id);
  api.pageSamples[0].text = "Apply Now";
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 2);
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
  assert.equal(updated.notify, true);
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
  const result = await vm.runInContext(`(${readPage.toString()})(${JSON.stringify(core.SUPPORTED_SITES[1].rule)},0)`, context);
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
  const result = await vm.runInContext(`(${readPage.toString()})(${JSON.stringify(core.SUPPORTED_SITES[1].rule)},0)`, context);
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

test("a second available listing alerts without resetting the site's available state", async () => {
  const {core, api, engine, id} = await setup();
  const studio = {id: "studio", name: "Studio A", rent: "€1,050", beds: "Studio", text: "Apply Now", applicationUrl: core.OURDOMAIN + "/apply?a=1"};
  const one = {id: "one", name: "1 Bedroom B", rent: "€1,500", beds: "1", text: "Get Notified", applicationUrl: core.OURDOMAIN + "/apply?b=1"};
  api.pageSamples = [studio, one];
  await engine.check(id);
  const first = await engine.state();
  api.pageSamples = [{...one, text: "Apply Now"}, studio];
  await engine.check(id);
  const second = await engine.state();
  assert.equal(api.notificationsLog.length, 2);
  assert.equal(second.monitors[0].available, true);
  assert.deepEqual(second.monitors[0].alert.listings.map(sample => sample.id), ["one"]);
  assert.equal(core.availabilityArrivals(first.monitors, second.monitors).length, 1);
  assert.match(api.notificationsLog[1].message, /1 Bedroom B/);
  assert.match(api.notificationsLog[1].message, /€1,500/);
  assert.match(api.notificationsLog[1].message, /apply\?b=1/);
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 2);
});

test("snooze keeps checking and delivers only still-available pending arrivals when it expires", async () => {
  const {api, createEngine, id} = await setup();
  let time = 1000000;
  const engine = createEngine(api, () => time);
  await engine.initialize();
  await engine.dispatch({type: "snooze", id, minutes: 15});
  api.pageSamples = [{id: "a", text: "Apply Now"}, {id: "b", text: "Get Notified"}];
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 0);
  assert.equal((await engine.state()).monitors[0].pendingArrivals.length, 1);
  api.pageSamples = [{id: "a", text: "Get Notified"}, {id: "b", text: "Apply Now"}];
  await engine.check(id);
  time += 900000;
  await engine.check(id);
  const monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.checks, 3);
  assert.deepEqual(monitor.alert.listings.map(sample => sample.id), ["b"]);
  assert.equal(monitor.pendingArrivals.length, 0);
  assert.equal(api.notificationsLog.length, 1);
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

test("test alerts work when notifications are disabled and do not change availability results", async () => {
  const {core, api, engine, id} = await setup();
  await engine.save({...core.defaultMonitor(), notify: false});
  await engine.check(id);
  const before = (await engine.state()).monitors[0];
  const result = await engine.dispatch({type: "test-alert", id});
  const after = (await engine.state()).monitors[0];
  assert.equal(result.desktop, true);
  assert.equal(after.alert.test, true);
  assert.equal(after.checks, before.checks);
  assert.equal(after.available, before.available);
  assert.equal(after.notify, false);
  assert.equal(core.availabilityArrivals([before], [after]).length, 1);
  assert.equal(api.notificationsLog.length, 1);
});

test("sound is delivered independently of desktop failure and previewing it does not save settings", async () => {
  const {api, engine, id} = await setup();
  let sounds = 0, documents = 0;
  api.runtime.getContexts = async () => [];
  api.runtime.sendMessage = async message => { assert.equal(message.target, "audio"); sounds++; return {ok: true}; };
  api.offscreen = {createDocument: async config => { assert.deepEqual(config.reasons, ["AUDIO_PLAYBACK"]); documents++; }};
  api.notifications.create = async () => { throw new Error("Notifications disabled by system"); };
  const result = await engine.dispatch({type: "test-alert", id, sound: true});
  assert.equal(result.desktop, false);
  assert.equal(result.sound, true);
  assert.equal(sounds, 1);
  assert.equal(documents, 1);
  assert.equal((await engine.state()).monitors[0].sound, false);
  assert.match(result.errors[0], /Notifications disabled/);
});

test("notification clicks retain the original application target after newer alerts arrive", async () => {
  const {core, api, engine, id} = await setup();
  const created = [];
  api.tabs.create = async config => { created.push(config); return {id: 9, ...config}; };
  api.pageSamples = [{id: "a", name: "Studio", text: "Apply Now", applicationUrl: core.OURDOMAIN + "/apply/a"}, {id: "b", name: "1 Bedroom", text: "Get Notified", applicationUrl: core.OURDOMAIN + "/apply/b"}];
  await engine.check(id);
  const notificationId = api.notificationsLog[0].id;
  api.pageSamples[1].text = "Apply Now";
  await engine.check(id);
  await engine.dispatch({type: "open-notification", notificationId});
  assert.equal(created[0].url, core.OURDOMAIN + "/apply/a");
  assert.equal(core.safeListingUrl("javascript:alert(1)", core.DEFAULT_URL), null);
  assert.equal(core.safeListingUrl("https://elsewhere.example/apply", core.DEFAULT_URL), null);
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

test("an increase in a published unit count alerts within an already-available floorplan", async () => {
  const {api, engine, id} = await setup();
  api.pageSamples = [{id: "studio", text: "1 Available", availableCount: 1}];
  await engine.check(id);
  api.pageSamples = [{id: "studio", text: "2 Available", availableCount: 2}];
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 2);
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 2);
  await engine.dispatch({type: "snooze", id, minutes: 15});
  api.pageSamples = [{id: "studio", text: "3 Available", availableCount: 3}];
  await engine.check(id);
  api.pageSamples = [{id: "studio", text: "2 Available", availableCount: 2}];
  await engine.check(id);
  assert.equal((await engine.state()).monitors[0].pendingArrivals.length, 0);
});

test("a snoozed transition updates availability without showing a panel pop-up", async () => {
  const {core, engine, api, id} = await setup();
  const before = await engine.state();
  await engine.dispatch({type: "snooze", id, minutes: 15});
  api.pageSamples = [{id: "studio", name: "Studio", text: "Apply Now"}];
  await engine.check(id);
  const after = await engine.state();
  assert.equal(after.monitors[0].available, true);
  assert.equal(after.monitors[0].alert, null);
  assert.deepEqual(core.availabilityArrivals(before.monitors, after.monitors), []);
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


test("notification preferences change without pausing or discarding observations", async () => {
  const {engine, id} = await setup();
  await engine.setEnabled(id, true);
  const before = (await engine.state()).monitors.find(m => m.id === id);
  await engine.dispatch({type: "set-alerts", id, notify: false, sound: true});
  const after = (await engine.state()).monitors.find(m => m.id === id);
  assert.equal(after.notify, false);
  assert.equal(after.sound, true);
  assert.equal(after.enabled, true);
  assert.equal(after.nextCheckAt, before.nextCheckAt);
  assert.deepEqual(after.samples, before.samples);
  await assert.rejects(engine.dispatch({type: "set-alerts", id, notify: "yes", sound: false}), /valid notification/);
});

test("Resend sending is opt-in, authenticated, and reports provider failures", async () => {
  const {sendEmailAlert, EMAIL_KEY, CONTACT_KEY} = await import("../SpotAlert/chrome_extension/email.js");
  let settings = {};
  const api = {storage: {local: {get: async () => settings}}};
  assert.deepEqual(await sendEmailAlert(api, {id: "test"}, "Subject", "Body"), {skipped: true});
  await assert.rejects(sendEmailAlert(api, {id: "test"}, "Subject", "Body", true), /destination/);
  settings = {[EMAIL_KEY]: {enabled: true, apiKey: "re_test"}, [CONTACT_KEY]: {email: "recipient@gmail.com"}};
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(options.headers.Authorization, "Bearer re_test");
      assert.deepEqual(JSON.parse(options.body).to, ["recipient@gmail.com"]);
      return {ok: true, json: async () => ({id: "test-email"})};
    };
    assert.equal((await sendEmailAlert(api, {id: "test"}, "Subject", "Body")).sent, true);
    globalThis.fetch = async () => ({ok: false, status: 401, json: async () => ({})});
    await assert.rejects(sendEmailAlert(api, {id: "test"}, "Subject", "Body"), /API key/);
    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(sendEmailAlert(api, {id: "test"}, "Subject", "Body"), /reach Resend/);
  } finally { globalThis.fetch = previousFetch; }
});


test("new availability sends Resend details and email failures preserve successful checks", async () => {
  const {engine, api, id} = await setup();
  const {EMAIL_KEY, CONTACT_KEY} = await import("../SpotAlert/chrome_extension/email.js");
  api.data[EMAIL_KEY] = {enabled: true, apiKey: "re_test"};
  api.data[CONTACT_KEY] = {email: "recipient@gmail.com"};
  let payload;
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      payload = JSON.parse(options.body);
      return {ok: false, json: async () => ({error: "Resend authentication failed."})};
    };
    api.pageSamples = [{index: 1, id: "studio", name: "Studio A", rent: "€900", text: "Apply now", context: "Studio", applicationUrl: api.url.replace("floorplans.aspx", "availableunits.aspx")}];
    await engine.check(id);
    assert.match(payload.text, /Studio A.*€900/);
    assert.match(payload.text, /availableunits.aspx/);
    const monitor = (await engine.state()).monitors.find(m => m.id === id);
    assert.equal(monitor.available, true);
    assert.equal(monitor.error, null);
    assert.ok(monitor.history.some(event => event.kind === "warning" && event.message.includes("Email failed")));
    assert.equal(api.notificationsLog.length, 1);
  } finally { globalThis.fetch = previousFetch; }
});


test("global alert preferences persist and old snooze settings clear on restart", async () => {
  const {engine, api, createEngine} = await setup();
  await engine.dispatch({type: "set-alerts", notify: false, sound: true});
  assert.ok((await engine.state()).monitors.every(m => !m.notify && m.sound));
  await engine.dispatch({type: "snooze-all", minutes: 15});
  assert.ok((await engine.state()).monitors.every(m => m.snoozedUntil === 1900000));
  const restarted = createEngine(api, () => 1000000);
  await restarted.initialize();
  assert.ok((await restarted.state()).monitors.every(m => !m.notify && m.sound));
  assert.ok((await restarted.state()).monitors.every(m => m.snoozedUntil === null));
});

test("pop-up and desktop delivery are independent, including email-only alerts", async () => {
  const {engine, api, id} = await setup();
  await engine.dispatch({type: "set-alerts", notify: true, popup: true, desktop: false, sound: false});
  api.pageSamples = [{index: 1, text: "Apply now", name: "Studio"}];
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 0);
  assert.ok((await engine.state()).monitors[0].alert);
  api.pageSamples = [{index: 1, text: "Get Notified"}];
  await engine.check(id);
  await engine.dispatch({type: "set-alerts", notify: true, popup: false, desktop: true, sound: false});
  api.pageSamples = [{index: 1, text: "Apply now", name: "Studio"}];
  await engine.check(id);
  assert.equal(api.notificationsLog.length, 1);
  assert.equal((await engine.state()).alertPreferences.popup, false);
  api.pageSamples = [{index: 1, text: "Get Notified"}];
  await engine.check(id);
  await engine.dispatch({type: "set-alerts", notify: false, popup: false, desktop: false, sound: false});
  const {EMAIL_KEY, CONTACT_KEY} = await import("../SpotAlert/chrome_extension/email.js");
  api.data[EMAIL_KEY] = {enabled: true, apiKey: "re_test"};
  api.data[CONTACT_KEY] = {email: "recipient@gmail.com"};
  let emails = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { emails++; return {ok: true, json: async () => ({id: "email-only"})}; };
  try {
    api.pageSamples = [{index: 1, text: "Apply now", name: "Studio"}];
    await engine.check(id);
    assert.equal(emails, 1);
    assert.equal(api.notificationsLog.length, 1);
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
  assert.match(api.notificationsLog[0].title, /Canvas.*Blaak/);
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

test('profile assignment applies client filters and survives active profile switching', async () => {
  const {engine, api, id} = await setup();
  await engine.dispatch({type:'save-profile', name:'Alex', profile:{firstName:'Alex',maxRent:'1500'}});
  await engine.dispatch({type:'assign-profile', id, profileId:'default'});
  await engine.dispatch({type:'create-profile'});
  await engine.dispatch({type:'save-profile', name:'Sam', profile:{firstName:'Sam',maxRent:'2500'}});
  api.pageSamples = [{text:'Apply now', rent:'€1800', size:'40 m²', name:'Studio'}];
  await engine.check(id);
  assert.equal((await engine.state()).monitors[0].available, false);
  const {PROFILES_KEY} = await import('../SpotAlert/chrome_extension/profile.js');
  await engine.dispatch({type:'assign-profile', id, profileId:api.data[PROFILES_KEY].activeId});
  assert.equal((await engine.state()).monitors[0].available, true);
  await assert.rejects(engine.dispatch({type:'assign-profile', id, profileId:'missing'}), /Profile not found/);
});

test('notification delivery history retries only the failed channel', async () => {
  const {engine, api, id} = await setup();
  const {EMAIL_KEY, CONTACT_KEY} = await import('../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {enabled:true,apiKey:'re_test'};
  api.data[CONTACT_KEY] = {email:'alex@example.com'};
  const original = globalThis.fetch;
  let emailCalls = 0;
  try {
    globalThis.fetch = async () => {emailCalls++; return {ok:false,status:429,json:async()=>({})};};
    await engine.dispatch({type:'test-alert', id, sound:false});
    const log = (await engine.state()).deliveries;
    const failed = log.find(item=>item.channel==='email');
    assert.equal(failed.status, 'failed');
    assert.equal(log.find(item=>item.channel==='desktop').status, 'sent');
    const desktops = api.notificationsLog.length;
    globalThis.fetch = async () => {emailCalls++; return {ok:true,json:async()=>({id:'mock-sent'})};};
    await engine.dispatch({type:'retry-delivery',deliveryId:failed.id});
    assert.equal(api.notificationsLog.length, desktops);
    const delivered = (await engine.state()).deliveries.find(item=>item.id===failed.id);
    assert.equal(delivered.status,'sent'); assert.equal(delivered.attempts,2);
    assert.equal(emailCalls,2);
    await assert.rejects(engine.dispatch({type:'retry-delivery',deliveryId:failed.id}), /Only failed/);
  } finally {globalThis.fetch=original;}
});
