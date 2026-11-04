import path from 'node:path';
import {gitRepo, hiddenTests, npm, projectFiles, read, verdict, writeTree} from '../lib.mjs';

// Fixture and hidden-test sources are String.raw templates: backslashes stay verbatim; they never contain a backtick or "${".
const js = String.raw;

const README = `# notes

A tiny static-site tool for a folder of Markdown notes.

A site directory (the "root") contains:

- \`pages/\`: the pages, \`*.md\` files at any depth. Other files there are ignored.
- \`layouts/<name>.html\`: HTML templates with \`{{title}}\`, \`{{site}}\` and \`{{content}}\` placeholders.
- \`site.json\` (optional): \`{"title": "...", "layout": "..."}\`, merged over the defaults \`{"title": "Notes", "layout": "default"}\`.

A page starts with front matter:

    ---
    title: Getting started
    layout: post
    ---
    # Hello

    Text with a [[guide/intro]] link.

## API

Everything is exported from \`src/index.js\`. The exact behavior of each function, including its errors and ordering, is documented in its JSDoc; the error classes are in \`src/errors.js\`.

| Function | Module | Filesystem I/O |
| --- | --- | --- |
| \`readText(file)\` | src/fsutil.js | yes |
| \`readJson(file)\` | src/fsutil.js | yes |
| \`pathExists(p)\` | src/fsutil.js | yes |
| \`listDir(dir)\` | src/fsutil.js | yes |
| \`loadConfig(root)\` | src/config.js | yes |
| \`parseFrontMatter(text)\` | src/frontmatter.js | no |
| \`listPages(root)\` | src/pages.js | yes |
| \`loadPage(root, rel)\` | src/pages.js | yes |
| \`loadSite(root)\` | src/site.js | yes |
| \`escapeHtml(text)\` | src/markdown.js | no |
| \`toHtml(body, pages)\` | src/markdown.js | no |
| \`fillTemplate(template, vars)\` | src/layout.js | no |
| \`renderLayout(root, name, vars)\` | src/layout.js | yes |
| \`renderPage(root, site, page)\` | src/render.js | yes |
| \`buildSite(root, outDir)\` | src/build.js | yes |

## CLI

    node bin/notes.js <list|check|build> [--root DIR] [--out DIR]

\`--root\` defaults to the current directory. \`--out\` is resolved against the current directory and defaults to \`<root>/dist\`.

- \`list\` prints every page path, in listPages order, one per line.
- \`check\` loads the site (loadSite) and prints \`ok: N pages\`.
- \`build\` builds the site (buildSite) and prints \`built N files into OUT\`, where N is the number of files written and OUT the absolute output directory.

Exit codes and standard error:

- 0: success; nothing is written to standard error.
- 1: the site has invalid pages (ValidationError): one line \`<path>: <message>\` per invalid page, in listPages order.
- 2: any other error: one line \`error: <message>\`.
- 64: unknown command or bad arguments: the line \`usage: notes <list|check|build> [--root DIR] [--out DIR]\`.
`;

const ERRORS = js`/** Error classes used by the library. Each sets .name to its class name. */

/** A file or directory that does not exist. .path is the path exactly as it was passed in; .cause is the original ENOENT error. */
export class NotFoundError extends Error {
  constructor(path, cause) {
    super('not found: ' + path, {cause});
    this.name = 'NotFoundError';
    this.path = path;
  }
}

/** site.json is unreadable, malformed or has an invalid value. */
export class ConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/** Malformed front matter; .line is the 1-based line number in the page file. */
export class FrontMatterError extends Error {
  constructor(line, message) {
    super('line ' + line + ': ' + message);
    this.name = 'FrontMatterError';
    this.line = line;
  }
}

/** One invalid page; .path is the page path as returned by listPages. */
export class PageError extends Error {
  constructor(path, message, options) {
    super(message, options);
    this.name = 'PageError';
    this.path = path;
  }
}

/** Every invalid page of a site at once; .errors holds their PageErrors in listPages order. */
export class ValidationError extends Error {
  constructor(errors) {
    super(errors.length + ' invalid page(s): ' + errors.map(error => error.path).join(', '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/** A [[target]] link to a page that does not exist; .target is the link target. */
export class LinkError extends Error {
  constructor(target) {
    super('broken link [[' + target + ']]');
    this.name = 'LinkError';
    this.target = target;
  }
}

/** Rendering one page failed; .path is the page path, .cause the original error. */
export class BuildError extends Error {
  constructor(path, cause) {
    super(path + ': ' + cause.message, {cause});
    this.name = 'BuildError';
    this.path = path;
  }
}
`;

const FRONTMATTER = js`import {FrontMatterError} from './errors.js';

/**
 * Splits a page into front matter and body. Front matter exists when the first line is exactly "---"; it ends at the next
 * line that is exactly "---", and the body is everything after that line. Without front matter, data is {} and body is the
 * whole text. Each front matter line must be "key: value" with a lower-case key; the value is trimmed.
 * Throws FrontMatterError: unterminated block (line 1), a line that is not "key: value", or a duplicate key (that line).
 */
export function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return {data: {}, body: text};
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return {data, body: lines.slice(i + 1).join('\n')};
    const match = /^([a-z]+):(.*)$/.exec(lines[i]);
    if (!match) throw new FrontMatterError(i + 1, 'expected "key: value"');
    if (Object.hasOwn(data, match[1])) throw new FrontMatterError(i + 1, 'duplicate key "' + match[1] + '"');
    data[match[1]] = match[2].trim();
  }
  throw new FrontMatterError(1, 'unterminated front matter');
}
`;

const MARKDOWN = js`import {LinkError} from './errors.js';

const ENTITIES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'};

/** Escapes & < > " for HTML. */
export function escapeHtml(text) {
  return text.replace(/[&<>"]/g, char => ENTITIES[char]);
}

/**
 * Minimal Markdown to HTML. Blocks are separated by blank lines; the lines of a block are trimmed and joined with one space.
 * A block starting with "# " becomes <h1>, "## " <h2>, anything else <p>. Text is escaped with escapeHtml.
 * [[target]] links to the page whose path is target + ".md" and renders as <a href="/target.html">escaped title</a>.
 * Blocks are joined with "\n". An unknown target throws LinkError(target).
 * @param {string} body
 * @param {Map<string, {title: string}>} pages pages keyed by page path, e.g. "guide/intro.md"
 */
export function toHtml(body, pages) {
  return body.split(/\n[ \t]*\n/).map(block => block.split('\n').map(line => line.trim()).filter(Boolean).join(' ')).filter(Boolean).map(block => {
    if (block.startsWith('## ')) return '<h2>' + inline(block.slice(3), pages) + '</h2>';
    if (block.startsWith('# ')) return '<h1>' + inline(block.slice(2), pages) + '</h1>';
    return '<p>' + inline(block, pages) + '</p>';
  }).join('\n');
}

function inline(text, pages) {
  return escapeHtml(text).replace(/\[\[([^\]]*)\]\]/g, (link, target) => {
    const page = pages.get(target + '.md');
    if (!page) throw new LinkError(target);
    return '<a href="/' + target + '.html">' + escapeHtml(page.title) + '</a>';
  });
}
`;

const INDEX = js`export * from './errors.js';
export {readText, readJson, pathExists, listDir} from './fsutil.js';
export {DEFAULTS, loadConfig} from './config.js';
export {parseFrontMatter} from './frontmatter.js';
export {listPages, loadPage} from './pages.js';
export {loadSite} from './site.js';
export {escapeHtml, toHtml} from './markdown.js';
export {fillTemplate, renderLayout} from './layout.js';
export {renderPage} from './render.js';
export {buildSite} from './build.js';
`;

// ---------- synchronous fixture modules ----------

