import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Markdown with code spans: '~' stands for a backtick so the docs can live in template literals.
const md = text => text.replaceAll('~', '\x60');

const SHOP_DOC = md(`# stockroom

Order and inventory service of a small web shop. ~createShop()~ in ~src/index.js~ is the only public entry point;
everything runs in memory and synchronously.

## createShop({clock, reservationMinutes})

- ~clock~ is an object whose ~now()~ returns the current time in epoch milliseconds. It defaults to
  ~manualClock('2024-03-01T09:00:00Z')~ from ~src/clock.js~, which only moves when its ~advance(minutes)~ is called.
  The shop never reads the system time.
- ~reservationMinutes~ (a positive integer, default 15) is how long a pending order holds its stock.

## Methods

| Method | Effect |
| --- | --- |
| ~addProduct(sku, {price, stock})~ | Adds a product with ~stock~ units on hand (a non-negative integer, default 0). |
| ~addBundle(sku, {price, components})~ | Adds a bundle: a fixed set of products sold as one item. ~components~ maps product skus to positive integer quantities, e.g. ~{hub: 1, cable: 2}~. |
| ~addCoupon(code, percent)~ | Adds a coupon worth ~percent~ (an integer from 1 to 100) off an order. |
| ~restock(sku, qty)~ | Adds ~qty~ units to the product's on-hand stock. |
| ~placeOrder(orderId, lines, {coupon})~ | Places a pending order; ~lines~ is a non-empty array of ~{sku, qty}~ (products or bundles). Returns the order view. |
| ~pay(orderId)~ | Pays a pending order. Returns the order view. |
| ~cancel(orderId)~ | Cancels a pending order. Returns the order view. |
| ~refund(orderId, lineNo, qty, {restock})~ | Refunds ~qty~ units of line ~lineNo~ (1-based) of a paid order; ~restock~ defaults to ~true~. Returns the amount refunded by this call. |
| ~order(orderId)~ | The order view. |
| ~stock(sku)~ | ~{onHand, reserved, available}~ of a product, as numbers. |

The ~add*~ methods and ~restock~ return ~undefined~. Skus, order ids and coupon codes consist of lower-case letters,
digits and ~-~ and do not start with ~-~. Prices are decimal strings with at most two decimals (~'12.50'~, ~'7'~,
~'0.5'~) and must be positive. Quantities are positive integers. Pricing, discounts and refund amounts are specified in
docs/PRICING.md.

## Stock

Every product has ~onHand~ units (in the warehouse) and ~reserved~ units (held for pending orders);
~available~ is ~onHand - reserved~. Bundles have no stock of their own: ~k~ units of a bundle consist of ~k~ times each
of its components.

- **Reserving.** ~placeOrder~ computes, for every product, the total quantity the order needs of it: a product line counts
  its ~qty~, a bundle line of ~qty~ k counts k times the component quantity. All lines add up, so a product ordered in
  two lines, or directly and as part of a bundle, is checked and reserved once with its total. The order is accepted
  only if every product's total is at most its ~available~; then ~reserved~ grows by the totals. Otherwise it throws
  ~Insufficient stock for <sku>~, naming the first such product in ascending sku order (string comparison), and nothing
  changes: no order is created and no stock is reserved.
- **Paying** moves the order's reserved units out of the shop: ~onHand~ and ~reserved~ both decrease by them.
  Payment never fails for lack of stock.
- **Cancelling** and **expiring** release the order's reserved units: ~reserved~ decreases by them, ~onHand~ is unchanged.
- **Refunding** with ~restock~ (the default) returns the refunded units to ~onHand~: k units of a product line return
  k units of that product, k units of a bundle line return k times each component quantity. Without ~restock~ nothing
  returns. ~restock(sku, qty)~ adds ~qty~ to ~onHand~.

An order's reservation is paid out or released exactly once, and only with the quantities that order reserved. The
catalog never changes: a bundle always consists of the components it was added with, however it has been ordered.

## Orders

An order is ~pending~ when placed and then becomes exactly one of ~paid~ (by ~pay~), ~cancelled~ (by ~cancel~) or
~expired~.

- **Expiry.** An order placed at time t stays pending until ~t + reservationMinutes~ minutes. Before any method of the
  shop runs (the queries ~order~ and ~stock~ included), every pending order whose expiry time is at or before
  ~clock.now()~ becomes ~expired~ and its reservation is released. So paying exactly at the expiry time fails with
  ~Order <id> is expired~. Only pending orders expire; the passing of time never changes paid or cancelled orders or
  the stock they used.
- ~pay~ and ~cancel~ need a pending order and ~refund~ a paid one; otherwise they throw ~Order <id> is <status>~.
- A refunded order stays ~paid~. Each line can be refunded in any number of calls, up to its ~qty~ in total.

## Views

~order(id)~, ~placeOrder~, ~pay~ and ~cancel~ return
~{id, status, coupon, subtotal, discount, total, refunded, lines}~ where ~coupon~ is the coupon code or ~null~,
~refunded~ is the sum of all refunds of the order, and ~lines~ is
~[{lineNo, sku, qty, unitPrice, gross, discount, net, refundedQty, refunded}]~ in the order given to ~placeOrder~
(~refundedQty~ is a number, ~refunded~ the line's refunds so far). Amounts are strings with exactly two decimals
(~'0.00'~, ~'12.50'~). ~refund~ returns such a string.

## Errors

Every rule violation throws ~ShopError~ (~src/errors.js~). Each method validates its arguments in the order listed and
throws the first problem it finds; a method that throws changes nothing.

| Method | Checks, in order |
| --- | --- |
| ~addProduct~ | ~Invalid sku <sku>~, ~Sku <sku> already exists~, ~Invalid price <price>~, ~Invalid quantity <stock>~ |
| ~addBundle~ | ~Invalid sku <sku>~, ~Sku <sku> already exists~, ~Invalid price <price>~, ~Invalid components for <sku>~ (not a non-empty plain object), then per component in ascending sku order: ~Unknown sku <c>~, ~Not a product <c>~, ~Invalid quantity <qty>~ |
| ~addCoupon~ | ~Invalid coupon code <code>~, ~Coupon <code> already exists~, ~Invalid percent <percent>~ |
| ~restock~ | ~Unknown sku <sku>~, ~Not a product <sku>~, ~Invalid quantity <qty>~ |
| ~placeOrder~ | ~Invalid order id <id>~, ~Order <id> already exists~, ~Order <id> has no lines~, then per line in order: ~Unknown sku <sku>~, ~Invalid quantity <qty>~; then ~Unknown coupon <code>~ (only when a coupon is given), then ~Insufficient stock for <sku>~ |
| ~pay~, ~cancel~ | ~Unknown order <id>~, ~Order <id> is <status>~ |
| ~refund~ | ~Unknown order <id>~, ~Order <id> is <status>~, ~Unknown line <lineNo> in <id>~, ~Invalid quantity <qty>~, ~Refund exceeds line <lineNo> of <id>~ (more than the line's not yet refunded units) |
| ~order~ | ~Unknown order <id>~ |
| ~stock~ | ~Unknown sku <sku>~, ~Not a product <sku>~ |
`);

