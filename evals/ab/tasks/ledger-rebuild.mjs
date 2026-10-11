import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Markdown with code spans: '~' stands for a backtick so the docs can live in template literals.
const md = text => text.replaceAll('~', '\x60');

const LEDGER_DOC = md(`# acct-ledger

An event-sourced account ledger. Commands append events to one stream per account; a live projection folds every
appended event into a read model that the queries read. ~createLedger()~ in ~src/index.js~ is the only public entry point.

## API

~createLedger({clock, snapshotEvery})~ returns a ledger. ~clock~ defaults to a fixed clock at 2024-01-01T00:00:00Z
(see ~src/clock.js~); ~snapshotEvery~ (a positive integer) defaults to 50.

| Method | Effect |
| --- | --- |
| ~openAccount(id, currency, {overdraft})~ | Opens an account. ~overdraft~ is an amount string, default ~'0'~. |
| ~deposit(id, amount)~ | Adds ~amount~ to the balance. |
| ~withdraw(id, amount)~ | Subtracts ~amount~ from the balance. Needs funds (below). |
| ~placeHold(id, holdId, amount)~ | Opens a hold of ~amount~. Needs funds. ~holdId~ must not be an open hold of the account. |
| ~releaseHold(id, holdId)~ | Closes an open hold without moving money. |
| ~captureHold(id, holdId, amount)~ | Closes an open hold and subtracts ~amount~ (default: the whole hold) from the balance. ~amount~ may not exceed the hold. |
| ~transfer(fromId, toId, amount)~ | Moves ~amount~ between two accounts of the same currency. Needs funds in ~fromId~. |
| ~balance(id)~ | ~{currency, balance, held, available, version}~ |
| ~holds(id)~ | Open holds as ~[{holdId, amount}]~, sorted by ~holdId~. |
| ~rebuild()~ | Rebuilds the read model; returns ~{accounts, eventsRead}~. See docs/ARCHITECTURE.md. |

## Amounts

Amounts are decimal strings in major units with at most as many decimals as the currency has minor digits
(USD 2, EUR 2, JPY 0, KWD 3): ~'12.50'~ USD, ~'7'~ JPY, ~'0.125'~ KWD. Amounts passed to commands must be positive.
Queries format amounts the same way, always with all minor digits and a leading ~-~ for negative values
(~'-0.40'~). Internally every amount is an integer number of minor units.

## Balances and holds

- ~balance~ is the money on the account: deposits and incoming transfers minus withdrawals, outgoing transfers and captures.
- ~held~ is the sum of the open holds; ~available~ is ~balance - held~.
- A hold is open from ~placeHold~ until it is released or captured. Capturing takes the captured amount from the balance
  and closes the hold, releasing the rest of it: after capturing 25.00 of a 40.00 hold, nothing of that hold is held any more.
- A closed hold is gone: releasing or capturing it again fails with ~Unknown hold <holdId>~. Its id may be reused by a new hold.
- ~version~ is the version of the account's latest event (see docs/ARCHITECTURE.md).

## Funds

A command that "needs funds" for an amount ~x~ succeeds exactly when ~x <= available + overdraft~, where ~available~ is
what ~balance(id)~ reports at that moment and ~overdraft~ is the account's overdraft limit. Otherwise it throws
~DomainError~ ~Insufficient funds in <id>~ and appends nothing. Commands and queries must always agree on these numbers.

## Errors

Every rule violation throws ~DomainError~ (~src/errors.js~) with one of these messages:
~Unknown account <id>~, ~Account <id> already exists~, ~Invalid account id <id>~, ~Unknown currency <currency>~,
~Invalid amount <amount>~, ~Insufficient funds in <id>~, ~Hold <holdId> already exists~, ~Unknown hold <holdId>~,
~Capture exceeds hold <holdId>~, ~Cannot transfer to the same account~, ~Currency mismatch: <from> vs <to>~.
`);

const ARCH_DOC = md(`# Architecture

## Write side

Each account has a stream ~account-<id>~ in the event store (~src/store/~). An event is
~{stream, version, position, type, data, at}~: ~version~ is its 1-based position in its stream (the first event of
every stream has version 1), ~position~ its 1-based position in the global log. A command loads the account by folding
its whole stream (~src/domain/~), validates, and appends with optimistic concurrency on the stream version.
The event payloads are listed in ~src/events/types.js~.

## Read side

The event store calls its subscribers synchronously for every appended event. The live projector
(~src/projection/projector.js~) folds each event into the read model with the reducer and ignores events whose
version is not newer than the account's projected version (delivery is at-least-once).

## Snapshots

After the projector applies an event whose version is a multiple of ~snapshotEvery~, it saves a snapshot of that
account's projected state; the snapshot's version is that event's version. Only the latest snapshot of each account is kept.

## Rebuild

~rebuild()~ replaces the read model with one rebuilt from the event store. For every account it starts from the account's
latest snapshot and applies only the events with a greater version; an account without a snapshot is rebuilt from its first
event. It returns ~{accounts, eventsRead}~: the number of accounts, and the total number of events read from the store
for the rebuild (so for every account, the events after its latest snapshot, or all of its events when it has none).

The rebuilt read model must be exactly the state the live projection had: afterwards ~balance()~ and ~holds()~ return the same
results for every account as before the rebuild. ~rebuild()~ runs at every deploy, so it may be called any number of times,
with commands in between; every call must satisfy this.
`);

const README = md(`# acct-ledger

Event-sourced account ledger. See docs/LEDGER.md for the API and docs/ARCHITECTURE.md for the internals.

    npm test
`);

