import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture and hidden-test sources are String.raw templates: they never contain a backtick or "${".
const js = String.raw;

const SPEC = `# Loader cache

\`createCache(options)\` (exported by \`src/index.js\`) is a read-through cache: callers ask for keys, and values that are missing are produced by an asynchronous \`load\` function. It supports a freshness window and a staleness window (stale-while-revalidate), single-flight loading, error caching, load timeouts and a bound on the number of entries with least-recently-used eviction. It never uses the global timer functions or \`Date\`: all time comes from the injected clock.

## Clock

\`options.clock\` is an object with three functions:

- \`now()\` returns the current time in milliseconds.
- \`setTimeout(callback, ms)\` arranges for \`callback()\` to be called once, \`ms\` milliseconds from now, and returns a handle.
- \`clearTimeout(handle)\` cancels a callback that has not run yet.

The tests use \`test/fake-clock.js\`: time moves only when a test calls \`advance(ms)\`. Callbacks that are due at the same time run in the order they were registered, and all pending promise reactions run before the next callback.

## Options

\`createCache({clock, load, ttl, staleTtl = 0, errorTtl = 0, loadTimeout, maxEntries = Infinity})\`

- \`load(key, {signal})\` produces the value for \`key\`, as a value or a promise. \`signal\` is an \`AbortSignal\` that belongs to this one call (see Loads).
- \`ttl\`: how long, in milliseconds, a stored value is fresh. It has no default.
- \`staleTtl\`: how long after it stops being fresh a value is still served, as a stale value.
- \`errorTtl\`: how long a failure is remembered (see Failures).
- \`loadTimeout\`: the longest a load may take, in milliseconds. When it is \`undefined\`, loads may take any time.
- \`maxEntries\`: the most entries the cache holds (see Size).

An option that is \`undefined\` takes its default. \`createCache\` checks its options in this order and throws for the first problem, with exactly these messages ("integer" means \`Number.isInteger\`):

1. \`clock\` must be a non-null object whose \`now\`, \`setTimeout\` and \`clearTimeout\` are functions: \`TypeError\` \`clock must have now, setTimeout and clearTimeout functions\` (also when \`options\` is missing).
2. \`load\` must be a function: \`TypeError\` \`load must be a function\`.
3. \`ttl\` must be an integer >= 1: \`RangeError\` \`ttl must be an integer >= 1\`.
4. \`staleTtl\` must be an integer >= 0: \`RangeError\` \`staleTtl must be an integer >= 0\`.
5. \`errorTtl\` must be an integer >= 0: \`RangeError\` \`errorTtl must be an integer >= 0\`.
6. \`loadTimeout\` must be \`undefined\` or an integer >= 1: \`RangeError\` \`loadTimeout must be an integer >= 1\`.
7. \`maxEntries\` must be an integer >= 1 or \`Infinity\`: \`RangeError\` \`maxEntries must be an integer >= 1 or Infinity\`.

## Keys

Every key is a non-empty string. \`get\` with any other key returns a promise that rejects with a \`TypeError\` \`key must be a non-empty string\`, and nothing else happens (no event, no statistics). \`set\`, \`delete\` and \`has\` throw that error.

## Entries

The cache holds at most one entry per key: either a *value entry* (a value) or an *error entry* (the reason of a failed load). Each entry records \`storedAt\`, the value of \`clock.now()\` at the moment it was stored; its *age* is \`clock.now() - storedAt\`.

- A value entry is *fresh* while its age is below \`ttl\`, *stale* while its age is at least \`ttl\` and below \`ttl + staleTtl\`, and *expired* from \`ttl + staleTtl\` on. With \`staleTtl\` 0 a value is never stale: it expires when it stops being fresh.
- An error entry is *valid* while its age is below \`errorTtl\` and *expired* from then on.

Expired entries are not removed eagerly. An expired entry stays in the cache, and counts against \`maxEntries\`, until a \`get\` for its key, \`delete\`, \`clear\` or eviction removes it.

## get

\`get(key)\` returns a promise. It never throws, whatever \`load\` does. What it does depends on the key's entry, in this order:

1. A fresh value entry: the hit counter goes up, the entry becomes the most recently used, emit \`hit\`; the promise fulfils with the value.
2. A valid error entry: the error-hit counter goes up, the entry becomes the most recently used, emit \`error-hit\`; the promise rejects with the stored reason (the same value).
3. A stale value entry: the stale-hit counter goes up, the entry becomes the most recently used, emit \`stale\`; the promise fulfils with the stale value. Then, if no load is in flight for the key and refreshes of the key are not on hold (see Failures), start a load of the key as a *refresh*.
4. Otherwise (no entry, or an expired one): an expired entry is removed (no event); the miss counter goes up; emit \`miss\`. If a load is in flight for the key, the promise settles like that load; otherwise start a load of the key (not a refresh) and the promise settles like it.

All of this happens synchronously inside the \`get\` call, including the \`load\` event and the call to \`load\` when a load starts.

**Single flight.** At most one load per key is *in flight* at any time. Every miss for a key whose load is in flight joins that load instead of calling \`load\` again, whether the load was started by a miss or as a refresh.

## Loads

Starting a load of a key takes these steps: the load counter goes up; emit \`load\`; the load becomes the key's in-flight load; if \`loadTimeout\` is set, register a clock callback \`loadTimeout\` milliseconds from now; call \`load(key, {signal})\`.

The outcome of \`load\` is always handled asynchronously: a returned value or promise is treated like \`Promise.resolve(value)\` and a synchronous throw like a returned rejected promise. No event about the outcome is emitted before the call that started the load has returned.

A load *ends* at the first of these: its outcome arrives, or its timeout callback runs. When the outcome arrives first, the timeout callback is cleared. When the timeout callback runs first, the load's signal is aborted with a \`TimeoutError\` and the load fails with that same error; an outcome that arrives later is ignored entirely. When a load ends, it stops being the key's in-flight load.

\`TimeoutError\` (exported by \`src/index.js\`) is an \`Error\` subclass whose \`name\` is \`'TimeoutError'\`; its message is \`Loading <key> timed out after <ms> ms\`.

When a load ends with a value, unless it was detached: store a value entry for the key whose \`storedAt\` is the time the load ended (not the time it started), replacing any entry of the key; emit \`store\`; evict (see Size). Then the promise of the load fulfils with the value.

## Failures

When a load fails with a reason, unless it was detached: emit \`fail\`; then

- if the key has a value entry (whatever its state), that entry is kept unchanged, and refreshes of the key are *on hold* until \`errorTtl\` milliseconds after the failure: a \`get\` that finds the entry stale while \`clock.now()\` is below failure time + \`errorTtl\` serves the stale value without starting a refresh. With \`errorTtl\` 0 there is no hold. The hold ends early when the entry is replaced or removed.
- otherwise, if \`errorTtl\` is above 0, store an error entry with the reason, replacing any entry of the key, and evict. With \`errorTtl\` 0 nothing is stored.

Then the promise of the load rejects with the reason. A refresh has nobody waiting for it: the failure of a load must never be reported as an unhandled rejection.

## set, delete, clear and detaching

- \`set(key, value)\` stores a value entry with \`storedAt\` now, replacing any entry of the key; emit \`store\`; evict.
- \`delete(key)\` removes the key's entry and returns \`true\` if the key had an entry, whatever its state (also an expired one), else \`false\`.
- \`clear()\` removes every entry.

Each of these *detaches* the in-flight load of every key it affects. A detached load keeps running and its timeout still applies, and the callers that already joined it still get its outcome, but it is no longer the key's in-flight load (the next miss starts a new load) and when it ends it has no effect on the cache: no event, nothing stored, no hold. Its signal is not aborted by detaching.

## has

\`has(key)\` returns \`true\` when a \`get\` for the key would be served from its entry without a load: a fresh or stale value entry, or a valid error entry. It changes nothing: no event, no statistics, no change in recency.

## Size

After an entry is stored, while the cache holds more than \`maxEntries\` entries, the least recently used entry is removed: the eviction counter goes up and emit \`evict\`. An entry becomes the most recently used when it is stored (a replacement counts as storing) and when \`get\` serves it (steps 1 to 3 of get). Expired entries count until they are removed.

## Statistics and events

\`stats()\` returns a new plain object \`{hits, staleHits, errorHits, misses, loads, evictions}\` with the current counters; later activity does not change an object that was already returned.

\`on(listener)\` subscribes \`listener\`. Every event is passed synchronously to every subscribed listener, in subscription order. An event is a plain object with exactly the properties listed here:

- \`{type: 'hit', key}\`, \`{type: 'error-hit', key}\`, \`{type: 'stale', key}\`, \`{type: 'miss', key}\`
- \`{type: 'load', key, refresh}\`: \`refresh\` is \`true\` for a refresh and \`false\` otherwise.
- \`{type: 'store', key}\`: a value entry was stored (by \`set\` or by a load).
- \`{type: 'fail', key, error}\`: \`error\` is the reason itself.
- \`{type: 'evict', key}\`

## Performance

\`get\`, \`set\`, \`delete\`, \`has\` and each eviction take time that does not grow with the number of entries (constant, amortized): 300,000 calls of \`set\` with distinct keys followed by as many hits, with \`maxEntries\` 100,000, must take well under a second.
`;

