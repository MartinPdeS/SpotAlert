const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {modules, setup} = require("./fixtures.cjs");

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

test("move-in selection respects the earliest preference, calendar limits, and excluded weekdays", async () => {
  const {selectMoveInDate} = await import("../../SpotAlert/chrome_extension/profile.js");
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
  const {canvasBookingLink} = await import('../../SpotAlert/chrome_extension/page.js');
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
  const {startCanvasApplication} = await import('../../SpotAlert/chrome_extension/profile.js');
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

test('Start Application refuses weekend move-in dates', async () => {
  const {startCanvasApplication} = await import('../../SpotAlert/chrome_extension/profile.js');
  assert.equal((await startCanvasApplication('24-10-2026', 0)).started, false);
  assert.equal((await startCanvasApplication('25-10-2026', 0)).started, false);
});

test('Start Application handles delegated handlers, hidden duplicates and unpadded dates', async () => {
  const {startCanvasApplication} = await import('../../SpotAlert/chrome_extension/profile.js');
  let clicks=0;
  const hidden={innerText:'Start Application',disabled:false,getAttribute:()=>null,getClientRects:()=>[],click:()=>{throw new Error('hidden button clicked');}};
  const button={...hidden,getClientRects:()=>[1],click:()=>clicks++};
  const context={document:{querySelector:()=>({value:'2-11-2026'}),querySelectorAll:()=>[hidden,button]},jQuery:{active:0,_data:()=>({})},Date,setTimeout:callback=>callback()};
  const result=await vm.runInNewContext(`(${startCanvasApplication.toString()})('02-11-2026',0)`,context);
  assert.equal(result.started,true);assert.equal(clicks,1);
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
  assert.equal(info.build,(await import('../../SpotAlert/chrome_extension/application-diagnostics.js')).APPLICATION_BUILD);
  const {applicationStage,applicationRecovery}=await import('../../SpotAlert/chrome_extension/application-state.js');
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

