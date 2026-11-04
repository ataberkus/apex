import {rmSync} from 'node:fs';
import path from 'node:path';
import {gitRepo, hiddenTests, literalChars, npm, pathURL, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw templates: they never contain a backtick or "${". In docs, ¤ stands for a backtick.
// literalChars keeps their non-ASCII characters literal under Bun.
const js = (strings, ...values) => literalChars(String.raw(strings, ...values), '£¥€àéÜßïö');
const md = text => literalChars(text, '¤£¥€→').replaceAll('¤', '`');

const README = md(String.raw`# pressdoc

pressdoc renders structured documents (JSON) to plain text: titles, numbered headings, wrapped paragraphs, lists, tables with formatted numbers, money and dates, footnotes, glossary expansions, a table of contents, and documents included from other documents.

This README documents version 1.x. Version 2.0 is in progress; see docs/MIGRATION-2.0.md.

## API (1.x)

¤¤¤js
import {configure, render} from 'pressdoc';
configure({locale: 'de', width: 60});
const text = await render({title: 'Report', blocks: [{type: 'paragraph', text: 'Hello *world*.'}]});
¤¤¤

- ¤configure(options)¤ validates and resolves ¤options¤ (see Options) and replaces the current settings with the result. When validation fails it throws a ¤RenderError¤ and keeps the previous settings. Every call starts from the defaults: options of earlier calls do not carry over.
- ¤getSettings()¤ returns the current resolved settings.
- ¤render(doc)¤ renders a document with the current settings and returns a promise of the text.
- ¤defaults¤ is the resolved default settings object.
- ¤formatNumber(value, decimals = 2)¤, ¤formatMoney(amount, currency)¤ and ¤formatDate(iso)¤ format values with the current settings, exactly as tables and inline markup do.
- ¤slugify(text)¤ turns text into a slug: accents removed, lower case, every run of characters other than ¤a-z0-9¤ replaced by ¤-¤, leading and trailing ¤-¤ removed; ¤section¤ if nothing is left.
- ¤RenderError¤ is the class of every error pressdoc reports about options or documents (¤name¤ ¤'RenderError'¤). Errors thrown by a loader propagate unchanged.

## Options

| option | default | meaning |
| --- | --- | --- |
| ¤locale¤ | ¤'en'¤ | one of ¤en¤, ¤us¤, ¤de¤, ¤fr¤; supplies the defaults of ¤number¤, ¤currencyPosition¤ and ¤dateFormat¤ |
| ¤width¤ | ¤72¤ | line width for wrapping, an integer from 20 to 200 |
| ¤bullet¤ | ¤'-'¤ | bullet of unordered lists: ¤-¤, ¤*¤ or ¤+¤ |
| ¤toc¤ | ¤false¤ | add a table of contents |
| ¤numberHeadings¤ | ¤true¤ | prefix headings with their number |
| ¤number¤ | from locale | ¤{decimal, group}¤ separators, single characters; a partial object overrides only the given keys |
| ¤currencyPosition¤ | from locale | ¤'before'¤ or ¤'after'¤ |
| ¤dateFormat¤ | from locale | ¤YYYY-MM-DD¤, ¤MM/DD/YYYY¤, ¤DD.MM.YYYY¤ or ¤DD/MM/YYYY¤ |
| ¤glossary¤ | ¤{}¤ | term → definition |
| ¤loader¤ | ¤null¤ | ¤async (src) => doc¤, loads included documents |

Locales: ¤en¤ uses ¤.¤ and ¤,¤, currency before, ¤YYYY-MM-DD¤; ¤us¤ the same with ¤MM/DD/YYYY¤; ¤de¤ uses ¤,¤ and ¤.¤, currency after, ¤DD.MM.YYYY¤; ¤fr¤ uses ¤,¤ and a space, currency after, ¤DD/MM/YYYY¤.

Validation stops at the first problem, checking: the options object itself, unknown option names, ¤locale¤, ¤width¤, ¤bullet¤, ¤toc¤, ¤numberHeadings¤, ¤number¤, ¤currencyPosition¤, ¤dateFormat¤, ¤glossary¤, ¤loader¤. ¤undefined¤ values mean "use the default".

## Documents

A document is ¤{title?, blocks}¤. The title is printed upper-cased and underlined with ¤=¤. Blocks are separated by one blank line. Block types:

- ¤heading¤ ¤{level, text}¤, level 1 to 3. Headings are numbered ¤1¤, ¤1.1¤, ¤1.1.1¤ across the whole document, includes included. Level 1 headings are underlined with ¤-¤. Every heading gets a unique slug: the second heading with slug ¤intro¤ gets ¤intro-2¤, the third ¤intro-3¤.
- ¤paragraph¤ ¤{text}¤ and ¤quote¤ ¤{text}¤ (prefixed with ¤> ¤), wrapped to ¤width¤.
- ¤list¤ ¤{items, ordered?}¤.
- ¤table¤ ¤{columns, rows}¤; a column is ¤{key, title?, type?, align?, decimals?, currency?}¤ with type ¤text¤ (default), ¤number¤, ¤money¤ or ¤date¤. Numbers and money are right-aligned by default.
- ¤rule¤ ¤{}¤: a centered ¤* * *¤.
- ¤include¤ ¤{src}¤: the blocks of ¤await loader(src)¤ rendered in place. Including a document that is already being included is an error (¤include cycle: a -> b -> a¤).

With ¤toc¤, a ¤Contents¤ block listing level 1 and 2 headings with their slugs follows the title. Footnotes are listed at the end under ¤Notes¤.

## Inline markup

In paragraph, quote, list item, heading and text cell text:

- ¤*word*¤: emphasis, printed upper-cased.
- ¤{{term}}¤: a glossary term. Its first use in a document is printed ¤term (definition)¤, later uses just ¤term¤. Terms match case-insensitively. An unknown term is an error.
- ¤[^text]¤: a footnote, printed ¤[n]¤. Footnotes are numbered in order of first use in the document; the same text reuses its number.
- ¤{num:1234.5:1}¤, ¤{money:12.5:EUR}¤, ¤{date:2024-02-29}¤: formatted values.

## Formatting

- Numbers: ¤decimals¤ (0 to 6) fraction digits, groups of three digits separated by ¤number.group¤, fraction separated by ¤number.decimal¤, a minus sign only when a non-zero digit is printed.
- Money: currencies are three upper-case letters. USD ¤$¤, EUR ¤€¤, GBP ¤£¤, JPY ¤¥¤ (no decimals), CHF ¤CHF¤; others print their code. With ¤currencyPosition: 'before'¤ the symbol precedes the amount (a space follows multi-letter symbols), with ¤'after'¤ it follows after a space.
- Dates: ¤YYYY-MM-DD¤ input, printed with ¤dateFormat¤.

## CLI

¤pressdoc <file.json> [--locale <name>] [--width <n>] [--toc] [--no-numbers]¤ renders a file to standard output; includes are loaded relative to the file's directory. A ¤RenderError¤ prints ¤pressdoc: <message>¤ to standard error and exits with code 1; bad arguments print the usage line and exit with code 2.
`);

const MIGRATION = md(String.raw`# Migrating to pressdoc 2.0

pressdoc 1.x keeps its configuration in module-level state: ¤configure(options)¤ replaces the current settings and ¤render(doc)¤ renders with whatever was configured last. That makes it impossible to render two documents with different settings at the same time in one process, and even two concurrent ¤render¤ calls with the same settings corrupt each other: footnote numbers, heading numbers, slugs, glossary expansions and include cycle detection are shared. Version 2.0 replaces the global configuration with renderer objects.

This document is the complete specification of what changes in 2.0. Everything it does not change stays exactly as in 1.x: README.md documents 1.x, and where README.md is silent, the 1.x source is the reference.

## Public API

¤src/index.js¤ exports exactly these seven names and nothing else:

| export | in 2.0 |
| --- | --- |
| ¤createRenderer(options)¤ | new |
| ¤DEFAULTS¤ | replaces ¤defaults¤ |
| ¤RenderError¤ | unchanged |
| ¤formatNumber(value, decimals, options)¤ | gains ¤options¤ |
| ¤formatMoney(amount, currency, options)¤ | gains ¤options¤ |
| ¤formatDate(iso, options)¤ | gains ¤options¤ |
| ¤slugify(text)¤ | unchanged |

¤configure¤, ¤getSettings¤, ¤render¤ and ¤defaults¤ are removed: they are not exported, not even as deprecated aliases.

### createRenderer(options)

- ¤options¤ is optional; omitted or ¤undefined¤ means ¤{}¤. It is validated and resolved exactly as 1.x ¤configure(options)¤ did: same rules, same order, same ¤RenderError¤ messages. Validation errors are thrown synchronously by ¤createRenderer¤.
- It returns a frozen object with exactly two own properties, ¤options¤ and ¤render¤.
- ¤renderer.options¤ is the resolved options object, deep-equal to what 1.x ¤getSettings()¤ returned after ¤configure(options)¤. It is frozen, and so is every plain object inside it; functions inside it (the ¤loader¤) are kept as they are.
- ¤renderer.render(doc)¤ returns a promise. It resolves to exactly the string that 1.x ¤render(doc)¤ resolved to after ¤configure(options)¤, or rejects when 1.x rejected: with a ¤RenderError¤ (the 2.0 export) with the same message, or with the very error object a loader threw. The loader is called with the same arguments, in the same order, as in 1.x.
- ¤createRenderer¤ takes a snapshot of its options: mutating ¤options¤, or any object inside it, after the call (adding a glossary term, changing ¤number.decimal¤, ...) does not change the renderer.

### Formatting helpers

¤formatNumber(value, decimals, options)¤, ¤formatMoney(amount, currency, options)¤ and ¤formatDate(iso, options)¤ take an optional last argument ¤options¤ with the same meaning as for ¤createRenderer¤: omitted or ¤undefined¤ means ¤{}¤, that is, the defaults. Each first validates and resolves ¤options¤ exactly like ¤createRenderer¤ (throwing the same errors), then behaves exactly as its 1.x counterpart did after ¤configure(options)¤: same results, same errors. ¤decimals¤ keeps its 1.x default when it is ¤undefined¤.

### DEFAULTS

¤DEFAULTS¤ is deep-equal to 1.x ¤defaults¤. It is frozen, and so is every plain object inside it.

## Independence

- Any number of renderers can exist at the same time. Using one never changes what another one produces, whatever their options and in whatever order they are created and used.
- Renders are independent too. Any number of ¤render¤ calls, on the same renderer or on different ones, may be in progress at the same time, interleaving whenever a loader is awaited. A render never waits for another render to finish, and each one resolves or rejects exactly as it would if it were the only render in progress.
- The formatting helpers' results depend only on their arguments.

## CLI

¤bin/pressdoc.js¤ keeps its exact 1.x behavior: same arguments, same standard output and standard error, same exit codes.

## Tests

The test files under ¤test/¤ have already been rewritten for 2.0.
`);

const PKG = JSON.stringify({name: 'pressdoc', version: '1.4.2', type: 'module', bin: {pressdoc: 'bin/pressdoc.js'}, exports: './src/index.js',
  scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n';
const PKG2 = PKG.replace('"1.4.2"', '"2.0.0-dev"');

// ---------------------------------------------------------------- 1.x sources

const V1 = {
  'src/errors.js': js`/** The class of every error pressdoc reports about options or documents. */
export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderError';
  }
}
`,
  'src/util/object.js': js`export const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const quote = value => JSON.stringify(value);
`,
  'src/options.js': js`import {RenderError} from './errors.js';
import {isPlain, quote} from './util/object.js';

export const PRESETS = {
  en: {number: {decimal: '.', group: ','}, currencyPosition: 'before', dateFormat: 'YYYY-MM-DD'},
  us: {number: {decimal: '.', group: ','}, currencyPosition: 'before', dateFormat: 'MM/DD/YYYY'},
  de: {number: {decimal: ',', group: '.'}, currencyPosition: 'after', dateFormat: 'DD.MM.YYYY'},
  fr: {number: {decimal: ',', group: ' '}, currencyPosition: 'after', dateFormat: 'DD/MM/YYYY'},
};

const KEYS = ['locale', 'width', 'bullet', 'toc', 'numberHeadings', 'number', 'currencyPosition', 'dateFormat', 'glossary', 'loader'];
const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD.MM.YYYY', 'DD/MM/YYYY'];

/** Validate options (first problem wins) and resolve them against the locale preset. */
export function resolveOptions(options = {}) {
  if (!isPlain(options)) throw new RenderError('options must be an object');
  for (const key of Object.keys(options)) {
    if (!KEYS.includes(key)) throw new RenderError('unknown option ' + quote(key));
  }
  const locale = options.locale ?? 'en';
  if (typeof locale !== 'string' || !Object.hasOwn(PRESETS, locale)) throw new RenderError('unknown locale ' + quote(locale));
  const preset = PRESETS[locale];
  const width = options.width ?? 72;
  if (!Number.isInteger(width) || width < 20 || width > 200) throw new RenderError('width must be an integer from 20 to 200');
  const bullet = options.bullet ?? '-';
  if (!['-', '*', '+'].includes(bullet)) throw new RenderError('bullet must be "-", "*" or "+"');
  for (const key of ['toc', 'numberHeadings']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new RenderError(key + ' must be a boolean');
  }
  const number = {...preset.number};
  if (options.number !== undefined) {
    if (!isPlain(options.number)) throw new RenderError('number must be an object');
    for (const key of Object.keys(options.number)) {
      if (key !== 'decimal' && key !== 'group') throw new RenderError('unknown number option ' + quote(key));
      const value = options.number[key];
      if (typeof value !== 'string' || [...value].length !== 1) throw new RenderError('number.' + key + ' must be a single character');
      number[key] = value;
    }
    if (number.decimal === number.group) throw new RenderError('number.decimal and number.group must differ');
  }
  const currencyPosition = options.currencyPosition ?? preset.currencyPosition;
  if (currencyPosition !== 'before' && currencyPosition !== 'after') throw new RenderError('currencyPosition must be "before" or "after"');
  const dateFormat = options.dateFormat ?? preset.dateFormat;
  if (!DATE_FORMATS.includes(dateFormat)) throw new RenderError('unknown dateFormat ' + quote(dateFormat));
  const glossary = {};
  if (options.glossary !== undefined) {
    if (!isPlain(options.glossary)) throw new RenderError('glossary must be an object');
    for (const [term, definition] of Object.entries(options.glossary)) {
      if (!/^[A-Za-z][A-Za-z -]*$/.test(term)) throw new RenderError('invalid glossary term ' + quote(term));
      if (typeof definition !== 'string' || definition === '') throw new RenderError('glossary definition of ' + quote(term) + ' must be a non-empty string');
      glossary[term] = definition;
    }
  }
  const loader = options.loader ?? null;
  if (loader !== null && typeof loader !== 'function') throw new RenderError('loader must be a function');
  return {locale, width, bullet, toc: options.toc ?? false, numberHeadings: options.numberHeadings ?? true, number, currencyPosition, dateFormat, glossary, loader};
}

export const defaults = resolveOptions();
`,
  'src/settings.js': js`import {resolveOptions} from './options.js';
import {clearNumberCache} from './format/number.js';

let current = resolveOptions();

/** Replace the current settings; every call starts from the defaults. */
export function configure(options = {}) {
  current = resolveOptions(options);
  clearNumberCache();
}

export function getSettings() {
  return current;
}
`,
  'src/format/number.js': js`import {RenderError} from '../errors.js';
import {getSettings} from '../settings.js';

// Tables repeat the same values a lot; formatting is cached until the next configure().
const cache = new Map();

export function clearNumberCache() {
  cache.clear();
}

/** Format value with decimals fraction digits and the configured separators. */
export function formatNumber(value, decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RenderError('not a finite number: ' + String(value));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new RenderError('decimals must be an integer from 0 to 6');
  const key = value + '|' + decimals;
  if (cache.has(key)) return cache.get(key);
  const {decimal, group} = getSettings().number;
  const [whole, fraction = ''] = Math.abs(value).toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const sign = value < 0 && /[1-9]/.test(whole + fraction) ? '-' : '';
  const text = sign + grouped + (fraction ? decimal + fraction : '');
  cache.set(key, text);
  return text;
}
`,
  'src/format/money.js': js`import {RenderError} from '../errors.js';
import {getSettings} from '../settings.js';
import {quote} from '../util/object.js';
import {formatNumber} from './number.js';

const CURRENCIES = {USD: ['$', 2], EUR: ['€', 2], GBP: ['£', 2], JPY: ['¥', 0], CHF: ['CHF', 2]};

/** Format an amount of a currency with the configured separators and symbol position. */
export function formatMoney(amount, currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new RenderError('invalid currency ' + quote(currency));
  const [symbol, decimals] = CURRENCIES[currency] ?? [currency, 2];
  if (typeof amount !== 'number') throw new RenderError('not a finite number: ' + String(amount));
  const digits = formatNumber(Math.abs(amount), decimals);
  const sign = amount < 0 && /[1-9]/.test(digits) ? '-' : '';
  if (getSettings().currencyPosition === 'before') return sign + symbol + (symbol.length > 1 ? ' ' : '') + digits;
  return sign + digits + ' ' + symbol;
}
`,
  'src/format/date.js': js`import {RenderError} from '../errors.js';
import {getSettings} from '../settings.js';
import {quote} from '../util/object.js';

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Format a YYYY-MM-DD date with the configured date format. */
export function formatDate(iso) {
  const match = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!match) throw new RenderError('invalid date ' + quote(iso));
  const [, year, month, day] = match;
  if (+month < 1 || +month > 12 || +day < 1 || +day > daysIn(+year, +month)) throw new RenderError('invalid date ' + quote(iso));
  return getSettings().dateFormat.replace('YYYY', year).replace('MM', month).replace('DD', day);
}
`,
  'src/util/wrap.js': js`import {getSettings} from '../settings.js';

/** Greedy word wrap to the configured width. first prefixes the first line, rest every other line. */
export function wrap(text, first = '', rest = first) {
  const {width} = getSettings();
  const lines = [];
  let line = null;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === null) line = first + word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else {
      lines.push(line);
      line = rest + word;
    }
  }
  lines.push(line ?? first.trimEnd());
  return lines.join('\n');
}
`,
  'src/util/pad.js': js`export const pad = (text, width, align) => align === 'right' ? text.padStart(width) : text.padEnd(width);
export const center = (text, width) => ' '.repeat(Math.max(0, Math.floor((width - text.length) / 2))) + text;
`,
  'src/state/slugs.js': js`const used = new Map();

export function resetSlugs() {
  used.clear();
}

export function slugify(text) {
  const slug = String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/** A slug that is unique within the current document. */
export function uniqueSlug(text) {
  const base = slugify(text);
  const count = (used.get(base) ?? 0) + 1;
  used.set(base, count);
  return count === 1 ? base : base + '-' + count;
}
`,
  'src/state/footnotes.js': js`const notes = [];

export function resetFootnotes() {
  notes.length = 0;
}

/** Number of the footnote with this text, assigned on first use. */
export function addFootnote(text) {
  const index = notes.indexOf(text);
  if (index >= 0) return index + 1;
  notes.push(text);
  return notes.length;
}

export function footnotes() {
  return [...notes];
}
`,
  'src/state/glossary.js': js`import {RenderError} from '../errors.js';
import {getSettings} from '../settings.js';
import {quote} from '../util/object.js';

const seen = new Set();

export function resetGlossary() {
  seen.clear();
}

/** First use of a term in a document carries its definition. */
export function expandTerm(term) {
  const {glossary} = getSettings();
  const key = Object.keys(glossary).find(name => name.toLowerCase() === term.toLowerCase());
  if (key === undefined) throw new RenderError('unknown glossary term ' + quote(term));
  if (seen.has(key)) return term;
  seen.add(key);
  return term + ' (' + glossary[key] + ')';
}
`,
  'src/state/headings.js': js`import {uniqueSlug} from './slugs.js';

const counters = [0, 0, 0];
const entries = [];

export function resetHeadings() {
  counters.fill(0);
  entries.length = 0;
}

export function nextHeading(level, text) {
  counters[level - 1]++;
  counters.fill(0, level);
  const number = counters.slice(0, level).join('.');
  const slug = uniqueSlug(text);
  entries.push({level, text, number, slug});
  return {number, slug};
}

export function headingEntries() {
  return entries.map(entry => ({...entry}));
}
`,
  'src/inline.js': js`import {RenderError} from './errors.js';
import {formatDate} from './format/date.js';
import {formatMoney} from './format/money.js';
import {formatNumber} from './format/number.js';
import {addFootnote} from './state/footnotes.js';
import {expandTerm} from './state/glossary.js';

const TOKEN = /\*([^*\s][^*]*?)\*|\{\{([^{}]+)\}\}|\[\^([^\]]+)\]|\{(num|money|date):([^{}]*)\}/g;

/** Expand inline markup, left to right. */
export function renderInline(text) {
  if (typeof text !== 'string') throw new RenderError('text must be a string');
  return text.replace(TOKEN, (match, emphasis, term, note, kind, argument) => {
    if (emphasis !== undefined) return emphasis.toUpperCase();
    if (term !== undefined) return expandTerm(term.trim());
    if (note !== undefined) return '[' + addFootnote(note.trim()) + ']';
    const [first, second] = argument.split(':');
    if (kind === 'num') return formatNumber(Number(first), second === undefined ? 2 : Number(second));
    if (kind === 'money') return formatMoney(Number(first), second);
    return formatDate(first);
  });
}
`,
  'src/blocks/heading.js': js`import {RenderError} from '../errors.js';
import {renderInline} from '../inline.js';
import {getSettings} from '../settings.js';
import {nextHeading} from '../state/headings.js';

export function renderHeading(block) {
  if (![1, 2, 3].includes(block.level)) throw new RenderError('heading level must be 1, 2 or 3');
  const text = renderInline(block.text);
  const {number} = nextHeading(block.level, text);
  const line = (getSettings().numberHeadings ? number + ' ' : '') + text;
  return block.level === 1 ? line + '\n' + '-'.repeat(line.length) : line;
}
`,
  'src/blocks/paragraph.js': js`import {renderInline} from '../inline.js';
import {wrap} from '../util/wrap.js';

export const renderParagraph = block => wrap(renderInline(block.text));

export const renderQuote = block => wrap(renderInline(block.text), '> ');
`,
  'src/blocks/list.js': js`import {RenderError} from '../errors.js';
import {renderInline} from '../inline.js';
import {getSettings} from '../settings.js';
import {wrap} from '../util/wrap.js';

export function renderList(block) {
  if (!Array.isArray(block.items)) throw new RenderError('list items must be an array');
  const ordered = block.ordered === true;
  const width = ordered ? String(block.items.length).length + 2 : 2;
  const {bullet} = getSettings();
  return block.items.map((item, index) => {
    const marker = (ordered ? (index + 1) + '.' : bullet).padEnd(width);
    return wrap(renderInline(item), marker, ' '.repeat(width));
  }).join('\n');
}
`,
  'src/blocks/table.js': js`import {RenderError} from '../errors.js';
import {formatDate} from '../format/date.js';
import {formatMoney} from '../format/money.js';
import {formatNumber} from '../format/number.js';
import {renderInline} from '../inline.js';
import {quote} from '../util/object.js';
import {pad} from '../util/pad.js';

function formatCell(value, column) {
  if (value === undefined || value === null) return '';
  switch (column.type ?? 'text') {
    case 'number': return formatNumber(value, column.decimals ?? 2);
    case 'money': return formatMoney(value, column.currency ?? 'USD');
    case 'date': return formatDate(value);
    case 'text': return renderInline(String(value));
    default: throw new RenderError('unknown column type ' + quote(column.type));
  }
}

export function renderTable(block) {
  const {columns, rows} = block;
  if (!Array.isArray(columns) || columns.length === 0) throw new RenderError('table needs columns');
  if (!Array.isArray(rows)) throw new RenderError('table rows must be an array');
  const header = columns.map(column => String(column.title ?? column.key));
  const cells = rows.map(row => columns.map(column => formatCell(row[column.key], column)));
  const widths = columns.map((column, i) => Math.max(header[i].length, ...cells.map(row => row[i].length)));
  const aligns = columns.map(column => column.align ?? (column.type === 'number' || column.type === 'money' ? 'right' : 'left'));
  const line = row => row.map((cell, i) => pad(cell, widths[i], aligns[i])).join('  ').trimEnd();
  return [line(header), widths.map(width => '-'.repeat(width)).join('  '), ...cells.map(line)].join('\n');
}
`,
  'src/blocks/rule.js': js`import {getSettings} from '../settings.js';
import {center} from '../util/pad.js';

export const renderRule = () => center('* * *', getSettings().width);
`,
  'src/blocks/include.js': js`import {RenderError} from '../errors.js';
import {getSettings} from '../settings.js';
import {isPlain, quote} from '../util/object.js';

// Sources being included right now, outermost first.
const stack = [];

export function resetIncludes() {
  stack.length = 0;
}

export async function renderInclude(block, renderBlocks) {
  const {src} = block;
  if (typeof src !== 'string' || src === '') throw new RenderError('include src must be a non-empty string');
  const {loader} = getSettings();
  if (loader === null) throw new RenderError('include ' + quote(src) + ' needs a loader');
  if (stack.includes(src)) throw new RenderError('include cycle: ' + [...stack.slice(stack.indexOf(src)), src].join(' -> '));
  stack.push(src);
  try {
    const doc = await loader(src);
    if (!isPlain(doc) || !Array.isArray(doc.blocks)) throw new RenderError('include ' + quote(src) + ' did not load a document');
    return await renderBlocks(doc.blocks);
  } finally {
    stack.pop();
  }
}
`,
  'src/blocks/index.js': js`import {RenderError} from '../errors.js';
import {isPlain, quote} from '../util/object.js';
import {renderHeading} from './heading.js';
import {renderInclude} from './include.js';
import {renderList} from './list.js';
import {renderParagraph, renderQuote} from './paragraph.js';
import {renderRule} from './rule.js';
import {renderTable} from './table.js';

const RENDERERS = {heading: renderHeading, paragraph: renderParagraph, quote: renderQuote, list: renderList, table: renderTable, rule: renderRule};

/** Render blocks in order; includes are rendered in place. */
export async function renderBlocks(blocks) {
  const parts = [];
  for (const [index, block] of blocks.entries()) {
    if (!isPlain(block)) throw new RenderError('block ' + index + ' must be an object');
    if (block.type === 'include') {
      const inner = await renderInclude(block, renderBlocks);
      if (inner !== '') parts.push(inner);
      continue;
    }
    if (!Object.hasOwn(RENDERERS, block.type)) throw new RenderError('unknown block type ' + quote(block.type));
    parts.push(RENDERERS[block.type](block));
  }
  return parts.join('\n\n');
}
`,
  'src/toc.js': js`import {getSettings} from './settings.js';
import {headingEntries} from './state/headings.js';

export function renderToc() {
  const entries = headingEntries().filter(entry => entry.level <= 2);
  if (!entries.length) return '';
  const {numberHeadings} = getSettings();
  return ['Contents', ...entries.map(entry => '  '.repeat(entry.level - 1) + (numberHeadings ? entry.number + ' ' : '') + entry.text + ' #' + entry.slug)].join('\n');
}
`,
  'src/render.js': js`import {renderBlocks} from './blocks/index.js';
import {resetIncludes} from './blocks/include.js';
import {RenderError} from './errors.js';
import {getSettings} from './settings.js';
import {footnotes, resetFootnotes} from './state/footnotes.js';
import {resetGlossary} from './state/glossary.js';
import {resetHeadings} from './state/headings.js';
import {resetSlugs} from './state/slugs.js';
import {renderToc} from './toc.js';
import {isPlain} from './util/object.js';
import {wrap} from './util/wrap.js';

/** Render a document with the current settings. */
export async function render(doc) {
  if (!isPlain(doc)) throw new RenderError('document must be an object');
  if (!Array.isArray(doc.blocks)) throw new RenderError('document blocks must be an array');
  if (doc.title !== undefined && typeof doc.title !== 'string') throw new RenderError('document title must be a string');
  resetSlugs();
  resetFootnotes();
  resetHeadings();
  resetGlossary();
  resetIncludes();
  const body = await renderBlocks(doc.blocks);
  const parts = [];
  if (doc.title) {
    const title = doc.title.toUpperCase();
    parts.push(title + '\n' + '='.repeat(title.length));
  }
  if (getSettings().toc) {
    const toc = renderToc();
    if (toc) parts.push(toc);
  }
  if (body) parts.push(body);
  const notes = footnotes();
  if (notes.length) {
    parts.push('Notes\n-----\n' + notes.map((note, i) => wrap(note, '[' + (i + 1) + '] ', ' '.repeat(String(i + 1).length + 3))).join('\n'));
  }
  return parts.join('\n\n') + '\n';
}
`,
  'src/index.js': js`export {configure, getSettings} from './settings.js';
export {render} from './render.js';
export {defaults} from './options.js';
export {RenderError} from './errors.js';
export {formatNumber} from './format/number.js';
export {formatMoney} from './format/money.js';
export {formatDate} from './format/date.js';
export {slugify} from './state/slugs.js';
`,
  'bin/pressdoc.js': js`#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {configure, render, RenderError} from '../src/index.js';

const USAGE = 'usage: pressdoc <file.json> [--locale <name>] [--width <n>] [--toc] [--no-numbers]';

function usage() {
  process.stderr.write(USAGE + '\n');
  process.exitCode = 2;
}

async function main(argv) {
  const options = {};
  let file;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--toc') options.toc = true;
    else if (arg === '--no-numbers') options.numberHeadings = false;
    else if (arg === '--locale' || arg === '--width') {
      const value = argv[++i];
      if (value === undefined) return usage();
      if (arg === '--locale') options.locale = value;
      else options.width = /^\d+$/.test(value) ? Number(value) : value;
    } else if (arg.startsWith('-') || file !== undefined) return usage();
    else file = arg;
  }
  if (file === undefined) return usage();
  const base = path.dirname(path.resolve(file));
  const load = async name => JSON.parse(await readFile(path.resolve(base, name), 'utf8'));
  try {
    configure({...options, loader: load});
    process.stdout.write(await render(await load(path.basename(file))));
  } catch (error) {
    if (!(error instanceof RenderError)) throw error;
    process.stderr.write('pressdoc: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
`,
};

const V1_TEST = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {configure, formatMoney, formatNumber, render} from '../src/index.js';

test('paragraphs wrap', async () => {
  configure({width: 20});
  assert.equal(await render({blocks: [{type: 'paragraph', text: 'one two three four five six seven'}]}), 'one two three four\nfive six seven\n');
});

test('numbers follow the locale', () => {
  configure({locale: 'de'});
  assert.equal(formatNumber(1234567.891), '1.234.567,89');
  assert.equal(formatMoney(-5, 'EUR'), '-5,00 €');
});
`;

// ---------------------------------------------------------------- 2.0 tests (in the fixture) and reference

const VISIBLE_RENDER = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {createRenderer, RenderError} from '../src/index.js';

const doc = {
  title: 'Quarterly report',
  blocks: [
    {type: 'heading', level: 1, text: 'Summary'},
    {type: 'paragraph', text: 'Revenue grew by {num:12.345:1} percent[^Unaudited.] to {money:1234567.5:EUR}.'},
    {type: 'heading', level: 2, text: 'Details'},
    {type: 'table', columns: [{key: 'item', title: 'Item'}, {key: 'amount', title: 'Amount', type: 'money', currency: 'EUR'}],
      rows: [{item: 'Licences', amount: 1200}, {item: 'Support[^Two contracts.]', amount: -80.5}]},
  ],
};

test('renders a document', async () => {
  const text = await createRenderer().render(doc);
  assert.equal(text, [
    'QUARTERLY REPORT',
    '================',
    '',
    '1 Summary',
    '---------',
    '',
    'Revenue grew by 12.3 percent[1] to €1,234,567.50.',
    '',
    '1.1 Details',
    '',
    'Item           Amount',
    '----------  ---------',
    'Licences    €1,200.00',
    'Support[2]    -€80.50',
    '',
    'Notes',
    '-----',
    '[1] Unaudited.',
    '[2] Two contracts.',
    '',
  ].join('\n'));
});

test('renderers keep their own options', async () => {
  const de = createRenderer({locale: 'de', numberHeadings: false});
  const text = await de.render({blocks: [{type: 'heading', level: 1, text: 'Summary'}, {type: 'paragraph', text: 'Costs fell by {num:2.5:1} percent to {money:98765.4:EUR}.'}]});
  assert.equal(text, 'Summary\n-------\n\nCosts fell by 2,5 percent to 98.765,40 €.\n');
  assert.equal(de.options.locale, 'de');
});

test('includes use the loader', async () => {
  const docs = {'intro.json': {blocks: [{type: 'paragraph', text: 'Included.'}]}};
  const renderer = createRenderer({loader: async src => docs[src]});
  assert.equal(await renderer.render({blocks: [{type: 'include', src: 'intro.json'}, {type: 'rule'}]}),
    'Included.\n\n' + ' '.repeat(33) + '* * *\n');
});

test('invalid options throw', () => {
  assert.throws(() => createRenderer({width: 5}), error => error instanceof RenderError && error.message === 'width must be an integer from 20 to 200');
});
`;

const VISIBLE_FORMAT = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDate, formatMoney, formatNumber, slugify} from '../src/index.js';

test('formatNumber takes options', () => {
  assert.equal(formatNumber(1234.5, 1, {locale: 'fr'}), '1 234,5');
  assert.equal(formatNumber(1234.5), '1,234.50');
});

test('formatMoney takes options', () => {
  assert.equal(formatMoney(-5, 'EUR', {locale: 'de'}), '-5,00 €');
  assert.equal(formatMoney(1500, 'JPY'), '¥1,500');
});

test('formatDate takes options', () => {
  assert.equal(formatDate('2024-02-29', {dateFormat: 'DD.MM.YYYY'}), '29.02.2024');
});

test('slugify is unchanged', () => {
  assert.equal(slugify('Déjà vu, again!'), 'deja-vu-again');
});
`;

const V2_FIXTURE_COMMIT = {
  'package.json': PKG2,
  'docs/MIGRATION-2.0.md': MIGRATION,
  'test/render.test.js': VISIBLE_RENDER,
  'test/format.test.js': VISIBLE_FORMAT,
};

const REFERENCE = {
  'src/options.js': V1['src/options.js']
    .replace("import {isPlain, quote} from './util/object.js';", "import {deepFreeze, isPlain, quote} from './util/object.js';")
    .replace('export const defaults = resolveOptions();', '/** Resolved options, frozen; plain objects inside are frozen too, functions are kept. */\nexport const freezeOptions = options => deepFreeze(options);\n\nexport const DEFAULTS = freezeOptions(resolveOptions());'),
  'src/util/object.js': V1['src/util/object.js'] + js`
export function deepFreeze(value) {
  if (isPlain(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
`,
  'src/format/number.js': js`import {RenderError} from '../errors.js';
import {resolveOptions} from '../options.js';

/** Format value with decimals fraction digits and the separators of resolved options. */
export function numberText(options, value, decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RenderError('not a finite number: ' + String(value));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new RenderError('decimals must be an integer from 0 to 6');
  const {decimal, group} = options.number;
  const [whole, fraction = ''] = Math.abs(value).toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const sign = value < 0 && /[1-9]/.test(whole + fraction) ? '-' : '';
  return sign + grouped + (fraction ? decimal + fraction : '');
}

export const formatNumber = (value, decimals, options) => numberText(resolveOptions(options), value, decimals);
`,
  'src/format/money.js': js`import {RenderError} from '../errors.js';
import {resolveOptions} from '../options.js';
import {quote} from '../util/object.js';
import {numberText} from './number.js';

const CURRENCIES = {USD: ['$', 2], EUR: ['€', 2], GBP: ['£', 2], JPY: ['¥', 0], CHF: ['CHF', 2]};

/** Format an amount of a currency with the separators and symbol position of resolved options. */
export function moneyText(options, amount, currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new RenderError('invalid currency ' + quote(currency));
  const [symbol, decimals] = CURRENCIES[currency] ?? [currency, 2];
  if (typeof amount !== 'number') throw new RenderError('not a finite number: ' + String(amount));
  const digits = numberText(options, Math.abs(amount), decimals);
  const sign = amount < 0 && /[1-9]/.test(digits) ? '-' : '';
  if (options.currencyPosition === 'before') return sign + symbol + (symbol.length > 1 ? ' ' : '') + digits;
  return sign + digits + ' ' + symbol;
}

export const formatMoney = (amount, currency, options) => moneyText(resolveOptions(options), amount, currency);
`,
  'src/format/date.js': js`import {RenderError} from '../errors.js';
import {resolveOptions} from '../options.js';
import {quote} from '../util/object.js';

const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Format a YYYY-MM-DD date with the date format of resolved options. */
export function dateText(options, iso) {
  const match = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!match) throw new RenderError('invalid date ' + quote(iso));
  const [, year, month, day] = match;
  if (+month < 1 || +month > 12 || +day < 1 || +day > daysIn(+year, +month)) throw new RenderError('invalid date ' + quote(iso));
  return options.dateFormat.replace('YYYY', year).replace('MM', month).replace('DD', day);
}

export const formatDate = (iso, options) => dateText(resolveOptions(options), iso);
`,
  'src/util/wrap.js': js`/** Greedy word wrap to width. first prefixes the first line, rest every other line. */
export function wrap(width, text, first = '', rest = first) {
  const lines = [];
  let line = null;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === null) line = first + word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else {
      lines.push(line);
      line = rest + word;
    }
  }
  lines.push(line ?? first.trimEnd());
  return lines.join('\n');
}
`,
  'src/state.js': js`/** Everything one render tracks: its options plus per-document numbering. */
export const createState = options => ({options, slugs: new Map(), notes: [], counters: [0, 0, 0], headings: [], seenTerms: new Set(), includes: []});
`,
  'src/state/slugs.js': js`export function slugify(text) {
  const slug = String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'section';
}

/** A slug that is unique within the render. */
export function uniqueSlug(state, text) {
  const base = slugify(text);
  const count = (state.slugs.get(base) ?? 0) + 1;
  state.slugs.set(base, count);
  return count === 1 ? base : base + '-' + count;
}
`,
  'src/state/footnotes.js': js`/** Number of the footnote with this text, assigned on first use within the render. */
export function addFootnote(state, text) {
  const index = state.notes.indexOf(text);
  if (index >= 0) return index + 1;
  state.notes.push(text);
  return state.notes.length;
}
`,
  'src/state/glossary.js': js`import {RenderError} from '../errors.js';
import {quote} from '../util/object.js';

/** First use of a term in a render carries its definition. */
export function expandTerm(state, term) {
  const {glossary} = state.options;
  const key = Object.keys(glossary).find(name => name.toLowerCase() === term.toLowerCase());
  if (key === undefined) throw new RenderError('unknown glossary term ' + quote(term));
  if (state.seenTerms.has(key)) return term;
  state.seenTerms.add(key);
  return term + ' (' + glossary[key] + ')';
}
`,
  'src/state/headings.js': js`import {uniqueSlug} from './slugs.js';

export function nextHeading(state, level, text) {
  const {counters} = state;
  counters[level - 1]++;
  counters.fill(0, level);
  const number = counters.slice(0, level).join('.');
  const slug = uniqueSlug(state, text);
  state.headings.push({level, text, number, slug});
  return {number, slug};
}
`,
  'src/inline.js': js`import {RenderError} from './errors.js';
import {dateText} from './format/date.js';
import {moneyText} from './format/money.js';
import {numberText} from './format/number.js';
import {addFootnote} from './state/footnotes.js';
import {expandTerm} from './state/glossary.js';

const TOKEN = /\*([^*\s][^*]*?)\*|\{\{([^{}]+)\}\}|\[\^([^\]]+)\]|\{(num|money|date):([^{}]*)\}/g;

/** Expand inline markup, left to right. */
export function renderInline(state, text) {
  if (typeof text !== 'string') throw new RenderError('text must be a string');
  return text.replace(TOKEN, (match, emphasis, term, note, kind, argument) => {
    if (emphasis !== undefined) return emphasis.toUpperCase();
    if (term !== undefined) return expandTerm(state, term.trim());
    if (note !== undefined) return '[' + addFootnote(state, note.trim()) + ']';
    const [first, second] = argument.split(':');
    if (kind === 'num') return numberText(state.options, Number(first), second === undefined ? 2 : Number(second));
    if (kind === 'money') return moneyText(state.options, Number(first), second);
    return dateText(state.options, first);
  });
}
`,
  'src/blocks/heading.js': js`import {RenderError} from '../errors.js';
import {renderInline} from '../inline.js';
import {nextHeading} from '../state/headings.js';

export function renderHeading(state, block) {
  if (![1, 2, 3].includes(block.level)) throw new RenderError('heading level must be 1, 2 or 3');
  const text = renderInline(state, block.text);
  const {number} = nextHeading(state, block.level, text);
  const line = (state.options.numberHeadings ? number + ' ' : '') + text;
  return block.level === 1 ? line + '\n' + '-'.repeat(line.length) : line;
}
`,
  'src/blocks/paragraph.js': js`import {renderInline} from '../inline.js';
import {wrap} from '../util/wrap.js';

export const renderParagraph = (state, block) => wrap(state.options.width, renderInline(state, block.text));

export const renderQuote = (state, block) => wrap(state.options.width, renderInline(state, block.text), '> ');
`,
  'src/blocks/list.js': js`import {RenderError} from '../errors.js';
import {renderInline} from '../inline.js';
import {wrap} from '../util/wrap.js';

export function renderList(state, block) {
  if (!Array.isArray(block.items)) throw new RenderError('list items must be an array');
  const ordered = block.ordered === true;
  const width = ordered ? String(block.items.length).length + 2 : 2;
  const {bullet} = state.options;
  return block.items.map((item, index) => {
    const marker = (ordered ? (index + 1) + '.' : bullet).padEnd(width);
    return wrap(state.options.width, renderInline(state, item), marker, ' '.repeat(width));
  }).join('\n');
}
`,
  'src/blocks/table.js': js`import {RenderError} from '../errors.js';
import {dateText} from '../format/date.js';
import {moneyText} from '../format/money.js';
import {numberText} from '../format/number.js';
import {renderInline} from '../inline.js';
import {quote} from '../util/object.js';
import {pad} from '../util/pad.js';

function formatCell(state, value, column) {
  if (value === undefined || value === null) return '';
  switch (column.type ?? 'text') {
    case 'number': return numberText(state.options, value, column.decimals ?? 2);
    case 'money': return moneyText(state.options, value, column.currency ?? 'USD');
    case 'date': return dateText(state.options, value);
    case 'text': return renderInline(state, String(value));
    default: throw new RenderError('unknown column type ' + quote(column.type));
  }
}

export function renderTable(state, block) {
  const {columns, rows} = block;
  if (!Array.isArray(columns) || columns.length === 0) throw new RenderError('table needs columns');
  if (!Array.isArray(rows)) throw new RenderError('table rows must be an array');
  const header = columns.map(column => String(column.title ?? column.key));
  const cells = rows.map(row => columns.map(column => formatCell(state, row[column.key], column)));
  const widths = columns.map((column, i) => Math.max(header[i].length, ...cells.map(row => row[i].length)));
  const aligns = columns.map(column => column.align ?? (column.type === 'number' || column.type === 'money' ? 'right' : 'left'));
  const line = row => row.map((cell, i) => pad(cell, widths[i], aligns[i])).join('  ').trimEnd();
  return [line(header), widths.map(width => '-'.repeat(width)).join('  '), ...cells.map(line)].join('\n');
}
`,
  'src/blocks/rule.js': js`import {center} from '../util/pad.js';

export const renderRule = state => center('* * *', state.options.width);
`,
  'src/blocks/include.js': js`import {RenderError} from '../errors.js';
import {isPlain, quote} from '../util/object.js';

export async function renderInclude(state, block, renderBlocks) {
  const {src} = block;
  if (typeof src !== 'string' || src === '') throw new RenderError('include src must be a non-empty string');
  const {loader} = state.options;
  if (loader === null) throw new RenderError('include ' + quote(src) + ' needs a loader');
  const stack = state.includes;
  if (stack.includes(src)) throw new RenderError('include cycle: ' + [...stack.slice(stack.indexOf(src)), src].join(' -> '));
  stack.push(src);
  try {
    const doc = await loader(src);
    if (!isPlain(doc) || !Array.isArray(doc.blocks)) throw new RenderError('include ' + quote(src) + ' did not load a document');
    return await renderBlocks(state, doc.blocks);
  } finally {
    stack.pop();
  }
}
`,
  'src/blocks/index.js': js`import {RenderError} from '../errors.js';
import {isPlain, quote} from '../util/object.js';
import {renderHeading} from './heading.js';
import {renderInclude} from './include.js';
import {renderList} from './list.js';
import {renderParagraph, renderQuote} from './paragraph.js';
import {renderRule} from './rule.js';
import {renderTable} from './table.js';

const RENDERERS = {heading: renderHeading, paragraph: renderParagraph, quote: renderQuote, list: renderList, table: renderTable, rule: renderRule};

/** Render blocks in order; includes are rendered in place. */
export async function renderBlocks(state, blocks) {
  const parts = [];
  for (const [index, block] of blocks.entries()) {
    if (!isPlain(block)) throw new RenderError('block ' + index + ' must be an object');
    if (block.type === 'include') {
      const inner = await renderInclude(state, block, renderBlocks);
      if (inner !== '') parts.push(inner);
      continue;
    }
    if (!Object.hasOwn(RENDERERS, block.type)) throw new RenderError('unknown block type ' + quote(block.type));
    parts.push(RENDERERS[block.type](state, block));
  }
  return parts.join('\n\n');
}
`,
  'src/toc.js': js`export function renderToc(state) {
  const entries = state.headings.filter(entry => entry.level <= 2);
  if (!entries.length) return '';
  const {numberHeadings} = state.options;
  return ['Contents', ...entries.map(entry => '  '.repeat(entry.level - 1) + (numberHeadings ? entry.number + ' ' : '') + entry.text + ' #' + entry.slug)].join('\n');
}
`,
  'src/render.js': js`import {renderBlocks} from './blocks/index.js';
import {RenderError} from './errors.js';
import {createState} from './state.js';
import {renderToc} from './toc.js';
import {isPlain} from './util/object.js';
import {wrap} from './util/wrap.js';

/** Render a document with resolved options; all per-document state lives in this call. */
export async function renderDocument(options, doc) {
  if (!isPlain(doc)) throw new RenderError('document must be an object');
  if (!Array.isArray(doc.blocks)) throw new RenderError('document blocks must be an array');
  if (doc.title !== undefined && typeof doc.title !== 'string') throw new RenderError('document title must be a string');
  const state = createState(options);
  const body = await renderBlocks(state, doc.blocks);
  const parts = [];
  if (doc.title) {
    const title = doc.title.toUpperCase();
    parts.push(title + '\n' + '='.repeat(title.length));
  }
  if (options.toc) {
    const toc = renderToc(state);
    if (toc) parts.push(toc);
  }
  if (body) parts.push(body);
  if (state.notes.length) {
    parts.push('Notes\n-----\n' + state.notes.map((note, i) => wrap(options.width, note, '[' + (i + 1) + '] ', ' '.repeat(String(i + 1).length + 3))).join('\n'));
  }
  return parts.join('\n\n') + '\n';
}
`,
  'src/renderer.js': js`import {freezeOptions, resolveOptions} from './options.js';
import {renderDocument} from './render.js';

/** A renderer with a frozen snapshot of its resolved options. */
export function createRenderer(options) {
  const resolved = freezeOptions(resolveOptions(options));
  return Object.freeze({options: resolved, render: doc => renderDocument(resolved, doc)});
}
`,
  'src/index.js': js`export {createRenderer} from './renderer.js';
export {DEFAULTS} from './options.js';
export {RenderError} from './errors.js';
export {formatNumber} from './format/number.js';
export {formatMoney} from './format/money.js';
export {formatDate} from './format/date.js';
export {slugify} from './state/slugs.js';
`,
  'bin/pressdoc.js': V1['bin/pressdoc.js']
    .replace("import {configure, render, RenderError} from '../src/index.js';", "import {createRenderer, RenderError} from '../src/index.js';")
    .replace("    configure({...options, loader: load});\n    process.stdout.write(await render(await load(path.basename(file))));",
      "    const renderer = createRenderer({...options, loader: load});\n    process.stdout.write(await renderer.render(await load(path.basename(file))));"),
};

// ---------------------------------------------------------------- hidden verification

const HIDDEN = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const v2 = await import('@ROOT@src/index.js');
const v1 = await import('@ORIG@src/index.js');
const ROOT = fileURLToPath('@ROOT@');
const ORIG = fileURLToPath('@ORIG@');

const ticks = async n => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

const LIBRARY = {
  'intro.json': {blocks: [
    {type: 'heading', level: 2, text: 'Background'},
    {type: 'paragraph', text: 'The {{API}} changed[^See the changelog.] and the {{api}} docs moved. Prices start at {money:9.99:USD}.'},
  ]},
  'nested.json': {blocks: [
    {type: 'include', src: 'intro.json'},
    {type: 'heading', level: 1, text: 'Background'},
    {type: 'list', items: ['First {{SLA}} item[^See the changelog.]', 'Second[^New note.]']},
  ]},
  'figures.json': {blocks: [
    {type: 'table', columns: [
      {key: 'name', title: 'Name'}, {key: 'qty', title: 'Qty', type: 'number', decimals: 0},
      {key: 'price', title: 'Price', type: 'money', currency: 'EUR'}, {key: 'total', type: 'money', currency: 'CHF'},
      {key: 'due', title: 'Due', type: 'date'}, {key: 'ratio', title: 'Ratio', type: 'number', decimals: 3, align: 'left'},
    ], rows: [
      {name: 'Widget *pro*', qty: 1234567, price: 1999.995, total: -0.004, due: '2024-02-29', ratio: 0.1 + 0.2},
      {name: 'Gadget[^Discontinued.]', qty: -12, price: 0.5, total: 123456.789, due: '1999-12-31', ratio: -1234.5678},
      {name: 'Empty', qty: null},
    ]},
  ]},
  'cycle-a.json': {blocks: [{type: 'paragraph', text: 'A'}, {type: 'include', src: 'cycle-b.json'}]},
  'cycle-b.json': {blocks: [{type: 'include', src: 'cycle-c.json'}]},
  'cycle-c.json': {blocks: [{type: 'include', src: 'cycle-a.json'}]},
  'twice.json': {blocks: [{type: 'include', src: 'intro.json'}, {type: 'include', src: 'intro.json'}]},
  'empty.json': {blocks: []},
  'broken.json': {nothing: true},
};

const loaderError = new Error('loader exploded');
function makeLoader(log) {
  return async src => {
    log?.push(src);
    await ticks(src.length % 5 + 1);
    if (src === 'explode.json') throw loaderError;
    return structuredClone(LIBRARY[src]);
  };
}

const LONG = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco.';
const DOCS = [
  {title: 'Annual Report 2024', blocks: [
    {type: 'heading', level: 1, text: 'Overview'},
    {type: 'paragraph', text: LONG + ' The {{API}} is stable[^Since version 3.] and fast[^Measured.].'},
    {type: 'heading', level: 2, text: 'Overview'},
    {type: 'heading', level: 3, text: 'Overview'},
    {type: 'heading', level: 2, text: 'Déjà vu: the *sequel*'},
    {type: 'quote', text: LONG},
    {type: 'list', ordered: true, items: Array.from({length: 11}, (_, i) => 'Item ' + i + (i === 3 ? ' ' + LONG : '') + (i === 5 ? '[^Since version 3.]' : ''))},
    {type: 'rule'},
    {type: 'heading', level: 1, text: '!!!'},
    {type: 'heading', level: 1, text: ''},
  ]},
  {title: 'Includes', blocks: [
    {type: 'paragraph', text: 'Before {{sla}} and {{Api}}.'},
    {type: 'include', src: 'nested.json'},
    {type: 'include', src: 'empty.json'},
    {type: 'heading', level: 2, text: 'Background'},
    {type: 'include', src: 'twice.json'},
    {type: 'include', src: 'figures.json'},
  ]},
  {blocks: [{type: 'include', src: 'figures.json'}, {type: 'paragraph', text: 'Inline {num:-0.004:2} {num:1e21:0} {num:2.5:0} {money:-1234.5:GBP} {money:7:JPY} {money:3.333:XYZ} {date:2000-01-09}'}]},
  {title: '', blocks: [{type: 'list', items: ['a', '*b* c', LONG]}, {type: 'paragraph', text: ''}]},
  {blocks: []},
  {title: 'Unicode Größe', blocks: [{type: 'heading', level: 1, text: 'Ünïcödé'}, {type: 'heading', level: 1, text: 'Unicode'}, {type: 'paragraph', text: '{{glossary term}} {{GLOSSARY TERM}}'}]},
  // Errors.
  {blocks: [{type: 'include', src: 'cycle-a.json'}]},
  {blocks: [{type: 'paragraph', text: 'x'}, {type: 'include', src: 'explode.json'}]},
  {blocks: [{type: 'include', src: 'broken.json'}]},
  {blocks: [{type: 'paragraph', text: '{{nope}}'}]},
  {blocks: [{type: 'heading', level: 4, text: 'x'}]},
  {blocks: [{type: 'table', columns: [{key: 'a', type: 'percent'}], rows: [{a: 1}]}]},
  {blocks: [{type: 'paragraph', text: '{date:2023-02-29}'}]},
  {blocks: [{type: 'paragraph', text: '{money:5:eur}'}]},
  {blocks: [{type: 'table', columns: [{key: 'a', type: 'number', decimals: 7}], rows: [{a: 1}]}]},
  {blocks: [{type: 'image'}]},
  {blocks: [null]},
  {blocks: [{type: 'include', src: ''}]},
  {blocks: 'nope'},
  {title: 5, blocks: []},
  null,
];

const CLI_DOC = {title: 'Command line', blocks: [
  {type: 'heading', level: 1, text: 'Usage'},
  {type: 'paragraph', text: LONG + ' Totals[^Rounded.] are {money:-1234.5:EUR} on {date:2024-02-29}.'},
  {type: 'heading', level: 2, text: 'Usage'},
  {type: 'include', src: 'figures.json'},
  {type: 'list', ordered: true, items: ['one', 'two *three*[^Rounded.]']},
  {type: 'rule'},
]};

const GLOSSARY = {API: 'application programming interface', SLA: 'service level agreement', 'glossary term': 'a defined word'};
const OPTION_SETS = [
  {},
  {locale: 'de', width: 40, toc: true, glossary: GLOSSARY},
  {locale: 'fr', bullet: '*', numberHeadings: false, toc: true, glossary: GLOSSARY, number: {group: '_'}},
  {locale: 'us', width: 20, currencyPosition: 'after', dateFormat: 'DD.MM.YYYY', glossary: GLOSSARY, number: {decimal: ',', group: '.'}},
  {width: 200, bullet: '+', toc: true, glossary: GLOSSARY, locale: undefined},
];
const withLoader = (options, log) => ({...options, loader: makeLoader(log)});

async function settle(promise) {
  try {
    return {text: await promise};
  } catch (error) {
    return {error};
  }
}

const describe = outcome => outcome.error
  ? (outcome.error === loaderError ? 'loader error' : outcome.error.name + ': ' + outcome.error.message)
  : outcome.text;

/** 1.x results, rendered one at a time with configure(). */
async function expected() {
  const out = [];
  for (const options of OPTION_SETS) {
    const loads = [];
    v1.configure(withLoader(options, loads));
    const row = [];
    for (const doc of DOCS) row.push({...(await settle(v1.render(structuredClone(doc)))), loads: loads.splice(0)});
    out.push(row);
  }
  return out;
}
const GOLDEN = await expected();

function check(actual, golden, label) {
  if (golden.error) {
    assert.ok(actual.error, label + ': expected a rejection');
    if (golden.error === loaderError) assert.equal(actual.error, loaderError, label);
    else {
      assert.ok(actual.error instanceof v2.RenderError, label + ': not a 2.0 RenderError: ' + actual.error);
      assert.equal(actual.error.name, 'RenderError', label);
      assert.equal(actual.error.message, golden.error.message, label);
    }
  } else {
    assert.equal(describe(actual), golden.text, label);
  }
}

test('exports exactly the 2.0 API', () => {
  assert.deepEqual(Object.keys(v2).sort(), ['DEFAULTS', 'RenderError', 'createRenderer', 'formatDate', 'formatMoney', 'formatNumber', 'slugify']);
});

test('DEFAULTS', () => {
  assert.deepEqual(v2.DEFAULTS, v1.defaults);
  assert.ok(Object.isFrozen(v2.DEFAULTS) && Object.isFrozen(v2.DEFAULTS.number) && Object.isFrozen(v2.DEFAULTS.glossary));
});

test('renders one at a time exactly like 1.x', async () => {
  for (const [o, options] of OPTION_SETS.entries()) {
    const loads = [];
    const renderer = v2.createRenderer(withLoader(options, loads));
    for (const [d, doc] of DOCS.entries()) {
      const actual = await settle(renderer.render(structuredClone(doc)));
      check(actual, GOLDEN[o][d], 'options ' + o + ', doc ' + d);
      assert.deepEqual(loads.splice(0), GOLDEN[o][d].loads, 'loader calls, options ' + o + ', doc ' + d);
    }
  }
});

test('renderers created in any order do not affect each other', async () => {
  const renderers = OPTION_SETS.map(options => v2.createRenderer(withLoader(options)));
  for (const d of [2, 1, 0]) {
    for (const o of [3, 0, 2, 1, 4, 0, 3]) check(await settle(renderers[o].render(structuredClone(DOCS[d]))), GOLDEN[o][d], 'options ' + o + ', doc ' + d);
  }
});

test('concurrent renders on different renderers', async () => {
  const renderers = OPTION_SETS.map(options => v2.createRenderer(withLoader(options)));
  const jobs = [];
  for (const [o, renderer] of renderers.entries()) for (const [d, doc] of DOCS.entries()) jobs.push([o, d, settle(renderer.render(structuredClone(doc)))]);
  for (const [o, d, promise] of jobs) check(await promise, GOLDEN[o][d], 'options ' + o + ', doc ' + d);
});

test('concurrent renders on the same renderer', async () => {
  for (const [o, options] of OPTION_SETS.entries()) {
    const renderer = v2.createRenderer(withLoader(options));
    const order = [1, 1, 0, 2, 1, 6, 0, 5, 1, 7, 3, 1];
    const results = await Promise.all(order.map(d => settle(renderer.render(structuredClone(DOCS[d])))));
    results.forEach((actual, i) => check(actual, GOLDEN[o][order[i]], 'options ' + o + ', doc ' + order[i] + ' #' + i));
  }
});

test('a render never waits for another render', {timeout: 10000}, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const renderer = v2.createRenderer({loader: async src => {
    if (src === 'wait.json') await gate;
    else release();
    return {blocks: [{type: 'paragraph', text: src}]};
  }});
  const results = await Promise.all([
    renderer.render({blocks: [{type: 'include', src: 'wait.json'}]}),
    renderer.render({blocks: [{type: 'include', src: 'go.json'}]}),
  ]);
  assert.deepEqual(results, ['wait.json\n', 'go.json\n']);
});

test('renderer objects and their options', () => {
  for (const options of OPTION_SETS) {
    const resolved = withLoader(options);
    const renderer = v2.createRenderer(resolved);
    v1.configure(resolved);
    assert.deepEqual(Object.getOwnPropertyNames(renderer).sort(), ['options', 'render']);
    assert.ok(Object.isFrozen(renderer));
    assert.deepEqual(renderer.options, v1.getSettings());
    assert.equal(renderer.options.loader, resolved.loader);
    assert.ok(Object.isFrozen(renderer.options) && Object.isFrozen(renderer.options.number) && Object.isFrozen(renderer.options.glossary));
  }
  v1.configure();
  assert.deepEqual(v2.createRenderer().options, v1.getSettings());
  assert.deepEqual(v2.createRenderer(undefined).options, v1.getSettings());
});

test('createRenderer snapshots its options', async () => {
  const options = {locale: 'de', glossary: {API: 'interface'}, number: {decimal: ','}};
  const renderer = v2.createRenderer(options);
  options.glossary.API = 'changed';
  options.glossary.NEW = 'added';
  options.number.decimal = ';';
  options.locale = 'fr';
  options.width = 20;
  assert.equal(await renderer.render({blocks: [{type: 'paragraph', text: '{{api}} {{API}} {num:1234.5} ' + LONG}]}),
    'api (interface) API 1.234,50 Lorem ipsum dolor sit amet, consectetur\nadipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore\nmagna aliqua. Ut enim ad minim veniam, quis nostrud exercitation\nullamco.\n');
  await assert.rejects(renderer.render({blocks: [{type: 'paragraph', text: '{{NEW}}'}]}), error => error instanceof v2.RenderError && error.message === 'unknown glossary term "NEW"');
});

const BAD_OPTIONS = [
  null, [], 'de', {colour: 'red'}, {locale: 'xx', width: 5}, {locale: 'toString'}, {locale: 5}, {width: 5, bullet: '#'}, {width: 20.5}, {width: '72'},
  {bullet: '#'}, {toc: 'yes'}, {numberHeadings: 1}, {number: 'x'}, {number: {decimal: '.', minus: '-'}}, {number: {group: ''}},
  {number: {decimal: '..'}}, {number: {group: '.'}}, {locale: 'de', number: {decimal: '.'}}, {currencyPosition: 'left'}, {dateFormat: 'YY'},
  {glossary: []}, {glossary: {'1x': 'y'}}, {glossary: {ok: ''}}, {glossary: {ok: 5}}, {loader: 'x'}, {loader: undefined, toc: null},
];

test('invalid options throw synchronously with the 1.x messages', () => {
  for (const options of BAD_OPTIONS) {
    let golden;
    try { v1.configure(options); } catch (error) { golden = error; }
    assert.ok(golden, 'fixture accepts ' + JSON.stringify(options));
    assert.throws(() => v2.createRenderer(options), error => error instanceof v2.RenderError && error.message === golden.message, JSON.stringify(options));
    assert.throws(() => v2.formatNumber(NaN, 2, options), error => error instanceof v2.RenderError && error.message === golden.message, JSON.stringify(options));
    assert.throws(() => v2.formatMoney(1, 'nope', options), error => error instanceof v2.RenderError && error.message === golden.message, JSON.stringify(options));
    assert.throws(() => v2.formatDate('nope', options), error => error instanceof v2.RenderError && error.message === golden.message, JSON.stringify(options));
  }
});

const NUMBERS = [[0], [-0], [1234567.891], [-1234.5, 0], [0.005, 2], [1.005, 2], [-0.004], [999.9995, 3], [1e21, 0], [12, 6], [-5e-7, 6], [NaN], [Infinity], ['1'], [1, 7], [1, 1.5], [1, -1], [5, undefined]];
const MONEY = [[-5, 'EUR'], [1500, 'JPY'], [1234.5, 'GBP'], [0.001, 'USD'], [-0.004, 'CHF'], [99, 'XYZ'], [1, 'eur'], [1, 5], ['1', 'USD'], [NaN, 'USD']];
const DATES = ['2024-02-29', '2023-02-29', '1999-12-31', '2024-13-01', '2024-1-01', 20240101, '0000-01-01'];
const FORMAT_OPTIONS = [undefined, {}, {locale: 'de'}, {locale: 'fr', number: {group: '_'}}, {locale: 'us', currencyPosition: 'after', dateFormat: 'DD/MM/YYYY'}, {number: {decimal: ',', group: '.'}}];

function outcome(fn) {
  try { return fn(); } catch (error) { return error.name + ': ' + error.message; }
}

test('formatting helpers match 1.x in any call order', () => {
  const calls = [];
  for (const [o, options] of FORMAT_OPTIONS.entries()) {
    for (const args of NUMBERS) calls.push([o, 'formatNumber', args]);
    for (const args of MONEY) calls.push([o, 'formatMoney', args]);
    for (const iso of DATES) calls.push([o, 'formatDate', [iso]]);
  }
  const golden = calls.map(([o, name, args]) => {
    v1.configure(FORMAT_OPTIONS[o]);
    return outcome(() => v1[name](...args));
  });
  // Interleave option sets: every call alternates between them.
  const order = calls.map((_, i) => i).sort((a, b) => (a % 7) - (b % 7) || b - a);
  for (const i of order) {
    const [o, name, args] = calls[i];
    const options = FORMAT_OPTIONS[o];
    const padded = name === 'formatDate' ? [args[0], options] : [args[0], args[1], options];
    const actual = outcome(() => v2[name](...padded));
    assert.equal(actual, golden[i], name + '(' + JSON.stringify(args) + ') with ' + JSON.stringify(options));
    if (typeof actual === 'string' && actual.startsWith('RenderError')) assert.throws(() => v2[name](...padded), v2.RenderError);
  }
  assert.equal(v2.formatNumber(1234.5, undefined, {locale: 'de'}), '1.234,50');
});

test('the CLI is unchanged', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pressdoc-cli-'));
  try {
    for (const [name, doc] of Object.entries(LIBRARY)) writeFileSync(path.join(dir, name), JSON.stringify(doc));
    writeFileSync(path.join(dir, 'main.json'), JSON.stringify({...DOCS[1], blocks: DOCS[1].blocks.map(block => ({...block}))}));
    writeFileSync(path.join(dir, 'first.json'), JSON.stringify(CLI_DOC));
    const runs = [
      ['main.json'], ['main.json', '--toc', '--locale', 'de', '--width', '30', '--no-numbers'], ['first.json', '--locale', 'fr'],
      ['main.json', '--width', '5'], ['main.json', '--width', 'wide'], ['main.json', '--locale', 'xx'], ['cycle-a.json'], ['broken.json'],
      [], ['main.json', 'first.json'], ['main.json', '--width'], ['--help'], ['figures.json', '--toc'],
    ];
    for (const args of runs) {
      const run = root => spawnSync(process.execPath, [path.join(root, 'bin', 'pressdoc.js'), ...args], {cwd: dir, encoding: 'utf8'});
      const before = run(ORIG);
      const after = run(ROOT);
      assert.deepEqual({status: after.status, stdout: after.stdout, stderr: after.stderr}, {status: before.status, stdout: before.stdout, stderr: before.stderr}, args.join(' '));
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

const solve = root => {
  writeTree(root, REFERENCE);
  rmSync(path.join(root, 'src', 'settings.js'));
};

const patch = (file, from, to) => root => {
  if (!REFERENCE[file].includes(from)) throw Error('mustReject patch target missing in ' + file + ': ' + from);
  writeTree(root, {[file]: REFERENCE[file].replace(from, to)});
};

export default {
  id: 'pressdoc-v2-migration',
  category: 'behavior-preserving API migration across many modules',
  prompt: 'Migrate this library (pressdoc) to its 2.0 API as specified in docs/MIGRATION-2.0.md: the global configure()/render() state goes away in favor of createRenderer(), the formatting helpers take options, and the exports change exactly as listed there. Everything the migration document does not change must keep behaving exactly as 1.x does now (README.md and the current source), byte for byte, including the CLI. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [
    ['pressdoc 1.4.2', {'package.json': PKG, 'README.md': README, ...V1, 'test/render.test.js': V1_TEST}],
    ['Start 2.0: migration notes and tests for the new API', {...V2_FIXTURE_COMMIT}],
  ]),
  solve,
  verify(root, before) {
    const suite = npm(root, 'test');
    const orig = path.join(root, '..', path.basename(root) + '-hidden', 'orig');
    writeTree(orig, {'package.json': PKG, ...V1});
    const hidden = hiddenTests(root, HIDDEN.replaceAll('@ORIG@', pathURL(orig)));
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
    // Per-render state kept per renderer: concurrent renders on one renderer share footnotes, slugs and the include stack.
    root => {
      writeTree(root, {
        'src/render.js': REFERENCE['src/render.js'].replace('export async function renderDocument(options, doc) {', 'export async function renderDocument(options, doc, shared) {')
          .replace('  const state = createState(options);', '  const state = shared;\n  state.slugs.clear(); state.notes.length = 0; state.counters.fill(0); state.headings.length = 0; state.seenTerms.clear(); state.includes.length = 0;'),
        'src/renderer.js': REFERENCE['src/renderer.js'].replace("import {renderDocument} from './render.js';", "import {renderDocument} from './render.js';\nimport {createState} from './state.js';")
          .replace('  return Object.freeze({options: resolved, render: doc => renderDocument(resolved, doc)});', '  const state = createState(resolved);\n  return Object.freeze({options: resolved, render: doc => renderDocument(resolved, doc, state)});'),
      });
    },
    // The 1.x number cache kept, keyed by value and decimals only.
    patch('src/format/number.js', "export function numberText(options, value, decimals = 2) {\n  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RenderError('not a finite number: ' + String(value));\n  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new RenderError('decimals must be an integer from 0 to 6');",
      "const cache = new Map();\nexport function numberText(options, value, decimals = 2) {\n  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RenderError('not a finite number: ' + String(value));\n  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new RenderError('decimals must be an integer from 0 to 6');\n  if (!cache.has(value + '|' + decimals)) cache.set(value + '|' + decimals, numberText2(options, value, decimals));\n  return cache.get(value + '|' + decimals);\n}\nfunction numberText2(options, value, decimals) {"),
    // Deprecated aliases kept in the public API.
    patch('src/index.js', "export {DEFAULTS} from './options.js';", "export {DEFAULTS, DEFAULTS as defaults} from './options.js';"),
    // Renders serialized through a queue instead of being independent.
    patch('src/renderer.js', '  return Object.freeze({options: resolved, render: doc => renderDocument(resolved, doc)});',
      '  let queue = Promise.resolve();\n  return Object.freeze({options: resolved, render: doc => (queue = queue.catch(() => {}).then(() => renderDocument(resolved, doc)))});'),
    // createRenderer keeps the caller's options object and resolves it on every render.
    patch('src/renderer.js', '  return Object.freeze({options: resolved, render: doc => renderDocument(resolved, doc)});',
      '  return Object.freeze({options: resolved, render: async doc => renderDocument(resolveOptions(options), doc)});'),
    // Options validated after the value.
    patch('src/format/number.js', 'export const formatNumber = (value, decimals, options) => numberText(resolveOptions(options), value, decimals);',
      "export const formatNumber = (value, decimals, options) => { numberText({number: {decimal: '.', group: ','}}, value, decimals); return numberText(resolveOptions(options), value, decimals); };"),
    // CLI loses its usage error.
    patch('bin/pressdoc.js', '  process.exitCode = 2;', '  process.exitCode = 1;'),
    // A thin 2.0 facade over the untouched 1.x globals: configure() before every call.
    root => writeTree(root, {...V1, 'bin/pressdoc.js': REFERENCE['bin/pressdoc.js'], 'src/index.js': js`import {configure, getSettings} from './settings.js';
import {render} from './render.js';
import {defaults} from './options.js';
import {formatNumber as number1} from './format/number.js';
import {formatMoney as money1} from './format/money.js';
import {formatDate as date1} from './format/date.js';
export {RenderError} from './errors.js';
export {slugify} from './state/slugs.js';

const freeze = value => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const snapshot = settings => freeze({...settings, number: {...settings.number}, glossary: {...settings.glossary}});

export const DEFAULTS = snapshot(defaults);
export const formatNumber = (value, decimals, options) => { configure(options); return number1(value, decimals); };
export const formatMoney = (amount, currency, options) => { configure(options); return money1(amount, currency); };
export const formatDate = (iso, options) => { configure(options); return date1(iso); };

export function createRenderer(options) {
  configure(options);
  const resolved = snapshot(getSettings());
  return Object.freeze({options: resolved, render: doc => { configure(resolved); return render(doc); }});
}
`}),
    // A visible test edited.
    root => writeTree(root, {'test/format.test.js': VISIBLE_FORMAT.replace("test('slugify is unchanged'", "test.skip('slugify is unchanged'")}),
  ],
};