const ISSUES = `# Open issues

Reports from users of the cache. Each one describes what was observed; none has been investigated yet.

## #41 Overwritten values come back

We write fresh data with \`set('user:7', profile)\` right after a request for \`user:7\` started a slow load. A moment later \`get('user:7')\` returns the old profile again, as if our \`set\` never happened.

## #44 Duplicate backend calls

After a \`set()\` or \`delete()\` for a key while a load for that key was running, we sometimes see two backend calls for the same key at the same time, although all our \`get\` calls for it happen together.

## #47 Outage turns stale data into errors

During a backend outage, users get errors for keys that still had stale data. We expected the stale value to be served for the whole stale window while refreshes fail.

## #52 Slow loads go stale early

With \`ttl: 60000\` and a loader that takes about 20 seconds, values are already stale about 40 seconds after they arrive.

## #53 Crash during a background refresh

Our service exited with an unhandled promise rejection right after a background refresh failed. Nobody awaits refreshes in our code.
`;

const README = `# loader-cache

A read-through cache with stale-while-revalidate, single-flight loading, error caching, load timeouts and LRU eviction.

\`\`\`js
import {createCache} from './src/index.js';

const cache = createCache({clock, load: key => fetchUser(key), ttl: 60000, staleTtl: 300000, errorTtl: 5000, maxEntries: 10000});
const user = await cache.get('user:7');
\`\`\`

The behaviour is specified in [docs/CACHE.md](docs/CACHE.md). Run the tests with \`npm test\`.

## Layout

- \`src/index.js\`: public exports.
- \`src/cache.js\`: \`createCache\`, which ties the parts together.
- \`src/options.js\`: option validation and defaults.
- \`src/keys.js\`: key validation.
- \`src/entry.js\`: value and error entries and their states.
- \`src/lru.js\`: entries in least-recently-used order.
- \`src/flights.js\`: the in-flight load of each key.
- \`src/loader.js\`: calls \`load\` with a signal and a timeout.
- \`src/stats.js\`, \`src/emitter.js\`: counters and events.
- \`src/errors.js\`: \`TimeoutError\`.
`;

const CHANGELOG = `# Changelog

## 1.3.0

- Refreshes are put on hold for \`errorTtl\` after a failed refresh.
- \`set\`, \`delete\` and \`clear\` detach in-flight loads.

## 1.2.0

- \`loadTimeout\`: loads that take too long fail with a \`TimeoutError\`; their signal is aborted.
- \`has(key)\`.

## 1.1.0

- \`maxEntries\` with least-recently-used eviction.
- \`stats()\` and \`on(listener)\`.

## 1.0.0

- First release: \`get\`, \`set\`, \`delete\`, \`clear\`; \`ttl\`, \`staleTtl\`, \`errorTtl\`; single-flight loading.
`;

const FAKE_CLOCK = js`/**
 * A manual clock for tests: time moves only when advance() is called.
 * Callbacks due at the same time run in the order they were registered; all pending promise reactions
 * run before each callback and after the last one.
 */
export function fakeClock(start = 0) {
  let now = start;
  let lastHandle = 0;
  const timers = new Map();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const handle = ++lastHandle;
      timers.set(handle, {due: now + Math.max(0, Number(ms) || 0), callback});
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
    /** Number of callbacks registered and neither run nor cleared yet. */
    pending: () => timers.size,
    /** Let every pending promise reaction run. */
    flush,
    /** Move time forward by ms, running every callback that falls due on the way. */
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        let next;
        for (const [handle, timer] of timers) if (timer.due <= end && (next === undefined || timer.due < timers.get(next).due)) next = handle;
        if (next === undefined) break;
        const {due, callback} = timers.get(next);
        timers.delete(next);
        now = due;
        callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
`;