const PKG = JSON.stringify({name: 'acct-ledger', version: '3.4.0', private: true, type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n';

const ERRORS = String.raw`/** A business rule violation; the messages are listed in docs/LEDGER.md. */
export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
  }
}

/** An append raced another writer of the same stream. */
export class ConcurrencyError extends Error {
  constructor(stream, expected, actual) {
    super('Stream ' + stream + ' is at version ' + actual + ', expected ' + expected);
    this.name = 'ConcurrencyError';
  }
}
`;

const CLOCK = String.raw`/** A clock that moves only when told to; the ledger never reads the system time. */
export function fixedClock(start) {
  let now = Date.parse(start);
  if (Number.isNaN(now)) throw new RangeError('Invalid clock start: ' + start);
  return {
    now: () => new Date(now).toISOString(),
    advance(ms) { now += ms; },
  };
}
`;

const MONEY = String.raw`import {DomainError} from './errors.js';

/** Number of minor digits of every supported currency. */
export const CURRENCIES = Object.freeze({USD: 2, EUR: 2, JPY: 0, KWD: 3});

export function exponentOf(currency) {
  if (typeof currency !== 'string' || !Object.hasOwn(CURRENCIES, currency)) throw new DomainError('Unknown currency ' + String(currency));
  return CURRENCIES[currency];
}

/** '12.50' (USD) -> 1250 minor units. Zero is accepted only with allowZero. */
export function parseAmount(text, currency, {allowZero = false} = {}) {
  const exponent = exponentOf(currency);
  const match = typeof text === 'string' ? /^(\d+)(?:\.(\d+))?$/.exec(text) : null;
  if (!match || (match[2] ?? '').length > exponent) throw new DomainError('Invalid amount ' + String(text));
  const minor = Number(match[1] + (match[2] ?? '').padEnd(exponent, '0'));
  if (!Number.isSafeInteger(minor) || (minor === 0 && !allowZero)) throw new DomainError('Invalid amount ' + String(text));
  return minor;
}

/** 1250 (USD) -> '12.50'; -40 (USD) -> '-0.40'; 7 (JPY) -> '7'. */
export function formatAmount(minor, currency) {
  const exponent = exponentOf(currency);
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0');
  const sign = minor < 0 ? '-' : '';
  return exponent === 0 ? sign + digits : sign + digits.slice(0, -exponent) + '.' + digits.slice(-exponent);
}
`;

const TYPES = String.raw`/**
 * Stored event types and their payloads (amounts in minor units):
 *
 *   AccountOpened   {accountId, currency, overdraftMinor}
 *   Deposited       {amountMinor}
 *   Withdrawn       {amountMinor}
 *   HoldPlaced      {holdId, amountMinor}
 *   HoldReleased    {holdId}
 *   HoldCaptured    {holdId, amountMinor}      amountMinor = captured amount, at most the hold
 *   TransferredOut  {amountMinor, counterparty}
 *   TransferredIn   {amountMinor, counterparty}
 */
export const ACCOUNT_OPENED = 'AccountOpened';
export const DEPOSITED = 'Deposited';
export const WITHDRAWN = 'Withdrawn';
export const HOLD_PLACED = 'HoldPlaced';
export const HOLD_RELEASED = 'HoldReleased';
export const HOLD_CAPTURED = 'HoldCaptured';
export const TRANSFERRED_OUT = 'TransferredOut';
export const TRANSFERRED_IN = 'TransferredIn';
`;

const STREAMS = String.raw`const PREFIX = 'account-';

/** Every account has exactly one stream. */
export const streamOf = accountId => PREFIX + accountId;
export const accountOf = stream => stream.slice(PREFIX.length);
`;

const BACKEND = String.raw`/**
 * Append-only in-memory storage: one array per stream plus the global log.
 * Index i of a stream's array holds the event with version i + 1.
 */
export class MemoryBackend {
  #streams = new Map();
  #log = [];

  /** Current version of the stream: its number of events, 0 when it does not exist. */
  version(stream) {
    return this.#streams.get(stream)?.length ?? 0;
  }

  /** Global position the next pushed event gets (positions start at 1). */
  nextPosition() {
    return this.#log.length + 1;
  }

  push(event) {
    if (!this.#streams.has(event.stream)) this.#streams.set(event.stream, []);
    this.#streams.get(event.stream).push(event);
    this.#log.push(event);
  }

  /** Every event of the stream, oldest first. Callers must not mutate the array. */
  all(stream) {
    return this.#streams.get(stream) ?? [];
  }

  /** Events of the stream with version >= fromVersion, oldest first. */
  range(stream, fromVersion) {
    return this.all(stream).slice(fromVersion);
  }

  streams() {
    return [...this.#streams.keys()];
  }
}
`;
const BACKEND_FIXED = swap(BACKEND, 'this.all(stream).slice(fromVersion)', 'this.all(stream).slice(fromVersion - 1)');

const EVENT_STORE = String.raw`import {ConcurrencyError} from '../errors.js';

/** Appends events with optimistic concurrency and notifies subscribers synchronously, in append order. */
export class EventStore {
  #backend;
  #clock;
  #subscribers = [];

  constructor(backend, clock) {
    this.#backend = backend;
    this.#clock = clock;
  }

  version(stream) {
    return this.#backend.version(stream);
  }

  /**
   * Append events ([{type, data}]) to the stream, whose current version must be expectedVersion.
   * Stored events are frozen and get the next stream versions, the next global positions and the clock's time.
   */
  append(stream, expectedVersion, events) {
    const actual = this.#backend.version(stream);
    if (actual !== expectedVersion) throw new ConcurrencyError(stream, expectedVersion, actual);
    const first = this.#backend.nextPosition();
    const at = this.#clock.now();
    const stored = events.map(({type, data}, i) => Object.freeze({
      stream, version: actual + i + 1, position: first + i, type, data: Object.freeze({...data}), at,
    }));
    for (const event of stored) this.#backend.push(event);
    for (const event of stored) for (const subscriber of this.#subscribers) subscriber(event);
    return stored;
  }

  /** Events of the stream with version >= fromVersion (versions are 1-based), oldest first. */
  read(stream, fromVersion = 1) {
    // Whole-stream reads are the common case (every command loads its account), so they skip the copy.
    if (fromVersion <= 1) return this.#backend.all(stream);
    return this.#backend.range(stream, fromVersion);
  }

  streams() {
    return this.#backend.streams();
  }

  subscribe(subscriber) {
    this.#subscribers.push(subscriber);
  }
}
`;

const ACCOUNT = String.raw`import * as T from '../events/types.js';

/**
 * Write-side state of one account, folded from its whole stream; commands validate against it.
 * {id, currency, overdraftMinor, balanceMinor, heldMinor, holds: Map(holdId -> amountMinor), version}
 */
export function foldAccount(events) {
  let state = null;
  for (const event of events) state = apply(state, event);
  return state;
}

function apply(state, {type, data, version}) {
  switch (type) {
    case T.ACCOUNT_OPENED:
      return {id: data.accountId, currency: data.currency, overdraftMinor: data.overdraftMinor,
        balanceMinor: 0, heldMinor: 0, holds: new Map(), version};
    case T.DEPOSITED:
    case T.TRANSFERRED_IN:
      return {...state, balanceMinor: state.balanceMinor + data.amountMinor, version};
    case T.WITHDRAWN:
    case T.TRANSFERRED_OUT:
      return {...state, balanceMinor: state.balanceMinor - data.amountMinor, version};
    case T.HOLD_PLACED: {
      const holds = new Map(state.holds).set(data.holdId, data.amountMinor);
      return {...state, holds, heldMinor: state.heldMinor + data.amountMinor, version};
    }
    case T.HOLD_RELEASED: {
      const holds = new Map(state.holds);
      holds.delete(data.holdId);
      return {...state, holds, heldMinor: state.heldMinor - state.holds.get(data.holdId), version};
    }
    case T.HOLD_CAPTURED: {
      const holds = new Map(state.holds);
      holds.delete(data.holdId);
      return {...state, holds, balanceMinor: state.balanceMinor - data.amountMinor,
        heldMinor: state.heldMinor - data.amountMinor, version};
    }
    default:
      return {...state, version};
  }
}
`;
const ACCOUNT_FIXED = swap(ACCOUNT, 'heldMinor: state.heldMinor - data.amountMinor, version};', 'heldMinor: state.heldMinor - state.holds.get(data.holdId), version};');

const POLICIES = String.raw`import {DomainError} from '../errors.js';

/** What a command may spend: balance minus open holds plus the overdraft limit. */
export const spendable = account => account.balanceMinor - account.heldMinor + account.overdraftMinor;

export function requireFunds(account, amountMinor) {
  if (amountMinor > spendable(account)) throw new DomainError('Insufficient funds in ' + account.id);
}

/** Amount of an open hold, or DomainError. */
export function openHold(account, holdId) {
  const amountMinor = account.holds.get(holdId);
  if (amountMinor === undefined) throw new DomainError('Unknown hold ' + holdId);
  return amountMinor;
}
`;

const LOAD = String.raw`import {DomainError} from '../errors.js';
import {streamOf} from '../events/streams.js';
import {foldAccount} from './account.js';

export function loadAccount(store, accountId) {
  const account = foldAccount(store.read(streamOf(accountId)));
  if (!account) throw new DomainError('Unknown account ' + accountId);
  return account;
}
`;

const OPEN = String.raw`import {DomainError} from '../errors.js';
import {streamOf} from '../events/streams.js';
import * as T from '../events/types.js';
import {exponentOf, parseAmount} from '../money.js';

export function openAccount({store}, accountId, currency, {overdraft = '0'} = {}) {
  if (typeof accountId !== 'string' || !/^[a-z0-9-]+$/.test(accountId)) throw new DomainError('Invalid account id ' + String(accountId));
  exponentOf(currency);
  const overdraftMinor = parseAmount(overdraft, currency, {allowZero: true});
  const stream = streamOf(accountId);
  if (store.version(stream) !== 0) throw new DomainError('Account ' + accountId + ' already exists');
  store.append(stream, 0, [{type: T.ACCOUNT_OPENED, data: {accountId, currency, overdraftMinor}}]);
}
`;

const CASH = String.raw`import {loadAccount} from '../domain/load.js';
import {requireFunds} from '../domain/policies.js';
import {streamOf} from '../events/streams.js';
import * as T from '../events/types.js';
import {parseAmount} from '../money.js';

export function deposit({store}, accountId, amount) {
  const account = loadAccount(store, accountId);
  const amountMinor = parseAmount(amount, account.currency);
  store.append(streamOf(accountId), account.version, [{type: T.DEPOSITED, data: {amountMinor}}]);
}

export function withdraw({store}, accountId, amount) {
  const account = loadAccount(store, accountId);
  const amountMinor = parseAmount(amount, account.currency);
  requireFunds(account, amountMinor);
  store.append(streamOf(accountId), account.version, [{type: T.WITHDRAWN, data: {amountMinor}}]);
}
`;

const HOLDS = String.raw`import {DomainError} from '../errors.js';
import {loadAccount} from '../domain/load.js';
import {openHold, requireFunds} from '../domain/policies.js';
import {streamOf} from '../events/streams.js';
import * as T from '../events/types.js';
import {parseAmount} from '../money.js';

export function placeHold({store}, accountId, holdId, amount) {
  const account = loadAccount(store, accountId);
  if (account.holds.has(holdId)) throw new DomainError('Hold ' + holdId + ' already exists');
  const amountMinor = parseAmount(amount, account.currency);
  requireFunds(account, amountMinor);
  store.append(streamOf(accountId), account.version, [{type: T.HOLD_PLACED, data: {holdId, amountMinor}}]);
}

export function releaseHold({store}, accountId, holdId) {
  const account = loadAccount(store, accountId);
  openHold(account, holdId);
  store.append(streamOf(accountId), account.version, [{type: T.HOLD_RELEASED, data: {holdId}}]);
}

export function captureHold({store}, accountId, holdId, amount) {
  const account = loadAccount(store, accountId);
  const holdMinor = openHold(account, holdId);
  const amountMinor = amount === undefined ? holdMinor : parseAmount(amount, account.currency);
  if (amountMinor > holdMinor) throw new DomainError('Capture exceeds hold ' + holdId);
  store.append(streamOf(accountId), account.version, [{type: T.HOLD_CAPTURED, data: {holdId, amountMinor}}]);
}
`;

const TRANSFER = String.raw`import {DomainError} from '../errors.js';
import {loadAccount} from '../domain/load.js';
import {requireFunds} from '../domain/policies.js';
import {streamOf} from '../events/streams.js';
import * as T from '../events/types.js';
import {parseAmount} from '../money.js';

export function transfer({store}, fromId, toId, amount) {
  if (fromId === toId) throw new DomainError('Cannot transfer to the same account');
  const from = loadAccount(store, fromId);
  const to = loadAccount(store, toId);
  if (from.currency !== to.currency) throw new DomainError('Currency mismatch: ' + from.currency + ' vs ' + to.currency);
  const amountMinor = parseAmount(amount, from.currency);
  requireFunds(from, amountMinor);
  store.append(streamOf(fromId), from.version, [{type: T.TRANSFERRED_OUT, data: {amountMinor, counterparty: toId}}]);
  store.append(streamOf(toId), to.version, [{type: T.TRANSFERRED_IN, data: {amountMinor, counterparty: fromId}}]);
}
`;

const REDUCER = String.raw`import * as T from '../events/types.js';

/** Projected state before an account's first event. */
export const EMPTY = Object.freeze({id: null, currency: null, version: 0, balanceMinor: 0, heldMinor: 0, holds: new Map()});

/**
 * Read-side reducer: (state, event) -> next state, where state is
 * {id, currency, version, balanceMinor, heldMinor, holds: Map(holdId -> amountMinor)}.
 * Never throws: events were validated by the command that wrote them.
 */
export function reduce(state, {type, data, version}) {
  switch (type) {
    case T.ACCOUNT_OPENED:
      return {id: data.accountId, currency: data.currency, version, balanceMinor: 0, heldMinor: 0, holds: new Map()};
    case T.DEPOSITED:
    case T.TRANSFERRED_IN:
      return {...state, version, balanceMinor: state.balanceMinor + data.amountMinor};
    case T.WITHDRAWN:
    case T.TRANSFERRED_OUT:
      return {...state, version, balanceMinor: state.balanceMinor - data.amountMinor};
    case T.HOLD_PLACED:
      state.holds.set(data.holdId, data.amountMinor);
      return {...state, version, heldMinor: state.heldMinor + data.amountMinor};
    case T.HOLD_RELEASED:
    case T.HOLD_CAPTURED: {
      const holdMinor = state.holds.get(data.holdId);
      if (holdMinor === undefined) return {...state, version}; // already settled
      state.holds.delete(data.holdId);
      const capturedMinor = type === T.HOLD_CAPTURED ? data.amountMinor : 0;
      return {...state, version, heldMinor: state.heldMinor - holdMinor, balanceMinor: state.balanceMinor - capturedMinor};
    }
    default:
      return {...state, version};
  }
}
`;
const REDUCER_FIXED = swap(swap(REDUCER, `    case T.HOLD_PLACED:
      state.holds.set(data.holdId, data.amountMinor);
      return {...state, version, heldMinor: state.heldMinor + data.amountMinor};`, `    case T.HOLD_PLACED: {
      const holds = new Map(state.holds).set(data.holdId, data.amountMinor);
      return {...state, version, holds, heldMinor: state.heldMinor + data.amountMinor};
    }`), `      state.holds.delete(data.holdId);
      const capturedMinor = type === T.HOLD_CAPTURED ? data.amountMinor : 0;
      return {...state, version, heldMinor:`, `      const holds = new Map(state.holds);
      holds.delete(data.holdId);
      const capturedMinor = type === T.HOLD_CAPTURED ? data.amountMinor : 0;
      return {...state, version, holds, heldMinor:`);

const READ_MODEL = String.raw`import {DomainError} from '../errors.js';

/** Projected account states by account id. */
export class ReadModel {
  #accounts = new Map();

  get(accountId) {
    return this.#accounts.get(accountId);
  }

  set(accountId, state) {
    this.#accounts.set(accountId, state);
  }

  require(accountId) {
    const state = this.#accounts.get(accountId);
    if (!state) throw new DomainError('Unknown account ' + accountId);
    return state;
  }

  ids() {
    return [...this.#accounts.keys()].sort();
  }
}
`;

const PROJECTOR = String.raw`import {accountOf} from '../events/streams.js';
import {shouldSnapshot} from '../snapshots/policy.js';
import {EMPTY, reduce} from './reducer.js';

/** Live projection: folds every appended event into the read model and takes the periodic snapshots. */
export class Projector {
  constructor({model, snapshots, snapshotEvery}) {
    this.model = model;
    this.snapshots = snapshots;
    this.snapshotEvery = snapshotEvery;
  }

  handle(event) {
    const accountId = accountOf(event.stream);
    const current = this.model.get(accountId) ?? EMPTY;
    if (event.version <= current.version) return; // at-least-once delivery: already applied
    const next = reduce(current, event);
    this.model.set(accountId, next);
    if (shouldSnapshot(next.version, this.snapshotEvery)) this.snapshots.save(accountId, next);
  }
}
`;

const POLICY = String.raw`/** Snapshot after every event whose version is a multiple of snapshotEvery. */
export const shouldSnapshot = (version, snapshotEvery) => version > 0 && version % snapshotEvery === 0;
`;

const SNAPSHOT_STORE = String.raw`/** Latest snapshot of every account's projected state. */
export class SnapshotStore {
  #latest = new Map();

  /** Keep state as the latest snapshot of the account; the snapshot's version is state.version. */
  save(accountId, state) {
    this.#latest.set(accountId, {version: state.version, state});
  }

  /** {version, state} of the account's latest snapshot, or undefined. */
  latest(accountId) {
    return this.#latest.get(accountId);
  }
}
`;

const REBUILD = String.raw`import {accountOf} from './events/streams.js';
import {ReadModel} from './projection/read-model.js';
import {EMPTY, reduce} from './projection/reducer.js';

/**
 * Rebuild the read model from each account's latest snapshot plus the events after it.
 * Returns {model, accounts, eventsRead}; see docs/ARCHITECTURE.md.
 */
export function rebuild(store, snapshots) {
  const model = new ReadModel();
  let eventsRead = 0;
  for (const stream of store.streams()) {
    const accountId = accountOf(stream);
    let state = snapshots.latest(accountId)?.state ?? EMPTY;
    const tail = store.read(stream, state.version + 1);
    for (const event of tail) state = reduce(state, event);
    eventsRead += tail.length;
    model.set(accountId, state);
  }
  return {model, accounts: model.ids().length, eventsRead};
}
`;

const QUERIES = String.raw`import {formatAmount} from './money.js';

export function balanceOf(model, accountId) {
  const state = model.require(accountId);
  const format = minor => formatAmount(minor, state.currency);
  return {
    currency: state.currency,
    balance: format(state.balanceMinor),
    held: format(state.heldMinor),
    available: format(state.balanceMinor - state.heldMinor),
    version: state.version,
  };
}

export function holdsOf(model, accountId) {
  const state = model.require(accountId);
  return [...state.holds]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([holdId, minor]) => ({holdId, amount: formatAmount(minor, state.currency)}));
}
`;

const INDEX = String.raw`import {fixedClock} from './clock.js';
import {deposit, withdraw} from './commands/cash.js';
import {captureHold, placeHold, releaseHold} from './commands/holds.js';
import {openAccount} from './commands/open-account.js';
import {transfer} from './commands/transfer.js';
import {Projector} from './projection/projector.js';
import {ReadModel} from './projection/read-model.js';
import {balanceOf, holdsOf} from './queries.js';
import {rebuild} from './rebuild.js';
import {SnapshotStore} from './snapshots/snapshot-store.js';
import {EventStore} from './store/event-store.js';
import {MemoryBackend} from './store/memory-backend.js';

/** The public API; see docs/LEDGER.md. */
export function createLedger({clock = fixedClock('2024-01-01T00:00:00Z'), snapshotEvery = 50} = {}) {
  if (!Number.isInteger(snapshotEvery) || snapshotEvery < 1) throw new RangeError('snapshotEvery must be a positive integer');
  const store = new EventStore(new MemoryBackend(), clock);
  const snapshots = new SnapshotStore();
  const projector = new Projector({model: new ReadModel(), snapshots, snapshotEvery});
  store.subscribe(event => projector.handle(event));
  const ctx = {store};
  return {
    openAccount: (accountId, currency, options) => openAccount(ctx, accountId, currency, options),
    deposit: (accountId, amount) => deposit(ctx, accountId, amount),
    withdraw: (accountId, amount) => withdraw(ctx, accountId, amount),
    placeHold: (accountId, holdId, amount) => placeHold(ctx, accountId, holdId, amount),
    releaseHold: (accountId, holdId) => releaseHold(ctx, accountId, holdId),
    captureHold: (accountId, holdId, amount) => captureHold(ctx, accountId, holdId, amount),
    transfer: (fromId, toId, amount) => transfer(ctx, fromId, toId, amount),
    balance: accountId => balanceOf(projector.model, accountId),
    holds: accountId => holdsOf(projector.model, accountId),
    rebuild() {
      const {model, accounts, eventsRead} = rebuild(store, snapshots);
      projector.model = model;
      return {accounts, eventsRead};
    },
  };
}
`;

const VISIBLE_LEDGER = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {createLedger} from '../src/index.js';

const fresh = () => {
  const ledger = createLedger();
  ledger.openAccount('alice', 'USD');
  ledger.openAccount('bob', 'USD');
  ledger.deposit('alice', '100.00');
  return ledger;
};

test('deposits and withdrawals', () => {
  const ledger = fresh();
  ledger.withdraw('alice', '30.25');
  assert.deepEqual(ledger.balance('alice'), {currency: 'USD', balance: '69.75', held: '0.00', available: '69.75', version: 3});
});

test('insufficient funds', () => {
  const ledger = fresh();
  assert.throws(() => ledger.withdraw('alice', '100.01'), {name: 'DomainError', message: 'Insufficient funds in alice'});
  assert.equal(ledger.balance('alice').version, 2);
});

test('holds reduce what is available', () => {
  const ledger = fresh();
  ledger.placeHold('alice', 'h1', '40.00');
  assert.deepEqual(ledger.balance('alice'), {currency: 'USD', balance: '100.00', held: '40.00', available: '60.00', version: 3});
  assert.deepEqual(ledger.holds('alice'), [{holdId: 'h1', amount: '40.00'}]);
  assert.throws(() => ledger.withdraw('alice', '60.01'), {message: 'Insufficient funds in alice'});
  ledger.releaseHold('alice', 'h1');
  assert.equal(ledger.balance('alice').available, '100.00');
  assert.deepEqual(ledger.holds('alice'), []);
});

test('capturing a whole hold', () => {
  const ledger = fresh();
  ledger.placeHold('alice', 'h1', '40.00');
  ledger.captureHold('alice', 'h1');
  assert.deepEqual(ledger.balance('alice'), {currency: 'USD', balance: '60.00', held: '0.00', available: '60.00', version: 4});
  ledger.withdraw('alice', '60.00');
  assert.equal(ledger.balance('alice').balance, '0.00');
});

test('transfers', () => {
  const ledger = fresh();
  ledger.transfer('alice', 'bob', '12.34');
  assert.equal(ledger.balance('alice').balance, '87.66');
  assert.equal(ledger.balance('bob').balance, '12.34');
  ledger.openAccount('yen', 'JPY');
  assert.throws(() => ledger.transfer('alice', 'yen', '1.00'), {message: 'Currency mismatch: USD vs JPY'});
});

test('overdraft', () => {
  const ledger = createLedger();
  ledger.openAccount('carol', 'USD', {overdraft: '5.00'});
  ledger.withdraw('carol', '0.40');
  assert.equal(ledger.balance('carol').balance, '-0.40');
  assert.throws(() => ledger.withdraw('carol', '4.61'), {message: 'Insufficient funds in carol'});
});

test('rebuild of a short history matches the live state', () => {
  const ledger = fresh();
  ledger.placeHold('alice', 'h1', '10.00');
  ledger.transfer('alice', 'bob', '5.00');
  const before = [ledger.balance('alice'), ledger.balance('bob'), ledger.holds('alice')];
  assert.deepEqual(ledger.rebuild(), {accounts: 2, eventsRead: 6});
  assert.deepEqual([ledger.balance('alice'), ledger.balance('bob'), ledger.holds('alice')], before);
});
`;

const VISIBLE_MONEY = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {formatAmount, parseAmount} from '../src/money.js';

test('parse', () => {
  assert.equal(parseAmount('12.50', 'USD'), 1250);
  assert.equal(parseAmount('7', 'JPY'), 7);
  assert.equal(parseAmount('0.125', 'KWD'), 125);
  assert.throws(() => parseAmount('1.234', 'USD'), {message: 'Invalid amount 1.234'});
  assert.throws(() => parseAmount('0', 'USD'), {message: 'Invalid amount 0'});
  assert.throws(() => parseAmount('1', 'XXX'), {message: 'Unknown currency XXX'});
});

test('format', () => {
  assert.equal(formatAmount(1250, 'USD'), '12.50');
  assert.equal(formatAmount(-40, 'USD'), '-0.40');
  assert.equal(formatAmount(7, 'JPY'), '7');
  assert.equal(formatAmount(5, 'KWD'), '0.005');
});
`;

const files = {
  'package.json': PKG,
  'README.md': README,
  'docs/LEDGER.md': LEDGER_DOC,
  'docs/ARCHITECTURE.md': ARCH_DOC,
  'src/index.js': INDEX,
  'src/errors.js': ERRORS,
  'src/clock.js': CLOCK,
  'src/money.js': MONEY,
  'src/queries.js': QUERIES,
  'src/rebuild.js': REBUILD,
  'src/events/types.js': TYPES,
  'src/events/streams.js': STREAMS,
  'src/store/memory-backend.js': BACKEND,
  'src/store/event-store.js': EVENT_STORE,
  'src/domain/account.js': ACCOUNT,
  'src/domain/policies.js': POLICIES,
  'src/domain/load.js': LOAD,
  'src/commands/open-account.js': OPEN,
  'src/commands/cash.js': CASH,
  'src/commands/holds.js': HOLDS,
  'src/commands/transfer.js': TRANSFER,
  'src/projection/reducer.js': REDUCER,
  'src/projection/read-model.js': READ_MODEL,
  'src/projection/projector.js': PROJECTOR,
  'src/snapshots/policy.js': POLICY,
  'src/snapshots/snapshot-store.js': SNAPSHOT_STORE,
  'test/ledger.test.js': VISIBLE_LEDGER,
  'test/money.test.js': VISIBLE_MONEY,
};

const FIXED = {
  'src/store/memory-backend.js': BACKEND_FIXED,
  'src/domain/account.js': ACCOUNT_FIXED,
  'src/projection/reducer.js': REDUCER_FIXED,
};

const HIDDEN = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
const {createLedger} = await import('@ROOT@src/index.js');

const state = (ledger, ids) => ids.map(id => ({id, balance: ledger.balance(id), holds: ledger.holds(id)}));

function checkedRebuild(ledger, ids, every) {
  const before = state(ledger, ids);
  const expectedRead = before.reduce((sum, {balance: {version}}) => sum + version - Math.floor(version / every) * every, 0);
  assert.deepStrictEqual(ledger.rebuild(), {accounts: ids.length, eventsRead: expectedRead});
  assert.deepStrictEqual(state(ledger, ids), before);
}

test('report 1: every deposit survives a rebuild', () => {
  const ledger = createLedger({snapshotEvery: 5});
  ledger.openAccount('acc-1', 'USD');
  for (let i = 0; i < 7; i++) ledger.deposit('acc-1', '1.00');
  assert.equal(ledger.balance('acc-1').balance, '7.00');
  assert.deepStrictEqual(ledger.rebuild(), {accounts: 1, eventsRead: 3});
  assert.deepStrictEqual(ledger.balance('acc-1'), {currency: 'USD', balance: '7.00', held: '0.00', available: '7.00', version: 8});
});

test('report 2: a hold released after the snapshot is not held after rebuild', () => {
  const ledger = createLedger({snapshotEvery: 5});
  ledger.openAccount('acc-1', 'USD');
  ledger.deposit('acc-1', '100.00');
  ledger.placeHold('acc-1', 'h1', '40.00');
  ledger.deposit('acc-1', '1.00');
  ledger.deposit('acc-1', '1.00');
  ledger.releaseHold('acc-1', 'h1');
  ledger.rebuild();
  assert.deepStrictEqual(ledger.balance('acc-1'), {currency: 'USD', balance: '102.00', held: '0.00', available: '102.00', version: 6});
  assert.deepStrictEqual(ledger.holds('acc-1'), []);
});

test('report 2: a hold placed after the snapshot is held once after rebuild', () => {
  const ledger = createLedger({snapshotEvery: 4});
  ledger.openAccount('acc-1', 'EUR');
  ledger.deposit('acc-1', '100.00');
  ledger.deposit('acc-1', '1.00');
  ledger.placeHold('acc-1', 'h1', '30.00');
  ledger.placeHold('acc-1', 'h2', '20.00');
  ledger.captureHold('acc-1', 'h1', '10.00');
  checkedRebuild(ledger, ['acc-1'], 4);
  assert.deepStrictEqual(ledger.balance('acc-1'), {currency: 'EUR', balance: '91.00', held: '20.00', available: '71.00', version: 6});
});

test('rebuild twice with a snapshotted hold settled in between', () => {
  const ledger = createLedger({snapshotEvery: 5});
  ledger.openAccount('acc-1', 'USD');
  ledger.deposit('acc-1', '100.00');
  ledger.placeHold('acc-1', 'h1', '40.00');
  ledger.placeHold('acc-1', 'h2', '5.00');
  ledger.deposit('acc-1', '1.00');
  checkedRebuild(ledger, ['acc-1'], 5);
  ledger.releaseHold('acc-1', 'h1');
  ledger.captureHold('acc-1', 'h2', '2.00');
  checkedRebuild(ledger, ['acc-1'], 5);
  assert.deepStrictEqual(ledger.balance('acc-1'), {currency: 'USD', balance: '99.00', held: '0.00', available: '99.00', version: 7});
  checkedRebuild(ledger, ['acc-1'], 5);
  ledger.placeHold('acc-1', 'h1', '9.00');
  checkedRebuild(ledger, ['acc-1'], 5);
  assert.deepStrictEqual(ledger.holds('acc-1'), [{holdId: 'h1', amount: '9.00'}]);
});

test('report 3: after a partial capture the rest of the hold is available to every command', () => {
  for (const command of ['withdraw', 'placeHold', 'transfer']) {
    const ledger = createLedger();
    ledger.openAccount('acc-2', 'USD');
    ledger.openAccount('acc-3', 'USD');
    ledger.deposit('acc-2', '100.00');
    ledger.placeHold('acc-2', 'h1', '40.00');
    ledger.captureHold('acc-2', 'h1', '25.00');
    assert.deepStrictEqual(ledger.balance('acc-2'), {currency: 'USD', balance: '75.00', held: '0.00', available: '75.00', version: 4});
    if (command === 'withdraw') ledger.withdraw('acc-2', '75.00');
    if (command === 'placeHold') ledger.placeHold('acc-2', 'h2', '75.00');
    if (command === 'transfer') ledger.transfer('acc-2', 'acc-3', '75.00');
    assert.equal(ledger.balance('acc-2').available, '0.00', command);
  }
});

test('a captured hold is closed', () => {
  const ledger = createLedger();
  ledger.openAccount('acc-2', 'USD');
  ledger.deposit('acc-2', '100.00');
  ledger.placeHold('acc-2', 'h1', '40.00');
  ledger.captureHold('acc-2', 'h1', '25.00');
  assert.throws(() => ledger.releaseHold('acc-2', 'h1'), {name: 'DomainError', message: 'Unknown hold h1'});
  assert.throws(() => ledger.captureHold('acc-2', 'h1'), {name: 'DomainError', message: 'Unknown hold h1'});
  ledger.placeHold('acc-2', 'h1', '75.00');
  assert.equal(ledger.balance('acc-2').held, '75.00');
});

// Seeded pseudo-random histories: rebuilds at random points must reproduce the live state exactly, and every
// command that needs funds must succeed exactly at available + overdraft and fail one minor unit above it.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DIGITS = {USD: 2, JPY: 0, KWD: 3};
const toMinor = (text, currency) => {
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const minor = Number(whole + fraction.padEnd(DIGITS[currency], '0'));
  return negative ? -minor : minor;
};
const toText = (minor, currency) => {
  const d = DIGITS[currency];
  const digits = String(minor).padStart(d + 1, '0');
  return d === 0 ? digits : digits.slice(0, -d) + '.' + digits.slice(-d);
};

for (const every of [1, 2, 3, 4, 7, 50]) {
  test('random histories, snapshotEvery ' + every, () => {
    const random = mulberry32(1000 + every);
    const pick = list => list[Math.floor(random() * list.length)];
    const accounts = {a: ['USD', 500], b: ['USD', 0], c: ['JPY', 300], d: ['KWD', 0], e: ['USD', 0]};
    const ids = Object.keys(accounts);
    const ledger = createLedger({snapshotEvery: every});
    const open = Object.fromEntries(ids.map(id => [id, []]));
    let holdNo = 0;
    for (const id of ids) ledger.openAccount(id, accounts[id][0], {overdraft: toText(accounts[id][1], accounts[id][0])});
    // Expect success exactly up to available + overdraft.
    const funded = (id, run) => {
      const [currency, overdraft] = accounts[id];
      const limit = toMinor(ledger.balance(id).available, currency) + overdraft;
      const over = random() < 0.3;
      const amount = over ? limit + 1 : random() < 0.3 ? limit : 1 + Math.floor(random() * Math.max(1, limit));
      if (amount < 1) return;
      const text = toText(amount, currency);
      if (amount > limit) assert.throws(() => run(text), {name: 'DomainError', message: 'Insufficient funds in ' + id});
      else run(text);
    };
    for (let step = 0; step < 450; step++) {
      const id = pick(ids);
      const [currency] = accounts[id];
      const roll = random();
      if (roll < 0.25) ledger.deposit(id, toText(1 + Math.floor(random() * 20000), currency));
      else if (roll < 0.40) funded(id, amount => ledger.withdraw(id, amount));
      else if (roll < 0.58) {
        const holdId = 'h' + (++holdNo % 7);
        if (open[id].includes(holdId)) assert.throws(() => ledger.placeHold(id, holdId, '1'), {message: 'Hold ' + holdId + ' already exists'});
        else funded(id, amount => { ledger.placeHold(id, holdId, amount); open[id].push(holdId); });
      } else if (roll < 0.70 && open[id].length) {
        const holdId = open[id].splice(Math.floor(random() * open[id].length), 1)[0];
        ledger.releaseHold(id, holdId);
      } else if (roll < 0.85 && open[id].length) {
        const holdId = open[id].splice(Math.floor(random() * open[id].length), 1)[0];
        const hold = toMinor(ledger.holds(id).find(h => h.holdId === holdId).amount, currency);
        const amount = random() < 0.4 ? hold : 1 + Math.floor(random() * hold);
        ledger.captureHold(id, holdId, toText(amount, currency));
      } else if (roll < 0.94 && currency === 'USD') {
        const to = pick(ids.filter(other => other !== id && accounts[other][0] === 'USD'));
        funded(id, amount => ledger.transfer(id, to, amount));
      } else checkedRebuild(ledger, ids, every);
      for (const other of ids) assert.deepStrictEqual(ledger.holds(other).map(h => h.holdId), [...open[other]].sort(), 'open holds of ' + other);
    }
    checkedRebuild(ledger, ids, every);
    checkedRebuild(ledger, ids, every);
  });
}
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

function swap(source, from, to) {
  if (!source.includes(from)) throw Error('ledger-rebuild: variant pattern not found: ' + from);
  return source.replace(from, to);
}
const variant = files => root => writeTree(root, files);

export default {
  id: 'ledger-rebuild',
  category: 'symptom-only multi-file debugging',
  prompt: 'Bug report from the payments team against acct-ledger 3.4 (this repository). ' +
    '(1) After the deploy-time `ledger.rebuild()`, some balances are wrong. With `snapshotEvery: 5`, an account that received seven USD deposits of 1.00 showed balance 7.00 before the rebuild and 6.00 after it. It only seems to hit accounts with at least `snapshotEvery` events. ' +
    '(2) Also after a rebuild, `held` is sometimes too high: a 40.00 hold that was placed early and released later still counts as held (balance shows held 40.00) after the rebuild, although `holds()` lists nothing. ' +
    '(3) Live, no rebuild involved: after capturing 25.00 of a 40.00 hold, the customer cannot spend what `balance()` reports. balance() says available 75.00, but withdraw(\'75.00\') throws "DomainError: Insufficient funds in acc-2" at requireFunds (src/domain/policies.js) via withdraw (src/commands/cash.js). ' +
    'Expected: the behaviour documented in docs/LEDGER.md and docs/ARCHITECTURE.md, which is correct as written. Find and fix the root causes in src/ so the whole documented API behaves as documented (including what rebuild() returns). ' +
    'Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['acct-ledger 3.4', files]]),
  solve: root => writeTree(root, FIXED),
  verify(root, before) {
    const suite = npm(root, 'test');
    const hidden = hiddenTests(root, HIDDEN);
    let pkg = {};
    try { pkg = JSON.parse(read(root, 'package.json')); } catch {}
    return verdict({
      tests_unchanged: unchanged(before, root, 'test/', {allowAdded: true}),
      no_dependencies: DEPENDENCY_FIELDS.every(field => pkg[field] === undefined),
      suite_passes: suite.status === 0,
      hidden_regressions: hidden.pass,
    }, {suite: (suite.stdout + suite.stderr).slice(-2000), hidden: hidden.output});
  },
  mustReject: [
    // 1. The off-by-one tail read is left in place.
    variant({'src/store/memory-backend.js': BACKEND}),
    // 2. The projection reducer still mutates the shared holds map (snapshots alias live state).
    variant({'src/projection/reducer.js': REDUCER}),
    // 3. Snapshots are cloned when saved but handed out by reference, so a rebuilt state still aliases its snapshot.
    variant({'src/projection/reducer.js': REDUCER, 'src/snapshots/snapshot-store.js': swap(SNAPSHOT_STORE, '{version: state.version, state}', '{version: state.version, state: structuredClone(state)}')}),
    // 4. Rebuild ignores snapshots and replays every stream from its first event.
    variant({'src/rebuild.js': swap(REBUILD, 'snapshots.latest(accountId)?.state ?? EMPTY', 'EMPTY')}),
    // 5. The write-side fold still keeps the uncaptured rest of a hold.
    variant({'src/domain/account.js': ACCOUNT}),
    // 6. The read side made to agree with the buggy write side instead (capture keeps the rest held).
    variant({'src/domain/account.js': ACCOUNT, 'src/projection/reducer.js': swap(REDUCER_FIXED, 'heldMinor: state.heldMinor - holdMinor', 'heldMinor: state.heldMinor - (type === T.HOLD_CAPTURED ? data.amountMinor : holdMinor)')}),
    // 7. A visible test edited.
    variant({'test/ledger.test.js': swap(VISIBLE_LEDGER, "test('overdraft'", "test.skip('overdraft'")}),
  ],
};
