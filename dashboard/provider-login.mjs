import {randomBytes} from 'node:crypto';
import {CredentialSynchronizationError} from '@earendil-works/pi-coding-agent';

// Providers the dashboard can sign in to. OAuth entries name the only sign-in page and callback Apex will accept;
// `code` providers also show a code#state on their own page when the localhost return fails.
export const LOGINS = {
  'openai-codex': {label: 'Codex', site: 'OpenAI', account: 'ChatGPT', type: 'oauth',
    authorize: 'https://auth.openai.com/oauth/authorize', callback: 'http://localhost:1455/auth/callback'},
  anthropic: {label: 'Claude', site: 'Claude', account: 'Claude Pro or Max', type: 'oauth', code: true,
    authorize: 'https://claude.ai/oauth/authorize', callback: 'http://localhost:53692/callback'},
  'opencode-go': {label: 'OpenCode Go', site: 'OpenCode', account: 'OpenCode Go', type: 'api_key', env: ['OPENCODE_API_KEY']},
};

const unreadable = config => `Apex could not read the saved ${config.label} login. Check permissions on the agent-profile folder.`;

async function savedLogin(runtime, id, type) {
  const credentials = await runtime.listCredentials({signal: AbortSignal.timeout(10000)});
  return credentials.some(c => c.providerId === id && c.type === type);
}

// Pi owns PKCE, the localhost callback, token exchange, locked persistence and refresh.
// This controller exposes only login progress and credential metadata to the dashboard.
export class OAuthLogin {
  constructor(runtime, id) {
    this.runtime = runtime;
    this.id = id;
    this.config = LOGINS[id];
    this.state = {phase: 'idle', message: ''};
    this.flow = null;
  }

  async status() {
    try {
      return {...this.state, signedIn: await savedLogin(this.runtime, this.id, 'oauth')};
    } catch {
      return {...this.state, signedIn: false, message: unreadable(this.config)};
    }
  }

  async start() {
    if (this.flow) return this.status(); // one callback listener and login attempt per provider
    const {label, site, authorize} = this.config;
    const saved = `${label} login saved. You can send or retry your message.`;
    const controller = new AbortController();
    const flow = {id: randomBytes(16).toString('hex'), controller, prompt: null};
    this.flow = flow;
    this.state = {id: flow.id, phase: 'waiting', message: `Opening ${site} sign-in…`};
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    timer.unref();
    flow.done = this.runtime.login(this.id, 'oauth', {
      signal: controller.signal,
      notify: event => {
        if (this.flow !== flow || controller.signal.aborted) return;
        if (event.type === 'auth_url') {
          const url = new URL(event.url);
          if (url.origin + url.pathname !== authorize) throw new Error('Unexpected sign-in URL');
          this.state.url = url.href;
          this.state.message = `Finish signing in on ${site}. Your login will be saved automatically.`;
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
          this.state.prompt = {code: Boolean(this.config.code), callback: this.config.callback,
            message: this.config.code ? `If ${site} shows a code instead of returning automatically, paste that code here.` : `If ${site} does not return automatically, paste the full callback URL here.`};
          for (const signal of signals) signal.addEventListener('abort', abort, {once: true});
          if (signals.some(signal => signal.aborted)) abort();
        });
      },
    }).then(() => {
      this.state = {phase: 'saved', message: saved};
    }, error => {
      // SDK errors can contain token-response bodies. Never forward them to the browser or logs.
      this.state = error instanceof CredentialSynchronizationError
        ? {phase: 'saved', message: saved}
        : controller.signal.aborted
          ? {phase: 'idle', message: 'Sign-in cancelled or timed out. Any previously saved login is unchanged.'}
          : {phase: 'error', message: `${label} sign-in failed. Start again and complete the ${site} login; paste the ${this.config.code ? 'code' : 'full callback URL'} if automatic return fails.`};
    }).finally(() => {
      clearTimeout(timer);
      this.flow = null;
    });
    return this.status();
  }

  respond(id, value) {
    const flow = this.flow;
    if (!flow || flow.id !== id || !flow.prompt || flow.controller.signal.aborted) throw new Error('That sign-in prompt is no longer active. Start a new sign-in.');
    const {site, callback, code} = this.config;
    const expectedState = new URL(this.state.url).searchParams.get('state');
    let url, state;
    try { url = new URL(value); } catch { /* maybe a code#state */ }
    if (url) {
      if (url.origin + url.pathname !== callback || !url.searchParams.get('code')) throw new Error(`Paste the full ${callback} URL from ${site}.`);
      state = url.searchParams.get('state');
    } else {
      const [pasted, pastedState, extra] = value.split('#');
      if (!code || !pasted || !pastedState || extra !== undefined || /\s/.test(value)) {
        throw new Error(code ? `Paste the code from ${site} or the full localhost callback URL, not an API key or password.` : 'Paste the full localhost callback URL, not an API key or password.');
      }
      state = pastedState;
    }
    if (!expectedState || state !== expectedState) throw new Error(`This ${url ? 'callback' : 'code'} belongs to a different sign-in attempt. Use the latest ${site} login page.`);
    flow.prompt(url ? url.href : value);
  }

  async cancel(id) {
    if (this.flow && this.flow.id === id) {
      this.flow.controller.abort();
      await this.flow.done;
    }
    return this.status();
  }

  async logout() {
    if (this.flow) await this.cancel(this.flow.id);
    await this.runtime.logout(this.id, {signal: AbortSignal.timeout(10000)}).catch(error => { if (!(error instanceof CredentialSynchronizationError)) throw new Error(`Apex could not remove the saved ${this.config.label} login.`); });
    this.state = {phase: 'idle', message: `${this.config.label} login removed from this computer.`};
    return this.status();
  }
}