// The correct library. The fixture is this library with the BUGS below applied.
const SOURCES = {
  'src/index.js': js`export {createCache} from './cache.js';
export {TimeoutError} from './errors.js';
`,
  'src/errors.js': js`/** A load that did not end within loadTimeout. */
export class TimeoutError extends Error {
  constructor(key, ms) {
    super('Loading ' + key + ' timed out after ' + ms + ' ms');
    this.name = 'TimeoutError';
  }
}
`,
  'src/keys.js': js`export const KEY_MESSAGE = 'key must be a non-empty string';

/** Throw unless key is a non-empty string. */
export function checkKey(key) {
  if (typeof key !== 'string' || key === '') throw new TypeError(KEY_MESSAGE);
}
`,
  'src/options.js': js`const CLOCK_FUNCTIONS = ['now', 'setTimeout', 'clearTimeout'];
const isInteger = (value, min) => Number.isInteger(value) && value >= min;

/** Validate createCache options in the documented order; returns them with defaults filled in. */
export function readOptions(options = {}) {
  const {clock, load, ttl, staleTtl = 0, errorTtl = 0, loadTimeout, maxEntries = Infinity} = options;
  if (clock === null || typeof clock !== 'object' || CLOCK_FUNCTIONS.some(name => typeof clock[name] !== 'function')) {
    throw new TypeError('clock must have now, setTimeout and clearTimeout functions');
  }
  if (typeof load !== 'function') throw new TypeError('load must be a function');
  if (!isInteger(ttl, 1)) throw new RangeError('ttl must be an integer >= 1');
  if (!isInteger(staleTtl, 0)) throw new RangeError('staleTtl must be an integer >= 0');
  if (!isInteger(errorTtl, 0)) throw new RangeError('errorTtl must be an integer >= 0');
  if (loadTimeout !== undefined && !isInteger(loadTimeout, 1)) throw new RangeError('loadTimeout must be an integer >= 1');
  if (maxEntries !== Infinity && !isInteger(maxEntries, 1)) throw new RangeError('maxEntries must be an integer >= 1 or Infinity');
  return {clock, load, ttl, staleTtl, errorTtl, loadTimeout, maxEntries};
}
`,
  'src/entry.js': js`/** Cache entries; see docs/CACHE.md, "Entries". */
export const valueEntry = (value, storedAt) => ({kind: 'value', value, storedAt, holdUntil: -Infinity});
export const errorEntry = (error, storedAt) => ({kind: 'error', error, storedAt});

/** 'missing', 'fresh', 'stale', 'error' (a valid error entry) or 'expired'. */
export function classify(entry, now, {ttl, staleTtl, errorTtl}) {
  if (!entry) return 'missing';
  const age = now - entry.storedAt;
  if (entry.kind === 'error') return age < errorTtl ? 'error' : 'expired';
  if (age < ttl) return 'fresh';
  return age < ttl + staleTtl ? 'stale' : 'expired';
}
`,
  'src/lru.js': js`/** Entries by key in least-recently-used order: a Map of nodes plus a doubly linked list, oldest first. */
export class LruMap {
  #nodes = new Map();
  #head = null;
  #tail = null;

  get size() { return this.#nodes.size; }

  /** The entry for key without changing its recency. */
  peek(key) { return this.#nodes.get(key)?.entry; }

  /** Make key the most recently used. */
  touch(key) {
    const node = this.#nodes.get(key);
    if (!node) return;
    this.#unlink(node);
    this.#append(node);
  }

  /** Store entry under key as the most recently used. */
  store(key, entry) {
    let node = this.#nodes.get(key);
    if (node) this.#unlink(node);
    else this.#nodes.set(key, node = {key, entry, prev: null, next: null});
    node.entry = entry;
    this.#append(node);
  }

  delete(key) {
    const node = this.#nodes.get(key);
    if (!node) return false;
    this.#unlink(node);
    this.#nodes.delete(key);
    return true;
  }

  clear() {
    this.#nodes.clear();
    this.#head = this.#tail = null;
  }

  /** The least recently used key, or undefined. */
  oldestKey() { return this.#head?.key; }

  #unlink(node) {
    if (node.prev) node.prev.next = node.next; else this.#head = node.next;
    if (node.next) node.next.prev = node.prev; else this.#tail = node.prev;
    node.prev = node.next = null;
  }

  #append(node) {
    node.prev = this.#tail;
    if (this.#tail) this.#tail.next = node; else this.#head = node;
    this.#tail = node;
  }
}
`,
  'src/flights.js': js`/** The in-flight load of each key: at most one per key. */
export class Flights {
  #byKey = new Map();

  get(key) { return this.#byKey.get(key); }

  add(key, flight) { this.#byKey.set(key, flight); }

  /** A load ended: it stops being in flight, unless another load has taken its place. */
  finish(key, flight) {
    if (this.#byKey.get(key) === flight) this.#byKey.delete(key);
  }

  /** The key's in-flight load keeps running but no longer affects the cache. */
  detach(key) {
    const flight = this.#byKey.get(key);
    if (!flight) return;
    flight.detached = true;
    this.#byKey.delete(key);
  }

  detachAll() {
    for (const flight of this.#byKey.values()) flight.detached = true;
    this.#byKey.clear();
  }
}
`,
  'src/loader.js': js`import {TimeoutError} from './errors.js';

/**
 * Call load(key, {signal}) and settle with its outcome, or fail with a TimeoutError after timeout ms
 * (when timeout is defined); whatever ends the load first wins and the other is ignored.
 */
export function runLoad({key, load, clock, timeout}) {
  const controller = new AbortController();
  const {promise, resolve, reject} = Promise.withResolvers();
  let ended = false;
  let timer;
  if (timeout !== undefined) {
    timer = clock.setTimeout(() => {
      if (ended) return;
      ended = true;
      const error = new TimeoutError(key, timeout);
      controller.abort(error);
      reject(error);
    }, timeout);
  }
  const end = settle => outcome => {
    if (ended) return;
    ended = true;
    if (timer !== undefined) clock.clearTimeout(timer);
    settle(outcome);
  };
  let outcome;
  try {
    outcome = Promise.resolve(load(key, {signal: controller.signal}));
  } catch (error) {
    outcome = Promise.reject(error);
  }
  outcome.then(end(resolve), end(reject));
  return promise;
}
`,
  'src/stats.js': js`export const createStats = () => ({hits: 0, staleHits: 0, errorHits: 0, misses: 0, loads: 0, evictions: 0});
`,
  'src/emitter.js': js`/** Synchronous events, delivered to listeners in subscription order. */
export function createEmitter() {
  const listeners = [];
  return {
    on(listener) { listeners.push(listener); },
    emit(event) { for (const listener of listeners) listener(event); },
  };
}
`,
  'src/cache.js': js`import {readOptions} from './options.js';
import {checkKey} from './keys.js';
import {classify, errorEntry, valueEntry} from './entry.js';
import {LruMap} from './lru.js';
import {Flights} from './flights.js';
import {runLoad} from './loader.js';
import {createStats} from './stats.js';
import {createEmitter} from './emitter.js';

/** A read-through cache; see docs/CACHE.md. */
export function createCache(options) {
  const policy = readOptions(options);
  const {clock, load, errorTtl, loadTimeout, maxEntries} = policy;
  const entries = new LruMap();
  const flights = new Flights();
  const stats = createStats();
  const {on, emit} = createEmitter();

  function evict() {
    while (entries.size > maxEntries) {
      const key = entries.oldestKey();
      entries.delete(key);
      stats.evictions++;
      emit({type: 'evict', key});
    }
  }

  function startLoad(key, refresh) {
    stats.loads++;
    emit({type: 'load', key, refresh});
    const flight = {detached: false, promise: undefined};
    flights.add(key, flight);
    flight.promise = runLoad({key, load, clock, timeout: loadTimeout}).then(value => {
      flights.finish(key, flight);
      if (!flight.detached) {
        entries.store(key, valueEntry(value, clock.now()));
        emit({type: 'store', key});
        evict();
      }
      return value;
    }, error => {
      flights.finish(key, flight);
      if (!flight.detached) {
        emit({type: 'fail', key, error});
        const entry = entries.peek(key);
        if (entry?.kind === 'value') entry.holdUntil = clock.now() + errorTtl;
        else if (errorTtl > 0) {
          entries.store(key, errorEntry(error, clock.now()));
          evict();
        }
      }
      throw error;
    });
    // A refresh has nobody waiting for it.
    flight.promise.catch(() => {});
    return flight;
  }

  function get(key) {
    try {
      checkKey(key);
    } catch (error) {
      return Promise.reject(error);
    }
    const now = clock.now();
    const entry = entries.peek(key);
    switch (classify(entry, now, policy)) {
      case 'fresh':
        stats.hits++;
        entries.touch(key);
        emit({type: 'hit', key});
        return Promise.resolve(entry.value);
      case 'error':
        stats.errorHits++;
        entries.touch(key);
        emit({type: 'error-hit', key});
        return Promise.reject(entry.error);
      case 'stale':
        stats.staleHits++;
        entries.touch(key);
        emit({type: 'stale', key});
        if (!flights.get(key) && now >= entry.holdUntil) startLoad(key, true);
        return Promise.resolve(entry.value);
      case 'expired':
        entries.delete(key);
        // falls through
      default:
        stats.misses++;
        emit({type: 'miss', key});
        return (flights.get(key) ?? startLoad(key, false)).promise;
    }
  }

  return {
    get,
    set(key, value) {
      checkKey(key);
      flights.detach(key);
      entries.store(key, valueEntry(value, clock.now()));
      emit({type: 'store', key});
      evict();
    },
    delete(key) {
      checkKey(key);
      flights.detach(key);
      return entries.delete(key);
    },
    clear() {
      flights.detachAll();
      entries.clear();
    },
    has(key) {
      checkKey(key);
      const state = classify(entries.peek(key), clock.now(), policy);
      return state === 'fresh' || state === 'stale' || state === 'error';
    },
    stats: () => ({...stats}),
    on,
  };
}
`,
};

