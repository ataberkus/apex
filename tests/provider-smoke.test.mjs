import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

let smoke;
try { smoke = await import('../evals/micro/provider-smoke.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const model = {
  type: 'chat', provider: 'openrouter', id: 'meta/muse-spark-1.3-contributor',
  api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
  cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
};
const payload = () => ({model: model.id, messages: [], stream: true,
  stream_options: {include_usage: true}, max_tokens: 6144, reasoning:{effort:'xhigh'}});
const request = (body = payload()) => ['https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST', body: JSON.stringify(body),
}];
function guard(extra = {}) {
  assert.equal(typeof smoke?.createRequestGuard, 'function', 'bounded provider request guard must exist');
  return smoke.createRequestGuard({model, maxSpendUsd: 0.02, ...extra});
}

const exactModel = `openrouter/${model.id}`;
const authorization = () => ({paid_runs_enabled:true, budget_cap_usd:1,
  main_model:exactModel,fast_model:exactModel,thinking_level:'xhigh',allowed_models:[exactModel]});
const ledger = () => ({budget_cap_usd:1,confirmed_spend_usd:0.002482108,reserved_usd:0.03,
  reservations:[{run_id:'future-smoke',model:exactModel,status:'reserved',reserved_usd:0.03}]});
function authorize(config = authorization(), spending = ledger(), runId = 'future-smoke') {
  assert.equal(typeof smoke?.assertPaidRunAuthorized, 'function', 'paid authorization policy must exist');
  return smoke.assertPaidRunAuthorized(config, spending, {runId,maxSpendUsd:0.03});
}

test('free policy overrides unused historical budget and explicit request cap', () => {
  assert.throws(() => authorize({...authorization(),paid_runs_enabled:false}), /paid_runs_disabled/);
  assert.throws(() => authorize({...authorization(),execution_policy:'offline-only'}), /paid_runs_disabled/);
  assert.throws(() => authorize({...authorization(),paid_runs_enabled:'true'}), /paid_runs_disabled/);
});

test('paid smoke needs its own unique current reservation', () => {
  assert.equal(authorize(), undefined);
  assert.throws(() => authorize(authorization(),ledger(),'different-run'), /paid_reservation_invalid/);
  const reconciled=ledger();reconciled.reservations[0].status='reconciled';reconciled.reserved_usd=0;
  assert.throws(() => authorize(authorization(),reconciled), /paid_reservation_invalid/);
  const duplicate=ledger();duplicate.reservations.push({...duplicate.reservations[0]});duplicate.reserved_usd=0.06;
  assert.throws(() => authorize(authorization(),duplicate), /paid_reservation_invalid/);
});

test('paid policy rejects overcommitted or inconsistent ledger amounts', () => {
  assert.throws(() => authorize(authorization(),{...ledger(),confirmed_spend_usd:0.99}), /paid_budget_invalid/);
  assert.throws(() => authorize(authorization(),{...ledger(),reserved_usd:0.01}), /paid_budget_invalid/);
  assert.throws(() => authorize(authorization(),{...ledger(),budget_cap_usd:2}), /paid_budget_invalid/);
  assert.throws(() => authorize(authorization(),{...ledger(),confirmed_spend_usd:NaN}), /paid_budget_invalid/);
  const insufficient=ledger();insufficient.reserved_usd=0.02;insufficient.reservations[0].reserved_usd=0.02;
  assert.throws(() => authorize(authorization(),insufficient), /paid_reservation_invalid/);
});

test('paid policy preserves exclusive Muse model and xhigh selection', () => {
  assert.throws(() => authorize({...authorization(),main_model:'other/model'}), /paid_model_policy_invalid/);
  assert.throws(() => authorize({...authorization(),allowed_models:[exactModel,'other/model']}), /paid_model_policy_invalid/);
  assert.throws(() => authorize({...authorization(),thinking_level:'low'}), /paid_model_policy_invalid/);
  const changed=ledger();changed.reservations[0].model='other/model';
  assert.throws(() => authorize(authorization(),changed), /paid_reservation_invalid/);
});