const FSUTIL_DOC = {
  readText: '/** Reads a UTF-8 text file. A missing file (ENOENT) fails with NotFoundError(file); any other error propagates unchanged. */',
  readJson: '/** readText(file) parsed with JSON.parse. Errors from readText and the SyntaxError from JSON.parse propagate unchanged. */',
  pathExists: '/** True when a file or directory exists at p, false otherwise (also when p cannot be checked at all); never fails. */',
  listDir: js`/**
 * The entries of directory dir as {name, dir} objects (dir: true for subdirectories), sorted by name in code unit order
 * (Array.prototype.sort without a comparator). A missing dir (ENOENT) fails with NotFoundError(dir); other errors propagate unchanged.
 */`,
};

const FSUTIL_SYNC = js`import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {NotFoundError} from './errors.js';

@readText@
export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new NotFoundError(file, err);
    throw err;
  }
}

@readJson@
export function readJson(file) {
  return JSON.parse(readText(file));
}

@pathExists@
export function pathExists(p) {
  return existsSync(p);
}

@listDir@
export function listDir(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') throw new NotFoundError(dir, err);
    throw err;
  }
  return names.sort().map(name => ({name, dir: statSync(path.join(dir, name)).isDirectory()}));
}
`;

const CONFIG_DOC = js`/**
 * Loads <root>/site.json merged over DEFAULTS (a new object each time). Without a site.json the result is a copy of DEFAULTS.
 * If site.json cannot be read or parsed: ConfigError with message "invalid site.json: " + the original error's message and
 * the original error as .cause. If "title" or "layout" is not a non-empty string afterwards:
 * ConfigError('site.json: "<key>" must be a non-empty string') without a cause (title is checked first).
 */`;

const CONFIG_SYNC = js`import path from 'node:path';
import {ConfigError} from './errors.js';
import {pathExists, readJson} from './fsutil.js';

export const DEFAULTS = Object.freeze({title: 'Notes', layout: 'default'});

@doc@
export function loadConfig(root) {
  const file = path.join(root, 'site.json');
  if (!pathExists(file)) return {...DEFAULTS};
  const config = {...DEFAULTS, ...readConfigFile(file)};
  for (const key of ['title', 'layout']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new ConfigError('site.json: "' + key + '" must be a non-empty string');
  }
  return config;
}

function readConfigFile(file) {
  try {
    return readJson(file);
  } catch (cause) {
    throw new ConfigError('invalid site.json: ' + cause.message, {cause});
  }
}
`;

const PAGES_DOC = {
  listPages: js`/**
 * Paths (relative to <root>/pages, "/"-separated) of every *.md file under <root>/pages, depth-first: the entries of each
 * directory in listDir order (code unit order), with a subdirectory's pages listed at the position of the subdirectory's
 * name. Example: "C.md", "a/z.md", "a.md", "b.md" (because "C" < "a" < "a.md" < "b.md"). Files not ending in ".md" are skipped.
 * A missing pages directory fails with NotFoundError for <root>/pages.
 */`,
  loadPage: js`/**
 * Loads page rel (a path as returned by listPages). Result: {path: rel, title, layout, body, out} where title and layout
 * come from the front matter (layout null when absent), body is the text after the front matter, and out is rel with
 * ".md" replaced by ".html". An invalid page fails with PageError whose .path is rel:
 * - the file name (last segment of rel) does not match /^[a-z0-9][a-z0-9-]*\.md$/: message "invalid file name", no cause;
 *   this is checked before the file is read;
 * - the front matter is malformed: the FrontMatterError's message, with that FrontMatterError as .cause;
 * - there is no title: message "missing title", no cause.
 * Errors from reading the file (such as NotFoundError) propagate unchanged.
 */`,
};

const PAGES_SYNC = js`import path from 'node:path';
import {PageError} from './errors.js';
import {parseFrontMatter} from './frontmatter.js';
import {listDir, readText} from './fsutil.js';

const FILE_NAME = /^[a-z0-9][a-z0-9-]*\.md$/;

@listPages@
export function listPages(root) {
  const out = [];
  const walk = rel => {
    for (const entry of listDir(path.join(root, 'pages', rel))) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.dir) walk(child);
      else if (entry.name.endsWith('.md')) out.push(child);
    }
  };
  walk('');
  return out;
}

@loadPage@
export function loadPage(root, rel) {
  if (!FILE_NAME.test(rel.split('/').pop())) throw new PageError(rel, 'invalid file name');
  const text = readText(path.join(root, 'pages', rel));
  let parsed;
  try {
    parsed = parseFrontMatter(text);
  } catch (cause) {
    throw new PageError(rel, cause.message, {cause});
  }
  if (!parsed.data.title) throw new PageError(rel, 'missing title');
  return {path: rel, title: parsed.data.title, layout: parsed.data.layout ?? null, body: parsed.body, out: rel.slice(0, -3) + '.html'};
}
`;

const SITE_DOC = js`/**
 * Loads the config (loadConfig) and then every page (loadPage) in listPages order. Result: {config, pages}, pages in
 * listPages order. Every invalid page is collected: if there is at least one PageError, fails with a single
 * ValidationError whose .errors are all those PageErrors in listPages order. Any other error propagates unchanged.
 */`;

const SITE_SYNC = js`import {loadConfig} from './config.js';
import {PageError, ValidationError} from './errors.js';
import {listPages, loadPage} from './pages.js';

@doc@
export function loadSite(root) {
  const config = loadConfig(root);
  const pages = [];
  const errors = [];
  listPages(root).forEach(rel => {
    try {
      pages.push(loadPage(root, rel));
    } catch (err) {
      if (!(err instanceof PageError)) throw err;
      errors.push(err);
    }
  });
  if (errors.length) throw new ValidationError(errors);
  return {config, pages};
}
`;

const LAYOUT_DOC = {
  fillTemplate: '/** Replaces each {{name}} placeholder (name: lower-case letters) with String(vars[name]), or "" when vars has no such key. */',
  renderLayout: '/** Reads the template <root>/layouts/<name>.html with readText (a missing one fails with its NotFoundError) and fills it with vars. */',
};

const LAYOUT_SYNC = js`import path from 'node:path';
import {readText} from './fsutil.js';

@fillTemplate@
export function fillTemplate(template, vars) {
  return template.replace(/\{\{([a-z]+)\}\}/g, (placeholder, name) => Object.hasOwn(vars, name) ? String(vars[name]) : '');
}

@renderLayout@
export function renderLayout(root, name, vars) {
  return fillTemplate(readText(path.join(root, 'layouts', name + '.html')), vars);
}
`;

const RENDER_DOC = js`/**
 * Renders page (one of site.pages, where site is the result of loadSite) to a complete HTML document: the layout
 * page.layout (site.config.layout when null) filled with title = escapeHtml(page.title), site = escapeHtml(site.config.title)
 * and content = toHtml(page.body, site's pages keyed by path). Every failure, e.g. a LinkError from toHtml or the
 * NotFoundError of a missing layout, is reported as BuildError with .path = page.path and .cause = the original error.
 */`;

const RENDER_SYNC = js`import {BuildError} from './errors.js';
import {renderLayout} from './layout.js';
import {escapeHtml, toHtml} from './markdown.js';

@doc@
export function renderPage(root, site, page) {
  try {
    const content = toHtml(page.body, new Map(site.pages.map(other => [other.path, other])));
    return renderLayout(root, page.layout ?? site.config.layout, {title: escapeHtml(page.title), site: escapeHtml(site.config.title), content});
  } catch (cause) {
    throw new BuildError(page.path, cause);
  }
}
`;

