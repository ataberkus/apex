import {gitRepo, hiddenTests, literalChars, npm, read, unchanged, verdict, writeTree} from '../lib.mjs';

// Fixture sources are String.raw templates: they never contain a backtick or "${". In SPEC, ¤ stands for a backtick.
// literalChars keeps their non-ASCII characters literal under Bun.
const js = (strings, ...values) => literalChars(String.raw(strings, ...values), 'äö');

const SPEC = literalChars(String.raw`# Corpus migrations

¤src/migrator.js¤ exports ¤migrateCorpus(options)¤ and the error class ¤MigrationError¤ (a subclass of ¤Error¤ whose ¤name¤ is ¤"MigrationError"¤). ¤migrateCorpus¤ brings every document of a corpus directory to one schema version by running a chain of migrations, validates every intermediate result, and writes the changed documents all-or-nothing. Everything in this document is normative.

"Plain object" means a value that is not ¤null¤, has ¤typeof¤ ¤'object'¤ and is not an array. A property whose value is ¤undefined¤ counts as absent. A *version* is an integer (¤Number.isInteger¤) greater than or equal to 1.

¤migrateCorpus¤ is asynchronous: it returns a promise and reports every error described here by rejecting that promise, never by throwing synchronously.

## Options

¤options¤ is a plain object with these properties (others are ignored):

- ¤dir¤ (required): the corpus directory, a non-empty string.
- ¤target¤ (required): the version to bring every document to.
- ¤migrations¤ (required): an array of migrations. A migration is a plain object with ¤from¤ and ¤to¤ (versions, ¤from¤ less than ¤to¤), ¤up¤ (a function) and optionally ¤down¤ (a function). Other properties of a migration are ignored. A migration is written ¤<from>-><to>¤, for example ¤2->3¤.
- ¤validators¤ (optional, default ¤{}¤): a plain object whose property names are versions written in decimal without leading zeros (¤"1"¤, ¤"12"¤), each mapped to a validator function. A version without a validator is never validated.
- ¤dryRun¤ (optional, default ¤false¤): a boolean.
- ¤fs¤ (optional, default the ¤node:fs/promises¤ module): an object with the functions ¤readdir¤, ¤readFile¤, ¤writeFile¤, ¤rename¤ and ¤unlink¤ (it may have more). ¤migrateCorpus¤ accesses the file system only through these five functions of this object, and builds the path of every file in the corpus directory with ¤path.join(dir, name)¤ from ¤node:path¤.

Options are checked in this order. The first problem rejects with a ¤MigrationError¤ with exactly this message, where ¤<value>¤ is ¤String(value)¤:

1. ¤options¤ is not a plain object: ¤invalid options¤
2. ¤dir¤ is not a non-empty string: ¤invalid dir¤
3. ¤target¤ is not a version: ¤invalid target: <value>¤
4. ¤migrations¤ is not an array: ¤invalid migrations¤
5. Each migration in array order, with the message ¤migration <i>: <problem>¤ where ¤<i>¤ is its zero-based index and ¤<problem>¤ is the first of these that applies:
   - ¤not an object¤ (not a plain object)
   - ¤invalid from¤ (¤from¤ is not a version)
   - ¤invalid to¤ (¤to¤ is not a version)
   - ¤to must be greater than from¤
   - ¤invalid up¤ (¤up¤ is not a function)
   - ¤invalid down¤ (¤down¤ is present but not a function)
   - ¤duplicate <from>-><to>¤ (an earlier migration in the array has the same ¤from¤ and the same ¤to¤)
6. ¤validators¤ is not a plain object: ¤invalid validators¤. Then each of its own enumerable properties in ¤Object.keys¤ order: a key that is not a version written as described above gives ¤invalid validator key: <key>¤; a value that is not a function gives ¤invalid validator for v<key>¤.
7. ¤dryRun¤ is not a boolean: ¤invalid dryRun¤
8. ¤fs¤ is not a value with ¤typeof¤ ¤'object'¤ (and not ¤null¤) whose properties ¤readdir¤, ¤readFile¤, ¤writeFile¤, ¤rename¤ and ¤unlink¤ are all functions: ¤invalid fs¤

The *known versions* are 1 and every ¤from¤ and every ¤to¤ of the migrations. If ¤target¤ is not a known version, reject with ¤unknown target version <target>¤.

None of these checks touches the file system.

## Lock

Once the options are accepted, and before anything else touches the file system, ¤migrateCorpus¤ creates the lock file ¤.migrate.lock¤ in ¤dir¤ by calling ¤fs.writeFile(lockPath, '', {flag: 'wx'})¤. If that call fails with an error whose ¤code¤ is ¤'EEXIST'¤, reject with the ¤MigrationError¤ ¤corpus is locked¤ and do nothing else; in particular, never remove a lock file that this call did not create. Any other error from that call rejects ¤migrateCorpus¤ with that same error object.

Once the lock file is created, ¤migrateCorpus¤ removes it with ¤fs.unlink(lockPath)¤ before its promise settles, whatever happens: success, failed documents, dry run, commit failure or I/O error. Errors from that ¤unlink¤ are ignored. Dry runs take the lock too.

## Documents

The documents are the names returned by ¤fs.readdir(dir)¤ that end with ¤.json¤ (case-sensitive) and do not start with ¤.¤. Every other name is ignored. Documents are processed one at a time, in ascending order of their names compared by UTF-16 code units (the order of ¤Array.prototype.sort¤ without a comparator). Each document is read with ¤fs.readFile(filePath, 'utf8')¤ just before it is processed. An error thrown by ¤readdir¤ or ¤readFile¤ rejects ¤migrateCorpus¤ with that same error object (after the lock is removed).

Processing a document runs these checks in order. The first one that does not pass makes the document *failed* with the message shown, and processing continues with the next document:

1. If the text starts with U+FEFF (a byte order mark), that character is set aside and the rest is the JSON text; otherwise the whole text is. If ¤JSON.parse¤ throws on the JSON text: ¤invalid JSON¤.
2. The parsed value is not a plain object: ¤not an object¤.
3. The document's version is the value of its ¤$v¤ property; a document without a ¤$v¤ property is at version 1. If ¤$v¤ is present but is not a version: ¤invalid version¤.
4. The version is not a known version: ¤unknown version <v>¤.
5. If there is a validator for the document's version and it reports a problem (see Validation): ¤invalid at v<v>: <problem>¤. This applies to every document, including those already at the target version.
6. If the version equals ¤target¤, the document is *unchanged* and its processing ends.
7. Find the path (see Paths). If there is none: ¤no path from <v> to <target>¤.
8. Run the path's steps in order (see Steps). A failing step makes the document failed and its remaining steps are not run. If every step succeeds, the document is *migrated*.

## Paths

A *step* is either the ¤up¤ function of a migration, which goes from its ¤from¤ to its ¤to¤ version, or the ¤down¤ function of a migration that has one, which goes from its ¤to¤ back to its ¤from¤ version. A migration without ¤down¤ has no down step. A step is written ¤<a>-><b>¤ in its direction of travel: the up step of migration ¤2->4¤ is ¤2->4¤, its down step is ¤4->2¤.

When the document's version ¤v¤ is lower than ¤target¤, a path is a sequence of up steps; when it is higher, a sequence of down steps. In both cases the first step starts at ¤v¤, every further step starts at the version where the previous one ended, and the last step ends at ¤target¤.

The chosen path is the one with the fewest steps. When several paths have the fewest steps, compare them step by step from the start; at the first position where they use different migrations, the path whose migration comes earlier in the ¤migrations¤ array is chosen.

## Steps

The first step receives a deep copy (¤structuredClone¤) of the parsed document. Every step is called as ¤fn(doc, context)¤, where ¤doc¤ is its input and ¤context¤ is a new plain object ¤{file, from, to}¤: the document's name as returned by ¤readdir¤, and the step's start and end version in its direction of travel (for the down step ¤4->2¤, ¤from¤ is 4 and ¤to¤ is 2). The call's result is awaited (¤await¤). Then:

- If the step throws, or its promise rejects, with a value ¤e¤: the document fails with ¤step <a>-><b> failed: <message>¤, where ¤<message>¤ is ¤e.message¤ when ¤e¤ is an instance of ¤Error¤ and ¤String(e)¤ otherwise.
- If the result is ¤undefined¤, the step's output is the ¤doc¤ object it received (steps may modify their argument in place).
- If the result is a plain object, that object is the step's output.
- Anything else: the document fails with ¤step <a>-><b> returned a non-object¤.

Then the runner sets the ¤$v¤ property of the output to ¤b¤, whatever the step put there. If there is a validator for version ¤b¤ and it reports a problem, the document fails with ¤invalid at v<b>: <problem>¤. Otherwise the output is the input of the next step, or the document's final value after the last step.

## Validation

A validator is called with the document as its only argument and returns an array of strings. A non-empty array reports a problem: its first element. A validator that throws a value ¤e¤ reports the problem ¤validator threw: <message>¤, with ¤<message>¤ formed as for steps.

## Writing

The new text of a migrated document is ¤JSON.stringify(value, null, 2)¤ followed by one line break, where ¤value¤ is the document's final value with ¤$v¤ moved to be its first property (¤$v¤ is written even when the target is 1); the other properties keep their order. If the original text contained ¤\r\n¤ anywhere, every line break of the new text is ¤\r\n¤, otherwise ¤\n¤. If the original text started with a byte order mark, the new text starts with one too. Unchanged and failed documents are never written.

After every document has been processed, the migrated documents are committed if, and only if, no document failed, ¤dryRun¤ is ¤false¤ and at least one document was migrated. The commit has two phases, each in document order:

1. For each migrated document ¤<name>¤, write its new text to ¤<name>.tmp¤ in ¤dir¤ with ¤fs.writeFile(tmpPath, text, {flag: 'w'})¤.
2. Then rename each ¤<name>.tmp¤ to ¤<name>¤ with ¤fs.rename(tmpPath, filePath)¤.

If one of these calls fails with an error ¤e¤, the commit is rolled back: every document already renamed gets its original text back, written with ¤fs.writeFile(filePath, originalText, {flag: 'w'})¤, and then every ¤.tmp¤ file whose write was attempted and that was not renamed is removed with ¤fs.unlink¤. Errors during the rollback are ignored and never stop it. Then ¤migrateCorpus¤ rejects with a ¤MigrationError¤ whose message is ¤commit failed at <name>: <message>¤ (¤<name>¤ is the document whose write or rename failed, ¤<message>¤ is formed as for steps) and whose ¤cause¤ is ¤e¤. After a rollback without rollback errors, the directory holds exactly the files it held before ¤migrateCorpus¤ was called, with the same contents.

## Result

Otherwise ¤migrateCorpus¤ resolves to a plain object with exactly these properties:

- ¤target¤: the target version.
- ¤migrated¤: the names of the migrated documents.
- ¤unchanged¤: the names of the unchanged documents.
- ¤failed¤: one entry per failed document, a plain object with exactly the properties ¤file¤ (its name), ¤version¤ (its version, or ¤null¤ when check 1, 2 or 3 failed), ¤step¤ (the failing step written ¤<a>-><b>¤, or ¤null¤ when checks 1 to 7 failed; the validation after a step belongs to that step) and ¤message¤.
- ¤written¤: ¤true¤ when the commit happened, ¤false¤ otherwise.

All three lists are in document order. Failed documents appear only in ¤failed¤, never in ¤migrated¤ or ¤unchanged¤.
`, '¤').replaceAll('¤', '`');

