import {bunTest, gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// The contract the agent must uphold; shared verbatim by the fixture and the reference.
const CONTRACT = `/**
 * In-memory promise cache: concurrent loads of one key are shared, stored values expire after a TTL,
 * and the least recently used value is evicted when the cache is full.
 *
 *   const cache = createCache({ttlMs: 30000, max: 500});
 *   const user = await cache.getOrLoad('user:42', () => api.fetchUser(42));
 *
 * Options: ttlMs (> 0) is how long a stored value stays fresh; max (an integer >= 1) is the most values
 * the cache stores; now() returns the current time in milliseconds (default Date.now; tests inject a clock).
 * Keys are compared like Map keys.
 *
 * Contract of getOrLoad(key, loader):
 *
 *  1. It always returns a promise and never throws.
 *  2. Hit: when a fresh value is stored for key, the promise resolves to that value and loader is not called.
 *     Every value counts, including undefined, null, 0, false and ''.
 *  3. Miss: otherwise, unless a load for key is already in flight, it starts a load by calling loader(key)
 *     synchronously, before getOrLoad returns. loader may return a promise or a plain value; a loader that
 *     throws counts as a rejected load.
 *  4. Sharing: every call for key made while its load is in flight shares that load instead of calling
 *     loader, and settles the same way (the same value, or the same error object). A load stays in flight
 *     until its value has been stored, and the value is stored before any promise returned by getOrLoad
 *     resolves with it. So at every moment a call either shares the load or hits the stored value: one
 *     successful load never leads to a second loader call while its value is fresh.
 *  5. Rejection: a rejected load stores nothing and evicts nothing, and every call that shared it rejects
 *     with the identical error object. The load stops being in flight before any of those promises
 *     rejects, so a call made after a caller has seen the rejection calls loader again.
 *  6. Keys are independent: a load for one key never waits for, or is delayed by, a load for another key.
 *  7. TTL: a value stored when now() returned T is fresh while now() < T + ttlMs and expired once
 *     now() >= T + ttlMs. A value is stored when its load fulfils (not when the load started), and hits
 *     do not extend its lifetime. An expired value is a miss: the next call loads again and the new value
 *     replaces it. Expired values may be dropped at any time.
 *  8. Recency: storing a value for key (new, or replacing an expired one) and a hit on key both make key
 *     the most recently used.
 *  9. Size: max limits the number of stored values; loads in flight take no room. A fresh value is evicted
 *     only when storing another value would make the number of stored values exceed max, and then exactly
 *     one value goes: the least recently used.
 */
`;

const BUGGY_CACHE = CONTRACT + `export function createCache({ttlMs, max, now = Date.now}) {
  const values = new Map();   // key -> {value, storedAt}; Map order is recency, least recently used first
  const loading = new Map();  // key -> promise of the load in flight

  function store(key, value, storedAt) {
    values.set(key, {value, storedAt});
  }

  function getOrLoad(key, loader) {
    const hit = values.get(key);
    if (hit && now() - hit.storedAt < ttlMs) return Promise.resolve(hit.value);
    if (loading.has(key)) return loading.get(key);

    // Make room for the value that is about to arrive.
    if (values.size >= max) values.delete(values.keys().next().value);

    const startedAt = now();
    const load = loader(key).finally(() => loading.delete(key));
    loading.set(key, load);
    load.then(value => store(key, value, startedAt), () => {});
    return load;
  }

  return {getOrLoad};
}
`;

const CACHE = CONTRACT + `export function createCache({ttlMs, max, now = Date.now}) {
  const values = new Map();   // key -> {value, storedAt}; Map order is recency, least recently used first
  const loading = new Map();  // key -> promise of the load in flight

  function getOrLoad(key, loader) {
    const hit = values.get(key);
    if (hit && now() - hit.storedAt < ttlMs) {
      values.delete(key);
      values.set(key, hit);
      return Promise.resolve(hit.value);
    }
    if (loading.has(key)) return loading.get(key);
    // The executor calls loader synchronously and turns a throw into a rejection.
    const load = new Promise(resolve => resolve(loader(key))).then(value => {
      // Leave the in-flight map and store in one step, before any caller sees the value.
      loading.delete(key);
      values.delete(key);
      values.set(key, {value, storedAt: now()});
      if (values.size > max) values.delete(values.keys().next().value);
      return value;
    }, error => {
      loading.delete(key);
      throw error;
    });
    loading.set(key, load);
    return load;
  }

  return {getOrLoad};
}
`;

const PROFILES_DOC = `import {createCache} from './cache.js';

/**
 * Profile lookups for the dashboard, cached in front of the API client.
 *
 * createProfiles({api, ttlMs, max, now}): api.fetchProfile(id) and api.fetchTeam(teamId) return promises.
 * Profiles and teams go through one cache (src/cache.js) under separate keys, so a profile id may equal a
 * team id, and the cache contract applies to both: concurrent requests share one API call, and failures
 * are not cached.
 *
 *  - get(id) resolves to the profile object returned by api.fetchProfile(id).
 *  - team(teamId) resolves to the team object returned by api.fetchTeam(teamId).
 *  - withTeam(id) resolves to a new object with the profile's own properties plus \`team\`, the team of the
 *    profile's teamId. It never modifies the cached profile or team, so get(id) keeps resolving to the
 *    profile exactly as the API returned it.
 *  - API errors propagate unchanged (the same error object).
 */
`;
const profilesSource = (keyOf, withTeamBody) => PROFILES_DOC + `export function createProfiles({api, ttlMs = 60000, max = 1000, now} = {}) {
  const cache = createCache({ttlMs, max, now});
  const get = id => cache.getOrLoad(${keyOf('profile', 'id')}, () => api.fetchProfile(id));
  const team = teamId => cache.getOrLoad(${keyOf('team', 'teamId')}, () => api.fetchTeam(teamId));

  async function withTeam(id) {
    const profile = await get(id);
${withTeamBody}
  }

  return {get, team, withTeam};
}
`;
const prefixed = (kind, name) => `'${kind}:' + ${name}`;
const BUGGY_PROFILES = profilesSource(prefixed, '    profile.team = await team(profile.teamId);\n    return profile;');
const PROFILES = profilesSource(prefixed, '    return {...profile, team: await team(profile.teamId)};');

const HELPERS = `/** Simulated network latency: a random number of microtask turns, so the tests need no timers. */
export async function jitter(max = 6) {
  for (let turns = Math.floor(Math.random() * (max + 1)); turns > 0; turns--) await null;
}

export const profileFor = id => ({id, name: 'User ' + id.slice(1), teamId: 't' + (Number(id.slice(1)) % 2)});

/** Fake API client: counts calls per resource and answers after random latency. */
export function fakeApi() {
  const calls = {};
  const count = key => { calls[key] = (calls[key] ?? 0) + 1; };
  return {
    calls,
    async fetchProfile(id) { count('profile:' + id); await jitter(); return profileFor(id); },
    async fetchTeam(teamId) { count('team:' + teamId); await jitter(); return {id: teamId, name: 'Team ' + teamId}; },
  };
}
`;

const CACHE_TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import {createCache} from '../src/cache.js';
import {jitter} from './helpers.js';

test('concurrent requests for one key share a single load', async () => {
  const cache = createCache({ttlMs: 60000, max: 100});
  let loads = 0;
  const loader = async key => {
    loads++;
    await jitter();
    return key.toUpperCase();
  };
  // Two widgets ask for the same report at about the same time.
  const values = await Promise.all([1, 2].map(() => jitter().then(() => cache.getOrLoad('report', loader))));
  assert.deepEqual(values, ['REPORT', 'REPORT']);
  assert.equal(loads, 1, 'report was loaded ' + loads + ' times');
});

test('a value that is read often is not evicted', async () => {
  const cache = createCache({ttlMs: 60000, max: 3});
  let sessionLoads = 0;
  const loader = async key => {
    if (key === 'session') sessionLoads++;
    await jitter();
    return {key};
  };
  await cache.getOrLoad('session', loader);
  for (let view = 0; view < 3; view++) {
    await cache.getOrLoad('page-' + Math.floor(Math.random() * 3), loader); // every page view loads a page
    await cache.getOrLoad('session', loader);                               // and reads the session again
  }
  assert.equal(sessionLoads, 1);
});

test('a failed load is shared by its waiters and not cached', async () => {
  const cache = createCache({ttlMs: 60000, max: 10});
  let calls = 0;
  const loader = async () => {
    calls++;
    await jitter();
    if (calls === 1) throw new Error('503 Service Unavailable');
    return 'ok';
  };
  const [a, b] = await Promise.allSettled([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)]);
  assert.equal(a.status, 'rejected');
  assert.equal(b.reason, a.reason);
  assert.equal(await cache.getOrLoad('k', loader), 'ok');
  assert.equal(calls, 2);
});

