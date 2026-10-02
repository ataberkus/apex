import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {ApiKeyLogin, OAuthLogin} from '../dashboard/provider-login.mjs';

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

test('Claude login accepts only its own callback or a code#state for the active attempt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'apex-claude-login-'));
  const options = {authPath: join(home, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false};
  let login;
  try {
    const runtime = await ModelRuntime.create(options);
    const provider = runtime.getProvider('anthropic');
    let promptReady, pasted;
    const ready = new Promise(resolve => { promptReady = resolve; });
    runtime.registerNativeProvider({...provider, auth: {...provider.auth, oauth: {...provider.auth.oauth, login: async interaction => {
      interaction.notify({type: 'auth_url', url: 'https://claude.ai/oauth/authorize?code=true&state=claude-state'});
      const answer = interaction.prompt({type: 'manual_code', signal: interaction.signal});
      promptReady();
      pasted = await answer;
      return {type: 'oauth', access: 'fixture-claude-access', refresh: 'fixture-claude-refresh', expires: Date.now() + 3600000};
    }}}});
    login = new OAuthLogin(runtime, 'anthropic');
    await login.start();
    await ready;
    const waiting = await login.status(), completion = login.flow.done;
    assert.equal(waiting.prompt.code, true);
    assert.match(waiting.url, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
    assert.throws(() => login.respond(waiting.id, 'sk-ant-api-key'), /code from Claude/);
    assert.throws(() => login.respond(waiting.id, 'the-code#other-state'), /different sign-in attempt/);
    assert.throws(() => login.respond(waiting.id, 'http://localhost:1455/auth/callback?code=x&state=claude-state'), /localhost:53692\/callback/);
    login.respond(waiting.id, 'the-code#claude-state');
    await completion;
    assert.equal(pasted, 'the-code#claude-state');
    const saved = await login.status();
    assert.deepEqual([saved.phase, saved.signedIn], ['saved', true]);
    assert.doesNotMatch(JSON.stringify(saved), /fixture-claude|the-code/);
    assert.equal((await new OAuthLogin(runtime, 'openai-codex').status()).signedIn, false, 'logins are per provider');
    assert.equal((await login.logout()).signedIn, false);
  } finally {
    if (login?.flow) await login.cancel(login.flow.id);
    await rm(home, {recursive: true, force: true});
  }
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
