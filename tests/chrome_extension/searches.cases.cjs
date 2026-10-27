const test = require("node:test");
const assert = require("node:assert/strict");
const {setup, waitForSearch, saveSearch} = require("./fixtures.cjs");

test('searches preserve existing watches and validate profiles, locations, channels and preferences', async () => {
  const {engine, id} = await setup();
  assert.deepEqual((await engine.state()).searches, []);
  const {validateSearch} = await import('../../SpotAlert/chrome_extension/searches.js');
  const profiles = [{id: 'a', details: {email: 'a@example.com', maxRent: '1400'}}];
  const input = {name: 'A', profileId: 'a', locationIds: [id], actions: {email: true}};
  assert.equal(Object.hasOwn(validateSearch(input, profiles), 'preferences'), false);
  assert.throws(() => validateSearch({...input, profileId: 'missing'}, profiles), /profile/);
  assert.throws(() => validateSearch({...input, locationIds: ['unknown']}, profiles), /location/);
  assert.throws(() => validateSearch({...input, actions: {}}, profiles), /Choose email/);
  assert.throws(() => validateSearch({...input, actions: {autoApply: true}}, profiles), /contact details/);
  assert.equal(validateSearch(input, profiles).intervalSeconds, 5);
  assert.throws(() => validateSearch({...input, intervalSeconds: 1}, profiles), /5 seconds/);
  assert.equal(Object.hasOwn(validateSearch({...input, preferences:{maxRent:'-1'}}, profiles), 'preferences'), false, 'copied overrides are ignored');
});

test('profile searches default to five seconds and shared locations use the fastest active interval', async () => {
  const {engine, id, api} = await setup();
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {apiKey: 'test'};
  await engine.dispatch({type: 'save-profile', name: 'Alex', profile: {email: 'alex@example.com'}});
  const profileId = (await engine.dispatch({type: 'profiles'})).activeId;
  const first = await saveSearch(engine, profileId, id);
  const second = await saveSearch(engine, profileId, id, {name: 'Slower search', intervalSeconds: 60});
  await engine.dispatch({type: 'set-search-enabled', id: second.id, enabled: true});
  assert.equal((await engine.state()).monitors[0].intervalSeconds, 60);
  await engine.dispatch({type: 'set-search-enabled', id: first.id, enabled: true});
  assert.equal((await engine.state()).monitors[0].intervalSeconds, 5);
  await engine.dispatch({type: 'set-search-interval', id: first.id, intervalSeconds: 300});
  assert.equal((await engine.state()).searches.find(search => search.id === first.id).intervalSeconds, 300);
  assert.equal((await engine.state()).monitors[0].intervalSeconds, 60);
  await engine.dispatch({type: 'set-search-enabled', id: first.id, enabled: false});
  assert.equal((await engine.state()).monitors[0].intervalSeconds, 60);
  await engine.dispatch({type: 'set-search-enabled', id: second.id, enabled: false});
  assert.equal((await engine.state()).monitors[0].intervalSeconds, 300);
});

test('search start and pause share scheduling and Stop all disables every search', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
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
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
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
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
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
  const {preferenceMatch} = await import('../../SpotAlert/chrome_extension/preferences.js');
  const {exclusionReasons} = await import('../../SpotAlert/chrome_extension/searches.js');
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
  const {searchReadiness} = await import('../../SpotAlert/chrome_extension/searches.js');
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

test('duplicate action records survive deletion and require one explicit, fresh authorization', async () => {
  const {api, engine, id, core} = await setup();
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
  const {searchClaimKey} = await import('../../SpotAlert/chrome_extension/searches.js');
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
  const {searchClaimKey} = await import('../../SpotAlert/chrome_extension/searches.js');
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

test('cancelling an authorized repeat before it runs restores the original duplicate protection', async () => {
  const {api, engine, id, core} = await setup();
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
  const {searchClaimKey} = await import('../../SpotAlert/chrome_extension/searches.js');
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

test('searches use live profile criteria and re-evaluate results immediately after a profile edit', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
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
  const {EMAIL_KEY}=await import('../../SpotAlert/chrome_extension/email.js');
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
  const {EMAIL_KEY,CONTACT_KEY}=await import('../../SpotAlert/chrome_extension/email.js');
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

test('general monitoring and profile searches can be stopped independently', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
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

test('shared location reads match each profile independently and email its holder only once', async () => {
  const {api, engine, id} = await setup();
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
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
    const [{createEngine}] = await Promise.all([import('../../SpotAlert/chrome_extension/engine.js')]);
    const restarted = createEngine(api, () => 1000000);
    await restarted.initialize();
    await restarted.check(id);
    assert.equal(emails.length, 1, 'claims survive worker restart');
    await restarted.dispatch({type: 'stop-all'});
  } finally { globalThis.fetch = original; }
});

test('another automatic application requires the matching profile, active channel and a fresh result', async () => {
  const {api, engine, id, core} = await setup();
  const {searchClaimKey} = await import('../../SpotAlert/chrome_extension/searches.js');
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


test('unnamed searches use the selected profile and preserve existing names on edit', async () => {
  const {engine, id, api} = await setup();
  const {EMAIL_KEY} = await import('../../SpotAlert/chrome_extension/email.js');
  api.data[EMAIL_KEY] = {apiKey: 'test'};
  await engine.dispatch({type: 'save-profile', name: 'Alex', profile: {email: 'alex@example.com'}});
  const firstId = (await engine.dispatch({type: 'profiles'})).activeId;
  const input = {profileId: firstId, locationIds: [id], actions: {email: true}};
  await engine.dispatch({type: 'save-search', search: input});
  let search = (await engine.state()).searches.at(-1);
  assert.equal(search.name, 'Alex');
  await engine.dispatch({type: 'save-search', search: {...input, id: search.id, name: 'Existing name'}});
  await engine.dispatch({type: 'save-search', search: {...input, id: search.id}});
  search = (await engine.state()).searches.at(-1);
  assert.equal(search.name, 'Existing name');
  await engine.dispatch({type: 'create-profile'});
  await engine.dispatch({type: 'save-profile', name: 'Bea', profile: {email: 'bea@example.com'}});
  const secondId = (await engine.dispatch({type: 'profiles'})).activeId;
  await engine.dispatch({type: 'save-search', search: {...input, id: search.id, profileId: secondId}});
  assert.equal((await engine.state()).searches.at(-1).name, 'Bea');
});
