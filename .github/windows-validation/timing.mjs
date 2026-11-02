// Times the two branch timing tests' operations against the d0c6d2b reference, outside bun test.
import {mkdtempSync, writeFileSync, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root = path.resolve(process.argv[2] ?? '.');
const cur = await import(pathToFileURL(path.join(root, 'extensions/apex-core/control.mjs')).href);
const ref = await import(pathToFileURL(path.join(root, 'tests/fixtures/core-control-d0c6d2b.mjs')).href);
const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'timing-')));
const lines = Array.from({length: 900}, (_, i) => `  const value${i} = compute(${i}, "some text here ${i % 97}"); // line ${i}`);
writeFileSync(path.join(cwd, 'large.js'), lines.join('\n') + '\n');
const block = lines.slice(450, 850).join('\n');
const edits = [{oldText: block, newText: block.replace(/compute/g, 'calc').replace(/line/g, 'L')}];
const call = (toolName, input) => ({type: 'tool_call', toolCallId: 'c1', toolName, input});
const median = xs => xs.sort((a, b) => a - b)[xs.length >> 1];
async function edit(api) { const times = []; for (let i = 0; i < 7; i++) { const s = performance.now(); await api.correctToolCall(call('edit', {path: 'large.js', edits}), {cwd}); times.push(performance.now() - s); } return {first: +times[0].toFixed(1), median: +median(times).toFixed(1)}; }
const grow = (target, prefix, item, joiner, suffix) => { const items = []; for (let i = 0, size = prefix.length + suffix.length; size < target; i++) { const v = item(i); items.push(v); size += v.length + joiner.length; } return prefix + items.join(joiner) + suffix; };
const json = size => grow(size, "echo '[", i => `{"path":"/src/module${i}/index.js","addr":"${i} Main ${i % 20 === 0 ? 'Rd' : 'St'}"}`, ',', "]' > fixtures/data.json");
async function del(api) { const out = {}; for (const size of [6e3, 25e3, 100e3]) { const command = json(size); const times = []; for (let i = 0; i < 3; i++) { const s = performance.now(); await api.correctToolCall(call('bash', {command}), {cwd, mode: 'tui', hasUI: true}, {headless: false, confirm: async () => false}); times.push(performance.now() - s); } out[size] = times.map(t => +t.toFixed(1)); } return out; }
console.log(JSON.stringify({platform: process.platform, cpus: os.availableParallelism(), editCurrent: await edit(cur), editReference: await edit(ref), deleteCheckCurrent: await del(cur)}));