const PRICING_DOC = md(`# Pricing

All amounts are integers of cents internally and strings with two decimals in views.

## Lines and totals

A line's ~unitPrice~ is the catalog price of its sku (products and bundles have their own prices) and its ~gross~ is
~unitPrice * qty~. The order's ~subtotal~ is the sum of the gross amounts.

## Discount

Without a coupon the discount is 0. With a coupon of p percent, the order's ~discount~ is ~subtotal * p / 100~ rounded
half up to whole cents. ~total~ is ~subtotal - discount~.

## Allocating the discount to lines

The discount is split over the lines in proportion to their gross amounts, by the largest remainder method:

1. A line's exact share is ~discount * gross / subtotal~ (a fraction of cents).
2. Every line first gets its exact share rounded down to whole cents.
3. The cents still missing (the discount minus the sum of the rounded-down shares; always fewer than the number of
   lines) are given out one cent each to the lines with the largest fractional parts of their exact shares. Between
   lines whose fractional parts are equal, the lower ~lineNo~ comes first.

The line's ~discount~ is its share and its ~net~ is ~gross - discount~. The line discounts add up to the order's
discount and the nets to its total.

Example: three lines with gross 10.00 each and a discount of 1.00. Each exact share is 33⅓ cents; rounding down gives
0.33 + 0.33 + 0.33 = 0.99, and the missing cent goes to line 1 (equal fractional parts): discounts 0.34, 0.33, 0.33.

Example: gross 6.00 and 4.00, discount 0.25. Exact shares are 15 and 10 cents: no cent is missing; discounts 0.15 and 0.10.

## Refunds

Refunds pay back net amounts. Refunding k more units of a line with ~qty~ n and ~net~ N, of which r units were refunded
before, pays back

    floor(N * (r + k) / n) - floor(N * r / n)

cents. So the refunds of a line always add up to exactly ~floor(N * refundedQty / n)~, and refunding all of a line, in
any number of calls, pays back exactly its net; refunding every line of an order completely pays back exactly its total.

Example: a line of 3 units with net 10.00. Refunding one unit at a time pays 3.33, 3.33 and 3.34; refunding 2 units and
then 1 pays 6.66 and 3.34.
`);

const ARCH_DOC = md(`# Architecture

- ~src/index.js~ wires the modules into the public API and runs the expiry sweep (~src/orders/expire.js~) before
  every method.
- ~src/catalog/~: the ~Catalog~ of products and bundles. ~Catalog.expand(sku, qty)~ turns k units of a sku into the
  products they consist of, as a parts list ~[{sku, qty}]~.
- ~src/inventory/~: ~Stock~ (on-hand and reserved numbers), ~Reservations~ (the parts each order holds, and their
  lifecycle) and ~mergeParts~, which combines parts lists into one entry per product.
- ~src/pricing/~: pricing of orders, the discount allocation and refund amounts (docs/PRICING.md).
- ~src/orders/~: the order commands, the order store, the expiry sweep and the order view.

A reservation is ~held~ from ~placeOrder~ until it is either ~committed~ (the order was paid) or ~released~ (the order was
cancelled or expired). Reservations stay in memory afterwards as an audit trail.

Parts lists returned by ~Catalog.expand~ may be shared with the catalog; nothing may modify them or their entries.
`);

const README = md(`# stockroom

Order and inventory service. See docs/SHOP.md for the API, docs/PRICING.md for amounts and docs/ARCHITECTURE.md for
the internals.

    npm test
`);

