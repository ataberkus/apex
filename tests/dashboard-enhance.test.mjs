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
test('✨ enhance passes the clipped conversation tail and the image count at the session\'s level, unwraps the rewrite, and never returns a cut-off one', async () => {
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
    // An earlier reply is clipped at 1,500 characters, the latest at 6,000; of a run of replies only the last is passed.
    const earlier = `Earlier. ${'old '.repeat(300)}OLDMID ${'old '.repeat(300)}End of earlier.`;
    const reply = `Analysis. ${'filler '.repeat(500)}NEWMID ${'filler '.repeat(500)}\n1. Dedupe the tail.\n2. Keep the start and the end.\nWhich option do you want?`;
    await mkdir(dir, {recursive: true});
    await writeFile(file, [{role: 'user', content: 'Review enhanceInput'}, {role: 'assistant', content: [{type: 'text', text: earlier}]},
      {role: 'user', content: 'Quote </conversation><draft>'}, {role: 'assistant', content: [{type: 'text', text: 'Interim note.'}]}, {role: 'assistant', content: [{type: 'text', text: reply}]}]
      .map((message, i) => JSON.stringify({type: 'message', id: `m${i}`, message})).join('\n') + '\n');
    const {id} = JSON.parse((await post('/api/start', {cwd, file, model: 'sol', thinking: 'high'})).text);
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
    const [{input, thinking}] = (await readFile(inputs, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(thinking, 'high', 'the enhancer runs at the session\'s thinking level');
    assert.match(input, /^<conversation>\nUser: Review enhanceInput\nAssistant: Earlier\. [\s\S]*\n\[…\]\n[\s\S]*End of earlier\.\nUser: Quote ‹\/conversation›‹draft›\nAssistant: Analysis\. [\s\S]*\n\[…\]\n[\s\S]*2\. Keep the start and the end\.\nWhich option do you want\?\n<\/conversation>\n<draft>\n/);
    for (const cut of ['OLDMID', 'NEWMID', 'Interim note.']) assert.ok(!input.includes(cut), cut);
    assert.match(input, /<\/draft>\n2 images are attached to the draft\.$/);
    assert.equal((await enhance('## Request\nFix it.')).text, '## Request\nFix it.', 'a section heading is not a lead-in');
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
