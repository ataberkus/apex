import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture and hidden-test sources are String.raw templates: they never contain a backtick or "${".
const js = String.raw;

const SPEC = `# Resource pool

\`createPool(options)\` in \`src/pool.js\` lends a bounded set of reusable resources (connections, worker handles and the like) to asynchronous callers. Callers that cannot be served at once wait in strict first-come, first-served order. The pool never uses the global timer functions or \`Date\`: all timing goes through the injected clock.

## Clock

\`options.clock\` is an object with two functions:

- \`setTimeout(callback, ms)\` arranges for \`callback()\` to be called once, \`ms\` milliseconds from now, and returns a handle.
- \`clearTimeout(handle)\` cancels a callback that has not run yet.

The tests use \`test/fake-clock.js\`: time moves only when a test calls \`advance(ms)\`. Callbacks that are due at the same time run in the order they were registered, and all pending promise reactions run before the next callback.

## Options

\`createPool({clock, create, destroy, validate, max = 10, minIdle = 0, acquireTimeout, idleTimeout, maxUses})\`

- \`create()\` makes a new resource and returns it or a promise for it. Every resource is a distinct object; the pool tells resources apart by identity.
- \`destroy(resource)\` (optional) is called once for every resource the pool gets rid of (see Destroying).
- \`validate(resource)\` (optional) returns a boolean or a promise for one (see Checks).
- \`max\`: the most resources the pool may hold at once (see Size).
- \`minIdle\`: see Idle resources.
- \`acquireTimeout\`: the default for how long, in milliseconds, \`acquire\` waits. When it is \`undefined\`, callers wait without limit.
- \`idleTimeout\`: how long, in milliseconds, a resource may stay idle (see Idle resources). When it is \`undefined\`, idle resources are kept forever.
- \`maxUses\`: the most leases a resource may serve (see Releasing). When it is \`undefined\`, there is no limit.

An option that is \`undefined\` takes its default. \`createPool\` does not call \`create\`: a new pool holds no resources.

### Validation

\`createPool\` checks its options in this order and throws for the first problem, with exactly these messages ("integer" means \`Number.isInteger\`, so \`2.0\` is an integer and \`'2'\` is not):

1. \`clock\` must be a non-null object whose \`setTimeout\` and \`clearTimeout\` are functions: \`TypeError\` \`clock must provide setTimeout and clearTimeout\` (also when \`options\` is missing).
2. \`create\` must be a function: \`TypeError\` \`create must be a function\`.
3. \`destroy\` must be \`undefined\` or a function: \`TypeError\` \`destroy must be a function\`.
4. \`validate\` must be \`undefined\` or a function: \`TypeError\` \`validate must be a function\`.
5. \`max\` must be an integer >= 1: \`RangeError\` \`max must be an integer >= 1\`.
6. \`minIdle\` must be an integer from 0 to \`max\` inclusive: \`RangeError\` \`minIdle must be an integer between 0 and max\`.
7. \`acquireTimeout\`, \`idleTimeout\` and \`maxUses\`, in this order, must each be \`undefined\` or an integer >= 1: \`RangeError\` \`<name> must be an integer >= 1\` (for example \`idleTimeout must be an integer >= 1\`).

## Resources and size

Each time the pool calls \`create\`, the new resource gets an id: 1 for the first call on this pool, then 2, 3 and so on. A creation that fails has used up its id.

At any moment every resource of the pool is in exactly one of these states: *creating* (\`create\` was called and has not settled), *idle*, *checking* (\`validate\` was called and has not settled) or *leased*. The *size* of the pool is the number of its resources in any of these states, and it never exceeds \`max\`. Creating and checking resources are *pending*. A destroyed resource leaves the pool at that moment.

The pool object has these getters: \`size\`, \`idle\` (the number of idle resources), \`leased\`, \`pending\` and \`waiting\` (the number of queued waiters).

## Acquiring

\`acquire({timeout, signal} = {})\` returns a promise for a resource. It never throws: every problem rejects the returned promise. Every call to \`acquire\` gets a waiter number: 1 for the first call on this pool, then 2, 3 and so on, also for calls that are rejected at once. \`acquire\` takes these steps, in this order:

1. The call gets its waiter number.
2. If the pool is draining, the promise rejects with an \`Error\` \`Pool is draining\`; if it is closed, with an \`Error\` \`Pool is closed\`.
3. \`timeout\` must be \`undefined\` or an integer >= 1, else the promise rejects with a \`RangeError\` \`timeout must be an integer >= 1\`. When it is \`undefined\`, the pool's \`acquireTimeout\` applies.
4. If \`signal\` is given and already aborted, the promise rejects with \`signal.reason\`.
5. The caller becomes a *waiter* at the end of the queue.
6. If a timeout applies, a clock callback is registered for it (see Waiting limits); if \`signal\` is given, the waiter listens for its \`abort\` event.
7. Dispatch.

A call rejected in steps 2 to 4 emits no event and queues nothing.

## Dispatch

The pool *dispatches* synchronously inside every call or callback that changes its state: \`acquire\`, \`release\`, \`invalidate\`, \`drain\`, the settlement of a \`create\` or \`validate\` call, and every clock callback or abort. A caller that can be served at once is therefore served inside the \`acquire\` call itself. Dispatching takes these steps:

1. While the number of waiters is greater than the number of pending resources:
   1. If an idle resource exists, take the one that became idle most recently (last in, first out). Without \`validate\`, lease it to the head waiter. With \`validate\`, check it (see Checks).
   2. Otherwise, if the size is below \`max\`, create a resource (see Creating).
   3. Otherwise, stop repeating.
2. If the pool is draining, no waiter is queued and the size is 0, the pool closes (see Draining).

A pending resource is never reserved for a particular waiter: whoever is at the head of the queue at the moment a resource becomes available gets it.

*Leasing* a resource to the head waiter takes these steps, in this order: the waiter leaves the queue (its clock callback is cleared and it stops listening to its signal); the resource becomes leased and its use count goes up by one; emit \`acquire\`; the waiter's promise fulfils with the resource.

## Making a resource available

A resource becomes *available* when its \`create\` fulfils, when its check passes, and when its holder releases it (unless it is destroyed because of \`maxUses\`). An available resource:

1. is leased to the head waiter if a waiter is queued;
2. otherwise is destroyed with reason \`'drain'\` if the pool is draining;
3. otherwise becomes idle, as the most recent idle resource. If \`idleTimeout\` is set, a clock callback is registered for it (see Idle resources).

## Creating

Creating a resource takes these steps: the resource gets the next id and becomes creating; emit \`create\`; call \`create()\`. The outcome of \`create\` is always handled asynchronously, in a promise reaction: a returned value or promise is treated like \`Promise.resolve(value)\` and a synchronous throw like a returned rejected promise, so no event about the outcome is emitted before the call that called \`create\` has returned.

- When it fulfils: emit \`ready\`; the resource becomes available; dispatch.
- When it rejects with \`error\`: the resource leaves the pool; emit \`create-error\`; if a waiter is queued, the head waiter leaves the queue (its callback is cleared and it stops listening to its signal) and its promise rejects with \`error\`; dispatch. The waiter that is rejected is whoever is at the head at that moment, not necessarily the caller whose \`acquire\` led to this creation.

## Checks

A resource taken from the idle list while \`validate\` is set is checked: its idle clock callback (if any) is cleared, it becomes checking, emit \`check\`, then call \`validate(resource)\`. The outcome is handled asynchronously, exactly like the outcome of \`create\`.

- The check passes only when \`validate\` fulfils with the value \`true\` itself. The resource becomes available; dispatch.
- Any other value (including truthy values such as \`1\`), a rejection or a synchronous throw fails the check: emit \`check-failed\`, destroy the resource with reason \`'check'\`, dispatch.

Only resources taken from the idle list are checked. A newly created resource, and a resource released while a waiter is queued, go to the head waiter without a check.

## Releasing

\`release(resource)\` gives a leased resource back. If \`resource\` is not currently leased (never seen, idle, already released or destroyed), it throws an \`Error\` \`Resource is not leased\` and changes nothing. Otherwise: emit \`release\`; if \`maxUses\` is set and the resource's use count has reached \`maxUses\`, destroy it with reason \`'uses'\`, otherwise it becomes available; dispatch.

\`invalidate(resource)\` is for a resource that turned out to be broken. It throws the same error for a resource that is not leased. Otherwise it destroys the resource with reason \`'invalid'\` (no \`release\` event) and dispatches.

## Destroying

Destroying a resource takes these steps: it leaves the pool (and the idle list, clearing its idle clock callback if any); emit \`destroy\`; call \`destroy(resource)\` if that option is set. The pool does not wait for \`destroy\`: whatever it returns is ignored, and when it throws or returns a promise that rejects, the error is ignored and must never be reported as an unhandled rejection.

## Waiting limits

When a waiter's clock callback runs, the waiter leaves the queue (it stops listening to its signal), emit \`timeout\`, and its promise rejects with a \`TimeoutError\`; dispatch. \`TimeoutError\` (exported) is an \`Error\` subclass whose \`name\` is \`'TimeoutError'\`; its message is \`Timed out after <ms> ms waiting for a resource\`, where \`<ms>\` is the timeout that applied to that call.

When a waiter's signal is aborted, the waiter leaves the queue (its clock callback is cleared), emit \`abort\`, and its promise rejects with \`signal.reason\`; dispatch.

Creations and checks that are pending when a waiter gives up are not cancelled: their resources become available as usual and become idle when nobody is waiting. Once a waiter has been served or rejected, its signal and its clock callback no longer have any effect.

## Idle resources

When the clock callback of an idle resource runs (\`idleTimeout\` milliseconds after it became idle), the resource is destroyed with reason \`'idle'\` if the number of idle resources is greater than \`minIdle\`; then dispatch. Otherwise the resource stays idle without a clock callback; it gets a new one only when it becomes idle again after a later lease.

## Draining

\`drain()\` returns a promise; every later call returns the same promise. The first call takes these steps: the pool becomes draining; emit \`drain\`; destroy every idle resource with reason \`'drain'\`, starting with the one that has been idle longest; dispatch.

Waiters that are already queued are still served, and pending creations and checks go on. While the pool is draining, a resource that becomes available while nobody is waiting is destroyed instead of becoming idle (see Making a resource available).

When the pool closes (dispatch step 2), emit \`closed\` and the drain promise fulfils with \`undefined\`. A closed pool stays closed.

## Events

\`on(listener)\` subscribes \`listener\`. Every event is passed synchronously to every subscribed listener, in subscription order. An event is a plain object with exactly the properties listed here; \`id\` is a resource id and \`waiter\` a waiter number.

- \`{type: 'create', id}\`
- \`{type: 'ready', id}\`
- \`{type: 'create-error', id, error}\`: \`error\` is the rejection reason itself.
- \`{type: 'check', id}\`
- \`{type: 'check-failed', id}\`
- \`{type: 'acquire', id, waiter}\`
- \`{type: 'release', id}\`
- \`{type: 'destroy', id, reason}\`: \`reason\` is one of \`'check'\`, \`'uses'\`, \`'invalid'\`, \`'idle'\`, \`'drain'\`.
- \`{type: 'timeout', waiter}\`
- \`{type: 'abort', waiter}\`
- \`{type: 'drain'}\`
- \`{type: 'closed'}\`

## Performance

Pools can have hundreds of thousands of queued waiters. \`acquire\`, \`release\`, a timeout, an abort and each step of dispatch must take time that does not grow with the number of waiters or resources (constant or logarithmic, amortized). With 300,000 waiters queued, aborting all but 10 of them in an arbitrary order and then serving those 10 must take well under three seconds; a constant-time queue needs less than one.
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

const NAIVE = js`/** Resource pool; see docs/POOL.md. First cut: FIFO waiters, a size limit and acquire timeouts. */
export class TimeoutError extends Error {
  constructor(ms) {
    super('Timed out after ' + ms + ' ms waiting for a resource');
    this.name = 'TimeoutError';
  }
}