const BUILD_DOC = js`/**
 * Builds the site into outDir, all or nothing.
 * 1. Loads the site with loadSite; its errors (ValidationError, ConfigError, ...) propagate before anything is written.
 * 2. Renders the pages one at a time in listPages order (renderPage) into the temporary directory outDir + ".tmp"
 *    (removed first if left over from an earlier run), each to its page.out path, then writes "sitemap.txt" there:
 *    every page.out followed by "\n", in listPages order.
 * 3. If a page fails, the build stops at that first failing page (in listPages order): outDir + ".tmp" is removed and the
 *    error is rethrown. outDir and everything else next to it are left exactly as they were.
 * 4. Otherwise outDir (which need not exist) is replaced by the new tree: an existing outDir is renamed to outDir + ".old",
 *    outDir + ".tmp" is renamed to outDir, and outDir + ".old" is removed. Nothing else remains next to outDir.
 * Result: {files}, the written paths relative to outDir ("/"-separated): every page.out in listPages order, then "sitemap.txt".
 */`;

const BUILD_SYNC = js`import {mkdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathExists} from './fsutil.js';
import {renderPage} from './render.js';
import {loadSite} from './site.js';

@doc@
export function buildSite(root, outDir) {
  const site = loadSite(root);
  const tmp = outDir + '.tmp';
  const old = outDir + '.old';
  rmSync(tmp, {recursive: true, force: true});
  mkdirSync(tmp, {recursive: true});
  const files = [];
  try {
    site.pages.forEach(page => {
      const html = renderPage(root, site, page);
      const file = path.join(tmp, page.out);
      mkdirSync(path.dirname(file), {recursive: true});
      writeFileSync(file, html);
      files.push(page.out);
    });
    writeFileSync(path.join(tmp, 'sitemap.txt'), files.map(name => name + '\n').join(''));
    files.push('sitemap.txt');
  } catch (err) {
    rmSync(tmp, {recursive: true, force: true});
    throw err;
  }
  rmSync(old, {recursive: true, force: true});
  if (pathExists(outDir)) renameSync(outDir, old);
  renameSync(tmp, outDir);
  rmSync(old, {recursive: true, force: true});
  return {files};
}
`;

const CLI_SYNC = js`#!/usr/bin/env node
import path from 'node:path';
import {buildSite, listPages, loadSite, ValidationError} from '../src/index.js';

const USAGE = 'usage: notes <list|check|build> [--root DIR] [--out DIR]';
class UsageError extends Error {}

function main(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--root', '--out'].includes(rest[i]) || rest[i + 1] === undefined) throw new UsageError();
    options[rest[i].slice(2)] = rest[i + 1];
  }
  const root = path.resolve(options.root ?? '.');
  const out = options.out === undefined ? path.join(root, 'dist') : path.resolve(options.out);
  if (command === 'list') {
    for (const page of listPages(root)) console.log(page);
    return 0;
  }
  if (command === 'check') {
    console.log('ok: ' + loadSite(root).pages.length + ' pages');
    return 0;
  }
  if (command === 'build') {
    console.log('built ' + buildSite(root, out).files.length + ' files into ' + out);
    return 0;
  }
  throw new UsageError();
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 64;
  } else if (err instanceof ValidationError) {
    for (const error of err.errors) console.error(error.path + ': ' + error.message);
    process.exitCode = 1;
  } else {
    console.error('error: ' + err.message);
    process.exitCode = 2;
  }
}
`;

const fill = (source, docs) => source.replace(/@(\w+)@/g, (match, key) => docs[key]);

// ---------- visible tests (sync API) ----------

const HELPERS = js`import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LAYOUT = '<title>{{title}} - {{site}}</title>\n<main>{{content}}</main>\n';

export function makeSite(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notes-test-'));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), {recursive: true});
    writeFileSync(file, text);
  }
  return root;
}

export const cleanup = root => rmSync(root, {recursive: true, force: true});
`;

const FRONTMATTER_TEST = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {FrontMatterError, parseFrontMatter} from '../src/index.js';

test('splits front matter from the body', () => {
  assert.deepEqual(parseFrontMatter('---\ntitle:  Hi \n---\nBody\n'), {data: {title: 'Hi'}, body: 'Body\n'});
});

test('reports the line of a malformed entry', () => {
  assert.throws(() => parseFrontMatter('---\ntitle: Hi\noops\n---\n'), err => err instanceof FrontMatterError && err.line === 3);
});
`;

// Visible tests; @fn@, @await@ and @throws@ are the spots the API change touches (filled by fillTests).
const TESTS = {
    'test/pages.test.js': js`import test from 'node:test';
import assert from 'node:assert/strict';
import {listPages, loadPage, PageError} from '../src/index.js';
import {cleanup, makeSite} from './helpers.js';

test('lists the markdown pages in name order', @fn@
  const root = makeSite({'pages/zebra.md': '---\ntitle: Z\n---\n', 'pages/apple.md': '---\ntitle: A\n---\n', 'pages/notes.txt': 'not a page'});
  try {
    assert.deepEqual(@await@listPages(root), ['apple.md', 'zebra.md']);
  } finally {
    cleanup(root);
  }
});

test('loads a page with its front matter', @fn@
  const root = makeSite({'pages/hello.md': '---\ntitle: Hello\nlayout: post\n---\nHi there.\n'});
  try {
    assert.deepEqual(@await@loadPage(root, 'hello.md'), {path: 'hello.md', title: 'Hello', layout: 'post', body: 'Hi there.\n', out: 'hello.html'});
  } finally {
    cleanup(root);
  }
});

test('rejects file names that are not lower-case slugs', @fn@
  const root = makeSite({'pages/Hello World.md': '---\ntitle: Hello\n---\n'});
  try {
    @throws@loadPage(root, 'Hello World.md'), err => err instanceof PageError && err.path === 'Hello World.md' && err.message === 'invalid file name');
  } finally {
    cleanup(root);
  }
});
`,
    'test/site.test.js': js`import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig, loadSite, ValidationError} from '../src/index.js';
import {cleanup, makeSite} from './helpers.js';

test('reads site.json over the defaults', @fn@
  const root = makeSite({'site.json': '{"title": "Dev Notes"}'});
  try {
    assert.deepEqual(@await@loadConfig(root), {title: 'Dev Notes', layout: 'default'});
  } finally {
    cleanup(root);
  }
});

test('loads every page of a valid site', @fn@
  const root = makeSite({'pages/b.md': '---\ntitle: B\n---\n', 'pages/a.md': '---\ntitle: A\n---\n'});
  try {
    const site = @await@loadSite(root);
    assert.deepEqual(site.pages.map(page => page.title), ['A', 'B']);
    assert.equal(site.config.title, 'Notes');
  } finally {
    cleanup(root);
  }
});

test('reports an invalid page', @fn@
  const root = makeSite({'pages/good.md': '---\ntitle: Good\n---\n', 'pages/bad.md': 'no front matter\n'});
  try {
    @throws@loadSite(root), err => err instanceof ValidationError && err.errors.length === 1 && err.errors[0].path === 'bad.md');
  } finally {
    cleanup(root);
  }
});
`,
    'test/build.test.js': js`import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {buildSite, ValidationError} from '../src/index.js';
import {cleanup, LAYOUT, makeSite} from './helpers.js';

test('builds every page and a sitemap', @fn@
  const root = makeSite({'layouts/default.html': LAYOUT, 'pages/index.md': '---\ntitle: Home\n---\nHello.\n', 'pages/about.md': '---\ntitle: About\n---\nUs.\n', 'dist/old.html': 'stale'});
  try {
    const out = path.join(root, 'dist');
    assert.deepEqual(@await@buildSite(root, out), {files: ['about.html', 'index.html', 'sitemap.txt']});
    assert.equal(readFileSync(path.join(out, 'index.html'), 'utf8'), '<title>Home - Notes</title>\n<main><p>Hello.</p></main>\n');
    assert.equal(readFileSync(path.join(out, 'sitemap.txt'), 'utf8'), 'about.html\nindex.html\n');
    assert.equal(existsSync(path.join(out, 'old.html')), false);
  } finally {
    cleanup(root);
  }
});

