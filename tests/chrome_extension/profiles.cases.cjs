const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {modules, fakeChrome, setup} = require("./fixtures.cjs");

test("manifest allows optional native messaging for local profile storage", async () => {
  const manifest = JSON.parse(fs.readFileSync("SpotAlert/chrome_extension/manifest.json"));
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.deepEqual(manifest.host_permissions, ["https://thisisourdomain.securerc.co.uk/*", "https://southeast-thisisourdomain.securerc.co.uk/*", "https://api.resend.com/*", "https://canvas-world.securerc.co.uk/*", "https://www.canvas-world.com/*"]);
  assert.equal(manifest.side_panel.default_path, "panel.html");
});

test("personal details validate, persist separately, delete, and never enter monitor state", async () => {
  const {api, engine} = await setup();
  const {PROFILE_KEY, validateProfile} = await import("../../SpotAlert/chrome_extension/profile.js");
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

test("application readiness requires contact details, without requiring an address", async () => {
  const {applicationReadiness} = await import("../../SpotAlert/chrome_extension/ui.js");
  assert.deepEqual(applicationReadiness({}).missing, ["first name", "last name", "email", "phone"]);
  assert.equal(applicationReadiness({firstName: "Alex", lastName: "Example", email: "alex@example.com", phone: "+31612345678"}).ready, true);
  assert.equal(applicationReadiness({firstName: "Alex", lastName: "Example", email: "invalid", phone: " "}).ready, false);
});

test("Resend requires an explicit profile recipient and reports provider failures", async () => {
  const {sendEmailAlert, EMAIL_KEY, CONTACT_KEY} = await import("../../SpotAlert/chrome_extension/email.js");
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







test('expanded profiles validate choices, dates and zero income, and count Canvas requirements', async () => {
  const {validateProfile, profileCompleteness, PROFILE_FIELDS} = await import('../../SpotAlert/chrome_extension/profile.js');
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

test('saved applicants migrate, switch independently and retain their own passwords', async () => {
  const {engine, api} = await setup();
  const {PROFILE_KEY, PROFILES_KEY} = await import('../../SpotAlert/chrome_extension/profile.js');
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

test('client questionnaire imports answers and optional existing account passwords', async () => {
  const {clientQuestionnaire, parseClientReply} = await import('../../SpotAlert/chrome_extension/clients.js');
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
  const {PROFILE_KEY, PROFILES_KEY} = await import('../../SpotAlert/chrome_extension/profile.js');
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
  const {PROFILES_KEY, PROFILE_KEY} = await import('../../SpotAlert/chrome_extension/profile.js');
  delete api.data[PROFILES_KEY]; delete api.data[PROFILE_KEY];
  const {createEngine} = await import('../../SpotAlert/chrome_extension/engine.js');
  const restored = await createEngine(api).dispatch({type:'profiles'});
  assert.equal(restored.profiles[0].details.firstName, 'Alex');
  api.runtime.sendNativeMessage = async () => {throw new Error('unavailable');};
  await assert.rejects(engine.dispatch({type:'save-profile', profile:{firstName:'Sam'}}), /helper unavailable/);
  assert.equal(api.data[PROFILE_KEY].firstName, 'Alex');
});

test('password generation leaves identity data separate from fictional test applicants', async () => {
  const {generateRegistrationPassword, validateProfile, profileCompleteness} = await import('../../SpotAlert/chrome_extension/profile.js');
  const {createTestProfile} = await import('../../SpotAlert/chrome_extension/test-profiles.js');
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
  const {profileCompleteness, requiredProfileFields} = await import('../../SpotAlert/chrome_extension/profile.js');
  const result = profileCompleteness({firstName: 'Alex', noMiddleName: 'Yes'});
  assert.ok(result.missingFields.some(field => field.key === 'nationality' && field.label === 'Nationality'));
  assert.ok(!result.missingFields.some(field => ['firstName', 'middleName', 'iban', 'registrationPassword'].includes(field.key)));
  assert.ok(requiredProfileFields({noMiddleName: 'No'}).includes('middleName'));
});

test('pending local test applicants merge with existing Chrome profiles without changing the active applicant', async () => {
  const {api, engine, createEngine} = await setup();
  const {PROFILES_KEY} = await import('../../SpotAlert/chrome_extension/profile.js');
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