// [file, from, to]: each one is a deviation from docs/CACHE.md planted in the fixture.
const BUGS = {
  // The end of the stale window is inclusive (and staleTtl 0 makes a value stale for 1 ms).
  staleBoundary: ['src/entry.js', 'return age < ttl + staleTtl ?', 'return age <= ttl + staleTtl ?'],
  // An ending load removes whatever load is in flight for its key (#44).
  finishAny: ['src/flights.js', '    if (this.#byKey.get(key) === flight) this.#byKey.delete(key);', '    this.#byKey.delete(key);'],
  // storedAt is the time the load started (#52).
  storedAtStart: ['src/cache.js', [['    stats.loads++;\n', '    stats.loads++;\n    const started = clock.now();\n'],
    ['        entries.store(key, valueEntry(value, clock.now()));', '        entries.store(key, valueEntry(value, started));']]],
  // Replacing an entry keeps its old place in the LRU order.
  replaceKeepsRecency: ['src/lru.js', '    if (node) this.#unlink(node);\n    else this.#nodes.set(key, node = {key, entry, prev: null, next: null});\n    node.entry = entry;\n    this.#append(node);',
    '    if (node) {\n      node.entry = entry;\n      return;\n    }\n    this.#nodes.set(key, node = {key, entry, prev: null, next: null});\n    this.#append(node);'],
  // A failed refresh replaces the stale value with an error entry, and there is no hold (#47).
  refreshFailureCached: ['src/cache.js', [['        const entry = entries.peek(key);\n        if (entry?.kind === \'value\') entry.holdUntil = clock.now() + errorTtl;\n        else if (errorTtl > 0) {', '        if (errorTtl > 0) {'],
    [' && now >= entry.holdUntil) startLoad', ') startLoad']]],
  // A synchronous throw from load escapes get.
  syncThrow: ['src/loader.js', '  let outcome;\n  try {\n    outcome = Promise.resolve(load(key, {signal: controller.signal}));\n  } catch (error) {\n    outcome = Promise.reject(error);\n  }\n  outcome.then(',
    '  Promise.resolve(load(key, {signal: controller.signal})).then('],
  // A failed refresh is an unhandled rejection (#53).
  unhandledRefresh: ['src/cache.js', '    // A refresh has nobody waiting for it.\n    flight.promise.catch(() => {});\n', ''],
  // set does not detach the in-flight load (#41).
  setKeepsFlight: ['src/cache.js', '      checkKey(key);\n      flights.detach(key);\n      entries.store(key, valueEntry(value, clock.now()));', '      checkKey(key);\n      entries.store(key, valueEntry(value, clock.now()));'],
};

function applyBugs(names) {
  const out = {...SOURCES};
  for (const name of names) {
    const [file, from, to] = BUGS[name];
    for (const [a, b] of Array.isArray(from) ? from : [[from, to]]) {
      if (out[file].split(a).length !== 2) throw Error('swr-loader-cache: bug pattern not found exactly once: ' + name);
      out[file] = out[file].replace(a, b);
    }
  }
  return out;
}

const VISIBLE_CACHE = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {createCache, TimeoutError} from '../src/index.js';
import {fakeClock} from './fake-clock.js';

function setup(options = {}) {
  const clock = fakeClock();
  const calls = [];
  const load = key => {
    calls.push(key);
    return Promise.resolve(key + '#' + calls.length);
  };
  const cache = createCache({clock, load, ttl: 100, ...options});
  return {clock, cache, calls};
}

test('a miss loads, then the value is a hit', async () => {
  const {cache, calls} = setup();
  assert.equal(await cache.get('a'), 'a#1');
  assert.equal(await cache.get('a'), 'a#1');
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(cache.stats(), {hits: 1, staleHits: 0, errorHits: 0, misses: 1, loads: 1, evictions: 0});
});

test('concurrent misses share one load', async () => {
  const {cache, calls} = setup();
  const values = await Promise.all([cache.get('a'), cache.get('a'), cache.get('b')]);
  assert.deepEqual(values, ['a#1', 'a#1', 'b#2']);
  assert.deepEqual(calls, ['a', 'b']);
});

test('without staleTtl a value is reloaded once it expires', async () => {
  const {clock, cache, calls} = setup();
  await cache.get('a');
  await clock.advance(150);
  assert.equal(await cache.get('a'), 'a#2');
  assert.deepEqual(calls, ['a', 'a']);
});

test('a stale value is served while it is refreshed', async () => {
  const {clock, cache, calls} = setup({staleTtl: 100});
  await cache.get('a');
  await clock.advance(150);
  assert.equal(await cache.get('a'), 'a#1');
  await clock.flush();
  assert.equal(await cache.get('a'), 'a#2');
  assert.deepEqual(calls, ['a', 'a']);
});

test('failed loads are remembered for errorTtl', async () => {
  const clock = fakeClock();
  let n = 0;
  const cache = createCache({clock, ttl: 100, errorTtl: 50, load: () => Promise.reject(new Error('down ' + (++n)))});
  await assert.rejects(cache.get('a'), {message: 'down 1'});
  await clock.advance(20);
  await assert.rejects(cache.get('a'), {message: 'down 1'});
  await clock.advance(40);
  await assert.rejects(cache.get('a'), {message: 'down 2'});
});

test('a slow load times out', async () => {
  const clock = fakeClock();
  const cache = createCache({clock, ttl: 100, loadTimeout: 30, load: () => new Promise(() => {})});
  const pending = cache.get('slow');
  pending.catch(() => {});
  await clock.advance(30);
  const error = await pending.catch(e => e);
  assert.ok(error instanceof TimeoutError);
  assert.equal(error.message, 'Loading slow timed out after 30 ms');
});

test('set and delete', async () => {
  const {cache, calls} = setup();
  cache.set('a', 1);
  assert.equal(await cache.get('a'), 1);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  assert.equal(await cache.get('a'), 'a#1');
  assert.deepEqual(calls, ['a']);
});

test('the least recently used entry is evicted', async () => {
  const {cache} = setup({maxEntries: 2});
  cache.set('a', 1);
  cache.set('b', 2);
  await cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.stats().evictions, 1);
});

