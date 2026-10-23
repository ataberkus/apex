import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const server = fileURLToPath(new URL('../dashboard/server.mjs', import.meta.url));
const fixture = new URL('./fixtures/dashboard-rpc.mjs', import.meta.url);
// The fixture replaces child_process.spawn; live-builtins makes the server's named `spawn` import see that.
const preload = ['--preload', fileURLToPath(new URL('../scripts/live-builtins.mjs', import.meta.url)), '--preload', fileURLToPath(fixture)];

function call(port, {method = 'GET', path = '/', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path, headers: {host: `127.0.0.1:${port}`, ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// The fixture's model echoes the draft as its rewrite, so each draft below is the answer the enhancer gets back.
test('✨ enhance passes the end of long replies and the image count, unwraps the rewrite, and never returns a cut-off one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-dash-enhance-'));
  const port = 46000 + Math.floor(Math.random() * 1000), inputs = join(home, 'enhance.jsonl');
  const child = spawn(process.execPath, [...preload, server], {env: {...process.env, APEX_DASH_HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent'), APEX_DASH_PORT: String(port), APEX_FIXTURE_ENHANCE: inputs}, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true});
  try {
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard startup timed out')), 20000);
      child.once('error', reject);
      child.stdout.on('data', chunk => { const match = /\?t=(\S+)/.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const cookie = (await call(port, {path: `/?t=${token}`})).headers['set-cookie'][0].split(';')[0];
    const post = (path, body) => call(port, {method: 'POST', path, headers: {cookie, origin: `http://127.0.0.1:${port}`}, body: JSON.stringify(body)});
    const project = join(home, 'project'); await mkdir(project);
    const cwd = JSON.parse((await post('/api/workspaces', {path: project})).text).path;
    const dir = join(home, 'agent', 'sessions', `--${cwd.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`), file = join(dir, 'saved.jsonl');
    const reply = `Analysis. ${'filler '.repeat(100)}MIDDLE ${'filler '.repeat(150)}\n1. Dedupe the tail.\n2. Keep the start and the end.\nWhich option do you want?`;
    await mkdir(dir, {recursive: true});
    await writeFile(file, [{role: 'user', content: 'Review enhanceInput'}, {role: 'assistant', content: [{type: 'text', text: reply}]}]
      .map((message, i) => JSON.stringify({type: 'message', id: `m${i}`, message})).join('\n') + '\n');
    const {id} = JSON.parse((await post('/api/start', {cwd, file, model: 'sol'})).text);
    const enhance = async (text, images) => {
      const started = await post('/api/enhance', {id, text, images});
      if (started.status !== 202) return {status: started.status, ...JSON.parse(started.text)};
      for (;;) {
        const job = JSON.parse((await call(port, {path: '/api/enhance?id=' + JSON.parse(started.text).id, headers: {cookie}})).text);
        if (job.status !== 'running') return job;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };

    for (const command of ['/compact now', '  !git status']) assert.equal((await enhance(command)).status, 400, command);
    const wrapped = await enhance("Here's the rewritten prompt:\n\n```markdown\nDo option 2 from your list.\n```", 2);
    assert.deepEqual([wrapped.status, wrapped.text], ['done', 'Do option 2 from your list.']);
    const [input] = (await readFile(inputs, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.match(input, /User: Review enhanceInput\nAssistant: Analysis\. [\s\S]*\n\[…\]\n[\s\S]*2\. Keep the start and the end\.\nWhich option do you want\?\n<\/conversation>/);
    assert.ok(!input.includes('MIDDLE'), 'the middle of the long reply is cut, not its end');
    assert.match(input, /<\/draft>\n2 images are attached to the draft\.\nRewrite the draft above/);
    // A prompt that starts with its own code block stays whole; a wrapper fence that was never closed goes.
    assert.equal((await enhance('```\nTypeError: x\n```\nFix this error.')).text, '```\nTypeError: x\n```\nFix this error.');
    assert.equal((await enhance('```markdown\nFix it.')).text, 'Fix it.');
    const cut = await enhance('Rewrite that stops at the output limit');
    assert.deepEqual([cut.status, cut.text], ['error', undefined], 'a cut-off rewrite never replaces the draft');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await rm(home, {recursive: true, force: true});
  }
});