const PKG = JSON.stringify({name: 'stockroom', version: '2.7.0', private: true, type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n';

const ERRORS = String.raw`/** Every rule violation of the shop throws a ShopError; the messages are listed in docs/SHOP.md. */
export class ShopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShopError';
  }
}
`;

const CLOCK = String.raw`/** A clock that moves only when told to; the shop never reads the system time. */
export function manualClock(start) {
  let now = Date.parse(start);
  return {
    now: () => now,
    /** Move forward by a number of minutes (fractions allowed). */
    advance(minutes) {
      now += Math.round(minutes * 60000);
    },
  };
}
`;

const MONEY = String.raw`import {ShopError} from './errors.js';

const PRICE = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/** A price string ('12.50', '7', '0.5') as integer cents; prices are positive. */
export function parsePrice(text) {
  if (typeof text !== 'string' || !PRICE.test(text)) throw new ShopError('Invalid price ' + text);
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents === 0) throw new ShopError('Invalid price ' + text);
  return cents;
}

/** Non-negative integer cents as '12.50'. */
export const formatCents = cents => Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0');
`;

const IDS = String.raw`import {ShopError} from './errors.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Skus, order ids and coupon codes: lower-case letters, digits and '-', not starting with '-'. */
export function checkId(kind, value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new ShopError('Invalid ' + kind + ' ' + value);
  return value;
}

/** Quantities are positive safe integers. */
export function checkQuantity(qty) {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new ShopError('Invalid quantity ' + qty);
  return qty;
}
`;

const COUPONS = String.raw`import {ShopError} from './errors.js';
import {checkId} from './ids.js';

/** Coupon codes and their percentages. */
export class Coupons {
  #percent = new Map();

  add(code, percent) {
    checkId('coupon code', code);
    if (this.#percent.has(code)) throw new ShopError('Coupon ' + code + ' already exists');
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new ShopError('Invalid percent ' + percent);
    this.#percent.set(code, percent);
  }

  percent(code) {
    if (!this.#percent.has(code)) throw new ShopError('Unknown coupon ' + code);
    return this.#percent.get(code);
  }
}
`;

const CATALOG = String.raw`import {ShopError} from '../errors.js';
import {checkId} from '../ids.js';

/**
 * Products (stocked items) and bundles (fixed sets of products sold as one item, without stock of their own).
 * Items are never changed or removed once added.
 */
export class Catalog {
  #items = new Map();

  /** Throws unless sku is a valid sku that is not taken yet. */
  claim(sku) {
    checkId('sku', sku);
    if (this.#items.has(sku)) throw new ShopError('Sku ' + sku + ' already exists');
  }

  addProduct(sku, priceCents) {
    this.#items.set(sku, Object.freeze({kind: 'product', sku, priceCents}));
  }

  /** parts: [{sku, qty}] sorted by sku, one entry per product (see components.js). */
  addBundle(sku, priceCents, parts) {
    this.#items.set(sku, Object.freeze({kind: 'bundle', sku, priceCents, parts}));
  }

  get(sku) {
    const item = this.#items.get(sku);
    if (!item) throw new ShopError('Unknown sku ' + sku);
    return item;
  }

  product(sku) {
    const item = this.get(sku);
    if (item.kind !== 'product') throw new ShopError('Not a product ' + sku);
    return item;
  }

  /**
   * The products that qty units of sku consist of, as parts [{sku, qty}] sorted by sku: the product itself, or each
   * part of the bundle times qty. One unit of a bundle is its stored parts list, so callers must not modify the result.
   */
  expand(sku, qty) {
    const item = this.get(sku);
    if (item.kind === 'product') return [{sku, qty}];
    if (qty === 1) return item.parts;
    return item.parts.map(part => ({sku: part.sku, qty: part.qty * qty}));
  }
}
`;

const COMPONENTS = String.raw`import {ShopError} from '../errors.js';
import {checkQuantity} from '../ids.js';

/**
 * Validate a bundle's components ({productSku: qty}) and return them as parts [{sku, qty}] sorted by sku.
 * Every component must be an existing product (not a bundle) and every qty a positive integer.
 */
export function toParts(bundleSku, components, catalog) {
  if (components === null || typeof components !== 'object' || Array.isArray(components) || Object.keys(components).length === 0) {
    throw new ShopError('Invalid components for ' + bundleSku);
  }
  return Object.keys(components).sort().map(sku => {
    catalog.product(sku);
    return {sku, qty: checkQuantity(components[sku])};
  });
}
`;

const STOCK = String.raw`import {ShopError} from '../errors.js';

/**
 * On-hand and reserved units of every product. The methods take parts lists [{sku, qty}] with one entry per product,
 * sorted by sku (see merge.js), and change all of them or, when they throw, none.
 */
export class Stock {
  #onHand = new Map();
  #reserved = new Map();

  add(sku, onHand) {
    this.#onHand.set(sku, onHand);
    this.#reserved.set(sku, 0);
  }

  view(sku) {
    const onHand = this.#onHand.get(sku);
    const reserved = this.#reserved.get(sku);
    return {onHand, reserved, available: onHand - reserved};
  }

  reserve(parts) {
    for (const {sku, qty} of parts) {
      if (qty > this.view(sku).available) throw new ShopError('Insufficient stock for ' + sku);
    }
    for (const {sku, qty} of parts) this.#reserved.set(sku, this.#reserved.get(sku) + qty);
  }

  /** Reserved units become available again. */
  release(parts) {
    for (const {sku, qty} of parts) this.#reserved.set(sku, this.#reserved.get(sku) - qty);
  }

  /** Reserved units leave the shop (the order was paid). */
  commit(parts) {
    for (const {sku, qty} of parts) {
      this.#onHand.set(sku, this.#onHand.get(sku) - qty);
      this.#reserved.set(sku, this.#reserved.get(sku) - qty);
    }
  }

  /** Units come (back) into the shop. */
  restock(parts) {
    for (const {sku, qty} of parts) this.#onHand.set(sku, this.#onHand.get(sku) + qty);
  }
}
`;

const MERGE = String.raw`/** Combine a parts list into one entry per product with the summed qty, sorted by sku. */
export function mergeParts(parts) {
  const bySku = new Map();
  for (const part of parts) {
    const seen = bySku.get(part.sku);
    if (seen) seen.qty += part.qty;
    else bySku.set(part.sku, part);
  }
  return [...bySku.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}
`;

const RESERVATIONS = String.raw`/**
 * The stock held for each order. A reservation is 'held' from placeOrder until it is either 'committed' (the order
 * was paid) or 'released' (cancelled or expired). Reservations are kept afterwards as an audit trail.
 */
export class Reservations {
  #stock;
  #all = new Map();

  constructor(stock) {
    this.#stock = stock;
  }

  hold(orderId, parts, expiresAt) {
    this.#stock.reserve(parts);
    this.#all.set(orderId, {orderId, parts, expiresAt, state: 'held'});
  }

  commit(orderId) {
    const reservation = this.#held(orderId);
    this.#stock.commit(reservation.parts);
    reservation.state = 'committed';
  }

  release(orderId) {
    const reservation = this.#held(orderId);
    this.#stock.release(reservation.parts);
    reservation.state = 'released';
  }

  /** Release the reservations whose expiry time is at or before now; returns their order ids, earliest expiry first. */
  expire(now) {
    const due = [...this.#all.values()]
      .filter(reservation => reservation.state !== 'released' && reservation.expiresAt <= now)
      .sort((a, b) => a.expiresAt - b.expiresAt);
    for (const reservation of due) {
      this.#stock.release(reservation.parts);
      reservation.state = 'released';
    }
    return due.map(reservation => reservation.orderId);
  }

  get(orderId) {
    return this.#all.get(orderId);
  }

  #held(orderId) {
    const reservation = this.#all.get(orderId);
    if (reservation?.state !== 'held') throw new Error('No held reservation for ' + orderId);
    return reservation;
  }
}
`;

const ALLOCATE = String.raw`/**
 * Split total (a non-negative integer) into integer shares proportional to weights (non-negative integers with a
 * positive sum). The shares add up to total; see docs/PRICING.md.
 */
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map(weight => Math.floor(total * weight / sum));
  let missing = total - shares.reduce((a, b) => a + b, 0);
  // Hand out the cents lost to rounding down, biggest lines first.
  const order = weights.map((_, i) => i).sort((a, b) => weights[b] - weights[a] || a - b);
  for (const i of order) {
    if (missing === 0) break;
    shares[i] += 1;
    missing -= 1;
  }
  return shares;
}
`;

const PRICE_ORDER = String.raw`import {allocate} from './allocate.js';

/** percent % of cents, rounded half up to whole cents. */
export const percentOf = (cents, percent) => Math.floor((cents * percent + 50) / 100);

/**
 * Price the lines ([{sku, qty}]) of an order at catalog prices with a coupon percentage (0 for none); see
 * docs/PRICING.md. Returns {lines, subtotalCents, discountCents, totalCents}.
 */
export function priceOrder(lines, catalog, percent) {
  const priced = lines.map(({sku, qty}, i) => {
    const unitCents = catalog.get(sku).priceCents;
    return {lineNo: i + 1, sku, qty, unitCents, grossCents: unitCents * qty};
  });
  const subtotalCents = priced.reduce((sum, line) => sum + line.grossCents, 0);
  const discountCents = percentOf(subtotalCents, percent);
  const shares = allocate(discountCents, priced.map(line => line.grossCents));
  for (const [i, line] of priced.entries()) {
    line.discountCents = shares[i];
    line.netCents = line.grossCents - shares[i];
    line.refundedQty = 0;
    line.refundedCents = 0;
  }
  return {lines: priced, subtotalCents, discountCents, totalCents: subtotalCents - discountCents};
}
`;

const REFUND_AMOUNT = String.raw`/** Cents to pay back for refunding units more units of a priced line; see docs/PRICING.md (Refunds). */
export function refundAmount(line, units) {
  return Math.round(line.netCents * units / line.qty);
}
`;

const ORDER_STORE = String.raw`import {ShopError} from '../errors.js';

export class OrderStore {
  #orders = new Map();

  has(orderId) {
    return this.#orders.has(orderId);
  }

  add(order) {
    this.#orders.set(order.id, order);
  }

  get(orderId) {
    const order = this.#orders.get(orderId);
    if (!order) throw new ShopError('Unknown order ' + orderId);
    return order;
  }
}
`;

const STATUS = String.raw`import {ShopError} from '../errors.js';

/** Orders go pending -> paid | cancelled | expired; see docs/SHOP.md. */
export function requireStatus(order, status) {
  if (order.status !== status) throw new ShopError('Order ' + order.id + ' is ' + order.status);
}
`;

const PLACE = String.raw`import {ShopError} from '../errors.js';
import {checkId, checkQuantity} from '../ids.js';
import {mergeParts} from '../inventory/merge.js';
import {priceOrder} from '../pricing/price-order.js';

/** Validate, price and reserve a new order; docs/SHOP.md lists the checks in order. */
export function placeOrder(ctx, orderId, lines, {coupon} = {}) {
  checkId('order id', orderId);
  if (ctx.orders.has(orderId)) throw new ShopError('Order ' + orderId + ' already exists');
  if (!Array.isArray(lines) || lines.length === 0) throw new ShopError('Order ' + orderId + ' has no lines');
  for (const {sku, qty} of lines) {
    ctx.catalog.get(sku);
    checkQuantity(qty);
  }
  const percent = coupon === undefined ? 0 : ctx.coupons.percent(coupon);
  const parts = mergeParts(lines.flatMap(({sku, qty}) => ctx.catalog.expand(sku, qty)));
  const now = ctx.clock.now();
  ctx.reservations.hold(orderId, parts, now + ctx.reservationMinutes * 60000);
  const order = {id: orderId, status: 'pending', coupon: coupon ?? null, placedAt: now, refundedCents: 0, ...priceOrder(lines, ctx.catalog, percent)};
  ctx.orders.add(order);
  return order;
}
`;

const PAY = String.raw`import {requireStatus} from './status.js';

export function pay(ctx, orderId) {
  const order = ctx.orders.get(orderId);
  requireStatus(order, 'pending');
  ctx.reservations.commit(orderId);
  order.status = 'paid';
  return order;
}
`;

const CANCEL = String.raw`import {requireStatus} from './status.js';

export function cancel(ctx, orderId) {
  const order = ctx.orders.get(orderId);
  requireStatus(order, 'pending');
  ctx.reservations.release(orderId);
  order.status = 'cancelled';
  return order;
}
`;

const REFUND = String.raw`import {ShopError} from '../errors.js';
import {checkQuantity} from '../ids.js';
import {formatCents} from '../money.js';
import {refundAmount} from '../pricing/refund-amount.js';
import {requireStatus} from './status.js';

/** Refund qty units of a line of a paid order; returns the amount paid back by this call. */
export function refund(ctx, orderId, lineNo, qty, {restock = true} = {}) {
  const order = ctx.orders.get(orderId);
  requireStatus(order, 'paid');
  const line = order.lines.find(candidate => candidate.lineNo === lineNo);
  if (!line) throw new ShopError('Unknown line ' + lineNo + ' in ' + orderId);
  checkQuantity(qty);
  if (qty > line.qty - line.refundedQty) throw new ShopError('Refund exceeds line ' + lineNo + ' of ' + orderId);
  const cents = refundAmount(line, qty);
  line.refundedQty += qty;
  line.refundedCents += cents;
  order.refundedCents += cents;
  if (restock) ctx.stock.restock(ctx.catalog.expand(line.sku, qty));
  return formatCents(cents);
}
`;

const EXPIRE = String.raw`/** Expire every pending order whose reservation time is over; see docs/SHOP.md (Orders). */
export function expireOrders(ctx) {
  for (const orderId of ctx.reservations.expire(ctx.clock.now())) {
    const order = ctx.orders.get(orderId);
    if (order.status === 'pending') order.status = 'expired';
  }
}
`;

const VIEW = String.raw`import {formatCents} from '../money.js';

/** The public view of an order; see docs/SHOP.md (Views). */
export function orderView(order) {
  return {
    id: order.id,
    status: order.status,
    coupon: order.coupon,
    subtotal: formatCents(order.subtotalCents),
    discount: formatCents(order.discountCents),
    total: formatCents(order.totalCents),
    refunded: formatCents(order.refundedCents),
    lines: order.lines.map(line => ({
      lineNo: line.lineNo,
      sku: line.sku,
      qty: line.qty,
      unitPrice: formatCents(line.unitCents),
      gross: formatCents(line.grossCents),
      discount: formatCents(line.discountCents),
      net: formatCents(line.netCents),
      refundedQty: line.refundedQty,
      refunded: formatCents(line.refundedCents),
    })),
  };
}
`;

const INDEX = String.raw`import {Catalog} from './catalog/catalog.js';
import {toParts} from './catalog/components.js';
import {manualClock} from './clock.js';
import {Coupons} from './coupons.js';
import {ShopError} from './errors.js';
import {checkQuantity} from './ids.js';
import {Reservations} from './inventory/reservations.js';
import {Stock} from './inventory/stock.js';
import {parsePrice} from './money.js';
import {cancel} from './orders/cancel.js';
import {expireOrders} from './orders/expire.js';
import {OrderStore} from './orders/order-store.js';
import {pay} from './orders/pay.js';
import {placeOrder} from './orders/place.js';
import {refund} from './orders/refund.js';
import {orderView} from './orders/view.js';

/** The public API; see docs/SHOP.md. */
export function createShop({clock = manualClock('2024-03-01T09:00:00Z'), reservationMinutes = 15} = {}) {
  if (!Number.isInteger(reservationMinutes) || reservationMinutes < 1) throw new RangeError('reservationMinutes must be a positive integer');
  const stock = new Stock();
  const ctx = {clock, reservationMinutes, stock, catalog: new Catalog(), coupons: new Coupons(), reservations: new Reservations(stock), orders: new OrderStore()};
  const api = {
    addProduct(sku, {price, stock: onHand = 0} = {}) {
      ctx.catalog.claim(sku);
      const priceCents = parsePrice(price);
      if (!Number.isSafeInteger(onHand) || onHand < 0) throw new ShopError('Invalid quantity ' + onHand);
      ctx.catalog.addProduct(sku, priceCents);
      stock.add(sku, onHand);
    },
    addBundle(sku, {price, components} = {}) {
      ctx.catalog.claim(sku);
      const priceCents = parsePrice(price);
      ctx.catalog.addBundle(sku, priceCents, toParts(sku, components, ctx.catalog));
    },
    addCoupon(code, percent) {
      ctx.coupons.add(code, percent);
    },
    restock(sku, qty) {
      ctx.catalog.product(sku);
      stock.restock([{sku, qty: checkQuantity(qty)}]);
    },
    placeOrder: (orderId, lines, options) => orderView(placeOrder(ctx, orderId, lines, options)),
    pay: orderId => orderView(pay(ctx, orderId)),
    cancel: orderId => orderView(cancel(ctx, orderId)),
    refund: (orderId, lineNo, qty, options) => refund(ctx, orderId, lineNo, qty, options),
    order: orderId => orderView(ctx.orders.get(orderId)),
    stock(sku) {
      ctx.catalog.product(sku);
      return stock.view(sku);
    },
  };
  // Expiry is lazy: every call first expires what is due (docs/SHOP.md, Orders).
  return Object.fromEntries(Object.entries(api).map(([name, method]) => [name, (...args) => {
    expireOrders(ctx);
    return method(...args);
  }]));
}
`;

const VISIBLE_SHOP = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {manualClock} from '../src/clock.js';
import {createShop} from '../src/index.js';

const fresh = () => {
  const clock = manualClock('2024-03-01T09:00:00Z');
  const shop = createShop({clock});
  shop.addProduct('widget', {price: '4.00', stock: 5});
  shop.addProduct('hub', {price: '20.00', stock: 10});
  shop.addProduct('cable', {price: '3.00', stock: 40});
  shop.addBundle('starter-kit', {price: '24.00', components: {hub: 1, cable: 2}});
  shop.addProduct('mug', {price: '10.00', stock: 8});
  shop.addCoupon('ten', 10);
  return {clock, shop};
};

test('placing and paying an order', () => {
  const {shop} = fresh();
  const view = shop.placeOrder('o1', [{sku: 'widget', qty: 2}]);
  assert.deepEqual(view, {id: 'o1', status: 'pending', coupon: null, subtotal: '8.00', discount: '0.00', total: '8.00', refunded: '0.00',
    lines: [{lineNo: 1, sku: 'widget', qty: 2, unitPrice: '4.00', gross: '8.00', discount: '0.00', net: '8.00', refundedQty: 0, refunded: '0.00'}]});
  assert.deepEqual(shop.stock('widget'), {onHand: 5, reserved: 2, available: 3});
  assert.equal(shop.pay('o1').status, 'paid');
  assert.deepEqual(shop.stock('widget'), {onHand: 3, reserved: 0, available: 3});
});

test('cancelling releases the reservation', () => {
  const {shop} = fresh();
  shop.placeOrder('o1', [{sku: 'widget', qty: 5}]);
  assert.equal(shop.cancel('o1').status, 'cancelled');
  assert.deepEqual(shop.stock('widget'), {onHand: 5, reserved: 0, available: 5});
  assert.throws(() => shop.pay('o1'), {name: 'ShopError', message: 'Order o1 is cancelled'});
});

test('unpaid orders expire', () => {
  const {clock, shop} = fresh();
  shop.placeOrder('o1', [{sku: 'widget', qty: 4}]);
  clock.advance(15);
  assert.equal(shop.order('o1').status, 'expired');
  assert.deepEqual(shop.stock('widget'), {onHand: 5, reserved: 0, available: 5});
  assert.throws(() => shop.pay('o1'), {message: 'Order o1 is expired'});
});

test('bundles reserve their components', () => {
  const {shop} = fresh();
  shop.placeOrder('o1', [{sku: 'starter-kit', qty: 2}]);
  assert.deepEqual(shop.stock('hub'), {onHand: 10, reserved: 2, available: 8});
  assert.deepEqual(shop.stock('cable'), {onHand: 40, reserved: 4, available: 36});
  shop.pay('o1');
  assert.deepEqual(shop.stock('cable'), {onHand: 36, reserved: 0, available: 36});
  assert.throws(() => shop.stock('starter-kit'), {message: 'Not a product starter-kit'});
});

test('coupons and refunds', () => {
  const {shop} = fresh();
  const view = shop.placeOrder('o1', [{sku: 'mug', qty: 2}], {coupon: 'ten'});
  assert.deepEqual([view.subtotal, view.discount, view.total, view.lines[0].net], ['20.00', '2.00', '18.00', '18.00']);
  shop.pay('o1');
  assert.equal(shop.refund('o1', 1, 1), '9.00');
  assert.deepEqual(shop.stock('mug'), {onHand: 7, reserved: 0, available: 7});
  assert.equal(shop.refund('o1', 1, 1, {restock: false}), '9.00');
  assert.deepEqual(shop.stock('mug'), {onHand: 7, reserved: 0, available: 7});
  assert.equal(shop.order('o1').refunded, '18.00');
  assert.throws(() => shop.refund('o1', 1, 1), {message: 'Refund exceeds line 1 of o1'});
});

test('insufficient stock changes nothing', () => {
  const {shop} = fresh();
  assert.throws(() => shop.placeOrder('o1', [{sku: 'mug', qty: 1}, {sku: 'widget', qty: 6}]), {message: 'Insufficient stock for widget'});
  assert.throws(() => shop.order('o1'), {message: 'Unknown order o1'});
  assert.deepEqual(shop.stock('mug'), {onHand: 8, reserved: 0, available: 8});
});
`;

const VISIBLE_MONEY = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {formatCents, parsePrice} from '../src/money.js';

test('parse', () => {
  assert.equal(parsePrice('12.50'), 1250);
  assert.equal(parsePrice('7'), 700);
  assert.equal(parsePrice('0.5'), 50);
  for (const bad of ['0', '0.00', '-1', '1.234', '01', '1.', '', ' 1']) assert.throws(() => parsePrice(bad), {message: 'Invalid price ' + bad});
});

test('format', () => {
  assert.equal(formatCents(1250), '12.50');
  assert.equal(formatCents(7), '0.07');
  assert.equal(formatCents(0), '0.00');
});
`;

const files = {
  'package.json': PKG,
  'README.md': README,
  'docs/SHOP.md': SHOP_DOC,
  'docs/PRICING.md': PRICING_DOC,
  'docs/ARCHITECTURE.md': ARCH_DOC,
  'src/index.js': INDEX,
  'src/errors.js': ERRORS,
  'src/clock.js': CLOCK,
  'src/money.js': MONEY,
  'src/ids.js': IDS,
  'src/coupons.js': COUPONS,
  'src/catalog/catalog.js': CATALOG,
  'src/catalog/components.js': COMPONENTS,
  'src/inventory/stock.js': STOCK,
  'src/inventory/merge.js': MERGE,
  'src/inventory/reservations.js': RESERVATIONS,
  'src/pricing/allocate.js': ALLOCATE,
  'src/pricing/price-order.js': PRICE_ORDER,
  'src/pricing/refund-amount.js': REFUND_AMOUNT,
  'src/orders/order-store.js': ORDER_STORE,
  'src/orders/status.js': STATUS,
  'src/orders/place.js': PLACE,
  'src/orders/pay.js': PAY,
  'src/orders/cancel.js': CANCEL,
  'src/orders/refund.js': REFUND,
  'src/orders/expire.js': EXPIRE,
  'src/orders/view.js': VIEW,
  'test/shop.test.js': VISIBLE_SHOP,
  'test/money.test.js': VISIBLE_MONEY,
};

function swap(source, from, to) {
  if (!source.includes(from)) throw Error('shop-oversell: variant pattern not found: ' + from);
  return source.replace(from, to);
}

const RESERVATIONS_FIXED = swap(swap(RESERVATIONS, "reservation.state !== 'released'", "reservation.state === 'held'"),
  'Release the reservations whose', 'Release the held reservations whose');
const MERGE_FIXED = swap(MERGE, 'else bySku.set(part.sku, part);', 'else bySku.set(part.sku, {sku: part.sku, qty: part.qty});');
const ALLOCATE_FIXED = String.raw`/**
 * Split total (a non-negative integer) into integer shares proportional to weights (non-negative integers with a
 * positive sum) by the largest remainder method. The shares add up to total; see docs/PRICING.md.
 */
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map(weight => Math.floor(total * weight / sum));
  const missing = total - shares.reduce((a, b) => a + b, 0);
  // Exact share = total * weight / sum; its fractional part is (total * weight % sum) / sum. Ties: lower index first.
  const order = weights.map((_, i) => i).sort((a, b) => (total * weights[b]) % sum - (total * weights[a]) % sum || a - b);
  for (const i of order.slice(0, missing)) shares[i] += 1;
  return shares;
}
`;
const REFUND_AMOUNT_FIXED = String.raw`/** Cents to pay back for refunding units more units of a priced line; see docs/PRICING.md (Refunds). */
export function refundAmount(line, units) {
  const paidBackAfter = refunded => Math.floor(line.netCents * refunded / line.qty);
  return paidBackAfter(line.refundedQty + units) - paidBackAfter(line.refundedQty);
}
`;

const FIXED = {
  'src/inventory/reservations.js': RESERVATIONS_FIXED,
  'src/inventory/merge.js': MERGE_FIXED,
  'src/pricing/allocate.js': ALLOCATE_FIXED,
  'src/pricing/refund-amount.js': REFUND_AMOUNT_FIXED,
};

const HIDDEN = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
const {createShop} = await import('@ROOT@src/index.js');
const {manualClock} = await import('@ROOT@src/clock.js');

const START = '2024-03-01T09:00:00Z';
const fresh = (reservationMinutes = 15) => {
  const clock = manualClock(START);
  return {clock, shop: createShop({clock, reservationMinutes})};
};
const err = message => ({name: 'ShopError', message});
const stockOf = (shop, sku) => shop.stock(sku);

test('report 1: a paid order stays sold after its reservation time', () => {
  const {clock, shop} = fresh();
  shop.addProduct('widget', {price: '4.00', stock: 3});
  shop.placeOrder('o-100', [{sku: 'widget', qty: 3}]);
  shop.pay('o-100');
  assert.deepEqual(stockOf(shop, 'widget'), {onHand: 0, reserved: 0, available: 0});
  clock.advance(20);
  assert.deepEqual(stockOf(shop, 'widget'), {onHand: 0, reserved: 0, available: 0});
  assert.throws(() => shop.placeOrder('o-101', [{sku: 'widget', qty: 3}]), err('Insufficient stock for widget'));
  assert.equal(shop.order('o-100').status, 'paid');
});

test('paid orders do not release stock held by other pending orders', () => {
  const {clock, shop} = fresh();
  shop.addProduct('widget', {price: '4.00', stock: 10});
  shop.placeOrder('a', [{sku: 'widget', qty: 3}]);
  shop.pay('a');
  clock.advance(5);
  shop.placeOrder('b', [{sku: 'widget', qty: 2}]);
  clock.advance(11);
  assert.deepEqual(stockOf(shop, 'widget'), {onHand: 7, reserved: 2, available: 5});
  clock.advance(4);
  assert.equal(shop.order('b').status, 'expired');
  assert.deepEqual(stockOf(shop, 'widget'), {onHand: 7, reserved: 0, available: 7});
  assert.throws(() => shop.pay('b'), err('Order b is expired'));
  clock.advance(600);
  assert.deepEqual(stockOf(shop, 'widget'), {onHand: 7, reserved: 0, available: 7});
});

test('expiry boundary and custom reservation time', () => {
  const {clock, shop} = fresh(30);
  shop.addProduct('widget', {price: '4.00', stock: 10});
  shop.placeOrder('late', [{sku: 'widget', qty: 1}]);
  shop.placeOrder('early', [{sku: 'widget', qty: 2}]);
  clock.advance(29.999);
  assert.equal(shop.pay('early').status, 'paid');
  clock.advance(0.001);
  assert.throws(() => shop.pay('late'), err('Order late is expired'));
  assert.deepEqual(stockOf(shop, 'widget'), {onHand: 8, reserved: 0, available: 8});
  clock.advance(60);
  assert.deepEqual(stockOf(shop, 'widget'), {onHand: 8, reserved: 0, available: 8});
});

test('cancelled orders and refunds of paid orders are unaffected by time', () => {
  const {clock, shop} = fresh();
  shop.addProduct('widget', {price: '4.00', stock: 5});
  shop.placeOrder('c', [{sku: 'widget', qty: 2}]);
  shop.cancel('c');
  shop.placeOrder('p', [{sku: 'widget', qty: 2}]);
  shop.pay('p');
  clock.advance(30);
  assert.deepEqual(stockOf(shop, 'widget'), {onHand: 3, reserved: 0, available: 3});
  assert.equal(shop.refund('p', 1, 1), '4.00');
  clock.advance(30);
  assert.deepEqual(stockOf(shop, 'widget'), {onHand: 4, reserved: 0, available: 4});
  assert.deepEqual([shop.order('c').status, shop.order('p').status], ['cancelled', 'paid']);
});

const kitShop = () => {
  const {clock, shop} = fresh();
  shop.addProduct('hub', {price: '20.00', stock: 10});
  shop.addProduct('cable', {price: '3.00', stock: 40});
  shop.addBundle('starter-kit', {price: '24.00', components: {hub: 1, cable: 2}});
  return {clock, shop};
};

test('report 2: kit plus extra cable', () => {
  const {shop} = kitShop();
  shop.placeOrder('o-200', [{sku: 'starter-kit', qty: 1}]);
  shop.placeOrder('o-201', [{sku: 'starter-kit', qty: 1}, {sku: 'cable', qty: 1}]);
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 40, reserved: 5, available: 35});
  shop.pay('o-200');
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 38, reserved: 3, available: 35});
  shop.pay('o-201');
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 35, reserved: 0, available: 35});
  assert.deepEqual(stockOf(shop, 'hub'), {onHand: 8, reserved: 0, available: 8});
  shop.placeOrder('o-202', [{sku: 'starter-kit', qty: 1}]);
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 35, reserved: 2, available: 33});
  assert.deepEqual(stockOf(shop, 'hub'), {onHand: 8, reserved: 1, available: 7});
});

