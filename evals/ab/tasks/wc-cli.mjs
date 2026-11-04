import path from 'node:path';
import {gitRepo, run, verdict, writeTree} from '../lib.mjs';

const SPEC = `Implement bin/wc.js, a small Node CLI (no dependencies), run as \`node bin/wc.js [-l] [-w] [-c] [FILE...]\`.

- Counts: lines = number of "\\n" characters; words = maximal runs of non-whitespace characters; bytes = size in bytes.
- Flags select counts: -l lines, -w words, -c bytes. With no flags, print all three. Flags may be combined ("-lw") and may appear anywhere among the arguments, in any order; output order is always lines, words, bytes.
- Output for each FILE: the selected counts, each right-aligned in a field of width 8, then one space and the file name exactly as given. One line per file, in argument order.
- With more than one FILE, finish with a totals line in the same format, named "total".
- With no FILE, read standard input and print the counts with no name and no trailing space.
- A FILE that does not exist: print "wc: NAME: No such file or directory" to standard error, continue with the other files, leave it out of the totals, and exit with code 1. Otherwise exit 0.
- An unknown flag such as -x: print "wc: invalid option -- 'x'" to standard error and exit with code 2 without printing counts.`;

const REFERENCE = `#!/usr/bin/env node
import {readFileSync} from 'node:fs';
const flags = new Set(), files = [];
for (const arg of process.argv.slice(2)) {
  if (/^-[^-]/.test(arg)) for (const flag of arg.slice(1)) {
    if (!'lwc'.includes(flag)) { process.stderr.write("wc: invalid option -- '" + flag + "'\\n"); process.exit(2); }
    flags.add(flag);
  } else files.push(arg);
}
const order = flags.size ? ['l', 'w', 'c'].filter(flag => flags.has(flag)) : ['l', 'w', 'c'];
const count = buffer => { const text = buffer.toString('utf8'); return {l: (text.match(/\\n/g) ?? []).length, w: (text.match(/\\S+/g) ?? []).length, c: buffer.length}; };
const line = (counts, name) => order.map(flag => String(counts[flag]).padStart(8)).join('') + (name === undefined ? '' : ' ' + name);
if (!files.length) { process.stdout.write(line(count(readFileSync(0))) + '\\n'); process.exit(0); }
let status = 0; const total = {l: 0, w: 0, c: 0};
for (const file of files) {
  let buffer;
  try { buffer = readFileSync(file); } catch { process.stderr.write('wc: ' + file + ': No such file or directory\\n'); status = 1; continue; }
  const counts = count(buffer); for (const flag of 'lwc') total[flag] += counts[flag];
  process.stdout.write(line(counts, file) + '\\n');
}
if (files.length > 1) process.stdout.write(line(total, 'total') + '\\n');
process.exit(status);
`;

const fixtures = {
  'samples/poem.txt': 'Tyger Tyger, burning bright,\nIn the forests of the night;\n',
  'samples/empty.txt': '',
  'samples/unicode.txt': 'naïve café — déjà vu\n\ttabs\tand  spaces  \n\nno newline at end',
  'samples/crlf.txt': 'one two\r\nthree\r\n',
};

export default {
  id: 'wc-cli',
  category: 'feature from a precise spec',
  prompt: SPEC,
  setup: root => gitRepo(root, [['Samples', {...fixtures, 'package.json': '{"type":"module"}\n', 'README.md': '# wc\n\nA tiny wc clone. See the task for the spec.\n'}]]),
  solve: root => writeTree(root, {'bin/wc.js': REFERENCE}),
  verify(root) {
    const ref = path.join(root, '..', path.basename(root) + '-hidden', 'wc-ref.mjs');
    writeTree(path.dirname(ref), {[path.basename(ref)]: REFERENCE});
    const extra = path.join(root, '..', path.basename(root) + '-hidden', 'extra.txt');
    writeTree(path.dirname(extra), {'extra.txt': 'alpha beta\ngamma\n\n  delta  epsilon zeta\n'});
    const cases = [
      ['samples/poem.txt'], ['-l', 'samples/poem.txt'], ['-wc', 'samples/unicode.txt'], ['-c', '-l', 'samples/crlf.txt', 'samples/poem.txt'],
      ['samples/empty.txt', 'samples/poem.txt', 'samples/unicode.txt'], ['samples/missing.txt'], ['-w', 'samples/poem.txt', 'samples/nope.txt', 'samples/crlf.txt'],
      ['-x', 'samples/poem.txt'], ['samples/poem.txt', '-l'], [extra], ['-lwc', extra, 'samples/unicode.txt'],
    ];
    const stdinCases = [['-l'], [], ['-w']];
    const failures = [];
    const compare = (args, input) => {
      const want = run(process.execPath, [ref, ...args], {cwd: root, input});
      const got = run(process.execPath, ['bin/wc.js', ...args], {cwd: root, input});
      const norm = text => text.replace(/\r\n/g, '\n');
      if (want.status !== got.status || norm(want.stdout) !== norm(got.stdout) || norm(want.stderr).trim() !== norm(got.stderr).trim())
        failures.push({args, input: input?.slice(0, 40), want: [want.status, want.stdout, want.stderr], got: [got.status, got.stdout.slice(0, 400), got.stderr.slice(0, 200)]});
    };
    for (const args of cases) compare(args);
    for (const args of stdinCases) compare(args, 'from stdin\nsecond line here\n  x');
    return verdict({all_cases_match: failures.length === 0}, {failures: failures.slice(0, 5), cases: cases.length + stdinCases.length});
  },
};
