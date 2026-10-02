import assert from 'node:assert/strict';
import test from 'node:test';
import {zstdCompressSync} from 'node:zlib';
import {createWindowsGuard, PROFILE} from '../evals/micro/windows-live.mjs';

const model={provider:PROFILE.provider,id:PROFILE.model,api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api',thinkingLevelMap:{xhigh:'xhigh'},maxTokens:128000,cost:{input:1.2,output:8,cacheRead:0.12,cacheWrite:0}};
const payload=()=>({model:PROFILE.model,stream:true,store:false,reasoning:{effort:'xhigh'},input:[]});
const request=value=>[PROFILE.endpoint,{method:'POST',body:JSON.stringify(value??payload())}];
const guard=options=>createWindowsGuard(model,options);

test('HTTP failures consume physical sends and a retry beyond the bound never reaches transport',async()=>{
  const bounded=guard({profile:{...PROFILE,maxRequests:2}}),signal=new AbortController().signal;
  let calls=0;
  const send=bounded.wrapFetch(async(_input,options)=>{calls++;assert.equal(options.redirect,'error');return new Response('limited',{status:429});},signal);
  await send(...request());await send(...request());
  await assert.rejects(send(...request()),/request_limit/);
  assert.equal(calls,2);assert.equal(bounded.sends.length,2);
});

test('wrong endpoint, model, thinking and overlarge uncompressed payload are denied before sending',async()=>{
  let sends=0;
  for(const [input,options,reason] of [
    ['https://elsewhere.invalid',{method:'POST',body:JSON.stringify(payload())},/endpoint_forbidden/],
    [...request({...payload(),model:'other'}),/payload_model_thinking_mismatch/],
    [...request({...payload(),reasoning:{effort:'low'}}),/payload_model_thinking_mismatch/],
    [...request({...payload(),fallbacks:[]}),/fallback_or_unsupported_parameter/],
    [...request({...payload(),input:['x'.repeat(PROFILE.maxPayloadBytes)]}),/payload_limit/],
  ]) {
    await assert.rejects(guard().wrapFetch(async()=>{sends++;},new AbortController().signal)(input,options),reason);
  }
  assert.equal(sends,0);
});

test('compressed wire body cannot bypass the full payload reservation limit',async()=>{
  const body=zstdCompressSync(Buffer.from(JSON.stringify({...payload(),input:['x'.repeat(PROFILE.maxPayloadBytes)]})));
  let sends=0;
  await assert.rejects(guard().wrapFetch(async()=>{sends++;},new AbortController().signal)(PROFILE.endpoint,{method:'POST',headers:{'content-encoding':'zstd'},body}),/payload_compression_invalid/);
  assert.equal(sends,0);
});

test('deadline and reported output/total usage boundaries fail closed',async()=>{
  const expired=guard({started:Date.now()-PROFILE.deadlineMs-1});
  await assert.rejects(expired.wrapFetch(async()=>assert.fail('sent after deadline'),new AbortController().signal)(...request()),/deadline_exceeded/);
  assert.throws(()=>guard().observe({type:'response.completed',response:{id:'r',model:PROFILE.model,usage:{input_tokens:1,output_tokens:model.maxTokens+1,total_tokens:model.maxTokens+2}}}),/response_usage_bound/);
  assert.throws(()=>guard().observe({type:'response.completed',response:{id:'r',model:PROFILE.model,usage:{input_tokens:1,output_tokens:1,total_tokens:3}}}),/response_usage_bound/);
  const incomplete=guard();incomplete.observe({type:'response.completed',response:{id:'r',model:PROFILE.model}});
  assert.equal(incomplete.responses.get('r').usage,null);
  incomplete.observe({type:'response.completed',response:{id:'zero',model:PROFILE.model,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}});
  assert.equal(incomplete.responses.get('zero').usage,null);
});