test('writes nothing when a page is invalid', @fn@
  const root = makeSite({'layouts/default.html': LAYOUT, 'pages/index.md': '---\ntitle: Home\n---\n', 'pages/bad.md': 'no title\n', 'dist/keep.html': 'kept'});
  try {
    const out = path.join(root, 'dist');
    @throws@buildSite(root, out), ValidationError);
    assert.deepEqual(readdirSync(out), ['keep.html']);
  } finally {
    cleanup(root);
  }
});
`,
};

const fillTests = sync => Object.fromEntries(Object.entries(TESTS).map(([name, text]) => [name, fill(text, sync
  ? {fn: '() => {', await: '', throws: 'assert.throws(() => '}
  : {fn: 'async () => {', await: 'await ', throws: 'await assert.rejects('})]));

const CLI_TEST = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cleanup, makeSite} from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/notes.js', import.meta.url));
const notes = (...args) => spawnSync(process.execPath, [CLI, ...args], {encoding: 'utf8'});

test('list prints the pages', () => {
  const root = makeSite({'pages/b.md': '---\ntitle: B\n---\n', 'pages/a.md': '---\ntitle: A\n---\n'});
  try {
    const result = notes('list', '--root', root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'a.md\nb.md\n');
  } finally {
    cleanup(root);
  }
});

test('check fails on an invalid page', () => {
  const root = makeSite({'pages/bad.md': 'no title\n'});
  try {
    const result = notes('check', '--root', root);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'bad.md: missing title\n');
  } finally {
    cleanup(root);
  }
});
`;

