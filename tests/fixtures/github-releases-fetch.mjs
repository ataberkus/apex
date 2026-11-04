// Bun preload for dashboard/server.mjs in tests: api.github.com answers from the file named by APEX_TEST_GITHUB, read on
// every request so a test can switch answers ("fail" rejects like an unreachable network; anything else is the JSON
// body of the releases list). Each GitHub request appends a line to APEX_TEST_GITHUB_LOG; other non-loopback requests fail.
import {appendFileSync, readFileSync} from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'api.github.com') {
    appendFileSync(process.env.APEX_TEST_GITHUB_LOG, url.pathname + '\n');
    const answer = readFileSync(process.env.APEX_TEST_GITHUB, 'utf8');
    if (answer === 'fail') throw new TypeError('fetch failed');
    return new Response(answer, {status: 200, headers: {'content-type': 'application/json'}});
  }
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return realFetch(input, init);
  throw new Error(`Blocked test request to ${url.origin}`);
};