// API-key providers: Pi stores the key in the same locked auth file. The key never travels back to the browser.
export class ApiKeyLogin {
  constructor(runtime, id) {
    this.runtime = runtime;
    this.id = id;
    this.config = LOGINS[id];
    this.state = {phase: 'idle', message: ''};
  }

  async status() {
    const fromEnv = this.config.env.some(name => process.env[name]);
    try {
      const stored = await savedLogin(this.runtime, this.id, 'api_key');
      return {...this.state, signedIn: stored || fromEnv, source: stored ? 'saved' : fromEnv ? 'environment' : undefined};
    } catch {
      return {...this.state, signedIn: fromEnv, message: unreadable(this.config)};
    }
  }

  async save(value) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!/^\S{8,512}$/.test(key)) throw new Error(`Paste the ${this.config.label} API key. It is one line with no spaces.`);
    const {label} = this.config;
    try {
      await this.runtime.login(this.id, 'api_key', {
        signal: AbortSignal.timeout(10000),
        notify: () => {},
        prompt: prompt => prompt.type === 'secret' ? Promise.resolve(key) : Promise.reject(new Error('Unexpected sign-in prompt')),
      });
      this.state = {phase: 'saved', message: `${label} key saved. You can send or retry your message.`};
    } catch (error) {
      // Never echo the key or an SDK message that might contain it.
      this.state = error instanceof CredentialSynchronizationError
        ? {phase: 'saved', message: `${label} key saved. You can send or retry your message.`}
        : {phase: 'error', message: `Apex could not save the ${label} key. Check permissions on the agent-profile folder.`};
    }
    return this.status();
  }

  async logout() {
    await this.runtime.logout(this.id, {signal: AbortSignal.timeout(10000)}).catch(error => { if (!(error instanceof CredentialSynchronizationError)) throw new Error(`Apex could not remove the saved ${this.config.label} key.`); });
    this.state = {phase: 'idle', message: `${this.config.label} key removed from this computer.`};
    return this.status();
  }
}

export const createLogins = runtime => Object.fromEntries(Object.entries(LOGINS).map(([id, config]) =>
  [id, config.type === 'oauth' ? new OAuthLogin(runtime, id) : new ApiKeyLogin(runtime, id)]));
