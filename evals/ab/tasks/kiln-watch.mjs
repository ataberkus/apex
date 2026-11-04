import {gitRepo, hiddenTests, literalChars, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Markdown with code spans: '~' stands for a backtick so the docs can live in template literals.
const md = text => text.replaceAll('~', '\x60');

const LANGUAGE_DOC = md(`# The kiln module language

A project is a set of text files addressed by POSIX-style paths relative to the project root, such as ~app/main.mod~
(no leading ~./~, no ~..~ segments). Modules are the files whose names end in ~.mod~; any file can be included as text.

## Lines and statements

The lines of a file are its text split at ~\\n~; a final ~\\n~ ends the last line instead of starting an empty one, and an
empty file has no lines. Every line of a module is exactly one statement, recognised in this order:

1. ~import "<spec>"~ — exactly the word ~import~, one space and a double-quoted, non-empty spec without ~"~, and nothing
   else on the line. Imports a module.
2. ~include "<spec>"~ — the same shape with the word ~include~. Includes a text file.
3. ~const NAME = <template>~ — ~const~, one space, a name matching ~[A-Z][A-Z0-9_]*~, the three characters ~ = ~ and then
   the rest of the line (possibly empty) as the value template. Defines a constant.
4. Any other line is a text line, including lines that only resemble statements (leading spaces, lower-case names, ...).

## Resolution

A spec must start with ~./~ or ~../~. It is joined to the directory of the file that contains the statement and
normalised (~.~ and ~..~ segments removed); a result that climbs above the project root cannot be resolved.

- ~include~: the joined path itself must be an existing file.
- ~import~: when the joined path ends in ~.mod~, that file. Otherwise ~<path>.mod~ if that file exists, else
  ~<path>/index.mod~. So when both ~lib/util.mod~ and ~lib/util/index.mod~ exist, ~import "./util"~ in ~lib/x.mod~
  resolves to ~lib/util.mod~; when only one of them exists, to that one.

A spec that cannot be resolved throws ~BuildError~ ~Cannot resolve "<spec>" from <file>~, where ~<file>~ is the path of
the file containing the statement. Resolution always reflects the files that exist when the build runs.

## Constants

In a template, ~{{NAME}}~ with a name matching ~[A-Za-z_][A-Za-z0-9_]*~ is a reference. Expanding a template replaces
every reference by the value of the visible constant of that name, inserted verbatim (values are never expanded again).
A reference to a name that is not visible throws ~BuildError~ ~Unknown constant <NAME> in <module>~.

A ~const~ statement defines the constant ~NAME~ of its module, whose value is the expanded template. Defining the same name
twice in one module throws ~BuildError~ ~Duplicate constant <NAME> in <module>~; that check happens before the second
template is expanded.

The names visible to a statement, first match wins:

1. the constants that the module itself defines on earlier lines;
2. the constants defined by the module's direct imports, the import listed last first. An import's constants are only
   the ones it defines itself; what it sees from its own imports is not passed on;
3. ~__FILE__~, whose value is the path of the module.

## Module output

A module's output lines, in line order: ~import~ and ~const~ lines produce nothing; a text line produces its expanded
text; an ~include~ line produces the lines of the included file, verbatim (included text is never expanded).

## Bundles

The bundle of an entry module lists the modules of its import graph in post-order: depth first from the entry, a
module's imports in the order they are listed, every import before the module that imports it, and each module only
once, where it is first reached. Each module contributes a header line ~// <path>~ followed by its output lines. The
bundle is all of these lines joined with ~\\n~, plus a final ~\\n~.

Example: ~app/main.mod~ is ~import "../lib/greet"~, ~const WHO = World~, ~{{HELLO}}, {{WHO}}!~ and ~lib/greet.mod~ is
~const HELLO = Hello~. The bundle of ~app/main.mod~ is the three lines ~// lib/greet.mod~, ~// app/main.mod~,
~Hello, World!~ (each followed by ~\\n~).

## Loading and errors

The graph is loaded depth first from the entry. Loading a module reads it, resolves (and reads) its includes in line
order, and then resolves and loads its imports in order, each import completely before the next one is resolved. A missing
entry throws ~BuildError~ ~Cannot read <entry>~. An import of a module that is still being loaded closes an import cycle
and throws ~BuildError~ ~Import cycle: <a> -> <b> -> ... -> <a>~: the chain of imports from that module back to itself,
for example ~Import cycle: app/b.mod -> app/c.mod -> app/b.mod~.

Constant errors are found only after the whole graph has loaded, by compiling the modules in bundle order; the first
error found is thrown.
`);

const BUILD_DOC = md(`# The builder

~createBuilder({fs, clock})~ in ~src/index.js~ returns a builder with one method, ~build(entry)~.

- ~fs~ is any object with ~stat(path)~, which returns ~{mtime, size}~ or ~null~ when the file does not exist, and
  ~readFile(path)~, which returns the file's text. The builder uses only these two methods. ~src/fs/memory-fs.js~ is an
  implementation; like many real file systems it keeps mtimes with a resolution of one second: a file written at clock
  time t gets the mtime ~floor(t / 1000) * 1000~. ~size~ is the length of the text in bytes.
- ~clock~ is an object whose ~now()~ returns the current time in epoch milliseconds.
- ~build(entry)~ returns ~{output, compiled}~: ~output~ is the bundle of the entry module (docs/LANGUAGE.md) and
  ~compiled~ lists the paths of the modules compiled during this build, in bundle order. Errors are thrown as
  ~BuildError~ (~src/errors.js~).

## One builder, many builds

The dev server keeps one builder for as long as it runs and calls ~build~ after every change to the files. Whatever
happened before, every build returns exactly the output, or throws exactly the error, that a new builder would return or
throw for the files as they are at that moment. Only the work done may differ, as described below.

## Cache

Compiled modules are cached by module key, and the cache keeps every entry it has ever stored. The key of a module is
a hash of:

- its path,
- its text,
- the texts of the files it includes, in line order,
- the keys of its direct imports, in import order.

A build compiles a module exactly when the cache has no entry for the module's key, and then stores the result under
that key. So after a file changes, the build compiles the module that changed (or every module that includes the
changed file) and every module that imports one of those, directly or indirectly — and nothing else. Changing files back
to texts that were built before compiles nothing. Modules compiled before a build fails stay cached.

## Reading files

To avoid reading unchanged files, the builder remembers, for every file it reads, the file's mtime and size at that
read, the text it read, and the time of the read (~clock.now()~). The files a build needs are the modules of the graph
and the files they include. For each of them the build calls ~fs.stat~, and it calls ~fs.readFile~ at most once per file
per build, and only when one of these holds:

- it has no remembered read of the file;
- the file's mtime or size differs from the remembered read;
- the remembered read is racy: the file's mtime is not earlier than the start of the second in which that read happened
  (the read time rounded down to a multiple of 1000 ms). Because mtimes only have whole seconds, such a file may have
  been changed again within that second without changing its mtime or its size.

Otherwise it uses the remembered text. A read replaces the remembered read of that file; files that are not read keep
theirs (also across builds that do not need them). Reads made by a build that fails are remembered too.
`);

const ARCH_DOC = md(`# Architecture

- ~src/builder.js~: ~createBuilder~ and the build pipeline: load the graph, key every module, compile what the cache
  does not have, link the bundle.
- ~src/fs/~: ~MemoryFs~ (an ~fs~ for tests and tools), ~SourceReader~ (the remembered reads of docs/BUILD.md) and the
  racy check.
- ~src/graph/~: ~Resolver~ (specs to paths), the loader (depth-first loading, import cycles) and the cycle message.
- ~src/lang/~: the statement parser, constant names and expansion, scopes and the module compiler.
- ~src/cache/~: module keys and the compile cache.
- ~src/bundle/link.js~: joins compiled modules into the bundle text.
- ~src/util/~: hashing and line splitting.

A compiled module is ~{consts, lines}~: its own constants (a ~Map~ of name to value) and its output lines. Cached
compiled modules are shared by every build that needs them and must never be modified.
`);

const README = md(`# kiln

An incremental bundler for ~.mod~ modules with a watch-mode dev server. See docs/LANGUAGE.md for the module language,
docs/BUILD.md for the builder and docs/ARCHITECTURE.md for the internals.

    npm test
`);

const PKG = JSON.stringify({name: 'kiln', version: '1.4.0', private: true, type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n';

const ERRORS = String.raw`/** Every problem with the files being built; the messages are listed in docs/LANGUAGE.md. */
export class BuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}
`;

const CLOCK = String.raw`/** A clock that moves only when told to; now() is epoch milliseconds. */
export function manualClock(start) {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}
`;

const INDEX = String.raw`export {createBuilder} from './builder.js';
export {BuildError} from './errors.js';
export {MemoryFs} from './fs/memory-fs.js';
export {manualClock} from './clock.js';
`;

const MEMORY_FS = String.raw`/**
 * An in-memory file system with the two methods the builder uses (stat, readFile) plus writeFile and deleteFile.
 * Like many real file systems it keeps mtimes in whole seconds: a write at clock time t gets mtime floor(t / 1000) * 1000.
 */
export class MemoryFs {
  #clock;
  #files = new Map();
  #reads = new Map();

  constructor(clock) {
    this.#clock = clock;
  }

  writeFile(path, text) {
    this.#files.set(path, {text, mtime: Math.floor(this.#clock.now() / 1000) * 1000, size: Buffer.byteLength(text)});
  }

  deleteFile(path) {
    this.#files.delete(path);
  }

  /** {mtime, size}, or null when the file does not exist. */
  stat(path) {
    const file = this.#files.get(path);
    return file ? {mtime: file.mtime, size: file.size} : null;
  }

  readFile(path) {
    const file = this.#files.get(path);
    if (!file) throw new Error('ENOENT: ' + path);
    this.#reads.set(path, this.readCount(path) + 1);
    return file.text;
  }

  /** How many times readFile has returned this file. */
  readCount(path) {
    return this.#reads.get(path) ?? 0;
  }
}
`;

const RACY = String.raw`/**
 * Whether a remembered read must not be trusted even though the file's mtime and size are unchanged; see
 * docs/BUILD.md (Reading files). mtime and readAt are epoch milliseconds; mtimes have whole-second resolution.
 */
export function isRacy(mtime, readAt) {
  return mtime > readAt;
}
`;

const READER = String.raw`import {BuildError} from '../errors.js';
import {digest} from '../util/hash.js';
import {isRacy} from './racy.js';

/** Reads files through fs and remembers the last read of each file, to skip reading unchanged files again. */
export class SourceReader {
  #fs;
  #clock;
  #remembered = new Map();

  constructor(fs, clock) {
    this.#fs = fs;
    this.#clock = clock;
  }

  /** The file as {text, hash}; throws 'Cannot read <path>' when it does not exist. */
  read(path) {
    const stat = this.#fs.stat(path);
    if (stat === null) throw new BuildError('Cannot read ' + path);
    const known = this.#remembered.get(path);
    if (known && known.mtime === stat.mtime && known.size === stat.size && !isRacy(known.mtime, known.readAt)) return known.source;
    const text = this.#fs.readFile(path);
    const source = {text, hash: digest(['text', text])};
    this.#remembered.set(path, {mtime: stat.mtime, size: stat.size, readAt: this.#clock.now(), source});
    return source;
  }
}
`;

const PATHS = String.raw`import path from 'node:path';

export const dirname = file => path.posix.dirname(file);

/** Join a relative spec to a directory and normalise it; null when the result climbs above the project root. */
export function joinRelative(dir, spec) {
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  return joined === '..' || joined.startsWith('../') ? null : joined;
}

export const isRelative = spec => spec.startsWith('./') || spec.startsWith('../');
`;

const RESOLVER = String.raw`import {BuildError} from '../errors.js';
import {dirname, isRelative, joinRelative} from '../paths.js';

/** Resolves import and include specs to file paths (docs/LANGUAGE.md, Resolution). Results are memoized. */
export class Resolver {
  #fs;
  #memo = new Map();

  constructor(fs) {
    this.#fs = fs;
  }

  /** kind is 'import' or 'include'; from is the path of the file containing the statement. */
  resolve(spec, from, kind) {
    const memoKey = kind + ' ' + dirname(from) + ' ' + spec;
    let found = this.#memo.get(memoKey);
    if (found === undefined) {
      found = this.#find(spec, from, kind);
      this.#memo.set(memoKey, found);
    }
    return found;
  }

  #find(spec, from, kind) {
    const base = isRelative(spec) ? joinRelative(dirname(from), spec) : null;
    const candidates = base === null ? [] : kind === 'include' || base.endsWith('.mod') ? [base] : [base + '.mod', base + '/index.mod'];
    const found = candidates.find(candidate => this.#fs.stat(candidate) !== null);
    if (found === undefined) throw new BuildError('Cannot resolve "' + spec + '" from ' + from);
    return found;
  }
}
`;

const CYCLE = String.raw`import {BuildError} from '../errors.js';

/** The error for an import of a module that is still loading; stack holds the paths being loaded, outermost first. */
export function cycleError(stack, path) {
  return new BuildError('Import cycle: ' + [...stack.slice(stack.indexOf(path)), path].join(' -> '));
}
`;

const LOADER = String.raw`import {parse} from '../lang/parse.js';
import {cycleError} from './cycle.js';

/**
 * Load the module graph of entry depth first (docs/LANGUAGE.md, Loading and errors). Every file is read at most once.
 * Returns the modules in bundle order: {path, source, statements, includes: [{spec, path, source}], imports: [module]}.
 */
export function loadGraph(entry, {reader, resolver}) {
  const sources = new Map();
  const readOnce = path => {
    if (!sources.has(path)) sources.set(path, reader.read(path));
    return sources.get(path);
  };
  const loaded = new Map();
  const order = [];
  const stack = [];

  const load = path => {
    if (stack.includes(path)) throw cycleError(stack, path);
    if (loaded.has(path)) return loaded.get(path);
    stack.push(path);
    const source = readOnce(path);
    const {imports, statements} = parse(source.text);
    const includes = statements.filter(statement => statement.kind === 'include').map(({spec}) => {
      const file = resolver.resolve(spec, path, 'include');
      return {spec, path: file, source: readOnce(file)};
    });
    const module = {path, source, statements, includes, imports: []};
    for (const spec of imports) module.imports.push(load(resolver.resolve(spec, path, 'import')));
    stack.pop();
    loaded.set(path, module);
    order.push(module);
    return module;
  };

  load(entry);
  return order;
}
`;

const NAMES = String.raw`/** Names of constants a const statement may define. */
export const CONST_NAME = '[A-Z][A-Z0-9_]*';

/** A {{NAME}} reference inside a template. */
export const REFERENCE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
`;

const PARSE = String.raw`import {splitLines} from '../util/lines.js';
import {CONST_NAME} from './names.js';

const IMPORT = /^import "([^"]+)"$/;
const INCLUDE = /^include "([^"]+)"$/;
const CONST = new RegExp('^const (' + CONST_NAME + ') = (.*)$');

/**
 * The statements of a module (docs/LANGUAGE.md): {imports: [spec], statements: [{kind: 'import', spec} |
 * {kind: 'include', spec} | {kind: 'const', name, template} | {kind: 'text', template}]} in line order.
 */
export function parse(text) {
  const imports = [];
  const statements = [];
  for (const line of splitLines(text)) {
    let match;
    if ((match = IMPORT.exec(line))) {
      imports.push(match[1]);
      statements.push({kind: 'import', spec: match[1]});
    } else if ((match = INCLUDE.exec(line))) statements.push({kind: 'include', spec: match[1]});
    else if ((match = CONST.exec(line))) statements.push({kind: 'const', name: match[1], template: match[2]});
    else statements.push({kind: 'text', template: line});
  }
  return {imports, statements};
}
`;

const SCOPE = String.raw`/**
 * What a module's statements can see (docs/LANGUAGE.md, Constants): its own constants defined so far, then the
 * constants of its direct imports (the last import first), then __FILE__.
 */
export function createScope(path, importedConsts) {
  const own = new Map();
  const lookup = name => {
    if (own.has(name)) return own.get(name);
    for (let i = importedConsts.length - 1; i >= 0; i--) {
      if (importedConsts[i].has(name)) return importedConsts[i].get(name);
    }
    return name === '__FILE__' ? path : undefined;
  };
  return {own, lookup};
}
`;

const EXPAND = String.raw`import {BuildError} from '../errors.js';
import {REFERENCE} from './names.js';

/** Replace every {{NAME}} in template by its value, verbatim; unknown names are an error of module path. */
export function expand(template, lookup, path) {
  return template.replace(REFERENCE, (_, name) => {
    const value = lookup(name);
    if (value === undefined) throw new BuildError('Unknown constant ' + name + ' in ' + path);
    return value;
  });
}
`;

const COMPILE = String.raw`import {BuildError} from '../errors.js';
import {splitLines} from '../util/lines.js';
import {expand} from './expand.js';
import {createScope} from './scope.js';

/**
 * Compile one loaded module, given the compiled modules of its direct imports (in import order).
 * Returns {consts, lines}: its own constants and its output lines (docs/LANGUAGE.md, Module output).
 */
export function compile(module, compiledImports) {
  const scope = createScope(module.path, compiledImports.map(compiled => compiled.consts));
  const includes = module.includes.values();
  const lines = [];
  for (const statement of module.statements) {
    if (statement.kind === 'const') {
      if (scope.own.has(statement.name)) throw new BuildError('Duplicate constant ' + statement.name + ' in ' + module.path);
      scope.own.set(statement.name, expand(statement.template, scope.lookup, module.path));
    } else if (statement.kind === 'include') {
      lines.push(...splitLines(includes.next().value.source.text));
    } else if (statement.kind === 'text') {
      lines.push(expand(statement.template, scope.lookup, module.path));
    }
  }
  return {consts: scope.own, lines};
}
`;

const KEYS = String.raw`import {digest} from '../util/hash.js';

/**
 * The cache key of a loaded module (docs/BUILD.md, Cache). Modules are keyed in bundle order, so the modules it
 * imports have been keyed already.
 */
export function moduleKey(module) {
  return digest([
    'module',
    module.source.hash,
    module.includes.map(include => include.source.hash),
    module.imports.map(imported => imported.source.hash),
  ]);
}
`;

const COMPILE_CACHE = String.raw`/** Compiled modules by module key; entries are never evicted. */
export class CompileCache {
  #compiled = new Map();

  get(key) {
    return this.#compiled.get(key);
  }

  set(key, compiled) {
    this.#compiled.set(key, compiled);
  }
}
`;

const LINK = String.raw`/** The bundle text (docs/LANGUAGE.md, Bundles) of modules in bundle order, each with its compiled output. */
export function link(modules) {
  const lines = [];
  for (const module of modules) {
    const chunk = module.compiled.lines;
    chunk.unshift('// ' + module.path);
    lines.push(...chunk);
  }
  return lines.join('\n') + '\n';
}
`;

const HASH = String.raw`import {createHash} from 'node:crypto';

/** sha256 hex of a JSON-serialisable value. */
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
`;

const LINES = String.raw`/** Split text into lines at '\n'; a final '\n' ends the last line, and an empty text has no lines. */
export function splitLines(text) {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}
`;

const BUILDER = String.raw`import {link} from './bundle/link.js';
import {CompileCache} from './cache/compile-cache.js';
import {moduleKey} from './cache/keys.js';
import {SourceReader} from './fs/reader.js';
import {loadGraph} from './graph/loader.js';
import {Resolver} from './graph/resolver.js';
import {compile} from './lang/compile.js';

/** A long-lived incremental builder; see docs/BUILD.md. */
export function createBuilder({fs, clock}) {
  const reader = new SourceReader(fs, clock);
  const resolver = new Resolver(fs);
  const cache = new CompileCache();
  return {
    build(entry) {
      const modules = loadGraph(entry, {reader, resolver});
      const compiled = [];
      for (const module of modules) {
        module.key = moduleKey(module);
        module.compiled = cache.get(module.key);
        if (module.compiled === undefined) {
          module.compiled = compile(module, module.imports.map(imported => imported.compiled));
          cache.set(module.key, module.compiled);
          compiled.push(module.path);
        }
      }
      return {output: link(modules), compiled};
    },
  };
}
`;

const VISIBLE_BUILD = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {createBuilder, manualClock, MemoryFs} from '../src/index.js';

const project = files => {
  const clock = manualClock(Date.parse('2024-05-01T12:00:00.250Z'));
  const fs = new MemoryFs(clock);
  for (const [path, text] of Object.entries(files)) fs.writeFile(path, text);
  return {clock, fs, builder: createBuilder({fs, clock})};
};

test('bundles a small project', () => {
  const {builder} = project({
    'app/main.mod': 'import "../lib/greet"\nconst WHO = World\n{{HELLO}}, {{WHO}}!\ninclude "../assets/banner.txt"\n',
    'lib/greet.mod': 'const HELLO = Hello\n',
    'assets/banner.txt': '** {{not expanded}} **\n',
  });
  assert.deepEqual(builder.build('app/main.mod'), {
    output: '// lib/greet.mod\n// app/main.mod\nHello, World!\n** {{not expanded}} **\n',
    compiled: ['lib/greet.mod', 'app/main.mod'],
  });
});

test('directory modules and diamonds', () => {
  const {builder} = project({
    'app/main.mod': 'import "./util"\nimport "./view.mod"\nmain sees {{V}} and {{U}}\n',
    'app/view.mod': 'import "./util"\nconst V = view of {{U}}\n',
    'app/util/index.mod': 'const U = util\nfile {{__FILE__}}\n',
  });
  assert.equal(builder.build('app/main.mod').output,
    '// app/util/index.mod\nfile app/util/index.mod\n// app/view.mod\n// app/main.mod\nmain sees view of util and util\n');
});

test('errors', () => {
  const {builder, fs} = project({
    'app/a.mod': 'import "./b"\n',
    'app/b.mod': 'import "./c"\n',
    'app/c.mod': 'import "./b"\n',
  });
  assert.throws(() => builder.build('app/a.mod'), {name: 'BuildError', message: 'Import cycle: app/b.mod -> app/c.mod -> app/b.mod'});
  fs.writeFile('app/c.mod', 'value {{MISSING}}\n');
  assert.throws(() => builder.build('app/a.mod'), {name: 'BuildError', message: 'Unknown constant MISSING in app/c.mod'});
  assert.throws(() => builder.build('app/nope.mod'), {name: 'BuildError', message: 'Cannot read app/nope.mod'});
});

test('rebuilds compile only what changed', () => {
  const {builder, clock, fs} = project({
    'app/main.mod': 'import "../lib/greet"\n{{HELLO}}!\n',
    'lib/greet.mod': 'const HELLO = Hello\n',
    'lib/other.mod': 'const OTHER = other\n',
  });
  assert.deepEqual(builder.build('app/main.mod').compiled, ['lib/greet.mod', 'app/main.mod']);
  clock.advance(1000);
  fs.writeFile('app/main.mod', 'import "../lib/greet"\n{{HELLO}}?\n');
  assert.deepEqual(builder.build('app/main.mod').compiled, ['app/main.mod']);
  clock.advance(1000);
  fs.writeFile('lib/greet.mod', 'const HELLO = Hi\n');
  assert.deepEqual(builder.build('app/main.mod').compiled, ['lib/greet.mod', 'app/main.mod']);
});
`;

// literalChars keeps the fixture's non-ASCII characters literal under Bun.
const VISIBLE_FS = literalChars(String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {manualClock, MemoryFs} from '../src/index.js';

test('mtimes have whole seconds', () => {
  const clock = manualClock(10999);
  const fs = new MemoryFs(clock);
  fs.writeFile('a.txt', 'héllo');
  assert.deepEqual(fs.stat('a.txt'), {mtime: 10000, size: 6});
  clock.advance(1);
  fs.writeFile('a.txt', 'hello');
  assert.deepEqual(fs.stat('a.txt'), {mtime: 11000, size: 5});
  assert.equal(fs.readFile('a.txt'), 'hello');
  assert.equal(fs.readCount('a.txt'), 1);
  fs.deleteFile('a.txt');
  assert.equal(fs.stat('a.txt'), null);
});
`, 'é');

const files = {
  'package.json': PKG,
  'README.md': README,
  'docs/LANGUAGE.md': LANGUAGE_DOC,
  'docs/BUILD.md': BUILD_DOC,
  'docs/ARCHITECTURE.md': ARCH_DOC,
  'src/index.js': INDEX,
  'src/builder.js': BUILDER,
  'src/errors.js': ERRORS,
  'src/clock.js': CLOCK,
  'src/paths.js': PATHS,
  'src/fs/memory-fs.js': MEMORY_FS,
  'src/fs/reader.js': READER,
  'src/fs/racy.js': RACY,
  'src/graph/resolver.js': RESOLVER,
  'src/graph/loader.js': LOADER,
  'src/graph/cycle.js': CYCLE,
  'src/lang/names.js': NAMES,
  'src/lang/parse.js': PARSE,
  'src/lang/scope.js': SCOPE,
  'src/lang/expand.js': EXPAND,
  'src/lang/compile.js': COMPILE,
  'src/cache/keys.js': KEYS,
  'src/cache/compile-cache.js': COMPILE_CACHE,
  'src/bundle/link.js': LINK,
  'src/util/hash.js': HASH,
  'src/util/lines.js': LINES,
  'test/build.test.js': VISIBLE_BUILD,
  'test/memory-fs.test.js': VISIBLE_FS,
};

function swap(source, from, to) {
  if (!source.includes(from)) throw Error('kiln-watch: variant pattern not found: ' + from);
  return source.replace(from, to);
}

const RACY_FIXED = swap(RACY, 'return mtime > readAt;', 'return mtime >= Math.floor(readAt / 1000) * 1000;');
const BUILDER_FIXED = swap(swap(BUILDER, '  const resolver = new Resolver(fs);\n', ''),
  'loadGraph(entry, {reader, resolver})', 'loadGraph(entry, {reader, resolver: new Resolver(fs)})');
const KEYS_FIXED = swap(swap(KEYS, "    'module',\n", "    'module',\n    module.path,\n"),
  'module.imports.map(imported => imported.source.hash)', 'module.imports.map(imported => imported.key)');
const LINK_FIXED = swap(swap(LINK, '    const chunk = module.compiled.lines;\n    chunk.unshift(\'// \' + module.path);\n', ''),
  'lines.push(...chunk);', "lines.push('// ' + module.path, ...module.compiled.lines);");

const FIXED = {
  'src/fs/racy.js': RACY_FIXED,
  'src/builder.js': BUILDER_FIXED,
  'src/cache/keys.js': KEYS_FIXED,
  'src/bundle/link.js': LINK_FIXED,
};

const HIDDEN = String.raw`import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
const {createBuilder} = await import('@ROOT@src/index.js');

const P = path.posix;
const START = 1714564800250; // 250 ms into a second
const err = message => ({name: 'BuildError', message});

function testClock(start = START) {
  let now = start;
  return {now: () => now, advance(ms) { now += ms; }};
}

// An fs as documented in docs/BUILD.md that counts readFile calls.
class TestFs {
  constructor(clock) {
    this.clock = clock;
    this.files = new Map();
    this.reads = new Map();
  }
  write(file, text) {
    this.files.set(file, {text, mtime: Math.floor(this.clock.now() / 1000) * 1000, size: Buffer.byteLength(text)});
  }
  remove(file) {
    this.files.delete(file);
  }
  stat(file) {
    const entry = this.files.get(file);
    return entry ? {mtime: entry.mtime, size: entry.size} : null;
  }
  readFile(file) {
    const entry = this.files.get(file);
    if (!entry) throw new Error('ENOENT: ' + file);
    this.reads.set(file, (this.reads.get(file) ?? 0) + 1);
    return entry.text;
  }
  count(file) {
    return this.reads.get(file) ?? 0;
  }
}

const setup = files => {
  const clock = testClock();
  const fs = new TestFs(clock);
  for (const [file, text] of Object.entries(files)) fs.write(file, text);
  return {clock, fs, builder: createBuilder({fs, clock})};
};
const fresh = (fs, entry) => createBuilder({fs, clock: fs.clock}).build(entry).output;

test('report 1: an edit two imports down reaches the bundle', () => {
  const {clock, fs, builder} = setup({
    'config/name.mod': 'const NAME = World\n',
    'ui/greeting.mod': 'import "../config/name"\nconst GREETING = Hello, {{NAME}}!\n',
    'app/main.mod': 'import "../ui/greeting"\n<h1>{{GREETING}}</h1>\n',
  });
  const first = builder.build('app/main.mod');
  assert.deepStrictEqual(first, {output: '// config/name.mod\n// ui/greeting.mod\n// app/main.mod\n<h1>Hello, World!</h1>\n',
    compiled: ['config/name.mod', 'ui/greeting.mod', 'app/main.mod']});
  clock.advance(1500);
  fs.write('config/name.mod', 'const NAME = Kiln\n');
  assert.deepStrictEqual(builder.build('app/main.mod'), {output: '// config/name.mod\n// ui/greeting.mod\n// app/main.mod\n<h1>Hello, Kiln!</h1>\n',
    compiled: ['config/name.mod', 'ui/greeting.mod', 'app/main.mod']});
  clock.advance(1500);
  fs.write('config/name.mod', 'const NAME = World\n');
  assert.deepStrictEqual(builder.build('app/main.mod'), {...first, compiled: []});
});

test('included files and deep chains are part of the keys', () => {
  const {clock, fs, builder} = setup({
    'app/main.mod': 'import "../lib/c"\nmain\n',
    'lib/c.mod': 'import "./d"\nc\n',
    'lib/d.mod': 'include "../assets/x.txt"\n',
    'lib/e.mod': 'include "../assets/x.txt"\n',
    'assets/x.txt': 'one\n',
  });
  builder.build('app/main.mod');
  clock.advance(2000);
  fs.write('assets/x.txt', 'two\nthree');
  assert.deepStrictEqual(builder.build('app/main.mod'), {output: '// lib/d.mod\ntwo\nthree\n// lib/c.mod\nc\n// app/main.mod\nmain\n',
    compiled: ['lib/d.mod', 'lib/c.mod', 'app/main.mod']});
  clock.advance(2000);
  fs.write('lib/c.mod', 'import "./d"\nc!\n');
  assert.deepStrictEqual(builder.build('app/main.mod').compiled, ['lib/c.mod', 'app/main.mod']);
});

test('report 2: an edit in the same second as the previous build', () => {
  const {clock, fs, builder} = setup({
    'app/main.mod': 'import "./count"\nCount: {{COUNT}}\n',
    'app/count.mod': 'const COUNT = 1\n',
  });
  const reads = () => [fs.count('app/main.mod'), fs.count('app/count.mod')];
  clock.advance(100);
  assert.equal(builder.build('app/main.mod').output, '// app/count.mod\n// app/main.mod\nCount: 1\n');
  assert.deepStrictEqual(reads(), [1, 1]);
  clock.advance(300);
  fs.write('app/count.mod', 'const COUNT = 2\n');
  clock.advance(100);
  assert.deepStrictEqual(builder.build('app/main.mod'), {output: '// app/count.mod\n// app/main.mod\nCount: 2\n', compiled: ['app/count.mod', 'app/main.mod']});
  assert.deepStrictEqual(reads(), [2, 2]);
  clock.advance(1500);
  assert.deepStrictEqual(builder.build('app/main.mod').compiled, []);
  assert.deepStrictEqual(reads(), [3, 3]);
  clock.advance(1000);
  assert.deepStrictEqual(builder.build('app/main.mod').compiled, []);
  assert.deepStrictEqual(reads(), [3, 3]);
  fs.write('app/count.mod', 'const COUNT = 3\n');
  assert.equal(builder.build('app/main.mod').output, '// app/count.mod\n// app/main.mod\nCount: 3\n');
  assert.deepStrictEqual(reads(), [3, 4]);
  clock.advance(200);
  fs.write('app/count.mod', 'const COUNT = 4\n');
  clock.advance(100);
  assert.equal(builder.build('app/main.mod').output, '// app/count.mod\n// app/main.mod\nCount: 4\n');
  assert.deepStrictEqual(reads(), [3, 5]);
});

test('reads at a second boundary', () => {
  const {clock, fs, builder} = setup({'a.mod': 'const A = 1\nA={{A}}\n'});
  clock.advance(750); // exactly on the next second
  builder.build('a.mod');
  clock.advance(5000);
  builder.build('a.mod');
  assert.equal(fs.count('a.mod'), 1);
  fs.write('a.mod', 'const A = 2\nA={{A}}\n');
  builder.build('a.mod');
  fs.write('a.mod', 'const A = 3\nA={{A}}\n');
  assert.equal(builder.build('a.mod').output, '// a.mod\nA=3\n');
  assert.equal(fs.count('a.mod'), 3);
});

test('report 3: a new file overrides a directory module, and deleting it restores the directory module', () => {
  const {clock, fs, builder} = setup({
    'lib/x.mod': 'import "./util"\nx uses {{U}}\n',
    'lib/util/index.mod': 'const U = index\n',
  });
  assert.equal(builder.build('lib/x.mod').output, '// lib/util/index.mod\n// lib/x.mod\nx uses index\n');
  clock.advance(1500);
  fs.write('lib/util.mod', 'const U = file\n');
  assert.deepStrictEqual(builder.build('lib/x.mod'), {output: '// lib/util.mod\n// lib/x.mod\nx uses file\n', compiled: ['lib/util.mod', 'lib/x.mod']});
  clock.advance(1500);
  fs.remove('lib/util.mod');
  assert.deepStrictEqual(builder.build('lib/x.mod'), {output: '// lib/util/index.mod\n// lib/x.mod\nx uses index\n', compiled: []});
  fs.remove('lib/util/index.mod');
  assert.throws(() => builder.build('lib/x.mod'), err('Cannot resolve "./util" from lib/x.mod'));
  fs.write('lib/util.mod', 'const U = back\n');
  assert.equal(builder.build('lib/x.mod').output, '// lib/util.mod\n// lib/x.mod\nx uses back\n');
});

test('includes resolve against the current files', () => {
  const {fs, builder} = setup({'a.mod': 'include "./t.txt"\n', 't.txt': 'text\n'});
  assert.equal(builder.build('a.mod').output, '// a.mod\ntext\n');
  fs.remove('t.txt');
  assert.throws(() => builder.build('a.mod'), err('Cannot resolve "./t.txt" from a.mod'));
});

test('report 4: rebuilding an unchanged project', () => {
  const {clock, fs, builder} = setup({
    'app/main.mod': 'import "./a"\nimport "./b"\nmain {{A}} {{B}}\ninclude "./note.txt"\n',
    'app/a.mod': 'import "./b"\nconst A = a{{B}}\nline a\n',
    'app/b.mod': 'const B = b\nline b\n',
    'app/note.txt': 'note\n',
  });
  const first = builder.build('app/main.mod');
  assert.equal(first.output, '// app/b.mod\nline b\n// app/a.mod\nline a\n// app/main.mod\nmain ab b\nnote\n');
  for (let i = 0; i < 3; i++) {
    clock.advance(2000);
    assert.deepStrictEqual(builder.build('app/main.mod'), {output: first.output, compiled: []});
  }
  assert.deepStrictEqual(['app/main.mod', 'app/a.mod', 'app/b.mod', 'app/note.txt'].map(file => fs.count(file)), [2, 2, 2, 2]);
});

test('the module path is part of the key', () => {
  const {builder} = setup({
    'gen/en/strings.mod': 'const LANG = {{__FILE__}}\nfile {{__FILE__}}\n',
    'gen/fr/strings.mod': 'const LANG = {{__FILE__}}\nfile {{__FILE__}}\n',
    'app/main.mod': 'import "../gen/en/strings"\nimport "../gen/fr/strings"\n{{LANG}}\n',
  });
  assert.deepStrictEqual(builder.build('app/main.mod'), {
    output: '// gen/en/strings.mod\nfile gen/en/strings.mod\n// gen/fr/strings.mod\nfile gen/fr/strings.mod\n// app/main.mod\ngen/fr/strings.mod\n',
    compiled: ['gen/en/strings.mod', 'gen/fr/strings.mod', 'app/main.mod'],
  });
});

test('a failed build keeps what it compiled', () => {
  const {clock, fs, builder} = setup({
    'app/main.mod': 'import "./dep"\n{{NOPE}}\n',
    'app/dep.mod': 'const D = d\n',
  });
  assert.throws(() => builder.build('app/main.mod'), err('Unknown constant NOPE in app/main.mod'));
  clock.advance(3000);
  fs.write('app/main.mod', 'import "./dep"\n{{D}}\n');
  assert.deepStrictEqual(builder.build('app/main.mod'), {output: '// app/dep.mod\n// app/main.mod\nd\n', compiled: ['app/main.mod']});
});

test('language details', () => {
  const {fs} = setup({
    'app/main.mod': [
      'import "../lib/first"', 'import "../lib/second.mod"', 'const X = own {{X}}', 'x={{X}} y={{Y}}', 'const Y = mine',
      'y={{Y}} file={{__FILE__}}', '  import "./ignored"', 'Const Z = text', 'include "../t/empty.txt"',
      'include "../t/raw.txt"', 'dollar={{D}}', '',
    ].join('\n') + '\n',
    'lib/first.mod': 'import "./deep"\nconst X = first\nconst Y = first\n',
    'lib/second.mod': 'const Y = second\nconst D = $& $1 $$\nconst low_name = lower\n',
    'lib/deep/index.mod': 'const DEEP = deep\n',
    't/empty.txt': '',
    't/raw.txt': '{{X}}\n\nlast',
  });
  assert.equal(fresh(fs, 'app/main.mod'), [
    '// lib/deep/index.mod', '// lib/first.mod', '// lib/second.mod', 'const low_name = lower', '// app/main.mod',
    'x=own first y=second', 'y=mine file=app/main.mod', '  import "./ignored"', 'Const Z = text', '{{X}}', '', 'last', 'dollar=$& $1 $$', '',
  ].join('\n') + '\n');
  // low_name is a valid reference but not a constant name: 'const low_name = ...' is a text line, so it is never defined.
  fs.write('app/main.mod', 'import "../lib/second"\nconst LOW = {{low_name}}\n');
  assert.throws(() => fresh(fs, 'app/main.mod'), err('Unknown constant low_name in app/main.mod'));
  fs.write('app/main.mod', 'import "../lib/first"\n{{DEEP}}\n');
  assert.throws(() => fresh(fs, 'app/main.mod'), err('Unknown constant DEEP in app/main.mod'));
  fs.write('app/main.mod', 'const A = 1\nconst A = {{NOPE}}\n');
  assert.throws(() => fresh(fs, 'app/main.mod'), err('Duplicate constant A in app/main.mod'));
  fs.write('app/main.mod', '');
  assert.equal(fresh(fs, 'app/main.mod'), '// app/main.mod\n');
});

test('resolution errors', () => {
  const {fs} = setup({'app/main.mod': 'import "lib/first"\n', 'lib/first.mod': ''});
  assert.throws(() => fresh(fs, 'app/main.mod'), err('Cannot resolve "lib/first" from app/main.mod'));
  fs.write('app/main.mod', 'import "../../lib/first"\n');
  assert.throws(() => fresh(fs, 'app/main.mod'), err('Cannot resolve "../../lib/first" from app/main.mod'));
  fs.write('app/main.mod', 'import "./x/../../lib/./first"\nimport "../lib/first.mod"\n');
  assert.equal(fresh(fs, 'app/main.mod'), '// lib/first.mod\n// app/main.mod\n');
  fs.write('app/main.mod', 'include "../lib"\n');
  assert.throws(() => fresh(fs, 'app/main.mod'), err('Cannot resolve "../lib" from app/main.mod'));
  fs.write('app/main.mod', 'import "./a"\n');
  fs.write('app/a.mod', 'import "./a"\n');
  assert.throws(() => fresh(fs, 'app/main.mod'), err('Import cycle: app/a.mod -> app/a.mod'));
});

// A model of docs/LANGUAGE.md and docs/BUILD.md, used to check long incremental sessions.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const linesOf = text => text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
function statementOf(line) {
  let m;
  if ((m = /^import "([^"]+)"$/.exec(line))) return {kind: 'import', spec: m[1]};
  if ((m = /^include "([^"]+)"$/.exec(line))) return {kind: 'include', spec: m[1]};
  if ((m = /^const ([A-Z][A-Z0-9_]*) = (.*)$/.exec(line))) return {kind: 'const', name: m[1], template: m[2]};
  return {kind: 'text', template: line};
}
function reference(fs, entry) {
  const text = file => fs.files.get(file).text;
  const resolve = (spec, from, kind) => {
    let base = null;
    if (spec.startsWith('./') || spec.startsWith('../')) {
      base = P.normalize(P.join(P.dirname(from), spec));
      if (base === '..' || base.startsWith('../')) base = null;
    }
    const candidates = base === null ? [] : kind === 'include' || base.endsWith('.mod') ? [base] : [base + '.mod', base + '/index.mod'];
    const found = candidates.find(candidate => fs.files.has(candidate));
    if (!found) throw new Error('Cannot resolve "' + spec + '" from ' + from);
    return found;
  };
  const needed = new Set();
  const done = new Map();
  const order = [];
  const stack = [];
  const visit = file => {
    if (stack.includes(file)) throw new Error('Import cycle: ' + [...stack.slice(stack.indexOf(file)), file].join(' -> '));
    if (done.has(file)) return done.get(file);
    if (!fs.files.has(file)) throw new Error('Cannot read ' + file);
    stack.push(file);
    needed.add(file);
    const statements = linesOf(text(file)).map(statementOf);
    const includes = statements.filter(s => s.kind === 'include').map(s => resolve(s.spec, file, 'include'));
    includes.forEach(included => needed.add(included));
    const module = {path: file, statements, includes, imports: []};
    for (const s of statements) if (s.kind === 'import') module.imports.push(visit(resolve(s.spec, file, 'import')));
    stack.pop();
    done.set(file, module);
    order.push(module);
    return module;
  };
  visit(entry);
  for (const m of order) {
    m.key = hash([m.path, text(m.path), m.includes.map(text), m.imports.map(d => d.key)]);
    const own = new Map();
    const lookup = name => {
      if (own.has(name)) return own.get(name);
      for (const d of [...m.imports].reverse()) if (d.consts.has(name)) return d.consts.get(name);
      return name === '__FILE__' ? m.path : undefined;
    };
    const expand = template => template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name) => {
      const value = lookup(name);
      if (value === undefined) throw new Error('Unknown constant ' + name + ' in ' + m.path);
      return value;
    });
    m.lines = [];
    let included = 0;
    for (const s of m.statements) {
      if (s.kind === 'const') {
        if (own.has(s.name)) throw new Error('Duplicate constant ' + s.name + ' in ' + m.path);
        own.set(s.name, expand(s.template));
      } else if (s.kind === 'include') m.lines.push(...linesOf(text(m.includes[included++])));
      else if (s.kind === 'text') m.lines.push(expand(s.template));
    }
    m.consts = own;
  }
  return {order, needed, output: order.flatMap(m => ['// ' + m.path, ...m.lines]).join('\n') + '\n'};
}
class Session {
  constructor(fs) {
    this.fs = fs;
    this.keys = new Set();
    this.remembered = new Map();
    this.reads = new Map();
  }
  build(entry) {
    const {order, needed, output} = reference(this.fs, entry);
    const compiled = order.filter(m => !this.keys.has(m.key)).map(m => m.path);
    for (const m of order) this.keys.add(m.key);
    const now = this.fs.clock.now();
    for (const file of needed) {
      const stat = this.fs.stat(file);
      const known = this.remembered.get(file);
      if (known && known.mtime === stat.mtime && known.size === stat.size && known.mtime < Math.floor(known.readAt / 1000) * 1000) continue;
      this.remembered.set(file, {mtime: stat.mtime, size: stat.size, readAt: now});
      this.reads.set(file, (this.reads.get(file) ?? 0) + 1);
    }
    return {output, compiled};
  }
}
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODULES = ['app/main.mod', 'app/view.mod', 'lib/util/index.mod', 'lib/core.mod', 'lib/deep/leaf.mod', 'shared/a.mod', 'shared/b.mod', 'shared/c/index.mod'];
const OVERRIDE = 'lib/util.mod';
const INCLUDES = ['assets/banner.txt', 'assets/note.txt'];
const relative = (from, to) => {
  const rel = P.relative(P.dirname(from), to);
  return rel.startsWith('.') ? rel : './' + rel;
};
const importSpec = (i, j) => {
  const rel = relative(MODULES[i], MODULES[j]);
  if (rel.endsWith('/index.mod')) return rel.slice(0, -'/index.mod'.length);
  return (i + j) % 2 ? rel : rel.slice(0, -'.mod'.length);
};
function moduleText(i, state) {
  const s = state[i];
  const imports = [...s.imports].sort();
  const lines = imports.map(j => 'import "' + importSpec(i, j) + '"');
  lines.push('const C' + i + ' = ' + s.value + (imports.length ? '+{{C' + imports[0] + '}}' : ''));
  if (s.include >= 0) lines.push('include "' + relative(MODULES[i], INCLUDES[s.include]) + '"');
  lines.push('m' + i + ' {{C' + i + '}} in {{__FILE__}}');
  for (const j of imports) lines.push('  sees {{C' + j + '}}');
  for (let k = 0; k < s.extra; k++) lines.push('extra ' + k);
  return lines.join('\n') + '\n';
}

for (const seed of [7, 8, 9, 10]) {
  test('random watch session, seed ' + seed, () => {
    const random = mulberry32(seed);
    const pick = list => list[Math.floor(random() * list.length)];
    const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
    const clock = testClock(START + int(0, 999));
    const fs = new TestFs(clock);
    const builder = createBuilder({fs, clock});
    const session = new Session(fs);
    const state = MODULES.map((_, i) => ({
      imports: new Set([i + 1, i + 2, i + 3].filter(j => j < MODULES.length && random() < 0.6)),
      value: 'v' + int(0, 9), include: random() < 0.3 ? int(0, 1) : -1, extra: int(0, 2),
    }));
    const history = [];
    const sync = () => {
      MODULES.forEach((file, i) => {
        const text = moduleText(i, state);
        if (fs.files.get(file)?.text !== text) fs.write(file, text);
      });
    };
    INCLUDES.forEach((file, k) => fs.write(file, 'include ' + k + '\n'));
    sync();
    for (let step = 0; step < 70; step++) {
      for (let edits = int(1, 2); edits > 0; edits--) {
        clock.advance(pick([0, 0, 40, 300, 700, 999, 1000, 1600, 3000]));
        const i = int(0, MODULES.length - 1);
        const roll = random();
        history.push(state.map(s => ({...s, imports: new Set(s.imports)})));
        if (roll < 0.30) state[i].value = 'v' + int(0, 9);
        else if (roll < 0.40) state[i].extra = (state[i].extra + 1) % 3;
        else if (roll < 0.52) {
          const j = int(i + 1, Math.min(i + 3, MODULES.length - 1));
          if (j < MODULES.length && j > i) state[i].imports.has(j) ? state[i].imports.delete(j) : state[i].imports.add(j);
        } else if (roll < 0.58) state[i].include = state[i].include >= 0 ? -1 : int(0, 1);
        else if (roll < 0.70) fs.write(pick(INCLUDES), pick(['include x\n', 'include y\n', 'other text\n', '', 'a\nb\n']));
        else if (roll < 0.80) {
          if (fs.files.has(OVERRIDE) && random() < 0.5) fs.remove(OVERRIDE);
          else fs.write(OVERRIDE, 'const C2 = o' + int(0, 9) + '\noverride\n');
        } else if (roll < 0.88) {
          const file = pick([...fs.files.keys()]);
          fs.write(file, fs.files.get(file).text);
        } else if (history.length > 3) {
          const back = history[int(0, history.length - 2)];
          back.forEach((s, k) => { state[k] = {...s, imports: new Set(s.imports)}; });
        }
        sync();
      }
      clock.advance(pick([0, 0, 100, 500, 1000, 2000]));
      const label = 'seed ' + seed + ' step ' + step;
      const expected = session.build('app/main.mod');
      assert.deepStrictEqual(builder.build('app/main.mod'), expected, label);
      assert.deepStrictEqual([...fs.reads].sort(), [...session.reads].sort(), label + ' reads');
    }
  });
}
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

const variant = files => root => writeTree(root, files);

export default {
  id: 'kiln-watch',
  category: 'symptom-only multi-file debugging',
  prompt: 'Bug reports against kiln 1.4 (this repository), all from our watch-mode dev server, which keeps one builder from createBuilder() alive and calls build(\'app/main.mod\') after every file change. A new builder on the same files always gives the right bundle. ' +
    '(1) Deep edits do not show up: app/main.mod imports ui/greeting.mod, which has `const GREETING = Hello, {{NAME}}!` with NAME from config/name.mod, and main prints `<h1>{{GREETING}}</h1>`. After changing NAME in config/name.mod, the rebuilt bundle still says Hello, World! in app/main.mod\'s section. ' +
    '(2) Quick edits get lost: when count.mod is saved again within the same second as the previous build (`const COUNT = 1` changed to `const COUNT = 2`), the next build still uses 1. Edits that change the length of the file, or that are made a second later, work. ' +
    '(3) New files are ignored: lib/util/index.mod existed and we added lib/util.mod, which per docs/LANGUAGE.md takes precedence for `import "./util"` in lib/x.mod, but the server keeps bundling lib/util/index.mod until it is restarted. ' +
    '(4) Rebuilding without any change makes the bundle longer every time. ' +
    'Expected: the behaviour documented in docs/LANGUAGE.md and docs/BUILD.md, which are correct as written, including when files are read and which modules are compiled. Find and fix the root causes in src/ so the whole documented API behaves as documented. ' +
    'Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['kiln 1.4', files]]),
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
    // 1. Remembered reads are still trusted within the second they were made.
    variant({'src/fs/racy.js': RACY}),
    // 2. Remembered reads never trusted: every build reads every file.
    variant({'src/fs/racy.js': swap(RACY, 'return mtime > readAt;', 'return true;')}),
    // 3. Racy compared with the exact read time instead of the start of its second.
    variant({'src/fs/racy.js': swap(RACY, 'return mtime > readAt;', 'return mtime >= readAt;')}),
    // 4. Resolutions still memoized for the builder's lifetime.
    variant({'src/builder.js': BUILDER}),
    // 5. Memoized resolutions re-checked only for deleted targets: new, preferred files stay unseen.
    variant({'src/builder.js': BUILDER, 'src/graph/resolver.js': swap(RESOLVER, 'if (found === undefined) {', 'if (found === undefined || this.#fs.stat(found) === null) {')}),
    // 6. Keys still built from the imports' texts instead of their keys.
    variant({'src/cache/keys.js': swap(KEYS, "    'module',\n", "    'module',\n    module.path,\n")}),
    // 7. Keys without the module path.
    variant({'src/cache/keys.js': swap(KEYS, 'module.imports.map(imported => imported.source.hash)', 'module.imports.map(imported => imported.key)')}),
    // 8. The linker still writes headers into cached outputs.
    variant({'src/bundle/link.js': LINK}),
    // 9. The cache switched off instead: every build compiles everything.
    variant({'src/bundle/link.js': LINK, 'src/builder.js': swap(BUILDER_FIXED, 'module.compiled = cache.get(module.key);', 'module.compiled = undefined;')}),
    // 10. A visible test edited.
    variant({'test/build.test.js': swap(VISIBLE_BUILD, "test('errors'", "test.skip('errors'")}),
  ],
};
