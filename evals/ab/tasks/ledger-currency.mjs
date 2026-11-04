import path from 'node:path';
import {gitRepo, hiddenTests, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture and reference sources are String.raw blocks: backslashes stay verbatim, so these files avoid `${` and backticks.

const PROMPT = `This repository is a small ledger CLI (README.md; docs/CLI.md describes its current behavior). Add multi-currency support as specified below. Everything docs/CLI.md describes stays as it is unless a requirement below changes it. Nobody is available to answer questions: this text and the repository are the whole specification. Error messages below are the MESSAGE part of the existing error format (\`ledger: MESSAGE\` on standard error, nothing on standard output).

1. Currencies. The supported currencies and their minor units (digits after the decimal point) are exactly: BHD 3, CHF 2, EUR 2, GBP 2, JPY 0, KRW 0, KWD 3, USD 2. A currency code is valid only if it is one of these eight, written exactly as listed (\`usd\` is not valid). Wherever the command line takes a currency code (\`--currency\`, \`--in\`), an invalid code fails with \`unknown currency: CODE\` (CODE exactly as given), exit code 1.

2. Entries have a currency. \`add\` accepts \`--currency CODE\` (an option like the others; default \`USD\`). The currency is validated before the amount.

3. Amounts per currency. AMOUNT keeps its syntax (an optional \`-\`, one or more digits, optionally a \`.\` followed by one or more digits), but the number of digits after the \`.\` may be at most the currency's minor units, trailing zeros included: \`1.250\` is a valid KWD amount, \`100.0\` is not a valid JPY amount, and a currency with 0 minor units takes no \`.\` at all. An amount whose absolute value in minor units exceeds 9007199254740991 is also invalid. An invalid amount fails with \`invalid amount for CODE: TEXT\` (TEXT exactly as given), exit code 1. A failing \`add\` never touches the ledger file.

4. Ledger file version 2: \`{"version": 2, "entries": [...]}\`, where every entry has exactly the properties \`id\`, \`date\`, \`amount\`, \`currency\` and \`description\`; \`amount\` is the signed amount in minor units of the entry's currency as a JSON integer (USD 12.50 is 1250, JPY 1500 is 1500, KWD -1.250 is -1250) and \`currency\` is its code. \`add\` always writes version 2.

5. Version-1 files (the current format) keep working: every version-1 entry is a USD entry, its decimal-string amount converted to minor units. When \`add\` writes a ledger read from a version-1 file, it writes all existing entries in version-2 form with ids, dates, descriptions and order unchanged, followed by the new entry. \`list\`, \`balance\` and \`export\` never create, write or reformat the ledger file, whatever its version: afterwards it is byte-for-byte identical. Any version other than 1 and 2 still fails with \`unsupported ledger version: N\`.

6. Displaying amounts. Everywhere an amount is printed (list, balance, export): its digits with exactly the currency's minor units after a \`.\` (no \`.\` for 0 minor units), a leading \`-\` when negative, no sign for zero, no thousands separators, no currency symbol. Examples: \`12.50\`, \`-0.05\`, \`0.00\`, \`1500\`, \`-1.250\`, \`0.000\`.

7. \`list\` prints \`#ID DATE AMOUNT CODE DESCRIPTION\` with single spaces between fields, e.g. \`#3 2024-01-07 -1500 JPY Ramen\`. \`list --currency CODE\` prints only the entries in that currency (nothing if there are none).

8. \`balance\` (without \`--in\`) prints one line \`CODE AMOUNT\` per currency that occurs in at least one entry, sorted by code (A to Z); AMOUNT is the exact sum of that currency's entries, printed even when it is zero (e.g. \`EUR 0.00\` followed by \`USD 8.30\`). Sums must be exact even when they exceed 9007199254740991 minor units. An empty ledger prints nothing. This replaces the \`Balance: AMOUNT\` line.

9. \`balance --in CODE\` prints exactly one line \`CODE AMOUNT\`: the total of all entries converted into currency CODE. Exchange rates come from the file given by \`--rates PATH\` (relative to the current directory), by default \`rates.json\` in the current directory; the rates file is read whenever \`--in\` is given, even if no conversion is needed. Rates file format: a JSON object like \`{"base": "USD", "rates": {"EUR": "0.9187", "JPY": "151.37"}}\`. \`base\` must be a valid currency code. \`rates\` must be a JSON object (not an array); each of its keys that is a valid currency code must not be the base and must have as its value a string of one or more digits, optionally followed by \`.\` and one or more digits, whose value is not zero. It means that 1 unit of the base is worth that many units of the key's currency. Keys that are not valid currency codes are ignored, and their values are not checked. The base's own rate is 1; a currency that is neither the base nor a key of \`rates\` has no rate.

10. Exact conversion. An amount A in currency X is worth A × rate(CODE) / rate(X) in CODE. Compute the sum of these values over all entries exactly (integer, rational or arbitrary-precision decimal arithmetic; never binary floating point), then round that one exact sum to CODE's minor units, half to even (a value exactly halfway between two neighbours goes to the one whose last digit is even: 0.125 → 0.12, 0.135 → 0.14, -0.125 → -0.12, 0.005 → 0.00). Never round per entry or per currency. An empty ledger converts to zero (e.g. \`JPY 0\`).

11. Conversion errors, all exit code 1, checked in this order: an invalid CODE gives \`unknown currency: CODE\`; a rates file that cannot be read gives \`cannot read rates file\`; a rates file that is not valid JSON or breaks a rule of requirement 9 gives \`invalid rates file\`; if CODE has no rate, \`no rate for CODE\`; otherwise, if a currency that occurs in at least one entry has no rate, \`no rate for X\` for the first such currency X in code order (A to Z).

12. CSV export (\`export\` and \`export --format csv\`): the header \`id,date,amount,currency,description\`, then one record per entry in file order; every record, the header included, ends with CR LF (\`\\r\\n\`). A field is enclosed in double quotes if and only if it contains a comma, a double quote, a CR or an LF; inside a quoted field every double quote is doubled. Field text is otherwise written unchanged.

13. JSON export (\`export --format json\`): an array, in file order, with one object per entry having exactly the keys \`id\` (number), \`date\`, \`amount\` (the display string of requirement 6), \`currency\`, \`minor\` (the amount in minor units as a JSON integer) and \`description\`. Key order and whitespace are free.

14. Update docs/CLI.md so that it describes the new behavior, including the \`--currency\`, \`--in\` and \`--rates\` options and the rates file. Do not modify or delete existing files under test/ (you may add new test files); \`npm test\` must pass. Do not add dependencies.`;

const DOCS_V1 = `# ledger command reference

    node bin/ledger.js COMMAND [ARGUMENTS] [OPTIONS]

Options are written \`--name value\` or \`--name=value\` and may appear anywhere after the command. Every other argument, including negative numbers such as \`-4.20\`, is positional.

Every command accepts \`--file PATH\`: the ledger file, relative to the current directory (default: \`ledger.json\` in the current directory).

Every line of output ends with \`\\n\`.

## Commands

### add AMOUNT DESCRIPTION... [--date YYYY-MM-DD]

Appends an entry and prints \`Added #ID\`. AMOUNT is an optional \`-\`, one or more digits, and optionally a \`.\` followed by one or two digits (\`12\`, \`12.5\`, \`-4.20\`); negative amounts are expenses. The description is the remaining positional arguments joined with single spaces and must not be empty. \`--date\` must be a real calendar date and defaults to today's local date. The new entry's id is one more than the largest id in the ledger (1 for an empty ledger). If the ledger file does not exist it is created.

### list

Prints one line per entry, in file order: \`#ID DATE AMOUNT DESCRIPTION\`, fields separated by single spaces, e.g. \`#3 2024-01-07 -4.20 Lunch\`. Prints nothing for an empty ledger.

### balance

Prints \`Balance: AMOUNT\`, the sum of all entries (\`Balance: 0.00\` for an empty ledger).

### export [--format csv|json]

Prints every entry in file order.

- \`csv\` (the default): the header \`id,date,amount,description\`, then one row per entry.
- \`json\`: a JSON array of objects \`{"id", "date", "amount", "description"}\` with \`amount\` as a decimal string.

Amounts are printed with two decimals and a leading \`-\` when negative, without thousands separators: \`12.50\`, \`-0.05\`, \`0.00\`.

## Ledger file

    {"version": 1, "entries": [{"id": 1, "date": "2024-01-05", "amount": "12.50", "description": "Coffee beans"}]}

Amounts are decimal strings in the AMOUNT syntax. A missing file is an empty ledger. Only \`add\` writes the file; \`list\`, \`balance\` and \`export\` never create or change it.

## Errors

Errors print \`ledger: MESSAGE\` on standard error and nothing on standard output.

Exit code 1, invalid data: \`invalid amount: TEXT\`, \`invalid date: TEXT\`, \`empty description\`, \`cannot parse ledger file\`, \`unsupported ledger version: N\`.

Exit code 2, invalid usage: \`missing command\`, \`unknown command: NAME\`, \`unknown option: --NAME\`, \`missing value for --NAME\`, \`missing amount\`, \`unexpected argument: TEXT\`, \`unknown format: NAME\`.
`;

const DOCS_V2 = `# ledger command reference

    node bin/ledger.js COMMAND [ARGUMENTS] [OPTIONS]

Options are written \`--name value\` or \`--name=value\` and may appear anywhere after the command. Every other argument, including negative numbers such as \`-4.20\`, is positional.

Every command accepts \`--file PATH\`: the ledger file, relative to the current directory (default: \`ledger.json\` in the current directory).

Every line of output ends with \`\\n\` (CSV export uses \`\\r\\n\`).

## Currencies

| Code | Minor units |
|------|-------------|
| BHD | 3 |
| CHF | 2 |
| EUR | 2 |
| GBP | 2 |
| JPY | 0 |
| KRW | 0 |
| KWD | 3 |
| USD | 2 |

Codes are case-sensitive. Amounts are printed with exactly the currency's minor units (\`12.50\`, \`1500\`, \`-1.250\`), a leading \`-\` when negative and no sign for zero.

## Commands

### add AMOUNT DESCRIPTION... [--currency CODE] [--date YYYY-MM-DD]

Appends an entry and prints \`Added #ID\`. \`--currency\` defaults to \`USD\`. AMOUNT is an optional \`-\`, one or more digits, and optionally a \`.\` followed by at most as many digits as the currency has minor units (none for JPY and KRW). Its absolute value in minor units may not exceed 9007199254740991. The description is the remaining positional arguments joined with single spaces and must not be empty. \`--date\` must be a real calendar date and defaults to today's local date. The new entry's id is one more than the largest id in the ledger (1 for an empty ledger). If the ledger file does not exist it is created.

### list [--currency CODE]

Prints one line per entry, in file order: \`#ID DATE AMOUNT CODE DESCRIPTION\`, e.g. \`#3 2024-01-07 -1500 JPY Ramen\`. With \`--currency\`, only entries in that currency.

### balance [--in CODE [--rates PATH]]

Without \`--in\`: one line \`CODE AMOUNT\` per currency in the ledger, sorted by code, with the exact sum of that currency's entries. Prints nothing for an empty ledger.

With \`--in CODE\`: one line \`CODE AMOUNT\`, the total of all entries converted into CODE with the rates file (\`--rates PATH\`, default \`rates.json\` in the current directory). An amount A in currency X is worth A × rate(CODE) / rate(X); the exact sum is rounded once, half to even, to CODE's minor units.

### export [--format csv|json]

Prints every entry in file order.

- \`csv\` (the default): the header \`id,date,amount,currency,description\`, then one record per entry, each line ending with \`\\r\\n\`. Fields containing a comma, double quote, CR or LF are quoted, with inner double quotes doubled (RFC 4180).
- \`json\`: a JSON array of objects \`{"id", "date", "amount", "currency", "minor", "description"}\`, \`amount\` being the printed decimal string and \`minor\` the integer amount in minor units.

## Rates file

    {"base": "USD", "rates": {"EUR": "0.9187", "JPY": "151.37"}}

1 unit of \`base\` is worth RATE units of each listed currency; the base itself has rate 1. Rates are decimal strings (digits, optionally \`.\` and digits) and may not be zero. Keys that are not supported currency codes are ignored.

## Ledger file

    {"version": 2, "entries": [{"id": 1, "date": "2024-01-05", "amount": 1250, "currency": "USD", "description": "Coffee beans"}]}

\`amount\` is an integer in minor units. Version 1 files (decimal-string amounts, no currency) are read as USD and rewritten as version 2 the next time \`add\` writes. A missing file is an empty ledger. Only \`add\` writes the file; \`list\`, \`balance\` and \`export\` never create or change it.

## Errors

Errors print \`ledger: MESSAGE\` on standard error and nothing on standard output.

Exit code 1, invalid data: \`unknown currency: CODE\`, \`invalid amount for CODE: TEXT\`, \`invalid date: TEXT\`, \`empty description\`, \`cannot parse ledger file\`, \`unsupported ledger version: N\`, \`cannot read rates file\`, \`invalid rates file\`, \`no rate for CODE\`.

Exit code 2, invalid usage: \`missing command\`, \`unknown command: NAME\`, \`unknown option: --NAME\`, \`missing value for --NAME\`, \`missing amount\`, \`unexpected argument: TEXT\`, \`unknown format: NAME\`.
`;

const FIXTURE = {
  'package.json': JSON.stringify({name: 'ledger', version: '1.0.0', description: 'A small command-line ledger.', type: 'module',
    bin: {ledger: 'bin/ledger.js'}, scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'README.md': `# ledger

A small command-line ledger for personal bookkeeping. Entries live in a JSON file (\`ledger.json\` in the current directory unless \`--file\` says otherwise).

    node bin/ledger.js add 12.50 Coffee beans --date 2024-01-05
    node bin/ledger.js add -4.20 Lunch
    node bin/ledger.js list
    node bin/ledger.js balance
    node bin/ledger.js export --format json

The full command reference is in docs/CLI.md. \`npm test\` runs the tests (Node 20 or newer, no dependencies).

Layout: \`bin/ledger.js\` (entry point), \`src/cli.js\` (dispatch and errors), \`src/args.js\` (option parsing), \`src/commands/\` (one module per command), \`src/money.js\` (amount parsing and formatting), \`src/store.js\` (ledger file), \`src/ledger.js\` (entries), \`src/csv.js\`.
`,
  'docs/CLI.md': DOCS_V1,
  'bin/ledger.js': String.raw`#!/usr/bin/env node
import {main} from '../src/cli.js';

process.exitCode = main(process.argv.slice(2), process.cwd());
`,
  'src/errors.js': String.raw`/** A failure shown to the user as "ledger: MESSAGE"; exit code 1 for bad data, 2 for bad usage. */
export class LedgerError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const usage = message => new LedgerError(message, 2);
`,
  'src/args.js': String.raw`import {usage} from './errors.js';

/** Split arguments into positionals and "--name value" / "--name=value" options; allowed lists the option names. */
export function parseArgs(argv, allowed) {
  const options = {}, positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!allowed.includes(name)) throw usage('unknown option: --' + name);
    if (eq !== -1) options[name] = arg.slice(eq + 1);
    else if (i + 1 < argv.length) options[name] = argv[++i];
    else throw usage('missing value for --' + name);
  }
  return {options, positionals};
}
`,
  'src/cli.js': String.raw`import path from 'node:path';
import {parseArgs} from './args.js';
import {LedgerError, usage} from './errors.js';
import * as add from './commands/add.js';
import * as balance from './commands/balance.js';
import * as exportCommand from './commands/export.js';
import * as list from './commands/list.js';

const commands = {add, balance, export: exportCommand, list};

/** Run one command and return its exit code. Output goes to stdout; errors go to stderr as "ledger: MESSAGE". */
export function main(argv, cwd) {
  try {
    const [name, ...rest] = argv;
    if (name === undefined) throw usage('missing command');
    if (!Object.hasOwn(commands, name)) throw usage('unknown command: ' + name);
    const command = commands[name];
    const {options, positionals} = parseArgs(rest, command.options);
    if (!command.positionals && positionals.length) throw usage('unexpected argument: ' + positionals[0]);
    const file = path.resolve(cwd, options.file ?? 'ledger.json');
    process.stdout.write(command.run({file, cwd, options, positionals}));
    return 0;
  } catch (error) {
    if (!(error instanceof LedgerError)) throw error;
    process.stderr.write('ledger: ' + error.message + '\n');
    return error.exitCode;
  }
}
`,
  'src/money.js': String.raw`import {LedgerError} from './errors.js';

const AMOUNT = /^-?\d+(\.\d{1,2})?$/;

/** Parse decimal text such as "12.5" or "-4.20" into integer cents. */
export function parseAmount(text) {
  if (!AMOUNT.test(text)) throw new LedgerError('invalid amount: ' + text);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

/** Integer cents as "12.50" / "-0.05". */
export function formatAmount(cents) {
  const abs = Math.abs(cents);
  return (cents < 0 ? '-' : '') + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
`,
  'src/ledger.js': String.raw`import {LedgerError} from './errors.js';

/** A real calendar date in YYYY-MM-DD form. */
export function checkDate(text) {
  const date = new Date(text + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text)
    throw new LedgerError('invalid date: ' + text);
  return text;
}

export function today() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

/** Append an entry with the next free id and return it. */
export function addEntry(ledger, fields) {
  const id = ledger.entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  const entry = {id, ...fields};
  ledger.entries.push(entry);
  return entry;
}

export const total = entries => entries.reduce((sum, entry) => sum + entry.amount, 0);
`,
  'src/store.js': String.raw`import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {LedgerError} from './errors.js';
import {formatAmount, parseAmount} from './money.js';

/** Read a ledger file; a missing file is an empty ledger. Amounts come back as integer cents. */
export function load(file) {
  if (!existsSync(file)) return {entries: []};
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new LedgerError('cannot parse ledger file'); }
  if (data.version !== 1) throw new LedgerError('unsupported ledger version: ' + data.version);
  return {entries: data.entries.map(entry => ({...entry, amount: parseAmount(entry.amount)}))};
}

export function save(file, ledger) {
  const entries = ledger.entries.map(({id, date, amount, description}) => ({id, date, amount: formatAmount(amount), description}));
  writeFileSync(file, JSON.stringify({version: 1, entries}, null, 2) + '\n');
}
`,
  'src/csv.js': String.raw`/** Rows of fields as CSV text. */
const field = value => {
  const text = String(value);
  return text.includes(',') ? '"' + text + '"' : text;
};

export const toCSV = rows => rows.map(row => row.map(field).join(',')).join('\n') + '\n';
`,
  'src/commands/add.js': String.raw`import {LedgerError, usage} from '../errors.js';
import {addEntry, checkDate, today} from '../ledger.js';
import {parseAmount} from '../money.js';
import {load, save} from '../store.js';

export const options = ['file', 'date'];
export const positionals = true;

export function run({file, options, positionals}) {
  const [amountText, ...words] = positionals;
  if (amountText === undefined) throw usage('missing amount');
  const amount = parseAmount(amountText);
  const description = words.join(' ');
  if (!description) throw new LedgerError('empty description');
  const date = checkDate(options.date ?? today());
  const ledger = load(file);
  const entry = addEntry(ledger, {date, amount, description});
  save(file, ledger);
  return 'Added #' + entry.id + '\n';
}
`,
  'src/commands/list.js': String.raw`import {formatAmount} from '../money.js';
import {load} from '../store.js';

export const options = ['file'];

export function run({file}) {
  return load(file).entries.map(entry => '#' + entry.id + ' ' + entry.date + ' ' + formatAmount(entry.amount) + ' ' + entry.description + '\n').join('');
}
`,
  'src/commands/balance.js': String.raw`import {total} from '../ledger.js';
import {formatAmount} from '../money.js';
import {load} from '../store.js';

export const options = ['file'];

export function run({file}) {
  return 'Balance: ' + formatAmount(total(load(file).entries)) + '\n';
}
`,
  'src/commands/export.js': String.raw`import {toCSV} from '../csv.js';
import {usage} from '../errors.js';
import {formatAmount} from '../money.js';
import {load} from '../store.js';

export const options = ['file', 'format'];

export function run({file, options}) {
  const format = options.format ?? 'csv';
  if (format !== 'csv' && format !== 'json') throw usage('unknown format: ' + format);
  const entries = load(file).entries;
  if (format === 'json')
    return JSON.stringify(entries.map(entry => ({id: entry.id, date: entry.date, amount: formatAmount(entry.amount), description: entry.description})), null, 2) + '\n';
  return toCSV([['id', 'date', 'amount', 'description'], ...entries.map(entry => [entry.id, entry.date, formatAmount(entry.amount), entry.description])]);
}
`,
  'test/money.test.js': String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {formatAmount, parseAmount} from '../src/money.js';

test('parses decimal amounts into cents', () => {
  assert.equal(parseAmount('12.50'), 1250);
  assert.equal(parseAmount('-4.2'), -420);
  assert.equal(parseAmount('7'), 700);
});

test('rejects malformed amounts', () => {
  assert.throws(() => parseAmount('1.234'), /invalid amount/);
  assert.throws(() => parseAmount('abc'), /invalid amount/);
});

test('formats cents with two decimals', () => {
  assert.equal(formatAmount(1250), '12.50');
  assert.equal(formatAmount(-5), '-0.05');
  assert.equal(formatAmount(0), '0.00');
});
`,
  'test/ledger.test.js': String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {addEntry, checkDate, total} from '../src/ledger.js';

test('new entries get the next id', () => {
  const ledger = {entries: [{id: 4, amount: 100}]};
  assert.equal(addEntry(ledger, {amount: 5}).id, 5);
  assert.equal(addEntry({entries: []}, {amount: 5}).id, 1);
});

test('total sums cents', () => assert.equal(total([{amount: 1250}, {amount: -420}]), 830));

test('dates must exist', () => {
  assert.equal(checkDate('2024-02-29'), '2024-02-29');
  assert.throws(() => checkDate('2023-02-29'), /invalid date/);
});
`,
  'test/cli.test.js': String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const bin = fileURLToPath(new URL('../bin/ledger.js', import.meta.url));
const ledger = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], {cwd, encoding: 'utf8'});

function workspace(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function twoEntries(t) {
  const dir = workspace(t);
  ledger(dir, 'add', '12.50', 'Coffee', 'beans', '--date', '2024-01-05');
  ledger(dir, 'add', '-4.20', 'Lunch', '--date', '2024-01-07');
  return dir;
}

test('add creates the ledger and numbers entries', t => {
  const dir = workspace(t);
  const first = ledger(dir, 'add', '12.50', 'Coffee', 'beans', '--date', '2024-01-05');
  assert.equal(first.status, 0);
  assert.equal(first.stdout, 'Added #1\n');
  assert.ok(existsSync(path.join(dir, 'ledger.json')));
  assert.equal(ledger(dir, 'add', '3', 'Milk', '--date', '2024-01-06').stdout, 'Added #2\n');
});

test('list shows entries in order', t => {
  const lines = ledger(twoEntries(t), 'list').stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^#1 2024-01-05 12\.50 .*Coffee beans$/);
  assert.match(lines[1], /^#2 2024-01-07 -4\.20 .*Lunch$/);
});

test('balance sums the entries', t => {
  assert.match(ledger(twoEntries(t), 'balance').stdout, /8\.30/);
});

test('invalid amounts are rejected', t => {
  const dir = workspace(t);
  const result = ledger(dir, 'add', '1.234', 'Too', 'precise');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid amount/);
  assert.ok(!existsSync(path.join(dir, 'ledger.json')));
});

test('invalid dates are rejected', t => {
  const result = ledger(workspace(t), 'add', '5', 'Rent', '--date', '2024-13-01');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'ledger: invalid date: 2024-13-01\n');
});

test('unknown commands are usage errors', t => {
  const result = ledger(workspace(t), 'frobnicate');
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'ledger: unknown command: frobnicate\n');
});

test('--file selects another ledger', t => {
  const dir = workspace(t);
  ledger(dir, 'add', '1', 'Gum', '--file', 'books.json', '--date', '2024-01-05');
  assert.ok(existsSync(path.join(dir, 'books.json')));
  assert.ok(!existsSync(path.join(dir, 'ledger.json')));
  assert.match(ledger(dir, 'list', '--file=books.json').stdout, /Gum/);
});

test('list on a missing ledger prints nothing and creates nothing', t => {
  const dir = workspace(t);
  const result = ledger(dir, 'list');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.ok(!existsSync(path.join(dir, 'ledger.json')));
});

test('export json', t => {
  const entries = JSON.parse(ledger(twoEntries(t), 'export', '--format', 'json').stdout);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 1);
  assert.equal(entries[0].amount, '12.50');
  assert.equal(entries[1].description, 'Lunch');
});

