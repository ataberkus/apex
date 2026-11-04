import {gitRepo, hiddenTests, verdict, writeTree} from '../lib.mjs';

const PROMPT = `normalize(p) in src/paths.js should turn Windows or POSIX style paths into one canonical forward-slash form, but several cases are wrong. Fix it to follow this spec exactly (pure string processing; do not use node:path):

- Backslashes become forward slashes; runs of separators collapse to one.
- A drive letter is upper-cased: "c:\\x" -> "C:/x". A drive root is "C:/". A bare drive "c:" stays "C:", and "c:foo" stays drive-relative ("C:foo").
- UNC paths keep their leading double slash: "\\\\server\\share\\x" -> "//server/share/x"; "//server/share" is its own root.
- "." segments are removed. ".." removes the previous segment; at a root (/, C:/, //server/share) it is dropped; in a relative path with nothing left to remove it is kept ("../a", "a/../../b" -> "../b").
- No trailing slash except on a root.
- A relative path that becomes empty, and the empty string, normalize to ".".`;

const SOURCE = `/** Canonical forward-slash form of a Windows or POSIX path. */
export function normalize(p) {
  let path = p.replace(/\\\\/g, '/');
  const absolute = path.startsWith('/');
  const parts = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return (absolute ? '/' : '') + parts.join('/');
}
`;

const REFERENCE = `export function normalize(p) {
  let path = p.replace(/\\\\/g, '/');
  let root = '';
  let match;
  if ((match = /^\\/\\/+([^/]+)\\/+([^/]+)/.exec(path))) { root = '//' + match[1] + '/' + match[2]; path = path.slice(match[0].length); }
  else if ((match = /^([a-zA-Z]):(\\/*)/.exec(path))) { root = match[1].toUpperCase() + ':' + (match[2] ? '/' : ''); path = path.slice(match[0].length); }
  else if (path.startsWith('/')) root = '/';
  const absolute = root !== '' && root.endsWith('/') || root.startsWith('//');
  const parts = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (parts.length && parts.at(-1) !== '..') parts.pop(); else if (!absolute) parts.push('..'); }
    else parts.push(segment);
  }
  if (root.startsWith('//')) return parts.length ? root + '/' + parts.join('/') : root;
  if (root) return root + parts.join('/');
  return parts.join('/') || '.';
}
`;

export default {
  id: 'win-paths',
  category: 'edge-case spec on Windows paths',
  prompt: PROMPT,
  setup: root => gitRepo(root, [['Path normalizer', {'package.json': '{"type":"module"}\n', 'src/paths.js': SOURCE}]]),
  solve: root => writeTree(root, {'src/paths.js': REFERENCE}),
  verify(root) {
    const hidden = hiddenTests(root, `import test from 'node:test';
import assert from 'node:assert/strict';
const {normalize} = await import('@ROOT@src/paths.js');
const cases = {
  'c:\\\\Users\\\\ada\\\\..\\\\bob\\\\.\\\\notes.txt': 'C:/Users/bob/notes.txt', 'C:\\\\': 'C:/', 'c:': 'C:', 'c:foo\\\\bar': 'C:foo/bar',
  'D:/a//b///c/': 'D:/a/b/c', 'C:\\\\..\\\\..\\\\x': 'C:/x', '\\\\\\\\server\\\\share\\\\dir\\\\..\\\\file': '//server/share/file',
  '//server/share': '//server/share', '//server/share/..': '//server/share', '/usr//local/./bin/': '/usr/local/bin', '/..': '/',
  '/a/b/../../..': '/', '../a': '../a', 'a/../../b': '../b', './x/./y/..': 'x', 'a/..': '.', '': '.', '.': '.', '../../': '../..',
  'a\\\\b/c\\\\': 'a/b/c',
};
test('spec cases', () => { for (const [input, want] of Object.entries(cases)) assert.equal(normalize(input), want, JSON.stringify(input)); });`);
    return verdict({spec_cases: hidden.pass}, {hidden: hidden.output});
  },
};
