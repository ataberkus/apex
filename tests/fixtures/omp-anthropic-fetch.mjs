// Bun preload for dashboard/omp-sidecar.mjs in tests (via BUN_OPTIONS): oh-my-pi's api.anthropic.com requests go to the
// test's local fixture server named by APEX_TEST_ANTHROPIC; every other non-loopback request fails, so no real Claude call is made.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'api.anthropic.com') return realFetch(new URL(url.pathname + url.search, process.env.APEX_TEST_ANTHROPIC), init);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return realFetch(input, init);
  return Promise.reject(new Error(`Blocked test request to ${url.origin}`));
};