test('two kit lines in one order, then kit refunds with restock', () => {
  const {shop} = kitShop();
  shop.placeOrder('a', [{sku: 'starter-kit', qty: 1}, {sku: 'starter-kit', qty: 1}, {sku: 'hub', qty: 1}]);
  assert.deepEqual(stockOf(shop, 'hub'), {onHand: 10, reserved: 3, available: 7});
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 40, reserved: 4, available: 36});
  shop.pay('a');
  shop.placeOrder('b', [{sku: 'starter-kit', qty: 1}]);
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 36, reserved: 2, available: 34});
  shop.pay('b');
  assert.equal(shop.refund('a', 2, 1), '24.00');
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 36, reserved: 0, available: 36});
  assert.deepEqual(stockOf(shop, 'hub'), {onHand: 7, reserved: 0, available: 7});
  shop.placeOrder('c', [{sku: 'starter-kit', qty: 3}]);
  shop.pay('c');
  shop.refund('c', 1, 2);
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 34, reserved: 0, available: 34});
  shop.refund('c', 1, 1, {restock: false});
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 34, reserved: 0, available: 34});
  assert.deepEqual(stockOf(shop, 'hub'), {onHand: 6, reserved: 0, available: 6});
});

test('a rejected kit order leaves the bundle unchanged', () => {
  const {shop} = kitShop();
  shop.restock('cable', 1);
  assert.throws(() => shop.placeOrder('x', [{sku: 'cable', qty: 2}, {sku: 'starter-kit', qty: 1}, {sku: 'hub', qty: 10}]), err('Insufficient stock for hub'));
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 41, reserved: 0, available: 41});
  shop.placeOrder('y', [{sku: 'starter-kit', qty: 1}]);
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 41, reserved: 2, available: 39});
  assert.throws(() => shop.placeOrder('z', [{sku: 'cable', qty: 38}, {sku: 'starter-kit', qty: 1}]), err('Insufficient stock for cable'));
  shop.placeOrder('w', [{sku: 'cable', qty: 37}, {sku: 'starter-kit', qty: 1}]);
  assert.deepEqual(stockOf(shop, 'cable'), {onHand: 41, reserved: 41, available: 0});
});