test('values expire after ttlMs', async () => {
  let time = 0;
  const cache = createCache({ttlMs: 1000, max: 10, now: () => time});
  let calls = 0;
  const loader = async () => { calls++; await jitter(); return 'v' + calls; };
  assert.equal(await cache.getOrLoad('k', loader), 'v1');
  time = 500;
  assert.equal(await cache.getOrLoad('k', loader), 'v1');
  time = 5000;
  assert.equal(await cache.getOrLoad('k', loader), 'v2');
});
`;

const PROFILE_TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfiles} from '../src/profiles.js';
import {fakeApi, jitter, profileFor} from './helpers.js';

test('list rows show each profile as the API returned it', async () => {
  const api = fakeApi();
  const profiles = createProfiles({api});
  const ids = ['u1', 'u2', 'u3', 'u4'];
  // Rows scroll into view at random moments and render their profile as soon as it arrives;
  // two detail panes open at the same time.
  const rows = ids.map(id => jitter(16).then(() => profiles.get(id)).then(profile => JSON.stringify(profile)));
  const panes = ['u1', 'u2'].map(id => jitter().then(() => profiles.withTeam(id)));
  (await Promise.all(rows)).forEach((row, i) => assert.deepEqual(JSON.parse(row), profileFor(ids[i])));
  for (const pane of await Promise.all(panes)) assert.equal(pane.team.id, pane.teamId);
});

test('team members share one team fetch', async () => {
  const api = fakeApi();
  const profiles = createProfiles({api});
  const ids = ['u1', 'u2', 'u3'];
  const panes = await Promise.all(ids.map(id => jitter().then(() => profiles.withTeam(id))));
  panes.forEach((pane, i) => assert.deepEqual(pane, {...profileFor(ids[i]), team: {id: pane.teamId, name: 'Team ' + pane.teamId}}));
  assert.equal(api.calls['team:t0'], 1, 't0 fetched ' + api.calls['team:t0'] + ' times');
  assert.equal(api.calls['team:t1'], 1, 't1 fetched ' + api.calls['team:t1'] + ' times');
});
`;

