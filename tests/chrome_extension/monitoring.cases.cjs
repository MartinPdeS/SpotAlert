const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {modules, fakeChrome, setup, saveSearch} = require("./fixtures.cjs");

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



test("opening a floorplan fragment keeps checks attached to the same website tab", async () => {
  const {core, api, engine, id} = await setup();
  api.url = core.DEFAULT_URL + "#FP_Detail_101";
  await engine.check(id);
  const monitor = (await engine.state()).monitors[0];
  assert.equal(monitor.checks, 1);
  assert.equal(monitor.error, null);
  assert.equal(monitor.tabId, 7);
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

test('client apartment preferences check budget, types, sizes and unknown details', async () => {
  const {preferenceMatch} = await import('../../SpotAlert/chrome_extension/preferences.js');
  const profile = {maxRent:'1800', minSize:'35', preferredApartmentType:'1-bedroom'};
  assert.equal(preferenceMatch({rent:'€ 1.724,27', size:'40 m²', apartmentType:'1-bedroom'}, profile).included, true);
  assert.equal(preferenceMatch({rent:'€1,600 – €2,000', size:'40 m²', apartmentType:'1-bedroom'}, profile).included, false);
  assert.ok(preferenceMatch({rent:'€2,000', size:'30 m²', apartmentType:'studio'}, profile).reasons.length === 3);
  assert.equal(preferenceMatch({rent:'€1,700', size:'400 sq ft', apartmentType:'1-bedroom'}, profile).included, true);
  assert.ok(preferenceMatch({apartmentType:'1-bedroom'}, profile).reasons.includes('Rent not published'));
});



test('starting can change actions independently and rejects unsupported SMS or stale dialog settings', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
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

test('Monitoring never sends general alerts, including after migrating enabled legacy settings', async () => {
  const {api, engine, core, createEngine, id} = await setup();
  const {EMAIL_KEY, CONTACT_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
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

test('Check all covers every building once, shares duplicate requests and leaves schedules unchanged', async () => {
  const {api, engine} = await setup();
  // Return the URL of each selected tab rather than the default fixture's single URL.
  const {SUPPORTED_SITES} = await import('../../SpotAlert/chrome_extension/sites/index.js');
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
  const {STORAGE_KEY} = await import('../../SpotAlert/chrome_extension/core.js');
  api.data[STORAGE_KEY] = value;
  const restarted = createEngine(api, () => 1000001);
  await restarted.initialize();
  value = await restarted.state();
  assert.equal(value.checkBatch.status, 'interrupted');
  assert.equal(value.checkBatch.currentId, null);
});

test('batch checking validates the requested buildings and checks only the selected subset', async () => {
  const {api, engine} = await setup();
  const {SUPPORTED_SITES} = await import('../../SpotAlert/chrome_extension/sites/index.js');
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