export function createPool({clock, create, max = 10, acquireTimeout} = {}) {
  const idle = [];
  const waiters = [];
  const leased = new Set();
  let size = 0;

  function serve() {
    while (waiters.length && idle.length) {
      const waiter = waiters.shift();
      const resource = idle.shift();
      if (waiter.timer !== undefined) clock.clearTimeout(waiter.timer);
      leased.add(resource);
      waiter.resolve(resource);
    }
    while (waiters.length > 0 && size < max) {
      size++;
      Promise.resolve(create()).then(resource => {
        idle.push(resource);
        serve();
      });
      break;
    }
  }

  return {
    get size() { return size; },
    get idle() { return idle.length; },
    get leased() { return leased.size; },
    get waiting() { return waiters.length; },
    acquire({timeout = acquireTimeout} = {}) {
      return new Promise((resolve, reject) => {
        const waiter = {resolve, timer: undefined};
        waiters.push(waiter);
        if (timeout !== undefined) {
          waiter.timer = clock.setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new TimeoutError(timeout));
          }, timeout);
        }
        serve();
      });
    },
    release(resource) {
      if (!leased.has(resource)) throw new Error('Resource is not leased');
      leased.delete(resource);
      idle.push(resource);
      serve();
    },
  };
}
`;

const VISIBLE = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {createPool, TimeoutError} from '../src/pool.js';
import {fakeClock} from './fake-clock.js';

function counter() {
  let n = 0;
  return () => ({name: 'r' + (++n)});
}

test('a released resource is reused', async () => {
  const clock = fakeClock();
  let calls = 0;
  const make = counter();
  const pool = createPool({clock, create: () => { calls++; return make(); }});
  const a = await pool.acquire();
  pool.release(a);
  const b = await pool.acquire();
  assert.equal(b, a);
  assert.equal(calls, 1);
  assert.equal(pool.size, 1);
  assert.equal(pool.leased, 1);
});

test('never more than max resources; waiters are served in arrival order', async () => {
  const clock = fakeClock();
  const pool = createPool({clock, create: counter(), max: 2});
  const a = await pool.acquire();
  const b = await pool.acquire();
  const served = [];
  const third = pool.acquire().then(r => { served.push('third:' + r.name); return r; });
  const fourth = pool.acquire().then(r => { served.push('fourth:' + r.name); return r; });
  await clock.flush();
  assert.equal(pool.size, 2);
  assert.equal(pool.waiting, 2);
  pool.release(b);
  await clock.flush();
  pool.release(a);
  await Promise.all([third, fourth]);
  assert.deepEqual(served, ['third:r2', 'fourth:r1']);
});

test('acquire times out', async () => {
  const clock = fakeClock();
  const pool = createPool({clock, create: counter(), max: 1, acquireTimeout: 50});
  await pool.acquire();
  const waiting = pool.acquire();
  let error;
  waiting.catch(e => { error = e; });
  await clock.advance(49);
  assert.equal(error, undefined);
  await clock.advance(1);
  assert.ok(error instanceof TimeoutError);
  assert.equal(error.message, 'Timed out after 50 ms waiting for a resource');
  assert.equal(pool.waiting, 0);
});

test('releasing an unknown resource throws', () => {
  const pool = createPool({clock: fakeClock(), create: counter()});
  assert.throws(() => pool.release({}), {message: 'Resource is not leased'});
});
`;