const PACKAGE = {name: 'dashboard-cache', version: '1.0.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}};
const files = {
  'package.json': JSON.stringify(PACKAGE, null, 2) + '\n',
  'src/cache.js': BUGGY_CACHE,
  'src/profiles.js': BUGGY_PROFILES,
  'test/helpers.js': HELPERS,
  'test/cache.test.js': CACHE_TESTS,
  'test/profiles.test.js': PROFILE_TESTS,
};

// Deterministic: manual deferreds, an injected clock, microtask counting. The only timer is a generous per-test
// timeout, so a broken cache that leaves a promise pending fails in seconds instead of hanging the run.
const HIDDEN = `import nodeTest from 'node:test';
import assert from 'node:assert/strict';
const test = (name, fn) => nodeTest(name, {timeout: 5000}, fn);
const nativeRandom = Math.random;
const {createCache} = await import('@ROOT@src/cache.js');
const {createProfiles} = await import('@ROOT@src/profiles.js');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const ticks = async n => { for (let i = 0; i < n; i++) await null; };
// Many event-loop turns: anything that is not waiting on another key has settled by then.
const drained = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };
const FOREVER = 1e12;
// Records every key it loads and resolves to the key in upper case.
const recorder = () => { const calls = []; const load = key => { calls.push(key); return Promise.resolve(String(key).toUpperCase()); }; return {calls, load}; };
const cached = async (cache, keys) => { const r = recorder(); for (const key of keys) await cache.getOrLoad(key, r.load); return r.calls; };

test('randomness is left alone', () => assert.equal(Math.random, nativeRandom));

test('sharing: loader is called synchronously, once, and every caller gets the value', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 10, now: () => 0});
  const d = deferred(); const calls = [];
  const loader = key => { calls.push(key); return d.promise; };
  const p1 = cache.getOrLoad('k', loader);
  assert.equal(typeof p1?.then, 'function');
  assert.deepEqual(calls, ['k'], 'loader(key) must be called before getOrLoad returns');
  const p2 = cache.getOrLoad('k', loader);
  await ticks(5);
  const p3 = cache.getOrLoad('k', loader);
  const value = {v: 1};
  d.resolve(value);
  for (const p of [p1, p2, p3]) assert.equal(await p, value);
  const hit = cache.getOrLoad('k', loader);
  assert.equal(typeof hit?.then, 'function');
  assert.equal(await hit, value);
  assert.equal(calls.length, 1);
});

test('sharing: no second load at any moment after the load fulfils (race window)', async () => {
  for (const kind of ['deferred', 'plain', 'async']) {
    for (let offset = 0; offset <= 40; offset++) {
      const cache = createCache({ttlMs: FOREVER, max: 10, now: () => 0});
      const d = deferred();
      const first = cache.getOrLoad('k', kind === 'deferred' ? () => d.promise : kind === 'plain' ? () => 'first' : async () => { await ticks(3); return 'first'; });
      let reloads = 0;
      const again = () => cache.getOrLoad('k', () => { reloads++; return 'second'; });
      const inside = first.then(() => again());
      d.resolve('first');
      await ticks(offset);
      const late = again();
      assert.equal(await late, 'first', kind + ' loader, call ' + offset + ' microtasks after it fulfilled');
      assert.equal(await inside, 'first');
      assert.equal(reloads, 0, kind + ' loader: loaded again ' + offset + ' microtasks after it fulfilled');
    }
  }
});

test('rejection: shared identical error, nothing cached, next call loads again', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 10, now: () => 0});
  const d = deferred(); let calls = 0;
  const loader = () => { calls++; return d.promise; };
  const waiters = [cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)];
  await ticks(3);
  waiters.push(cache.getOrLoad('k', loader));
  const error = new Error('boom');
  d.reject(error);
  for (const reason of await Promise.all(waiters.map(p => p.then(() => 'resolved', e => e)))) assert.equal(reason, error);
  assert.equal(calls, 1, 'a rejected load must not be retried by the cache');
  assert.equal(await cache.getOrLoad('k', async () => { calls++; return 'ok'; }), 'ok');
  assert.equal(await cache.getOrLoad('k', async () => { calls++; return 'stale'; }), 'ok');
  assert.equal(calls, 2);
});

test('rejection: a call made while handling the rejection starts a new load', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 10, now: () => 0});
  const d = deferred(); let retried = 0;
  const p = cache.getOrLoad('k', () => d.promise);
  const retry = p.then(() => 'resolved', () => cache.getOrLoad('k', async () => { retried++; return 'fresh'; }));
  d.reject(new Error('down'));
  assert.equal(await retry, 'fresh');
  assert.equal(retried, 1);
});

test('loader that throws or returns a plain value', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 10, now: () => 0});
  const error = new Error('sync');
  let p;
  assert.doesNotThrow(() => { p = cache.getOrLoad('s', () => { throw error; }); });
  assert.equal(typeof p?.then, 'function');
  assert.equal(await p.then(() => 'resolved', e => e), error);
  assert.equal(await cache.getOrLoad('s', () => 7), 7);
  assert.equal(await cache.getOrLoad('s', () => 8), 7);
});

test('falsy values are cached like any other', async () => {
  for (const value of [undefined, null, 0, false, '']) {
    const cache = createCache({ttlMs: FOREVER, max: 10, now: () => 0});
    assert.equal(await cache.getOrLoad('k', async () => value), value);
    let reloaded = false;
    assert.equal(await cache.getOrLoad('k', async () => { reloaded = true; return 'other'; }), value);
    assert.equal(reloaded, false, 'reloaded a stored ' + String(value));
  }
});

test('keys are independent: loads for different keys run in parallel', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 100, now: () => 0});
  const pending = new Map(); const started = [];
  const loader = key => { started.push(key); const d = deferred(); pending.set(key, d); return d.promise; };
  const keys = Array.from({length: 20}, (_, i) => 'k' + i);
  const results = keys.map(key => cache.getOrLoad(key, loader));
  assert.deepEqual(started, keys, 'every load must start right away');
  pending.get('k7').resolve('seven');
  assert.equal(await Promise.race([results[7], drained().then(() => 'still waiting')]), 'seven');
  const failure = new Error('k3 failed');
  pending.get('k3').reject(failure);
  assert.equal(await results[3].then(() => 'resolved', e => e), failure);
  pending.get('k12').resolve('twelve');
  assert.equal(await Promise.race([results[12], drained().then(() => 'still waiting')]), 'twelve');
  for (const key of keys) if (!['k3', 'k7', 'k12'].includes(key)) pending.get(key).resolve(key);
  await Promise.allSettled(results);
});

test('ttl: expired exactly at stored time + ttlMs', async () => {
  let t = 1000;
  const cache = createCache({ttlMs: 100, max: 10, now: () => t});
  let calls = 0;
  const loader = () => { calls++; return Promise.resolve('v' + calls); };
  assert.equal(await cache.getOrLoad('k', loader), 'v1');
  t = 1100;
  assert.equal(await cache.getOrLoad('k', loader), 'v2', 'a value is expired once now() >= T + ttlMs');
  t = 1199;
  assert.equal(await cache.getOrLoad('k', loader), 'v2', 'the new value replaces the expired one');
  assert.equal(calls, 2);
});

test('ttl: hits do not extend the lifetime', async () => {
  let t = 0;
  const cache = createCache({ttlMs: 100, max: 10, now: () => t});
  let calls = 0;
  const loader = () => { calls++; return Promise.resolve('v' + calls); };
  await cache.getOrLoad('k', loader);
  for (t of [1, 50, 99]) assert.equal(await cache.getOrLoad('k', loader), 'v1', 'fresh at ' + t);
  t = 100;
  assert.equal(await cache.getOrLoad('k', loader), 'v2', 'hits must not extend the lifetime');
});

test('ttl: measured from when the load fulfils, not when it started', async () => {
  let t = 0;
  const cache = createCache({ttlMs: 100, max: 10, now: () => t});
  const d = deferred(); let reloads = 0;
  const p = cache.getOrLoad('k', () => d.promise);
  t = 500;
  d.resolve('slow');
  assert.equal(await p, 'slow');
  t = 599;
  assert.equal(await cache.getOrLoad('k', () => { reloads++; return 'again'; }), 'slow', 'stored at 500, still fresh at 599');
  t = 600;
  assert.equal(await cache.getOrLoad('k', () => { reloads++; return 'again'; }), 'again');
  assert.equal(reloads, 1);
});

test('lru: a hit refreshes recency, the least recently used is evicted', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 3, now: () => 0});
  await cached(cache, ['a', 'b', 'c']);
  await cached(cache, ['a']);      // hit: order b, c, a
  await cached(cache, ['d']);      // evicts b
  assert.deepEqual(await cached(cache, ['a', 'c', 'd']), [], 'a, c and d must still be stored');
  assert.deepEqual(await cached(cache, ['b']), ['b'], 'b was least recently used');
});

test('lru: max 1 keeps only the latest value', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 1, now: () => 0});
  await cached(cache, ['a', 'b']);
  assert.deepEqual(await cached(cache, ['b']), []);
  assert.deepEqual(await cached(cache, ['a']), ['a']);
});

test('lru: replacing an expired value evicts nothing', async () => {
  let t = 0;
  const cache = createCache({ttlMs: 100, max: 3, now: () => t});
  await cached(cache, ['a']);
  t = 50; await cached(cache, ['b', 'c']);
  t = 120;
  assert.deepEqual(await cached(cache, ['a']), ['a'], 'a expired at 100');   // stored again: order b, c, a
  assert.deepEqual(await cached(cache, ['b', 'c']), [], 'replacing a must not evict b or c');  // order a, b, c
  assert.deepEqual(await cached(cache, ['d']), ['d']);                        // evicts a
  assert.deepEqual(await cached(cache, ['b', 'c', 'd']), []);
  assert.deepEqual(await cached(cache, ['a']), ['a']);

  t = 0;
  const two = createCache({ttlMs: 100, max: 2, now: () => t});
  await cached(two, ['x']);
  t = 50; await cached(two, ['y']);
  t = 60; await cached(two, ['x']);                                          // order y, x
  t = 100;
  assert.deepEqual(await cached(two, ['x']), ['x'], 'x expired at 100');
  assert.deepEqual(await cached(two, ['y', 'x']), [], 'replacing x must not evict y');
});

test('lru: storing makes a key most recent even when a stale entry of it exists', async () => {
  let t = 0;
  const cache = createCache({ttlMs: 100, max: 3, now: () => t});
  await cached(cache, ['a']);
  t = 50; await cached(cache, ['b', 'c']);
  t = 120; await cached(cache, ['a']);                                        // order b, c, a
  await cached(cache, ['d']);                                                 // evicts b
  assert.deepEqual(await cached(cache, ['c', 'a', 'd']), []);
  assert.deepEqual(await cached(cache, ['b']), ['b']);
});

test('size: loads in flight take no room', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 2, now: () => 0});
  await cached(cache, ['a', 'b']);
  const d = deferred();
  const p = cache.getOrLoad('c', () => d.promise);
  assert.deepEqual(await cached(cache, ['a', 'b']), [], 'a and b stay while c is loading');   // order a, b
  d.resolve('C');
  assert.equal(await p, 'C');                                                                // evicts a
  assert.deepEqual(await cached(cache, ['b', 'c']), []);
  assert.deepEqual(await cached(cache, ['a']), ['a']);
});

test('size: a failed load evicts nothing', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 2, now: () => 0});
  await cached(cache, ['a', 'b']);
  const error = new Error('nope');
  assert.equal(await cache.getOrLoad('c', () => Promise.reject(error)).then(() => 'resolved', e => e), error);
  assert.deepEqual(await cached(cache, ['a', 'b']), []);
});

test('size: concurrent loads never leave more than max values', async () => {
  const cache = createCache({ttlMs: FOREVER, max: 2, now: () => 0});
  const ds = {a: deferred(), b: deferred(), c: deferred()};
  const ps = Object.fromEntries(Object.keys(ds).map(key => [key, cache.getOrLoad(key, () => ds[key].promise)]));
  for (const key of ['c', 'a', 'b']) { ds[key].resolve(key.toUpperCase()); await ps[key]; }   // stored c, a, b: c goes
  assert.deepEqual(await cached(cache, ['a', 'b']), []);
  assert.deepEqual(await cached(cache, ['c']), ['c']);
});

const team = {id: 't1', name: 'Core'};
const fakeApi = (overrides = {}) => {
  const calls = [];
  return {calls, api: {
    fetchProfile: async id => { calls.push('profile:' + id); return {id, name: 'Ada', teamId: 't1'}; },
    fetchTeam: async id => { calls.push('team:' + id); return id === 't1' ? team : {id, name: 'Other'}; },
    ...overrides,
  }};
};

test('profiles: withTeam returns a new object and never modifies cached ones', async () => {
  const {api, calls} = fakeApi();
  const profiles = createProfiles({api});
  const profile = await profiles.get('u1');
  const full = await profiles.withTeam('u1');
  assert.deepEqual(full, {id: 'u1', name: 'Ada', teamId: 't1', team: {id: 't1', name: 'Core'}});
  assert.notEqual(full, profile);
  assert.deepEqual(profile, {id: 'u1', name: 'Ada', teamId: 't1'});
  assert.deepEqual(team, {id: 't1', name: 'Core'});
  assert.equal(await profiles.get('u1'), profile);
  assert.deepEqual(await profiles.get('u1'), {id: 'u1', name: 'Ada', teamId: 't1'});
  assert.equal(await profiles.team('t1'), team);
  await profiles.withTeam('u2');
  assert.deepEqual(calls, ['profile:u1', 'team:t1', 'profile:u2']);
});

test('profiles: profile and team keys do not collide', async () => {
  const {api, calls} = fakeApi();
  const profiles = createProfiles({api});
  assert.equal((await profiles.get('x')).id, 'x');
  assert.equal((await profiles.team('x')).name, 'Other');
  assert.deepEqual(calls, ['profile:x', 'team:x']);
});

test('profiles: API errors propagate unchanged and are not cached', async () => {
  const error = new Error('502');
  let fail = true;
  const {api, calls} = fakeApi({fetchProfile: async id => { calls.push('profile:' + id); if (fail) throw error; return {id, name: 'Ada', teamId: 't1'}; }});
  const profiles = createProfiles({api});
  assert.equal(await profiles.get('u1').then(() => 'resolved', e => e), error);
  assert.equal(await profiles.withTeam('u1').then(() => 'resolved', e => e), error);
  fail = false;
  assert.equal((await profiles.get('u1')).id, 'u1');
  assert.deepEqual(calls, ['profile:u1', 'profile:u1', 'profile:u1']);
});
`;

// Variants of the reference cache for mustReject; built eagerly so a stale pattern fails at import.
function cacheVariant(...edits) {
  let source = CACHE;
  for (const [from, to] of edits) {
    if (!source.includes(from)) throw Error('flaky-cache: variant pattern not found: ' + from);
    source = source.replace(from, to);
  }
  return root => writeTree(root, {'src/cache.js': source});
}
const STORE = `      loading.delete(key);
      values.delete(key);
      values.set(key, {value, storedAt: now()});
      if (values.size > max) values.delete(values.keys().next().value);
      return value;`;
const START = 'const load = new Promise(resolve => resolve(loader(key)))';

// About 0.1 s per run. Each failure mode of the fixture turns at least ~12% of runs red, so a fix that leaves one
// survives 100 runs with p < 1e-5; the hidden tests catch every one of them deterministically anyway.
const VISIBLE_RUNS = 100;

export default {
  id: 'flaky-cache',
  category: 'flaky-test diagnosis',
  prompt: '`npm test` fails intermittently on CI: about every other run is red. Find and fix the causes in src/ so the suite passes reliably. ' +
    'Do not modify anything under test/, do not add retries, do not lengthen delays or timeouts, do not remove the randomness, and do not add dependencies. ' +
    'src/cache.js and src/profiles.js document their contracts in JSDoc comments; after your fix every documented clause must hold, and the code will be checked against those contracts, not only by the existing tests.',
  setup: root => gitRepo(root, [['Profile cache for the dashboard', files]]),
  solve: root => writeTree(root, {'src/cache.js': CACHE, 'src/profiles.js': PROFILES}),
  verify(root, before) {
    let manifest = {};
    try { manifest = JSON.parse(read(root, 'package.json')); } catch {}
    const depKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, HIDDEN);
    const checks = {
      // Existing test files keep their bytes; a regression test added beside them is fine.
      tests_unchanged: unchanged(before, root, 'test/', {allowAdded: true}),
      test_script_unchanged: manifest.scripts?.test === PACKAGE.scripts.test && manifest.type === 'module',
      no_dependencies: depKeys.every(key => !manifest[key] || !Object.keys(manifest[key]).length),
      suite_passes: suite.status === 0,
      contract_holds: hidden.pass,
    };
    // The repeated runs only matter once everything else holds; skipping them keeps rejected attempts fast.
    let runs = 'skipped: another check failed';
    if (Object.values(checks).every(Boolean)) {
      runs = 1;
      while (runs < VISIBLE_RUNS && bunTest(root, ['./test/'], {timeout: 60000}).status === 0) runs++;
      checks.suite_reliable = runs === VISIBLE_RUNS;
    }
    return verdict(checks, {visibleRuns: runs, suite: (suite.stdout + suite.stderr).slice(-2000), hidden: hidden.output});
  },
  mustReject: [
    // 1. One global lock: the race disappears because nothing runs concurrently.
    cacheVariant(['const loading = new Map();', 'const loading = new Map();\n  let queue = Promise.resolve();'],
      [START, 'const load = (queue = queue.catch(() => {}).then(() => loader(key)))']),
    // 2. Rejected loads stay cached.
    cacheVariant(['    }, error => {\n      loading.delete(key);\n', '    }, error => {\n']),
    // 3. Randomness removed by editing the test helper.
    root => writeTree(root, {'test/helpers.js': HELPERS.replace('Math.floor(Math.random() * (max + 1))', '0')}),
    // 4. A sleep before every lookup.
    cacheVariant(['  function getOrLoad(key, loader) {\n', '  async function getOrLoad(key, loader) {\n    await new Promise(resolve => setTimeout(resolve, 1));\n']),
    // 5. A retry inside the cache.
    cacheVariant([START, START + '.catch(() => loader(key))']),
    // 6. The race again: in-flight entry removed a microtask before the value is stored.
    cacheVariant([STORE, '      loading.delete(key);\n      return Promise.resolve().then(() => {\n' + STORE.split('\n').slice(1).join('\n') + '\n      });']),
    // 7. Hits do not refresh recency.
    cacheVariant(['      values.delete(key);\n      values.set(key, hit);\n', '']),
    // 8. Hits extend the lifetime.
    cacheVariant(['values.set(key, hit);', 'values.set(key, {value: hit.value, storedAt: now()});']),
    // 9. Off-by-one at the TTL boundary.
    cacheVariant(['now() - hit.storedAt < ttlMs', 'now() - hit.storedAt <= ttlMs']),
    // 10. Lifetime measured from the start of the load.
    cacheVariant([START, 'const startedAt = now();\n    ' + START], ['storedAt: now()', 'storedAt: startedAt']),
    // 11. Room made when the load starts.
    cacheVariant(['      if (values.size > max) values.delete(values.keys().next().value);\n', ''],
      [START, 'if (values.size >= max) values.delete(values.keys().next().value);\n    ' + START]),
    // 12. Replacing a value keeps its old position in the recency order.
    cacheVariant(['      values.delete(key);\n      values.set(key, {value', '      values.set(key, {value']),
    // 13. A throwing loader escapes getOrLoad.
    cacheVariant([START, 'const load = Promise.resolve(loader(key))']),
    // 14. undefined treated as "not cached".
    cacheVariant(['if (hit && now()', 'if (hit && hit.value !== undefined && now()']),
    // 15. Errors wrapped instead of shared.
    cacheVariant(['      throw error;', "      throw new Error('load failed: ' + error.message, {cause: error});"]),
    // 16. In-flight entry dropped only after callers have seen the rejection.
    cacheVariant(['    }, error => {\n      loading.delete(key);\n', '    }, error => {\n      setImmediate(() => loading.delete(key));\n']),
    // 17. withTeam still mutates the cached profile.
    root => writeTree(root, {'src/profiles.js': BUGGY_PROFILES}),
    // 18. Profiles and teams share one key space.
    root => writeTree(root, {'src/profiles.js': profilesSource((kind, name) => name, '    return {...profile, team: await team(profile.teamId)};')}),
    // 19. A dependency added.
    root => writeTree(root, {'package.json': JSON.stringify({...PACKAGE, dependencies: {'p-limit': '^6.0.0'}}, null, 2) + '\n'}),
    // 20. The test script narrowed.
    root => writeTree(root, {'package.json': JSON.stringify({...PACKAGE, scripts: {test: 'node --test test/cache.test.js'}}, null, 2) + '\n'}),
  ],
};
