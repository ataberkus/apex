import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {ApiKeyLogin, OAuthLogin, subscriptionUsage} from '../dashboard/provider-login.mjs';

// The OAuth response is a fixture; Pi's login orchestration, file store and reload are real.
// No OpenAI request, model call or access to the user's profile is made.
test('Codex login binds callbacks to the active attempt, persists across restart, and keeps credentials private', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-codex-login-'));
  const options = {authPath: join(home, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false};
  let login;
  try {
    const runtime = await ModelRuntime.create(options);
    const provider = runtime.getProvider('openai-codex');
    let promptReady;
    let ready = new Promise(resolve => { promptReady = resolve; });
    const fixtureLogin = async interaction => {
      const method = await interaction.prompt({type: 'select', options: [{id: 'browser', label: 'Browser login'}]});
      if (method !== 'browser') throw new Error('Browser login required');
      interaction.notify({type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=fixture-state'});
      const answer = interaction.prompt({type: 'manual_code', signal: interaction.signal});
      promptReady();
      await answer;
      return {type: 'oauth', access: 'fixture-private-access', refresh: 'fixture-private-refresh', expires: Date.now() + 3600000, accountId: 'fixture-account'};
    };
    runtime.registerNativeProvider({...provider, auth: {...provider.auth, oauth: {...provider.auth.oauth, login: fixtureLogin}}});
    login = new OAuthLogin(runtime, 'openai-codex');
    assert.equal((await login.status()).signedIn, false);
    await login.start();
    await ready;
    const waiting = await login.status(), completion = login.flow.done;
    assert.throws(() => login.respond('stale-attempt', 'anything'), /no longer active/);
    assert.throws(() => login.respond(waiting.id, 'api-key-or-password'), /full localhost callback/);
    assert.throws(() => login.respond(waiting.id, 'https://evil.example/auth/callback?code=x&state=fixture-state'), /localhost/);
    assert.throws(() => login.respond(waiting.id, 'http://localhost:1455/auth/callback?code=x&state=wrong-attempt'), /different sign-in attempt/);
    login.respond(waiting.id, 'http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state');
    await completion;
    const saved = await login.status();
    assert.equal(saved.phase, 'saved');
    assert.equal(saved.signedIn, true);
    assert.equal(saved.url, undefined);
    assert.doesNotMatch(JSON.stringify(saved), /fixture-private|fixture-account|fixture-code/);

    // A new runtime with only the same profile path must see the durable login.
    const restarted = new OAuthLogin(await ModelRuntime.create(options), 'openai-codex');
    assert.equal((await restarted.status()).signedIn, true);

    ready = new Promise(resolve => { promptReady = resolve; });
    await login.start();
    await ready;
    const cancelledId = login.state.id;
    const cancelled = await login.cancel(cancelledId);
    assert.equal(cancelled.phase, 'idle');
    assert.equal(cancelled.signedIn, true); // cancellation must not erase an earlier login
    assert.throws(() => login.respond(cancelledId, 'http://localhost:1455/auth/callback?code=x&state=fixture-state'), /no longer active/);

    runtime.registerNativeProvider({...provider, auth: {...provider.auth, oauth: {...provider.auth.oauth, login: async () => { throw new Error('token response: fixture-private-access'); }}}});
    const failedStart = login.start(), failedCompletion = login.flow.done;
    await failedStart;
    await failedCompletion;
    const failed = await login.status();
    assert.equal(failed.phase, 'error');
    assert.equal(failed.signedIn, true);
    assert.doesNotMatch(JSON.stringify(failed), /fixture-private/);
  } finally {
    if (login?.flow) await login.cancel(login.flow.id);
    await rm(home, {recursive: true, force: true});
  }
});

// oh-my-pi's Claude flow runs for real in Bun: PKCE, state, its localhost:54545 listener, token exchange, refresh and usage,
// behind Pi's interaction and file store. A Bun preload sends api.anthropic.com to a local fixture and blocks all other
// network, so no Claude request or access to the user's profile is made.
test('Claude login, refresh and usage run through oh-my-pi: callback or code#state, PKCE exchange, refresh headers, 5h/7d windows', async t => {
  const home = await mkdtemp(join(tmpdir(), 'apex-claude-login-'));
  const options = {authPath: join(home, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false};
  const requests = [], resetsAt = new Date(Date.now() + 2 * 3600000).toISOString();
  let usageStatus = 200;
  let tokenResponse = {access_token: 'fixture-claude-access', refresh_token: 'fixture-claude-refresh', expires_in: 3600,
    account: {uuid: 'acct-1', email_address: 'me@example.com'}, organization: {uuid: 'org-1', name: 'Max plan'}};
  const anthropic = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({path: req.url.split('?')[0], headers: req.headers, body: body ? JSON.parse(body) : undefined});
    const reply = req.method === 'POST' && req.url === '/v1/oauth/token' ? tokenResponse
      : req.url === '/api/oauth/usage' ? {five_hour: {utilization: 42, resets_at: resetsAt}, seven_day: {utilization: 7, resets_at: resetsAt}} : undefined;
    if (req.url === '/api/oauth/usage' && usageStatus !== 200) return res.writeHead(usageStatus, {'content-type': 'application/json'}).end('{"error":{"type":"rate_limit_error"}}');
    res.writeHead(reply ? 200 : 404, {'content-type': 'application/json'}).end(JSON.stringify(reply ?? {}));
  });
  await new Promise(resolve => anthropic.listen(0, '127.0.0.1', resolve));
  const env = {BUN_OPTIONS: process.env.BUN_OPTIONS, APEX_TEST_ANTHROPIC: process.env.APEX_TEST_ANTHROPIC};
  process.env.BUN_OPTIONS = `--preload ${fileURLToPath(new URL('./fixtures/omp-anthropic-fetch.mjs', import.meta.url)).replaceAll('\\', '/')}`;
  process.env.APEX_TEST_ANTHROPIC = `http://127.0.0.1:${anthropic.address().port}`;
  let login;
  t.after(async () => {
    if (login?.flow) await login.cancel(login.flow.id);
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    anthropic.close();
    await rm(home, {recursive: true, force: true});
  });
  const until = async ready => { // fail fast (e.g. port 54545 busy or Bun missing) instead of polling forever
    const deadline = Date.now() + 15000;
    while (!ready()) {
      if (login.state.phase === 'error') throw new Error(login.state.message);
      if (Date.now() > deadline) throw new Error('Claude sign-in did not reach the expected step within 15 s');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const tokens = () => requests.filter(request => request.path === '/v1/oauth/token');
  const runtime = await ModelRuntime.create(options);
  login = new OAuthLogin(runtime, 'anthropic');
  const clientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

  // Pasted code#state.
  await login.start();
  await until(() => login.state.prompt);
  const waiting = await login.status(), completion = login.flow.done;
  const authorize = new URL(waiting.url), state = authorize.searchParams.get('state');
  assert.equal(authorize.origin + authorize.pathname, 'https://claude.ai/oauth/authorize');
  assert.deepEqual(Object.fromEntries([...authorize.searchParams].filter(([key]) => !['state', 'code_challenge'].includes(key))), {
    code: 'true', client_id: clientId, response_type: 'code', redirect_uri: 'http://localhost:54545/callback',
    scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload', code_challenge_method: 'S256'});
  assert.match(state, /^[0-9a-f]{32}$/);
  assert.equal(waiting.prompt.code, true);
  assert.throws(() => login.respond(waiting.id, 'sk-ant-api-key'), /code from Claude/);
  assert.throws(() => login.respond(waiting.id, 'the-code#other-state'), /different sign-in attempt/);
  assert.throws(() => login.respond(waiting.id, `http://localhost:53692/callback?code=x&state=${state}`), /localhost:54545\/callback/);
  login.respond(waiting.id, `the-code#${state}`);
  await completion;
  const [exchange] = tokens();
  const {code_verifier: verifier, ...exchangeBody} = exchange.body;
  assert.deepEqual(exchangeBody, {grant_type: 'authorization_code', client_id: clientId, code: 'the-code',
    redirect_uri: 'http://localhost:54545/callback', state});
  assert.notEqual(verifier, state, 'the PKCE verifier never travels as the state');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
  assert.equal(exchange.headers['anthropic-beta'], undefined, 'Claude Code sends the OAuth beta on refresh only');
  const saved = await login.status();
  assert.deepEqual([saved.phase, saved.signedIn], ['saved', true]);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-claude|the-code/);
  const stored = JSON.parse(await readFile(options.authPath, 'utf8')).anthropic;
  assert.deepEqual([stored.type, stored.access, stored.orgId, stored.email], ['oauth', 'fixture-claude-access', 'org-1', 'me@example.com'], 'Pi stores the identity oh-my-pi captured');
  assert.equal((await new OAuthLogin(runtime, 'openai-codex').status()).signedIn, false, 'logins are per provider');

  // Browser return to oh-my-pi's localhost listener; a forged state is refused there.
  await login.start();
  await until(() => login.state.url);
  const second = new URL(login.state.url).searchParams.get('state'), done = login.flow.done;
  assert.notEqual(second, state);
  assert.notEqual((await fetch(`http://127.0.0.1:54545/callback?code=forged&state=${state}`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:54545/callback?code=browser-code&state=${second}`)).status, 200);
  await done;
  assert.equal(tokens()[1].body.code, 'browser-code');
  assert.equal((await login.status()).signedIn, true);
  await assert.rejects(fetch('http://127.0.0.1:54545/callback'), 'the listener closes after sign-in');

  // Refresh through Pi keeps the refresh token and login identity when Claude omits them.
  tokenResponse = {access_token: 'fixture-refreshed-access', expires_in: 7200};
  const refreshed = await runtime.getProvider('anthropic').auth.oauth.refresh({type: 'oauth', access: 'old', refresh: 'fixture-claude-refresh', expires: 0, orgId: 'org-1'});
  const refresh = tokens()[2];
  assert.deepEqual(refresh.body, {grant_type: 'refresh_token', client_id: clientId, refresh_token: 'fixture-claude-refresh'});
  assert.equal(refresh.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.match(refresh.headers['user-agent'], /^anthropic-sdk-typescript\/\d+\.\d+\.\d+ userOAuthProvider$/);
  assert.deepEqual([refreshed.access, refreshed.refresh, refreshed.orgId], ['fixture-refreshed-access', 'fixture-claude-refresh', 'org-1']);
  assert.ok(refreshed.expires > Date.now() + 7200000 - 300000 - 15000 && refreshed.expires <= Date.now() + 7200000 - 300000);

  // Subscription usage: oh-my-pi's Claude usage provider with the saved token.
  const usage = await subscriptionUsage(runtime);
  assert.deepEqual(Object.keys(usage), ['anthropic'], 'only signed-in logins report usage');
  assert.deepEqual(usage.anthropic, {label: 'Claude', limits: [{label: 'Claude 5 Hour', used: 0.42, resetsAt: Date.parse(resetsAt)},
    {label: 'Claude 7 Day', used: 0.07, resetsAt: Date.parse(resetsAt)}]});
  assert.equal(requests.find(request => request.path === '/api/oauth/usage').headers.authorization, 'Bearer fixture-claude-access');
  assert.doesNotMatch(JSON.stringify(usage), /fixture-claude/);

  // Claude's /usage throttles per IP for minutes: a 429 (or 5xx) keeps the last report instead of asking to sign in again.
  usageStatus = 429;
  assert.deepEqual(await subscriptionUsage(runtime, undefined, usage), usage);
  assert.deepEqual((await subscriptionUsage(runtime)).anthropic, {label: 'Claude', error: 'HTTP429', signIn: false});
  // A refused token is a sign-in problem, whatever was shown before.
  usageStatus = 401;
  assert.deepEqual((await subscriptionUsage(runtime, undefined, usage)).anthropic, {label: 'Claude', error: 'HTTP401', signIn: true});
  usageStatus = 200;

  // An expired access token is refreshed through oh-my-pi before usage is fetched, and the refreshed token is used.
  const expiring = JSON.parse(await readFile(options.authPath, 'utf8'));
  expiring.anthropic.expires = 0;
  await writeFile(options.authPath, JSON.stringify(expiring));
  tokenResponse = {access_token: 'fixture-after-expiry', expires_in: 7200};
  const restarted = await ModelRuntime.create(options);
  new OAuthLogin(restarted, 'anthropic'); // as the dashboard does at startup: Pi refreshes through oh-my-pi
  assert.deepEqual((await subscriptionUsage(restarted)).anthropic, usage.anthropic);
  assert.equal(requests.findLast(request => request.path === '/api/oauth/usage').headers.authorization, 'Bearer fixture-after-expiry');

  assert.equal((await login.logout()).signedIn, false);
});

// Pi's real API-key login prompt and file store; no OpenCode request is made.
test('OpenCode Go key is saved privately, survives restart, and can be removed', async t => {
  const home = await mkdtemp(join(tmpdir(), 'apex-opencode-key-'));
  const env = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  t.after(async () => {
    if (env === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = env;
    await rm(home, {recursive: true, force: true});
  });
  const options = {authPath: join(home, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false};
  const login = new ApiKeyLogin(await ModelRuntime.create(options), 'opencode-go');
  assert.equal((await login.status()).signedIn, false);
  await assert.rejects(login.save('two words'), /no spaces/);
  await assert.rejects(login.save(42), /no spaces/);
  const saved = await login.save('  oc-fixture-private-key  ');
  assert.deepEqual([saved.phase, saved.signedIn, saved.source], ['saved', true, 'saved']);
  assert.doesNotMatch(JSON.stringify(saved), /oc-fixture-private-key/);
  const restarted = new ApiKeyLogin(await ModelRuntime.create(options), 'opencode-go');
  assert.equal((await restarted.status()).signedIn, true);
  assert.equal((await restarted.status()).source, 'saved');
  assert.equal((await restarted.logout()).signedIn, false);
  process.env.OPENCODE_API_KEY = 'from-environment';
  assert.equal((await restarted.status()).source, 'environment');
});
