import assert from 'node:assert/strict';
import test from 'node:test';
import {createWindowsGuard, PROFILE} from '../evals/micro/windows-live.mjs';

const model={provider:PROFILE.provider,id:PROFILE.model,api:'anthropic-messages',baseUrl:'https://api.anthropic.com',thinkingLevelMap:{medium:'medium'},maxTokens:128000,cost:{input:4,output:20,cacheRead:0.2,cacheWrite:5}};
const payload=()=>({model:PROFILE.model,stream:true,max_tokens:PROFILE.maxOutputTokens,thinking:{type:'adaptive'},messages:[{role:'user',content:'x'},{role:'system',content:[],output_config:{effort:PROFILE.thinking}}]});
const request=value=>[`${PROFILE.endpoint}?beta=true`,{method:'POST',body:JSON.stringify(value??payload())}];
const guard=options=>createWindowsGuard(model,options);
const usage={input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0};

test('HTTP failures consume physical sends and a retry beyond the bound never reaches transport',async()=>{
  const bounded=guard({profile:{...PROFILE,maxRequests:2}}),signal=new AbortController().signal;
  let calls=0;
  const send=bounded.wrapFetch(async(_input,options)=>{calls++;assert.equal(options.redirect,'error');return new Response('limited',{status:429});},signal);
  await send(...request());await send(...request());
  await assert.rejects(send(...request()),/request_limit/);
  assert.equal(calls,2);assert.equal(bounded.sends.length,2);
});

test('wrong endpoint, model, thinking, unbounded output and overlarge payload are denied before sending',async()=>{
  let sends=0;
  for(const [input,options,reason] of [
    ['https://elsewhere.invalid/v1/messages',{method:'POST',body:JSON.stringify(payload())},/endpoint_forbidden/],
    [`${PROFILE.endpoint}?other=1`,{method:'POST',body:JSON.stringify(payload())},/endpoint_forbidden/],
    [...request({...payload(),model:'other'}),/payload_model_thinking_mismatch/],
    [...request({...payload(),messages:[{role:'system',content:[],output_config:{effort:'high'}}]}),/payload_model_thinking_mismatch/],
    [...request({...payload(),fallbacks:[]}),/fallback_or_unsupported_parameter/],
    [...request({...payload(),max_tokens:model.maxTokens}),/output_bound_missing/],
    [...request({...payload(),system:'x'.repeat(PROFILE.maxPayloadBytes)}),/payload_limit/],
  ]) {
    await assert.rejects(guard().wrapFetch(async()=>{sends++;},new AbortController().signal)(input,options),reason);
  }
  assert.equal(sends,0);
});

test('the payload hook lowers max_tokens to the guard bound',()=>{
  assert.equal(guard().payload({...payload(),max_tokens:model.maxTokens}).max_tokens,PROFILE.maxOutputTokens);
});

test('a send whose worst case would pass the run cap never reaches transport; reported usage releases the worst case',async()=>{
  const body={...payload(),system:'y'.repeat(500)};
  const worst=(Buffer.byteLength(JSON.stringify(body))*model.cost.cacheWrite+PROFILE.maxOutputTokens*model.cost.output)/1e6;
  const capped=guard({profile:{...PROFILE,runCapUsd:worst*1.5}});
  let calls=0;
  const send=capped.wrapFetch(async()=>{calls++;return new Response('ok');},new AbortController().signal);
  await send(...request(body));
  await assert.rejects(send(...request(body)),/run_cap_exceeded/,'the unreported first send still counts at its worst case');
  capped.observe({type:'message_start',message:{id:'m1',model:PROFILE.model,usage}});capped.observe({type:'message_stop'});
  await send(...request(body));
  assert.equal(calls,2);assert.ok(capped.cost()>0);
});

test('deadline and reported usage boundaries fail closed',async()=>{
  const expired=guard({started:Date.now()-PROFILE.deadlineMs-1});
  await assert.rejects(expired.wrapFetch(async()=>assert.fail('sent after deadline'),new AbortController().signal)(...request()),/deadline_exceeded/);
  const over=guard();over.observe({type:'message_start',message:{id:'m',model:PROFILE.model,usage}});
  over.observe({type:'message_delta',usage:{output_tokens:PROFILE.maxOutputTokens+1}});
  assert.throws(()=>over.observe({type:'message_stop'}),/response_usage_bound/);
  assert.throws(()=>guard().observe({type:'message_start',message:{id:'m',model:'claude-other',usage}}),/response_model_mismatch/);
  const partial=guard();partial.observe({type:'message_start',message:{id:'m',model:PROFILE.model,usage}});
  assert.equal(partial.responses.get('m').complete,false,'a stream without message_stop is incomplete usage');
});