test('options are validated', () => {
  const clock = fakeClock();
  const load = () => 1;
  assert.throws(() => createCache({load, ttl: 1}), {message: 'clock must have now, setTimeout and clearTimeout functions'});
  assert.throws(() => createCache({clock, ttl: 1}), {message: 'load must be a function'});
  assert.throws(() => createCache({clock, load}), {message: 'ttl must be an integer >= 1'});
  assert.throws(() => createCache({clock, load, ttl: 1, maxEntries: 0}), {message: 'maxEntries must be an integer >= 1 or Infinity'});
});
`;

const VISIBLE_ENTRY = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {classify, errorEntry, valueEntry} from '../src/entry.js';

const policy = {ttl: 100, staleTtl: 50, errorTtl: 20};

test('value entries: fresh, then stale, then expired', () => {
  const entry = valueEntry('v', 1000);
  assert.equal(classify(entry, 1000, policy), 'fresh');
  assert.equal(classify(entry, 1099, policy), 'fresh');
  assert.equal(classify(entry, 1100, policy), 'stale');
  assert.equal(classify(entry, 1120, policy), 'stale');
  assert.equal(classify(entry, 1200, policy), 'expired');
});

test('error entries are valid for errorTtl', () => {
  const entry = errorEntry(new Error('x'), 1000);
  assert.equal(classify(entry, 1019, policy), 'error');
  assert.equal(classify(entry, 1020, policy), 'expired');
});

test('no entry', () => {
  assert.equal(classify(undefined, 0, policy), 'missing');
});
`;

const VISIBLE_LRU = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {LruMap} from '../src/lru.js';

test('touch moves a key to the most recent end', () => {
  const lru = new LruMap();
  lru.store('a', 1);
  lru.store('b', 2);
  lru.store('c', 3);
  assert.equal(lru.oldestKey(), 'a');
  lru.touch('a');
  assert.equal(lru.oldestKey(), 'b');
  assert.equal(lru.peek('a'), 1);
  assert.equal(lru.size, 3);
  assert.equal(lru.delete('b'), true);
  assert.equal(lru.oldestKey(), 'c');
});
`;

const PACKAGE = {name: 'loader-cache', version: '1.3.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}};
// The idiomatic Map-insertion-order LRU: right order, but V8 Map iterators step over every deleted slot, so
// oldestKey() slows down as evictions pile up (the performance clause).
const MAP_LRU = js`/** Entries by key in least-recently-used order, oldest first, kept in Map insertion order. */
export class LruMap {
  #map = new Map();

