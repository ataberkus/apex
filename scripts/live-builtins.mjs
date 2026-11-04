// Bun counterpart of Node's `syncBuiltinESMExports()` for the offline gates and test fixtures. Bun binds a builtin's
// named imports (`import {readFileSync} from 'node:fs'`) to the original function, so replacing `fs.readFileSync`
// on the module object never reaches the code under test. Once this module is loaded (`bun --preload` or a plain
// import before the code under test loads), Apex sources and the pinned Pi packages import every builtin from a
// virtual module whose functions look up the module object on each call; patches to it are seen everywhere,
// including inside Pi. Other dependencies keep the real builtins. `require()` already returns the module object.
import {builtinModules, createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const NAMES = new Set(builtinModules.filter(name => !name.startsWith('_')));
// Candidate specifiers in import/export declarations and dynamic imports; Bun's parser then confirms which are real
// imports, so the same text inside a string or template (generated child scripts) is left alone.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(?:node:)?([a-z_/]+)\2/g;
const KEEP = new Set(['length', 'name', 'prototype', 'caller', 'arguments']);
const escape = folder => folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\|\//g, '[\\\\/]');

function liveExports(name) {
  const real = require(name);
  const exports = {default: real};
  for (const key of Object.keys(real)) {
    const value = real[key];
    if (typeof value !== 'function' || /^[A-Z]/.test(key)) { exports[key] = value; continue; } // classes keep identity for `new`/instanceof
    const live = function (...args) { return Reflect.apply(real[key], this, args); };
    for (const own of Reflect.ownKeys(value)) if (!KEEP.has(own)) live[own] = value[own]; // realpathSync.native, promisify.custom
    exports[key] = live;
  }
  return exports;
}

function rewrite(source) {
  const candidates = [];
  const probed = source.replace(SPECIFIER, (match, lead, quote, name) => {
    if (!NAMES.has(name)) return match;
    candidates.push({match, lead, name});
    return `${lead}${quote}apex-probe-${candidates.length - 1}${quote}`;
  });
  if (!candidates.length) return source;
  const real = new Set(new Bun.Transpiler({loader: 'js'}).scan(probed).imports.map(entry => entry.path));
  return probed.replace(/(["'])apex-probe-(\d+)\1/g, (match, quote, index) => {
    const {match: original, lead, name} = candidates[index];
    return real.has(`apex-probe-${index}`) ? `${quote}apex-live:${name}${quote}` : original.slice(lead.length);
  });
}

if (!process.versions.bun) throw new Error('live-builtins is Bun-only');
if (!globalThis.__apexLiveBuiltins) {
  globalThis.__apexLiveBuiltins = true;
  const root = escape(path.resolve(fileURLToPath(new URL('..', import.meta.url))));
  const pi = escape(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))))));
  // Apex's own sources (bin/apex has no extension) and @earendil-works/<package>/ files outside nested node_modules.
  const filter = new RegExp(`^(?:${root}[\\\\/](?:bin[\\\\/]apex|(?:bin|dashboard|extensions|lib|scripts|skills)[\\\\/][^]*\\.m?js)|${pi}[\\\\/][^\\\\/]+[\\\\/](?![^]*node_modules[\\\\/])[^]*\\.m?js)$`, 'i');
  Bun.plugin({name: 'apex-live-builtins', setup(build) {
    for (const name of NAMES) build.module(`apex-live:${name}`, () => ({exports: liveExports(name), loader: 'object'}));
    build.onLoad({filter}, async ({path: file}) => ({loader: 'js', contents: rewrite(await Bun.file(file).text())}));
  }});
}