const lampShop = () => {
  const {clock, shop} = fresh();
  for (const [sku, price] of [['lamp', '12.99'], ['shade', '7.45'], ['bulb', '3.50'], ['ten', '10.00'], ['six', '6.00'], ['four', '4.00']]) {
    shop.addProduct(sku, {price, stock: 100});
  }
  shop.addCoupon('save15', 15);
  shop.addCoupon('five', 5);
  shop.addCoupon('half', 50);
  shop.addCoupon('all', 100);
  shop.addCoupon('three', 3);
  return {clock, shop};
};
const discounts = view => view.lines.map(line => line.discount);
const nets = view => view.lines.map(line => line.net);

test('report 3: largest remainder allocation', () => {
  const {shop} = lampShop();
  const view = shop.placeOrder('o-300', [{sku: 'lamp', qty: 2}, {sku: 'shade', qty: 1}, {sku: 'bulb', qty: 3}], {coupon: 'save15'});
  assert.deepEqual([view.subtotal, view.discount, view.total], ['43.93', '6.59', '37.34']);
  assert.deepEqual(discounts(view), ['3.90', '1.12', '1.57']);
  assert.deepEqual(nets(view), ['22.08', '6.33', '8.93']);
});

test('allocation examples and ties', () => {
  const {shop} = lampShop();
  let view = shop.placeOrder('t1', [{sku: 'ten', qty: 1}, {sku: 'ten', qty: 1}, {sku: 'ten', qty: 1}], {coupon: 'three'});
  assert.deepEqual(discounts(view), ['0.30', '0.30', '0.30']);
  view = shop.placeOrder('t2', [{sku: 'bulb', qty: 1}, {sku: 'bulb', qty: 1}, {sku: 'bulb', qty: 1}], {coupon: 'save15'});
  // 15% of 10.50 = 1.575 -> 1.58; exact shares 52 2/3 each: 52 x 3 = 156, two cents go to lines 1 and 2.
  assert.deepEqual(discounts(view), ['0.53', '0.53', '0.52']);
  view = shop.placeOrder('t3', [{sku: 'bulb', qty: 1}, {sku: 'shade', qty: 1}, {sku: 'bulb', qty: 1}], {coupon: 'five'});
  // 5% of 14.45 = 0.7225 -> 0.72; shares 17.439..., 37.120..., 17.439...: floors 17 + 37 + 17 = 71, the cent goes to line 1.
  assert.deepEqual(discounts(view), ['0.18', '0.37', '0.17']);
  view = shop.placeOrder('t4', [{sku: 'six', qty: 1}, {sku: 'four', qty: 1}], {coupon: 'save15'});
  assert.deepEqual(discounts(view), ['0.90', '0.60']);
  view = shop.placeOrder('t5', [{sku: 'shade', qty: 1}, {sku: 'lamp', qty: 1}, {sku: 'bulb', qty: 3}], {coupon: 'all'});
  assert.deepEqual([view.total, ...nets(view)], ['0.00', '0.00', '0.00', '0.00']);
  view = shop.placeOrder('t6', [{sku: 'lamp', qty: 1}], {coupon: 'half'});
  assert.deepEqual([view.discount, ...discounts(view)], ['6.50', '6.50']);
});