const PACKAGE = {name: 'lease-pool', version: '1.0.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}};
const files = {
  'package.json': JSON.stringify(PACKAGE, null, 2) + '\n',
  'docs/POOL.md': SPEC,
  'src/pool.js': NAIVE,
  'test/fake-clock.js': FAKE_CLOCK,
  'test/pool.test.js': VISIBLE,
};

const REFERENCE = js`/** Resource pool with FIFO waiters, checks, idle eviction, use limits and draining; see docs/POOL.md. */
export class TimeoutError extends Error {
  constructor(ms) {
    super('Timed out after ' + ms + ' ms waiting for a resource');
    this.name = 'TimeoutError';
  }
}

const isFunction = value => typeof value === 'function';
const optionalCount = value => value === undefined || (Number.isInteger(value) && value >= 1);

/** Doubly linked list over nodes that carry their own prev/next, so any node leaves in constant time. */
class List {
  head = null;
  tail = null;
  length = 0;
  push(node) {
    node.prev = this.tail;
    node.next = null;
    if (this.tail) this.tail.next = node; else this.head = node;
    this.tail = node;
    this.length++;
  }
  remove(node) {
    if (node.prev) node.prev.next = node.next; else this.head = node.next;
    if (node.next) node.next.prev = node.prev; else this.tail = node.prev;
    node.prev = node.next = null;
    this.length--;
  }
}

/** Call fn() and return its outcome as a promise; a synchronous throw becomes a rejection. */
function attempt(fn) {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

export function createPool(options = {}) {
  const {clock, create, destroy, validate, max = 10, minIdle = 0, acquireTimeout, idleTimeout, maxUses} = options;
  if (clock === null || typeof clock !== 'object' || !isFunction(clock.setTimeout) || !isFunction(clock.clearTimeout)) {
    throw new TypeError('clock must provide setTimeout and clearTimeout');
  }
  if (!isFunction(create)) throw new TypeError('create must be a function');
  if (destroy !== undefined && !isFunction(destroy)) throw new TypeError('destroy must be a function');
  if (validate !== undefined && !isFunction(validate)) throw new TypeError('validate must be a function');
  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be an integer >= 1');
  if (!Number.isInteger(minIdle) || minIdle < 0 || minIdle > max) throw new RangeError('minIdle must be an integer between 0 and max');
  for (const [name, value] of [['acquireTimeout', acquireTimeout], ['idleTimeout', idleTimeout], ['maxUses', maxUses]]) {
    if (!optionalCount(value)) throw new RangeError(name + ' must be an integer >= 1');
  }

  const waiters = new List();
  const idle = new List();
  const leasedRecords = new Map();
  const listeners = [];
  let state = 'open';
  let lastId = 0, lastWaiter = 0, size = 0, pending = 0;
  let drained, resolveDrained;

  const emit = event => { for (const listener of listeners) listener(event); };

  function leave(waiter) {
    waiters.remove(waiter);
    if (waiter.timer !== undefined) clock.clearTimeout(waiter.timer);
    waiter.timer = undefined;
    if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
  }

  function dispatch() {
    while (waiters.length > pending) {
      if (idle.length) {
        const record = idle.tail;
        idle.remove(record);
        clearIdle(record);
        if (validate) check(record); else lease(record);
      } else if (size < max) startCreate();
      else break;
    }
    if (state === 'draining' && !waiters.length && !size) {
      state = 'closed';
      emit({type: 'closed'});
      resolveDrained();
    }
  }

  function lease(record) {
    const waiter = waiters.head;
    leave(waiter);
    record.state = 'leased';
    record.uses++;
    leasedRecords.set(record.resource, record);
    emit({type: 'acquire', id: record.id, waiter: waiter.number});
    waiter.resolve(record.resource);
  }

  function clearIdle(record) {
    if (record.timer !== undefined) clock.clearTimeout(record.timer);
    record.timer = undefined;
  }

  function available(record) {
    if (waiters.length) lease(record);
    else if (state !== 'open') remove(record, 'drain');
    else {
      record.state = 'idle';
      idle.push(record);
      if (idleTimeout !== undefined) record.timer = clock.setTimeout(() => expire(record), idleTimeout);
    }
  }

  function expire(record) {
    record.timer = undefined;
    if (record.state !== 'idle') return;
    if (idle.length > minIdle) remove(record, 'idle');
    dispatch();
  }

  function remove(record, reason) {
    if (record.state === 'idle') idle.remove(record);
    clearIdle(record);
    record.state = 'gone';
    size--;
    emit({type: 'destroy', id: record.id, reason});
    if (destroy) attempt(() => destroy(record.resource)).catch(() => {});
  }

  function startCreate() {
    const record = {id: ++lastId, resource: undefined, state: 'creating', uses: 0, timer: undefined, prev: null, next: null};
    size++;
    pending++;
    emit({type: 'create', id: record.id});
    attempt(() => create()).then(resource => {
      pending--;
      record.resource = resource;
      emit({type: 'ready', id: record.id});
      available(record);
      dispatch();
    }, error => {
      pending--;
      size--;
      record.state = 'gone';
      emit({type: 'create-error', id: record.id, error});
      const waiter = waiters.head;
      if (waiter) {
        leave(waiter);
        waiter.reject(error);
      }
      dispatch();
    });
  }

  function check(record) {
    record.state = 'checking';
    pending++;
    emit({type: 'check', id: record.id});
    const done = passed => {
      pending--;
      if (passed) available(record);
      else {
        emit({type: 'check-failed', id: record.id});
        remove(record, 'check');
      }
      dispatch();
    };
    attempt(() => validate(record.resource)).then(value => done(value === true), () => done(false));
  }

  function takeLeased(resource) {
    const record = leasedRecords.get(resource);
    if (!record) throw new Error('Resource is not leased');
    leasedRecords.delete(resource);
    record.state = 'returned';
    return record;
  }

  return {
    get size() { return size; },
    get idle() { return idle.length; },
    get leased() { return leasedRecords.size; },
    get pending() { return pending; },
    get waiting() { return waiters.length; },
    on(listener) { listeners.push(listener); },
    acquire({timeout, signal} = {}) {
      const number = ++lastWaiter;
      if (state === 'draining') return Promise.reject(new Error('Pool is draining'));
      if (state === 'closed') return Promise.reject(new Error('Pool is closed'));
      if (!optionalCount(timeout)) return Promise.reject(new RangeError('timeout must be an integer >= 1'));
      const limit = timeout ?? acquireTimeout;
      if (signal !== undefined && signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const waiter = {number, resolve, reject, timer: undefined, signal, onAbort: undefined, prev: null, next: null};
        waiters.push(waiter);
        if (limit !== undefined) {
          waiter.timer = clock.setTimeout(() => {
            waiter.timer = undefined;
            leave(waiter);
            emit({type: 'timeout', waiter: number});
            reject(new TimeoutError(limit));
            dispatch();
          }, limit);
        }
        if (signal !== undefined) {
          waiter.onAbort = () => {
            leave(waiter);
            emit({type: 'abort', waiter: number});
            reject(signal.reason);
            dispatch();
          };
          signal.addEventListener('abort', waiter.onAbort);
        }
        dispatch();
      });
    },
    release(resource) {
      const record = takeLeased(resource);
      emit({type: 'release', id: record.id});
      if (maxUses !== undefined && record.uses >= maxUses) remove(record, 'uses');
      else available(record);
      dispatch();
    },
    invalidate(resource) {
      remove(takeLeased(resource), 'invalid');
      dispatch();
    },
    drain() {
      if (!drained) {
        drained = new Promise(resolve => { resolveDrained = resolve; });
        state = 'draining';
        emit({type: 'drain'});
        while (idle.head) remove(idle.head, 'drain');
        dispatch();
      }
      return drained;
    },
  };
}
`;

const PERF_BUDGET_MS = 3000;
const PERF_WAITERS = 300000;

const HIDDEN = js`import nodeTest from 'node:test';
import assert from 'node:assert/strict';
const {createPool, TimeoutError} = await import('@ROOT@src/pool.js');

@FAKE_CLOCK@

// No test may hang the run.
const test = (name, fn) => nodeTest(name, {timeout: name.startsWith('performance') ? 20000 : 5000}, fn);

const unhandled = [];
process.on('unhandledRejection', reason => unhandled.push(reason));

const flush = () => new Promise(resolve => setImmediate(resolve));
const message = error => error instanceof Error ? error.message : String(error);
const fmt = e => [e.type, e.id === undefined ? undefined : 'r' + e.id, e.waiter === undefined ? undefined : 'w' + e.waiter,
  e.reason, e.error === undefined ? undefined : message(e.error)].filter(part => part !== undefined).join(' ');

/** Resources are {name: 'r<n>'} objects made synchronously, unless manual is set: then each create() call waits for the test. */
function setup(options = {}, {manual = false} = {}) {
  const clock = fakeClock();
  const creations = [];
  let made = 0;
  const create = manual
    ? () => new Promise((resolve, reject) => creations.push({resolve: () => resolve({name: 'r' + (++made)}), reject}))
    : () => ({name: 'r' + (++made)});
  const pool = createPool({clock, create, ...options});
  const log = [];
  pool.on(event => log.push(clock.now() + ' ' + fmt(event)));
  return {clock, pool, log, creations};
}

/** Track a promise's outcome without leaving it unhandled. */
function track(promise) {
  const box = {state: 'pending', value: undefined};
  promise.then(value => { box.state = 'fulfilled'; box.value = value; }, error => { box.state = 'rejected'; box.value = error; });
  return box;
}

test('option validation: order and messages', () => {
  const clock = fakeClock();
  const create = () => ({});
  const cases = [
    [undefined, TypeError, 'clock must provide setTimeout and clearTimeout'],
    [{create}, TypeError, 'clock must provide setTimeout and clearTimeout'],
    [{clock: null, create}, TypeError, 'clock must provide setTimeout and clearTimeout'],
    [{clock: {setTimeout() {}}, create}, TypeError, 'clock must provide setTimeout and clearTimeout'],
    [{clock, max: 0}, TypeError, 'create must be a function'],
    [{clock, create: 'make'}, TypeError, 'create must be a function'],
    [{clock, create, destroy: 5, max: 0}, TypeError, 'destroy must be a function'],
    [{clock, create, validate: true, max: 0}, TypeError, 'validate must be a function'],
    [{clock, create, max: 0, minIdle: -1}, RangeError, 'max must be an integer >= 1'],
    [{clock, create, max: 2.5}, RangeError, 'max must be an integer >= 1'],
    [{clock, create, max: '3'}, RangeError, 'max must be an integer >= 1'],
    [{clock, create, minIdle: 11}, RangeError, 'minIdle must be an integer between 0 and max'],
    [{clock, create, max: 2, minIdle: 3, acquireTimeout: 0}, RangeError, 'minIdle must be an integer between 0 and max'],
    [{clock, create, minIdle: 0.5}, RangeError, 'minIdle must be an integer between 0 and max'],
    [{clock, create, acquireTimeout: 0, idleTimeout: 0}, RangeError, 'acquireTimeout must be an integer >= 1'],
    [{clock, create, idleTimeout: '5', maxUses: 0}, RangeError, 'idleTimeout must be an integer >= 1'],
    [{clock, create, maxUses: -1}, RangeError, 'maxUses must be an integer >= 1'],
    [{clock, create, maxUses: 1.5}, RangeError, 'maxUses must be an integer >= 1'],
  ];
  for (const [options, type, text] of cases) {
    assert.throws(() => createPool(options), error => error instanceof type && error.message === text, text);
  }
  const pool = createPool({clock, create, max: 2.0, minIdle: 2, acquireTimeout: undefined, idleTimeout: 1, maxUses: 1, destroy: undefined, validate: undefined});
  assert.equal(pool.size, 0);
});

test('createPool creates nothing; defaults allow 10 resources', async () => {
  let calls = 0;
  const pool = createPool({clock: fakeClock(), create: () => ({n: ++calls})});
  assert.equal(calls, 0);
  for (let i = 0; i < 12; i++) track(pool.acquire());
  assert.equal(calls, 10);
  assert.equal(pool.size, 10);
  assert.equal(pool.pending, 10);
  await flush();
  assert.equal(pool.leased, 10);
  assert.equal(pool.waiting, 2);
  assert.equal(pool.pending, 0);
});

test('events are plain objects with exactly the listed properties', async () => {
  const {pool, creations} = setup({max: 1}, {manual: true});
  const events = [];
  pool.on(event => events.push(event));
  const first = track(pool.acquire());
  creations[0].resolve();
  await flush();
  pool.release(first.value);
  pool.drain();
  assert.deepStrictEqual(events, [{type: 'create', id: 1}, {type: 'ready', id: 1}, {type: 'acquire', id: 1, waiter: 1},
    {type: 'release', id: 1}, {type: 'drain'}, {type: 'destroy', id: 1, reason: 'drain'}, {type: 'closed'}]);
});

test('an idle resource is leased synchronously inside acquire, most recently idle first', async () => {
  const {pool, log} = setup();
  const held = [track(pool.acquire()), track(pool.acquire()), track(pool.acquire())];
  await flush();
  const [a, b, c] = held.map(box => box.value);
  pool.release(b);
  pool.release(a);
  pool.release(c);
  log.length = 0;
  const next = pool.acquire();
  assert.deepEqual(log, ['0 acquire r3 w4']);
  assert.equal(await next, c);
  const after = pool.acquire();
  assert.deepEqual(log, ['0 acquire r3 w4', '0 acquire r1 w5']);
  assert.equal(await after, a);
  assert.equal(pool.idle, 1);
});

test('a pending resource is not reserved: a release goes to the head waiter and the creation ends idle', async () => {
  const {pool, log, creations} = setup({max: 2}, {manual: true});
  const first = track(pool.acquire());
  creations[0].resolve();
  await flush();
  const second = track(pool.acquire());
  assert.equal(pool.pending, 1);
  pool.release(first.value);
  assert.equal(second.state, 'pending');
  await flush();
  assert.equal(second.value, first.value);
  creations[1].resolve();
  await flush();
  assert.deepEqual(log, ['0 create r1', '0 ready r1', '0 acquire r1 w1', '0 create r2', '0 release r1', '0 acquire r1 w2', '0 ready r2']);
  assert.equal(pool.idle, 1);
  assert.equal(pool.size, 2);
});

test('a failed creation rejects whoever is at the head of the queue', async () => {
  const {pool, log, creations} = setup({max: 2}, {manual: true});
  const w1 = track(pool.acquire());
  const w2 = track(pool.acquire());
  const w3 = track(pool.acquire());
  assert.equal(creations.length, 2);
  creations[1].reject(new Error('refused'));
  await flush();
  assert.equal(w1.state, 'rejected');
  assert.equal(w1.value.message, 'refused');
  assert.equal(w2.state, 'pending');
  assert.equal(creations.length, 3, 'two waiters, one pending creation: create again');
  creations[0].resolve();
  await flush();
  assert.equal(w2.value.name, 'r1');
  creations[2].reject(new Error('down'));
  await flush();
  assert.equal(w3.state, 'rejected');
  assert.equal(w3.value.message, 'down');
  assert.equal(creations.length, 3);
  assert.deepEqual(log, ['0 create r1', '0 create r2', '0 create-error r2 refused', '0 create r3', '0 ready r1', '0 acquire r1 w2',
    '0 create-error r3 down']);
  assert.equal(pool.size, 1);
  assert.equal(pool.waiting, 0);
});

test('a failed creation with nobody waiting rejects nobody; ids are used up', async () => {
  const {clock, pool, log, creations} = setup({max: 1}, {manual: true});
  const w1 = track(pool.acquire({timeout: 10}));
  await clock.advance(10);
  assert.equal(w1.value.message, 'Timed out after 10 ms waiting for a resource');
  creations[0].reject(new Error('late'));
  await flush();
  const w2 = track(pool.acquire());
  creations[1].resolve();
  await flush();
  assert.equal(w2.value.name, 'r1');
  assert.deepEqual(log, ['0 create r1', '10 timeout w1', '10 create-error r1 late', '10 create r2', '10 ready r2', '10 acquire r2 w2']);
});

test('the outcome of create is handled asynchronously, also for a synchronous throw', async () => {
  const clock = fakeClock();
  let sync = true;
  const pool = createPool({clock, create: () => { if (sync) throw new Error('no capacity'); return {name: 'ok'}; }});
  const log = [];
  pool.on(event => log.push(fmt(event)));
  const first = track(pool.acquire());
  assert.deepEqual(log, ['create r1']);
  assert.equal(pool.pending, 1);
  assert.equal(pool.size, 1);
  await flush();
  assert.equal(first.state, 'rejected');
  assert.equal(first.value.message, 'no capacity');
  sync = false;
  const second = track(pool.acquire());
  assert.deepEqual(log, ['create r1', 'create-error r1 no capacity', 'create r2']);
  await flush();
  assert.equal(second.value.name, 'ok');
});

test('checks: only idle resources, most recent first; only true passes; failures are destroyed', async () => {
  const verdicts = new Map();
  const destroyed = [];
  const {pool, log} = setup({validate: resource => {
    const v = verdicts.get(resource.name);
    if (v === 'throw') throw new Error('broken');
    if (v === 'reject') return Promise.reject(new Error('broken'));
    return v;
  }, destroy: resource => { destroyed.push(resource.name); }});
  const held = [];
  for (let i = 0; i < 5; i++) held.push(track(pool.acquire()));
  await flush();
  assert.ok(!log.some(line => line.includes('check')), 'new resources are not checked');
  for (const box of held) pool.release(box.value);
  verdicts.set('r5', 1).set('r4', 'throw').set('r3', 'reject').set('r2', true).set('r1', true);
  log.length = 0;
  const next = track(pool.acquire());
  assert.deepEqual(log, ['0 check r5']);
  await flush();
  assert.equal(next.value.name, 'r2');
  assert.deepEqual(log, ['0 check r5', '0 check-failed r5', '0 destroy r5 check', '0 check r4', '0 check-failed r4', '0 destroy r4 check',
    '0 check r3', '0 check-failed r3', '0 destroy r3 check', '0 check r2', '0 acquire r2 w6']);
  assert.deepEqual(destroyed, ['r5', 'r4', 'r3']);
  assert.equal(pool.idle, 1);
  assert.equal(pool.size, 2);
});

test('checks: when every idle resource fails, a new one is created and not checked', async () => {
  const {pool, log} = setup({validate: () => Promise.resolve(false), max: 2});
  const a = track(pool.acquire());
  const b = track(pool.acquire());
  await flush();
  pool.release(a.value);
  pool.release(b.value);
  log.length = 0;
  const c = track(pool.acquire());
  await flush();
  assert.equal(c.value.name, 'r3');
  assert.deepEqual(log, ['0 check r2', '0 check-failed r2', '0 destroy r2 check', '0 check r1', '0 check-failed r1', '0 destroy r1 check',
    '0 create r3', '0 ready r3', '0 acquire r3 w3']);
});

test('checks: a checking resource is not reserved; a release while someone waits skips the check', async () => {
  const pending = [];
  const {pool, log} = setup({max: 2, validate: () => new Promise(resolve => pending.push(resolve)), idleTimeout: 100});
  const a = track(pool.acquire());
  const b = track(pool.acquire());
  await flush();
  pool.release(a.value);
  log.length = 0;
  const w3 = track(pool.acquire());
  assert.equal(pool.pending, 1);
  assert.equal(pool.idle, 0);
  pool.release(b.value);
  await flush();
  assert.equal(w3.value, b.value);
  pending[0](true);
  await flush();
  assert.deepEqual(log, ['0 check r1', '0 release r2', '0 acquire r2 w3']);
  assert.equal(pool.idle, 1);
  assert.equal(pending.length, 1);
  const w4 = track(pool.acquire());
  assert.equal(pending.length, 2);
  pending[1](true);
  await flush();
  assert.equal(w4.value, a.value);
});

test('acquire: step order, waiter numbers and rejections without events', async () => {
  const {clock, pool, log} = setup({max: 1, acquireTimeout: 30});
  const errors = [];
  const reject = async promise => { try { await promise; errors.push('fulfilled'); } catch (error) { errors.push(error.constructor.name + ': ' + message(error)); } };
  const held = track(pool.acquire());
  await flush();
  const aborted = AbortSignal.abort(new Error('gave up'));
  await reject(pool.acquire({timeout: 0}));
  await reject(pool.acquire({timeout: 2.5, signal: aborted}));
  await reject(pool.acquire({signal: aborted}));
  await reject(pool.acquire({timeout: '10'}));
  assert.deepEqual(errors, ['RangeError: timeout must be an integer >= 1', 'RangeError: timeout must be an integer >= 1',
    'Error: gave up', 'RangeError: timeout must be an integer >= 1']);
  assert.equal(pool.waiting, 0);
  const late = track(pool.acquire({timeout: undefined}));
  const short = track(pool.acquire({timeout: 5}));
  await clock.advance(5);
  assert.equal(short.state, 'rejected');
  assert.ok(short.value instanceof TimeoutError);
  assert.equal(short.value.name, 'TimeoutError');
  assert.equal(short.value.message, 'Timed out after 5 ms waiting for a resource');
  await clock.advance(25);
  assert.equal(late.value.message, 'Timed out after 30 ms waiting for a resource');
  assert.deepEqual(log, ['0 create r1', '0 ready r1', '0 acquire r1 w1', '5 timeout w7', '30 timeout w6']);
  assert.ok(held.value);
});

test('acquire: a draining or closed pool rejects before the timeout is validated', async () => {
  const {pool} = setup();
  const held = track(pool.acquire());
  await flush();
  const drained = track(pool.drain());
  const during = track(pool.acquire({timeout: -1}));
  await flush();
  assert.equal(during.value.message, 'Pool is draining');
  assert.equal(drained.state, 'pending');
  pool.release(held.value);
  await flush();
  assert.equal(drained.state, 'fulfilled');
  assert.equal(drained.value, undefined);
  const after = track(pool.acquire({timeout: -1, signal: AbortSignal.abort()}));
  await flush();
  assert.equal(after.value.constructor, Error);
  assert.equal(after.value.message, 'Pool is closed');
});

test('timeouts: callbacks are cleared when a waiter is served, aborted or rejected; pending creations go idle', async () => {
  const {clock, pool, log, creations} = setup({acquireTimeout: 50, max: 2}, {manual: true});
  const w1 = track(pool.acquire());
  const w2 = track(pool.acquire());
  const w3 = track(pool.acquire());
  assert.equal(clock.pending(), 3);
  creations[0].resolve();
  await flush();
  assert.equal(w1.state, 'fulfilled');
  assert.equal(clock.pending(), 2);
  creations[1].reject(new Error('nope'));
  await flush();
  assert.equal(w2.value.message, 'nope');
  assert.equal(clock.pending(), 1);
  await clock.advance(50);
  assert.equal(w3.value.message, 'Timed out after 50 ms waiting for a resource');
  creations[2].resolve();
  await flush();
  assert.equal(pool.idle, 1);
  assert.equal(pool.size, 2);
  assert.deepEqual(log, ['0 create r1', '0 create r2', '0 ready r1', '0 acquire r1 w1', '0 create-error r2 nope', '0 create r3',
    '50 timeout w3', '50 ready r3']);
});

test('abort: rejects with the reason; a later abort or timeout of a served waiter does nothing', async () => {
  const {clock, pool, log} = setup({max: 1});
  const held = track(pool.acquire());
  await flush();
  const one = new AbortController();
  const two = new AbortController();
  const w2 = track(pool.acquire({signal: one.signal, timeout: 40}));
  const w3 = track(pool.acquire({signal: two.signal, timeout: 40}));
  const reason = {why: 'user left'};
  one.abort(reason);
  await flush();
  assert.equal(w2.value, reason);
  assert.equal(clock.pending(), 1);
  pool.release(held.value);
  await flush();
  assert.equal(w3.value, held.value);
  two.abort(new Error('too late'));
  await clock.advance(100);
  assert.equal(w3.state, 'fulfilled');
  assert.deepEqual(log, ['0 create r1', '0 ready r1', '0 acquire r1 w1', '0 abort w2', '0 release r1', '0 acquire r1 w3']);
  assert.equal(pool.waiting, 0);
});

test('maxUses: destroyed on the release that reaches the limit; a waiter gets a new resource', async () => {
  const destroyed = [];
  const {pool, log} = setup({max: 1, maxUses: 2, destroy: r => destroyed.push(r.name)});
  const a = track(pool.acquire());
  await flush();
  pool.release(a.value);
  const b = track(pool.acquire());
  const c = track(pool.acquire());
  await flush();
  assert.equal(b.value, a.value);
  pool.release(b.value);
  await flush();
  assert.equal(c.value.name, 'r2');
  assert.deepEqual(destroyed, ['r1']);
  assert.deepEqual(log, ['0 create r1', '0 ready r1', '0 acquire r1 w1', '0 release r1', '0 acquire r1 w2', '0 release r1',
    '0 destroy r1 uses', '0 create r2', '0 ready r2', '0 acquire r2 w3']);
});

test('maxUses counts every lease, including direct hand-overs', async () => {
  const {pool, log} = setup({max: 1, maxUses: 3});
  const a = track(pool.acquire());
  await flush();
  const b = track(pool.acquire());
  pool.release(a.value);
  const c = track(pool.acquire());
  pool.release(a.value);
  await flush();
  assert.equal(b.value, a.value);
  assert.equal(c.value, a.value);
  pool.release(a.value);
  assert.deepEqual(log.slice(-2), ['0 release r1', '0 destroy r1 uses']);
  assert.equal(pool.size, 0);
});

test('release and invalidate reject resources that are not leased', async () => {
  const {pool, log} = setup();
  const a = track(pool.acquire());
  const b = track(pool.acquire());
  await flush();
  pool.release(a.value);
  for (const call of [() => pool.release(a.value), () => pool.invalidate(a.value), () => pool.release({name: 'r1'}), () => pool.invalidate(undefined)]) {
    assert.throws(call, error => error.constructor === Error && error.message === 'Resource is not leased');
  }
  pool.invalidate(b.value);
  assert.throws(() => pool.release(b.value), {message: 'Resource is not leased'});
  assert.deepEqual(log, ['0 create r1', '0 create r2', '0 ready r1', '0 acquire r1 w1', '0 ready r2', '0 acquire r2 w2', '0 release r1', '0 destroy r2 invalid']);
  assert.equal(pool.size, 1);
  assert.equal(pool.idle, 1);
});

test('invalidate makes room for a waiter', async () => {
  const {pool, log} = setup({max: 1});
  const a = track(pool.acquire());
  await flush();
  const b = track(pool.acquire());
  pool.invalidate(a.value);
  await flush();
  assert.equal(b.value.name, 'r2');
  assert.deepEqual(log.slice(3), ['0 destroy r1 invalid', '0 create r2', '0 ready r2', '0 acquire r2 w2']);
});

test('idle timeout keeps minIdle resources, the most recent ones, without a new callback', async () => {
  const {clock, pool, log} = setup({idleTimeout: 100, minIdle: 1});
  const held = [track(pool.acquire()), track(pool.acquire()), track(pool.acquire())];
  await flush();
  pool.release(held[1].value);
  await clock.advance(10);
  pool.release(held[0].value);
  await clock.advance(10);
  pool.release(held[2].value);
  assert.equal(clock.pending(), 3);
  log.length = 0;
  await clock.advance(99);
  assert.deepEqual(log, ['100 destroy r2 idle', '110 destroy r1 idle']);
  await clock.advance(1000);
  assert.equal(clock.pending(), 0);
  assert.equal(pool.idle, 1);
  const again = pool.acquire();
  assert.equal(await again, held[2].value);
  pool.release(held[2].value);
  assert.equal(clock.pending(), 1);
  await clock.advance(100);
  assert.equal(pool.idle, 1);
  assert.equal(log.length, 4);
});

test('idle timeout: leaving the idle list clears the callback; a new idle period starts over', async () => {
  const {clock, pool, log} = setup({idleTimeout: 100});
  const a = track(pool.acquire());
  await flush();
  pool.release(a.value);
  await clock.advance(60);
  const b = track(pool.acquire());
  assert.equal(clock.pending(), 0);
  await clock.advance(60);
  pool.release(b.value);
  await clock.advance(99);
  assert.equal(pool.idle, 1);
  await clock.advance(1);
  assert.equal(pool.idle, 0);
  assert.equal(pool.size, 0);
  assert.deepEqual(log, ['0 create r1', '0 ready r1', '0 acquire r1 w1', '0 release r1', '60 acquire r1 w2', '120 release r1', '220 destroy r1 idle']);
});

test('drain: idle resources go oldest first, queued waiters are still served, then the pool closes', async () => {
  const {pool, log, creations} = setup({max: 3}, {manual: true});
  const boxes = [track(pool.acquire()), track(pool.acquire()), track(pool.acquire())];
  creations.forEach(c => c.resolve());
  await flush();
  const [a, b, c] = boxes.map(box => box.value);
  pool.release(b);
  pool.release(a);
  const w4 = track(pool.acquire());
  const w5 = track(pool.acquire());
  const w6 = track(pool.acquire());
  await flush();
  assert.equal(w4.value, a);
  assert.equal(w5.value, b);
  assert.equal(creations.length, 3);
  log.length = 0;
  const done = track(pool.drain());
  assert.equal(pool.drain(), pool.drain());
  pool.release(a);
  pool.release(c);
  pool.invalidate(b);
  await flush();
  assert.equal(w6.value, a);
  assert.equal(done.state, 'pending');
  pool.release(a);
  await flush();
  assert.equal(done.state, 'fulfilled');
  assert.deepEqual(log, ['0 drain', '0 release r1', '0 acquire r1 w6', '0 release r3', '0 destroy r3 drain', '0 destroy r2 invalid',
    '0 release r1', '0 destroy r1 drain', '0 closed']);
});

test('drain: idle resources are destroyed oldest first and an empty pool closes at once', async () => {
  const {clock, pool, log} = setup({idleTimeout: 1000});
  const boxes = [track(pool.acquire()), track(pool.acquire()), track(pool.acquire())];
  await flush();
  pool.release(boxes[2].value);
  pool.release(boxes[0].value);
  pool.release(boxes[1].value);
  log.length = 0;
  const done = pool.drain();
  assert.deepEqual(log, ['0 drain', '0 destroy r3 drain', '0 destroy r1 drain', '0 destroy r2 drain', '0 closed']);
  assert.equal(clock.pending(), 0);
  assert.equal(await done, undefined);
});

test('drain: queued waiters still get new resources; a creation finishing for nobody is destroyed', async () => {
  const {clock, pool, log, creations} = setup({max: 2}, {manual: true});
  const w1 = track(pool.acquire());
  const w2 = track(pool.acquire({timeout: 5}));
  const done = track(pool.drain());
  creations[0].resolve();
  await flush();
  assert.equal(w1.state, 'fulfilled');
  await clock.advance(5);
  assert.equal(w2.state, 'rejected');
  creations[1].resolve();
  await flush();
  assert.equal(done.state, 'pending');
  pool.release(w1.value);
  await flush();
  assert.equal(done.state, 'fulfilled');
  assert.deepEqual(log, ['0 create r1', '0 create r2', '0 drain', '0 ready r1', '0 acquire r1 w1', '5 timeout w2', '5 ready r2',
    '5 destroy r2 drain', '5 release r1', '5 destroy r1 drain', '5 closed']);
});

test('drain: the last waiter giving up closes the pool', async () => {
  const {clock, pool, log, creations} = setup({max: 1}, {manual: true});
  const w1 = track(pool.acquire({timeout: 20}));
  const done = track(pool.drain());
  creations[0].reject(new Error('offline'));
  await flush();
  assert.equal(w1.value.message, 'offline');
  assert.equal(done.state, 'fulfilled');
  assert.deepEqual(log, ['0 create r1', '0 drain', '0 create-error r1 offline', '0 closed']);
  await clock.advance(20);
  assert.equal(log.length, 4);
});

test('destroy errors are ignored and never unhandled', async () => {
  let mode = 0;
  const {clock, pool} = setup({max: 3, destroy: () => {
    mode++;
    if (mode === 1) throw new Error('sync destroy failure');
    if (mode === 2) return Promise.reject(new Error('async destroy failure'));
    return 'ignored';
  }});
  const boxes = [track(pool.acquire()), track(pool.acquire()), track(pool.acquire())];
  await flush();
  pool.invalidate(boxes[0].value);
  pool.invalidate(boxes[1].value);
  pool.invalidate(boxes[2].value);
  await clock.advance(10);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(mode, 3);
  assert.deepEqual(unhandled.map(message), []);
});

test('listeners get events in subscription order', async () => {
  const {pool} = setup();
  const seen = [];
  pool.on(event => seen.push('a:' + event.type));
  pool.on(event => seen.push('b:' + event.type));
  track(pool.acquire());
  assert.deepEqual(seen, ['a:create', 'b:create']);
});

test('performance: ${PERF_WAITERS} waiters, all but 10 aborted in arbitrary order', async () => {
  const pool = createPool({clock: fakeClock(), create: () => ({}), max: 1});
  const first = await pool.acquire();
  const controllers = [];
  const boxes = [];
  for (let i = 0; i < ${PERF_WAITERS}; i++) {
    const controller = new AbortController();
    controllers.push(controller);
    boxes.push(track(pool.acquire({signal: controller.signal})));
  }
  let seed = 7;
  const order = controllers.map((_, i) => i).filter(i => i % ${PERF_WAITERS / 10} !== ${PERF_WAITERS / 20});
  for (let i = order.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const started = performance.now();
  // Give up as soon as the budget is spent, so a quadratic queue cannot stall the run.
  for (let n = 0; n < order.length; n++) {
    controllers[order[n]].abort(order[n]);
    if (n % 100 === 0 && performance.now() - started > ${PERF_BUDGET_MS}) assert.fail('aborted only ' + n + ' waiters within ${PERF_BUDGET_MS} ms');
  }
  assert.equal(pool.waiting, 10);
  let held = first;
  for (let k = 0; k < 10; k++) {
    pool.release(held);
    await flush();
    const box = boxes[k * ${PERF_WAITERS / 10} + ${PERF_WAITERS / 20}];
    assert.equal(box.state, 'fulfilled');
    held = box.value;
  }
  const elapsed = performance.now() - started;
  assert.equal(pool.waiting, 0);
  assert.ok(elapsed < ${PERF_BUDGET_MS}, 'took ' + Math.round(elapsed) + ' ms');
});
`.replace('@FAKE_CLOCK@', FAKE_CLOCK.replace('export function', 'function'));

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

// Variants of the reference for mustReject; built eagerly so a stale pattern fails at import.
function variant(...edits) {
  let source = REFERENCE;
  for (const [from, to] of edits) {
    if (!source.includes(from)) throw Error('fair-lease-pool: variant pattern not found: ' + from);
    source = source.replace(from, to);
  }
  return root => writeTree(root, {'src/pool.js': source});
}

export default {
  id: 'fair-lease-pool',
  category: 'async ordering with a fake clock',
  prompt: 'src/pool.js implements only part of the resource pool specified in docs/POOL.md. Make it implement that specification completely and exactly. ' +
    'Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Resource pool: first cut', files]]),
  solve: root => writeTree(root, {'src/pool.js': REFERENCE}),
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
    // Idle resources handed out first in, first out.
    variant(['        const record = idle.tail;', '        const record = idle.head;']),
    // A pending creation is reserved for the waiter that caused it: a failed creation rejects the newest waiter.
    variant(['      const waiter = waiters.head;\n      if (waiter) {', '      const waiter = waiters.tail;\n      if (waiter) {']),
    // Any truthy validate result passes the check.
    variant(['done(value === true)', 'done(Boolean(value))']),
    // Resources released while someone waits are checked too.
    variant(['    if (waiters.length) lease(record);\n    else if', "    if (waiters.length && validate && record.state === 'returned') { record.state = 'idle'; idle.push(record); }\n    else if (waiters.length) lease(record);\n    else if"]),
    // The minIdle survivor keeps a recurring idle callback.
    variant(['    if (idle.length > minIdle) remove(record, \'idle\');', "    if (idle.length > minIdle) remove(record, 'idle');\n    else record.timer = clock.setTimeout(() => expire(record), idleTimeout);"]),
    // A synchronous create() throw is handled inside the call.
    variant(['    attempt(() => create()).then(', '    let made;\n    try { made = Promise.resolve(create()); } catch (error) { made = {then: (ok, fail) => fail(error)}; }\n    made.then(']),
    // Destroy rejections are left unhandled.
    variant(['    if (destroy) attempt(() => destroy(record.resource)).catch(() => {});', '    if (destroy) attempt(() => destroy(record.resource));']),
    // Waiter queue as an array: removal is indexOf + splice.
    variant(['  const waiters = new List();', '  const waiters = {items: [], get head() { return this.items[0]; }, get length() { return this.items.length; },\n' +
      '    push(node) { this.items.push(node); }, remove(node) { this.items.splice(this.items.indexOf(node), 1); }};']),
    // A visible test edited.
    root => writeTree(root, {'test/pool.test.js': VISIBLE.replace("test('acquire times out'", "test.skip('acquire times out'")}),
  ],
};
