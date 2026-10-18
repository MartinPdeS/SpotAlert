const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {modules, setup, backgroundFixture, htmlResponse} = require("./fixtures.cjs");

test("page reader returns selector errors instead of false unavailability", async () => {
  const [, , {readPage}] = await modules;
  const context = vm.createContext({
    document: {querySelectorAll: () => { throw new Error("invalid selector"); }},
    location: {href: "https://example.com"}, Date, setTimeout,
  });
  const result = await vm.runInContext(`(${readPage.toString()})({type:'css',selector:'['},0)`, context);
  assert.match(result.error, /Invalid CSS selector/);
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

test("reader distinguishes verification, login, selector errors and empty loading elements", async () => {
  const [, , {readPage}] = await modules;
  const read = (document) => vm.runInContext(`(${readPage.toString()})({type:'css',selector:'.availability'},0)`, vm.createContext({document, location: {href: "https://example.com"}, Date, setTimeout}));
  assert.equal((await read({title: "Just a moment..."})).errorKind, "verification");
  assert.equal((await read({title: "Sign in", querySelector: selector => selector.includes("password") ? {} : null})).errorKind, "login");
  assert.equal((await read({readyState: "complete", querySelectorAll: () => []})).errorKind, "selector");
  assert.equal((await read({querySelectorAll: () => [{getClientRects: () => [{}], innerText: "", closest: () => null}]})).errorKind, "loading");
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


test('background reader fetches without cache, uses a detached parser and rejects incomplete data', async () => {
  const {readBackground} = await import('../../SpotAlert/chrome_extension/background-reader.js');
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
  const {readBackground} = await import('../../SpotAlert/chrome_extension/background-reader.js');
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

