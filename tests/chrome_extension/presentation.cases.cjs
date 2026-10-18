const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {event} = require("./fixtures.cjs");

test("freshness uses the last successful check and accounts for refresh intervals", async () => {
  const {freshness} = await import("../../SpotAlert/chrome_extension/ui.js");
  assert.equal(freshness({lastCheckedAt: null}, 100000).text, "Not checked");
  assert.equal(freshness({lastCheckedAt: 100000, intervalSeconds: 5}, 159000).stale, false);
  assert.equal(freshness({lastCheckedAt: 100000, intervalSeconds: 5}, 161000).stale, true);
  assert.equal(freshness({lastCheckedAt: 100000, intervalSeconds: 3600}, 3700000).stale, false);
  assert.equal(freshness({lastCheckedAt: 100000, intervalSeconds: 300}, 1100000).text, "Stale · 16m ago");
});

test("available website totals differ from apartment units and unknown counts remain explicit", async () => {
  const {availabilityTotals} = await import("../../SpotAlert/chrome_extension/ui.js");
  const monitors = [{available: true, samples: [{id: "a", matched: true, availableCount: 3}, {id: "a", matched: true, availableCount: 3}, {id: "b", matched: true}, {id: "c", matched: false, availableCount: 7}]}];
  assert.deepEqual(availabilityTotals(monitors), {websites: 1, apartments: 4, unknownCounts: 1});
  monitors.push({available: true, samples: [{id: "d", matched: true, availableCount: 2}, {id: "e", matched: true, included: false}]});
  assert.deepEqual(availabilityTotals(monitors), {websites: 2, apartments: 6, unknownCounts: 1});
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

test('attention tasks point to recoverable actions and retire superseded failures', async () => {
  const {attentionItems} = await import('../../SpotAlert/chrome_extension/ui.js');
  const {searchClaimKey} = await import('../../SpotAlert/chrome_extension/searches.js');
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

test('one activity timeline deduplicates current records and retains previous attempts once', async () => {
  const {mergeActionHistory, cleanError}=await import('../../SpotAlert/chrome_extension/ui.js');
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
  const {diagnosticReport, diagnosticText} = await import('../../SpotAlert/chrome_extension/diagnostics.js');
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
  const {resultStatus, monitoringScope, errorRecovery} = await import('../../SpotAlert/chrome_extension/ui.js');
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

test('application debug reports exclude profile values, passwords and URL queries', async () => {
  const {applicationReport, APPLICATION_BUILD} = await import('../../SpotAlert/chrome_extension/application-diagnostics.js');
  const report = applicationReport({build:APPLICATION_BUILD,status:'stopped',kind:'waiting',profile:{email:'private@example.com'},password:'secret-password',message:'private content',trace:[{at:123,event:'page-inspected',path:'/termsandotheritems.aspx?token=secret-token',step:'',kind:'ready',password:'secret-password',pageContent:'private content'}]});
  const encoded=JSON.stringify(report);
  assert.equal(report.build,APPLICATION_BUILD);
  assert.equal(report.trace[0].path,'/termsandotheritems.aspx');
  assert.ok(!/secret|private/.test(encoded));
});

