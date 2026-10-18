const test = require('node:test');
const assert = require('node:assert/strict');
const {fakeChrome, setup} = require('./fixtures.cjs');

// Boundary validation must reject malformed data before it reaches a mutation.
test('malformed runtime commands fail without changing persisted state', async () => {
  const {engine} = await setup();
  const before = await engine.state();
  for (const message of [null, [], {}, {type: 42}, {type: 'unknown'},
    {type: 'save-search', search: []}, {type: 'save-profile', profile: 'bad'},
    {type: 'set-search-enabled', id: 'search', enabled: 'true'},
    {type: 'open-application-target', tabId: -1}]) {
    await assert.rejects(engine.dispatch(message), /Invalid|Unknown/);
    assert.deepEqual(await engine.state(), before);
  }
});

test('engine state reads wait for queued writes and a rejected write permits recovery', async () => {
  const {createEngineStore} = await import('../../SpotAlert/chrome_extension/engine-store.js');
  const {STORAGE_KEY} = await import('../../SpotAlert/chrome_extension/core.js');
  const api = fakeChrome();
  const store = createEngineStore(api);
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const first = store.mutate(async value => {
    await paused;
    value.order = ['first'];
  });
  const second = store.mutate(value => value.order.push('second'));
  const read = store.state();
  release();
  await Promise.all([first, second]);
  assert.deepEqual((await read).order, ['first', 'second']);

  await assert.rejects(store.mutate(value => {
    value.order.push('discarded');
    throw new Error('Update failed');
  }), /Update failed/);
  assert.deepEqual((await store.state()).order, ['first', 'second']);

  const save = api.storage.local.set;
  api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(store.mutate(value => value.order.push('unsaved')), /Storage unavailable/);
  api.storage.local.set = save;
  await store.mutate(value => value.order.push('recovered'));
  assert.deepEqual(api.data[STORAGE_KEY].order, ['first', 'second', 'recovered']);
});
