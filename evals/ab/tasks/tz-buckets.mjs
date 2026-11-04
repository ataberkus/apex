import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

const SPEC = `# Event report buckets

\`bucket(events, {timeZone, period})\` in \`src/report.js\` groups timestamped events into calendar buckets of one time zone and returns one row per bucket.

## Input

- \`events\` is an array of \`{at, amount}\` objects. \`amount\` is always a safe integer and needs no validation.
- \`at\` must be a string of exactly this form: \`YYYY-MM-DDTHH:MM:SS\`, optionally followed by fractional seconds (a \`.\` and one or more digits), followed by a UTC offset that is either \`Z\` or \`+HH:MM\` / \`-HH:MM\`.
  - \`T\` and \`Z\` are upper-case. Every field has exactly the number of digits shown (the year has four).
  - The date must exist in the Gregorian calendar: month 01-12, and the day must exist in that month (February 29 only in leap years, which are the years divisible by 4, except years divisible by 100 that are not divisible by 400).
  - Hours are 00-23, minutes 00-59, seconds 00-59 (no \`24:00:00\`, no leap second \`60\`). Offset hours are 00-23, offset minutes 00-59.
  - The offset is required: a timestamp without one is invalid. Nothing else is accepted (no space instead of \`T\`, no \`+0100\`, no missing seconds).
  - The timestamp denotes the instant "local time minus offset": \`2021-03-14T01:30:00+01:00\` is the same instant as \`2021-03-14T00:30:00Z\`.
  - Fractional seconds are truncated to whole milliseconds, never rounded: \`23:59:59.9999\` means \`23:59:59.999\`.
- \`timeZone\` is valid exactly when it is a string that \`new Intl.DateTimeFormat('en-US', {timeZone})\` accepts. That includes every alias and spelling Intl accepts, such as \`UTC\`, \`utc\` or \`US/Eastern\`.
- \`period\` is one of the strings \`'day'\`, \`'week'\`, \`'month'\` (exactly these, lower-case).

## Buckets

An event belongs to the bucket of its local calendar date in \`timeZone\`: the date that a wall clock in that zone shows at the event's instant. The offset written in \`at\` only fixes the instant; it never affects the bucket.

- \`day\`: key \`YYYY-MM-DD\` of the local date.
- \`week\`: the ISO 8601 week of the local date, key \`YYYY-Www\` (for example \`2021-W05\`; \`ww\` is two digits). Weeks start on Monday. Week 01 of a week-year is the week that contains that year's first Thursday (equivalently, January 4th). The week-year (\`YYYY\` in the key) is the calendar year of the Thursday of the date's week, so a few dates at the start of January can belong to week 52 or 53 of the previous week-year, and a few dates at the end of December to week 01 of the next week-year. A week-year has 52 or 53 weeks.
- \`month\`: key \`YYYY-MM\` of the local date.

## Output

An array of \`{key, count, sum}\` objects (no other properties), sorted by \`key\` ascending. \`count\` is the number of events in the bucket and \`sum\` the sum of their amounts. No events: \`[]\`.

The output is gap-filled: it contains every bucket from the first non-empty bucket to the last non-empty bucket, inclusive. A bucket without events has \`count: 0\` and \`sum: 0\`.

- \`day\`: the buckets are consecutive local calendar dates of \`timeZone\`, found by stepping one calendar date at a time, not by adding 24 hours (local days can last 23, 23.5, 24.5 or 25 hours). Only dates that actually occur in that time zone are included: if the zone skipped a whole calendar date, that date has no bucket. For example, Pacific/Apia jumped from the end of 2011-12-29 straight to 2011-12-31, so 2011-12-30 never occurred there and \`2011-12-30\` is never a key for Pacific/Apia.
- \`week\`: every ISO week in between.
- \`month\`: every month in between.

## Errors

Validation runs in this order, even when \`events\` is empty: \`timeZone\` first, then \`period\`, then the \`at\` of each event in array order. The first problem found throws a \`RangeError\` with exactly one of these messages, where \`<value>\` is \`String(value)\` of the offending value:

- \`Invalid time zone: <value>\`
- \`Invalid period: <value>\`
- \`Invalid timestamp: <value>\`
`;

