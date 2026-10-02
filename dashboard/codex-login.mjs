import {randomBytes} from 'node:crypto';
import {CredentialSynchronizationError} from '@earendil-works/pi-coding-agent';

// Pi owns PKCE, the localhost callback, token exchange, locked persistence and refresh.
// This controller exposes only login progress and credential metadata to the dashboard.
export class CodexLogin {
  constructor(runtime) {
    this.runtime = runtime;
    this.state = {phase: 'idle', message: ''};
    this.flow = null;
  }

  async status() {
    try {
      const credentials = await this.runtime.listCredentials({signal: AbortSignal.timeout(10000)});
      return {...this.state, signedIn: credentials.some(c => c.providerId === 'openai-codex' && c.type === 'oauth')};
    } catch {
      return {...this.state, signedIn: false, message: 'Apex could not read the saved Codex login. Check permissions on the agent-profile folder.'};
    }
  }

  async start() {
    if (this.flow) return this.status(); // one callback listener and login attempt per dashboard
    const controller = new AbortController();
    const flow = {id: randomBytes(16).toString('hex'), controller, prompt: null};
    this.flow = flow;
    this.state = {id: flow.id, phase: 'waiting', message: 'Opening OpenAI sign-in…'};
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    timer.unref();
    flow.done = this.runtime.login('openai-codex', 'oauth', {
      signal: controller.signal,
      notify: event => {
        if (this.flow !== flow || controller.signal.aborted) return;
        if (event.type === 'auth_url') {
          const url = new URL(event.url);
          if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize') throw new Error('Unexpected sign-in URL');
          this.state.url = url.href;
          this.state.message = 'Finish signing in on OpenAI. Your login will be saved automatically.';
        }
      },
      prompt: prompt => {
        if (prompt.type === 'select') {
          if (!prompt.options.some(option => option.id === 'browser')) throw new Error('Browser login is unavailable');
          return Promise.resolve('browser');
        }
        if (prompt.type !== 'manual_code') throw new Error('Unexpected sign-in prompt');
        return new Promise((resolve, reject) => {
          const signals = [controller.signal, prompt.signal].filter(Boolean);
          const cleanup = () => {
            for (const signal of signals) signal.removeEventListener('abort', abort);
            flow.prompt = null;
            delete this.state.prompt;
          };
          const abort = () => { cleanup(); reject(new Error('Login cancelled')); };
          flow.prompt = value => { cleanup(); resolve(value); };
          this.state.prompt = {message: 'If OpenAI does not return automatically, paste the full callback URL here.'};
          for (const signal of signals) signal.addEventListener('abort', abort, {once: true});
          if (signals.some(signal => signal.aborted)) abort();
        });
      },
    }).then(() => {
      this.state = {phase: 'saved', message: 'Codex login saved. You can send or retry your message.'};
    }, error => {
      // SDK errors can contain token-response bodies. Never forward them to the browser or logs.
      this.state = error instanceof CredentialSynchronizationError
        ? {phase: 'saved', message: 'Codex login saved. You can send or retry your message.'}
        : controller.signal.aborted
          ? {phase: 'idle', message: 'Sign-in cancelled or timed out. Any previously saved login is unchanged.'}
          : {phase: 'error', message: 'Codex sign-in failed. Start again and complete the OpenAI login; paste the full callback URL if automatic return fails.'};
    }).finally(() => {
      clearTimeout(timer);
      this.flow = null;
    });
    return this.status();
  }

  respond(id, value) {
    const flow = this.flow;
    if (!flow || flow.id !== id || !flow.prompt || flow.controller.signal.aborted) throw new Error('That sign-in prompt is no longer active. Start a new sign-in.');
    let url;
    try { url = new URL(value); } catch { throw new Error('Paste the full localhost callback URL, not an API key or password.'); }
    if (url.origin !== 'http://localhost:1455' || url.pathname !== '/auth/callback' || !url.searchParams.get('code')) throw new Error('Paste the full http://localhost:1455/auth/callback URL from OpenAI.');
    const expectedState = new URL(this.state.url).searchParams.get('state');
    if (!expectedState || url.searchParams.get('state') !== expectedState) throw new Error('This callback belongs to a different sign-in attempt. Use the latest OpenAI login page.');
    flow.prompt(url.href);
  }

  async cancel(id) {
    if (this.flow && this.flow.id === id) {
      this.flow.controller.abort();
      await this.flow.done;
    }
    return this.status();
  }
}