const DRAFT = js`import fs from 'node:fs/promises';
import path from 'node:path';

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Bring every document in options.dir to options.target. See docs/MIGRATIONS.md. */
export async function migrateCorpus({dir, target, migrations}) {
  const result = {target, migrated: [], unchanged: [], failed: [], written: false};
  const names = (await fs.readdir(dir)).filter(name => name.endsWith('.json')).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    let doc = JSON.parse(await fs.readFile(file, 'utf8'));
    let version = doc.$v ?? 1;
    if (version === target) {
      result.unchanged.push(name);
      continue;
    }
    while (version < target) {
      const migration = migrations.find(m => m.from === version);
      doc = (await migration.up(doc)) ?? doc;
      version = doc.$v = migration.to;
    }
    await fs.writeFile(file, JSON.stringify(doc, null, 2) + '\n');
    result.migrated.push(name);
    result.written = true;
  }
  return result;
}
`;

const MIGRATIONS = js`/** Schema history of the contacts corpus. v1: name; v2: first/last; v3: phones array; v4: tags array. */
export const migrations = [
  {
    from: 1, to: 2,
    up(doc) {
      const {name, ...rest} = doc;
      const parts = name.trim().split(/\s+/);
      const last = parts.length > 1 ? parts.pop() : '';
      return {...rest, first: parts.join(' '), last};
    },
    down(doc) {
      const {first, last, ...rest} = doc;
      return {...rest, name: [first, last].filter(Boolean).join(' ')};
    },
  },
  {
    from: 2, to: 3,
    up(doc) {
      doc.phones = doc.phone === undefined ? [] : [{kind: 'main', number: doc.phone}];
      delete doc.phone;
    },
    down(doc) {
      if (doc.phones.length) doc.phone = doc.phones[0].number;
      delete doc.phones;
    },
  },
  {
    from: 3, to: 4,
    up(doc) {
      doc.tags = (doc.tags ?? '').split(',').map(tag => tag.trim()).filter(Boolean);
    },
    down(doc) {
      doc.tags = doc.tags.join(',');
    },
  },
];
`;

const SCHEMAS = js`const string = (doc, key) => typeof doc[key] === 'string' ? [] : [key + ' must be a string'];

/** One validator per schema version; each returns a list of problems. */
export const validators = {
  1: doc => string(doc, 'name'),
  2: doc => [...string(doc, 'first'), ...string(doc, 'last')],
  3: doc => Array.isArray(doc.phones) ? [] : ['phones must be an array'],
  4: doc => Array.isArray(doc.tags) && doc.tags.every(tag => typeof tag === 'string') ? [] : ['tags must be an array of strings'],
};
`;

const VISIBLE = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {migrateCorpus, MigrationError} from '../src/migrator.js';
import {migrations} from '../migrations/index.js';
import {validators} from '../schemas/index.js';

const corpus = fileURLToPath(new URL('../corpus/', import.meta.url));

async function copy() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'corpus-'));
  await cp(corpus, dir, {recursive: true});
  return dir;
}

async function contents(dir) {
  const out = {};
  for (const name of (await readdir(dir)).sort()) out[name] = await readFile(path.join(dir, name), 'utf8');
  return out;
}