const FIXTURE = {
  'package.json': JSON.stringify({name: 'notes', version: '1.0.0', type: 'module', bin: {notes: 'bin/notes.js'}, scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'README.md': README,
  'bin/notes.js': CLI_SYNC,
  'src/index.js': INDEX,
  'src/errors.js': ERRORS,
  'src/fsutil.js': fill(FSUTIL_SYNC, FSUTIL_DOC),
  'src/config.js': fill(CONFIG_SYNC, {doc: CONFIG_DOC}),
  'src/frontmatter.js': FRONTMATTER,
  'src/pages.js': fill(PAGES_SYNC, PAGES_DOC),
  'src/site.js': fill(SITE_SYNC, {doc: SITE_DOC}),
  'src/markdown.js': MARKDOWN,
  'src/layout.js': fill(LAYOUT_SYNC, LAYOUT_DOC),
  'src/render.js': fill(RENDER_SYNC, {doc: RENDER_DOC}),
  'src/build.js': fill(BUILD_SYNC, {doc: BUILD_DOC}),
  'test/helpers.js': HELPERS,
  'test/frontmatter.test.js': FRONTMATTER_TEST,
  'test/cli.test.js': CLI_TEST,
  ...fillTests(true),
};

// ---------- reference: async conversion ----------

const REFERENCE = {
  'src/fsutil.js': fill(js`import {access, readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {NotFoundError} from './errors.js';

@readText@
export async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new NotFoundError(file, err);
    throw err;
  }
}

@readJson@
export async function readJson(file) {
  return JSON.parse(await readText(file));
}

@pathExists@
export async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

@listDir@
export async function listDir(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') throw new NotFoundError(dir, err);
    throw err;
  }
  return Promise.all(names.sort().map(async name => ({name, dir: (await stat(path.join(dir, name))).isDirectory()})));
}
`, FSUTIL_DOC),
  'src/config.js': fill(js`import path from 'node:path';
import {ConfigError} from './errors.js';
import {pathExists, readJson} from './fsutil.js';

export const DEFAULTS = Object.freeze({title: 'Notes', layout: 'default'});

@doc@
export async function loadConfig(root) {
  const file = path.join(root, 'site.json');
  if (!(await pathExists(file))) return {...DEFAULTS};
  const config = {...DEFAULTS, ...(await readConfigFile(file))};
  for (const key of ['title', 'layout']) {
    if (typeof config[key] !== 'string' || !config[key]) throw new ConfigError('site.json: "' + key + '" must be a non-empty string');
  }
  return config;
}

async function readConfigFile(file) {
  try {
    return await readJson(file);
  } catch (cause) {
    throw new ConfigError('invalid site.json: ' + cause.message, {cause});
  }
}
`, {doc: CONFIG_DOC}),
  'src/pages.js': fill(js`import path from 'node:path';
import {PageError} from './errors.js';
import {parseFrontMatter} from './frontmatter.js';
import {listDir, readText} from './fsutil.js';

const FILE_NAME = /^[a-z0-9][a-z0-9-]*\.md$/;

@listPages@
export async function listPages(root) {
  const out = [];
  const walk = async rel => {
    for (const entry of await listDir(path.join(root, 'pages', rel))) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.dir) await walk(child);
      else if (entry.name.endsWith('.md')) out.push(child);
    }
  };
  await walk('');
  return out;
}

@loadPage@
export async function loadPage(root, rel) {
  if (!FILE_NAME.test(rel.split('/').pop())) throw new PageError(rel, 'invalid file name');
  const text = await readText(path.join(root, 'pages', rel));
  let parsed;
  try {
    parsed = parseFrontMatter(text);
  } catch (cause) {
    throw new PageError(rel, cause.message, {cause});
  }
  if (!parsed.data.title) throw new PageError(rel, 'missing title');
  return {path: rel, title: parsed.data.title, layout: parsed.data.layout ?? null, body: parsed.body, out: rel.slice(0, -3) + '.html'};
}
`, PAGES_DOC),
  'src/site.js': fill(js`import {loadConfig} from './config.js';
import {PageError, ValidationError} from './errors.js';
import {listPages, loadPage} from './pages.js';

@doc@
export async function loadSite(root) {
  const config = await loadConfig(root);
  const pages = [];
  const errors = [];
  for (const rel of await listPages(root)) {
    try {
      pages.push(await loadPage(root, rel));
    } catch (err) {
      if (!(err instanceof PageError)) throw err;
      errors.push(err);
    }
  }
  if (errors.length) throw new ValidationError(errors);
  return {config, pages};
}
`, {doc: SITE_DOC}),
  'src/layout.js': fill(js`import path from 'node:path';
import {readText} from './fsutil.js';

@fillTemplate@
export function fillTemplate(template, vars) {
  return template.replace(/\{\{([a-z]+)\}\}/g, (placeholder, name) => Object.hasOwn(vars, name) ? String(vars[name]) : '');
}

@renderLayout@
export async function renderLayout(root, name, vars) {
  return fillTemplate(await readText(path.join(root, 'layouts', name + '.html')), vars);
}
`, LAYOUT_DOC),
  'src/render.js': fill(js`import {BuildError} from './errors.js';
import {renderLayout} from './layout.js';
import {escapeHtml, toHtml} from './markdown.js';

@doc@
export async function renderPage(root, site, page) {
  try {
    const content = toHtml(page.body, new Map(site.pages.map(other => [other.path, other])));
    return await renderLayout(root, page.layout ?? site.config.layout, {title: escapeHtml(page.title), site: escapeHtml(site.config.title), content});
  } catch (cause) {
    throw new BuildError(page.path, cause);
  }
}
`, {doc: RENDER_DOC}),
  'src/build.js': fill(js`import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathExists} from './fsutil.js';
import {renderPage} from './render.js';
import {loadSite} from './site.js';

@doc@
export async function buildSite(root, outDir) {
  const site = await loadSite(root);
  const tmp = outDir + '.tmp';
  const old = outDir + '.old';
  await rm(tmp, {recursive: true, force: true});
  await mkdir(tmp, {recursive: true});
  const files = [];
  try {
    for (const page of site.pages) {
      const html = await renderPage(root, site, page);
      const file = path.join(tmp, page.out);
      await mkdir(path.dirname(file), {recursive: true});
      await writeFile(file, html);
      files.push(page.out);
    }
    await writeFile(path.join(tmp, 'sitemap.txt'), files.map(name => name + '\n').join(''));
    files.push('sitemap.txt');
  } catch (err) {
    await rm(tmp, {recursive: true, force: true});
    throw err;
  }
  await rm(old, {recursive: true, force: true});
  if (await pathExists(outDir)) await rename(outDir, old);
  await rename(tmp, outDir);
  await rm(old, {recursive: true, force: true});
  return {files};
}
`, {doc: BUILD_DOC}),
  'bin/notes.js': CLI_SYNC
    .replace('function main(args) {', 'async function main(args) {')
    .replace('for (const page of listPages(root))', 'for (const page of await listPages(root))')
    .replace("loadSite(root).pages.length", "(await loadSite(root)).pages.length")
    .replace('buildSite(root, out).files.length', '(await buildSite(root, out)).files.length')
    .replace('process.exitCode = main(process.argv.slice(2));', 'process.exitCode = await main(process.argv.slice(2));'),
  ...fillTests(false),
};

// ---------- hidden tests ----------

const HEAD = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const lib = await import('@ROOT@src/index.js');
const CLI = fileURLToPath('@ROOT@bin/notes.js');
const LAYOUT = '<title>{{title}} - {{site}}</title>\n<main>{{content}}</main>\n';
const roots = [];
process.on('exit', () => { for (const root of roots) rmSync(root, {recursive: true, force: true, maxRetries: 3}); });
function makeSite(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ab-notes-hidden-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), {recursive: true});
    if (text === null) mkdirSync(file, {recursive: true}); else writeFileSync(file, text);
  }
  return root;
}
// Requires a Promise back: a synchronous throw or a plain value fails the test.
function call(fn) {
  let value;
  try { value = fn(); } catch (err) { assert.fail('threw synchronously instead of returning a rejected Promise: ' + err); }
  assert.ok(value instanceof Promise, 'expected a Promise, got ' + (value === null ? 'null' : typeof value));
  return value;
}
async function rejection(fn) {
  const promise = call(fn);
  try { await promise; } catch (err) { return err; }
  assert.fail('expected the Promise to reject');
}
function tree(dir) {
  const out = {};
  const walk = rel => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const child = rel ? rel + '/' + name : name;
      if (statSync(path.join(dir, child)).isDirectory()) { out[child + '/'] = 'dir'; walk(child); }
      else out[child] = readFileSync(path.join(dir, child), 'utf8');
    }
  };
  walk('');
  return out;
}
const page = (title, body = '', extra = '') => '---\ntitle: ' + title + '\n' + extra + '---\n' + body;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
`;

const HIDDEN_FS = HEAD + js`
test('functions without I/O stay synchronous', () => {
  assert.deepEqual(lib.parseFrontMatter('---\ntitle: T\n---\nbody'), {data: {title: 'T'}, body: 'body'});
  assert.equal(lib.escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  assert.equal(lib.toHtml('# Hi\n\nx [[a]]', new Map([['a.md', {title: 'A'}]])), '<h1>Hi</h1>\n<p>x <a href="/a.html">A</a></p>');
  assert.equal(lib.fillTemplate('{{a}}-{{b}}', {a: 1}), '1-');
  assert.throws(() => lib.parseFrontMatter('---\ntitle: T\n'), lib.FrontMatterError);
});

test('readText', async () => {
  const root = makeSite({'a.txt': 'h\u00e9llo\n', 'dir/x.txt': 'x'});
  assert.equal(await call(() => lib.readText(path.join(root, 'a.txt'))), 'h\u00e9llo\n');
  const missing = path.join(root, 'nope.txt');
  const err = await rejection(() => lib.readText(missing));
  assert.ok(err instanceof lib.NotFoundError, 'NotFoundError expected, got ' + err);
  assert.equal(err.name, 'NotFoundError');
  assert.equal(err.path, missing);
  assert.equal(err.message, 'not found: ' + missing);
  assert.equal(err.cause?.code, 'ENOENT');
  const dirErr = await rejection(() => lib.readText(path.join(root, 'dir')));
  assert.ok(!(dirErr instanceof lib.NotFoundError));
  assert.equal(dirErr.code, 'EISDIR');
});

test('readJson', async () => {
  const root = makeSite({'ok.json': '{"a": [1, 2]}', 'bad.json': '{"a": '});
  assert.deepEqual(await call(() => lib.readJson(path.join(root, 'ok.json'))), {a: [1, 2]});
  const syntax = await rejection(() => lib.readJson(path.join(root, 'bad.json')));
  assert.ok(syntax instanceof SyntaxError);
  const missing = await rejection(() => lib.readJson(path.join(root, 'none.json')));
  assert.ok(missing instanceof lib.NotFoundError);
  assert.equal(missing.path, path.join(root, 'none.json'));
});

test('pathExists', async () => {
  const root = makeSite({'f.txt': '', 'd/': null});
  assert.equal(await call(() => lib.pathExists(path.join(root, 'f.txt'))), true);
  assert.equal(await call(() => lib.pathExists(path.join(root, 'd'))), true);
  assert.equal(await call(() => lib.pathExists(path.join(root, 'nope'))), false);
  assert.equal(await call(() => lib.pathExists(path.join(root, 'nope', 'deeper', 'x'))), false);
});

test('listDir', async () => {
  const names = ['b.txt', 'A', 'a.md', 'Z.txt', '10', '9.md', 'a-b', 'c', '_x'];
  const files = {};
  for (const name of names) files['d/' + name] = /\.|_/.test(name) ? 'x' : null;
  const root = makeSite(files);
  const got = await call(() => lib.listDir(path.join(root, 'd')));
  assert.deepEqual(got, [...names].sort().map(name => ({name, dir: !/\.|_/.test(name)})));
  const err = await rejection(() => lib.listDir(path.join(root, 'missing')));
  assert.ok(err instanceof lib.NotFoundError);
  assert.equal(err.path, path.join(root, 'missing'));
  assert.equal(err.cause?.code, 'ENOENT');
});

test('loadConfig', async () => {
  const none = makeSite({});
  const defaults = await call(() => lib.loadConfig(none));
  assert.deepEqual(defaults, {title: 'Notes', layout: 'default'});
  assert.notEqual(defaults, lib.DEFAULTS);
  assert.deepEqual(await call(() => lib.loadConfig(makeSite({'site.json': '{"layout": "post", "extra": 1}'}))), {title: 'Notes', layout: 'post', extra: 1});

  const text = '{"title": "x",}';
  let expected;
  try { JSON.parse(text); } catch (err) { expected = err.message; }
  const bad = await rejection(() => lib.loadConfig(makeSite({'site.json': text})));
  assert.ok(bad instanceof lib.ConfigError, 'ConfigError expected, got ' + bad);
  assert.equal(bad.message, 'invalid site.json: ' + expected);
  assert.ok(bad.cause instanceof SyntaxError);

  const dirRoot = makeSite({'site.json/': null});
  const dir = await rejection(() => lib.loadConfig(dirRoot));
  assert.ok(dir instanceof lib.ConfigError, 'ConfigError expected, got ' + dir);
  assert.equal(dir.cause?.code, 'EISDIR');

  const both = await rejection(() => lib.loadConfig(makeSite({'site.json': '{"title": "", "layout": 3}'})));
  assert.ok(both instanceof lib.ConfigError);
  assert.equal(both.message, 'site.json: "title" must be a non-empty string');
  assert.equal(both.cause, undefined);
});
`;

const HIDDEN_PAGES = HEAD + js`
test('listPages: depth-first, code unit order', async () => {
  const names = ['C.md', 'a/z.md', 'a/y.md', 'a.md', 'b.md', 'a/b/c/d.md', 'a/b.md', 'a/b/x.md', 'a/b/c.md', 'notes.txt', 'z/readme.txt', 'z/q.md', '10.md', '9.md', 'x-y.md', 'x/1.md', 'x/0/0.md'];
  for (let i = 0; i < 40; i++) names.push('deep/' + (i % 4) + '/' + (i % 3) + '/p' + i + '.md', 'w' + i + '.md');
  const files = {};
  for (const name of names) files['pages/' + name] = page(name);
  const root = makeSite(files);
  const expected = [];
  const walk = rel => {
    for (const name of readdirSync(path.join(root, 'pages', rel)).sort()) {
      const child = rel ? rel + '/' + name : name;
      if (statSync(path.join(root, 'pages', child)).isDirectory()) walk(child);
      else if (name.endsWith('.md')) expected.push(child);
    }
  };
  walk('');
  assert.deepEqual(expected.slice(0, 11), ['10.md', '9.md', 'C.md', 'a/b/c/d.md', 'a/b/c.md', 'a/b/x.md', 'a/b.md', 'a/y.md', 'a/z.md', 'a.md', 'b.md']);
  for (let i = 0; i < 3; i++) assert.deepEqual(await call(() => lib.listPages(root)), expected);
  const empty = makeSite({});
  const err = await rejection(() => lib.listPages(empty));
  assert.ok(err instanceof lib.NotFoundError);
  assert.equal(err.path, path.join(empty, 'pages'));
});

test('loadPage', async () => {
  const root = makeSite({
    'pages/guide/intro.md': page('Intro', 'Body\n', 'layout: post\n'),
    'pages/plain.md': 'just text\n',
    'pages/broken.md': '---\ntitle: X\nnot a pair\n---\n',
    'pages/dup.md': '---\ntitle: X\ntitle: Y\n---\n',
  });
  assert.deepEqual(await call(() => lib.loadPage(root, 'guide/intro.md')), {path: 'guide/intro.md', title: 'Intro', layout: 'post', body: 'Body\n', out: 'guide/intro.html'});

  const name = await rejection(() => lib.loadPage(root, 'guide/No_Such.md'));
  assert.ok(name instanceof lib.PageError, 'PageError expected (checked before reading), got ' + name);
  assert.equal(name.path, 'guide/No_Such.md');
  assert.equal(name.message, 'invalid file name');
  assert.equal(name.cause, undefined);

  const untitled = await rejection(() => lib.loadPage(root, 'plain.md'));
  assert.ok(untitled instanceof lib.PageError);
  assert.equal(untitled.message, 'missing title');
  assert.equal(untitled.cause, undefined);

  const broken = await rejection(() => lib.loadPage(root, 'broken.md'));
  assert.ok(broken instanceof lib.PageError);
  assert.equal(broken.path, 'broken.md');
  assert.equal(broken.message, 'line 3: expected "key: value"');
  assert.ok(broken.cause instanceof lib.FrontMatterError);
  assert.equal(broken.cause.line, 3);

  const dup = await rejection(() => lib.loadPage(root, 'dup.md'));
  assert.equal(dup.message, 'line 3: duplicate key "title"');

  const missing = await rejection(() => lib.loadPage(root, 'gone.md'));
  assert.ok(missing instanceof lib.NotFoundError, 'NotFoundError expected, got ' + missing);
  assert.equal(missing.path, path.join(root, 'pages', 'gone.md'));
});

test('loadSite collects every invalid page in listPages order', async () => {
  const root = makeSite({
    'pages/a/z.md': '---\ntitle: Z\nbroken\n---\n',
    'pages/a.md': 'just text\n',
    'pages/b.md': page('B', 'b body\n'),
    'pages/c/ok.md': page('OK'),
    'pages/x_y.md': page('XY'),
    'pages/zz/Deep.md': page('Deep'),
    'pages/zz.md': '---\ntitle: Z',
  });
  const err = await rejection(() => lib.loadSite(root));
  assert.ok(err instanceof lib.ValidationError, 'ValidationError expected, got ' + err);
  assert.deepEqual(err.errors.map(e => e.path), ['a/z.md', 'a.md', 'x_y.md', 'zz/Deep.md', 'zz.md']);
  assert.ok(err.errors.every(e => e instanceof lib.PageError));
  assert.deepEqual(err.errors.map(e => e.message), ['line 3: expected "key: value"', 'missing title', 'invalid file name', 'invalid file name', 'line 1: unterminated front matter']);
  assert.ok(err.errors[0].cause instanceof lib.FrontMatterError);
  assert.ok(err.errors[4].cause instanceof lib.FrontMatterError);
  assert.equal(err.message, '5 invalid page(s): a/z.md, a.md, x_y.md, zz/Deep.md, zz.md');
});

test('loadSite returns config and pages in order', async () => {
  const files = {'site.json': '{"title": "Dev"}'};
  const order = ['a/b.md', 'a.md', 'b.md', 'c/d/e.md'];
  for (let i = 0; i < 30; i++) files['pages/m' + String(i).padStart(2, '0') + '.md'] = page('M' + i, 'x'.repeat((30 - i) * 2000));
  for (const name of order) files['pages/' + name] = page(name);
  const root = makeSite(files);
  const site = await call(() => lib.loadSite(root));
  assert.deepEqual(site.config, {title: 'Dev', layout: 'default'});
  assert.deepEqual(site.pages.map(p => p.path), [...order.slice(0, 3), 'c/d/e.md', ...Array.from({length: 30}, (_, i) => 'm' + String(i).padStart(2, '0') + '.md')]);
  assert.equal(site.pages[4].body, 'x'.repeat(60000));
  const config = await rejection(() => lib.loadSite(makeSite({'site.json': '{', 'pages/a.md': page('A')})));
  assert.ok(config instanceof lib.ConfigError);
  const noPages = await rejection(() => lib.loadSite(makeSite({})));
  assert.ok(noPages instanceof lib.NotFoundError);
});
`;

const SITE_FILES = js`{
  'site.json': '{"title": "Dev Notes"}',
  'layouts/default.html': LAYOUT,
  'layouts/post.html': '<article>{{title}}|{{content}}|{{missing}}</article>\n',
  'pages/index.md': page('Home & <Welcome>', '# Notes\n\nSee [[guide/intro]] and\n  [[about]].\n\n## Next\n'),
  'pages/about.md': page('About', 'Us.\n', 'layout: post\n'),
  'pages/guide.md': page('Guide', 'All guides.\n'),
  'pages/guide/intro.md': page('Intro', 'Start [[guide/setup]].\n'),
  'pages/guide/setup.md': page('Setup', ''),
}`;

const HIDDEN_BUILD = HEAD + js`
const site = () => makeSite(@SITE@);
const INDEX_HTML = '<title>Home &amp; &lt;Welcome&gt; - Dev Notes</title>\n<main><h1>Notes</h1>\n<p>See <a href="/guide/intro.html">Intro</a> and <a href="/about.html">About</a>.</p>\n<h2>Next</h2></main>\n';
const FILES = ['about.html', 'guide/intro.html', 'guide/setup.html', 'guide.html', 'index.html', 'sitemap.txt'];

test('renderLayout', async () => {
  const root = site();
  assert.equal(await call(() => lib.renderLayout(root, 'post', {title: 'T', content: 'C'})), '<article>T|C|</article>\n');
  const err = await rejection(() => lib.renderLayout(root, 'nope', {}));
  assert.ok(err instanceof lib.NotFoundError);
  assert.equal(err.path, path.join(root, 'layouts', 'nope.html'));
});

test('renderPage', async () => {
  const root = site();
  const loaded = await lib.loadSite(root);
  const byPath = Object.fromEntries(loaded.pages.map(p => [p.path, p]));
  assert.equal(await call(() => lib.renderPage(root, loaded, byPath['index.md'])), INDEX_HTML);
  assert.equal(await call(() => lib.renderPage(root, loaded, byPath['about.md'])), '<article>About|<p>Us.</p>|</article>\n');

  const noLayout = await rejection(() => lib.renderPage(root, loaded, {...byPath['guide.md'], layout: 'nope'}));
  assert.ok(noLayout instanceof lib.BuildError, 'BuildError expected, got ' + noLayout);
  assert.equal(noLayout.path, 'guide.md');
  assert.ok(noLayout.cause instanceof lib.NotFoundError);
  assert.equal(noLayout.cause.path, path.join(root, 'layouts', 'nope.html'));
  assert.equal(noLayout.message, 'guide.md: not found: ' + path.join(root, 'layouts', 'nope.html'));

  const link = await rejection(() => lib.renderPage(root, loaded, {...byPath['guide.md'], body: 'to [[nowhere]]'}));
  assert.ok(link instanceof lib.BuildError);
  assert.ok(link.cause instanceof lib.LinkError);
  assert.equal(link.message, 'guide.md: broken link [[nowhere]]');
});

test('buildSite into a new directory', async () => {
  const root = site();
  const before = readdirSync(root).sort();
  const out = path.join(root, 'dist');
  assert.deepEqual(await call(() => lib.buildSite(root, out)), {files: FILES});
  const built = tree(out);
  assert.deepEqual(Object.keys(built).filter(name => !name.endsWith('/')).sort(), [...FILES].sort());
  assert.equal(built['index.html'], INDEX_HTML);
  assert.equal(built['guide/setup.html'], '<title>Setup - Dev Notes</title>\n<main></main>\n');
  assert.equal(built['guide/intro.html'], '<title>Intro - Dev Notes</title>\n<main><p>Start <a href="/guide/setup.html">Setup</a>.</p></main>\n');
  assert.equal(built['sitemap.txt'], FILES.slice(0, 5).join('\n') + '\n');
  await sleep(200);
  assert.deepEqual(readdirSync(root).sort(), [...before, 'dist'].sort());
  assert.deepEqual(tree(out), built);
});

test('buildSite replaces an existing output directory', async () => {
  const root = site();
  const out = path.join(root, 'public');
  mkdirSync(path.join(out, 'old', 'deep'), {recursive: true});
  writeFileSync(path.join(out, 'index.html'), 'old index');
  writeFileSync(path.join(out, 'old', 'deep', 'x.html'), 'old');
  mkdirSync(path.join(root, 'public.tmp', 'stale'), {recursive: true});
  writeFileSync(path.join(root, 'public.tmp', 'stale', 'x.html'), 'left over from an earlier run');
  const before = readdirSync(root).filter(name => name !== 'public.tmp').sort();
  assert.deepEqual(await call(() => lib.buildSite(root, out)), {files: FILES});
  assert.deepEqual(Object.keys(tree(out)).filter(name => !name.endsWith('/')).sort(), [...FILES].sort());
  assert.equal(readFileSync(path.join(out, 'index.html'), 'utf8'), INDEX_HTML);
  assert.deepEqual(readdirSync(root).sort(), before);
});

test('a failure mid-build leaves everything as it was', async () => {
  const root = makeSite({
    'layouts/default.html': LAYOUT,
    'pages/a.md': page('A', 'a\n'),
    'pages/b.md': page('B', 'b\n', 'layout: nope\n'),
    'pages/c.md': page('C', 'see [[nowhere]]\n'),
    'pages/d.md': page('D', 'd\n'),
    'dist/a.html': 'old a',
    'dist/keep/me.txt': 'keep',
  });
  const out = path.join(root, 'dist');
  const snapshot = tree(out);
  const listing = readdirSync(root).sort();
  const err = await rejection(() => lib.buildSite(root, out));
  assert.ok(err instanceof lib.BuildError, 'BuildError expected, got ' + err);
  assert.equal(err.path, 'b.md', 'the first failing page in listPages order');
  assert.ok(err.cause instanceof lib.NotFoundError);
  assert.deepEqual(tree(out), snapshot);
  assert.deepEqual(readdirSync(root).sort(), listing);
  await sleep(300);
  assert.deepEqual(tree(out), snapshot);
  assert.deepEqual(readdirSync(root).sort(), listing);
});

test('an invalid site writes nothing', async () => {
  const root = makeSite({'layouts/default.html': LAYOUT, 'pages/a.md': page('A'), 'pages/Bad.md': page('Bad')});
  const listing = readdirSync(root).sort();
  const err = await rejection(() => lib.buildSite(root, path.join(root, 'dist')));
  assert.ok(err instanceof lib.ValidationError);
  await sleep(100);
  assert.deepEqual(readdirSync(root).sort(), listing);
});
`.replace('@SITE@', SITE_FILES);

const HIDDEN_CLI = HEAD + js`
const notes = (args, cwd) => {
  const result = spawnSync(process.execPath, [CLI, ...args], {cwd, encoding: 'utf8', timeout: 30000});
  return {status: result.status, stdout: result.stdout.replace(/\r\n/g, '\n'), stderr: result.stderr.replace(/\r\n/g, '\n')};
};
const site = () => makeSite(@SITE@);

test('list and check', () => {
  const root = site();
  assert.deepEqual(notes(['list', '--root', root]), {status: 0, stdout: 'about.md\nguide/intro.md\nguide/setup.md\nguide.md\nindex.md\n', stderr: ''});
  assert.deepEqual(notes(['check'], root), {status: 0, stdout: 'ok: 5 pages\n', stderr: ''});
});

test('build', () => {
  const root = site();
  assert.deepEqual(notes(['build', '--root', root]), {status: 0, stdout: 'built 6 files into ' + path.join(root, 'dist') + '\n', stderr: ''});
  assert.ok(statSync(path.join(root, 'dist', 'index.html')).isFile());
  assert.deepEqual(notes(['build', '--out', 'public'], root), {status: 0, stdout: 'built 6 files into ' + path.join(root, 'public') + '\n', stderr: ''});
  assert.ok(statSync(path.join(root, 'public', 'guide', 'intro.html')).isFile());
});

test('invalid pages: exit 1, one line per page in order', () => {
  const root = makeSite({'pages/zz.md': 'no title\n', 'pages/a/b.md': '---\nbad\n---\n', 'pages/m_n.md': page('MN'), 'pages/a.md': page('A')});
  assert.deepEqual(notes(['check', '--root', root]), {status: 1, stdout: '', stderr: 'a/b.md: line 2: expected "key: value"\nm_n.md: invalid file name\nzz.md: missing title\n'});
  assert.deepEqual(notes(['build', '--root', root]), {status: 1, stdout: '', stderr: 'a/b.md: line 2: expected "key: value"\nm_n.md: invalid file name\nzz.md: missing title\n'});
});

test('other errors: exit 2', () => {
  const text = '{"title": ';
  let parse;
  try { JSON.parse(text); } catch (err) { parse = err.message; }
  const bad = makeSite({'site.json': text, 'pages/a.md': page('A')});
  assert.deepEqual(notes(['build', '--root', bad]), {status: 2, stdout: '', stderr: 'error: invalid site.json: ' + parse + '\n'});
  assert.deepEqual(notes(['check', '--root', bad]), {status: 2, stdout: '', stderr: 'error: invalid site.json: ' + parse + '\n'});

  const layout = makeSite({'layouts/default.html': LAYOUT, 'pages/a.md': page('A'), 'pages/b.md': page('B', '', 'layout: nope\n'), 'dist/x.txt': 'x'});
  assert.deepEqual(notes(['build', '--root', layout]), {status: 2, stdout: '', stderr: 'error: b.md: not found: ' + path.join(layout, 'layouts', 'nope.html') + '\n'});
  assert.deepEqual(readdirSync(path.join(layout, 'dist')), ['x.txt']);

  const empty = makeSite({});
  assert.deepEqual(notes(['list', '--root', empty]), {status: 2, stdout: '', stderr: 'error: not found: ' + path.join(empty, 'pages') + '\n'});
});

test('usage: exit 64', () => {
  const usage = 'usage: notes <list|check|build> [--root DIR] [--out DIR]\n';
  const root = site();
  assert.deepEqual(notes(['publish'], root), {status: 64, stdout: '', stderr: usage});
  assert.deepEqual(notes([], root), {status: 64, stdout: '', stderr: usage});
  assert.deepEqual(notes(['list', '--root'], root), {status: 64, stdout: '', stderr: usage});
});
`.replace('@SITE@', SITE_FILES);

// ---------- verification ----------

const PROMPT = `Convert this library (src/) from synchronous fs calls to asynchronous code using node:fs/promises.

- Every exported function in src/ that does filesystem I/O (the ones marked "yes" in the API table of README.md) must return a Promise, and it must report every failure by rejecting that Promise, never by throwing synchronously. Functions without I/O stay synchronous.
- No *Sync call (readFileSync, statSync, existsSync, ...) may remain anywhere in src/.
- Behavior must stay exactly as documented in README.md and the JSDoc comments: the same resolved values, the same error classes with the same messages and properties (.path, .cause, .errors, ...), the same ordering, and buildSite stays all-or-nothing.
- bin/notes.js must keep its output and exit codes.
- Update the tests in test/ to the async API, changing only what the API change requires: keep every test and every assertion. \`npm test\` must pass.
- Do not add dependencies.`;

const TEST_FILES = Object.keys(FIXTURE).filter(name => name.startsWith('test/')).sort();
const testShape = text => ({titles: [...text.matchAll(/\btest\(\s*(['"])(.*?)\1/g)].map(match => match[2]), asserts: (text.match(/\bassert\.\w+\(/g) ?? []).length});
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function patch(root, file, from, to) {
  const text = read(root, file);
  if (!text.includes(from)) throw Error('mustReject patch target missing in ' + file + ': ' + from.slice(0, 60));
  writeTree(root, {[file]: text.replace(from, to)});
}

export default {
  id: 'async-refactor',
  category: 'multi-file async refactor',
  prompt: PROMPT,
  setup: root => gitRepo(root, [['notes: static site tool', FIXTURE]]),
  solve: root => writeTree(root, REFERENCE),
  verify(root) {
    const files = projectFiles(root);
    const src = files.filter(name => name.startsWith('src/') && /\.[cm]?js$/.test(name));
    const syncLeft = src.filter(name => /\w*Sync\b/.test(stripComments(read(root, name))));
    let pkg = {};
    try { pkg = JSON.parse(read(root, 'package.json')); } catch {}
    const deps = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']
      .filter(key => pkg[key] && Object.keys(pkg[key]).length);
    // Every original test file, test and assertion is still there; additions are fine.
    const testsKept = TEST_FILES.every(name => files.includes(name)) && TEST_FILES.filter(name => name.endsWith('.test.js')).every(name => {
      const was = testShape(FIXTURE[name]);
      const now = testShape(read(root, name));
      return was.titles.every(title => now.titles.includes(title)) && now.asserts >= was.asserts;
    });
    const suite = npm(root, 'test');
    const fsCheck = hiddenTests(root, HIDDEN_FS, 'fsutil.test.mjs');
    const pages = hiddenTests(root, HIDDEN_PAGES, 'pages.test.mjs');
    const build = hiddenTests(root, HIDDEN_BUILD, 'build.test.mjs');
    const cli = hiddenTests(root, HIDDEN_CLI, 'cli.test.mjs');
    return verdict({
      no_sync_calls_in_src: syncLeft.length === 0,
      no_new_dependencies: deps.length === 0,
      tests_kept: testsKept,
      suite_passes: suite.status === 0,
      hidden_fsutil_config: fsCheck.pass,
      hidden_pages_site: pages.pass,
      hidden_render_build: build.pass,
      hidden_cli: cli.pass,
    }, {syncLeft, deps, suite: (suite.stdout + suite.stderr).slice(-1500),
      hidden: {fsutil: fsCheck.output, pages: pages.output, build: build.output, cli: cli.output}});
  },
  mustReject: [
    // 1. One leftover sync call (behavior identical, so only the static check sees it).
    root => {
      patch(root, 'src/fsutil.js', "import path from 'node:path';\n", "import {existsSync} from 'node:fs';\nimport path from 'node:path';\n");
      patch(root, 'src/fsutil.js', '  try {\n    await access(p);\n    return true;\n  } catch {\n    return false;\n  }', '  return existsSync(p);');
    },
    // 2. forEach(async) in the build loop: the swap runs before the page writes land.
    root => {
      patch(root, 'src/build.js', '    for (const page of site.pages) {\n      const html', '    site.pages.forEach(async page => {\n      const html');
      patch(root, 'src/build.js', '      files.push(page.out);\n    }\n', '      files.push(page.out);\n    });\n');
    },
    // 3. return without await inside try: the SyntaxError escapes the ConfigError wrapping.
    root => patch(root, 'src/config.js', 'return await readJson(file);', 'return readJson(file);'),
    // 4. Promise.all straight into outDir: first-to-fail error and partial output.
    root => writeTree(root, {'src/build.js': js`import {mkdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {renderPage} from './render.js';
import {loadSite} from './site.js';

export async function buildSite(root, outDir) {
  const site = await loadSite(root);
  const files = site.pages.map(page => page.out);
  await Promise.all(site.pages.map(async page => {
    const html = await renderPage(root, site, page);
    const file = path.join(outDir, page.out);
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, html);
  }));
  await writeFile(path.join(outDir, 'sitemap.txt'), files.map(name => name + '\n').join(''));
  return {files: [...files, 'sitemap.txt']};
}
`}),
    // 5. Same wrapping bug in renderPage: a missing layout surfaces as a bare NotFoundError.
    root => patch(root, 'src/render.js', 'return await renderLayout(', 'return renderLayout('),
    // 6. Concurrent page loading that pushes errors as they arrive: aggregated order breaks.
    root => patch(root, 'src/site.js', `  for (const rel of await listPages(root)) {
    try {
      pages.push(await loadPage(root, rel));
    } catch (err) {
      if (!(err instanceof PageError)) throw err;
      errors.push(err);
    }
  }`, `  await Promise.all((await listPages(root)).map(async rel => {
    try {
      pages.push(await loadPage(root, rel));
    } catch (err) {
      if (!(err instanceof PageError)) throw err;
      errors.push(err);
    }
  }));`),
    // 7. Concurrent directory walk that pushes as it goes: subdirectory pages land after their siblings.
    root => patch(root, 'src/pages.js', `    for (const entry of await listDir(path.join(root, 'pages', rel))) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.dir) await walk(child);
      else if (entry.name.endsWith('.md')) out.push(child);
    }`, `    await Promise.all((await listDir(path.join(root, 'pages', rel))).map(async entry => {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.dir) await walk(child);
      else if (entry.name.endsWith('.md')) out.push(child);
    }));`),
    // 8. CLI promise without a handler: errors become unhandled rejections (exit 1, stack trace).
    root => patch(root, 'bin/notes.js', 'process.exitCode = await main(process.argv.slice(2));', 'main(process.argv.slice(2)).then(code => { process.exitCode = code; });'),
    // 9. A visible assertion dropped instead of converted.
    root => patch(root, 'test/build.test.js', "    assert.equal(existsSync(path.join(out, 'old.html')), false);\n", ''),
    // 10. A synchronous throw from an I/O function (invalid name checked outside the async body).
    root => patch(root, 'src/pages.js', 'export async function loadPage(root, rel) {\n  if (!FILE_NAME.test(rel.split(\'/\').pop())) throw new PageError(rel, \'invalid file name\');\n',
      'export function loadPage(root, rel) {\n  if (!FILE_NAME.test(rel.split(\'/\').pop())) throw new PageError(rel, \'invalid file name\');\n  return loadValid(root, rel);\n}\n\nasync function loadValid(root, rel) {\n'),
    // 11. The existsSync check converted without await: a Promise is truthy, so a first build renames a missing outDir.
    root => patch(root, 'src/build.js', 'if (await pathExists(outDir))', 'if (pathExists(outDir))'),
  ],
};
