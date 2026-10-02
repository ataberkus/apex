import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createReadTool, createWriteTool, createEditTool, createBashTool, createGrepTool, createFindTool, createLsTool } from '@earendil-works/pi-coding-agent';

await mkdir('validation', {recursive: true});
const cwd = await mkdtemp(path.resolve('validation/micro-'));
const execute = (tool, args) => tool.execute('offline-fixture', args, undefined, undefined);
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
const results = [];
try {
  await execute(createWriteTool(cwd), {path: 'sample.txt', content: 'alpha\nbeta\ngamma\n'});
  assert.equal(await readFile(path.join(cwd, 'sample.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
  results.push({check: 'write', passed: true});
  assert.match(text(await execute(createReadTool(cwd), {path: 'sample.txt', offset: 2, limit: 1})), /beta/);
  results.push({check: 'read_range', passed: true});
  await execute(createEditTool(cwd), {path: 'sample.txt', edits: [{oldText: 'beta', newText: 'delta'}, {oldText: 'gamma', newText: 'epsilon'}]});
  assert.equal(await readFile(path.join(cwd, 'sample.txt'), 'utf8'), 'alpha\ndelta\nepsilon\n');
  results.push({check: 'batch_edit_apply', passed: true});
  await assert.rejects(() => execute(createEditTool(cwd), {path: 'sample.txt', edits: [{oldText: 'absent', newText: 'z'}]}));
  assert.equal(await readFile(path.join(cwd, 'sample.txt'), 'utf8'), 'alpha\ndelta\nepsilon\n');
  results.push({check: 'edit_precondition_preserves_file', passed: true});
  assert.match(text(await execute(createGrepTool(cwd), {path: cwd, pattern: 'delta', limit: 5})), /sample.txt.*delta/);
  results.push({check: 'grep', passed: true});
  assert.match(text(await execute(createFindTool(cwd), {path: cwd, pattern: '*.txt', limit: 5})), /sample.txt/);
  results.push({check: 'find', passed: true});
  assert.match(text(await execute(createLsTool(cwd), {path: cwd, limit: 5})), /sample.txt/);
  results.push({check: 'ls', passed: true});
  assert.match(text(await execute(createBashTool(cwd), {command: 'printf apex-offline', timeout: 5})), /apex-offline/);
  results.push({check: 'bash', passed: true});
  console.log(JSON.stringify({kind: 'offline_tool_contract', provider_calls: 0, results}, null, 2));
} finally {
  await rm(cwd, {recursive: true, force: true});
}
