import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture and hidden-test sources are String.raw templates: they never contain a backtick or "${".
const js = String.raw;

const SPEC = `# Job scheduler

\`createScheduler(options)\` in \`src/scheduler.js\` runs asynchronous jobs with priorities, a concurrency limit, retries with exponential backoff, per-attempt timeouts, cancellation and de-duplication by key, and reports what it does as a stream of events. It never uses the global timer functions or \`Date\`: all time comes from the injected clock.

## Clock

\`options.clock\` is an object with three functions:

- \`now()\` returns the current time in milliseconds.
- \`setTimeout(callback, ms)\` arranges for \`callback()\` to be called once, \`ms\` milliseconds from now, and returns a handle.
- \`clearTimeout(handle)\` cancels a callback that has not run yet.

The tests use \`test/fake-clock.js\`: time moves only when a test calls \`advance(ms)\`. Callbacks that are due at the same time run in the order they were registered, and all pending promise reactions run before the next callback.

## Options

\`createScheduler({clock, concurrency = 1, attempts = 1, backoff = {}})\`

- \`concurrency\`: the most attempts that may be running at the same time.
- \`attempts\`: the default for the most attempts a job gets (the first attempt included).
- \`backoff\`: \`{initial = 100, factor = 2, max = 10000}\`, the delays between attempts (see Failures and retries).

An option that is \`undefined\` takes its default.

## Jobs

\`schedule(name, run, {priority = 0, attempts, timeout, key} = {})\` adds a job and returns its handle (De-duplication describes the one exception).

- \`name\` identifies the job in error messages.
- \`run\` does the work. It is called once per attempt as \`run({attempt, signal})\`, where \`attempt\` is the attempt number (1 for the first attempt) and \`signal\` is an \`AbortSignal\` that belongs to this attempt only.
- \`priority\`: jobs with a higher priority start first.
- \`attempts\`: the most attempts for this job; defaults to the scheduler's \`attempts\`.
- \`timeout\`: when given, the longest an attempt may run, in milliseconds.
- \`key\`: see De-duplication.

Each new job gets an \`id\`: 1 for the first job a scheduler creates, then 2, 3 and so on.

A handle is an object with these properties:

- \`id\`, \`name\`: as above.
- \`promise\`: settles once, when the job ends. It fulfils with the value of the successful attempt, or rejects with the reason of the last failed attempt, or with a \`CancelError\`. A rejection of \`promise\` must never be reported as an unhandled rejection, even when nobody ever handles it.
- \`state\` (a getter): the job's current state, one of \`'waiting'\`, \`'running'\`, \`'delayed'\`, \`'succeeded'\`, \`'failed'\` or \`'cancelled'\`. The last three are final: a job in a final state has *ended*; a job in one of the other states is *unfinished*.
- \`priority\` (a getter): the job's current priority.
- \`cancel()\`: see Cancellation.

## Order and concurrency

A job is *waiting* while it is ready to start an attempt. Whenever fewer than \`concurrency\` attempts are running and at least one job is waiting, the scheduler starts an attempt of the best waiting job, and repeats until the limit is reached or no job waits. This happens immediately, synchronously inside the call or callback that made it possible (\`schedule\`, \`setConcurrency\`, \`cancel\`, a clock callback or the settlement of an attempt), never later. In the step lists below this is called *start waiting jobs*.

The best waiting job is the one with the highest priority; among equal priorities, the one with the smallest \`id\`. This rule applies every time, also to a job that waits again after a failed attempt: a retried job goes ahead of every waiting job with the same priority and a larger \`id\`, however long those have been waiting.

\`setConcurrency(n)\` changes the limit (validated like the option) and then starts waiting jobs. A higher limit therefore starts waiting jobs at once; a lower limit never stops a running attempt, it only keeps new attempts from starting until fewer than \`n\` attempts run.

Only running attempts count against the limit. An attempt that timed out or whose job was cancelled stops running at that moment, even if the promise returned by its \`run\` has not settled.

## Attempts

Starting an attempt of a job takes these steps, in this order:

1. The job's state becomes \`'running'\` and the attempt gets the next attempt number.
2. Emit \`start\`.
3. If the job has a \`timeout\`, register a clock callback \`timeout\` milliseconds from now. When it runs while the attempt is still running, the attempt fails with a \`TimeoutError\`.
4. Call \`run({attempt, signal})\`.

The outcome of \`run\` is always observed asynchronously: a returned value or promise is treated like \`Promise.resolve(value)\`, and a synchronous throw like a returned rejected promise. Nothing that \`run\` does makes \`schedule\` (or any other method) throw, and no event about the outcome is emitted before the call that started the attempt has returned.

When the outcome arrives while the attempt is still running, it ends the attempt: a fulfilment is a success, a rejection a failure. When the attempt is no longer running (it timed out, or its job was cancelled), the outcome is ignored entirely: no event, no effect on the job.

A success takes these steps, in this order:

1. The attempt's timeout callback, if any, is cleared, and the attempt stops running.
2. The job's state becomes \`'succeeded'\`; emit \`success\`.
3. \`promise\` fulfils with the value.
4. Start waiting jobs, then check for idleness (see Idle).

## Failures and retries

An attempt fails when its \`run\` rejects (or throws), or when its timeout callback runs first. A failure with reason \`error\` takes these steps, in this order:

1. The attempt's timeout callback, if any, is cleared, and the attempt stops running. For a timeout, the attempt's signal is aborted with the \`TimeoutError\` as its reason.
2. Emit \`failure\`.
3. If the job has attempts left and \`error\` is retryable, the job waits for a retry: its state becomes \`'delayed'\`, emit \`retry\`, and register a clock callback \`delay\` milliseconds from now (also when \`delay\` is 0). When that callback runs, the job's state becomes \`'waiting'\` and the scheduler starts waiting jobs.
   Otherwise the job's state becomes \`'failed'\`, emit \`failed\`, and \`promise\` rejects with \`error\`.
4. Start waiting jobs, then check for idleness.

An error is retryable unless it is an object (or a function) whose \`retryable\` property is \`false\`. A \`TimeoutError\` is retryable.

The delay before attempt \`n + 1\` (after attempt \`n\` failed) is \`initial × factor^(n − 1)\` rounded down to an integer, but at most \`max\`. With the defaults: 100, 200, 400, 800 and so on, up to 10000.

\`TimeoutError\` (exported) is an \`Error\` subclass whose \`name\` is \`'TimeoutError'\`; its message is \`Job <name> timed out after <timeout> ms\`.

## Cancellation

\`cancel()\` on a handle whose job has ended returns \`false\` and does nothing else. Otherwise it takes these steps, in this order, and returns \`true\`:

1. If the job is running, its attempt ends: the timeout callback, if any, is cleared, the attempt stops running, and its signal is aborted with the \`CancelError\` as its reason. If the job is delayed, its retry callback is cleared. If it is waiting, it stops waiting.
2. The job's state becomes \`'cancelled'\`; emit \`cancel\`.
3. \`promise\` rejects with the \`CancelError\`.
4. Start waiting jobs, then check for idleness.

\`CancelError\` (exported) is an \`Error\` subclass whose \`name\` is \`'CancelError'\`; its message is \`Job <name> was cancelled\`. A cancellation creates one instance, used both as the signal's reason and as the rejection reason.

## De-duplication

When \`schedule\` is given a \`key\` and an unfinished job that was created with the same key exists, no job is created: the call returns that job's handle (the same object) and ignores its own \`name\`, \`run\`, \`attempts\` and \`timeout\`. No \`id\` is used up. If the call's \`priority\` is higher than the job's current priority, the job's priority is raised to it (when the job waits, now or later, it is ordered by its new priority); a lower or equal priority changes nothing. Then emit \`merge\`. Once a job has ended, its key is free again: the next \`schedule\` with that key creates a new job.

## Events

\`on(listener)\` subscribes \`listener\` and returns a function that unsubscribes it. Every event is passed synchronously to every listener subscribed at that moment, in subscription order. An event is a plain object with exactly the properties listed here; \`at\` is always \`clock.now()\` at emission and \`id\` is the job's id.

- \`{type: 'queued', id, at}\`: \`schedule\` created a job (emitted before the job can start).
- \`{type: 'merge', id, at}\`: \`schedule\` returned an existing job (see De-duplication).
- \`{type: 'start', id, attempt, at}\`
- \`{type: 'success', id, attempt, at}\`
- \`{type: 'failure', id, attempt, error, at}\`: \`error\` is the reason itself (the same value).
- \`{type: 'retry', id, attempt, delay, at}\`: \`attempt\` is the number of the attempt that will follow.
- \`{type: 'failed', id, attempt, at}\`: \`attempt\` is the number of the last attempt.
- \`{type: 'cancel', id, at}\`
- \`{type: 'idle', at}\`

## Idle

The scheduler is *idle* when no job is unfinished. Each time a job ends and this leaves the scheduler idle, \`idle\` is emitted, as the last event of that step list.

\`drain()\` returns a promise that fulfils with \`undefined\` the next time the scheduler becomes idle, or an already fulfilled one when the scheduler is idle now.

## Validation

\`createScheduler\` and \`schedule\` validate their arguments before doing anything else and throw a \`TypeError\` for the first problem, in this order, with exactly these messages ("integer" means \`Number.isInteger\`):

\`createScheduler\`:

1. \`clock\` must be an object whose \`now\`, \`setTimeout\` and \`clearTimeout\` are functions: \`clock must have now, setTimeout and clearTimeout functions\` (also when \`options\` is missing).
2. \`concurrency\` must be an integer ≥ 1: \`concurrency must be an integer >= 1\`.
3. \`attempts\` must be an integer ≥ 1: \`attempts must be an integer >= 1\`.
4. \`backoff.initial\` must be an integer ≥ 0: \`backoff.initial must be an integer >= 0\`.
5. \`backoff.factor\` must be a finite number ≥ 1: \`backoff.factor must be a finite number >= 1\`.
6. \`backoff.max\` must be an integer ≥ \`backoff.initial\`: \`backoff.max must be an integer >= backoff.initial\`.

\`schedule\` (also when the call would merge into an existing job):

1. \`name\` must be a non-empty string: \`name must be a non-empty string\`.
2. \`run\` must be a function: \`run must be a function\`.
3. \`priority\` must be an integer: \`priority must be an integer\`.
4. \`attempts\` must be an integer ≥ 1: \`attempts must be an integer >= 1\`.
5. \`timeout\` must be an integer ≥ 1: \`timeout must be an integer >= 1\`.
6. \`key\` must be a string: \`key must be a string\`.

\`setConcurrency(n)\` throws \`concurrency must be an integer >= 1\` for a bad \`n\` and then changes nothing. A call that throws has no effect at all.

## Performance

The scheduler must stay fast with many jobs: scheduling 100,000 jobs with assorted priorities, cancelling some of them and running the rest to completion (with \`run\` returning a value immediately) must take well under a second. Adding, starting and cancelling a job may take at most time logarithmic in the number of waiting jobs.
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

const NAIVE = js`/** Job scheduler; see docs/SCHEDULER.md. First cut: runs jobs in the order they were scheduled, one attempt each. */
export function createScheduler({clock, concurrency = 1} = {}) {
  if (!clock) throw new TypeError('clock must have now, setTimeout and clearTimeout functions');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be an integer >= 1');
  const queue = [];
  const listeners = [];
  let running = 0;
  let lastId = 0;
  let drains = [];
  const emit = event => { for (const listener of listeners) listener({...event, at: clock.now()}); };

  function next() {
    while (running < concurrency && queue.length) {
      const job = queue.shift();
      running++;
      job.state = 'running';
      emit({type: 'start', id: job.id, attempt: 1});
      Promise.resolve().then(() => job.run({attempt: 1})).then(value => {
        running--;
        job.state = 'succeeded';
        emit({type: 'success', id: job.id, attempt: 1});
        job.resolve(value);
        done();
      }, error => {
        running--;
        job.state = 'failed';
        emit({type: 'failure', id: job.id, attempt: 1, error});
        emit({type: 'failed', id: job.id, attempt: 1});
        job.reject(error);
        done();
      });
    }
  }

  function done() {
    next();
    if (running === 0 && queue.length === 0) {
      emit({type: 'idle'});
      for (const resolve of drains.splice(0)) resolve();
    }
  }

  return {
    schedule(name, run, {priority = 0} = {}) {
      const job = {id: ++lastId, name, run, priority, state: 'waiting'};
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      queue.push(job);
      emit({type: 'queued', id: job.id});
      next();
      return {id: job.id, name, promise: job.promise, get state() { return job.state; }, get priority() { return job.priority; }};
    },
    on(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    drain: () => running === 0 && queue.length === 0 ? Promise.resolve() : new Promise(resolve => drains.push(resolve)),
  };
}
`;

const VISIBLE = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {createScheduler} from '../src/scheduler.js';
import {fakeClock} from './fake-clock.js';

function setup(options) {
  const clock = fakeClock();
  const scheduler = createScheduler({clock, ...options});
  const log = [];
  scheduler.on(event => log.push([event.at, event.type, event.id, event.attempt].filter(part => part !== undefined).join(' ')));
  return {clock, scheduler, log};
}

function manual() {
  const calls = [];
  const run = ({attempt}) => new Promise((resolve, reject) => calls.push({attempt, resolve, reject}));
  return {run, calls};
}

test('jobs run one at a time in scheduling order', async () => {
  const {clock, scheduler, log} = setup();
  const a = scheduler.schedule('a', () => 'A');
  const b = scheduler.schedule('b', () => 'B');
  assert.equal(await a.promise, 'A');
  assert.equal(await b.promise, 'B');
  await clock.flush();
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 queued 2', '0 success 1 1', '0 start 2 1', '0 success 2 1', '0 idle']);
});

test('a higher priority starts first', async () => {
  const {clock, scheduler, log} = setup();
  const first = manual();
  scheduler.schedule('first', first.run);
  scheduler.schedule('low', () => 1);
  scheduler.schedule('high', () => 2, {priority: 3});
  first.calls[0].resolve();
  await clock.flush();
  assert.deepEqual(log.filter(line => line.includes('start')), ['0 start 1 1', '0 start 3 1', '0 start 2 1']);
});

test('concurrency limits the running attempts', async () => {
  const {scheduler} = setup({concurrency: 2});
  const jobs = ['a', 'b', 'c'].map(name => scheduler.schedule(name, manual().run));
  assert.deepEqual(jobs.map(job => job.state), ['running', 'running', 'waiting']);
});

test('a failed attempt is retried after the backoff delay', async () => {
  const {clock, scheduler, log} = setup({attempts: 2, backoff: {initial: 50}});
  const work = manual();
  const job = scheduler.schedule('flaky', work.run);
  work.calls[0].reject(new Error('busy'));
  await clock.advance(50);
  work.calls[1].resolve('ok');
  assert.equal(await job.promise, 'ok');
  await clock.flush();
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 failure 1 1', '0 retry 1 2', '50 start 1 2', '50 success 1 2', '50 idle']);
});

test('invalid concurrency', () => {
  assert.throws(() => createScheduler({clock: fakeClock(), concurrency: 0}), {name: 'TypeError', message: 'concurrency must be an integer >= 1'});
});

test('drain waits until every job has ended', async () => {
  const {scheduler} = setup({concurrency: 3});
  const order = [];
  for (const name of ['a', 'b', 'c']) scheduler.schedule(name, async () => { order.push(name); });
  await scheduler.drain();
  assert.deepEqual(order, ['a', 'b', 'c']);
});
`;

const PACKAGE = {name: 'job-runner', version: '1.0.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}};
const files = {
  'package.json': JSON.stringify(PACKAGE, null, 2) + '\n',
  'docs/SCHEDULER.md': SPEC,
  'src/scheduler.js': NAIVE,
  'test/fake-clock.js': FAKE_CLOCK,
  'test/scheduler.test.js': VISIBLE,
};

const REFERENCE = js`/** Job scheduler with priorities, a concurrency limit, retries, timeouts, cancellation and keys; see docs/SCHEDULER.md. */
export class TimeoutError extends Error {
  constructor(name, timeout) {
    super('Job ' + name + ' timed out after ' + timeout + ' ms');
    this.name = 'TimeoutError';
  }
}

export class CancelError extends Error {
  constructor(name) {
    super('Job ' + name + ' was cancelled');
    this.name = 'CancelError';
  }
}

const isInteger = (value, min = -Infinity) => Number.isInteger(value) && value >= min;
function check(ok, message) { if (!ok) throw new TypeError(message); }
const CONCURRENCY = 'concurrency must be an integer >= 1';
const ATTEMPTS = 'attempts must be an integer >= 1';
const ENDED = new Set(['succeeded', 'failed', 'cancelled']);

// Binary heap of queue entries, best on top. An entry is live while its job still points at it, so cancelling
// or re-prioritising a waiting job just abandons the old entry.
const better = (a, b) => a.priority > b.priority || (a.priority === b.priority && a.order < b.order);
function heapPush(heap, entry) {
  heap.push(entry);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!better(heap[i], heap[parent])) break;
    [heap[i], heap[parent]] = [heap[parent], heap[i]];
    i = parent;
  }
}
function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1, right = left + 1;
      let best = i;
      if (left < heap.length && better(heap[left], heap[best])) best = left;
      if (right < heap.length && better(heap[right], heap[best])) best = right;
      if (best === i) break;
      [heap[i], heap[best]] = [heap[best], heap[i]];
      i = best;
    }
  }
  return top;
}

export function createScheduler(options) {
  const {clock, concurrency = 1, attempts: defaultAttempts = 1, backoff = {}} = options ?? {};
  check(clock !== null && typeof clock === 'object' && ['now', 'setTimeout', 'clearTimeout'].every(name => typeof clock[name] === 'function'),
    'clock must have now, setTimeout and clearTimeout functions');
  check(isInteger(concurrency, 1), CONCURRENCY);
  check(isInteger(defaultAttempts, 1), ATTEMPTS);
  const {initial = 100, factor = 2, max = 10000} = backoff;
  check(isInteger(initial, 0), 'backoff.initial must be an integer >= 0');
  check(typeof factor === 'number' && Number.isFinite(factor) && factor >= 1, 'backoff.factor must be a finite number >= 1');
  check(isInteger(max, initial), 'backoff.max must be an integer >= backoff.initial');

  let limit = concurrency;
  let running = 0;
  let unfinished = 0;
  let lastId = 0;
  let drains = [];
  const heap = [];
  const keys = new Map();
  const listeners = [];

  function emit(event) {
    event.at = clock.now();
    for (const listener of [...listeners]) listener(event);
  }

  function enqueue(job) {
    job.state = 'waiting';
    job.entry = {job, priority: job.priority, order: job.id};
    heapPush(heap, job.entry);
  }

  function startWaiting() {
    while (running < limit && heap.length) {
      const entry = heapPop(heap);
      if (entry.job.entry === entry) start(entry.job);
    }
  }

  function startWaitingThenCheckIdle() {
    startWaiting();
    if (unfinished > 0) return;
    emit({type: 'idle'});
    const waiting = drains;
    drains = [];
    for (const resolve of waiting) resolve();
  }

  function end(job, state) {
    job.state = state;
    unfinished--;
    if (keys.get(job.key) === job) keys.delete(job.key);
  }

  function start(job) {
    job.entry = null;
    job.state = 'running';
    running++;
    const attempt = ++job.attempt;
    const controller = new AbortController();
    const current = job.current = {controller, timer: undefined};
    emit({type: 'start', id: job.id, attempt});
    if (job.timeout !== undefined) {
      current.timer = clock.setTimeout(() => {
        if (job.current === current) fail(job, new TimeoutError(job.name, job.timeout), true);
      }, job.timeout);
    }
    let outcome;
    try {
      outcome = Promise.resolve(job.run({attempt, signal: controller.signal}));
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome.then(value => { if (job.current === current) succeed(job, value); },
      error => { if (job.current === current) fail(job, error, false); });
  }

  /** The running attempt of job stops running; returns its AbortController. */
  function stop(job) {
    const {controller, timer} = job.current;
    if (timer !== undefined) clock.clearTimeout(timer);
    job.current = null;
    running--;
    return controller;
  }

  function succeed(job, value) {
    stop(job);
    end(job, 'succeeded');
    emit({type: 'success', id: job.id, attempt: job.attempt});
    job.resolve(value);
    startWaitingThenCheckIdle();
  }

  function fail(job, error, timedOut) {
    const controller = stop(job);
    if (timedOut) controller.abort(error);
    const attempt = job.attempt;
    emit({type: 'failure', id: job.id, attempt, error});
    const retryable = !((typeof error === 'object' || typeof error === 'function') && error !== null && error.retryable === false);
    if (attempt < job.attempts && retryable) {
      job.state = 'delayed';
      const delay = Math.min(max, Math.floor(initial * factor ** (attempt - 1)));
      emit({type: 'retry', id: job.id, attempt: attempt + 1, delay});
      job.timer = clock.setTimeout(() => {
        job.timer = undefined;
        enqueue(job);
        startWaiting();
      }, delay);
    } else {
      end(job, 'failed');
      emit({type: 'failed', id: job.id, attempt});
      job.reject(error);
    }
    startWaitingThenCheckIdle();
  }

  function cancel(job) {
    if (ENDED.has(job.state)) return false;
    const error = new CancelError(job.name);
    if (job.state === 'running') stop(job).abort(error);
    else if (job.state === 'delayed') clock.clearTimeout(job.timer);
    else job.entry = null;
    end(job, 'cancelled');
    emit({type: 'cancel', id: job.id});
    job.reject(error);
    startWaitingThenCheckIdle();
    return true;
  }

  function schedule(name, run, options = {}) {
    const {priority = 0, attempts = defaultAttempts, timeout, key} = options;
    check(typeof name === 'string' && name !== '', 'name must be a non-empty string');
    check(typeof run === 'function', 'run must be a function');
    check(isInteger(priority), 'priority must be an integer');
    check(isInteger(attempts, 1), ATTEMPTS);
    check(timeout === undefined || isInteger(timeout, 1), 'timeout must be an integer >= 1');
    check(key === undefined || typeof key === 'string', 'key must be a string');

    const existing = key === undefined ? undefined : keys.get(key);
    if (existing) {
      if (priority > existing.priority) {
        existing.priority = priority;
        if (existing.state === 'waiting') {
          existing.entry = {job: existing, priority, order: existing.id};
          heapPush(heap, existing.entry);
        }
      }
      emit({type: 'merge', id: existing.id});
      return existing.handle;
    }

    const job = {id: ++lastId, name, run, priority, attempts, timeout, key, state: 'waiting', attempt: 0,
      entry: null, current: null, timer: undefined};
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.promise.catch(() => {});
    job.handle = {
      id: job.id,
      name,
      promise: job.promise,
      get state() { return job.state; },
      get priority() { return job.priority; },
      cancel: () => cancel(job),
    };
    unfinished++;
    if (key !== undefined) keys.set(key, job);
    emit({type: 'queued', id: job.id});
    enqueue(job);
    startWaiting();
    return job.handle;
  }

  return {
    schedule,
    on(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    drain: () => unfinished === 0 ? Promise.resolve() : new Promise(resolve => drains.push(resolve)),
    setConcurrency(n) {
      check(isInteger(n, 1), CONCURRENCY);
      limit = n;
      startWaiting();
    },
  };
}
`;

const PERF_BUDGET_MS = 2500;

const HIDDEN = js`import test from 'node:test';
import assert from 'node:assert/strict';
const {createScheduler, TimeoutError, CancelError} = await import('@ROOT@src/scheduler.js');

@FAKE_CLOCK@

const flush = () => new Promise(resolve => setImmediate(resolve));
const message = error => error instanceof Error ? error.message : String(error);
const fmt = e => [e.at, e.type, e.id, e.attempt, e.delay, e.error === undefined ? undefined : message(e.error)]
  .filter(part => part !== undefined).join(' ');

function setup(options = {}) {
  const clock = fakeClock();
  const scheduler = createScheduler({clock, ...options});
  const log = [];
  scheduler.on(event => log.push(fmt(event)));
  return {clock, scheduler, log};
}

/** A run function whose attempts the test settles by hand; abort events are logged when a log is given. */
function manual(log) {
  const calls = [];
  const run = ({attempt, signal}) => new Promise((resolve, reject) => {
    if (log) signal.addEventListener('abort', () => log.push('abort ' + attempt));
    calls.push({attempt, signal, resolve, reject});
  });
  return {run, calls, get last() { return calls[calls.length - 1]; }};
}

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail('expected a rejection');
}

test('the best waiting job starts first: highest priority, then smallest id', async () => {
  const {scheduler, log} = setup();
  const jobs = [['a', 0], ['b', 1], ['c', 5], ['d', 1], ['e', 5], ['f', -1]].map(([name, priority]) => {
    const work = manual();
    return {work, handle: scheduler.schedule(name, work.run, {priority})};
  });
  for (let i = 0; i < 6; i++) {
    const job = jobs.find(candidate => candidate.handle.state === 'running');
    job.work.last.resolve(job.handle.name);
    await flush();
  }
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 queued 2', '0 queued 3', '0 queued 4', '0 queued 5', '0 queued 6',
    '0 success 1 1', '0 start 3 1', '0 success 3 1', '0 start 5 1', '0 success 5 1', '0 start 2 1', '0 success 2 1',
    '0 start 4 1', '0 success 4 1', '0 start 6 1', '0 success 6 1', '0 idle']);
  assert.equal(await jobs[2].handle.promise, 'c');
  assert.deepEqual(jobs.map(job => job.handle.priority), [0, 1, 5, 1, 5, -1]);
});

test('a retried job waits again in its place by priority and id', async () => {
  const {clock, scheduler, log} = setup({backoff: {initial: 10}});
  const [one, two, three] = [manual(), manual(), manual()];
  const first = scheduler.schedule('one', one.run, {attempts: 2});
  scheduler.schedule('two', two.run);
  scheduler.schedule('three', three.run);
  one.last.reject(new Error('boom'));
  await flush();
  assert.equal(first.state, 'delayed');
  await clock.advance(10);
  assert.equal(first.state, 'waiting');
  two.last.resolve();
  await flush();
  one.last.resolve('done');
  await flush();
  three.last.resolve();
  await flush();
  assert.equal(await first.promise, 'done');
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 queued 2', '0 queued 3', '0 failure 1 1 boom', '0 retry 1 2 10', '0 start 2 1',
    '10 success 2 1', '10 start 1 2', '10 success 1 2', '10 start 3 1', '10 success 3 1', '10 idle']);
});

test('backoff: factor, rounding down and the cap; a synchronous throw is observed later', async () => {
  const {clock, scheduler, log} = setup({attempts: 6, backoff: {initial: 100, factor: 1.5, max: 400}});
  const job = scheduler.schedule('sync', ({attempt}) => { throw new Error('no ' + attempt); });
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1']);
  await clock.advance(5000);
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 failure 1 1 no 1', '0 retry 1 2 100',
    '100 start 1 2', '100 failure 1 2 no 2', '100 retry 1 3 150',
    '250 start 1 3', '250 failure 1 3 no 3', '250 retry 1 4 225',
    '475 start 1 4', '475 failure 1 4 no 4', '475 retry 1 5 337',
    '812 start 1 5', '812 failure 1 5 no 5', '812 retry 1 6 400',
    '1212 start 1 6', '1212 failure 1 6 no 6', '1212 failed 1 6', '1212 idle']);
  assert.equal(message(await rejection(job.promise)), 'no 6');
  assert.equal(job.state, 'failed');
});

test('default backoff doubles from 100 up to 10000', async () => {
  const {clock, scheduler, log} = setup({attempts: 9});
  scheduler.schedule('always', () => Promise.reject(new Error('x')));
  await clock.advance(100000);
  assert.deepEqual(log.filter(line => line.includes(' retry ')).map(line => Number(line.split(' ')[4])), [100, 200, 400, 800, 1600, 3200, 6400, 10000]);
  assert.equal(log[log.length - 2], '22700 failed 1 9');
});

test('a zero delay still goes through the clock', async () => {
  const {clock, scheduler, log} = setup({backoff: {initial: 0}});
  const work = manual();
  const job = scheduler.schedule('zero', work.run, {attempts: 2});
  work.last.reject(new Error('first'));
  await flush();
  assert.equal(job.state, 'delayed');
  assert.equal(clock.pending(), 1);
  assert.equal(work.calls.length, 1);
  await clock.advance(0);
  assert.equal(job.state, 'running');
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 failure 1 1 first', '0 retry 1 2 0', '0 start 1 2']);
});

test('a timeout frees the slot at once and the late outcome is ignored', async () => {
  const {clock, scheduler, log} = setup();
  const slow = manual(log);
  const next = manual();
  const job = scheduler.schedule('slow', slow.run, {timeout: 50});
  const other = scheduler.schedule('next', next.run);
  await clock.advance(49);
  assert.equal(job.state, 'running');
  await clock.advance(1);
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 queued 2', 'abort 1', '50 failure 1 1 Job slow timed out after 50 ms', '50 failed 1 1', '50 start 2 1']);
  const error = await rejection(job.promise);
  assert.ok(error instanceof TimeoutError && error instanceof Error);
  assert.equal(error.name, 'TimeoutError');
  assert.equal(error.message, 'Job slow timed out after 50 ms');
  assert.equal(slow.last.signal.aborted, true);
  assert.equal(slow.last.signal.reason, error);
  slow.last.resolve('late');
  await flush();
  assert.equal(job.state, 'failed');
  assert.equal(log.length, 7);
  next.last.resolve('n');
  assert.equal(await other.promise, 'n');
  await flush();
  assert.deepEqual(log.slice(7), ['50 success 2 1', '50 idle']);
});

test('the timeout callback is registered before run is called', async () => {
  const {clock, scheduler, log} = setup();
  const job = scheduler.schedule('tie', () => new Promise(resolve => clock.setTimeout(() => resolve('ok'), 30)), {timeout: 30, attempts: 2});
  await clock.advance(1000);
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '30 failure 1 1 Job tie timed out after 30 ms', '30 retry 1 2 100',
    '130 start 1 2', '160 failure 1 2 Job tie timed out after 30 ms', '160 failed 1 2', '160 idle']);
  assert.ok((await rejection(job.promise)) instanceof TimeoutError);
});

test('success clears the timeout; each attempt has its own signal', async () => {
  const {clock, scheduler, log} = setup({backoff: {initial: 5}});
  const work = manual();
  const job = scheduler.schedule('t', work.run, {timeout: 20, attempts: 2});
  await clock.advance(20);
  assert.equal(job.state, 'delayed');
  await clock.advance(5);
  assert.equal(work.calls.length, 2);
  assert.deepEqual(work.calls.map(call => call.attempt), [1, 2]);
  assert.notEqual(work.calls[0].signal, work.calls[1].signal);
  work.calls[1].resolve('second');
  assert.equal(await job.promise, 'second');
  await flush();
  assert.equal(clock.pending(), 0);
  assert.equal(work.calls[0].signal.aborted, true);
  assert.equal(work.calls[1].signal.aborted, false);
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '20 failure 1 1 Job t timed out after 20 ms', '20 retry 1 2 5', '25 start 1 2', '25 success 1 2', '25 idle']);
});

test('which errors are retried', async () => {
  const {clock, scheduler, log} = setup({attempts: 2, backoff: {initial: 1}});
  const fatal = Object.assign(new Error('bad input'), {retryable: false});
  const fatalFunction = Object.assign(() => {}, {retryable: false});
  const reasons = [fatal, 'plain', null, Object.assign(new Error('zero'), {retryable: 0}), fatalFunction];
  const jobs = reasons.map((reason, i) => scheduler.schedule('r' + i, ({attempt}) => attempt === 1 ? Promise.reject(reason) : 'ok'));
  await clock.advance(10);
  assert.deepEqual(jobs.map(job => job.state), ['failed', 'succeeded', 'succeeded', 'succeeded', 'failed']);
  assert.equal(await rejection(jobs[0].promise), fatal);
  assert.equal(await rejection(jobs[4].promise), fatalFunction);
  assert.ok(log.includes('0 failed 1 1'));
  assert.ok(log.includes('0 retry 2 2 1'));
});

test('a plain return value is observed asynchronously', async () => {
  const {scheduler, log} = setup();
  const job = scheduler.schedule('now', () => 42);
  assert.equal(job.state, 'running');
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1']);
  assert.equal(await job.promise, 42);
  await flush();
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 success 1 1', '0 idle']);
});

test('cancelling a waiting job', async () => {
  const {scheduler, log} = setup();
  const [one, two, three] = [manual(), manual(), manual()];
  const first = scheduler.schedule('one', one.run);
  const second = scheduler.schedule('two', two.run);
  scheduler.schedule('three', three.run);
  assert.equal(second.cancel(), true);
  assert.equal(second.state, 'cancelled');
  assert.equal(second.cancel(), false);
  const error = await rejection(second.promise);
  assert.ok(error instanceof CancelError && error instanceof Error);
  assert.equal(error.name, 'CancelError');
  assert.equal(error.message, 'Job two was cancelled');
  one.last.resolve();
  await flush();
  three.last.resolve();
  await flush();
  assert.equal(first.cancel(), false);
  assert.equal(two.calls.length, 0);
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 queued 2', '0 queued 3', '0 cancel 2', '0 success 1 1', '0 start 3 1', '0 success 3 1', '0 idle']);
});

test('cancelling a running job aborts it and starts the next job synchronously', async () => {
  const {clock, scheduler, log} = setup();
  const one = manual(log);
  const first = scheduler.schedule('one', one.run, {timeout: 50});
  scheduler.schedule('two', manual().run);
  await clock.advance(10);
  assert.equal(first.cancel(), true);
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 queued 2', 'abort 1', '10 cancel 1', '10 start 2 1']);
  const error = await rejection(first.promise);
  assert.equal(one.last.signal.reason, error);
  assert.equal(error.message, 'Job one was cancelled');
  assert.equal(clock.pending(), 0);
  one.last.resolve('late');
  await clock.advance(100);
  assert.equal(log.length, 6);
  assert.equal(first.state, 'cancelled');
});

test('cancelling a delayed job clears its retry', async () => {
  const {clock, scheduler, log} = setup({attempts: 3});
  const work = manual();
  const job = scheduler.schedule('d', work.run);
  const drained = scheduler.drain();
  work.last.reject(new Error('e'));
  await flush();
  assert.equal(clock.pending(), 1);
  assert.equal(job.cancel(), true);
  assert.equal(clock.pending(), 0);
  await drained;
  await clock.advance(1000);
  assert.equal(work.calls.length, 1);
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 failure 1 1 e', '0 retry 1 2 100', '0 cancel 1', '0 idle']);
});

test('a key merges schedules into one unfinished job', async () => {
  const {scheduler, log} = setup();
  const blocker = manual();
  const a = manual();
  const other = manual();
  scheduler.schedule('blocker', blocker.run);
  const keyed = scheduler.schedule('a', a.run, {key: 'k', priority: 1});
  scheduler.schedule('b', manual().run, {priority: 3});
  assert.equal(scheduler.schedule('other', other.run, {key: 'k', priority: 5, attempts: 9, timeout: 5}), keyed);
  assert.equal(keyed.priority, 5);
  const c = scheduler.schedule('c', manual().run);
  assert.equal(c.id, 4);
  assert.equal(scheduler.schedule('x', other.run, {key: 'k', priority: 0}), keyed);
  assert.equal(keyed.priority, 5);
  assert.equal(keyed.name, 'a');
  blocker.last.resolve();
  await flush();
  assert.equal(keyed.state, 'running');
  a.last.resolve('A');
  assert.equal(await keyed.promise, 'A');
  const again = scheduler.schedule('again', manual().run, {key: 'k'});
  assert.notEqual(again, keyed);
  assert.equal(again.id, 5);
  assert.equal(other.calls.length, 0);
  assert.deepEqual(log, ['0 queued 1', '0 start 1 1', '0 queued 2', '0 queued 3', '0 merge 2', '0 queued 4', '0 merge 2',
    '0 success 1 1', '0 start 2 1', '0 success 2 1', '0 start 3 1', '0 queued 5']);
});

test('a priority raised while running applies when the job waits again', async () => {
  const {clock, scheduler, log} = setup({backoff: {initial: 10}});
  const keyed = manual();
  const job = scheduler.schedule('keyed', keyed.run, {key: 'k', attempts: 2});
  const second = manual();
  scheduler.schedule('second', second.run, {priority: 1});
  scheduler.schedule('merge', () => {}, {key: 'k', priority: 3});
  keyed.last.reject(new Error('once'));
  await clock.advance(10);
  scheduler.schedule('third', () => {}, {priority: 2});
  second.last.resolve();
  await flush();
  assert.equal(job.state, 'running');
  assert.deepEqual(log.slice(-3), ['10 queued 3', '10 success 2 1', '10 start 1 2']);
});

test('setConcurrency', async () => {
  const {scheduler, log} = setup();
  const works = [manual(), manual(), manual(), manual()];
  const jobs = [0, 0, 2, 1].map((priority, i) => scheduler.schedule('j' + i, works[i].run, {priority}));
  log.length = 0;
  scheduler.setConcurrency(3);
  assert.deepEqual(log, ['0 start 3 1', '0 start 4 1']);
  assert.throws(() => scheduler.setConcurrency(0), {name: 'TypeError', message: 'concurrency must be an integer >= 1'});
  assert.throws(() => scheduler.setConcurrency(2.5), {name: 'TypeError', message: 'concurrency must be an integer >= 1'});
  scheduler.setConcurrency(1);
  assert.deepEqual(jobs.map(job => job.state), ['running', 'waiting', 'running', 'running']);
  works[0].last.resolve();
  await flush();
  works[2].last.resolve();
  await flush();
  assert.equal(jobs[1].state, 'waiting');
  works[3].last.resolve();
  await flush();
  assert.equal(jobs[1].state, 'running');
});

test('idle and drain', async () => {
  const {scheduler, log} = setup({concurrency: 2});
  let early = false;
  scheduler.drain().then(() => { early = true; });
  await flush();
  assert.equal(early, true);
  const [a, b] = [manual(), manual()];
  scheduler.schedule('a', a.run);
  scheduler.schedule('b', b.run);
  let drained = false;
  const done = scheduler.drain().then(value => { drained = true; return value; });
  a.last.resolve();
  await flush();
  assert.equal(drained, false);
  b.last.resolve();
  assert.equal(await done, undefined);
  assert.deepEqual(log.filter(line => line.endsWith('idle')), ['0 idle']);
  assert.equal(log[log.length - 1], '0 idle');
  scheduler.schedule('c', () => 'c');
  await scheduler.drain();
  assert.deepEqual(log.filter(line => line.endsWith('idle')), ['0 idle', '0 idle']);
});

test('events are plain objects with exactly the documented properties', async () => {
  const clock = fakeClock();
  const scheduler = createScheduler({clock, backoff: {initial: 5}});
  const events = [];
  scheduler.on(event => events.push(event));
  const error = new Error('e1');
  const work = manual();
  const job = scheduler.schedule('x', work.run, {attempts: 2, key: 'k'});
  scheduler.schedule('y', () => 1, {key: 'k'});
  await clock.advance(3);
  work.last.reject(error);
  await flush();
  await clock.advance(5);
  job.cancel();
  scheduler.schedule('z', () => 'z');
  scheduler.schedule('w', () => Promise.reject(error));
  await scheduler.drain();
  assert.deepStrictEqual(events, [
    {type: 'queued', id: 1, at: 0}, {type: 'start', id: 1, attempt: 1, at: 0}, {type: 'merge', id: 1, at: 0},
    {type: 'failure', id: 1, attempt: 1, error, at: 3}, {type: 'retry', id: 1, attempt: 2, delay: 5, at: 3},
    {type: 'start', id: 1, attempt: 2, at: 8}, {type: 'cancel', id: 1, at: 8}, {type: 'idle', at: 8},
    {type: 'queued', id: 2, at: 8}, {type: 'start', id: 2, attempt: 1, at: 8}, {type: 'queued', id: 3, at: 8},
    {type: 'success', id: 2, attempt: 1, at: 8}, {type: 'start', id: 3, attempt: 1, at: 8},
    {type: 'failure', id: 3, attempt: 1, error, at: 8}, {type: 'failed', id: 3, attempt: 1, at: 8}, {type: 'idle', at: 8}]);
  assert.equal(events[3].error, error);
});

test('listeners: subscription order and unsubscribing', async () => {
  const clock = fakeClock();
  const scheduler = createScheduler({clock});
  const seen = [];
  const offA = scheduler.on(event => seen.push('a ' + event.type));
  scheduler.on(event => seen.push('b ' + event.type));
  scheduler.schedule('one', () => 1);
  offA();
  await scheduler.drain();
  assert.deepEqual(seen, ['a queued', 'b queued', 'a start', 'b start', 'b success', 'b idle']);
});

test('rejections nobody handles are not unhandled rejections', async () => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const {clock, scheduler} = setup();
    scheduler.schedule('fails', () => Promise.reject(new Error('nobody listens')));
    scheduler.schedule('cancelled', () => new Promise(() => {})).cancel();
    scheduler.schedule('times out', () => new Promise(() => {}), {timeout: 5});
    await clock.advance(10);
    await scheduler.drain();
    for (let i = 0; i < 5; i++) await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('validation: messages and order', () => {
  const clock = fakeClock();
  const make = options => () => createScheduler(options);
  const cases = [
    [() => createScheduler(), 'clock must have now, setTimeout and clearTimeout functions'],
    [make({clock: {now() {}, setTimeout() {}}, concurrency: 0}), 'clock must have now, setTimeout and clearTimeout functions'],
    [make({clock, concurrency: 0, attempts: 0}), 'concurrency must be an integer >= 1'],
    [make({clock, concurrency: '2'}), 'concurrency must be an integer >= 1'],
    [make({clock, concurrency: 1.5}), 'concurrency must be an integer >= 1'],
    [make({clock, concurrency: NaN}), 'concurrency must be an integer >= 1'],
    [make({clock, attempts: 0, backoff: {initial: -1}}), 'attempts must be an integer >= 1'],
    [make({clock, backoff: {initial: -1, factor: 0}}), 'backoff.initial must be an integer >= 0'],
    [make({clock, backoff: {initial: 1.5}}), 'backoff.initial must be an integer >= 0'],
    [make({clock, backoff: {factor: 0.5}}), 'backoff.factor must be a finite number >= 1'],
    [make({clock, backoff: {factor: Infinity}}), 'backoff.factor must be a finite number >= 1'],
    [make({clock, backoff: {factor: '2'}}), 'backoff.factor must be a finite number >= 1'],
    [make({clock, backoff: {factor: NaN, max: -1}}), 'backoff.factor must be a finite number >= 1'],
    [make({clock, backoff: {max: 50}}), 'backoff.max must be an integer >= backoff.initial'],
    [make({clock, backoff: {initial: 10, max: 10.5}}), 'backoff.max must be an integer >= backoff.initial'],
  ];
  for (const [fn, expected] of cases) assert.throws(fn, error => error instanceof TypeError && error.message === expected, expected);
  createScheduler({clock, backoff: {initial: 10, max: 10}});
  createScheduler({clock, concurrency: undefined, attempts: undefined, backoff: {initial: 0, factor: 1, max: 0}});

  const log = [];
  const scheduler = createScheduler({clock});
  scheduler.on(event => log.push(event.type));
  const fn = () => new Promise(() => {});
  const bad = [
    [['', 'x', {priority: 0.5}], 'name must be a non-empty string'],
    [[5, fn], 'name must be a non-empty string'],
    [['a', 'fn', {priority: 'x'}], 'run must be a function'],
    [['a', fn, {priority: 1.5, timeout: 0}], 'priority must be an integer'],
    [['a', fn, {priority: '1'}], 'priority must be an integer'],
    [['a', fn, {attempts: 0, timeout: 0}], 'attempts must be an integer >= 1'],
    [['a', fn, {timeout: 0, key: 5}], 'timeout must be an integer >= 1'],
    [['a', fn, {timeout: 2.5}], 'timeout must be an integer >= 1'],
    [['a', fn, {key: 5}], 'key must be a string'],
  ];
  for (const [args, expected] of bad) assert.throws(() => scheduler.schedule(...args), error => error instanceof TypeError && error.message === expected, expected);
  assert.deepEqual(log, []);
  const job = scheduler.schedule('ok', fn, {key: 'k', priority: -2, attempts: undefined, timeout: undefined});
  assert.equal(job.id, 1);
  assert.throws(() => scheduler.schedule('a', fn, {key: 'k', timeout: 0}), {name: 'TypeError', message: 'timeout must be an integer >= 1'});
  assert.deepEqual(log, ['queued', 'start']);
  job.cancel();
});

test('performance: 100,000 jobs', async () => {
  const clock = fakeClock();
  const scheduler = createScheduler({clock, concurrency: 4});
  const starts = [];
  scheduler.on(event => { if (event.type === 'start') starts.push(event.id); });
  let seed = 12345;
  const random = () => (seed = seed * 48271 % 2147483647);
  const N = 100000;
  const priorities = [];
  for (let i = 0; i < N; i++) priorities.push(random() % 101 - 50);
  const begin = performance.now();
  const handles = [];
  for (let i = 0; i < N; i++) handles.push(scheduler.schedule('job' + i, () => i, {priority: priorities[i]}));
  for (let i = 10; i < N; i += 10) handles[i].cancel();
  await scheduler.drain();
  const elapsed = performance.now() - begin;
  const rest = [];
  for (let id = 5; id <= N; id++) if ((id - 1) % 10 !== 0) rest.push(id);
  rest.sort((a, b) => priorities[b - 1] - priorities[a - 1] || a - b);
  assert.deepEqual(starts, [1, 2, 3, 4, ...rest]);
  assert.ok(elapsed < ${PERF_BUDGET_MS}, 'took ' + Math.round(elapsed) + ' ms');
});
`.replace('@FAKE_CLOCK@', FAKE_CLOCK.replace('export function', 'function'));

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

// Variants of the reference for mustReject; built eagerly so a stale pattern fails at import.
function variant(...edits) {
  let source = REFERENCE;
  for (const [from, to] of edits) {
    if (!source.includes(from)) throw Error('job-scheduler: variant pattern not found: ' + from);
    source = source.replace(from, to);
  }
  return root => writeTree(root, {'src/scheduler.js': source});
}

const TIMEOUT_BLOCK = js`    if (job.timeout !== undefined) {
      current.timer = clock.setTimeout(() => {
        if (job.current === current) fail(job, new TimeoutError(job.name, job.timeout), true);
      }, job.timeout);
    }
`;

export default {
  id: 'job-scheduler',
  category: 'async ordering with a fake clock',
  prompt: 'src/scheduler.js implements only part of the job scheduler specified in docs/SCHEDULER.md. Make it implement that specification completely and exactly. ' +
    'Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Job scheduler: first cut', files]]),
  solve: root => writeTree(root, {'src/scheduler.js': REFERENCE}),
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
    // A retried job queues behind every job with the same priority (FIFO by re-entry).
    variant(['job.entry = {job, priority: job.priority, order: job.id};', 'job.entry = {job, priority: job.priority, order: job.id + job.attempt * 1e9};']),
    // The timeout callback is registered after run is called.
    variant([TIMEOUT_BLOCK, ''], ['    let outcome;\n', '    let outcome;\n    queueMicrotask(() => {\n' + TIMEOUT_BLOCK + '    });\n']),
    // Backoff rounded to nearest instead of down.
    variant(['Math.floor(initial * factor', 'Math.round(initial * factor']),
    // Cancel emits before aborting the running attempt.
    variant(["    if (job.state === 'running') stop(job).abort(error);\n", "    const controller = job.state === 'running' ? stop(job) : null;\n"],
      ["    emit({type: 'cancel', id: job.id});\n", "    emit({type: 'cancel', id: job.id});\n    controller?.abort(error);\n"]),
    // A merge uses up an id.
    variant(["      emit({type: 'merge', id: existing.id});", "      lastId++;\n      emit({type: 'merge', id: existing.id});"]),
    // A synchronous throw is handled synchronously.
    variant(['    } catch (error) {\n      outcome = Promise.reject(error);\n    }', '    } catch (error) {\n      fail(job, error, false);\n      return;\n    }']),
    // Job promises may surface as unhandled rejections.
    variant(['    job.promise.catch(() => {});\n', '']),
    // A raised priority does not reposition a waiting job.
    variant(['        if (existing.state === \'waiting\') {', '        if (false) {']),
    // Linear scan for the best waiting job.
    variant(['      const entry = heapPop(heap);', '      let bestIndex = 0;\n      for (let i = 1; i < heap.length; i++) if (better(heap[i], heap[bestIndex])) bestIndex = i;\n      const entry = heap.splice(bestIndex, 1)[0];'],
      ['    heapPush(heap, job.entry);', '    heap.push(job.entry);'], ['          heapPush(heap, existing.entry);', '          heap.push(existing.entry);']),
    // A visible test edited.
    root => writeTree(root, {'test/scheduler.test.js': VISIBLE.replace("test('a higher priority starts first'", "test.skip('a higher priority starts first'")}),
  ],
};