test('free CLI refuses before credentials, SDK startup or filesystem run creation', () => {
  const directory=mkdtempSync(join(process.cwd(),'free-smoke-policy-'));
  const runId='must-not-start';
  try {
    mkdirSync(join(directory,'evals'));
    writeFileSync(join(directory,'evals','config.json'), JSON.stringify({paid_runs_enabled:false,budget_cap_usd:1}));
    const script=join(process.cwd(),'evals','micro','provider-smoke.mjs');
    const result=spawnSync(process.execPath,[script,'--run-id',runId,'--harness-commit','1'.repeat(40),
      '--max-spend-usd','0.02'],{cwd:directory,encoding:'utf8',env:{...process.env,OPENROUTER_API_KEY:''}});
    assert.equal(result.status,1);
    assert.equal(JSON.parse(result.stderr).error,'paid_runs_disabled');
    assert.equal(existsSync(join(directory,'runs')),false);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('conservative reservation covers all four maximum sized requests', () => {
  const bounded = guard();
  assert.equal(bounded.maxRequests, 4);
  assert.equal(bounded.maxPayloadBytes, 32768);
  assert.ok(Math.abs(bounded.reservedUpperBoundUsd - 0.0196608) < 1e-15);
  assert.equal(bounded.sentRequests, 0);
});

test('fifth physical send fails before transport and sends are counted on failed responses', async () => {
  const bounded = guard();
  let sends = 0;
  const send = bounded.wrapFetch(async () => { sends++; return new Response('failure', {status: 429}); });
  for (let i = 0; i < 4; i++) assert.equal((await send(...request())).status, 429);
  await assert.rejects(() => send(...request()), /request_limit/);
  assert.equal(sends, 4);
  assert.equal(bounded.sentRequests, 4);
  assert.deepEqual(bounded.blockedReasons, ['request_limit']);
});

test('six-request profile reserves its full bound and blocks the seventh send', async () => {
  const bounded = guard({maxRequests:6, maxSpendUsd:0.03});
  assert.equal(bounded.maxRequests, 6);
  assert.ok(Math.abs(bounded.reservedUpperBoundUsd - 0.0294912) < 1e-15);
  let sent = 0;
  const send = bounded.wrapFetch(async () => { sent++; return new Response(); });
  for (let i = 0; i < 6; i++) await send(...request());
  await assert.rejects(() => send(...request()), /request_limit/);
  assert.equal(sent, 6);
  assert.deepEqual(bounded.blockedReasons, ['request_limit']);
});

test('only authorized request profiles and their corresponding spend caps are accepted', () => {
  for (const maxRequests of [0,3,5,7,4.5,null,true,'6']) {
    assert.throws(() => guard({maxRequests, maxSpendUsd:0.03}), /request_profile_invalid/);
  }
  assert.throws(() => guard({maxRequests:4,maxSpendUsd:0.03}), /budget_invalid/);
  assert.throws(() => guard({maxRequests:6,maxSpendUsd:0.02}), /budget_insufficient/);
  assert.throws(() => guard({maxRequests:6,maxSpendUsd:0.030001}), /budget_invalid/);
});

test('CLI enforces profile and budget limits without credentials or provider calls', () => {
  const script = join(process.cwd(), 'evals', 'micro', 'provider-smoke.mjs');
  for (const [requests, budget, expected] of [['5','0.03','request_profile_invalid'],
    ['4','0.03','budget_invalid'], ['6','0.02','budget_insufficient']]) {
    const runId = `offline-cli-${requests}-${budget}-${randomUUID()}`;
    const result = spawnSync(process.execPath, [script, '--run-id', runId,
      '--harness-commit', '1111111111111111111111111111111111111111', '--max-requests', requests,
      '--max-spend-usd', budget, '--dry-run'], {encoding:'utf8'});
    try {
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr).error, expected);
    } finally { rmSync(join(process.cwd(), 'runs', 'model-smoke', runId), {recursive:true,force:true}); }
  }
});

test('guard records blocked reasons separately from the SDK connection-error text', async () => {
  const bounded = guard();
  const send = bounded.wrapFetch(async () => assert.fail('wrong model sent'));
  await assert.rejects(() => send(...request({...payload(),model:'wrong'})), /model_mismatch/);
  assert.deepEqual(bounded.blockedReasons, ['model_mismatch']);
  assert.equal(bounded.sentRequests, 0);
  assert.equal(typeof smoke?.classifySmokeFailure, 'function', 'explicit guard failure classifier must exist');
  assert.equal(smoke.classifySmokeFailure(null, [{stopReason:'error',errorMessage:'Connection error'}], bounded), 'model_mismatch');
  assert.equal(smoke.classifySmokeFailure(null, [{stopReason:'error',errorMessage:'private arbitrary provider text'}], guard()), 'native_session_failed');
  assert.equal(smoke.classifySmokeFailure('deadline_exceeded', [{stopReason:'error'}], bounded), 'deadline_exceeded');
});

test('model mismatch and fallback fields cannot reach transport', async () => {
  const bounded = guard();
  let sends = 0;
  const send = bounded.wrapFetch(async () => { sends++; return new Response(); });
  for (const body of [ {...payload(), model: 'some/other-model'},
    {...payload(), models: [model.id]}, {...payload(), route: 'fallback'},
    {...payload(), fallback: true}, {...payload(), fallbacks: [model.id]} ]) {
    await assert.rejects(() => send(...request(body)), /model_mismatch|fallback_forbidden/);
  }
  assert.equal(sends, 0);
});

test('UTF-8 byte cap rejects a multibyte payload before transport', async () => {
  const bounded = guard();
  const body = {...payload(), messages: [{role:'user', content:'€'.repeat(11000)}]};
  await assert.rejects(() => bounded.wrapFetch(async () => { assert.fail('oversize sent'); })(...request(body)), /payload_limit/);
  assert.equal(bounded.sentRequests, 0);
});

test('request body and endpoint are checked for both Request and URL inputs', async () => {
  const bounded = guard();
  const send = bounded.wrapFetch(async () => new Response('ok'));
  const [url, init] = request();
  assert.equal((await send(new Request(url, init))).status, 200);
  await assert.rejects(() => send('https://openrouter.ai/api/v1/generation', init), /endpoint_forbidden/);
  await assert.rejects(() => send(url, {...init, method:'GET'}), /endpoint_forbidden/);
  await assert.rejects(() => send(url, {...init, body:'{'}), /payload_invalid/);
  await assert.rejects(() => send(...request({...payload(), max_tokens:6145})), /output_limit/);
  await assert.rejects(() => send(...request({...payload(), stream_options:{include_usage:false}})), /usage_required/);
  assert.equal(bounded.sentRequests, 1);
});

test('missing budget, larger authorization, unsupported model and unknown prices fail closed', () => {
  for (const maxSpendUsd of [undefined, NaN, -1, 0, 0.01, 0.020001]) {
    assert.throws(() => guard({maxSpendUsd}), /budget_invalid|budget_insufficient/);
  }
  assert.throws(() => guard({model:{...model, id:'meta/other'}}), /model_mismatch/);
  assert.throws(() => guard({model:{...model, api:'other-api'}}), /model_mismatch/);
  assert.throws(() => guard({model:{...model, cost:{...model.cost,input:null}}}), /catalog_price_unknown/);
});

test('response identity is restricted to requested slug and official canonical slug', () => {
  const bounded = guard();
  bounded.observeResponseModel(model.id);
  bounded.observeResponseModel('meta/muse-spark-1.3-contributor-20260902');
  assert.throws(() => bounded.observeResponseModel('meta/unrequested'), /response_model_mismatch/);
  assert.throws(() => bounded.observeResponseModel(''), /response_model_mismatch/);
  assert.deepEqual(bounded.responseModels, [model.id, 'meta/muse-spark-1.3-contributor-20260902']);
});

test('payload preflight validates independently and never counts an unsent request', () => {
  const bounded = guard();
  assert.equal(bounded.validatePayload(payload()), undefined);
  assert.throws(() => bounded.validatePayload({...payload(), model:'wrong'}), /model_mismatch/);
  assert.equal(bounded.sentRequests, 0);
});

test('payload thinking downgrade is rejected before any physical request', async () => {
  const bounded = guard();
  const send = bounded.wrapFetch(async () => { assert.fail('downgraded thinking sent'); });
  for (const reasoning of [undefined, {effort:'low'}, {effort:'high'}, {effort:'none'}]) {
    await assert.rejects(() => send(...request({...payload(), reasoning})), /thinking_effort_mismatch/);
  }
  assert.equal(bounded.sentRequests, 0);
});

test('redirects are denied for URL, string and Request inputs even if caller requests follow', async () => {
  const bounded = guard();
  const redirects = [];
  const send = bounded.wrapFetch(async (_input, options) => {
    redirects.push(options.redirect);
    return new Response();
  });
  const [url, init] = request();
  await send(url, {...init, redirect:'follow'});
  await send(new URL(url), {...init, redirect:'follow'});
  await send(new Request(url, {...init, redirect:'follow'}), {redirect:'follow'});
  assert.deepEqual(redirects, ['error','error','error']);
  assert.equal(bounded.sentRequests, 3);
});

function evaluate(events, guardOverrides = {}, assistants = [{stopReason:'stop'}]) {
  assert.equal(typeof smoke?.evaluateSmokeFixture, 'function', 'fixture verification evaluator must exist');
  const directory = mkdtempSync(join(process.cwd(), 'provider-smoke-check-'));
  try {
    writeFileSync(join(directory, 'sample.txt'), 'alpha\ndelta\ngamma\n');
    writeFileSync(join(directory, 'summary.json'), '{"lines":3,"second":"delta"}');
    return smoke.evaluateSmokeFixture(directory, events, assistants, {
      responseModels:[model.id], sentRequests:4, maxRequests:4, ...guardOverrides,
    }, null);
  } finally { rmSync(directory, {recursive:true}); }
}

const toolEnd = (toolName, toolCallId, isError = false) => ({type:'tool_execution_end', toolName, toolCallId, isError});
const bashStart = (toolCallId, command) => ({type:'tool_execution_start', toolName:'bash', toolCallId, args:{command}});

test('successful echo cannot count as fixture verification', () => {
  const result = evaluate([toolEnd('read','r'), toolEnd('edit','e'), toolEnd('write','w'),
    bashStart('b','echo verified'), toolEnd('bash','b')]);
  assert.equal(result.bash_verification_succeeded, false);
  assert.equal(result.bash_after_changes, false);
});

test('fixture completion rejects a final error and honors six-request policy', () => {
  const result = evaluate([], {maxRequests:6,sentRequests:6}, [{stopReason:'error'}]);
  assert.equal(result.native_session_completed, false);
  assert.equal(result.request_limit_observed, true);
});

test('exact successful verification requires both edits before that bash start', () => {
  const result = evaluate([toolEnd('read','r'), toolEnd('write','w'),
    bashStart('b', smoke?.VERIFICATION_COMMAND), toolEnd('bash','b'), toolEnd('edit','e')]);
  assert.equal(result.bash_verification_succeeded, true);
  assert.equal(result.bash_after_changes, false);
});

test('later genuine verification is recognized after an unrelated earlier bash', () => {
  const result = evaluate([bashStart('early','echo hello'), toolEnd('bash','early'),
    toolEnd('read','r'), toolEnd('edit','e'), toolEnd('write','w'),
    bashStart('b', smoke?.VERIFICATION_COMMAND), toolEnd('bash','b')]);
  assert.equal(result.bash_verification_succeeded, true);
  assert.equal(result.bash_after_changes, true);
  assert.equal(Object.values(result).every(Boolean), true);
});

test('reported reasoning sums billable responses and excludes an unsent guard error', () => {
  assert.equal(typeof smoke?.summarizeReportedReasoning, 'function', 'reported reasoning summary must exist');
  const messages = [{responseId:'one',usage:{input:5,output:9}}, {responseId:'two',usage:{input:4,output:5}},
    {stopReason:'error',usage:{input:0,output:0,cacheRead:0,cacheWrite:0}}];
  const reported = new Map([['one',7],['two',3]]);
  assert.deepEqual(smoke.summarizeReportedReasoning(messages, reported, 2), {
    thinking_tokens:10, reasoning_reporting_complete:true, reasoning_included_in_output:true,
  });
  reported.delete('two');
  assert.equal(smoke.summarizeReportedReasoning(messages, reported, 2).thinking_tokens, null);
  assert.equal(smoke.summarizeReportedReasoning(messages, reported, 2).reasoning_reporting_complete, false);
  assert.equal(smoke.summarizeReportedReasoning(messages, new Map([['one',7],['two',3]]), 3).thinking_tokens, null,
    'a sent request without a reported assistant stays unknown');
});

test('provider credential echoes are sanitized before native session persistence without losing usage or IDs', async () => {
  assert.equal(typeof smoke?.redactProviderStream, 'function', 'stream redaction boundary must exist');
  const fakeCredential = 'test-only-fake-credential';
  const message = {role:'assistant', api:'openai-completions', provider:model.provider, model:model.id,
    responseId:'gen-offline-error', responseModel:'meta/muse-spark-1.3-contributor-20260902', timestamp:1,
    content:[{type:'text', text:`provider metadata: Bearer ${fakeCredential}`}],
    errorMessage:`401 rejected ${fakeCredential}; metadata {"token":"${fakeCredential}"}`,
    stopReason:'error', usage:{input:3, output:1, cacheRead:2, cacheWrite:0, totalTokens:6,
      cost:{input:0.0000003,output:0.0000002,cacheRead:0.000000004,cacheWrite:0,total:0.000000504}}};
  const source = {
    async *[Symbol.asyncIterator]() { yield {type:'start', partial:message}; yield {type:'error', reason:'error', error:message}; },
    async result() { return message; },
  };
  const wrapped = smoke.redactProviderStream(source, fakeCredential);
  const events = [];
  for await (const event of wrapped) events.push(event);
  const result = await wrapped.result();
  assert.equal(JSON.stringify(events).includes(fakeCredential), false);
  assert.equal(JSON.stringify(result).includes(fakeCredential), false);
  assert.match(result.errorMessage, /<redacted-api-key>/);
  assert.equal(result.responseId, message.responseId);
  assert.equal(result.responseModel, message.responseModel);
  assert.deepEqual(result.usage, message.usage);
  assert.equal(result.stopReason, 'error');
  assert.equal(message.errorMessage.includes(fakeCredential), true, 'provider-owned objects stay untouched');
  message.errorMessage = `later mutable error ${fakeCredential}`;
  assert.equal(events[0].partial.errorMessage.startsWith('later'), false, 'agent receives detached partials');
  const directory = mkdtempSync(join(process.cwd(), 'provider-smoke-persist-'));
  try {
    const {SessionManager} = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.create(directory, join(directory, 'sessions'));
    manager.appendMessage({role:'user', content:[{type:'text',text:'synthetic fixture'}], timestamp:0});
    manager.appendMessage(result);
    const originalNativeFile = readFileSync(manager.getSessionFile(), 'utf8');
    assert.equal(originalNativeFile.includes(fakeCredential), false);
    assert.match(originalNativeFile, /gen-offline-error/);
    assert.match(originalNativeFile, /redacted-api-key/);
  } finally { rmSync(directory, {recursive:true}); }
});