test('report 4: unit-by-unit refunds pay back exactly the net', () => {
  const {shop} = lampShop();
  const view = shop.placeOrder('o-400', [{sku: 'shade', qty: 3}], {coupon: 'five'});
  assert.equal(view.total, '21.23');
  shop.pay('o-400');
  assert.deepEqual([1, 1, 1].map(qty => shop.refund('o-400', 1, qty)), ['7.07', '7.08', '7.08']);
  assert.equal(shop.order('o-400').refunded, '21.23');
  shop.placeOrder('o-401', [{sku: 'shade', qty: 3}], {coupon: 'five'});
  shop.pay('o-401');
  assert.deepEqual([shop.refund('o-401', 1, 2), shop.refund('o-401', 1, 1)], ['14.15', '7.08']);
});

test('refunding every line of an order pays back its total', () => {
  const {shop} = lampShop();
  shop.placeOrder('o-300', [{sku: 'lamp', qty: 2}, {sku: 'shade', qty: 1}, {sku: 'bulb', qty: 3}], {coupon: 'save15'});
  shop.pay('o-300');
  assert.deepEqual([shop.refund('o-300', 3, 1), shop.refund('o-300', 1, 1), shop.refund('o-300', 3, 2), shop.refund('o-300', 2, 1), shop.refund('o-300', 1, 1)],
    ['2.97', '11.04', '5.96', '6.33', '11.04']);
  const view = shop.order('o-300');
  assert.equal(view.refunded, view.total);
  assert.deepEqual(view.lines.map(line => [line.refundedQty, line.refunded]), [[2, '22.08'], [1, '6.33'], [3, '8.93']]);
  assert.equal(view.status, 'paid');
});