const NAIVE = `/** Group events into calendar buckets; see docs/REPORT.md. */
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');

function keyOf(date, period) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
  if (period === 'day') return y + '-' + pad(m) + '-' + pad(d);
  if (period === 'month') return y + '-' + pad(m);
  const dayOfYear = (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / DAY + 1;
  return y + '-W' + pad(Math.ceil(dayOfYear / 7));
}

export function bucket(events, {timeZone, period}) {
  if (!['day', 'week', 'month'].includes(period)) throw new Error('unknown period ' + period);
  const rows = new Map();
  let first = Infinity, last = -Infinity;
  for (const {at, amount} of events) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) throw new Error('bad timestamp ' + at);
    const key = keyOf(date, period);
    const row = rows.get(key) ?? {key, count: 0, sum: 0};
    row.count++;
    row.sum += amount;
    rows.set(key, row);
    first = Math.min(first, date.getTime());
    last = Math.max(last, date.getTime());
  }
  // Fill gaps: walk from the first event to the last one step at a time.
  const step = {day: DAY, week: 7 * DAY, month: 28 * DAY}[period];
  for (let t = first; t <= last; t += step) {
    const key = keyOf(new Date(t), period);
    if (!rows.has(key)) rows.set(key, {key, count: 0, sum: 0});
  }
  return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}
`;

const VISIBLE = `import test from 'node:test';
import assert from 'node:assert/strict';
import {bucket} from '../src/report.js';

const ev = (at, amount) => ({at, amount});

test('daily buckets are gap-filled', () => {
  const events = [ev('2024-05-03T10:00:00Z', 5), ev('2024-05-01T08:30:00Z', 2), ev('2024-05-01T23:59:59Z', 3)];
  assert.deepEqual(bucket(events, {timeZone: 'UTC', period: 'day'}), [
    {key: '2024-05-01', count: 2, sum: 5},
    {key: '2024-05-02', count: 0, sum: 0},
    {key: '2024-05-03', count: 1, sum: 5},
  ]);
});

test('offsets in timestamps are honoured', () => {
  assert.deepEqual(bucket([ev('2024-05-01T23:30:00-02:00', 4)], {timeZone: 'UTC', period: 'day'}), [{key: '2024-05-02', count: 1, sum: 4}]);
});

test('weekly buckets', () => {
  const events = [ev('2024-05-06T10:00:00Z', 1), ev('2024-05-12T22:00:00Z', 2), ev('2024-05-20T09:00:00Z', 4)];
  assert.deepEqual(bucket(events, {timeZone: 'UTC', period: 'week'}), [
    {key: '2024-W19', count: 2, sum: 3},
    {key: '2024-W20', count: 0, sum: 0},
    {key: '2024-W21', count: 1, sum: 4},
  ]);
});

test('monthly buckets', () => {
  const events = [ev('2024-03-02T00:00:00Z', 10), ev('2024-01-15T12:00:00Z', 1)];
  assert.deepEqual(bucket(events, {timeZone: 'UTC', period: 'month'}), [
    {key: '2024-01', count: 1, sum: 1},
    {key: '2024-02', count: 0, sum: 0},
    {key: '2024-03', count: 1, sum: 10},
  ]);
});

test('no events', () => {
  assert.deepEqual(bucket([], {timeZone: 'UTC', period: 'day'}), []);
});
`;

