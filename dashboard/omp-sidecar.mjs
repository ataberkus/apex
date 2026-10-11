// Runs under Bun, started by provider-login.mjs: oh-my-pi's Claude sign-in, token refresh and subscription usage
// ship as Bun-only TypeScript, so Node cannot import them. One JSON object per line on stdin/stdout.
// Errors report only their class name: oh-my-pi messages can quote token-response bodies.
import {createInterface} from 'node:readline';
import {getProviderDefinition} from '@oh-my-pi/pi-ai/registry/registry';
import {resolveUsedFraction} from '@oh-my-pi/pi-ai/usage';
import {defaultUsageProvider} from '@oh-my-pi/pi-ai/usage/registry';

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const controller = new AbortController(); // the Node side ends stdin to cancel
const manual = [];
let receive;
const input = new Promise(resolve => { receive = resolve; });
createInterface({input: process.stdin})
  .on('line', line => { const message = JSON.parse(line); if (message.type === 'code') manual.shift()?.(message.value); else receive(message); })
  .on('close', () => controller.abort());

const claude = getProviderDefinition('anthropic');
const ops = {
  login: () => claude.login({
    signal: controller.signal,
    onAuth: ({url, instructions}) => send({type: 'auth', url, instructions}),
    onProgress: message => send({type: 'progress', message}),
    onManualCodeInput: () => new Promise(resolve => { manual.push(resolve); send({type: 'manual'}); }),
  }),
  refresh: async () => claude.refreshToken((await input).credentials, controller.signal),
  // The same windows and resets omp's /usage shows; the raw provider payload stays here.
  usage: async () => {
    const {provider, access} = await input;
    const usage = defaultUsageProvider(provider);
    const params = {provider, credential: {type: 'oauth', accessToken: access}, signal: controller.signal};
    if (!usage || usage.supports?.(params) === false) return null;
    const report = await usage.fetchUsage(params, {fetch});
    return report && report.limits.map(limit => ({label: limit.label, used: resolveUsedFraction(limit), resetsAt: limit.window?.resetsAt}));
  },
};

let outcome;
try {
  outcome = {type: 'done', result: await ops[process.argv[2]]()};
} catch (error) {
  outcome = {type: 'error', name: error?.name ?? 'Error'};
}
process.stdout.write(`${JSON.stringify(outcome)}\n`, () => process.exit(0)); // exit even if a listener lingers