test('export csv', t => {
  const out = ledger(twoEntries(t), 'export').stdout;
  assert.match(out, /^id,date,amount/);
  assert.match(out, /Coffee beans/);
});

test('the ledger file stays readable JSON', t => {
  const data = JSON.parse(readFileSync(path.join(twoEntries(t), 'ledger.json'), 'utf8'));
  assert.equal(data.entries.length, 2);
});
`,
};

const CONVERT = String.raw`import {MINOR_UNITS} from './currencies.js';

/** Round num/den (den > 0) to an integer, halves to even. */
export function roundHalfEven(num, den) {
  const negative = num < 0n;
  const abs = negative ? -num : num;
  let quotient = abs / den;
  const twice = 2n * (abs % den);
  if (twice > den || (twice === den && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

/**
 * Exact total of sums (Map code -> BigInt minor units) in target minor units. rates: Map code -> {num, den}, the
 * units of that currency per unit of the base. The whole sum is one fraction num/den, rounded once at the end.
 */
export function convert(sums, target, rates) {
  const rt = rates.get(target);
  let num = 0n, den = 1n;
  for (const [code, minor] of sums) {
    const rx = rates.get(code);
    const n = minor * rt.num * rx.den;
    const d = 10n ** BigInt(MINOR_UNITS[code]) * rt.den * rx.num;
    num = num * d + n * den;
    den *= d;
  }
  return roundHalfEven(num * 10n ** BigInt(MINOR_UNITS[target]), den);
}
`;

const REFERENCE = {
  'docs/CLI.md': DOCS_V2,
  'src/currencies.js': String.raw`import {LedgerError} from './errors.js';

/** Supported currencies and their minor units (digits after the decimal point). */
export const MINOR_UNITS = {BHD: 3, CHF: 2, EUR: 2, GBP: 2, JPY: 0, KRW: 0, KWD: 3, USD: 2};

export const isCurrency = code => typeof code === 'string' && Object.hasOwn(MINOR_UNITS, code);

export function checkCurrency(code) {
  if (!isCurrency(code)) throw new LedgerError('unknown currency: ' + code);
  return code;
}
`,
  'src/money.js': String.raw`import {MINOR_UNITS} from './currencies.js';
import {LedgerError} from './errors.js';

const AMOUNT = /^-?(\d+)(?:\.(\d+))?$/;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** Parse decimal text such as "12.5" or "-4.20" into integer minor units of currency. */
export function parseAmount(text, currency = 'USD') {
  const digits = MINOR_UNITS[currency];
  const match = AMOUNT.exec(text);
  const fraction = match?.[2] ?? '';
  if (!match || fraction.length > digits) throw new LedgerError('invalid amount for ' + currency + ': ' + text);
  const minor = BigInt(match[1] + fraction.padEnd(digits, '0'));
  if (minor > MAX) throw new LedgerError('invalid amount for ' + currency + ': ' + text);
  return Number(text.startsWith('-') ? -minor : minor);
}

/** Integer (or BigInt) minor units as "12.50", "-0.05", "1500", "-1.250". */
export function formatAmount(minor, currency = 'USD') {
  const digits = MINOR_UNITS[currency];
  const value = BigInt(minor);
  const text = (value < 0n ? -value : value).toString().padStart(digits + 1, '0');
  return (value < 0n ? '-' : '') + (digits ? text.slice(0, -digits) + '.' + text.slice(-digits) : text);
}
`,
  'src/ledger.js': FIXTURE['src/ledger.js'] + String.raw`
/** Exact per-currency sums (BigInt minor units), sorted by currency code. */
export function totals(entries) {
  const sums = new Map();
  for (const entry of entries) sums.set(entry.currency, (sums.get(entry.currency) ?? 0n) + BigInt(entry.amount));
  return new Map([...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
`,
  'src/store.js': String.raw`import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {LedgerError} from './errors.js';
import {parseAmount} from './money.js';

/** Read a ledger file (version 1 or 2); a missing file is an empty ledger. Amounts come back in minor units. */
export function load(file) {
  if (!existsSync(file)) return {entries: []};
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new LedgerError('cannot parse ledger file'); }
  if (data.version === 1)
    return {entries: data.entries.map(({id, date, amount, description}) => ({id, date, amount: parseAmount(amount, 'USD'), currency: 'USD', description}))};
  if (data.version === 2) return {entries: data.entries.map(entry => ({...entry}))};
  throw new LedgerError('unsupported ledger version: ' + data.version);
}

/** Always writes version 2. */
export function save(file, ledger) {
  const entries = ledger.entries.map(({id, date, amount, currency, description}) => ({id, date, amount, currency, description}));
  writeFileSync(file, JSON.stringify({version: 2, entries}, null, 2) + '\n');
}
`,
  'src/rates.js': String.raw`import {readFileSync} from 'node:fs';
import {isCurrency} from './currencies.js';
import {LedgerError} from './errors.js';

const RATE = /^(\d+)(?:\.(\d+))?$/;
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Map code -> {num, den}: units of that currency per unit of the base (the base itself is 1). */
export function loadRates(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw new LedgerError('cannot read rates file'); }
  const invalid = () => new LedgerError('invalid rates file');
  let data;
  try { data = JSON.parse(text); } catch { throw invalid(); }
  if (!isObject(data) || !isCurrency(data.base) || !isObject(data.rates)) throw invalid();
  const rates = new Map([[data.base, {num: 1n, den: 1n}]]);
  for (const [code, value] of Object.entries(data.rates)) {
    if (!isCurrency(code)) continue;
    const match = typeof value === 'string' && code !== data.base && RATE.exec(value);
    if (!match) throw invalid();
    const fraction = match[2] ?? '';
    const rate = {num: BigInt(match[1] + fraction), den: 10n ** BigInt(fraction.length)};
    if (rate.num === 0n) throw invalid();
    rates.set(code, rate);
  }
  return rates;
}
`,
  'src/convert.js': CONVERT,
  'src/csv.js': String.raw`/** Rows of fields as RFC 4180 CSV: CRLF after every record, quotes only where needed. */
const field = value => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};

export const toCSV = rows => rows.map(row => row.map(field).join(',') + '\r\n').join('');
`,
  'src/commands/add.js': String.raw`import {checkCurrency} from '../currencies.js';
import {LedgerError, usage} from '../errors.js';
import {addEntry, checkDate, today} from '../ledger.js';
import {parseAmount} from '../money.js';
import {load, save} from '../store.js';

export const options = ['file', 'date', 'currency'];
export const positionals = true;

export function run({file, options, positionals}) {
  const [amountText, ...words] = positionals;
  if (amountText === undefined) throw usage('missing amount');
  const currency = checkCurrency(options.currency ?? 'USD');
  const amount = parseAmount(amountText, currency);
  const description = words.join(' ');
  if (!description) throw new LedgerError('empty description');
  const date = checkDate(options.date ?? today());
  const ledger = load(file);
  const entry = addEntry(ledger, {date, amount, currency, description});
  save(file, ledger);
  return 'Added #' + entry.id + '\n';
}
`,
  'src/commands/list.js': String.raw`import {checkCurrency} from '../currencies.js';
import {formatAmount} from '../money.js';
import {load} from '../store.js';

export const options = ['file', 'currency'];

export function run({file, options}) {
  const currency = options.currency === undefined ? undefined : checkCurrency(options.currency);
  return load(file).entries.filter(entry => currency === undefined || entry.currency === currency)
    .map(entry => '#' + entry.id + ' ' + entry.date + ' ' + formatAmount(entry.amount, entry.currency) + ' ' + entry.currency + ' ' + entry.description + '\n')
    .join('');
}
`,
  'src/commands/balance.js': String.raw`import path from 'node:path';
import {convert} from '../convert.js';
import {checkCurrency} from '../currencies.js';
import {LedgerError} from '../errors.js';
import {totals} from '../ledger.js';
import {formatAmount} from '../money.js';
import {loadRates} from '../rates.js';
import {load} from '../store.js';

export const options = ['file', 'in', 'rates'];

export function run({file, cwd, options}) {
  if (options.in === undefined)
    return [...totals(load(file).entries)].map(([code, sum]) => code + ' ' + formatAmount(sum, code) + '\n').join('');
  const target = checkCurrency(options.in);
  const sums = totals(load(file).entries);
  const rates = loadRates(path.resolve(cwd, options.rates ?? 'rates.json'));
  for (const code of [target, ...sums.keys()]) if (!rates.has(code)) throw new LedgerError('no rate for ' + code);
  return target + ' ' + formatAmount(convert(sums, target, rates), target) + '\n';
}
`,
  'src/commands/export.js': String.raw`import {toCSV} from '../csv.js';
import {usage} from '../errors.js';
import {formatAmount} from '../money.js';
import {load} from '../store.js';

export const options = ['file', 'format'];

export function run({file, options}) {
  const format = options.format ?? 'csv';
  if (format !== 'csv' && format !== 'json') throw usage('unknown format: ' + format);
  const entries = load(file).entries;
  if (format === 'json')
    return JSON.stringify(entries.map(entry => ({id: entry.id, date: entry.date, amount: formatAmount(entry.amount, entry.currency),
      currency: entry.currency, minor: entry.amount, description: entry.description})), null, 2) + '\n';
  return toCSV([['id', 'date', 'amount', 'currency', 'description'],
    ...entries.map(entry => [entry.id, entry.date, formatAmount(entry.amount, entry.currency), entry.currency, entry.description])]);
}
`,
};

// ---------------------------------------------------------------- hidden tests (run from outside the workspace)

const PRELUDE = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const BIN = fileURLToPath(new URL('bin/ledger.js', '@ROOT@'));
const made = [];
process.on('exit', () => { for (const dir of made) rmSync(dir, {recursive: true, force: true}); });

function ws(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-hidden-'));
  made.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
function cli(cwd, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {cwd, encoding: 'utf8', timeout: 30000, windowsHide: true});
  return {status: r.status, raw: r.stdout, out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr.replace(/\r\n/g, '\n'), args};
}
function ok(r, out) {
  assert.equal(r.status, 0, r.args.join(' ') + ': ' + r.err);
  assert.equal(r.out, out, r.args.join(' '));
}
function fails(r, status, message) {
  assert.equal(r.err.trim(), 'ledger: ' + message, r.args.join(' '));
  assert.equal(r.status, status, r.args.join(' '));
  assert.equal(r.out, '', r.args.join(' '));
}
const bytes = (dir, name = 'ledger.json') => readFileSync(path.join(dir, name)).toString('base64');
const parsed = (dir, name = 'ledger.json') => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const entry = (id, date, amount, currency, description) => ({id, date, amount, currency, description});
const v2 = (...rows) => JSON.stringify({version: 2, entries: rows.map(row => entry(...row))}, null, 2) + '\n';
const R1 = JSON.stringify({base: 'USD', rates: {EUR: '0.9187', GBP: '0.7912', JPY: '151.37', CHF: '0.8823', KWD: '0.30745',
  BHD: '0.376', KRW: '1345.5', XAU: 0.00042, usd: 'not checked', Eur: null}});
const MIX = v2(
  [1, '2024-03-01', 1250, 'USD', 'Coffee beans'],
  [2, '2024-03-02', -1500, 'JPY', 'Ramen'],
  [3, '2024-03-03', -1250, 'KWD', 'Bank fee'],
  [4, '2024-03-04', 10000, 'EUR', 'Refund'],
  [5, '2024-03-05', -4599, 'GBP', 'Books'],
  [6, '2024-03-06', 2375, 'CHF', 'Train'],
  [7, '2024-03-07', 120000, 'KRW', 'Gift'],
  [8, '2024-03-08', 5005, 'BHD', 'Hotel deposit'],
  [9, '2024-03-09', -420, 'USD', 'Lunch  with  Ann'],
  [10, '2024-03-10', -5, 'KWD', 'Stamp']);
`;

const HIDDEN_STORAGE = String.raw`
test('add stores the currency and integer minor units (req 1, 2, 4)', () => {
  const dir = ws();
  ok(cli(dir, 'add', '12.50', 'Coffee', 'beans', '--date', '2024-01-05'), 'Added #1\n');
  ok(cli(dir, 'add', '--currency', 'JPY', '1500', 'Ramen', '--date', '2024-01-06'), 'Added #2\n');
  ok(cli(dir, 'add', '-1.250', 'Fee', '--currency=KWD', '--date=2024-01-07'), 'Added #3\n');
  ok(cli(dir, 'add', '0.5', '--date', '2024-01-08', 'Tea', '--currency', 'EUR'), 'Added #4\n');
  ok(cli(dir, 'add', '1.999', 'Taxi', 'ride', '--currency', 'BHD', '--date', '2024-01-09'), 'Added #5\n');
  ok(cli(dir, 'add', '-30000', 'Dinner', '--currency', 'KRW', '--date', '2024-01-10'), 'Added #6\n');
  assert.deepEqual(parsed(dir), {version: 2, entries: [
    entry(1, '2024-01-05', 1250, 'USD', 'Coffee beans'), entry(2, '2024-01-06', 1500, 'JPY', 'Ramen'),
    entry(3, '2024-01-07', -1250, 'KWD', 'Fee'), entry(4, '2024-01-08', 50, 'EUR', 'Tea'),
    entry(5, '2024-01-09', 1999, 'BHD', 'Taxi ride'), entry(6, '2024-01-10', -30000, 'KRW', 'Dinner')]});
});

test('unknown currency codes are rejected before anything else (req 1, 2)', () => {
  const dir = ws({'rates.json': R1});
  for (const code of ['usd', 'XYZ', 'US', 'USDX', 'Eur', 'XAU', 'constructor'])
    fails(cli(dir, 'add', '1', 'Gum', '--currency', code, '--date', '2024-01-05'), 1, 'unknown currency: ' + code);
  fails(cli(dir, 'add', '0.5', 'Gum', '--currency', 'xyz', '--date', '2024-01-05'), 1, 'unknown currency: xyz');
  assert.ok(!existsSync(path.join(dir, 'ledger.json')));
  fails(cli(dir, 'list', '--currency', 'eur'), 1, 'unknown currency: eur');
  fails(cli(dir, 'balance', '--in', 'XAU'), 1, 'unknown currency: XAU');
  fails(cli(dir, 'balance', '--in', 'toString'), 1, 'unknown currency: toString');
  assert.ok(!existsSync(path.join(dir, 'ledger.json')));
});

test('amount precision follows the currency, failures leave the file alone (req 3)', () => {
  const start = v2([1, '2024-01-01', 100, 'USD', 'Start']);
  const dir = ws({'ledger.json': start});
  const before = bytes(dir);
  const invalid = [['0.5', 'JPY'], ['100.0', 'JPY'], ['1.5', 'KRW'], ['1.234', 'USD'], ['1.2345', 'KWD'], ['0.0001', 'BHD'],
    ['2.500', 'EUR'], ['1.', 'USD'], ['.5', 'USD'], ['1e3', 'USD'], ['+5', 'USD'], ['1,50', 'EUR'], ['12.5.0', 'USD'], ['1-5', 'USD'],
    ['90071992547409.92', 'USD'], ['9007199254740992', 'JPY'], ['-9007199254740992', 'KRW'], ['9007199254740.992', 'KWD'],
    ['100000000000000000000', 'JPY']];
  for (const [text, code] of invalid) {
    const args = code === 'USD' ? [] : ['--currency', code];
    fails(cli(dir, 'add', text, 'Bad', ...args, '--date', '2024-01-02'), 1, 'invalid amount for ' + code + ': ' + text);
  }
  assert.equal(bytes(dir), before);
  const valid = [['1.250', 'KWD', 1250], ['007.5', 'USD', 750], ['9007199254740991', 'JPY', 9007199254740991],
    ['-90071992547409.91', 'USD', -9007199254740991], ['9007199254740.991', 'KWD', 9007199254740991], ['-0', 'KRW', 0],
    ['-0.00', 'USD', 0], ['0.1', 'BHD', 100], ['12', 'EUR', 1200], ['0.05', 'GBP', 5], ['3', 'KWD', 3000]];
  for (const [text, code] of valid) assert.equal(cli(dir, 'add', text, 'Ok', '--currency', code, '--date', '2024-01-03').status, 0, text);
  assert.deepEqual(parsed(dir).entries, [entry(1, '2024-01-01', 100, 'USD', 'Start'),
    ...valid.map(([, code, minor], i) => entry(i + 2, '2024-01-03', minor, code, 'Ok'))]);
});

test('version 1 files are read as USD, never rewritten by read-only commands, converted by add (req 5)', () => {
  const v1 = JSON.stringify({version: 1, entries: [
    {id: 3, date: '2023-12-30', amount: '12.5', description: 'Old, "quoted" entry'},
    {id: 7, date: '2023-12-31', amount: '-0.10', description: 'Fee'},
    {id: 9, date: '2024-01-02', amount: '7', description: 'Seven'}]});
  const dir = ws({'ledger.json': v1, 'rates.json': R1});
  const before = bytes(dir);
  const listing = '#3 2023-12-30 12.50 USD Old, "quoted" entry\n#7 2023-12-31 -0.10 USD Fee\n#9 2024-01-02 7.00 USD Seven\n';
  ok(cli(dir, 'list'), listing);
  ok(cli(dir, 'list', '--currency', 'USD'), listing);
  ok(cli(dir, 'list', '--currency', 'EUR'), '');
  ok(cli(dir, 'balance'), 'USD 19.40\n');
  ok(cli(dir, 'balance', '--in', 'EUR'), 'EUR 17.82\n');
  ok(cli(dir, 'balance', '--in', 'USD'), 'USD 19.40\n');
  fails(cli(dir, 'balance', '--in', 'EUR', '--rates', 'missing.json'), 1, 'cannot read rates file');
  assert.equal(cli(dir, 'export').status, 0);
  assert.deepEqual(JSON.parse(cli(dir, 'export', '--format', 'json').out), [
    {id: 3, date: '2023-12-30', amount: '12.50', currency: 'USD', minor: 1250, description: 'Old, "quoted" entry'},
    {id: 7, date: '2023-12-31', amount: '-0.10', currency: 'USD', minor: -10, description: 'Fee'},
    {id: 9, date: '2024-01-02', amount: '7.00', currency: 'USD', minor: 700, description: 'Seven'}]);
  fails(cli(dir, 'add', '0.5', 'Bad', '--currency', 'JPY'), 1, 'invalid amount for JPY: 0.5');
  assert.equal(bytes(dir), before, 'read-only commands must leave a version 1 file byte-identical');
  ok(cli(dir, 'add', '5', 'Stuff', '--currency', 'GBP', '--date', '2024-01-03'), 'Added #10\n');
  assert.deepEqual(parsed(dir), {version: 2, entries: [entry(3, '2023-12-30', 1250, 'USD', 'Old, "quoted" entry'),
    entry(7, '2023-12-31', -10, 'USD', 'Fee'), entry(9, '2024-01-02', 700, 'USD', 'Seven'), entry(10, '2024-01-03', 500, 'GBP', 'Stuff')]});
  ok(cli(dir, 'list'), listing + '#10 2024-01-03 5.00 GBP Stuff\n');
});

test('a large version 1 file (req 5, 7, 8)', () => {
  const entries = [], cents = [];
  for (let i = 1; i <= 3000; i++) {
    const c = i % 50 === 0 ? (i % 100 === 0 ? -i * 100 : i * 100) : ((i * 7919) % 200001) - 100000;
    const a = Math.abs(c);
    let text = Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
    if (a % 100 === 0 && i % 50 === 0) text = String(a / 100);
    else if (a % 10 === 0 && i % 2 === 1) text = text.slice(0, -1);
    entries.push({id: i * 2, date: '2023-01-' + String(1 + (i % 28)).padStart(2, '0'), amount: (c < 0 ? '-' : '') + text,
      description: 'Entry ' + i + (i % 7 === 0 ? ', with comma' : '')});
    cents.push(c);
  }
  const fmt = c => (c < 0 ? '-' : '') + Math.floor(Math.abs(c) / 100) + '.' + String(Math.abs(c) % 100).padStart(2, '0');
  const dir = ws({'ledger.json': JSON.stringify({version: 1, entries})});
  const before = bytes(dir);
  const listing = entries.map((e, i) => '#' + e.id + ' ' + e.date + ' ' + fmt(cents[i]) + ' USD ' + e.description + '\n').join('');
  ok(cli(dir, 'list'), listing);
  ok(cli(dir, 'balance'), 'USD ' + fmt(cents.reduce((s, c) => s + c, 0)) + '\n');
  const exported = JSON.parse(cli(dir, 'export', '--format', 'json').out);
  assert.deepEqual(exported.map(e => e.minor), cents);
  assert.equal(bytes(dir), before);
  ok(cli(dir, 'add', '-1', 'Last', '--currency', 'KRW', '--date', '2024-01-01'), 'Added #6001\n');
  assert.deepEqual(parsed(dir), {version: 2, entries: [...entries.map((e, i) => entry(e.id, e.date, cents[i], 'USD', e.description)),
    entry(6001, '2024-01-01', -1, 'KRW', 'Last')]});
  ok(cli(dir, 'list'), listing + '#6001 2024-01-01 -1 KRW Last\n');
});

test('read-only commands keep an oddly formatted version 2 file byte-identical (req 5)', () => {
  const odd = '{ "version":2,\r\n\t"entries":[{"id":1,"date":"2024-01-01","amount":150,"currency":"CHF","description":"Odd"}]  }  ';
  const dir = ws({'ledger.json': odd, 'rates.json': R1});
  ok(cli(dir, 'list'), '#1 2024-01-01 1.50 CHF Odd\n');
  ok(cli(dir, 'balance'), 'CHF 1.50\n');
  for (const args of [['balance', '--in', 'JPY'], ['export'], ['export', '--format', 'json'], ['list', '--currency', 'CHF']])
    assert.equal(cli(dir, ...args).status, 0, args.join(' '));
  assert.equal(readFileSync(path.join(dir, 'ledger.json'), 'utf8'), odd);
  ok(cli(dir, 'add', '2', 'Even', '--currency', 'JPY', '--date', '2024-01-02'), 'Added #2\n');
  assert.deepEqual(parsed(dir), {version: 2, entries: [entry(1, '2024-01-01', 150, 'CHF', 'Odd'), entry(2, '2024-01-02', 2, 'JPY', 'Even')]});
});

test('unsupported versions and missing files (req 5, docs/CLI.md)', () => {
  const v3 = '{"version": 3, "entries": []}\n';
  const dir = ws({'ledger.json': v3, 'rates.json': R1});
  for (const args of [['list'], ['balance'], ['balance', '--in', 'EUR'], ['export'], ['add', '1', 'X', '--date', '2024-01-01']])
    fails(cli(dir, ...args), 1, 'unsupported ledger version: 3');
  assert.equal(readFileSync(path.join(dir, 'ledger.json'), 'utf8'), v3);
  const empty = ws({'rates.json': R1});
  ok(cli(empty, 'list'), '');
  ok(cli(empty, 'balance'), '');
  assert.deepEqual(JSON.parse(cli(empty, 'export', '--format', 'json').out), []);
  assert.equal(cli(empty, 'export').raw, 'id,date,amount,currency,description\r\n');
  ok(cli(empty, 'balance', '--in', 'KWD'), 'KWD 0.000\n');
  assert.ok(!existsSync(path.join(empty, 'ledger.json')));
});
`;

const HIDDEN_DISPLAY = String.raw`
test('list prints the currency column with per-currency decimals (req 6, 7)', () => {
  const dir = ws({'ledger.json': MIX});
  ok(cli(dir, 'list'), [
    '#1 2024-03-01 12.50 USD Coffee beans', '#2 2024-03-02 -1500 JPY Ramen', '#3 2024-03-03 -1.250 KWD Bank fee',
    '#4 2024-03-04 100.00 EUR Refund', '#5 2024-03-05 -45.99 GBP Books', '#6 2024-03-06 23.75 CHF Train',
    '#7 2024-03-07 120000 KRW Gift', '#8 2024-03-08 5.005 BHD Hotel deposit', '#9 2024-03-09 -4.20 USD Lunch  with  Ann',
    '#10 2024-03-10 -0.005 KWD Stamp', ''].join('\n'));
  ok(cli(dir, 'list', '--currency', 'KWD'), '#3 2024-03-03 -1.250 KWD Bank fee\n#10 2024-03-10 -0.005 KWD Stamp\n');
  ok(cli(dir, 'list', '--currency=USD'), '#1 2024-03-01 12.50 USD Coffee beans\n#9 2024-03-09 -4.20 USD Lunch  with  Ann\n');
});

test('small, zero and negative amounts (req 6)', () => {
  const dir = ws({'ledger.json': v2([1, '2024-01-01', -5, 'USD', 'a'], [2, '2024-01-01', 0, 'KWD', 'b'], [3, '2024-01-01', 0, 'JPY', 'c'],
    [4, '2024-01-01', -7, 'BHD', 'd'], [5, '2024-01-01', 99, 'EUR', 'e'], [6, '2024-01-01', -100, 'GBP', 'f'], [7, '2024-01-01', -1, 'JPY', 'g'])});
  ok(cli(dir, 'list'), '#1 2024-01-01 -0.05 USD a\n#2 2024-01-01 0.000 KWD b\n#3 2024-01-01 0 JPY c\n#4 2024-01-01 -0.007 BHD d\n' +
    '#5 2024-01-01 0.99 EUR e\n#6 2024-01-01 -1.00 GBP f\n#7 2024-01-01 -1 JPY g\n');
});

test('balance prints one line per currency sorted by code (req 8)', () => {
  ok(cli(ws({'ledger.json': MIX}), 'balance'),
    'BHD 5.005\nCHF 23.75\nEUR 100.00\nGBP -45.99\nJPY -1500\nKRW 120000\nKWD -1.255\nUSD 8.30\n');
  const zero = ws({'ledger.json': v2([1, '2024-01-01', 830, 'USD', 'a'], [2, '2024-01-02', 1000, 'EUR', 'b'], [3, '2024-01-03', -1000, 'EUR', 'c'],
    [4, '2024-01-04', 0, 'CHF', 'd'], [5, '2024-01-05', 7, 'JPY', 'e'], [6, '2024-01-06', -7, 'JPY', 'f'])});
  ok(cli(zero, 'balance'), 'CHF 0.00\nEUR 0.00\nJPY 0\nUSD 8.30\n');
  ok(cli(ws({'ledger.json': v2()}), 'balance'), '');
});

test('balance sums are exact beyond Number.MAX_SAFE_INTEGER (req 8)', () => {
  const max = 9007199254740991;
  const dir = ws({'ledger.json': v2([1, '2024-01-01', max, 'USD', 'a'], [2, '2024-01-01', max, 'USD', 'b'], [3, '2024-01-01', max, 'USD', 'c'],
    [4, '2024-01-01', -max, 'KRW', 'd'], [5, '2024-01-01', -max, 'KRW', 'e'], [6, '2024-01-01', -max, 'KRW', 'f'], [7, '2024-01-01', -1, 'KRW', 'g'],
    [8, '2024-01-01', max, 'KWD', 'h'], [9, '2024-01-01', max, 'KWD', 'i'], [10, '2024-01-01', 3, 'KWD', 'j'])});
  ok(cli(dir, 'balance'), 'KRW -27021597764222974\nKWD 18014398509481.985\nUSD 270215977642229.73\n');
});
`;

const HIDDEN_CONVERSION = String.raw`
const one = (code, minor) => v2([1, '2024-01-01', minor, code, 'x']);
const rates = (base, table) => JSON.stringify({base, rates: table});

test('converts a mixed ledger into every currency (req 9, 10)', () => {
  const dir = ws({'ledger.json': MIX, 'rates.json': R1});
  const want = {BHD: '65.592', CHF: '153.91', EUR: '160.26', GBP: '138.02', JPY: '26406', KRW: '234718', KWD: '53.634', USD: '174.45'};
  for (const [code, amount] of Object.entries(want)) ok(cli(dir, 'balance', '--in', code), code + ' ' + amount + '\n');
});

test('--rates selects the rates file relative to the current directory (req 9)', () => {
  const dir = ws({'ledger.json': MIX, 'conf/fx.json': R1});
  ok(cli(dir, 'balance', '--in', 'EUR', '--rates', 'conf/fx.json'), 'EUR 160.26\n');
  ok(cli(dir, 'balance', '--rates=conf/fx.json', '--in=JPY'), 'JPY 26406\n');
  fails(cli(dir, 'balance', '--in', 'EUR'), 1, 'cannot read rates file');
  ok(cli(dir, 'balance'), 'BHD 5.005\nCHF 23.75\nEUR 100.00\nGBP -45.99\nJPY -1500\nKRW 120000\nKWD -1.255\nUSD 8.30\n');
});

test('ties that binary floating point gets wrong (req 10)', () => {
  const cases = [['USD', 225000, 'EUR', 'EUR 2067.08'], ['USD', 265000, 'CHF', 'CHF 2338.10'], ['USD', 71875, 'GBP', 'GBP 568.68'],
    ['USD', 73125, 'GBP', 'GBP 578.56'], ['USD', 500000, 'EUR', 'EUR 4593.50'], ['USD', 5000, 'EUR', 'EUR 45.94'], ['USD', -265000, 'CHF', 'CHF -2338.10']];
  for (const [code, minor, target, line] of cases) ok(cli(ws({'ledger.json': one(code, minor), 'rates.json': R1}), 'balance', '--in', target), line + '\n');
});

test('round half to even, once, on the exact total (req 10)', () => {
  const half = rates('USD', {EUR: '0.5', KWD: '0.5', JPY: '0.5'});
  const cases = [
    [[['USD', 1]], 'EUR', 'EUR 0.00'], [[['USD', 3]], 'EUR', 'EUR 0.02'], [[['USD', 5]], 'EUR', 'EUR 0.02'], [[['USD', 7]], 'EUR', 'EUR 0.04'],
    [[['USD', -3]], 'EUR', 'EUR -0.02'], [[['USD', -5]], 'EUR', 'EUR -0.02'], [[['USD', -1]], 'EUR', 'EUR 0.00'],
    [[['USD', 100]], 'JPY', 'JPY 0'], [[['USD', 300]], 'JPY', 'JPY 2'], [[['USD', 500]], 'JPY', 'JPY 2'], [[['USD', -300]], 'JPY', 'JPY -2'],
    [[['USD', 1]], 'KWD', 'KWD 0.005'],
    [[['USD', 1], ['KWD', 5]], 'EUR', 'EUR 0.01'], [[['USD', 1], ['USD', 1]], 'EUR', 'EUR 0.01'],
    [[['USD', 1], ['USD', 1], ['USD', 1]], 'EUR', 'EUR 0.02'], [[['KWD', 5], ['JPY', 1], ['USD', -2]], 'EUR', 'EUR 1.00'],
    [[['USD', 300], ['USD', -100]], 'JPY', 'JPY 1'], [[['KWD', 3], ['USD', 1], ['JPY', 0]], 'EUR', 'EUR 0.01'],
  ];
  for (const [rows, target, line] of cases) {
    const ledger = v2(...rows.map(([code, minor], i) => [i + 1, '2024-01-01', minor, code, 'x']));
    ok(cli(ws({'ledger.json': ledger, 'rates.json': half}), 'balance', '--in', target), line + '\n');
  }
});

test('exact division through the base currency (req 10)', () => {
  const thirds = rates('USD', {KWD: '3', EUR: '9', GBP: '15'});
  for (const [minor, target, line] of [[5, 'EUR', 'EUR 0.02'], [5, 'GBP', 'GBP 0.02'], [-5, 'EUR', 'EUR -0.02'], [1, 'EUR', 'EUR 0.00'], [7, 'GBP', 'GBP 0.04']])
    ok(cli(ws({'ledger.json': one('KWD', minor), 'rates.json': thirds}), 'balance', '--in', target), line + '\n');
  const above = rates('USD', {KWD: '2.' + '9'.repeat(28), EUR: '1'});
  const below = rates('USD', {KWD: '3.' + '0'.repeat(27) + '1', EUR: '1'});
  ok(cli(ws({'ledger.json': one('KWD', 75), 'rates.json': above}), 'balance', '--in', 'EUR'), 'EUR 0.03\n');
  ok(cli(ws({'ledger.json': one('KWD', 45), 'rates.json': above}), 'balance', '--in', 'EUR'), 'EUR 0.02\n');
  ok(cli(ws({'ledger.json': one('KWD', 45), 'rates.json': below}), 'balance', '--in', 'EUR'), 'EUR 0.01\n');
  ok(cli(ws({'ledger.json': one('KWD', -45), 'rates.json': below}), 'balance', '--in', 'EUR'), 'EUR -0.01\n');
});

test('large totals convert exactly (req 10)', () => {
  const max = 9007199254740991;
  const ledger = v2([1, '2024-01-01', max, 'USD', 'a'], [2, '2024-01-01', max, 'USD', 'b'], [3, '2024-01-01', max, 'USD', 'c']);
  ok(cli(ws({'ledger.json': ledger, 'rates.json': rates('USD', {EUR: '0.5'})}), 'balance', '--in', 'EUR'), 'EUR 135107988821114.86\n');
  ok(cli(ws({'ledger.json': ledger, 'rates.json': R1}), 'balance', '--in', 'JPY'), 'JPY 40902592535704314\n');
});

test('any base currency, base rate 1, empty ledger (req 9, 10)', () => {
  const eur = rates('EUR', {USD: '1.08', JPY: '162.5'});
  ok(cli(ws({'ledger.json': one('USD', 1080), 'rates.json': eur}), 'balance', '--in', 'EUR'), 'EUR 10.00\n');
  ok(cli(ws({'ledger.json': one('EUR', 1000), 'rates.json': eur}), 'balance', '--in', 'USD'), 'USD 10.80\n');
  ok(cli(ws({'ledger.json': one('JPY', 1000), 'rates.json': eur}), 'balance', '--in', 'USD'), 'USD 6.65\n');
  ok(cli(ws({'ledger.json': one('EUR', 1), 'rates.json': eur}), 'balance', '--in', 'EUR'), 'EUR 0.01\n');
  const empty = ws({'rates.json': R1});
  ok(cli(empty, 'balance', '--in', 'EUR'), 'EUR 0.00\n');
  ok(cli(empty, 'balance', '--in', 'JPY'), 'JPY 0\n');
  ok(cli(ws({'ledger.json': v2(), 'rates.json': R1}), 'balance', '--in', 'BHD'), 'BHD 0.000\n');
});

test('rates file errors (req 9, 11)', () => {
  const ledger = one('USD', 100);
  fails(cli(ws({'ledger.json': ledger}), 'balance', '--in', 'USD'), 1, 'cannot read rates file');
  fails(cli(ws({'ledger.json': ledger}), 'balance', '--in', 'xyz'), 1, 'unknown currency: xyz');
  fails(cli(ws({'ledger.json': ledger, 'rates.json': R1}), 'balance', '--in', 'EUR', '--rates', 'nope.json'), 1, 'cannot read rates file');
  const bad = ['nope', '[]', 'null', '"USD"', '{"base":"USD"}', '{"rates":{"EUR":"1"}}', '{"base":"XAU","rates":{}}', '{"base":"usd","rates":{}}',
    '{"base":"USD","rates":[]}', '{"base":"USD","rates":"EUR"}', '{"base":"USD","rates":{"EUR":0.9}}', '{"base":"USD","rates":{"EUR":"0.9","BHD":0.376}}',
    '{"base":"USD","rates":{"EUR":"0"}}', '{"base":"USD","rates":{"EUR":"0.000"}}', '{"base":"USD","rates":{"EUR":"-1"}}',
    '{"base":"USD","rates":{"EUR":"1e3"}}', '{"base":"USD","rates":{"EUR":".5"}}', '{"base":"USD","rates":{"EUR":"5."}}',
    '{"base":"USD","rates":{"EUR":""}}', '{"base":"USD","rates":{"EUR":" 1"}}', '{"base":"USD","rates":{"EUR":"1,5"}}',
    '{"base":"USD","rates":{"EUR":null}}', '{"base":"USD","rates":{"USD":"1","EUR":"0.9"}}'];
  for (const text of bad) {
    fails(cli(ws({'ledger.json': ledger, 'rates.json': text}), 'balance', '--in', 'EUR'), 1, 'invalid rates file');
    fails(cli(ws({'ledger.json': ledger, 'rates.json': text}), 'balance', '--in', 'GBP'), 1, 'invalid rates file');
  }
  ok(cli(ws({'ledger.json': ledger, 'rates.json': '{"base":"USD","rates":{"EUR":"00.50","XAU":-1,"eur":"x","ZZZ":{},"Usd":[]}}'}), 'balance', '--in', 'EUR'), 'EUR 0.50\n');
});

test('missing rates are reported for the target first, then in code order (req 11)', () => {
  const eur = rates('EUR', {USD: '1.08'});
  const ledger = v2([1, '2024-01-01', 5, 'KWD', 'a'], [2, '2024-01-01', 5, 'JPY', 'b'], [3, '2024-01-01', 5, 'CHF', 'c'], [4, '2024-01-01', 5, 'USD', 'd']);
  const dir = ws({'ledger.json': ledger, 'rates.json': eur});
  fails(cli(dir, 'balance', '--in', 'GBP'), 1, 'no rate for GBP');
  fails(cli(dir, 'balance', '--in', 'USD'), 1, 'no rate for CHF');
  fails(cli(dir, 'balance', '--in', 'EUR'), 1, 'no rate for CHF');
  fails(cli(ws({'rates.json': eur}), 'balance', '--in', 'KRW'), 1, 'no rate for KRW');
  const zero = v2([1, '2024-01-01', 100, 'USD', 'a'], [2, '2024-01-01', 100, 'JPY', 'b'], [3, '2024-01-01', -100, 'JPY', 'c']);
  fails(cli(ws({'ledger.json': zero, 'rates.json': rates('USD', {EUR: '0.9'})}), 'balance', '--in', 'EUR'), 1, 'no rate for JPY');
  ok(cli(ws({'ledger.json': zero, 'rates.json': rates('USD', {EUR: '0.9', JPY: '150'})}), 'balance', '--in', 'EUR'), 'EUR 0.90\n');
});
`;

const HIDDEN_EXPORT = String.raw`
const SPECIAL = v2([1, '2024-01-01', 1250, 'USD', 'Plain'], [2, '2024-01-02', -1500, 'JPY', 'Comma, inside'],
  [3, '2024-01-03', 1250, 'KWD', 'Say "hi"'], [4, '2024-01-04', -5, 'BHD', 'Line1\nLine2'], [5, '2024-01-05', 0, 'EUR', 'CR\rhere'],
  [6, '2024-01-06', 7, 'GBP', ' padded '], [7, '2024-01-07', 100, 'CHF', 'semi;colon \'single\''], [8, '2024-01-08', 3, 'KRW', '"'],
  [9, '2024-01-09', -99, 'USD', 'a,"b",c\r\nd']);

test('CSV export: currency column, CRLF records, RFC 4180 quoting (req 12)', () => {
  const dir = ws({'ledger.json': SPECIAL});
  const want = 'id,date,amount,currency,description\r\n' +
    '1,2024-01-01,12.50,USD,Plain\r\n' +
    '2,2024-01-02,-1500,JPY,"Comma, inside"\r\n' +
    '3,2024-01-03,1.250,KWD,"Say ""hi"""\r\n' +
    '4,2024-01-04,-0.005,BHD,"Line1\nLine2"\r\n' +
    '5,2024-01-05,0.00,EUR,"CR\rhere"\r\n' +
    '6,2024-01-06,0.07,GBP, padded \r\n' +
    '7,2024-01-07,1.00,CHF,semi;colon \'single\'\r\n' +
    '8,2024-01-08,3,KRW,""""\r\n' +
    '9,2024-01-09,-0.99,USD,"a,""b"",c\r\nd"\r\n';
  const csv = cli(dir, 'export');
  assert.equal(csv.status, 0);
  assert.equal(csv.raw, want);
  assert.equal(cli(dir, 'export', '--format', 'csv').raw, want);
  assert.equal(cli(dir, 'export', '--format=csv').raw, want);
});

test('JSON export fields (req 13)', () => {
  const r = cli(ws({'ledger.json': SPECIAL}), 'export', '--format', 'json');
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.raw), [
    {id: 1, date: '2024-01-01', amount: '12.50', currency: 'USD', minor: 1250, description: 'Plain'},
    {id: 2, date: '2024-01-02', amount: '-1500', currency: 'JPY', minor: -1500, description: 'Comma, inside'},
    {id: 3, date: '2024-01-03', amount: '1.250', currency: 'KWD', minor: 1250, description: 'Say "hi"'},
    {id: 4, date: '2024-01-04', amount: '-0.005', currency: 'BHD', minor: -5, description: 'Line1\nLine2'},
    {id: 5, date: '2024-01-05', amount: '0.00', currency: 'EUR', minor: 0, description: 'CR\rhere'},
    {id: 6, date: '2024-01-06', amount: '0.07', currency: 'GBP', minor: 7, description: ' padded '},
    {id: 7, date: '2024-01-07', amount: '1.00', currency: 'CHF', minor: 100, description: 'semi;colon \'single\''},
    {id: 8, date: '2024-01-08', amount: '3', currency: 'KRW', minor: 3, description: '"'},
    {id: 9, date: '2024-01-09', amount: '-0.99', currency: 'USD', minor: -99, description: 'a,"b",c\r\nd'}]);
  const big = cli(ws({'ledger.json': v2([1, '2024-01-01', 9007199254740991, 'KWD', 'big'])}), 'export', '--format', 'json');
  assert.deepEqual(JSON.parse(big.raw), [{id: 1, date: '2024-01-01', amount: '9007199254740.991', currency: 'KWD', minor: 9007199254740991, description: 'big'}]);
});
`;

const HIDDEN = {storage: HIDDEN_STORAGE, display: HIDDEN_DISPLAY, conversion: HIDDEN_CONVERSION, export: HIDDEN_EXPORT};

// ---------------------------------------------------------------- forbidden variants for the self-test

/** Replace one exact snippet in a workspace file; a snippet that is not there would make the variant a silent no-op. */
function patch(root, name, from, to) {
  const text = read(root, name);
  if (!text.includes(from)) throw Error(`${name}: snippet not found: ${from}`);
  writeTree(root, {[name]: text.replace(from, to)});
}

const FLOAT_CONVERT = String.raw`import {MINOR_UNITS} from './currencies.js';

export function convert(sums, target, rates) {
  const rate = code => Number(rates.get(code).num) / Number(rates.get(code).den);
  let value = 0;
  for (const [code, minor] of sums) value += Number(minor) / 10 ** MINOR_UNITS[code] * rate(target) / rate(code);
  const scaled = value * 10 ** MINOR_UNITS[target];
  const floor = Math.floor(scaled), rest = scaled - floor;
  return BigInt(rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor);
}
`;

// Divides by the source rate first at a fixed 20-digit precision, then multiplies: right for everyday rates, not exact.
const FIXED_PRECISION_CONVERT = CONVERT.replace(/export function convert[\s\S]*$/, String.raw`export function convert(sums, target, rates) {
  const SCALE = 10n ** 20n, rt = rates.get(target);
  let base = 0n;
  for (const [code, minor] of sums) {
    const rx = rates.get(code);
    base += minor * rx.den * SCALE / (10n ** BigInt(MINOR_UNITS[code]) * rx.num);
  }
  return roundHalfEven(base * rt.num * 10n ** BigInt(MINOR_UNITS[target]), rt.den * SCALE);
}
`);

const mustReject = [
  // 1. binary floating point conversion (with a correct-looking half-to-even step)
  root => writeTree(root, {'src/convert.js': FLOAT_CONVERT}),
  // 2. `list` migrates a version 1 file on read
  root => {
    patch(root, 'src/commands/list.js', "import {load} from '../store.js';", "import {load, save} from '../store.js';\nimport {existsSync} from 'node:fs';");
    patch(root, 'src/commands/list.js', 'return load(file).entries', 'const ledger = load(file);\n  if (existsSync(file)) save(file, ledger);\n  return ledger.entries');
  },
  // 3. an existing test edited to fit the new behavior
  root => patch(root, 'test/cli.test.js', "assert.match(lines[0], /^#1 2024-01-05 12\\.50 .*Coffee beans$/);", "assert.match(lines[0], /^#1 2024-01-05 12\\.50 USD Coffee beans$/);"),
  // 4. docs/CLI.md left at version 1
  root => writeTree(root, {'docs/CLI.md': DOCS_V1}),
  // 5. rounding each currency's converted total before summing
  root => patch(root, 'src/convert.js', '    num = num * d + n * den;\n    den *= d;\n  }\n  return roundHalfEven(num * 10n ** BigInt(MINOR_UNITS[target]), den);',
    '    num += roundHalfEven(n * 10n ** BigInt(MINOR_UNITS[target]), d);\n  }\n  return num;'),
  // 6. half up instead of half to even
  root => patch(root, 'src/convert.js', '(twice === den && quotient % 2n === 1n)', 'twice === den'),
  // 7. fixed-precision division instead of exact arithmetic
  root => writeTree(root, {'src/convert.js': FIXED_PRECISION_CONVERT}),
  // 8. balance totals summed as Numbers
  root => patch(root, 'src/ledger.js', '(sums.get(entry.currency) ?? 0n) + BigInt(entry.amount)', 'BigInt(Number(sums.get(entry.currency) ?? 0n) + entry.amount)'),
  // 9. CSV records end with LF
  root => patch(root, 'src/csv.js', "+ '\\r\\n'", "+ '\\n'"),
  // 10. CSV quotes commas only, without doubling inner quotes (the old behavior)
  root => patch(root, 'src/csv.js', `/[",\\r\\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"'`, `text.includes(',') ? '"' + text + '"'`),
  // 11. balance lines in insertion order
  root => patch(root, 'src/ledger.js', 'new Map([...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))', 'sums'),
  // 12. currency lookup that accepts inherited properties ("constructor", "toString")
  root => patch(root, 'src/currencies.js', "typeof code === 'string' && Object.hasOwn(MINOR_UNITS, code)", 'code in MINOR_UNITS'),
  // 13. no rate check for ledger currencies whose total is zero
  root => patch(root, 'src/commands/balance.js', '[target, ...sums.keys()]', '[target, ...[...sums].filter(([, sum]) => sum !== 0n).map(([code]) => code)]'),
  // 14. rates given as JSON numbers accepted
  root => patch(root, 'src/rates.js', "typeof value === 'string' && code !== data.base && RATE.exec(value)", "code !== data.base && RATE.exec(String(value))"),
  // 15. new dependency
  root => patch(root, 'package.json', '"scripts"', '"dependencies": {"big.js": "^6.2.1"},\n  "scripts"'),
];

export default {
  id: 'ledger-currency',
  category: 'long multi-requirement feature',
  prompt: PROMPT,
  setup: root => gitRepo(root, [['Single-currency ledger CLI', FIXTURE]]),
  solve: root => writeTree(root, REFERENCE),
  verify(root, before) {
    const pkg = JSON.parse(read(root, 'package.json'));
    const docs = read(root, 'docs/CLI.md');
    const checks = {
      tests_unchanged: unchanged(before, root, 'test/', {allowAdded: true}),
      no_dependencies: ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].every(key => !Object.keys(pkg[key] ?? {}).length),
      docs_updated: ['--currency', '--in', '--rates'].every(option => docs.includes(option)),
      suite_passes: npm(root, 'test').status === 0,
    };
    const notes = {};
    for (const [name, body] of Object.entries(HIDDEN)) {
      const result = hiddenTests(root, PRELUDE + body, `hidden-${name}.test.mjs`);
      checks[`hidden_${name}`] = result.pass;
      if (!result.pass) notes[name] = result.output;
    }
    return verdict(checks, notes);
  },
  mustReject,
};