const files = {
  'package.json': JSON.stringify({name: 'event-report', version: '1.0.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'docs/REPORT.md': SPEC,
  'src/report.js': NAIVE,
  'test/report.test.js': VISIBLE,
};

const REFERENCE = String.raw`/** Group events into calendar buckets of one time zone; see docs/REPORT.md. */
const DAY = 86400000, HOUR = 3600000;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const pad = (n, width = 2) => String(n).padStart(width, '0');
const civil = (y, m, d) => { const date = new Date(0); date.setUTCFullYear(y, m - 1, d); return date.getTime(); };

/** Epoch milliseconds, or NaN when at is not a valid timestamp. */
function parse(at) {
  const match = typeof at === 'string' ? TIMESTAMP.exec(at) : null;
  if (!match) return NaN;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  const oh = Number(match[9] ?? 0), om = Number(match[10] ?? 0);
  if (!days || d < 1 || d > days || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59) return NaN;
  const ms = Number(((match[7] ?? '') + '00').slice(0, 3));
  return civil(y, mo, d) + ((h * 60 + mi) * 60 + s) * 1000 + ms - (match[8] === '-' ? -1 : 1) * (oh * 60 + om) * 60000;
}

function isoWeek(y, m, d) {
  const t = civil(y, m, d);
  const thursday = t + (3 - (new Date(t).getUTCDay() + 6) % 7) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  return pad(year, 4) + '-W' + pad(Math.floor((thursday - civil(year, 1, 1)) / DAY / 7) + 1);
}

export function bucket(events, {timeZone, period}) {
  let format;
  try {
    if (typeof timeZone !== 'string') throw new TypeError('not a string');
    format = new Intl.DateTimeFormat('en-US', {timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: 'numeric', day: 'numeric'});
  } catch {
    throw new RangeError('Invalid time zone: ' + String(timeZone));
  }
  if (!['day', 'week', 'month'].includes(period)) throw new RangeError('Invalid period: ' + String(period));
  const times = events.map(({at}) => {
    const time = parse(at);
    if (Number.isNaN(time)) throw new RangeError('Invalid timestamp: ' + String(at));
    return time;
  });
  if (!times.length) return [];

  const local = time => {
    const parts = Object.fromEntries(format.formatToParts(time).map(part => [part.type, Number(part.value)]));
    return [parts.year, parts.month, parts.day];
  };
  const keyOf = ([y, m, d]) => period === 'day' ? pad(y, 4) + '-' + pad(m) + '-' + pad(d)
    : period === 'month' ? pad(y, 4) + '-' + pad(m) : isoWeek(y, m, d);
  const rows = new Map();
  const row = key => rows.get(key) ?? rows.set(key, {key, count: 0, sum: 0}).get(key);
  const dates = times.map(local);
  events.forEach(({amount}, i) => { const r = row(keyOf(dates[i])); r.count++; r.sum += amount; });

  let first = Infinity, last = -Infinity;
  if (period === 'day') {
    // Every local date between the first and last event lasts over an hour, so an hourly walk over the instants visits each one that occurs.
    for (const time of times) { first = Math.min(first, time); last = Math.max(last, time); }
    for (let time = first; time < last; time += HOUR) row(keyOf(local(time)));
  } else {
    // Weeks and months: walk the calendar dates in between; every week and month has dates.
    for (const [y, m, d] of dates) { first = Math.min(first, civil(y, m, d)); last = Math.max(last, civil(y, m, d)); }
    for (let t = first; t <= last; t += DAY) { const date = new Date(t); row(keyOf([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()])); }
  }
  return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
`;

const z = (...keys) => keys.map(key => [key, 0, 0]);

// [name, timeZone, period, [[at, amount], ...], [[key, count, sum], ...]]
const CASES = [
  ['New York: midnights around the 23-hour day', 'America/New_York', 'day',
    [['2021-03-14T04:59:59Z', 1], ['2021-03-14T05:00:00Z', 2], ['2021-03-15T03:59:59Z', 4], ['2021-03-15T04:00:00Z', 8]],
    [['2021-03-13', 1, 1], ['2021-03-14', 2, 6], ['2021-03-15', 1, 8]]],
  ['New York: gap filling across the 23-hour day', 'America/New_York', 'day',
    [['2021-03-13T23:30:00-05:00', 5], ['2021-03-17T12:00:00-04:00', 7]],
    [['2021-03-13', 1, 5], ...z('2021-03-14', '2021-03-15', '2021-03-16'), ['2021-03-17', 1, 7]]],
  ['New York: midnights around the 25-hour day', 'America/New_York', 'day',
    [['2021-11-07T03:59:59Z', 1], ['2021-11-07T04:00:00Z', 2], ['2021-11-07T05:30:00Z', 4], ['2021-11-07T06:30:00Z', 8], ['2021-11-08T04:59:59Z', 16], ['2021-11-08T05:00:00Z', 32]],
    [['2021-11-06', 1, 1], ['2021-11-07', 4, 30], ['2021-11-08', 1, 32]]],
  ['New York: gap filling across the 25-hour day', 'America/New_York', 'day',
    [['2021-11-08T23:30:00-05:00', 4], ['2021-11-05T00:30:00-04:00', 3]],
    [['2021-11-05', 1, 3], ...z('2021-11-06', '2021-11-07'), ['2021-11-08', 1, 4]]],
  ['US/Eastern alias; the written offset only fixes the instant; fractions truncate', 'US/Eastern', 'day',
    [['2021-03-14T01:30:00+01:00', 1], ['2021-03-14T09:00:00+05:00', 2], ['2021-03-13T23:59:59.9999999-05:00', 4], ['2021-03-14T00:00:00-05:00', 8]],
    [['2021-03-13', 3, 7], ['2021-03-14', 1, 8]]],
  ['Berlin: midnights around the 23-hour day', 'Europe/Berlin', 'day',
    [['2021-03-27T22:59:59Z', 1], ['2021-03-28T00:00:00+01:00', 2], ['2021-03-28T23:59:59+02:00', 4], ['2021-03-28T22:00:00Z', 8]],
    [['2021-03-27', 1, 1], ['2021-03-28', 2, 6], ['2021-03-29', 1, 8]]],
  ['Berlin: midnights around the 25-hour day', 'Europe/Berlin', 'day',
    [['2021-10-30T23:59:59+02:00', 1], ['2021-10-30T22:00:00Z', 2], ['2021-10-31T00:30:00Z', 4], ['2021-10-31T01:30:00Z', 8], ['2021-10-31T23:59:59.999+01:00', 16], ['2021-10-31T23:00:00Z', 32]],
    [['2021-10-30', 1, 1], ['2021-10-31', 4, 30], ['2021-11-01', 1, 32]]],
  ['Berlin: gap filling across the 23-hour day', 'Europe/Berlin', 'day',
    [['2021-03-26T23:30:00+01:00', 1], ['2021-03-30T00:15:00+02:00', 2]],
    [['2021-03-26', 1, 1], ...z('2021-03-27', '2021-03-28', '2021-03-29'), ['2021-03-30', 1, 2]]],
  ['Berlin: weeks follow local dates', 'Europe/Berlin', 'week',
    [['2021-10-24T22:30:00Z', 4], ['2021-10-31T22:59:59Z', 1], ['2021-10-31T23:00:00Z', 2]],
    [['2021-W43', 2, 5], ['2021-W44', 1, 2]]],
  ['Kathmandu: months at +05:45', 'Asia/Kathmandu', 'month',
    [['2021-06-30T18:14:59Z', 1], ['2021-06-30T18:15:00Z', 2], ['2021-08-31T23:59:59+05:45', 4]],
    [['2021-06', 1, 1], ['2021-07', 1, 2], ['2021-08', 1, 4]]],
  ['Kathmandu: days at +05:45', 'Asia/Kathmandu', 'day',
    [['2021-01-01T00:00:00+05:45', 1], ['2020-12-31T18:14:59.999Z', 2]],
    [['2020-12-31', 1, 2], ['2021-01-01', 1, 1]]],
  ['Lord Howe: the 23.5-hour day', 'Australia/Lord_Howe', 'day',
    [['2021-10-02T13:29:59Z', 1], ['2021-10-02T13:30:00Z', 2], ['2021-10-02T15:45:00Z', 4], ['2021-10-03T12:59:59Z', 8], ['2021-10-03T13:00:00Z', 16]],
    [['2021-10-02', 1, 1], ['2021-10-03', 3, 14], ['2021-10-04', 1, 16]]],
  ['Lord Howe: the 24.5-hour day', 'Australia/Lord_Howe', 'day',
    [['2021-04-03T12:59:59Z', 1], ['2021-04-03T13:00:00Z', 2], ['2021-04-04T13:15:00Z', 16], ['2021-04-04T13:29:59Z', 4], ['2021-04-04T13:30:00Z', 8]],
    [['2021-04-03', 1, 1], ['2021-04-04', 3, 22], ['2021-04-05', 1, 8]]],
  ['Apia: one second apart, two dates apart', 'Pacific/Apia', 'day',
    [['2011-12-29T23:59:59-10:00', 1], ['2011-12-31T00:00:00+14:00', 2]],
    [['2011-12-29', 1, 1], ['2011-12-31', 1, 2]]],
  ['Apia: gap filling skips 2011-12-30', 'Pacific/Apia', 'day',
    [['2012-01-02T12:00:00Z', 5], ['2011-12-27T08:00:00Z', 3]],
    [['2011-12-26', 1, 3], ...z('2011-12-27', '2011-12-28', '2011-12-29', '2011-12-31', '2012-01-01', '2012-01-02'), ['2012-01-03', 1, 5]]],
  ['Apia: weeks across the skipped date', 'Pacific/Apia', 'week',
    [['2011-12-29T12:00:00-10:00', 1], ['2011-12-31T12:00:00+14:00', 2], ['2012-01-01T23:00:00+14:00', 4], ['2012-01-02T00:00:00+14:00', 8]],
    [['2011-W52', 3, 7], ['2012-W01', 1, 8]]],
  ['ISO week-year: 2020-12-31 and 2021-01-01 are 2020-W53', 'UTC', 'week',
    [['2020-12-31T12:00:00Z', 1], ['2021-01-01T12:00:00Z', 2], ['2021-01-03T23:59:59Z', 4], ['2021-01-04T00:00:00Z', 8]],
    [['2020-W53', 3, 7], ['2021-W01', 1, 8]]],
  ['ISO week-year: 2018-12-31 is 2019-W01', 'UTC', 'week',
    [['2018-12-30T12:00:00Z', 1], ['2018-12-31T00:00:00Z', 2], ['2019-01-06T23:59:59Z', 4]],
    [['2018-W52', 1, 1], ['2019-W01', 2, 6]]],
  ['ISO week-year: 2027-01-01 is 2026-W53 (Tokyo dates)', 'Asia/Tokyo', 'week',
    [['2026-12-31T15:00:00Z', 1], ['2026-12-27T15:00:00Z', 2], ['2027-01-03T15:00:00Z', 4], ['2027-01-03T14:59:59Z', 8]],
    [['2026-W53', 3, 11], ['2027-W01', 1, 4]]],
  ['ISO week-year: Auckland Monday 2018-12-31 is 2019-W01', 'Pacific/Auckland', 'week',
    [['2018-12-30T11:00:00Z', 1], ['2018-12-30T10:59:59Z', 2]],
    [['2018-W52', 1, 2], ['2019-W01', 1, 1]]],
  ['week gap filling through a 53-week year', 'UTC', 'week',
    [['2021-01-15T00:00:00Z', 2], ['2020-12-14T00:00:00Z', 1]],
    [['2020-W51', 1, 1], ...z('2020-W52', '2020-W53', '2021-W01'), ['2021-W02', 1, 2]]],
  ['week gap filling through a 52-week year', 'UTC', 'week',
    [['2018-12-20T00:00:00Z', 1], ['2019-01-08T00:00:00Z', 2]],
    [['2018-W51', 1, 1], ...z('2018-W52', '2019-W01'), ['2019-W02', 1, 2]]],
  ['month gap filling across a year boundary (Tokyo)', 'Asia/Tokyo', 'month',
    [['2021-10-31T15:30:00Z', 1], ['2022-01-31T15:00:00Z', 2]],
    [['2021-11', 1, 1], ...z('2021-12', '2022-01'), ['2022-02', 1, 2]]],
  ['month gap filling over 14 months (New York)', 'America/New_York', 'month',
    [['2019-11-30T23:59:59-05:00', 1], ['2021-01-01T04:59:59Z', 2]],
    [['2019-11', 1, 1], ...z('2019-12', '2020-01', '2020-02', '2020-03', '2020-04', '2020-05', '2020-06', '2020-07', '2020-08', '2020-09', '2020-10', '2020-11'), ['2020-12', 1, 2]]],
  ['Santiago: the day whose midnight does not exist', 'America/Santiago', 'day',
    [['2021-09-05T03:59:59Z', 1], ['2021-09-05T04:00:00Z', 2], ['2021-09-03T12:00:00Z', 4], ['2021-09-07T03:30:00Z', 8]],
    [['2021-09-03', 1, 4], ['2021-09-04', 1, 1], ['2021-09-05', 1, 2], ['2021-09-06', 0, 0], ['2021-09-07', 1, 8]]],
  ['UTC: unsorted input, negative amounts, leap day', 'UTC', 'day',
    [['2024-02-29T12:00:00Z', -5], ['2024-02-28T00:00:00.5Z', 3], ['2024-02-29T00:00:00+00:00', 10], ['2024-03-01T00:00:00+01:00', 7]],
    [['2024-02-28', 1, 3], ['2024-02-29', 3, 12]]],
  ['2000-02-29 exists; lower-case utc is a valid zone', 'utc', 'day',
    [['2000-02-29T12:00:00Z', 1]],
    [['2000-02-29', 1, 1]]],
  ['no events', 'Pacific/Apia', 'month', [], []],
];

const OK = ['2021-01-01T00:00:00Z', 1];
// [events, options, message]
const ERRORS = [
  [[], {timeZone: 'Mars/Olympus_Mons', period: 'day'}, 'Invalid time zone: Mars/Olympus_Mons'],
  [[OK], {timeZone: 'America/NewYork', period: 'day'}, 'Invalid time zone: America/NewYork'],
  [[OK], {period: 'day'}, 'Invalid time zone: undefined'],
  [[['garbage', 1]], {timeZone: 'Nowhere/Land', period: 'year'}, 'Invalid time zone: Nowhere/Land'],
  [[], {timeZone: 'UTC', period: 'year'}, 'Invalid period: year'],
  [[OK], {timeZone: 'Europe/Berlin', period: 'Day'}, 'Invalid period: Day'],
  [[OK], {timeZone: 'UTC'}, 'Invalid period: undefined'],
  [[['garbage', 1]], {timeZone: 'UTC', period: 'hour'}, 'Invalid period: hour'],
  [[OK, ['2021-02-30T00:00:00Z', 1], ['garbage', 1]], {timeZone: 'UTC', period: 'day'}, 'Invalid timestamp: 2021-02-30T00:00:00Z'],
  [[OK, [1609459200000, 1]], {timeZone: 'UTC', period: 'day'}, 'Invalid timestamp: 1609459200000'],
  ...['not a date', '2021-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '2021-04-31T12:00:00Z', '2021-13-01T00:00:00Z', '2021-00-10T00:00:00Z',
    '2021-01-00T00:00:00Z', '2021-01-01T24:00:00Z', '2021-01-01T10:60:00Z', '2021-01-01T10:00:60Z', '2021-01-01T10:00:00',
    '2021-01-01 10:00:00Z', '2021-01-01T10:00Z', '2021-01-01T10:00:00+0100', '2021-01-01T10:00:00+24:00', '2021-01-01T10:00:00+05:60',
    '2021-01-01t10:00:00z', '2021-01-01T10:00:00.Z', '21-01-01T10:00:00Z', '2021-1-01T10:00:00Z']
    .map(at => [[OK, [at, 1]], {timeZone: 'America/New_York', period: 'week'}, 'Invalid timestamp: ' + at]),
];

const HIDDEN = `import test from 'node:test';
import assert from 'node:assert/strict';
const {bucket} = await import('@ROOT@src/report.js');
const toEvents = list => list.map(([at, amount]) => ({at, amount}));
for (const [name, timeZone, period, events, rows] of ${JSON.stringify(CASES)}) {
  test(name, () => assert.deepStrictEqual(bucket(toEvents(events), {timeZone, period}), rows.map(([key, count, sum]) => ({key, count, sum}))));
}
for (const [events, options, message] of ${JSON.stringify(ERRORS)}) {
  test('error: ' + message, () => assert.throws(() => bucket(toEvents(events), options), error => error instanceof RangeError && error.message === message));
}
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

export default {
  id: 'tz-buckets',
  category: 'calendar and time-zone edge cases',
  prompt: '`bucket()` in src/report.js only works for UTC. Make it implement the specification in docs/REPORT.md completely and exactly, for every time zone. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Event report with UTC buckets', files]]),
  solve: root => writeTree(root, {'src/report.js': REFERENCE}),
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
    // Gap filling in 24-hour steps from the first event.
    root => writeTree(root, {'src/report.js': REFERENCE.replace('time < last; time += HOUR', 'time < last; time += 24 * HOUR')}),
    // Week-year taken from the calendar year of the date.
    root => writeTree(root, {'src/report.js': REFERENCE.replace("return pad(year, 4) + '-W'", "return pad(y, 4) + '-W'")}),
    // Buckets by UTC dates whatever the zone.
    root => writeTree(root, {'src/report.js': REFERENCE.replace('{timeZone, calendar:', "{timeZone: 'UTC', calendar:")}),
    // A visible test edited.
    root => writeTree(root, {'test/report.test.js': VISIBLE.replace("test('no events'", "test.skip('no events'")}),
  ],
};