test('errors in documented order', () => {
  const {clock, shop} = kitShop();
  shop.addCoupon('ten', 10);
  assert.throws(() => shop.addProduct('Hub', {price: '1'}), err('Invalid sku Hub'));
  assert.throws(() => shop.addProduct('hub', {price: 'x'}), err('Sku hub already exists'));
  assert.throws(() => shop.addProduct('lamp', {price: '1.001'}), err('Invalid price 1.001'));
  assert.throws(() => shop.addProduct('lamp', {price: '1', stock: -1}), err('Invalid quantity -1'));
  assert.throws(() => shop.addBundle('k2', {price: '1', components: {}}), err('Invalid components for k2'));
  assert.throws(() => shop.addBundle('k2', {price: '1', components: {zz: 0, 'starter-kit': 1}}), err('Not a product starter-kit'));
  assert.throws(() => shop.addBundle('k2', {price: '1', components: {hub: 0}}), err('Invalid quantity 0'));
  assert.throws(() => shop.addCoupon('ten', 5), err('Coupon ten already exists'));
  assert.throws(() => shop.addCoupon('big', 101), err('Invalid percent 101'));
  assert.throws(() => shop.restock('starter-kit', 1), err('Not a product starter-kit'));
  assert.throws(() => shop.restock('hub', 0), err('Invalid quantity 0'));
  assert.throws(() => shop.placeOrder('O1', []), err('Invalid order id O1'));
  assert.throws(() => shop.placeOrder('o1', []), err('Order o1 has no lines'));
  assert.throws(() => shop.placeOrder('o1', [{sku: 'hub', qty: 1}, {sku: 'nope', qty: 0}], {coupon: 'nope'}), err('Unknown sku nope'));
  assert.throws(() => shop.placeOrder('o1', [{sku: 'hub', qty: 1.5}, {sku: 'nope', qty: 1}]), err('Invalid quantity 1.5'));
  assert.throws(() => shop.placeOrder('o1', [{sku: 'hub', qty: 11}], {coupon: 'nope'}), err('Unknown coupon nope'));
  shop.placeOrder('o1', [{sku: 'hub', qty: 1}]);
  assert.throws(() => shop.placeOrder('o1', [{sku: 'hub', qty: 1}]), err('Order o1 already exists'));
  assert.throws(() => shop.refund('o1', 1, 1), err('Order o1 is pending'));
  assert.throws(() => shop.pay('o9'), err('Unknown order o9'));
  shop.pay('o1');
  assert.throws(() => shop.cancel('o1'), err('Order o1 is paid'));
  assert.throws(() => shop.refund('o1', 2, 1), err('Unknown line 2 in o1'));
  assert.throws(() => shop.refund('o1', 1, 0), err('Invalid quantity 0'));
  assert.throws(() => shop.refund('o1', 1, 2), err('Refund exceeds line 1 of o1'));
  assert.throws(() => shop.stock('nope'), err('Unknown sku nope'));
  clock.advance(100);
  assert.deepEqual(stockOf(shop, 'hub'), {onHand: 9, reserved: 0, available: 9});
});

// Seeded random histories against a small model of docs/SHOP.md and docs/PRICING.md.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cents = c => Math.floor(c / 100) + '.' + String(c % 100).padStart(2, '0');
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const rows = weights.map((w, i) => ({i, share: Math.floor(total * w / sum), rest: (total * w) % sum}));
  const missing = total - rows.reduce((s, row) => s + row.share, 0);
  [...rows].sort((a, b) => b.rest - a.rest || a.i - b.i).slice(0, missing).forEach(row => row.share++);
  return rows.map(row => row.share);
}

class Model {
  constructor(minutes) {
    this.minutes = minutes;
    this.now = Date.parse(START);
    this.items = {};
    this.onHand = {};
    this.reserved = {};
    this.coupons = {};
    this.orders = new Map();
  }
  sweep() {
    for (const order of this.orders.values()) {
      if (order.status !== 'pending' || order.expiresAt > this.now) continue;
      order.status = 'expired';
      for (const [sku, qty] of order.parts) this.reserved[sku] -= qty;
    }
  }
  parts(sku, qty) {
    const {components} = this.items[sku];
    return components ? Object.entries(components).map(([part, n]) => [part, n * qty]) : [[sku, qty]];
  }
  place(id, lines, coupon) {
    const need = {};
    for (const {sku, qty} of lines) for (const [part, n] of this.parts(sku, qty)) need[part] = (need[part] ?? 0) + n;
    const short = Object.keys(need).sort().find(sku => need[sku] > this.onHand[sku] - this.reserved[sku]);
    if (short) return {error: 'Insufficient stock for ' + short};
    for (const sku in need) this.reserved[sku] += need[sku];
    const rows = lines.map(({sku, qty}, i) => ({lineNo: i + 1, sku, qty, unit: this.items[sku].price, gross: this.items[sku].price * qty, refundedQty: 0, refunded: 0}));
    const subtotal = rows.reduce((s, row) => s + row.gross, 0);
    const discount = Math.floor((subtotal * (coupon ? this.coupons[coupon] : 0) + 50) / 100);
    allocate(discount, rows.map(row => row.gross)).forEach((share, i) => { rows[i].discount = share; rows[i].net = rows[i].gross - share; });
    const order = {id, status: 'pending', coupon: coupon ?? null, subtotal, discount, refunded: 0, lines: rows, parts: Object.entries(need), expiresAt: this.now + this.minutes * 60000};
    this.orders.set(id, order);
    return {value: this.view(id)};
  }
  settle(id, from, to) {
    const order = this.orders.get(id);
    if (order.status !== from) return {error: 'Order ' + id + ' is ' + order.status};
    for (const [sku, qty] of order.parts) {
      this.reserved[sku] -= qty;
      if (to === 'paid') this.onHand[sku] -= qty;
    }
    order.status = to;
    return {value: this.view(id)};
  }
  refund(id, lineNo, qty, restock) {
    const order = this.orders.get(id);
    if (order.status !== 'paid') return {error: 'Order ' + id + ' is ' + order.status};
    const line = order.lines[lineNo - 1];
    if (qty > line.qty - line.refundedQty) return {error: 'Refund exceeds line ' + lineNo + ' of ' + id};
    const amount = Math.floor(line.net * (line.refundedQty + qty) / line.qty) - Math.floor(line.net * line.refundedQty / line.qty);
    line.refundedQty += qty;
    line.refunded += amount;
    order.refunded += amount;
    if (restock) for (const [sku, n] of this.parts(line.sku, qty)) this.onHand[sku] += n;
    return {value: cents(amount)};
  }
  view(id) {
    const o = this.orders.get(id);
    return {id, status: o.status, coupon: o.coupon, subtotal: cents(o.subtotal), discount: cents(o.discount), total: cents(o.subtotal - o.discount), refunded: cents(o.refunded),
      lines: o.lines.map(l => ({lineNo: l.lineNo, sku: l.sku, qty: l.qty, unitPrice: cents(l.unit), gross: cents(l.gross), discount: cents(l.discount), net: cents(l.net), refundedQty: l.refundedQty, refunded: cents(l.refunded)}))};
  }
  stock(sku) {
    return {onHand: this.onHand[sku], reserved: this.reserved[sku], available: this.onHand[sku] - this.reserved[sku]};
  }
}