test('migrates the corpus to v4', async () => {
  const dir = await copy();
  try {
    const result = await migrateCorpus({dir, target: 4, migrations, validators});
    assert.deepEqual(result, {target: 4, migrated: ['ada.json', 'alan.json', 'grace.json'], unchanged: ['edsger.json'], failed: [], written: true});
    assert.equal(await readFile(path.join(dir, 'ada.json'), 'utf8'), [
      '{',
      '  "$v": 4,',
      '  "tags": [',
      '    "math",',
      '    "poetry"',
      '  ],',
      '  "first": "Ada",',
      '  "last": "Lovelace",',
      '  "phones": [',
      '    {',
      '      "kind": "main",',
      '      "number": "555-0100"',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n'));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('an invalid target is rejected', async () => {
  await assert.rejects(migrateCorpus({dir: path.join(os.tmpdir(), 'no-such-corpus'), target: 0, migrations}), error => error instanceof MigrationError && error.message === 'invalid target: 0');
});

test('one invalid document blocks every write', async () => {
  const dir = await copy();
  try {
    await writeFile(path.join(dir, 'zed.json'), '{"$v": 2, "first": "Zed"}\n');
    const before = await contents(dir);
    const result = await migrateCorpus({dir, target: 4, migrations, validators});
    assert.deepEqual(result.failed, [{file: 'zed.json', version: 2, step: null, message: 'invalid at v2: last must be a string'}]);
    assert.equal(result.written, false);
    assert.deepEqual(await contents(dir), before);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('a dry run writes nothing', async () => {
  const dir = await copy();
  try {
    const before = await contents(dir);
    const result = await migrateCorpus({dir, target: 4, migrations, validators, dryRun: true});
    assert.deepEqual(result.migrated, ['ada.json', 'alan.json', 'grace.json']);
    assert.equal(result.written, false);
    assert.deepEqual(await contents(dir), before);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
`;

const REFERENCE = js`import fsPromises from 'node:fs/promises';
import path from 'node:path';

export class MigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

const LOCK = '.migrate.lock';
const FS_FUNCTIONS = ['readdir', 'readFile', 'writeFile', 'rename', 'unlink'];
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isVersion = value => Number.isInteger(value) && value >= 1;
const messageOf = error => error instanceof Error ? error.message : String(error);

function checkOptions(options) {
  if (!isPlain(options)) throw new MigrationError('invalid options');
  const {dir, target, migrations} = options;
  const validators = options.validators === undefined ? {} : options.validators;
  const dryRun = options.dryRun === undefined ? false : options.dryRun;
  const fs = options.fs === undefined ? fsPromises : options.fs;
  if (typeof dir !== 'string' || dir === '') throw new MigrationError('invalid dir');
  if (!isVersion(target)) throw new MigrationError('invalid target: ' + String(target));
  if (!Array.isArray(migrations)) throw new MigrationError('invalid migrations');
  const pairs = new Set();
  migrations.forEach((migration, index) => {
    const problem = (() => {
      if (!isPlain(migration)) return 'not an object';
      if (!isVersion(migration.from)) return 'invalid from';
      if (!isVersion(migration.to)) return 'invalid to';
      if (migration.to <= migration.from) return 'to must be greater than from';
      if (typeof migration.up !== 'function') return 'invalid up';
      if (migration.down !== undefined && typeof migration.down !== 'function') return 'invalid down';
      const pair = migration.from + '->' + migration.to;
      if (pairs.has(pair)) return 'duplicate ' + pair;
      pairs.add(pair);
    })();
    if (problem) throw new MigrationError('migration ' + index + ': ' + problem);
  });
  if (!isPlain(validators)) throw new MigrationError('invalid validators');
  for (const key of Object.keys(validators)) {
    if (!/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(Number(key))) throw new MigrationError('invalid validator key: ' + key);
    if (typeof validators[key] !== 'function') throw new MigrationError('invalid validator for v' + key);
  }
  if (typeof dryRun !== 'boolean') throw new MigrationError('invalid dryRun');
  if (fs === null || typeof fs !== 'object' || !FS_FUNCTIONS.every(name => typeof fs[name] === 'function')) throw new MigrationError('invalid fs');
  const known = new Set([1, ...migrations.flatMap(migration => [migration.from, migration.to])]);
  if (!known.has(target)) throw new MigrationError('unknown target version ' + target);
  return {dir, target, migrations, validators, dryRun, fs, known};
}

/** Steps toward target in one direction, with the BFS distance of every version that can reach target. */
function planner(migrations, target, direction) {
  const steps = [];
  migrations.forEach((migration, index) => {
    if (direction === 'up') steps.push({index, a: migration.from, b: migration.to, fn: migration.up});
    else if (migration.down !== undefined) steps.push({index, a: migration.to, b: migration.from, fn: migration.down});
  });
  const outgoing = new Map();
  const incoming = new Map();
  for (const step of steps) {
    if (!outgoing.has(step.a)) outgoing.set(step.a, []);
    outgoing.get(step.a).push(step);
    if (!incoming.has(step.b)) incoming.set(step.b, []);
    incoming.get(step.b).push(step);
  }
  const distance = new Map([[target, 0]]);
  const queue = [target];
  for (let i = 0; i < queue.length; i++) {
    for (const step of incoming.get(queue[i]) ?? []) {
      if (!distance.has(step.a)) {
        distance.set(step.a, distance.get(queue[i]) + 1);
        queue.push(step.a);
      }
    }
  }
  const cache = new Map();
  return version => {
    if (!distance.has(version)) return null;
    if (cache.has(version)) return cache.get(version);
    const path = [];
    for (let at = version; at !== target;) {
      const next = (outgoing.get(at) ?? []).find(step => distance.get(step.b) === distance.get(at) - 1);
      path.push(next);
      at = next.b;
    }
    cache.set(version, path);
    return path;
  };
}

function validate(validators, version, doc) {
  const validator = validators[String(version)];
  if (!validator) return null;
  let problems;
  try {
    problems = validator(doc);
  } catch (error) {
    return 'validator threw: ' + messageOf(error);
  }
  return problems.length ? problems[0] : null;
}

async function processDocument(name, text, options, plans) {
  const fail = (version, step, message) => ({failed: {file: name, version, step, message}});
  const bom = text.startsWith('\uFEFF');
  let doc;
  try {
    doc = JSON.parse(bom ? text.slice(1) : text);
  } catch {
    return fail(null, null, 'invalid JSON');
  }
  if (!isPlain(doc)) return fail(null, null, 'not an object');
  const version = Object.hasOwn(doc, '$v') ? doc.$v : 1;
  if (!isVersion(version)) return fail(null, null, 'invalid version');
  if (!options.known.has(version)) return fail(version, null, 'unknown version ' + version);
  const problem = validate(options.validators, version, doc);
  if (problem !== null) return fail(version, null, 'invalid at v' + version + ': ' + problem);
  if (version === options.target) return {unchanged: true};
  const steps = (version < options.target ? plans.up : plans.down)(version);
  if (!steps) return fail(version, null, 'no path from ' + version + ' to ' + options.target);
  let value = structuredClone(doc);
  for (const {a, b, fn} of steps) {
    const label = a + '->' + b;
    let result;
    try {
      result = await fn(value, {file: name, from: a, to: b});
    } catch (error) {
      return fail(version, label, 'step ' + label + ' failed: ' + messageOf(error));
    }
    if (result !== undefined) {
      if (!isPlain(result)) return fail(version, label, 'step ' + label + ' returned a non-object');
      value = result;
    }
    value.$v = b;
    const invalid = validate(options.validators, b, value);
    if (invalid !== null) return fail(version, label, 'invalid at v' + b + ': ' + invalid);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const json = JSON.stringify({$v: options.target, ...value}, null, 2).replace(/\n/g, eol) + eol;
  return {output: (bom ? '\uFEFF' : '') + json};
}

async function commit(fs, dir, changes) {
  const attempted = [];
  const renamed = [];
  let current;
  try {
    for (const change of changes) {
      current = change;
      attempted.push(change);
      await fs.writeFile(path.join(dir, change.name + '.tmp'), change.output, {flag: 'w'});
    }
    for (const change of changes) {
      current = change;
      await fs.rename(path.join(dir, change.name + '.tmp'), path.join(dir, change.name));
      renamed.push(change);
    }
  } catch (error) {
    for (const change of renamed) {
      try { await fs.writeFile(path.join(dir, change.name), change.original, {flag: 'w'}); } catch {}
    }
    for (const change of attempted) {
      if (renamed.includes(change)) continue;
      try { await fs.unlink(path.join(dir, change.name + '.tmp')); } catch {}
    }
    throw new MigrationError('commit failed at ' + current.name + ': ' + messageOf(error), {cause: error});
  }
}

/** Bring every document in options.dir to options.target. See docs/MIGRATIONS.md. */
export async function migrateCorpus(options) {
  const checked = checkOptions(options);
  const {dir, target, fs} = checked;
  const lock = path.join(dir, LOCK);
  try {
    await fs.writeFile(lock, '', {flag: 'wx'});
  } catch (error) {
    if (error?.code === 'EEXIST') throw new MigrationError('corpus is locked');
    throw error;
  }
  try {
    const plans = {up: planner(checked.migrations, target, 'up'), down: planner(checked.migrations, target, 'down')};
    const names = (await fs.readdir(dir)).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort();
    const result = {target, migrated: [], unchanged: [], failed: [], written: false};
    const changes = [];
    for (const name of names) {
      const original = await fs.readFile(path.join(dir, name), 'utf8');
      const outcome = await processDocument(name, original, checked, plans);
      if (outcome.failed) result.failed.push(outcome.failed);
      else if (outcome.unchanged) result.unchanged.push(name);
      else {
        result.migrated.push(name);
        changes.push({name, original, output: outcome.output});
      }
    }
    if (!result.failed.length && !checked.dryRun && changes.length) {
      await commit(fs, dir, changes);
      result.written = true;
    }
    return result;
  } finally {
    try { await fs.unlink(lock); } catch {}
  }
}
`;

const BOM = '\uFEFF';
const CORPUS = {
  'corpus/ada.json': '{"name": "Ada Lovelace", "phone": "555-0100", "tags": "math, poetry"}\n',
  'corpus/alan.json': '{\n  "$v": 2,\n  "first": "Alan",\n  "last": "Turing",\n  "tags": "math,crypto"\n}\n',
  'corpus/grace.json': '{\r\n  "$v": 3,\r\n  "first": "Grace",\r\n  "last": "Hopper",\r\n  "phones": [{"kind": "main", "number": "555-0102"}],\r\n  "tags": "navy"\r\n}\r\n',
  'corpus/edsger.json': '{"$v": 4, "first": "Edsger", "last": "Dijkstra", "phones": [], "tags": ["algorithms"]}\n',
  'corpus/README.txt': 'Contacts corpus. Every *.json file is one contact document; $v is its schema version (absent means 1).\n',
};

const files = {
  'package.json': JSON.stringify({name: 'contacts-corpus', version: '1.4.0', type: 'module', scripts: {test: 'node --test test/*.test.js'}}, null, 2) + '\n',
  'docs/MIGRATIONS.md': SPEC,
  'src/migrator.js': DRAFT,
  'migrations/index.js': MIGRATIONS,
  'schemas/index.js': SCHEMAS,
  ...CORPUS,
  'test/migrator.test.js': VISIBLE,
};

const HIDDEN = js`import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const {migrateCorpus, MigrationError} = await import('@ROOT@src/migrator.js');
const {migrations: contacts} = await import('@ROOT@migrations/index.js');
const {validators: schemas} = await import('@ROOT@schemas/index.js');

const DIR = path.join(path.sep + 'virtual', 'corpus');
const BOM = '\uFEFF';

/** In-memory fs with the five functions; fail(op, name) may return an error to throw. */
function memfs(initial, fail) {
  const store = new Map(Object.entries(initial).map(([name, text]) => [path.join(DIR, name), text]));
  const log = [];
  const key = file => path.normalize(file);
  const error = (code, op, file) => Object.assign(new Error(code + ': ' + op + ' ' + path.basename(file)), {code});
  const hook = (op, file) => {
    log.push(op + ' ' + path.basename(file));
    const injected = fail?.(op, path.basename(file));
    if (injected) throw injected;
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const fs = {
    async readdir(dir) {
      await tick(); hook('readdir', dir);
      if (key(dir) !== DIR) throw error('ENOENT', 'scandir', dir);
      return [...store.keys()].map(file => path.basename(file)).sort().reverse();
    },
    async readFile(file, encoding) {
      await tick(); hook('readFile', file);
      if (encoding !== 'utf8') throw new Error('readFile without utf8');
      if (!store.has(key(file))) throw error('ENOENT', 'open', file);
      return store.get(key(file));
    },
    async writeFile(file, data, options) {
      await tick(); hook('writeFile', file);
      if (path.dirname(key(file)) !== DIR) throw error('ENOENT', 'open', file);
      if (options?.flag === 'wx' && store.has(key(file))) throw error('EEXIST', 'open', file);
      store.set(key(file), String(data));
    },
    async rename(from, to) {
      await tick(); hook('rename', from);
      if (!store.has(key(from))) throw error('ENOENT', 'rename', from);
      store.set(key(to), store.get(key(from)));
      store.delete(key(from));
    },
    async unlink(file) {
      await tick(); hook('unlink', file);
      if (!store.has(key(file))) throw error('ENOENT', 'unlink', file);
      store.delete(key(file));
    },
  };
  const files = () => Object.fromEntries([...store].map(([file, text]) => [path.basename(file), text]).sort(([a], [b]) => a < b ? -1 : 1));
  return {fs, log, files};
}

const pretty = (value, eol = '\n') => JSON.stringify(value, null, 2).replace(/\n/g, eol) + eol;
const isError = message => error => error instanceof MigrationError && error.name === 'MigrationError' && error.message === message;

/** Steps that append their label to doc.trail and record their context. */
function chain(spec, calls = []) {
  return spec.map(([from, to, down = true]) => {
    const step = label => (doc, context) => {
      calls.push([label, {...context}]);
      doc.trail = [...(doc.trail ?? []), label];
    };
    return {from, to, up: step(from + '->' + to), ...(down ? {down: step(to + '->' + from)} : {})};
  });
}

const up = (doc, label) => doc;
const OPTION_ERRORS = [
  [null, 'invalid options'],
  [[], 'invalid options'],
  ['x', 'invalid options'],
  [{}, 'invalid dir'],
  [{dir: '', target: 1, migrations: []}, 'invalid dir'],
  [{dir: 5, target: 'x', migrations: null}, 'invalid dir'],
  [{dir: 'd'}, 'invalid target: undefined'],
  [{dir: 'd', target: 0, migrations: []}, 'invalid target: 0'],
  [{dir: 'd', target: 1.5, migrations: []}, 'invalid target: 1.5'],
  [{dir: 'd', target: '2', migrations: []}, 'invalid target: 2'],
  [{dir: 'd', target: 1, migrations: {}}, 'invalid migrations'],
  [{dir: 'd', target: 1}, 'invalid migrations'],
  [{dir: 'd', target: 1, migrations: [null]}, 'migration 0: not an object'],
  [{dir: 'd', target: 1, migrations: [{from: 1, to: 2, up}, []]}, 'migration 1: not an object'],
  [{dir: 'd', target: 1, migrations: [{from: 0, to: 'x', up: 1}]}, 'migration 0: invalid from'],
  [{dir: 'd', target: 1, migrations: [{from: 1, to: 2.5, up}]}, 'migration 0: invalid to'],
  [{dir: 'd', target: 1, migrations: [{from: 2, to: 2, up: 1}]}, 'migration 0: to must be greater than from'],
  [{dir: 'd', target: 1, migrations: [{from: 3, to: 2, up}]}, 'migration 0: to must be greater than from'],
  [{dir: 'd', target: 1, migrations: [{from: 1, to: 2, down: up}]}, 'migration 0: invalid up'],
  [{dir: 'd', target: 1, migrations: [{from: 1, to: 2, up, down: null}]}, 'migration 0: invalid down'],
  [{dir: 'd', target: 1, migrations: [{from: 1, to: 2, up, down: undefined}, {from: 2, to: 3, up}, {from: 1, to: 2, up: 'x'}]}, 'migration 2: invalid up'],
  [{dir: 'd', target: 1, migrations: [{from: 1, to: 2, up, down: undefined}, {from: 2, to: 3, up}, {from: 1, to: 2, up}]}, 'migration 2: duplicate 1->2'],
  [{dir: 'd', target: 1, migrations: [], validators: []}, 'invalid validators'],
  [{dir: 'd', target: 1, migrations: [], validators: null}, 'invalid validators'],
  [{dir: 'd', target: 1, migrations: [], validators: {1: up, '01': up}}, 'invalid validator key: 01'],
  [{dir: 'd', target: 1, migrations: [], validators: {0: up}}, 'invalid validator key: 0'],
  [{dir: 'd', target: 1, migrations: [], validators: {x: 'y'}}, 'invalid validator key: x'],
  [{dir: 'd', target: 1, migrations: [], validators: {'1.0': up}}, 'invalid validator key: 1.0'],
  [{dir: 'd', target: 1, migrations: [], validators: {2: up, 3: 'f', 4: up}}, 'invalid validator for v3'],
  [{dir: 'd', target: 1, migrations: [], validators: {2: 'f'}, dryRun: 'yes'}, 'invalid validator for v2'],
  [{dir: 'd', target: 1, migrations: [], dryRun: 'yes'}, 'invalid dryRun'],
  [{dir: 'd', target: 1, migrations: [], dryRun: null, fs: null}, 'invalid dryRun'],
  [{dir: 'd', target: 1, migrations: [], fs: null}, 'invalid fs'],
  [{dir: 'd', target: 1, migrations: [], fs: {}}, 'invalid fs'],
  [{dir: 'd', target: 1, migrations: [], fs: Object.assign(() => {}, {readdir: up, readFile: up, writeFile: up, rename: up, unlink: up})}, 'invalid fs'],
  [{dir: 'd', target: 1, migrations: [], fs: {readdir: up, readFile: up, writeFile: up, rename: up}}, 'invalid fs'],
  [{dir: 'd', target: 3, migrations: [{from: 1, to: 2, up}]}, 'unknown target version 3'],
  [{dir: 'd', target: 3, migrations: [{from: 1, to: 2, up}, {from: 4, to: 5, up}], fs: {}}, 'invalid fs'],
  [{dir: 'd', target: 3, migrations: [{from: 1, to: 2, up}, {from: 4, to: 5, up}]}, 'unknown target version 3'],
];

for (const [options, message] of OPTION_ERRORS) {
  test('option error: ' + message + ' ' + JSON.stringify(options), async () => {
    const mem = memfs({});
    const withFs = options !== null && typeof options === 'object' && !Array.isArray(options) && !Object.hasOwn(options, 'fs') ? {...options, fs: mem.fs} : options;
    let promise;
    assert.doesNotThrow(() => { promise = migrateCorpus(withFs); });
    await assert.rejects(promise, isError(message));
    assert.deepEqual(mem.log, []);
  });
}

test('undefined optional options count as absent', async () => {
  const mem = memfs({'a.json': '{"$v": 1}'});
  const result = await migrateCorpus({dir: DIR, target: 1, migrations: [{from: 1, to: 2, up, down: undefined}], validators: undefined, dryRun: undefined, fs: mem.fs});
  assert.deepEqual(result, {target: 1, migrated: [], unchanged: ['a.json'], failed: [], written: false});
});

test('the contacts corpus migrates up and back down', async () => {
  const original = {
    'ada.json': '{"name": "Ada Lovelace", "phone": "555-0100", "tags": "math, poetry"}\n',
    'alan.json': '{\n  "$v": 2,\n  "first": "Alan",\n  "last": "Turing",\n  "tags": "math,crypto"\n}\n',
    'grace.json': '{\r\n  "$v": 3,\r\n  "first": "Grace",\r\n  "last": "Hopper",\r\n  "phones": [{"kind": "main", "number": "555-0102"}],\r\n  "tags": "navy"\r\n}\r\n',
    'barbara.json': BOM + '{"name": "Barbara Liskov"}',
  };
  const mem = memfs(original);
  const result = await migrateCorpus({dir: DIR, target: 4, migrations: contacts, validators: schemas, fs: mem.fs});
  assert.deepEqual(result, {target: 4, migrated: ['ada.json', 'alan.json', 'barbara.json', 'grace.json'], unchanged: [], failed: [], written: true});
  assert.deepEqual(mem.files(), {
    'ada.json': pretty({$v: 4, tags: ['math', 'poetry'], first: 'Ada', last: 'Lovelace', phones: [{kind: 'main', number: '555-0100'}]}),
    'alan.json': pretty({$v: 4, first: 'Alan', last: 'Turing', tags: ['math', 'crypto'], phones: []}),
    'barbara.json': BOM + pretty({$v: 4, first: 'Barbara', last: 'Liskov', phones: [], tags: []}),
    'grace.json': pretty({$v: 4, first: 'Grace', last: 'Hopper', phones: [{kind: 'main', number: '555-0102'}], tags: ['navy']}, '\r\n'),
  });
  const down = await migrateCorpus({dir: DIR, target: 1, migrations: contacts, validators: schemas, fs: mem.fs});
  assert.deepEqual(down.migrated, ['ada.json', 'alan.json', 'barbara.json', 'grace.json']);
  assert.deepEqual(mem.files(), {
    'ada.json': pretty({$v: 1, tags: 'math,poetry', phone: '555-0100', name: 'Ada Lovelace'}),
    'alan.json': pretty({$v: 1, tags: 'math,crypto', name: 'Alan Turing'}),
    'barbara.json': BOM + pretty({$v: 1, tags: '', name: 'Barbara Liskov'}),
    'grace.json': pretty({$v: 1, tags: 'navy', phone: '555-0102', name: 'Grace Hopper'}, '\r\n'),
  });
});

test('the default fs is node:fs/promises', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hidden-corpus-'));
  try {
    await writeFile(path.join(dir, 'a.json'), BOM + '{"name": "Kurt Gödel"}\r\n');
    await writeFile(path.join(dir, 'b.json'), '{"$v": 3, "first": "x", "last": "y", "phones": []}');
    const result = await migrateCorpus({dir, target: 3, migrations: contacts, validators: schemas});
    assert.deepEqual(result, {target: 3, migrated: ['a.json'], unchanged: ['b.json'], failed: [], written: true});
    assert.deepEqual((await readdir(dir)).sort(), ['a.json', 'b.json']);
    assert.equal(await readFile(path.join(dir, 'a.json'), 'utf8'), BOM + pretty({$v: 3, first: 'Kurt', last: 'Gödel', phones: []}, '\r\n'));
    assert.equal(await readFile(path.join(dir, 'b.json'), 'utf8'), '{"$v": 3, "first": "x", "last": "y", "phones": []}');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('the shortest path wins, ties go to the earlier migration', async () => {
  const calls = [];
  const migrations = chain([[1, 3, false], [1, 2], [2, 4], [3, 4], [2, 3], [3, 5], [4, 5]], calls);
  const mem = memfs({
    'a.json': '{"$v": 1}',
    'b.json': '{"$v": 5}',
    'c.json': '{"$v": 2}',
    'd.json': '{"$v": 4}',
  });
  const result = await migrateCorpus({dir: DIR, target: 4, migrations, fs: mem.fs});
  assert.deepEqual(result, {target: 4, migrated: ['a.json', 'b.json', 'c.json'], unchanged: ['d.json'], failed: [], written: true});
  const trail = name => JSON.parse(mem.files()[name]).trail;
  assert.deepEqual(trail('a.json'), ['1->3', '3->4']);
  assert.deepEqual(trail('b.json'), ['5->4']);
  assert.deepEqual(trail('c.json'), ['2->4']);
  assert.deepEqual(calls, [
    ['1->3', {file: 'a.json', from: 1, to: 3}], ['3->4', {file: 'a.json', from: 3, to: 4}],
    ['5->4', {file: 'b.json', from: 5, to: 4}],
    ['2->4', {file: 'c.json', from: 2, to: 4}],
  ]);
  const down = chain([[1, 2], [2, 3], [3, 4], [1, 3, false], [2, 4], [1, 4]]);
  const mem2 = memfs({'x.json': '{"$v": 4, "keep": true}', 'y.json': '{"$v": 3}'});
  await migrateCorpus({dir: DIR, target: 1, migrations: down, fs: mem2.fs});
  assert.equal(mem2.files()['x.json'], pretty({$v: 1, keep: true, trail: ['4->1']}));
  assert.equal(mem2.files()['y.json'], pretty({$v: 1, trail: ['3->2', '2->1']}));
  const tie = chain([[1, 2], [1, 3], [3, 5], [2, 5], [5, 6]]);
  const mem3 = memfs({'t.json': '{}'});
  await migrateCorpus({dir: DIR, target: 6, migrations: tie, fs: mem3.fs});
  assert.deepEqual(JSON.parse(mem3.files()['t.json']).trail, ['1->2', '2->5', '5->6']);
});

test('missing paths', async () => {
  const migrations = chain([[1, 2, false], [3, 4], [2, 3]]).slice(0, 2);
  const mem = memfs({'a.json': '{"$v": 2}', 'b.json': '{"$v": 1}', 'c.json': '{"$v": 4}', 'd.json': '{}'});
  const result = await migrateCorpus({dir: DIR, target: 1, migrations, fs: mem.fs});
  assert.deepEqual(result.failed, [
    {file: 'a.json', version: 2, step: null, message: 'no path from 2 to 1'},
    {file: 'c.json', version: 4, step: null, message: 'no path from 4 to 1'},
  ]);
  assert.deepEqual(result.unchanged, ['b.json', 'd.json']);
  const upward = await migrateCorpus({dir: DIR, target: 4, migrations, fs: memfs({'a.json': '{}'}).fs});
  assert.deepEqual(upward.failed, [{file: 'a.json', version: 1, step: null, message: 'no path from 1 to 4'}]);
});

test('$v is set after every step and written first', async () => {
  const seen = [];
  const migrations = [
    {from: 1, to: 2, up: doc => ({...doc, $v: 99, a: 1})},
    {from: 2, to: 3, up: doc => { seen.push(doc.$v); doc.$v = 'nope'; }},
  ];
  const validators = {2: doc => { seen.push('v2:' + doc.$v); return []; }, 3: doc => { seen.push('v3:' + doc.$v); return []; }};
  const mem = memfs({'a.json': '{"z": 0}\n'});
  await migrateCorpus({dir: DIR, target: 3, migrations, validators, fs: mem.fs});
  assert.deepEqual(seen, ['v2:2', 2, 'v3:3']);
  assert.equal(mem.files()['a.json'], '{\n  "$v": 3,\n  "z": 0,\n  "a": 1\n}\n');
});

test('line endings and byte order marks are kept', async () => {
  const migrations = [{from: 1, to: 2, up: doc => { doc.n = [1, 2]; }}];
  const mem = memfs({
    'crlf.json': '{"a": 1,\r\n"b": 2}',
    'mixed.json': '{"a": 1,\n"b": 2,\r\n"c": 3}\n',
    'lf.json': '{"a": 1}',
    'bom.json': BOM + '{"a": 1}\r\n',
    'cr.json': '{"a":\r1}',
  });
  await migrateCorpus({dir: DIR, target: 2, migrations, fs: mem.fs});
  assert.deepEqual(mem.files(), {
    'bom.json': BOM + pretty({$v: 2, a: 1, n: [1, 2]}, '\r\n'),
    'cr.json': pretty({$v: 2, a: 1, n: [1, 2]}),
    'crlf.json': pretty({$v: 2, a: 1, b: 2, n: [1, 2]}, '\r\n'),
    'lf.json': pretty({$v: 2, a: 1, n: [1, 2]}),
    'mixed.json': pretty({$v: 2, a: 1, b: 2, c: 3, n: [1, 2]}, '\r\n'),
  });
});

test('every document is processed and failures block the commit', async () => {
  const calls = [];
  const record = (label, behave) => (doc, context) => { calls.push(context.file + ' ' + label); return behave(doc, context); };
  const migrations = [
    {from: 1, to: 2, up: record('1->2', (doc, {file}) => {
      if (file === 'throws.json') throw new TypeError('boom');
      if (file === 'string.json') throw 'plain';
      if (file === 'rejects.json') return Promise.reject(new Error('later'));
      if (file === 'null.json') return null;
      if (file === 'array.json') return [];
      if (file === 'number.json') return 5;
      if (file === 'new.json') return {fresh: true};
      if (file === 'async.json') return Promise.resolve({async: true});
      doc.two = true;
    })},
    {from: 2, to: 3, up: record('2->3', doc => { doc.three = true; })},
  ];
  const validators = {
    1: doc => doc.bad1 ? ['bad at one', 'second'] : [],
    2: doc => doc.bad2 ? ['bad at two'] : [],
    3: doc => { if (doc.throw3) throw new RangeError('validator broke'); if (doc.throwPlain) throw 7; return []; },
  };
  const initial = {
    'array.json': '{}', 'async.json': '{}', 'bad1.json': '{"bad1": true}', 'bad2.json': '{"bad2": true}', 'json.json': '{"a": ',
    'bomjson.json': BOM + '{', 'list.json': '[1]', 'nil.json': 'null', 'new.json': '{"$v": 1}', 'null.json': '{}', 'number.json': '{}',
    'ok.json': '{}', 'rejects.json': '{}', 'same.json': '{"$v":3}', 'same-bad.json': '{"$v": 3, "throw3": true}', 'string.json': '{}',
    'throw3.json': '{"throw3": true}', 'throwplain.json': '{"$v": 2, "throwPlain": 1}', 'throws.json': '{}', 'v0.json': '{"$v": 0}',
    'v15.json': '{"$v": 1.5}', 'vnull.json': '{"$v": null}', 'vstring.json': '{"$v": "2"}', 'v7.json': '{"$v": 7}',
  };
  const mem = memfs(initial);
  const result = await migrateCorpus({dir: DIR, target: 3, migrations, validators, fs: mem.fs});
  assert.deepEqual(result, {
    target: 3,
    migrated: ['async.json', 'new.json', 'ok.json'],
    unchanged: ['same.json'],
    failed: [
      {file: 'array.json', version: 1, step: '1->2', message: 'step 1->2 returned a non-object'},
      {file: 'bad1.json', version: 1, step: null, message: 'invalid at v1: bad at one'},
      {file: 'bad2.json', version: 1, step: '1->2', message: 'invalid at v2: bad at two'},
      {file: 'bomjson.json', version: null, step: null, message: 'invalid JSON'},
      {file: 'json.json', version: null, step: null, message: 'invalid JSON'},
      {file: 'list.json', version: null, step: null, message: 'not an object'},
      {file: 'nil.json', version: null, step: null, message: 'not an object'},
      {file: 'null.json', version: 1, step: '1->2', message: 'step 1->2 returned a non-object'},
      {file: 'number.json', version: 1, step: '1->2', message: 'step 1->2 returned a non-object'},
      {file: 'rejects.json', version: 1, step: '1->2', message: 'step 1->2 failed: later'},
      {file: 'same-bad.json', version: 3, step: null, message: 'invalid at v3: validator threw: validator broke'},
      {file: 'string.json', version: 1, step: '1->2', message: 'step 1->2 failed: plain'},
      {file: 'throw3.json', version: 1, step: '2->3', message: 'invalid at v3: validator threw: validator broke'},
      {file: 'throwplain.json', version: 2, step: '2->3', message: 'invalid at v3: validator threw: 7'},
      {file: 'throws.json', version: 1, step: '1->2', message: 'step 1->2 failed: boom'},
      {file: 'v0.json', version: null, step: null, message: 'invalid version'},
      {file: 'v15.json', version: null, step: null, message: 'invalid version'},
      {file: 'v7.json', version: 7, step: null, message: 'unknown version 7'},
      {file: 'vnull.json', version: null, step: null, message: 'invalid version'},
      {file: 'vstring.json', version: null, step: null, message: 'invalid version'},
    ],
    written: false,
  });
  assert.deepEqual(mem.files(), initial);
  assert.deepEqual(calls.filter(call => call.startsWith('a') || call.startsWith('b') || call.startsWith('t')), [
    'array.json 1->2', 'async.json 1->2', 'async.json 2->3', 'bad2.json 1->2', 'throw3.json 1->2', 'throw3.json 2->3', 'throwplain.json 2->3', 'throws.json 1->2',
  ]);
});

test('documents: names, order and what is ignored', async () => {
  const order = [];
  const migrations = [{from: 1, to: 2, up: (doc, {file}) => { order.push(file); }}];
  const initial = {
    'b.json': '{}', 'B.json': '{}', '10.json': '{}', '9.json': '{}', '.hidden.json': 'x', 'upper.JSON': 'x', 'notes.txt': 'x',
    'old.json.bak': 'x', 'ä.json': '{}', 'Z.json': '{"$v": 2}', '_.json': '{}',
  };
  const mem = memfs(initial);
  const result = await migrateCorpus({dir: DIR, target: 2, migrations, fs: mem.fs});
  assert.deepEqual(order, ['10.json', '9.json', 'B.json', '_.json', 'b.json', 'ä.json']);
  assert.deepEqual(result.migrated, order);
  assert.deepEqual(result.unchanged, ['Z.json']);
  for (const name of ['.hidden.json', 'upper.JSON', 'notes.txt', 'old.json.bak', 'Z.json']) assert.equal(mem.files()[name], initial[name]);
  assert.equal(mem.log.filter(entry => entry.startsWith('readFile')).length, 7);
});

test('unchanged documents are never rewritten', async () => {
  const mem = memfs({'a.json': '{"$v":2,"x":[1,2]}', 'b.json': '{}'});
  await migrateCorpus({dir: DIR, target: 2, migrations: [{from: 1, to: 2, up: doc => { doc.y = 1; }}], fs: mem.fs});
  assert.equal(mem.files()['a.json'], '{"$v":2,"x":[1,2]}');
  assert.equal(mem.log.some(entry => entry.startsWith('writeFile a.json') || entry.startsWith('rename a.json')), false);
  const none = memfs({'a.json': '{"$v":2}'});
  const result = await migrateCorpus({dir: DIR, target: 2, migrations: [{from: 1, to: 2, up}], fs: none.fs});
  assert.equal(result.written, false);
  assert.deepEqual(none.log, ['writeFile .migrate.lock', 'readdir corpus', 'readFile a.json', 'unlink .migrate.lock']);
});

test('the commit writes temporary files, then renames them', async () => {
  const mem = memfs({'a.json': '{}', 'b.json': '{}', 'c.json': '{"$v": 2}'});
  const result = await migrateCorpus({dir: DIR, target: 2, migrations: [{from: 1, to: 2, up}], fs: mem.fs});
  assert.equal(result.written, true);
  assert.deepEqual(mem.log, [
    'writeFile .migrate.lock', 'readdir corpus', 'readFile a.json', 'readFile b.json', 'readFile c.json',
    'writeFile a.json.tmp', 'writeFile b.json.tmp', 'rename a.json.tmp', 'rename b.json.tmp', 'unlink .migrate.lock',
  ]);
});

test('dry runs take the lock and write nothing', async () => {
  const initial = {'a.json': '{}', 'b.json': '{"$v": 2}'};
  const mem = memfs(initial);
  const result = await migrateCorpus({dir: DIR, target: 2, migrations: [{from: 1, to: 2, up}], dryRun: true, fs: mem.fs});
  assert.deepEqual(result, {target: 2, migrated: ['a.json'], unchanged: ['b.json'], failed: [], written: false});
  assert.deepEqual(mem.files(), initial);
  assert.deepEqual(mem.log, ['writeFile .migrate.lock', 'readdir corpus', 'readFile a.json', 'readFile b.json', 'unlink .migrate.lock']);
});

test('a locked corpus is left alone', async () => {
  const initial = {'.migrate.lock': 'other run', 'a.json': '{}'};
  const mem = memfs(initial);
  await assert.rejects(migrateCorpus({dir: DIR, target: 2, migrations: [{from: 1, to: 2, up}], fs: mem.fs}), isError('corpus is locked'));
  assert.deepEqual(mem.files(), initial);
  assert.deepEqual(mem.log, ['writeFile .migrate.lock']);
  const denied = Object.assign(new Error('EACCES: denied'), {code: 'EACCES'});
  const mem2 = memfs({'a.json': '{}'}, (op, name) => op === 'writeFile' && name === '.migrate.lock' ? denied : undefined);
  await assert.rejects(migrateCorpus({dir: DIR, target: 2, migrations: [{from: 1, to: 2, up}], fs: mem2.fs}), error => error === denied);
  assert.deepEqual(mem2.log, ['writeFile .migrate.lock']);
});

test('I/O errors propagate after the lock is removed', async () => {
  const broken = new Error('disk gone');
  const mem = memfs({'a.json': '{}', 'b.json': '{}'}, (op, name) => op === 'readFile' && name === 'b.json' ? broken : undefined);
  await assert.rejects(migrateCorpus({dir: DIR, target: 2, migrations: [{from: 1, to: 2, up}], fs: mem.fs}), error => error === broken);
  assert.deepEqual(mem.files(), {'a.json': '{}', 'b.json': '{}'});
  const mem2 = memfs({'a.json': '{}'}, (op, name) => op === 'readdir' ? broken : op === 'unlink' ? new Error('cannot unlink') : undefined);
  await assert.rejects(migrateCorpus({dir: DIR, target: 2, migrations: [{from: 1, to: 2, up}], fs: mem2.fs}), error => error === broken);
  assert.deepEqual(mem2.log, ['writeFile .migrate.lock', 'readdir corpus', 'unlink .migrate.lock']);
});

const FOUR = {'a.json': '{"n": 1}', 'b.json': '{"n": 2}\r\n', 'c.json': BOM + '{"n": 3}', 'd.json': '{"n": 4}', 'e.json': '{"$v": 2}'};
const bump = [{from: 1, to: 2, up: doc => { doc.n *= 10; }}];

test('a failed rename rolls the commit back', async () => {
  const failure = Object.assign(new Error('EPERM: busy'), {code: 'EPERM'});
  const mem = memfs(FOUR, (op, name) => op === 'rename' && name === 'c.json.tmp' ? failure : undefined);
  await assert.rejects(migrateCorpus({dir: DIR, target: 2, migrations: bump, fs: mem.fs}),
    error => isError('commit failed at c.json: EPERM: busy')(error) && error.cause === failure);
  assert.deepEqual(mem.files(), FOUR);
});

test('a failed temporary write rolls the commit back', async () => {
  const mem = memfs(FOUR, (op, name) => op === 'writeFile' && name === 'b.json.tmp' ? 'no space' : undefined);
  await assert.rejects(migrateCorpus({dir: DIR, target: 2, migrations: bump, fs: mem.fs}),
    error => isError('commit failed at b.json: no space')(error) && error.cause === 'no space');
  assert.deepEqual(mem.files(), FOUR);
});

test('rollback errors do not stop the rollback', async () => {
  let restores = 0;
  const mem = memfs(FOUR, (op, name) => {
    if (op === 'rename' && name === 'd.json.tmp') return new Error('locked by scanner');
    if (op === 'writeFile' && /^[abc]\.json$/.test(name) && restores++ === 0) return new Error('restore failed');
    if (op === 'unlink' && name === '.migrate.lock') return new Error('lock stuck');
  });
  await assert.rejects(migrateCorpus({dir: DIR, target: 2, migrations: bump, fs: mem.fs}), isError('commit failed at d.json: locked by scanner'));
  const files = mem.files();
  delete files['.migrate.lock'];
  const restored = Object.keys(FOUR).filter(name => files[name] === FOUR[name]);
  assert.equal(restored.length, 4);
  assert.deepEqual(Object.keys(files).sort(), ['a.json', 'b.json', 'c.json', 'd.json', 'e.json']);
});

test('the commit rejects even when the failing step is the last rename', async () => {
  const mem = memfs(FOUR, (op, name) => op === 'rename' && name === 'd.json.tmp' ? new Error('late') : undefined);
  await assert.rejects(migrateCorpus({dir: DIR, target: 2, migrations: bump, fs: mem.fs}), isError('commit failed at d.json: late'));
  assert.deepEqual(mem.files(), FOUR);
});

test('path search stays fast on long histories', {timeout: 20000}, async () => {
  const migrations = [];
  for (let v = 1; v <= 600; v++) for (const jump of [1, 2, 3]) migrations.push({from: v, to: v + jump, up: doc => { doc.steps++; }, down: doc => { doc.steps--; }});
  const initial = {};
  for (let i = 0; i < 60; i++) initial['doc' + String(i).padStart(2, '0') + '.json'] = JSON.stringify({$v: 1 + (i * 7) % 600, steps: 0});
  const mem = memfs(initial);
  const started = Date.now();
  const result = await migrateCorpus({dir: DIR, target: 301, migrations, fs: mem.fs});
  assert.equal(result.failed.length, 0);
  for (const [name, text] of Object.entries(mem.files())) {
    if (name.startsWith('.')) continue;
    const before = JSON.parse(initial[name]).$v;
    const doc = JSON.parse(text);
    assert.equal(doc.$v, 301);
    assert.equal(Math.abs(doc.steps), Math.ceil(Math.abs(301 - before) / 3), name);
  }
  assert.ok(Date.now() - started < 8000, 'took ' + (Date.now() - started) + ' ms');
});
`;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

const patch = (from, to) => root => {
  if (!REFERENCE.includes(from)) throw Error('mustReject patch target missing: ' + from);
  writeTree(root, {'src/migrator.js': REFERENCE.replace(from, to)});
};

export default {
  id: 'corpus-migrations',
  category: 'versioned document migrations with rollback',
  prompt: 'src/migrator.js is an early draft of the migration runner for our contacts corpus. Make `migrateCorpus` implement the specification in docs/MIGRATIONS.md completely and exactly: option checks and error messages, locking, path selection, steps and validation, file formatting, the all-or-nothing commit with rollback, and the result. Use only Node built-ins and add no dependencies. Do not modify, delete or rename any existing file under test/ (you may add new test files); `npm test` must pass.',
  setup: root => gitRepo(root, [['Contacts corpus with draft migration runner', files]]),
  solve: root => writeTree(root, {'src/migrator.js': REFERENCE}),
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
    // Ties broken by the largest jump instead of array order.
    patch('.find(step => distance.get(step.b) === distance.get(at) - 1)',
      '.filter(step => distance.get(step.b) === distance.get(at) - 1).sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a))[0]'),
    // Documents already at the target are not validated.
    patch("  const problem = validate(options.validators, version, doc);\n  if (problem !== null) return fail(version, null, 'invalid at v' + version + ': ' + problem);\n  if (version === options.target) return {unchanged: true};",
      "  if (version === options.target) return {unchanged: true};\n  const problem = validate(options.validators, version, doc);\n  if (problem !== null) return fail(version, null, 'invalid at v' + version + ': ' + problem);"),
    // Rollback forgets the documents already renamed.
    patch('    for (const change of renamed) {\n      try {', '    for (const change of []) {\n      try {'),
    // Line endings always LF.
    patch("text.includes('\\r\\n') ? '\\r\\n' : '\\n'", "'\\n'"),
    // The lock is removed even when another run holds it.
    patch("if (error?.code === 'EEXIST') throw new MigrationError('corpus is locked');", "if (error?.code === 'EEXIST') { await fs.unlink(lock).catch(() => {}); throw new MigrationError('corpus is locked'); }"),
    // A visible test edited.
    root => writeTree(root, {'test/migrator.test.js': VISIBLE.replace("test('a dry run writes nothing'", "test.skip('a dry run writes nothing'")}),
  ],
};