  get size() { return this.#map.size; }

  /** The entry for key without changing its recency. */
  peek(key) { return this.#map.get(key); }

  /** Make key the most recently used. */
  touch(key) {
    const entry = this.#map.get(key);
    if (entry === undefined) return;
    this.#map.delete(key);
    this.#map.set(key, entry);
  }

  /** Store entry under key as the most recently used. */
  store(key, entry) {
    this.#map.delete(key);
    this.#map.set(key, entry);
  }

  delete(key) { return this.#map.delete(key); }

  clear() { this.#map.clear(); }

  /** The least recently used key, or undefined. */
  oldestKey() { return this.#map.keys().next().value; }
}
`;
// The fixture ships the Map LRU, with the replaceKeepsRecency bug in its own shape.
const FIXTURE = {...applyBugs(Object.keys(BUGS).filter(name => name !== 'replaceKeepsRecency')),
  'src/lru.js': MAP_LRU.replace('  store(key, entry) {\n    this.#map.delete(key);\n', '  store(key, entry) {\n')};
if (FIXTURE['src/lru.js'] === MAP_LRU) throw Error('swr-loader-cache: fixture LRU bug not applied');
const files = {
  'package.json': JSON.stringify(PACKAGE, null, 2) + '\n',
  'README.md': README,
  'CHANGELOG.md': CHANGELOG,
  'docs/CACHE.md': SPEC,
  'docs/ISSUES.md': ISSUES,
  ...FIXTURE,
  'test/fake-clock.js': FAKE_CLOCK,
  'test/cache.test.js': VISIBLE_CACHE,
  'test/entry.test.js': VISIBLE_ENTRY,
  'test/lru.test.js': VISIBLE_LRU,
};

const PERF_BUDGET_MS = 3000;

const HIDDEN = js`import nodeTest from 'node:test';
import assert from 'node:assert/strict';
const {createCache, TimeoutError} = await import('@ROOT@src/index.js');

@FAKE_CLOCK@

// No test may hang the run.
const test = (name, fn) => nodeTest(name, {timeout: name.startsWith('performance') ? 20000 : 5000}, fn);

const unhandled = [];
process.on('unhandledRejection', reason => unhandled.push(reason));

const flush = () => new Promise(resolve => setImmediate(resolve));
const message = error => error instanceof Error ? error.message : String(error);
const fmt = e => [e.type, e.key, e.refresh === undefined ? undefined : (e.refresh ? 'refresh' : 'initial'),
  e.error === undefined ? undefined : message(e.error)].filter(part => part !== undefined).join(' ');

/** A cache whose loads the test settles by hand: loads[i] = {key, signal, resolve, reject}. */
function setup(options = {}) {
  const clock = fakeClock();
  const loads = [];
  const load = (key, {signal}) => new Promise((resolve, reject) => loads.push({key, signal, resolve, reject}));
  const cache = createCache({clock, load, ttl: 100, ...options});
  const log = [];
  cache.on(event => log.push(clock.now() + ' ' + fmt(event)));
  return {clock, cache, log, loads};
}

/** Track a promise's outcome without leaving it unhandled. */
function track(promise) {
  const box = {state: 'pending', value: undefined};
  promise.then(value => { box.state = 'fulfilled'; box.value = value; }, error => { box.state = 'rejected'; box.value = error; });
  return box;
}

/** The outcome of a promise that must settle within one flush; never waits longer. */
async function settled(promise) {
  const box = track(promise);
  await flush();
  if (box.state === 'pending') assert.fail('still pending after a flush');
  if (box.state === 'rejected') throw box.value;
  return box.value;
}

const stat = (cache, ...names) => names.map(name => cache.stats()[name]);

test('option validation: order and messages', () => {
  const clock = fakeClock();
  const load = () => 1;
  const cases = [
    [undefined, TypeError, 'clock must have now, setTimeout and clearTimeout functions'],
    [{clock: null, load, ttl: 1}, TypeError, 'clock must have now, setTimeout and clearTimeout functions'],
    [{clock: {now() {}, setTimeout() {}}, load, ttl: 1}, TypeError, 'clock must have now, setTimeout and clearTimeout functions'],
    [{clock, load: 'x', ttl: 0}, TypeError, 'load must be a function'],
    [{clock, load, ttl: 0, staleTtl: -1}, RangeError, 'ttl must be an integer >= 1'],
    [{clock, load, ttl: 1.5}, RangeError, 'ttl must be an integer >= 1'],
    [{clock, load, ttl: '10'}, RangeError, 'ttl must be an integer >= 1'],
    [{clock, load, ttl: 10, staleTtl: -1, errorTtl: -1}, RangeError, 'staleTtl must be an integer >= 0'],
    [{clock, load, ttl: 10, staleTtl: Infinity}, RangeError, 'staleTtl must be an integer >= 0'],
    [{clock, load, ttl: 10, errorTtl: 0.5, loadTimeout: 0}, RangeError, 'errorTtl must be an integer >= 0'],
    [{clock, load, ttl: 10, loadTimeout: 0, maxEntries: 0}, RangeError, 'loadTimeout must be an integer >= 1'],
    [{clock, load, ttl: 10, loadTimeout: Infinity}, RangeError, 'loadTimeout must be an integer >= 1'],
    [{clock, load, ttl: 10, maxEntries: 2.5}, RangeError, 'maxEntries must be an integer >= 1 or Infinity'],
    [{clock, load, ttl: 10, maxEntries: -Infinity}, RangeError, 'maxEntries must be an integer >= 1 or Infinity'],
  ];
  for (const [options, type, text] of cases) {
    assert.throws(() => createCache(options), error => error instanceof type && error.message === text, text);
  }
  createCache({clock, load, ttl: 1, staleTtl: 0, errorTtl: 0, loadTimeout: 1, maxEntries: 1});
  createCache({clock, load, ttl: 1, staleTtl: undefined, errorTtl: undefined, loadTimeout: undefined, maxEntries: undefined});
});

test('keys must be non-empty strings', async () => {
  const {cache, log, loads} = setup();
  for (const key of ['', 7, undefined, null, {}]) {
    const result = cache.get(key);
    await assert.rejects(settled(result), error => error instanceof TypeError && error.message === 'key must be a non-empty string');
    for (const call of [() => cache.set(key, 1), () => cache.delete(key), () => cache.has(key)]) {
      assert.throws(call, error => error instanceof TypeError && error.message === 'key must be a non-empty string');
    }
  }
  assert.deepEqual(log, []);
  assert.equal(loads.length, 0);
  assert.deepEqual(cache.stats(), {hits: 0, staleHits: 0, errorHits: 0, misses: 0, loads: 0, evictions: 0});
});

test('freshness and staleness windows: exact boundaries', async () => {
  const {clock, cache, log} = setup({staleTtl: 50});
  cache.set('k', 'v');
  await clock.advance(99);
  assert.equal(await settled(cache.get('k')), 'v');
  await clock.advance(1);
  assert.equal(cache.has('k'), true);
  assert.equal(await settled(cache.get('k')), 'v');
  cache.set('k', 'v2');
  await clock.advance(149);
  assert.equal(cache.has('k'), true);
  await clock.advance(1);
  assert.equal(cache.has('k'), false);
  track(cache.get('k'));
  assert.deepEqual(log, ['0 store k', '99 hit k', '100 stale k', '100 load k refresh', '100 store k', '250 miss k', '250 load k initial']);
});

test('with staleTtl 0 a value is never stale', async () => {
  const {clock, cache, log} = setup();
  cache.set('k', 'v');
  await clock.advance(100);
  assert.equal(cache.has('k'), false);
  track(cache.get('k'));
  assert.deepEqual(log, ['0 store k', '100 miss k', '100 load k initial']);
  assert.deepEqual(stat(cache, 'staleHits', 'misses'), [0, 1]);
});

test('storedAt is the time the load ended', async () => {
  const {clock, cache, log, loads} = setup({staleTtl: 20});
  const first = track(cache.get('k'));
  await clock.advance(30);
  loads[0].resolve('slow');
  await flush();
  assert.equal(first.value, 'slow');
  await clock.advance(99);
  assert.equal(await settled(cache.get('k')), 'slow');
  await clock.advance(1);
  assert.equal(await settled(cache.get('k')), 'slow');
  await clock.advance(19);
  assert.equal(cache.has('k'), true);
  await clock.advance(1);
  assert.equal(cache.has('k'), false);
  assert.deepEqual(log, ['0 miss k', '0 load k initial', '30 store k', '129 hit k', '130 stale k', '130 load k refresh']);
});

test('get runs synchronously: events and the load call happen inside the call', () => {
  const {cache, log, loads} = setup();
  track(cache.get('k'));
  assert.deepEqual(log, ['0 miss k', '0 load k initial']);
  assert.equal(loads.length, 1);
  assert.equal(loads[0].key, 'k');
  assert.ok(loads[0].signal instanceof AbortSignal);
  assert.equal(loads[0].signal.aborted, false);
});

test('single flight: misses join the in-flight load, also a refresh', async () => {
  const {clock, cache, log, loads} = setup({staleTtl: 100});
  const a = track(cache.get('k'));
  const b = track(cache.get('k'));
  assert.equal(loads.length, 1);
  loads[0].resolve('v1');
  await flush();
  assert.deepEqual([a.value, b.value], ['v1', 'v1']);
  await clock.advance(150);
  const stale = track(cache.get('k'));
  const stale2 = track(cache.get('k'));
  assert.equal(loads.length, 2);
  await clock.advance(60);
  const joined = track(cache.get('k'));
  assert.equal(loads.length, 2);
  loads[1].resolve('v2');
  await flush();
  assert.deepEqual([stale.value, stale2.value, joined.value], ['v1', 'v1', 'v2']);
  assert.deepEqual(log, ['0 miss k', '0 load k initial', '0 miss k', '0 store k', '150 stale k', '150 load k refresh', '150 stale k',
    '210 miss k', '210 store k']);
  assert.deepEqual(cache.stats(), {hits: 0, staleHits: 2, errorHits: 0, misses: 3, loads: 2, evictions: 0});
});

test('a failed refresh keeps the stale value and puts refreshes on hold for errorTtl', async () => {
  const {clock, cache, log, loads} = setup({staleTtl: 1000, errorTtl: 40});
  cache.set('k', 'old');
  await clock.advance(100);
  assert.equal(await settled(cache.get('k')), 'old');
  await clock.advance(5);
  loads[0].reject(new Error('backend down'));
  await flush();
  assert.equal(await settled(cache.get('k')), 'old');
  await clock.advance(39);
  assert.equal(await settled(cache.get('k')), 'old');
  assert.equal(loads.length, 1);
  assert.equal(cache.has('k'), true);
  await clock.advance(1);
  assert.equal(await settled(cache.get('k')), 'old');
  assert.equal(loads.length, 2);
  loads[1].resolve('new');
  await flush();
  assert.equal(await settled(cache.get('k')), 'new');
  assert.deepEqual(log, ['0 store k', '100 stale k', '100 load k refresh', '105 fail k backend down', '105 stale k', '144 stale k',
    '145 stale k', '145 load k refresh', '145 store k', '145 hit k']);
  assert.deepEqual(unhandled.map(message), []);
});

test('with errorTtl 0 a failed refresh is retried by the next stale get', async () => {
  const {clock, cache, loads} = setup({staleTtl: 1000});
  cache.set('k', 'old');
  await clock.advance(100);
  await settled(cache.get('k'));
  loads[0].reject(new Error('x'));
  await flush();
  assert.equal(await settled(cache.get('k')), 'old');
  assert.equal(loads.length, 2);
});

test('the hold ends when the entry is replaced', async () => {
  const {clock, cache, loads} = setup({staleTtl: 1000, errorTtl: 500});
  cache.set('k', 'old');
  await clock.advance(100);
  await settled(cache.get('k'));
  loads[0].reject(new Error('x'));
  await flush();
  cache.set('k', 'manual');
  await clock.advance(100);
  assert.equal(await settled(cache.get('k')), 'manual');
  assert.equal(loads.length, 2);
});

test('a refresh that a miss joined: a failure is cached when no value entry is left', async () => {
  const {clock, cache, log, loads} = setup({staleTtl: 10, errorTtl: 30});
  cache.set('k', 'old');
  await clock.advance(105);
  await settled(cache.get('k'));
  await clock.advance(5);
  const joined = track(cache.get('k'));
  loads[0].reject(new Error('boom'));
  await flush();
  assert.equal(joined.state, 'rejected');
  assert.equal(joined.value.message, 'boom');
  const again = cache.get('k');
  await assert.rejects(settled(again), error => error === joined.value);
  assert.equal(loads.length, 1);
  assert.deepEqual(log, ['0 store k', '105 stale k', '105 load k refresh', '110 miss k', '110 fail k boom', '110 error-hit k']);
});

test('error entries: valid below errorTtl, the same reason, then reloaded', async () => {
  const {clock, cache, log, loads} = setup({errorTtl: 25});
  const reason = {code: 503};
  const first = track(cache.get('k'));
  loads[0].reject(reason);
  await flush();
  assert.equal(first.value, reason);
  await clock.advance(24);
  assert.equal(cache.has('k'), true);
  await assert.rejects(settled(cache.get('k')), error => error === reason);
  await clock.advance(1);
  assert.equal(cache.has('k'), false);
  track(cache.get('k'));
  assert.equal(loads.length, 2);
  assert.deepEqual(stat(cache, 'errorHits', 'misses', 'loads'), [1, 2, 2]);
  assert.deepEqual(log, ['0 miss k', '0 load k initial', '0 fail k [object Object]', '24 error-hit k', '25 miss k', '25 load k initial']);
});

test('with errorTtl 0 failures are not stored', async () => {
  const {cache, loads} = setup();
  const first = track(cache.get('k'));
  loads[0].reject(new Error('x'));
  await flush();
  assert.equal(first.state, 'rejected');
  assert.equal(cache.has('k'), false);
  track(cache.get('k'));
  assert.equal(loads.length, 2);
});

test('a synchronous throw from load never escapes get and is handled later', async () => {
  const clock = fakeClock();
  const cache = createCache({clock, ttl: 100, errorTtl: 10, load: () => { throw new Error('sync failure'); }});
  const log = [];
  cache.on(event => log.push(fmt(event)));
  let result;
  assert.doesNotThrow(() => { result = cache.get('k'); });
  assert.deepEqual(log, ['miss k', 'load k initial']);
  await assert.rejects(settled(result), {message: 'sync failure'});
  assert.deepEqual(log, ['miss k', 'load k initial', 'fail k sync failure']);
  await assert.rejects(settled(cache.get('k')), {message: 'sync failure'});
  const values = createCache({clock, ttl: 100, load: key => key.toUpperCase()});
  assert.equal(await values.get('abc'), 'ABC');
});

test('timeouts: the signal is aborted with the TimeoutError, a late outcome is ignored, the next miss loads again', async () => {
  const {clock, cache, log, loads} = setup({loadTimeout: 50, errorTtl: 10});
  const first = track(cache.get('k'));
  await clock.advance(49);
  assert.equal(first.state, 'pending');
  await clock.advance(1);
  assert.equal(first.state, 'rejected');
  assert.ok(first.value instanceof TimeoutError);
  assert.equal(first.value.name, 'TimeoutError');
  assert.equal(first.value.message, 'Loading k timed out after 50 ms');
  assert.equal(loads[0].signal.aborted, true);
  assert.equal(loads[0].signal.reason, first.value);
  loads[0].resolve('late');
  await flush();
  await assert.rejects(settled(cache.get('k')), error => error === first.value);
  await clock.advance(10);
  const second = track(cache.get('k'));
  assert.equal(loads.length, 2);
  loads[1].resolve('ok');
  await flush();
  assert.equal(second.value, 'ok');
  assert.equal(clock.pending(), 0);
  assert.deepEqual(log, ['0 miss k', '0 load k initial', '50 fail k Loading k timed out after 50 ms', '50 error-hit k', '60 miss k', '60 load k initial', '60 store k']);
});

test('set detaches the in-flight load: joiners get its value, the cache keeps the set value', async () => {
  const {clock, cache, log, loads} = setup();
  const waiting = track(cache.get('k'));
  cache.set('k', 'mine');
  loads[0].resolve('theirs');
  await flush();
  assert.equal(waiting.value, 'theirs');
  assert.equal(await settled(cache.get('k')), 'mine');
  assert.equal(loads[0].signal.aborted, false);
  await clock.advance(99);
  assert.equal(await settled(cache.get('k')), 'mine');
  assert.deepEqual(log, ['0 miss k', '0 load k initial', '0 store k', '0 hit k', '99 hit k']);
});

test('a detached load that fails has no effect on the cache', async () => {
  const {cache, log, loads} = setup({errorTtl: 100});
  const waiting = track(cache.get('k'));
  cache.set('k', 'mine');
  loads[0].reject(new Error('nope'));
  await flush();
  assert.equal(waiting.value.message, 'nope');
  assert.equal(await settled(cache.get('k')), 'mine');
  assert.deepEqual(log, ['0 miss k', '0 load k initial', '0 store k', '0 hit k']);
});

test('delete detaches: the next miss starts a new load that the old one cannot disturb', async () => {
  const {cache, log, loads} = setup();
  const old = track(cache.get('k'));
  assert.equal(cache.delete('k'), false);
  const a = track(cache.get('k'));
  assert.equal(loads.length, 2);
  loads[0].resolve('old');
  await flush();
  assert.equal(old.value, 'old');
  const b = track(cache.get('k'));
  assert.equal(loads.length, 2);
  loads[1].resolve('new');
  await flush();
  assert.deepEqual([a.value, b.value], ['new', 'new']);
  assert.equal(await settled(cache.get('k')), 'new');
  assert.deepEqual(log, ['0 miss k', '0 load k initial', '0 miss k', '0 load k initial', '0 miss k', '0 store k', '0 hit k']);
});

test('set detaches too: a load started after it is not disturbed by the detached one', async () => {
  const {cache, loads} = setup({ttl: 1});
  track(cache.get('k'));
  cache.set('k', 'mine');
  cache.delete('k');
  const a = track(cache.get('k'));
  loads[0].reject(new Error('old failure'));
  await flush();
  const b = track(cache.get('k'));
  assert.equal(loads.length, 2);
  loads[1].resolve('fresh');
  await flush();
  assert.deepEqual([a.value, b.value], ['fresh', 'fresh']);
});

test('clear detaches every in-flight load and removes every entry', async () => {
  const {cache, log, loads} = setup();
  cache.set('x', 1);
  const a = track(cache.get('a'));
  const b = track(cache.get('b'));
  cache.clear();
  assert.equal(cache.has('x'), false);
  loads[0].resolve('A');
  loads[1].reject(new Error('B'));
  await flush();
  assert.equal(a.value, 'A');
  assert.equal(b.value.message, 'B');
  track(cache.get('a'));
  assert.equal(loads.length, 3);
  assert.deepEqual(log, ['0 store x', '0 miss a', '0 load a initial', '0 miss b', '0 load b initial', '0 miss a', '0 load a initial']);
});

test('delete reports any entry, also an expired one', async () => {
  const {clock, cache} = setup({errorTtl: 5});
  cache.set('v', 1);
  await clock.advance(1000);
  assert.equal(cache.has('v'), false);
  assert.equal(cache.delete('v'), true);
  assert.equal(cache.delete('v'), false);
  assert.equal(cache.delete('never'), false);
});

test('has changes nothing: no events, no statistics, no recency', async () => {
  const {cache, log} = setup({maxEntries: 2});
  cache.set('a', 1);
  cache.set('b', 2);
  log.length = 0;
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('zzz'), false);
  assert.deepEqual(log, []);
  assert.deepEqual(cache.stats(), {hits: 0, staleHits: 0, errorHits: 0, misses: 0, loads: 0, evictions: 0});
  cache.set('c', 3);
  assert.deepEqual(log, ['0 store c', '0 evict a']);
});

test('eviction: least recently used first; serving and replacing make an entry the most recent', async () => {
  const {clock, cache, log, loads} = setup({maxEntries: 3, staleTtl: 100, errorTtl: 1000});
  cache.set('a', 1);
  cache.set('b', 2);
  const failing = track(cache.get('e'));
  loads[0].reject(new Error('bad'));
  await flush();
  assert.equal(failing.state, 'rejected');
  cache.set('a', 10);
  cache.set('c', 3);
  assert.equal(cache.has('b'), false);
  await settled(cache.get('e')).catch(() => {});
  cache.set('d', 4);
  assert.equal(cache.has('a'), false);
  await clock.advance(150);
  await settled(cache.get('c'));
  cache.set('f', 5);
  assert.equal(cache.has('e'), false);
  assert.equal(cache.has('c'), true);
  assert.deepEqual(log.filter(line => line.includes('evict')), ['0 evict b', '0 evict a', '150 evict e']);
  assert.equal(cache.stats().evictions, 3);
});

test('eviction: expired entries count until removed, and the store event comes first', async () => {
  const {clock, cache, log} = setup({maxEntries: 2});
  cache.set('old', 1);
  await clock.advance(500);
  cache.set('a', 2);
  cache.set('b', 3);
  assert.deepEqual(log, ['0 store old', '500 store a', '500 store b', '500 evict old']);
});

test('eviction applies to values stored by loads', async () => {
  const {cache, log, loads} = setup({maxEntries: 1});
  cache.set('a', 1);
  track(cache.get('b'));
  loads[0].resolve(2);
  await flush();
  assert.deepEqual(log, ['0 store a', '0 miss b', '0 load b initial', '0 store b', '0 evict a']);
});

test('stats returns a new object each time', async () => {
  const {cache} = setup();
  cache.set('a', 1);
  const before = cache.stats();
  await settled(cache.get('a'));
  assert.equal(before.hits, 0);
  assert.equal(cache.stats().hits, 1);
  assert.notEqual(cache.stats(), cache.stats());
});

test('events are plain objects with exactly the listed properties', async () => {
  const {clock, cache, loads} = setup({maxEntries: 1, staleTtl: 10, errorTtl: 5});
  const events = [];
  cache.on(event => events.push(event));
  const second = [];
  cache.on(event => second.push(event.type));
  const error = new Error('e');
  track(cache.get('a'));
  loads[0].reject(error);
  await flush();
  await settled(cache.get('a')).catch(() => {});
  cache.set('b', 1);
  await settled(cache.get('b'));
  await clock.advance(100);
  await settled(cache.get('b'));
  assert.deepStrictEqual(events, [{type: 'miss', key: 'a'}, {type: 'load', key: 'a', refresh: false}, {type: 'fail', key: 'a', error},
    {type: 'error-hit', key: 'a'}, {type: 'store', key: 'b'}, {type: 'evict', key: 'a'}, {type: 'hit', key: 'b'}, {type: 'stale', key: 'b'},
    {type: 'load', key: 'b', refresh: true}]);
  assert.deepEqual(second, events.map(event => event.type));
});

test('a failed refresh is never an unhandled rejection', async () => {
  const clock = fakeClock();
  let n = 0;
  const cache = createCache({clock, ttl: 10, staleTtl: 1000, load: () => (++n === 1 ? 'v' : Promise.reject(new Error('refresh failed ' + n)))});
  await settled(cache.get('k'));
  await clock.advance(10);
  await settled(cache.get('k'));
  await clock.advance(10);
  await settled(cache.get('k'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(n, 3);
  assert.deepEqual(unhandled.map(message), []);
});

test('performance: 300,000 distinct sets then 300,000 hits with maxEntries 100,000', async () => {
  const cache = createCache({clock: fakeClock(), load: () => 0, ttl: 1000, maxEntries: 100000});
  const keys = Array.from({length: 300000}, (_, i) => 'key' + i);
  const started = performance.now();
  for (let i = 0; i < keys.length; i++) {
    cache.set(keys[i], i);
    if (i % 1000 === 0 && performance.now() - started > ${PERF_BUDGET_MS}) assert.fail('only ' + i + ' sets within ${PERF_BUDGET_MS} ms');
  }
  const hits = [];
  const order = [];
  for (let i = 200000; i < 300000; i++) order.push(i);
  for (let i = 299999; i >= 200000; i--) order.push(i);
  for (let i = 200000; i < 300000; i++) order.push(i);
  for (let n = 0; n < order.length; n++) {
    hits.push(cache.get(keys[order[n]]));
    if (n % 1000 === 0 && performance.now() - started > ${PERF_BUDGET_MS}) assert.fail('only ' + n + ' hits within ${PERF_BUDGET_MS} ms');
  }
  await Promise.all(hits);
  const elapsed = performance.now() - started;
  assert.deepEqual(cache.stats(), {hits: 300000, staleHits: 0, errorHits: 0, misses: 0, loads: 0, evictions: 200000});
  assert.ok(elapsed < ${PERF_BUDGET_MS}, 'took ' + Math.round(elapsed) + ' ms');
});
`.replace('@FAKE_CLOCK@', FAKE_CLOCK.replace('export function', 'function'));

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

// A forbidden change on top of the reference: one planted bug put back.
const withBug = name => root => writeTree(root, applyBugs([name]));

export default {
  id: 'swr-loader-cache',
  category: 'async bug hunt across a multi-file library',
  prompt: 'The cache library in src/ has open bug reports in docs/ISSUES.md and may deviate from its specification, docs/CACHE.md, in other ways too. ' +
    'Find the root causes and make the library implement docs/CACHE.md completely and exactly. ' +
    'Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['loader-cache 1.3.0', files]]),
  solve: root => writeTree(root, SOURCES),
  verify(root, before) {
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, HIDDEN);
    let pkg = {};
    try { pkg = JSON.parse(read(root, 'package.json')); } catch {}
    return verdict({
      tests_unchanged: unchanged(before, root, 'test/', {allowAdded: true}),
      no_dependencies: DEPENDENCY_FIELDS.every(field => pkg[field] === undefined),
      suite_passes: suite.status === 0,
      hidden_cases: hidden.pass,
    }, {suite: (suite.stdout + suite.stderr).slice(-2000), hidden: hidden.output});
  },
  mustReject: [
    ...Object.keys(BUGS).map(withBug),
    // The Map-insertion-order LRU: correct order, too slow.
    root => writeTree(root, {'src/lru.js': MAP_LRU}),
    // An LRU kept as an array of keys.
    root => writeTree(root, {'src/lru.js': js`export class LruMap {
  #map = new Map();
  #order = [];
  get size() { return this.#map.size; }
  peek(key) { return this.#map.get(key); }
  touch(key) {
    if (!this.#map.has(key)) return;
    this.#order.splice(this.#order.indexOf(key), 1);
    this.#order.push(key);
  }
  store(key, entry) {
    if (this.#map.has(key)) this.#order.splice(this.#order.indexOf(key), 1);
    this.#map.set(key, entry);
    this.#order.push(key);
  }
  delete(key) {
    if (!this.#map.delete(key)) return false;
    this.#order.splice(this.#order.indexOf(key), 1);
    return true;
  }
  clear() { this.#map.clear(); this.#order = []; }
  oldestKey() { return this.#order[0]; }
}
`}),
    // A visible test edited.
    root => writeTree(root, {'test/entry.test.js': VISIBLE_ENTRY.replace("test('no entry'", "test.skip('no entry'")}),
  ],
};