for (const seed of [11, 22, 33, 44, 55]) {
  test('random history, seed ' + seed, () => {
    const random = mulberry32(seed);
    const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
    const pick = list => list[Math.floor(random() * list.length)];
    const minutes = pick([10, 15, 25]);
    const clock = manualClock(START);
    const shop = createShop({clock, reservationMinutes: minutes});
    const model = new Model(minutes);
    const products = {p1: 1999, p2: 350, p3: 745, p4: 1299, p5: 99, p6: 2450};
    for (const [sku, price] of Object.entries(products)) {
      const stock = int(5, 40);
      shop.addProduct(sku, {price: cents(price), stock});
      model.items[sku] = {price};
      model.onHand[sku] = stock;
      model.reserved[sku] = 0;
    }
    const bundles = {k1: [2499, {p1: 1, p2: 2}], k2: [1999, {p2: 1, p3: 3}], k3: [4999, {p1: 2, p4: 1, p5: 1}], k4: [999, {p5: 4}]};
    for (const [sku, [price, components]] of Object.entries(bundles)) {
      shop.addBundle(sku, {price: cents(price), components});
      model.items[sku] = {price, components};
    }
    for (const [code, percent] of Object.entries({c3: 3, c7: 7, c15: 15, c33: 33, c100: 100})) {
      shop.addCoupon(code, percent);
      model.coupons[code] = percent;
    }
    const skus = Object.keys(model.items);
    const ids = [];
    const expectSame = (label, actual, expected) => {
      if (expected.error) assert.throws(actual, err(expected.error), label);
      else assert.deepStrictEqual(actual(), expected.value, label);
    };
    // Mostly orders in the status the command needs, sometimes any order (status errors).
    const choose = status => {
      const fitting = ids.filter(id => model.orders.get(id).status === status);
      return fitting.length && random() < 0.85 ? pick(fitting) : pick(ids);
    };
    for (let step = 0; step < 400; step++) {
      const roll = random();
      const label = 'seed ' + seed + ' step ' + step;
      model.sweep();
      if (roll < 0.30) {
        const id = 'o' + step;
        const lines = Array.from({length: int(1, 4)}, () => ({sku: pick(skus), qty: pick([1, 1, 1, 2, 3])}));
        const coupon = random() < 0.6 ? pick(Object.keys(model.coupons)) : undefined;
        const expected = model.place(id, lines, coupon);
        expectSame(label + ' place', () => shop.placeOrder(id, lines, coupon === undefined ? undefined : {coupon}), expected);
        if (!expected.error) ids.push(id);
      } else if (roll < 0.50 && ids.length) {
        const id = choose('pending');
        expectSame(label + ' pay', () => shop.pay(id), model.settle(id, 'pending', 'paid'));
      } else if (roll < 0.56 && ids.length) {
        const id = choose('pending');
        expectSame(label + ' cancel', () => shop.cancel(id), model.settle(id, 'pending', 'cancelled'));
      } else if (roll < 0.76 && ids.length) {
        const id = choose('paid');
        const order = model.orders.get(id);
        const lineNo = int(1, order.lines.length);
        const line = order.lines[lineNo - 1];
        const qty = int(1, Math.max(1, line.qty - line.refundedQty + (random() < 0.15 ? 1 : 0)));
        const restock = random() < 0.8;
        expectSame(label + ' refund', () => shop.refund(id, lineNo, qty, {restock}), model.refund(id, lineNo, qty, restock));
      } else if (roll < 0.80) {
        const sku = pick(Object.keys(products));
        const qty = int(1, 20);
        shop.restock(sku, qty);
        model.onHand[sku] += qty;
      } else {
        const advance = pick([1, 2, 5, 7, minutes, minutes - 1, 30]);
        clock.advance(advance);
        model.now += advance * 60000;
      }
      model.sweep();
      for (const sku of Object.keys(products)) assert.deepStrictEqual(shop.stock(sku), model.stock(sku), label + ' stock of ' + sku);
    }
    for (const id of ids) assert.deepStrictEqual(shop.order(id), model.view(id), 'final view of ' + id);
  });
}
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

const variant = files => root => writeTree(root, files);

export default {
  id: 'shop-oversell',
  category: 'symptom-only multi-file debugging',
  prompt: 'Bug reports from the shop team against stockroom 2.7 (this repository). ' +
    '(1) Sold-out products come back. We had 3 widgets; order o-100 for all 3 was placed and paid right away, and stock(\'widget\') showed available 0. Twenty minutes later, with no restock, stock(\'widget\') showed available 3 again, and order o-101 for 3 more widgets was accepted and paid. The warehouse never had them. ' +
    '(2) Starter kit stock drifts. starter-kit is 1 hub + 2 cables, and we had 10 hubs and 40 cables. We placed o-200 (1 starter-kit) and o-201 (1 starter-kit and 1 cable), then paid both. stock(\'cable\') now says onHand 34, reserved -1; the warehouse counts 35 cables and nothing should be reserved. Every starter-kit ordered since reserves 3 cables. ' +
    '(3) Line discounts disagree with accounting, which implements docs/PRICING.md: o-300 (2 lamp at 12.99, 1 shade at 7.45, 3 bulb at 3.50, coupon save15 = 15%) shows line discounts 3.90 / 1.11 / 1.58, accounting has 3.90 / 1.12 / 1.57. ' +
    '(4) Refunds overpay: o-400 (3 shade at 7.45, coupon five = 5%) has total 21.23; the customer returned the shades one at a time and was paid back 7.08 three times, 21.24 in all. ' +
    'Expected: the behaviour documented in docs/SHOP.md and docs/PRICING.md, which are correct as written. Find and fix the root causes in src/ so the whole documented API behaves as documented. ' +
    'Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['stockroom 2.7', files]]),
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
    // 1. The expiry sweep still releases committed reservations.
    variant({'src/inventory/reservations.js': RESERVATIONS}),
    // 2. Symptom patch: reserved clamped at zero instead of fixing the double release.
    variant({'src/inventory/reservations.js': RESERVATIONS,
      // The first match is release(); commit() keeps its plain subtraction.
      'src/inventory/stock.js': swap(STOCK, 'this.#reserved.set(sku, this.#reserved.get(sku) - qty);', 'this.#reserved.set(sku, Math.max(0, this.#reserved.get(sku) - qty));')}),
    // 3. mergeParts still mutates the catalog's bundle parts.
    variant({'src/inventory/merge.js': MERGE}),
    // 4. Bundle parts deep-frozen instead: merging a kit with its own component now throws.
    variant({'src/inventory/merge.js': MERGE, 'src/catalog/catalog.js': swap(CATALOG, '{kind: \'bundle\', sku, priceCents, parts}', '{kind: \'bundle\', sku, priceCents, parts: Object.freeze(parts.map(part => Object.freeze(part)))}')}),
    // 5. Left-over cents still go to the biggest lines.
    variant({'src/pricing/allocate.js': ALLOCATE}),
    // 6. Largest remainder with ties going to the later line.
    variant({'src/pricing/allocate.js': swap(ALLOCATE_FIXED, '|| a - b);', '|| b - a);')}),
    // 7. Refunds still round each call on its own.
    variant({'src/pricing/refund-amount.js': REFUND_AMOUNT}),
    // 8. Rounded refunds with the remainder on the last unit.
    variant({'src/pricing/refund-amount.js': String.raw`export function refundAmount(line, units) {
  if (line.refundedQty + units === line.qty) return line.netCents - Math.round(line.netCents * line.refundedQty / line.qty);
  return Math.round(line.netCents * units / line.qty);
}
`}),
    // 9. A visible test edited.
    variant({'test/shop.test.js': swap(VISIBLE_SHOP, "test('coupons and refunds'", "test.skip('coupons and refunds'")}),
  ],
};
