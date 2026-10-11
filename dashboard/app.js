import {renderMarkdown, renderMessage, renderThought} from './chat-content.mjs';
import {fileImageType, imageDataUrl, validateImages, IMAGE_TYPES, IMAGE_HELP, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES} from './attachments.mjs';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const post = (path, body) => fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
  .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; });
const ago = ms => { const m = Math.max(0, (Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? Math.round(m) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const base = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
const usd = n => '$' + (n < 0.1 ? n.toFixed(4) : n.toFixed(2));
const until = ms => { const m = Math.max(0, (ms - Date.now()) / 60000); return m < 60 ? Math.round(m) + ' min' : m < 1440 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'; };
const dur = ms => { const s = ms / 1000; return s < 60 ? s.toFixed(1) + 's' : s < 3600 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60 % 60)}m`; };
const percent = limit => limit.used == null ? 'unknown' : Math.round(limit.used * 100) + '% used';
// Subscription windows from oh-my-pi's usage providers, the same rows omp's /usage shows.
const usageRows = () => Object.values(state.usage ?? {});
const limitName = (p, l) => l.label.startsWith(p.label + ' ') ? l.label.slice(p.label.length + 1) : l.label; // "Claude 5 Hour" under Claude
const stored = (key, fallback) => { try { return JSON.parse(localStorage[key]) ?? fallback; } catch { return fallback; } };

let state = {workspaces: [], models: [], groups: []}, stateSig = '', sel = null, source = null, current = null, activity = null;
let tools = new Map(), toolArgs = new Map(), view = newView(), seen = stored('seen', {}), collapsed = stored('collapsed', {}), asksSig = '';
const drafts = new Map(), pendingRender = new Map();
let markdownTimer = 0;
const sessionDraft = id => { if (!drafts.has(id)) drafts.set(id, {message: '', images: [], reading: 0, sending: false, error: ''}); return drafts.get(id); };
const enhance = new Map(); // session id → {id, original, model, step} while a run is active
const enhanced = new Map(); // session id → {original, text}: a result that finished while another session was open
const enhanceBlocked = text => !text.trim() || /^[/!]/.test(text.trim());
const modelLabel = id => state.models.find(m => m.id === id)?.label ?? id ?? '';

/* model routes: one model, or a planning model and a build model, each at its own thinking level */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PAIR = 'apex/pair'; // a session's model while its plan + build pair is routing
const modelById = id => state.models.find(m => m.id === id);
const levelsOf = m => m?.levels ?? state.thinking ?? LEVELS;
const rank = level => LEVELS.indexOf(level);
const nearest = (levels, want) => levels.includes(want) ? want : levels.reduce((best, l) => Math.abs(rank(l) - rank(want)) < Math.abs(rank(best) - rank(want)) ? l : best, levels[0]);
const pairable = m => Boolean(m?.target && m.apex); // pairs run through the Windows target on saved logins
const shortName = id => (modelById(id)?.label ?? id ?? '').replace(/^Claude /, '').replace(/ \(latest\)$/, '');
const contextWords = n => !n ? '' : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M context` : `${Math.round(n / 1000)}k context`;
const routeOf = s => s.model === PAIR && s.pair ? {mode: 'pair', plan: {...s.pair.plan}, build: {model: s.pair.build.model, thinking: s.thinking}} : {mode: 'single', model: s.model, thinking: s.thinking};
const sameRoute = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const samePair = (route, pair) => Boolean(pair) && route.plan.model === pair.plan.model && route.plan.thinking === pair.plan.thinking && route.build.model === pair.build.model;
function routeWords(s, levels = true) {
  const r = routeOf(s);
  if (r.mode === 'single') return shortName(r.model) + (levels ? ' ' + r.thinking : '');
  return levels ? `${shortName(r.plan.model)} ${r.plan.thinking} plans, ${shortName(r.build.model)} ${r.build.thinking} builds` : `${shortName(r.plan.model)} and ${shortName(r.build.model)}`;
}
const recentModels = () => stored('recentModels', []);
// Favorites are per browser: catalog ids in localStorage, ignored once a model leaves the catalog.
const favoriteModels = () => { const ids = stored('favorites', []); return Array.isArray(ids) ? ids.filter(id => modelById(id)) : []; };
function toggleFavorite(id) {
  const ids = favoriteModels(), next = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
  try { localStorage.favorites = JSON.stringify(next); } catch { /* without storage there are no favorites */ }
}
function rememberModels(r) {
  const ids = r.mode === 'pair' ? [r.plan.model, r.build.model] : [r.model];
  try { localStorage.recentModels = JSON.stringify([...new Set([...ids, ...recentModels()])].slice(0, 5)); } catch { /* recent models are a convenience */ }
}
// A cheaper sibling for the build slot: Opus builds with Sonnet, Sol with Luna; otherwise the same model at a lower level.
function suggestBuild(planId) {
  const plan = modelById(planId), swap = [[/opus/, 'sonnet'], [/-sol$/, '-luna'], [/^sol$/, 'openai-codex/gpt-6-luna']];
  for (const [from, to] of swap) { const hit = modelById(planId.replace(from, to)); if (hit && hit.id !== planId && pairable(hit)) return hit.id; }
  return plan?.id;
}

// The effort ladder: one bar per level the model accepts, taller for more thinking.
function ladder(levels, value, {role, disabled, onpick, compact} = {}) {
  const box = el('span', 'ladder' + (compact ? ' compact' : '') + (role ? ' ' + role : ''));
  if (!compact) { box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', 'Thinking level'); }
  for (const level of levels) {
    const on = rank(level) <= rank(value), b = el(compact ? 'i' : 'button', 'step' + (on ? ' on' : '') + (level === value ? ' at' : ''));
    b.style.setProperty?.('--h', 4 + rank(level) * 3.4 + 'px');
    if (!compact) {
      b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(level === value)); b.disabled = Boolean(disabled?.(level));
      b.append(el('span', 'rung'), el('span', 'word', level));
      b.onclick = () => onpick(level);
      b.onkeydown = ev => {
        const i = levels.indexOf(level), next = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? levels[i + 1] : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? levels[i - 1] : undefined;
        if (next && !disabled?.(next)) { ev.preventDefault(); onpick(next); box.parentNode?.querySelector('.ladder [aria-checked=true]')?.focus(); }
      };
    } else b.append(el('span', 'rung'));
    box.append(b);
  }
  return box;
}

const SLOT_WORDS = {
  single: ['Model', 'Answers every request.'],
  plan: ['Plan', 'Reads and plans each message you send.'],
  build: ['Build', 'Takes over after the first successful edit.'],
};
// Shared by New session and the in-session dialog. opts: strict() keeps one model at xhigh (eval runs, auto route); allow(model, mode) filters the list.
const editors = []; // a favorite starred in one list shows in every list
function createEditor(root, opts) {
  const ed = {route: null, slot: 'single', query: '', ...opts};
  const modes = el('div', 'modes'), slots = el('div', 'slots'), effort = el('div', 'effort'), search = el('input', 'search'), list = el('div', 'models');
  modes.setAttribute('role', 'radiogroup'); modes.setAttribute('aria-label', 'How this session uses models');
  const modeButtons = {};
  for (const [mode, words, hint] of [['single', 'One model', 'Same model for every step'], ['pair', 'Plan + build', 'A stronger model plans, a cheaper one edits']]) {
    const b = el('button', 'mode'); b.type = 'button'; b.setAttribute('role', 'radio'); b.append(el('b', '', words), el('small', '', hint));
    b.onclick = () => ed.setMode(mode); modeButtons[mode] = b; modes.append(b);
  }
  search.type = 'search'; search.placeholder = 'Search models'; search.setAttribute('aria-label', 'Search models'); search.autocomplete = 'off';
  search.oninput = () => { ed.query = search.value.trim().toLowerCase(); drawList(); };
  search.onkeydown = ev => {
    const rows = [...list.querySelectorAll('.model')];
    if (ev.key === 'ArrowDown' && rows.length) { ev.preventDefault(); rows[0].focus(); }
    if (ev.key === 'Enter') { ev.preventDefault(); rows[0]?.click(); }
  };
  list.onkeydown = ev => {
    if (!['ArrowDown', 'ArrowUp'].includes(ev.key)) return;
    const rows = [...list.querySelectorAll('.model')], i = rows.indexOf(document.activeElement);
    ev.preventDefault();
    if (ev.key === 'ArrowUp' && i <= 0) search.focus(); else rows[Math.min(rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1))]?.focus();
  };
  root.replaceChildren(modes, slots, effort, search, list);

  const slotValue = () => ed.slot === 'single' ? ed.route : ed.route[ed.slot];
  const lockedLevel = () => ed.route.mode === 'single' && ed.strict?.();
  ed.set = (route, slot) => { ed.route = structuredClone(route); ed.slot = route.mode === 'single' ? 'single' : slot ?? 'plan'; ed.query = ''; search.value = ''; ed.render(); };
  ed.setMode = mode => {
    if (mode === ed.route.mode) return;
    if (mode === 'pair') {
      const first = pairable(modelById(ed.route.model)) ? ed.route.model : (state.models.find(m => m.id === 'anthropic/claude-opus-5-5' && pairable(m)) ?? state.models.find(pairable))?.id;
      if (!first) return;
      const build = suggestBuild(first);
      ed.route = {mode: 'pair', plan: {model: first, thinking: nearest(levelsOf(modelById(first)), 'high')}, build: {model: build, thinking: nearest(levelsOf(modelById(build)), 'medium')}};
      ed.slot = 'build';
    } else {
      const {model, thinking} = ed.route.plan;
      ed.route = {mode: 'single', model, thinking: ed.strict?.() ? 'xhigh' : thinking};
      ed.slot = 'single';
    }
    ed.render(); ed.onchange?.();
  };
  ed.pick = id => {
    const target = slotValue(), levels = levelsOf(modelById(id));
    target.model = id; target.thinking = lockedLevel() ? 'xhigh' : nearest(levels, target.thinking);
    ed.render(); ed.onchange?.();
  };
  ed.level = level => { slotValue().thinking = level; ed.render(); ed.onchange?.(); effort.querySelector('[aria-checked=true]')?.focus(); };
  ed.render = () => {
    if (!ed.route) return;
    const canPair = state.models.some(pairable) && ed.allow?.(null, 'pair') !== false;
    for (const [mode, b] of Object.entries(modeButtons)) { b.setAttribute('aria-checked', String(ed.route.mode === mode)); b.tabIndex = ed.route.mode === mode ? 0 : -1; }
    modeButtons.pair.disabled = !canPair; modeButtons.pair.title = canPair ? '' : 'Plan + build runs signed-in models on native Windows';
    // slot cards
    slots.replaceChildren();
    slots.dataset.mode = ed.route.mode;
    for (const slot of ed.route.mode === 'pair' ? ['plan', 'build'] : ['single']) {
      const value = slot === 'single' ? ed.route : ed.route[slot], model = modelById(value.model), [role, hint] = SLOT_WORDS[slot];
      const card = el('button', 'slot ' + slot); card.type = 'button'; card.setAttribute('aria-pressed', String(ed.slot === slot));
      card.setAttribute('aria-label', `${role}: ${model?.label ?? value.model} at ${value.thinking} thinking. Change`);
      const top = el('span', 'slot-top'); top.append(el('span', 'role', role), ladder(levelsOf(model), value.thinking, {compact: true, role: slot}), el('span', 'level', value.thinking));
      card.append(top, el('span', 'name', model?.label ?? value.model ?? 'Choose a model'), el('small', '', hint));
      card.onclick = () => { ed.slot = slot; ed.render(); search.focus(); };
      if (slot === 'build') slots.append(el('span', 'then', '→'));
      slots.append(card);
    }
    // effort for the active slot
    const value = slotValue(), model = modelById(value.model), locked = lockedLevel();
    effort.replaceChildren();
    const head = el('div', 'effort-head');
    head.append(el('b', '', ed.slot === 'single' ? 'Thinking' : `${SLOT_WORDS[ed.slot][0]} thinking`), el('small', '', model?.label ?? ''));
    effort.append(head, ladder(levelsOf(model), value.thinking, {role: ed.slot, disabled: level => locked && level !== 'xhigh', onpick: ed.level}));
    const note = locked ? 'Eval isolation and the auto model route run one model at xhigh. Plan + build can use any level.'
      : ed.slot === 'plan' ? 'Higher levels plan more carefully. The planning model also takes over after three failed tool calls in a row.'
      : ed.slot === 'build' ? 'Lower levels edit faster and cost less.' : '';
    if (note) effort.append(el('small', 'effort-note', note));
    drawList();
  };
  let listSig = '';
  function drawList() {
    if (!ed.route) return;
    const current = slotValue().model, other = ed.route.mode === 'pair' ? ed.route[ed.slot === 'plan' ? 'build' : 'plan'].model : null;
    // Only models whose provider is signed in or has a key; sign-ins live in the sidebar.
    const usable = state.models.filter(m => modelReady(m) && (ed.route.mode !== 'pair' || pairable(m)) && ed.allow?.(m, ed.route.mode) !== false);
    const hits = ed.query ? usable.filter(m => `${m.label} ${m.id} ${m.group}`.toLowerCase().includes(ed.query)) : usable;
    // Favorites lead every list and leave their provider group; Recent repeats only what is not a favorite.
    const favorites = favoriteModels(), groups = new Map(), pick = ids => ids.map(id => hits.find(m => m.id === id)).filter(Boolean);
    if (pick(favorites).length) groups.set('Favorites', pick(favorites));
    if (!ed.query) { const recent = pick(recentModels().filter(id => !favorites.includes(id))); if (recent.length) groups.set('Recent', recent); }
    for (const m of hits) { if (favorites.includes(m.id)) continue; if (!groups.has(m.group)) groups.set(m.group, []); groups.get(m.group).push(m); }
    // Rebuild only when something visible changed, so polling never resets a list someone is moving through.
    const sig = JSON.stringify([[...groups].map(([name, models]) => [name, models.map(m => m.id)]), current, other, ed.slot, ed.query, loginBusy,
      Object.entries(state.auth ?? {}).map(([id, a]) => [id, a.signedIn, a.type])]);
    if (sig === listSig) return;
    listSig = sig;
    const focused = list.contains?.(document.activeElement) ? [document.activeElement.getAttribute('data-id'), document.activeElement.className] : null;
    list.replaceChildren();
    if (!hits.length) list.append(el('p', 'empty', ed.query ? `No model matches “${search.value.trim()}”.` : 'No models yet. Sign in or add a key in the sidebar.'));
    for (const [name, models] of groups) {
      const sec = el('section', 'model-group'), head = el('div', 'group-head'), a = ['Favorites', 'Recent'].includes(name) ? null : auth(models[0].provider);
      head.append(el('b', '', name));
      if (a) head.append(el('small', 'signed', a.type === 'oauth' ? 'Signed in' : 'Key saved'));
      sec.append(head);
      for (const m of models) {
        const line = el('div', 'model-row'), row = el('button', 'model'); row.type = 'button'; row.setAttribute('aria-pressed', String(m.id === current)); row.setAttribute('data-id', m.id);
        const meta = [contextWords(m.contextWindow), m.input?.includes('image') ? 'images' : 'text only', ['Favorites', 'Recent'].includes(name) ? m.group : ''].filter(Boolean).join(', ');
        row.append(el('span', 'name', m.label), el('small', '', meta));
        if (m.id === other) row.append(el('span', 'tag ' + (ed.slot === 'plan' ? 'build' : 'plan'), ed.slot === 'plan' ? 'Build' : 'Plan'));
        row.onclick = () => ed.pick(m.id);
        const loved = favorites.includes(m.id), star = el('button', 'star', loved ? '\u2605' : '\u2606');
        star.type = 'button'; star.setAttribute('aria-pressed', String(loved)); star.setAttribute('data-id', m.id);
        star.setAttribute('aria-label', loved ? `Remove ${m.label} from favorites` : `Add ${m.label} to favorites`); star.title = loved ? 'Remove from favorites' : 'Add to favorites';
        star.onclick = () => { toggleFavorite(m.id); for (const other of editors) other.redrawList(); };
        line.append(row, star); sec.append(line);
      }
      list.append(sec);
    }
    if (focused) [...list.querySelectorAll('[data-id]')].find(node => node.getAttribute('data-id') === focused[0] && node.className === focused[1])?.focus();
  }
  ed.redrawList = () => { listSig = ''; drawList(); };
  editors.push(ed);
  return ed;
}

function newView() { return {todos: new Map(), contract: null, files: new Map(), stats: null, commands: [], statuses: new Map(), widgets: new Map(), report: null}; }

let loginPopup = null, loginPopupFlow = null, loginBusy = false, authFor = 'openai-codex';
const auth = provider => state.auth?.[provider];
// Signed in, or a provider the dashboard does not manage (OpenRouter reads its key from the environment).
const ready = provider => !auth(provider) || auth(provider).signedIn;
const modelReady = m => ready(m.provider) && !m.keyMissing;
const loginsOfSession = s => s?.logins ?? [s?.provider ?? modelById(s?.model)?.provider].filter(Boolean);
const missingLogin = s => loginsOfSession(s).find(provider => !ready(provider));
const signInWords = a => a.type === 'oauth' ? `Sign in to ${a.label}` : `Add ${a.label} key`;
const loginWord = a => a.type === 'oauth' ? 'login' : 'key';
function renderAuth() {
  const list = $('accounts'); list.replaceChildren();
  for (const [id, a] of Object.entries(state.auth ?? {})) {
    const waiting = a.phase === 'waiting', row = el('div', 'account-row'), who = el('div');
    who.append(el('strong', '', a.label), el('small', '', waiting ? 'Signing in…' : !a.signedIn ? 'Not signed in' : a.source === 'environment' ? 'Key from environment' : a.type === 'oauth' ? 'Login saved' : 'Key saved'));
    const b = el('button', 'ghost', waiting ? 'Continue sign-in' : a.signedIn ? 'Manage' : signInWords(a));
    b.type = 'button'; b.disabled = loginBusy; b.setAttribute('aria-label', `${a.label}: ${b.textContent}`); b.onclick = () => openAuth(id);
    row.append(who, b); list.append(row);
  }
  const need = sel ? auth(missingLogin(sel)) : null;
  $('login-needed').hidden = !need;
  if (need) { $('login-needed-text').textContent = `${signInWords(need)} to send messages. It is saved for future sessions.`; $('login-needed-button').textContent = signInWords(need); }
  syncLaunchAuth(); syncRouteAuth(); renderAuthDialog(); if (launchEditor.route) launchEditor.render(); if (routeEditor.route) routeEditor.render();
}
function renderAuthDialog() {
  const a = auth(authFor); if (!a) return;
  const waiting = a.phase === 'waiting', oauth = a.type === 'oauth';
  $('auth-h').textContent = a.signedIn && !waiting ? a.label : signInWords(a);
  $('auth-intro').textContent = oauth ? `No API key needed. Sign in on ${a.site} with your ${a.account} account; Apex saves your login for later.`
    : `Paste your ${a.account} API key from ${a.site}. Apex saves it on this computer and never shows it again.`;
  $('auth-message').textContent = a.message || (a.signedIn ? `${a.label} ${loginWord(a)} is saved on this computer for future sessions.` : '');
  $('auth-open').hidden = !waiting || !a.url; $('auth-open').textContent = `Continue on ${a.site}`;
  if (waiting && a.url) $('auth-open').href = a.url; else $('auth-open').removeAttribute('href');
  $('auth-fallback').hidden = !waiting || !a.prompt;
  if (a.prompt) {
    $('auth-code-label').textContent = a.code ? 'Code or full callback URL' : 'Full callback URL';
    $('auth-code').placeholder = a.code ? 'code#state' : `${a.prompt.callback}?code=…&state=…`;
    $('auth-code-help').textContent = `Paste ${a.code ? `the code ${a.site} shows, or ` : ''}the address of the ${a.site} callback page. Never paste a password or API key.`;
  }
  $('auth-key-row').hidden = oauth;
  $('auth-close').textContent = waiting ? 'Cancel sign-in' : a.phase === 'saved' ? 'Done' : 'Close';
  $('auth-retry').hidden = !oauth || waiting || a.phase === 'saved'; $('auth-retry').textContent = a.signedIn ? 'Sign in again' : a.phase === 'error' ? 'Try again' : 'Sign in';
  $('auth-signout').hidden = waiting || !a.signedIn || a.source === 'environment'; $('auth-signout').textContent = oauth ? 'Sign out' : 'Remove key';
  for (const id of ['auth-retry', 'auth-signout', 'login-needed-button']) $(id).disabled = loginBusy;
  if (waiting && a.url && loginPopup && loginPopupFlow !== a.id) {
    try { loginPopup.location.replace(a.url); loginPopupFlow = a.id; } catch { /* the visible link also works when a popup is blocked */ }
  }
  if (!waiting && !loginBusy) {
    loginPopup?.close(); loginPopup = null; loginPopupFlow = null;
    $('auth-code').value = '';
  }
}
const authPost = async (action, body = {}) => { state.auth[authFor] = {...auth(authFor), ...await post('/api/auth/' + action, {provider: authFor, ...body})}; stateSig = ''; };
function openAuth(provider) {
  const a = auth(provider); if (!a) return;
  authFor = provider; $('auth-error').textContent = '';
  if (a.type === 'oauth' && (!a.signedIn || a.phase === 'waiting')) return signIn();
  if (!$('authdlg').open) $('authdlg').showModal();
  renderAuthDialog(); if (a.type !== 'oauth') $('auth-key').focus();
}
async function signIn() { // runs inside the click so the popup is not blocked
  if (loginBusy) return;
  loginBusy = true; $('auth-error').textContent = '';
  if (!$('authdlg').open) $('authdlg').showModal();
  if (!loginPopup || loginPopup.closed) {
    loginPopup = window.open('about:blank', '_blank');
    if (loginPopup) loginPopup.opener = null;
    loginPopupFlow = null;
  }
  renderAuthDialog();
  try { await authPost('login'); await refresh(); }
  catch (e) { $('auth-error').textContent = e.message; loginPopup?.close(); loginPopup = null; }
  finally { loginBusy = false; renderAuth(); }
}
async function closeAuth() {
  try {
    if (auth(authFor)?.phase === 'waiting') await authPost('cancel', {loginId: auth(authFor).id});
    $('authdlg').close(); $('auth-error').textContent = ''; $('auth-key').value = ''; renderAuth(); await refresh();
  } catch (e) { $('auth-error').textContent = e.message; }
}
$('login-needed-button').onclick = () => openAuth(missingLogin(sel));
$('auth-retry').onclick = signIn;
$('auth-close').onclick = closeAuth;
$('authdlg').oncancel = e => { e.preventDefault(); closeAuth(); };
$('auth-signout').onclick = async () => {
  const a = auth(authFor);
  if (!confirm(`Remove the saved ${a.label} ${loginWord(a)} from this computer? Sessions using it stop working until you sign in again.`)) return;
  loginBusy = true; $('auth-error').textContent = '';
  try { await authPost('logout'); await refresh(); } catch (e) { $('auth-error').textContent = e.message; }
  finally { loginBusy = false; renderAuth(); }
};
$('auth-form').onsubmit = async e => {
  e.preventDefault(); $('auth-error').textContent = '';
  const oauth = auth(authFor)?.type === 'oauth', field = $(oauth ? 'auth-code' : 'auth-key'), value = field.value.trim();
  field.value = ''; // never keep a key or code in the page after sending it
  try {
    await authPost(oauth ? 'respond' : 'key', oauth ? {loginId: auth(authFor).id, value} : {value});
    renderAuth(); await refresh();
  } catch (err) { $('auth-error').textContent = err.message; }
};

// What a session means for the person: one plain word, never colour alone.
function label(s) {
  if (s.status === 'error') return ['error', 'Stopped with an error'];
  if (s.status === 'done') return ['done', 'Ended'];
  if (s.viewOnly) return ['saved', 'Read-only'];
  if (s.pending.length) return ['asks', 'Asks you'];
  if (s.status === 'running') return ['running', 'Working'];
  if (s.settled > (seen[s.id] ?? 0) && s.id !== sel?.id) return ['finished', 'Finished'];
  return ['idle', 'Idle'];
}

// Decorative state dot; colour comes from the same `.st.<kind>` mapping, the word in <small> carries the meaning.
const dot = kind => { const d = el('span', 'dot st ' + kind); d.setAttribute('aria-hidden', 'true'); return d; };

function sessionButton(s, onclick, extra) {
  const b = el('button', 'row'), [kind, words] = label(s);
  b.type = 'button'; b.setAttribute('aria-current', String(s.id === sel?.id));
  const small = el('small'); small.append(el('span', 'st ' + kind, words), document.createTextNode(extra ?? ', ' + routeWords(s)));
  b.append(el('b', '', s.title || 'New session'), small); b.onclick = onclick;
  b.firstChild.prepend(dot(kind));
  // Running time ticks client-side (see the interval at the bottom); state only changes on start/settle.
  if (s.status === 'running' && s.startedAt) { const t = el('small', 'run', 'Running ' + dur(Date.now() - s.startedAt)); t.dataset.since = s.startedAt; b.append(t); }
  else if (s.ranMs != null) b.append(el('small', 'run', 'Last run ' + dur(s.ranMs)));
  return b;
}

// A saved or archived session: the title shows its transcript read-only, the side button moves it between the two lists (files never change).
function savedRow(w, s, words, action, endpoint) {
  const line = el('div', 'saved-row'), b = el('button', 'row'); b.type = 'button';
  const m = el('small'); m.append(el('span', 'st saved', words), document.createTextNode(', ' + ago(s.mtime)));
  b.append(el('b', '', s.title), m); b.firstChild.prepend(dot('saved'));
  if (sel?.viewOnly && sel.file === s.file) b.setAttribute('aria-current', 'true');
  b.onclick = () => select({id: 'saved:' + s.file, cwd: w.path, file: s.file, title: s.title, status: 'saved', pending: [], viewOnly: true});
  const act = el('button', 'ghost more', action); act.type = 'button'; act.title = 'The session stays on disk';
  act.setAttribute('aria-label', `${action} ${s.title}`);
  act.onclick = async () => { await post(endpoint, {file: s.file}).catch(e => alert(e.message)); refresh(); };
  line.append(b, act); return line;
}
const archivedOpen = new Set(); // workspaces whose Archived group is expanded, kept across re-renders

function renderSide() {
  const groups = $('groups'); groups.replaceChildren();
  const live = state.workspaces.flatMap(w => w.live.map(s => ({...s, ws: base(w.path)})));
  const waiting = live.filter(s => ['asks', 'finished', 'error'].includes(label(s)[0]));
  $('queue').hidden = !waiting.length; $('queue-n').textContent = waiting.length ? `(${waiting.length})` : '';
  const list = $('queue-list'); list.replaceChildren();
  for (const s of waiting) { const b = sessionButton(s, () => select(s), ''); b.querySelector('small').append(document.createTextNode(' in ' + s.ws)); list.append(b); }
  if (!state.workspaces.length) groups.append(el('p', 'empty', 'No workspaces yet. Add a project folder to start.'));
  for (const w of state.workspaces) {
    const sec = el('section', 'ws'), head = el('div', 'ws-head'), title = el('div', 'ws-title');
    sec.setAttribute('aria-label', base(w.path));
    const shut = Boolean(collapsed[w.path]), body = el('div', 'ws-body'); body.hidden = shut;
    const h = el('h3'), toggle = el('button', 'ws-toggle'); h.title = w.path;
    toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(!shut));
    const count = w.live.length + w.saved.length;
    toggle.append(el('span', 'chev', '›'), el('span', 'ws-name', base(w.path)), el('span', 'ws-count', count ? String(count) : ''));
    toggle.onclick = () => {
      const open = body.hidden; body.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
      if (open) delete collapsed[w.path]; else collapsed[w.path] = true;
      try { localStorage.collapsed = JSON.stringify(collapsed); } catch { /* remembered layout is a convenience */ }
    };
    h.append(toggle);
    const small = el('small', 'ws-path', w.path); small.title = w.path; title.append(h);
    const add = el('button', 'ghost', 'New session'); add.type = 'button'; add.setAttribute('aria-label', 'New session in ' + base(w.path)); add.onclick = () => openLaunch(w.path);
    const more = el('button', 'ghost more', 'More'); more.type = 'button'; more.setAttribute('aria-expanded', 'false');
    const menu = el('div'); menu.hidden = true;
    const reveal = el('button', 'ghost', 'Show in file explorer'); reveal.type = 'button'; reveal.onclick = () => post('/api/reveal', {path: w.path}).catch(e => alert(e.message));
    const remove = el('button', 'ghost more', 'Remove from list'); remove.type = 'button'; remove.title = 'Files and sessions stay on disk';
    remove.onclick = async () => { if (confirm(`Remove ${base(w.path)} from the list? Files and sessions stay on disk.`)) { await post('/api/workspaces/remove', {path: w.path}); refresh(); } };
    menu.append(reveal, remove);
    more.onclick = () => { menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); };
    head.append(title, add, more); body.append(small, menu); sec.append(head, body);
    for (const s of w.live) body.append(sessionButton(s, () => select(s)));
    for (const s of w.saved) body.append(savedRow(w, s, 'Saved', 'Archive', '/api/sessions/archive'));
    if (!w.live.length && !w.saved.length) body.append(el('p', 'empty', 'No sessions yet.'));
    if (w.archived.length) {
      const open = archivedOpen.has(w.path), list = el('div'); list.hidden = !open;
      const toggle = el('button', 'ghost more', `Archived (${w.archived.length})`); toggle.type = 'button'; toggle.setAttribute('aria-expanded', String(open));
      toggle.onclick = () => { list.hidden = !list.hidden; toggle.setAttribute('aria-expanded', String(!list.hidden)); archivedOpen[list.hidden ? 'delete' : 'add'](w.path); };
      for (const s of w.archived) list.append(savedRow(w, s, 'Archived', 'Restore', '/api/sessions/unarchive'));
      body.append(toggle, list);
    }
    groups.append(sec);
  }
  $('subscription-usage').textContent = usageRows().map(p => `${p.label}: ` + (p.error ? 'usage unavailable'
    : p.limits.map(l => `${limitName(p, l)} ${percent(l)}`).join(', '))).join(' · ');
}

async function refresh() {
  let data;
  try { data = await (await fetch('/api/state')).json(); } catch { return; }
  const sig = JSON.stringify(data);
  if (sig === stateSig) return;
  stateSig = sig; state = data;
  const fresh = state.workspaces.flatMap(w => w.live).find(s => s.id === sel?.id);
  if (fresh) { sel = fresh; seen[sel.id] = sel.settled; localStorage.seen = JSON.stringify(seen); }
  else if (sel && !sel.viewOnly) sel = {...sel, status: 'done', pending: []};
  renderAuth(); header(); renderSide(); renderAsks();
  if (!sel) { $('log').replaceChildren(); blank(); }
}

function header() {
  const empty = !sel;
  $('title').textContent = sel?.title || (empty ? 'Pick a session' : 'New session');
  $('where').textContent = empty ? 'Choose one on the left, or start a new one in a workspace.' : `${sel.cwd}, ${label(sel)[1].toLowerCase()}`;
  const running = sel?.status === 'running', alive = running || sel?.status === 'idle';
  $('stop').hidden = !running; $('end').hidden = !alive; $('resume').hidden = !sel?.viewOnly;
  const auto = Boolean(sel?.autoApprove); // only sessions with the safety feature ask before tool calls
  $('auto').hidden = !alive || !sel.flags?.features?.includes('safety');
  $('auto').textContent = `Auto-approve: ${auto ? 'on' : 'off'}`; $('auto').setAttribute('aria-pressed', String(auto)); $('auto').className = auto ? 'btn auto on' : 'btn auto';
  $('where').className = empty ? '' : 'path'; $('form').hidden = empty || Boolean(sel.viewOnly); // read-only: no sending, no model changes
  syncComposer();
}

function select(s) {
  if (sel) sessionDraft(sel.id).message = $('box').value;
  sel = s; source?.close(); current = null; activity = null; tools.clear(); toolArgs.clear(); view = newView(); asksSig = '';
  clearTimeout(markdownTimer); markdownTimer = 0; pendingRender.clear();
  $('box').value = sessionDraft(s.id).message; $('slash').hidden = true; renderAttachments();
  if (!s.viewOnly) { seen[s.id] = s.settled ?? 0; localStorage.seen = JSON.stringify(seen); }
  $('log').replaceChildren(); renderQueued(); header(); renderSide(); renderAsks(); renderInfo();
  renderAuth();
  document.body.dataset.pane = 'chat';
  if (s.viewOnly) { // the file as Pi's get_messages would return it; no agent process
    fetch('/api/transcript?file=' + encodeURIComponent(s.file)).then(async r => ({ok: r.ok, body: await r.json()}))
      .then(({ok, body}) => { if (sel === s) handle(ok ? {type: 'response', command: 'get_messages', success: true, data: body} : {type: 'response', success: false, error: body.error}); },
        e => { if (sel === s) add('note', e.message); });
  } else {
    source = new EventSource('/api/events?id=' + s.id);
    source.onmessage = e => { const log = $('log'), stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80; handle(JSON.parse(e.data)); if (stick) log.scrollTop = log.scrollHeight; };
    source.onerror = () => source.close();
  }
  $('box').focus();
  const result = enhanced.get(s.id);
  if (result) { enhanced.delete(s.id); applyEnhanced(s.id, result.original, result.text); } // through the undo stack and the toast
}

const add = (cls, text) => { const e = el('div', cls, text); $('log').append(e); return e; };
// Mid-turn notes (auto-approvals, extension notices) stay inside the running activity group instead of splitting it.
const aside = (cls, text) => activity ? activity.list.append(el('div', cls, text)) : add(cls, text);
const text = c => typeof c === 'string' ? c : (c ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n\n');
const message = (role, content) => { settle(); return renderMessage(add(role), content); };
function queueRender(node, render) { // streaming deltas repaint at most every 50 ms
  pendingRender.set(node, render);
  if (!markdownTimer) markdownTimer = setTimeout(() => {
    markdownTimer = 0;
    const log = $('log'), stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    for (const [target, render] of pendingRender) if (target.isConnected) render();
    pendingRender.clear(); if (stick) log.scrollTop = log.scrollHeight;
  }, 50);
}

// Activity: thinking and tool calls between two replies share one collapsible group, one row per step.
// Any other log entry (add) closes the group; live groups show a spinner, the +/- line total and the current step.
const file = a => base(String(a?.path ?? ''));
const STEPS = { // tool → verb, live verb, target element, target, summary kind
  read: ['Read', 'Reading', 'b', file, 'read'],
  edit: ['Edited', 'Editing', 'b', file, 'edit'],
  write: ['Wrote', 'Writing', 'b', file, 'edit'],
  bash: ['Ran', 'Running', 'code', a => String(a?.command ?? '').split('\n')[0].slice(0, 300), 'ran'],
  grep: ['Searched', 'Searching', 'span', a => a?.pattern, 'search'],
  find: ['Searched', 'Searching', 'span', a => a?.pattern, 'search'],
  ls: ['Listed', 'Listing', 'b', a => file(a) || '.', 'list'],
};
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const PHRASES = {thought: () => 'thought', read: n => 'read ' + plural(n, 'file'), edit: n => 'edited ' + plural(n, 'file'),
  ran: n => n === 1 ? 'ran a command' : `ran ${n} commands`, search: () => 'searched code', list: () => 'listed files', other: n => 'used ' + plural(n, 'tool')};
function group() {
  if (activity) return activity;
  const node = el('details', 'activity'), summary = el('summary'), list = el('div', 'steps');
  node.append(summary, list); $('log').append(node);
  return activity = {node, summary, list, kinds: new Map(), plus: 0, minus: 0, step: '', stepOf: null, live: true};
}
function step(kind, key, row) { // files count once per path; every other step counts once
  const g = group(); g.list.append(row);
  if (!g.kinds.has(kind)) g.kinds.set(kind, new Set());
  g.kinds.get(kind).add(key || row);
  return g;
}
function doing(g, label, of) { g.step = label; g.stepOf = of; summarize(g); }
function done(g, of) { if (g.stepOf === of) doing(g, '', null); }
function summarize(g) {
  const words = [...g.kinds].map(([kind, keys]) => PHRASES[kind](keys.size)).join(', ') || 'auto-approved a tool call'; // approval before its tool row
  g.summary.replaceChildren(...(g.live ? [el('span', 'spinner')] : []), el('span', 'what', words[0].toUpperCase() + words.slice(1)),
    ...(g.plus || g.minus ? [statEl(g.plus, g.minus)] : []), ...(g.live && g.step ? [el('span', 'doing', g.step)] : []));
}
function settle() { if (activity) { activity.live = false; summarize(activity); activity = null; } }
// apex-features/safety.mjs asks "Tool: name\nArguments: json\nreason…". Pi starts the tool before the gate asks, so an
// auto-approval marks the latest unmarked row for that tool (whose diff or command already shows the arguments).
// Without such a row it becomes one quiet row of its own, arguments folded.
function approval(prompt) {
  const name = /^Tool: (.*)$/m.exec(prompt)?.[1] ?? 'tool', args = /^Arguments: (.*)$/m.exec(prompt)?.[1] ?? '';
  const row = [...activity?.list.querySelectorAll('.step[data-tool]:not(.approved)') ?? []].reverse().find(r => r.dataset.tool === name);
  if (row) { row.classList.add('approved'); row.querySelector('summary').append(el('span', 'approved-tag', 'auto-approved')); return; }
  let shown = args;
  try { shown = JSON.stringify(JSON.parse(args), null, 2); } catch { /* cut at 2000 chars with " [truncated]": show as sent */ }
  const note = el('details', 'step approval'), summary = el('summary');
  summary.append(el('span', 'verb', 'Auto-approved'), el('b', 'target', name)); note.append(summary);
  if (shown) note.append(el('pre', '', shown));
  group().list.append(note);
}

// One assistant content part, created on first sight and repainted after: streaming, message_end and replay share it.
function place(ctx, index, part, live) {
  let block = ctx.blocks.get(index);
  if (part.type === 'thinking') {
    if (!block) { if (!part.thinking) return; block = {node: el('details')}; block.group = step('thought', null, block.node); ctx.blocks.set(index, block); }
    const paint = () => renderThought(block.node, part);
    if (live) { queueRender(block.node, paint); if (block.group.stepOf !== block.node) doing(block.group, 'Thinking', block.node); }
    else { pendingRender.delete(block.node); paint(); done(block.group, block.node); }
  } else if (part.type === 'text') {
    if (!block) {
      if (!part.text) return;
      if (!ctx.text || ctx.text !== $('log').lastElementChild) { settle(); ctx.text = add('assistant'); }
      block = {node: el('div', 'markdown')}; ctx.text.append(block.node); ctx.blocks.set(index, block);
    }
    const paint = () => renderMarkdown(block.node, part.text);
    if (live) queueRender(block.node, paint); else { pendingRender.delete(block.node); paint(); }
  }
}
const newMessage = () => ({text: null, blocks: new Map(), values: new Map()});
function updateAssistant(event) {
  current ??= newMessage();
  const index = event.contentIndex ?? 0, end = event.type.endsWith('_end');
  const value = end ? event.content : (current.values.get(index) ?? '') + event.delta;
  current.values.set(index, value);
  place(current, index, event.type.startsWith('thinking') ? {type: 'thinking', thinking: value} : {type: 'text', text: value}, !end);
}
function tool(id, name, args) {
  const [verb, live, tag, target, kind] = STEPS[name] ?? ['Used', 'Using', 'b', () => name, 'other'];
  const row = el('details', 'step'), summary = el('summary'), what = String(target(args) ?? '');
  row.dataset.tool = name;
  summary.append(el('span', 'verb', verb), el(tag, 'target', what)); row.append(summary);
  const g = step(kind, kind === 'read' || kind === 'edit' ? args?.path : null, row);
  doing(g, (live + ' ' + what).trim(), id);
  const entry = {row, group: g}; tools.set(id, entry); toolArgs.set(id, args); return entry;
}
function result(d, r, bad) {
  if (bad) d.classList.add('err');
  const out = text(r?.content).slice(0, 4000); if (out && !d.querySelector('pre')) d.append(el('pre', '', out));
  const images = Array.isArray(r?.content) ? r.content.filter(p => p.type === 'image') : [];
  if (images.length && !d.querySelector('.message-images')) d.append(renderMessage(el('div'), images));
}

// Pi's edit diff lines: "+NN text" added (new number), "-NN text" removed (old number), " NN text" context (old number), " ... " skipped.
function parseDiff(diff) {
  const rows = []; let delta = 0; // delta = new line number - old line number
  for (const line of diff.split('\n')) {
    const m = /^( *\d+) (.*)$/.exec(line.slice(1)), n = m && Number(m[1]), body = m?.[2] ?? '';
    if (!m) rows.push({t: 'gap'});
    else if (line[0] === '+') { rows.push({t: 'add', n, text: body}); delta++; }
    else if (line[0] === '-') { rows.push({t: 'del', o: n, text: body}); delta--; }
    else rows.push({t: 'ctx', o: n, n: n + delta, text: body});
  }
  rows.forEach((x, i) => { if (x.t === 'gap') { const next = rows[i + 1]; x.label = next ? 'Unchanged lines skipped before line ' + (next.o ?? next.n) : 'Unchanged lines skipped'; } });
  return rows;
}
function writeRows(content) {
  const lines = content.split('\n'); if (lines.at(-1) === '') lines.pop();
  const rows = lines.slice(0, 300).map((l, i) => ({t: 'add', n: i + 1, text: l}));
  if (lines.length > 300) rows.push({t: 'gap', label: `${lines.length - 300} more lines not shown`});
  return rows;
}
function diffTable(rows, split) {
  const t = el('table', 'dt'), cell = (cls, txt) => el('td', cls, txt ?? '');
  const widths = split ? ['56px', '', '56px', ''] : ['56px', '56px', '']; // fixed number gutters, code columns share the rest
  const cols = el('colgroup'); for (const w of widths) { const c = el('col'); if (w) c.style.width = w; cols.append(c); } t.append(cols);
  const push = (cls, cells) => { const tr = el('tr', cls); tr.append(...cells); t.append(tr); };
  const gap = x => { const tr = el('tr', 'gap'), td = cell('', x.label); td.colSpan = split ? 4 : 3; tr.append(td); t.append(tr); };
  let dels = [], adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const a = dels[i], b = adds[i];
      push('', [cell('num del' + (a ? '' : ' none'), a?.o), cell('code del' + (a ? '' : ' none'), a?.text), cell('num add' + (b ? '' : ' none'), b?.n), cell('code add' + (b ? '' : ' none'), b?.text)]);
    }
    dels = []; adds = [];
  };
  for (const x of rows) {
    if (split) {
      if (x.t === 'del') dels.push(x); else if (x.t === 'add') adds.push(x);
      else { flush(); if (x.t === 'gap') gap(x); else push('', [cell('num', x.o), cell('code', x.text), cell('num', x.n), cell('code', x.text)]); }
    } else if (x.t === 'gap') gap(x);
    else push(x.t === 'ctx' ? '' : x.t, [cell('num', x.o), cell('num', x.n), cell('code', x.text)]);
  }
  flush();
  return t;
}
const statEl = (plus, minus) => { const stat = el('span', 'stat'); stat.append(el('span', 'plus', '+' + plus), el('span', 'minus', '\u2212' + minus)); return stat; };
const diffStat = rows => [rows.filter(x => x.t === 'add').length, rows.filter(x => x.t === 'del').length];
function diffCard(name, path, rows, args, r) {
  const card = el('div', 'diff'), head = el('div', 'diff-head'), body = el('div', 'diff-body');
  const badge = el('span', 'badge ' + name, name === 'edit' ? 'M' : 'W'); badge.title = name === 'edit' ? 'Modified' : 'Written';
  const parts = String(path ?? name).split(/[\\/]/).filter(Boolean), file = el('span', 'file', parts.length > 3 ? '.../' + parts.slice(-3).join('/') : parts.join('/'));
  file.title = path ?? '';
  const [plus, minus] = diffStat(rows), stat = statEl(plus, minus);
  const seg = el('span', 'seg'), buttons = {};
  const draw = () => { body.replaceChildren(diffTable(rows, localStorage.diff === 'split')); for (const mode in buttons) buttons[mode].classList.toggle('on', (localStorage.diff === 'split') === (mode === 'split')); };
  for (const mode of ['unified', 'split']) { const b = buttons[mode] = el('button', '', mode === 'split' ? 'Split' : 'Unified'); b.type = 'button'; b.onclick = () => { localStorage.diff = mode; draw(); }; seg.append(b); }
  head.append(badge, file, stat, seg); card.append(head, body); draw();
  for (const [title, value] of [['Raw input', JSON.stringify(args, null, 2)], ['Tool output', text(r?.content)]]) {
    if (!value) continue; const d = el('details', 'raw'); d.append(el('summary', '', title), el('pre', '', value.slice(0, 4000))); card.append(d);
  }
  const seenFile = view.files.get(path) ?? {name, plus: 0, minus: 0}; seenFile.plus += plus; seenFile.minus += minus; if (path) view.files.set(path, seenFile);
  return card;
}

function learn(name, args, r) { // Apex tool state that has a home in the Plan panel
  try {
    if (name === 'todo') {
      const items = JSON.parse(text(r?.content));
      if (args?.action === 'list') view.todos.clear();
      if (Array.isArray(items)) for (const t of items) view.todos.set(t.id, t);
    } else if (name === 'contract') {
      const data = JSON.parse(text(r?.content));
      if (Array.isArray(data?.criteria)) view.contract = data.criteria;
    }
  } catch { /* free text result: nothing to show */ }
}
function finish(id, name, r, bad) {
  const {row, group: g} = tools.get(id) ?? tool(id, name), args = toolArgs.get(id);
  if (!bad) learn(name, args, r);
  const rows = bad ? null : name === 'edit' && r?.details?.diff ? parseDiff(r.details.diff) : name === 'write' && typeof args?.content === 'string' ? writeRows(args.content) : null;
  if (rows) {
    const [plus, minus] = diffStat(rows);
    row.querySelector('summary').append(statEl(plus, minus)); row.append(diffCard(name, args?.path, rows, args, r));
    g.plus += plus; g.minus += minus;
  } else result(row, r, bad);
  if (g.stepOf === id) doing(g, '', null); else summarize(g);
}

// Queue updates are complete snapshots. Keep pending input separate from the
// transcript: Pi removes it from the queue before emitting the user message.
// Pi queues text only and can only clear its whole queue, so remember the images each queued send carried:
// the bar marks them [Image], and remove/edit/send-now clear the queue and re-queue the rest with their images.
const queuedImages = new Map(); // session id → Map(text → draft images)
const imagesOf = (id, message) => queuedImages.get(id)?.get(message) ?? [];
let queueSnapshot = {};
function renderQueued(queue = {}, ended = false) {
  queueSnapshot = queue;
  const panel = $('queued'), items = [...(queue.steering ?? []).map(t => ['steer', t]), ...(queue.followUp ?? []).map(t => ['followUp', t])];
  panel.replaceChildren(); panel.hidden = !items.length;
  if (!items.length) return;
  const bar = el('div', 'queue-bar'), count = plural(items.length, 'message');
  items.forEach(([mode, message], i) => {
    const line = el('span', 'queue-text'), actions = el('span', 'queue-actions');
    if (mode === 'steer') line.append(el('span', 'queue-tag', '[Steer] '));
    if (imagesOf(sel?.id, message).length) line.append(el('span', 'queue-tag', '[Image] '));
    line.append(message.replace(/\s+/g, ' ').trim()); line.title = message;
    if (!ended) for (const [label, glyph, action] of [...(mode === 'followUp' ? [['Send now', '\u2191', 'now']] : []), ['Edit', '\u270E', 'edit'], ['Remove', '\u2715', 'remove']]) {
      const button = el('button', '', glyph); button.type = 'button'; button.title = label;
      button.setAttribute('aria-label', `${label}: ${message.slice(0, 80)}`); button.onclick = () => rework(mode, message, action);
      actions.append(button);
    }
    bar.append(el('b', 'queue-count', i ? '' : ended ? `${count} not delivered — session ended` : `${count} queued`), line, actions);
  });
  panel.append(bar);
}
function restoreDraft(id, message, images) {
  const draft = sessionDraft(id), typed = sel?.id === id ? $('box').value : draft.message;
  draft.message = typed.trim() ? message + '\n\n' + typed : message; draft.images.push(...images);
  if (sel?.id === id) { $('box').value = draft.message; renderAttachments(); syncComposer(); $('box').focus(); }
}
async function rework(mode, message, action) {
  const id = sel.id;
  try {
    const queue = await post('/api/clear-queue', {id});
    const items = [...queue.steering.map(t => ['steer', t]), ...queue.followUp.map(t => ['followUp', t])];
    const at = items.findIndex(([m, t]) => m === mode && t === message);
    if (at >= 0) { // already delivered: just put the rest back
      items.splice(at, 1);
      if (action === 'now') items.unshift(['steer', message]); // first in line for the running turn
      if (action === 'edit') restoreDraft(id, message, imagesOf(id, message));
    }
    const failed = [];
    for (const [m, t] of items) {
      const images = imagesOf(id, t).map(({type, data, mimeType}) => ({type, data, mimeType}));
      try { await post('/api/send', {id, message: t, ...(images.length ? {images} : {}), ...(m === 'followUp' ? {mode: 'followUp'} : {})}); }
      catch { failed.push(t); restoreDraft(id, t, imagesOf(id, t)); }
    }
    if (failed.length) add('note', `Could not re-queue ${plural(failed.length, 'message')}; ${failed.length === 1 ? 'it is' : 'they are'} back in the message box.`);
  } catch (err) { add('note', err.message); }
}

function handle(r) {
  $('log').querySelector('.blank')?.remove();
  if (r.type === 'message_start' && r.message.role === 'assistant') current = null;
  else if (r.type === 'message_update' && ['text_delta', 'text_end', 'thinking_delta', 'thinking_end'].includes(r.assistantMessageEvent?.type)) updateAssistant(r.assistantMessageEvent);
  else if (r.type === 'message_end') {
    if (r.message.role === 'user') { queuedImages.get(sel?.id)?.delete(text(r.message.content)); message('user', r.message.content); }
    else if (r.message.role === 'assistant') {
      // Completed content is authoritative, even when it differs from the streamed deltas. Tool calls arrive as execution events.
      const ctx = current ?? newMessage(), content = r.message.content ?? [];
      content.forEach((part, index) => place(ctx, index, part, false));
      for (const [index, block] of ctx.blocks) {
        const part = content[index];
        if (!(part?.type === 'text' ? part.text : part?.type === 'thinking' && part.thinking)) { pendingRender.delete(block.node); block.node.remove(); }
      }
      if (ctx.text && !ctx.text.hasChildNodes()) ctx.text.remove();
      if (r.message.errorMessage) { settle(); add('note', r.message.errorMessage); }
      current = null;
    }
  } else if (r.type === 'queue_update') renderQueued(r);
  else if (r.type === 'tool_execution_start') tool(r.toolCallId, r.toolName, r.args);
  else if (r.type === 'tool_execution_end') finish(r.toolCallId, r.toolName, r.result, r.isError);
  else if (r.type === 'extension_ui_request') {
    if (r.method === 'notify') aside('note ext', r.message);
    else if (r.method === 'setStatus') { r.statusText ? view.statuses.set(r.statusKey, r.statusText) : view.statuses.delete(r.statusKey); if (r.statusKey === 'apex-pair') renderRoute(); }
    else if (r.method === 'setWidget') r.widgetLines?.length ? view.widgets.set(r.widgetKey, r.widgetLines) : view.widgets.delete(r.widgetKey);
    else if (['select', 'confirm', 'input', 'editor'].includes(r.method)) stateSig = '', refresh();
  } else if (r.type === 'response') {
    if (!r.success) add('note', r.error);
    else if (r.command === 'get_messages') {
      for (const m of r.data.messages) {
        if (m.role === 'user') message('user', m.content);
        else if (m.role === 'assistant') { const ctx = newMessage(); m.content.forEach((p, i) => p.type === 'toolCall' ? tool(p.id, p.name, p.arguments) : place(ctx, i, p, false)); }
        else if (m.role === 'toolResult') finish(m.toolCallId, m.toolName, m, m.isError);
      }
      settle();
    } else if (r.command === 'get_session_stats') view.stats = r.data;
    else if (r.command === 'get_commands') view.commands = r.data.commands ?? [];
  } else if (r.type === 'dashboard_auto_approved') approval(String(r.message ?? ''));
  else if (r.type === 'dashboard_exit') {
    settle(); renderQueued(queueSnapshot, true);
    add(r.code === 0 ? 'note quiet' : 'note', r.code === 0 ? 'Session ended. Pick it under Saved to read it or resume it.' : `The agent stopped (exit ${r.code}).\n${r.stderr}`);
  }
  if (r.type === 'agent_end' || r.type === 'agent_settled') settle();
  if (r.type === 'agent_start' || r.type === 'agent_settled' || r.type === 'dashboard_exit') { stateSig = ''; refresh(); }
  if (!$('log').children.length && sel) blank();
  queueInfo();
}
function blank() {
  const d = el('div', 'blank');
  if (sel) d.append(el('h3', '', 'Ready'), el('p', '', 'Describe the task below. Edits appear here as reviewable diffs.'));
  else d.append(el('h3', '', state.workspaces.length ? 'No session open' : 'Add your first workspace'), el('p', '', state.workspaces.length ? 'Pick a session on the left, or choose New session under a workspace.' : 'A workspace is a project folder. Use Add workspace at the top left.'));
  $('log').append(d);
}

/* approvals the agent is waiting on */
function renderAsks() {
  const pending = sel?.pending ?? [], sig = pending.map(p => p.id).join();
  if (sig === asksSig) return;
  asksSig = sig; $('asks').replaceChildren();
  for (const q of pending) {
    const box = el('section', 'ask'), opts = el('div', 'opts');
    box.setAttribute('aria-label', 'Question from the agent'); box.append(el('h3', '', q.title || 'The agent needs an answer'));
    const answer = body => post('/api/ui-response', {id: sel.id, requestId: q.id, ...body}).then(() => { stateSig = ''; refresh(); }, e => { add('note', e.message); stateSig = ''; refresh(); });
    if (q.message) box.append(el('p', '', q.message));
    if (q.method === 'confirm') {
      const yes = el('button', 'btn primary', 'Allow'), no = el('button', 'btn', 'Deny');
      yes.type = no.type = 'button'; yes.onclick = () => answer({confirmed: true}); no.onclick = () => answer({confirmed: false}); opts.append(yes, no);
      if (q.title === 'Confirm tool action') {
        const all = el('button', 'btn quiet', 'Allow all in this session'); all.type = 'button'; all.onclick = () => autoApprove(true); opts.append(all);
      }
    } else if (q.method === 'select') {
      for (const o of q.options ?? []) { const b = el('button', 'btn', typeof o === 'string' ? o : o.label ?? o.value); b.type = 'button'; b.onclick = () => answer({value: typeof o === 'string' ? o : o.value ?? o.label}); opts.append(b); }
      const c = el('button', 'btn quiet', 'Cancel'); c.type = 'button'; c.onclick = () => answer({cancelled: true}); opts.append(c);
    } else {
      const field = q.method === 'editor' ? el('textarea') : el('input'); field.value = q.prefill ?? ''; field.placeholder = q.placeholder ?? ''; field.setAttribute('aria-label', q.title || 'Answer');
      const ok = el('button', 'btn primary', 'Submit'), c = el('button', 'btn quiet', 'Cancel'); ok.type = c.type = 'button';
      ok.onclick = () => answer({value: field.value}); c.onclick = () => answer({cancelled: true}); box.append(field); opts.append(ok, c);
    }
    box.append(opts); $('asks').append(box);
  }
}

/* details column */
let infoTimer = 0;
function queueInfo() { if (!infoTimer) infoTimer = setTimeout(() => { infoTimer = 0; renderInfo(); }, 150); }
const section = (panel, title) => panel.append(el('h3', '', title));
const hint = (panel, words) => panel.append(el('p', 'empty', words));
const MARK = {done: '\u2713', in_progress: '\u25B6', dropped: '\u00D7', pending: '\u25CB'};
function renderInfo() {
  const plan = $('p-plan'), use = $('p-use'), cmd = $('p-cmd');
  plan.replaceChildren(); section(plan, 'Todo');
  if (view.todos.size) {
    const ul = el('ul', 'todo');
    for (const t of view.todos.values()) {
      const li = el('li', t.status), mark = el('span', 'mark', MARK[t.status] ?? MARK.pending); mark.setAttribute('aria-label', t.status.replace('_', ' '));
      li.append(mark, el('span', '', t.text + (t.reason ? ` (dropped: ${t.reason})` : ''))); ul.append(li);
    }
    plan.append(ul);
  } else hint(plan, 'No todos yet. The agent fills this in when the Todo list feature is on.');
  section(plan, 'Acceptance criteria');
  if (view.contract?.length) { const ul = el('ul', 'todo'); for (const c of view.contract) { const li = el('li'); li.append(el('span', 'mark', '\u25CB'), el('span', '', c.requirement)); ul.append(li); } plan.append(ul); }
  else hint(plan, 'None set. Turn on Acceptance criteria to track them.');
  section(plan, 'Files changed');
  if (view.files.size) { const ul = el('ul', 'files'); for (const [path, f] of view.files) { const li = el('li'), name = el('span', '', path); name.title = path; li.append(name, el('span', f.plus ? 'plus' : '', `+${f.plus}`), el('span', 'minus', `\u2212${f.minus}`)); ul.append(li); } plan.append(ul); }
  else hint(plan, 'No edits yet.');
  const statuses = [...view.statuses].filter(([key]) => key !== 'apex-pair').map(([, t]) => t); // the route strip shows the pair's phase
  if (statuses.length || view.widgets.size) {
    section(plan, 'From extensions');
    for (const t of statuses) plan.append(el('p', '', t));
    for (const lines of view.widgets.values()) plan.append(el('p', '', lines.join('\n')));
    plan.lastChild.style.whiteSpace = 'pre-wrap';
  }

  use.replaceChildren(); section(use, 'This session');
  const s = view.stats;
  if (!sel) hint(use, 'Open a session to see its usage.');
  else if (!s) hint(use, sel.viewOnly ? 'Resume the session to see its usage.' : 'Usage appears after the first turn.');
  else {
    const pct = s.contextUsage?.percent, t = s.tokens ?? {};
    const kv = el('table', 'kv');
    for (const [k, v] of [['Total tokens', t.total], ['Input', t.input], ['Output', t.output], ['Cache read', t.cacheRead], ['Cache write', t.cacheWrite]]) if (v != null) { const tr = el('tr'); tr.append(el('td', '', k), el('td', '', Number(v).toLocaleString())); kv.append(tr); }
    const tr = el('tr'); tr.append(el('td', '', 'Catalog cost estimate'), el('td', '', usd(Number(s.cost) || 0))); kv.append(tr); use.append(kv);
    if (pct != null) {
      const m = el('div', 'meter' + (pct >= 80 ? ' hot' : '')); m.setAttribute('role', 'meter'); m.setAttribute('aria-valuenow', Math.round(pct)); m.setAttribute('aria-valuemin', 0); m.setAttribute('aria-valuemax', 100); m.setAttribute('aria-label', 'Context window used');
      const i = el('i'); i.style.width = Math.min(100, pct) + '%'; m.append(i);
      section(use, 'Context window'); use.append(m, el('small', '', `${Math.round(pct)}% used` + (pct >= 80 ? '. Consider starting a fresh session.' : '')));
    }
    const rb = el('button', 'btn', 'Load token breakdown'); rb.type = 'button'; rb.style.marginTop = '14px';
    rb.onclick = async () => { rb.disabled = true; try { view.report = await (await fetch('/api/report?id=' + sel.id)).json(); if (view.report.error) throw new Error(view.report.error); } catch (e) { view.report = {error: e.message}; } renderInfo(); };
    if (!view.report) use.append(rb);
    else if (view.report.error) use.append(el('p', 'note', view.report.error));
    else {
      const sum = view.report.summary; section(use, 'Where tokens went');
      const kv2 = el('table', 'kv');
      for (const [k, v] of Object.entries(sum.categories ?? {})) if (v?.estimatedTokens > 0) { const row = el('tr'); row.append(el('td', '', k), el('td', '', '~' + Math.round(v.estimatedTokens).toLocaleString())); kv2.append(row); }
      use.append(kv2, el('small', '', 'Estimated from stored text size. Not exact input attribution.'));
    }
  }
  const rows = usageRows();
  if (rows.length) section(use, 'Subscription usage');
  for (const p of rows) {
    if (p.error) { use.append(el('p', 'note', `${p.label}: usage unavailable. Sign in again if this persists.`)); continue; }
    const kv = el('table', 'kv');
    for (const l of p.limits) { const tr = el('tr'); tr.append(el('td', '', `${p.label} ${limitName(p, l)}`), el('td', '', percent(l) + (l.resetsAt ? `, resets in ${until(l.resetsAt)}` : ''))); kv.append(tr); }
    use.append(kv);
  }

  cmd.replaceChildren(); section(cmd, 'Commands');
  if (!view.commands.length) hint(cmd, sel ? 'No commands reported yet.' : 'Open a session to see its commands.');
  for (const c of view.commands) {
    const b = el('button', 'cmdrow'); b.type = 'button'; const name = '/' + c.name.replace(/^\//, '');
    b.append(el('b', '', name), el('small', '', c.description ?? '')); b.onclick = () => { $('box').value = name + ' '; syncComposer(); $('box').focus(); document.body.dataset.pane = 'chat'; };
    cmd.append(b);
  }
}
for (const t of document.querySelectorAll('.tabs button')) t.onclick = () => {
  for (const o of document.querySelectorAll('.tabs button')) { o.setAttribute('aria-selected', String(o === t)); $(o.getAttribute('aria-controls')).hidden = o !== t; }
};
for (const b of document.querySelectorAll('#panes button')) b.onclick = () => { document.body.dataset.pane = b.dataset.pane; };

/* composer: drafts and attachments belong to a session, including during asynchronous reads/sends. */
const acceptsImages = () => (sel?.input ?? modelById(sel?.model)?.input ?? []).includes('image');
const canCompose = () => sel && ['idle', 'running'].includes(sel.status) && !missingLogin(sel);
function syncComposer() {
  const draft = sel ? sessionDraft(sel.id) : null, ready = canCompose(), vision = acceptsImages();
  const enhancing = sel ? enhance.get(sel.id) : null;
  $('box').disabled = !ready || Boolean(draft?.sending);
  $('box').readOnly = Boolean(enhancing); // the draft is about to be replaced
  $('send').disabled = !ready || Boolean(draft?.sending || draft?.reading || enhancing) || (!vision && Boolean(draft?.images.length)) || (!$('box').value.trim() && !draft?.images.length);
  $('attach').disabled = $('image-files').disabled = !ready || !vision || Boolean(draft?.sending || draft?.reading) || (draft?.images.length ?? 0) >= MAX_IMAGES;
  $('enhance').disabled = !enhancing && (!ready || Boolean(draft?.sending || draft?.reading) || enhanceBlocked($('box').value));
  $('enhance').textContent = enhancing ? '✕' : '✨';
  $('enhance').setAttribute('aria-label', enhancing ? 'Cancel enhance' : 'Enhance prompt');
  $('enhance').title = enhancing ? 'Stop enhancing (Ctrl+Shift+E)' : 'Rewrite this draft with project context (Ctrl+Shift+E)';
  $('send').textContent = draft?.sending ? 'Sending…' : sel?.status === 'running' ? 'Steer' : 'Send';
  $('queue-send').hidden = sel?.status !== 'running'; $('queue-send').disabled = $('send').disabled;
  $('attachment-hint').textContent = !sel ? 'Open a session to attach images.' : !vision ? `${routeWords(sel, false)} ${sel.model === PAIR ? 'accept' : 'accepts'} text only, so images are unavailable.` : IMAGE_HELP + ' Paste or drop images here.';
  const status = enhancing ? `Enhancing with ${enhancing.model} · ${enhancing.step || 'starting'}…` : draft?.reading ? 'Preparing images…' : draft?.images.length ? `${draft.images.length} image${draft.images.length === 1 ? '' : 's'} attached.` : '';
  $('attachment-status').textContent = status; $('attachment-status').hidden = !status;
  $('composer-error').textContent = draft?.error || ''; $('composer-error').hidden = !draft?.error;
  renderRoute();
}
function renderAttachments() {
  const list = $('attachments'), draft = sel ? sessionDraft(sel.id) : null;
  list.replaceChildren(); list.hidden = !draft?.images.length;
  for (const image of draft?.images ?? []) {
    const item = el('div', 'attachment'); item.setAttribute('role', 'listitem');
    const preview = el('button', 'image-preview'), img = el('img'); preview.type = 'button'; preview.setAttribute('aria-label', 'Preview ' + image.name);
    img.src = imageDataUrl(image); img.alt = image.name; preview.append(img); preview.onclick = () => openImage(img.src, img.alt);
    const info = el('div', 'attachment-info'), name = el('small', '', image.name); name.title = image.name;
    const remove = el('button', 'ghost', 'Remove'); remove.type = 'button'; remove.disabled = draft.sending;
    remove.setAttribute('aria-label', 'Remove ' + image.name);
    remove.onclick = () => { draft.images = draft.images.filter(i => i !== image); draft.error = ''; renderAttachments(); syncComposer(); $('attach').focus(); };
    info.append(name, remove); item.append(preview, info); list.append(item);
  }
}
function readImage(file) {
  return new Promise((resolveImage, rejectImage) => {
    const reader = new FileReader();
    reader.onload = () => resolveImage({type: 'image', mimeType: fileImageType(file), data: String(reader.result).split(',')[1], name: file.name || 'Pasted image', bytes: file.size});
    reader.onerror = reader.onabort = () => rejectImage(new Error('Could not read the image. Choose it again.'));
    reader.readAsDataURL(file);
  });
}
async function attachImages(files) {
  const picked = [...files]; if (!picked.length || !sel) return;
  const id = sel.id, draft = sessionDraft(id);
  let reading = false;
  try {
    if (!canCompose()) throw new Error('Open an active session and sign in before attaching images.');
    if (!acceptsImages()) throw new Error('This model does not support images. Start a session with an image-capable model.');
    if (draft.sending || draft.reading) throw new Error('Wait for the current message or images to finish preparing.');
    if (draft.images.length + picked.length > MAX_IMAGES) throw new Error('Attach up to 4 images per message.');
    for (const file of picked) {
      if (!IMAGE_TYPES.includes(fileImageType(file))) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
      if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error('Each image must be nonempty and 5 MB or smaller.');
    }
    if ([...draft.images, ...picked].reduce((sum, file) => sum + (file.bytes ?? file.size), 0) > MAX_TOTAL_IMAGE_BYTES) throw new Error('Images must total 10 MB or less. Remove an image or choose smaller files.');
    draft.error = ''; reading = true; draft.reading = picked.length; syncComposer();
    const images = await Promise.all(picked.map(readImage));
    validateImages([...draft.images, ...images]); draft.images.push(...images); draft.error = '';
  } catch (error) { draft.error = error.message; }
  finally { if (reading) draft.reading = 0; if (sel?.id === id) { renderAttachments(); syncComposer(); } }
}
$('attach').onclick = () => $('image-files').click();
$('image-files').onchange = () => { const files = [...$('image-files').files]; $('image-files').value = ''; attachImages(files); };
$('box').onpaste = e => {
  const files = [...(e.clipboardData?.items ?? [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); attachImages(files); }
};

/* ✨ enhance prompt: a read-only agent run rewrites the draft with project context; nothing is sent automatically. */
let toastTimer = 0;
function toast(text, action) {
  const t = $('toast'); t.replaceChildren(el('span', '', text));
  if (action) { const b = el('button', 'btn', action.label); b.type = 'button'; b.onclick = () => { t.hidden = true; action.run(); }; t.append(b); }
  t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 10000);
}
// insertText keeps the swap on the browser's undo stack (Ctrl+Z); plain assignment is the fallback.
function replaceDraft(text) {
  const box = $('box'); box.focus(); box.select();
  if (!document.execCommand('insertText', false, text)) box.value = text;
  box.selectionStart = box.selectionEnd = box.value.length;
  sessionDraft(sel.id).message = box.value; syncComposer();
}
function applyEnhanced(id, original, text) {
  if (sel?.id !== id) { enhanced.set(id, {original, text}); return; }
  // The draft changed meanwhile: offer the result instead of overwriting.
  if ($('box').value !== original) return toast('Enhanced prompt ready', {label: 'Use enhanced prompt', run: () => { if (sel?.id === id) replaceDraft(text); }});
  replaceDraft(text);
  toast('Prompt enhanced', {label: 'Undo', run: () => { if (sel?.id === id) replaceDraft(original); }});
}
function enhanceFailed(id, job, message) {
  if (enhance.get(id) !== job) return;
  enhance.delete(id); sessionDraft(id).error = message;
  if (sel?.id === id) syncComposer();
}
async function pollEnhance(id, job) {
  let r;
  try { r = await (await fetch('/api/enhance?id=' + encodeURIComponent(job.id))).json(); if (r.error && !r.status) throw new Error(r.error); }
  catch (error) { return enhanceFailed(id, job, error.message); }
  if (enhance.get(id) !== job) return;
  if (r.status === 'running') { job.step = r.step; if (sel?.id === id) syncComposer(); setTimeout(() => pollEnhance(id, job), 500); return; }
  if (r.status === 'error') return enhanceFailed(id, job, r.error || 'Enhance failed.');
  enhance.delete(id); if (sel?.id === id) syncComposer();
  if (r.status === 'done') applyEnhanced(id, job.original, r.text);
}
async function toggleEnhance() {
  if (!sel) return;
  const id = sel.id, running = enhance.get(id);
  if (running) { enhance.delete(id); if (running.id) post('/api/enhance/stop', {id: running.id}).catch(() => {}); syncComposer(); return; } // cancelling is silent
  if ($('enhance').disabled) return;
  const job = {id: null, original: $('box').value, model: modelLabel(sel.model), step: ''};
  enhance.set(id, job); sessionDraft(id).error = ''; syncComposer();
  let r;
  try { r = await post('/api/enhance', {id, text: job.original}); }
  catch (error) { return enhanceFailed(id, job, error.message); }
  if (enhance.get(id) !== job) { post('/api/enhance/stop', {id: r.id}).catch(() => {}); return; } // cancelled while starting
  Object.assign(job, {id: r.id, model: r.model}); if (sel?.id === id) syncComposer();
  pollEnhance(id, job);
}
$('enhance').onclick = toggleEnhance;
let dragDepth = 0;
const draggingFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
$('chat').ondragenter = e => { if (draggingFiles(e)) { e.preventDefault(); dragDepth++; if (canCompose() && acceptsImages()) $('form').classList.add('dropping'); } };
$('chat').ondragover = e => { if (draggingFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = canCompose() && acceptsImages() ? 'copy' : 'none'; } };
$('chat').ondragleave = () => { if (--dragDepth <= 0) { dragDepth = 0; $('form').classList.remove('dropping'); } };
$('chat').ondrop = e => { if (draggingFiles(e)) { e.preventDefault(); dragDepth = 0; $('form').classList.remove('dropping'); attachImages(e.dataTransfer.files); } };
function openImage(src, alt) {
  const img = el('img'); img.id = 'image-viewer-img'; img.src = src; img.alt = alt;
  $('image-viewer-body').replaceChildren(img); $('image-viewer-title').textContent = alt || 'Image preview';
  $('image-viewer').showModal();
}
$('image-viewer-close').onclick = () => $('image-viewer').close();
$('image-viewer').onclose = () => $('image-viewer-body').replaceChildren();
$('log').addEventListener('click', e => { const img = e.target.closest('.image-preview')?.querySelector('img'); if (img) openImage(img.src, img.alt); });

const slash = $('slash'); let slashAt = 0;
function slashMatches() { const m = /^\/(\S*)$/.exec($('box').value); return m ? view.commands.filter(c => c.name.replace(/^\//, '').startsWith(m[1])) : []; }
function drawSlash() {
  const list = slashMatches(); slash.replaceChildren(); slash.hidden = !list.length; slashAt = Math.min(slashAt, Math.max(0, list.length - 1));
  list.forEach((c, i) => { const li = el('li'), name = '/' + c.name.replace(/^\//, ''); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(i === slashAt)); li.append(el('b', '', name), el('small', '', c.description ?? '')); li.onmousedown = e => { e.preventDefault(); pick(name); }; slash.append(li); });
}
function pick(name) { $('box').value = name + ' '; slash.hidden = true; syncComposer(); $('box').focus(); }
$('box').oninput = () => { if (sel) { const draft = sessionDraft(sel.id); draft.message = $('box').value; draft.error = ''; } slashAt = 0; drawSlash(); syncComposer(); };
$('box').onkeydown = e => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); toggleEnhance(); return; }
  const list = slashMatches();
  if (!slash.hidden && list.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); slashAt = (slashAt + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; drawSlash(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && list.length && $('box').value !== '/' + list[slashAt].name.replace(/^\//, ''))) { e.preventDefault(); pick('/' + list[slashAt].name.replace(/^\//, '')); return; }
    if (e.key === 'Escape') { slash.hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('form').requestSubmit(e.altKey && !$('queue-send').hidden ? $('queue-send') : undefined); }
};
$('form').onsubmit = async e => {
  e.preventDefault(); if (!canCompose()) return;
  const id = sel.id, draft = sessionDraft(id), messageText = $('box').value.trim(), followUp = e.submitter?.value === 'followUp';
  if (draft.sending || draft.reading || enhance.has(id) || (!messageText && !draft.images.length)) return;
  draft.message = $('box').value; draft.sending = true; draft.error = ''; syncComposer(); renderAttachments();
  try {
    const images = draft.images.map(({type, data, mimeType}) => ({type, data, mimeType}));
    if (sel.status === 'running' && draft.images.length) { // queued, not started: the queue bar needs to know
      if (!queuedImages.has(id)) queuedImages.set(id, new Map());
      queuedImages.get(id).set(messageText, [...draft.images]);
    }
    await post('/api/send', {id, message: messageText, ...(images.length ? {images} : {}), ...(followUp ? {mode: 'followUp'} : {})});
    draft.message = ''; draft.images = [];
    if (sel?.id === id) { $('box').value = ''; slash.hidden = true; }
  } catch (err) { draft.error = err.message; if (sel?.id === id) add('note', err.message); }
  finally { draft.sending = false; if (sel?.id === id) { renderAttachments(); syncComposer(); if (canCompose()) $('box').focus(); } }
  setTimeout(() => { stateSig = ''; refresh(); }, 300);
};
$('stop').onclick = () => post('/api/abort', {id: sel.id});
const autoApprove = on => post('/api/auto-approve', {id: sel.id, on}).then(() => { stateSig = ''; refresh(); }, e => add('note', e.message));
$('auto').onclick = () => autoApprove(!sel.autoApprove);
$('end').onclick = async () => { await post('/api/stop', {id: sel.id}); setTimeout(() => { stateSig = ''; refresh(); }, 800); };
$('resume').onclick = () => openLaunch(sel.cwd, sel.file, sel.title);

/* workspaces */
const wsdlg = $('wsdlg');
$('addws').onclick = () => { $('ws-error').textContent = ''; $('wspath').value = ''; wsdlg.showModal(); $('wspath').focus(); };
$('ws-cancel').onclick = () => wsdlg.close();
$('pick').onclick = async () => { $('pick').disabled = true; try { const {path} = await post('/api/pick-folder', {}); if (path) $('wspath').value = path; } catch (e) { $('ws-error').textContent = e.message; } $('pick').disabled = false; };
$('ws-form').onsubmit = async e => {
  e.preventDefault();
  try { await post('/api/workspaces', {path: $('wspath').value.trim()}); wsdlg.close(); stateSig = ''; refresh(); }
  catch (err) { $('ws-error').textContent = err.message + '. Check the path exists and is a folder.'; }
};

/* the route strip above the message box, and the dialog that changes a running session's models */
function renderRoute() {
  const strip = $('route'); strip.replaceChildren();
  const alive = sel && ['idle', 'running'].includes(sel.status);
  $('settings-note').textContent = sel?.lock ?? ''; $('settings-note').hidden = !sel?.lock;
  if (!sel) return;
  const r = routeOf(sel), status = view.statuses.get('apex-pair') ?? '';
  const phase = r.mode !== 'pair' ? '' : / building$/.test(status) ? 'build' : status ? 'plan' : '';
  const slots = r.mode === 'pair' ? [['plan', r.plan], ['build', r.build]] : [['single', r]];
  for (const [slot, value] of slots) {
    const b = el('button', 'chip ' + slot); b.type = 'button'; b.disabled = !alive || Boolean(sel.lock);
    const role = r.mode === 'pair' ? SLOT_WORDS[slot][0] : '';
    b.setAttribute('aria-label', `${role ? role + ' model' : 'Model'}: ${modelLabel(value.model)} at ${value.thinking} thinking.${phase === slot ? ' Working now.' : ''} Change models`);
    if (phase === slot) b.classList.add('now');
    if (role) b.append(el('span', 'role', role));
    b.append(el('span', 'name', shortName(value.model)), ladder(levelsOf(modelById(value.model)), value.thinking, {compact: true, role: slot}), el('span', 'level', value.thinking));
    b.title = sel.lock ?? (phase === slot ? 'Working now. ' : '') + 'Change models';
    b.onclick = () => openRoute(slot);
    if (slot === 'build') strip.append(el('span', 'then', '→'));
    strip.append(b);
  }
}
const routeDialog = $('routedlg');
const routeEditor = createEditor($('route-editor'), {
  allow: (m, mode) => !m || mode === 'pair' || !sel?.target || pairable(m), // the Windows target stays on signed-in models
  onchange: () => syncRoute(),
});
function openRoute(slot) {
  if (!sel || sel.lock) return;
  $('route-error').textContent = ''; $('route-where').textContent = sel.title || sel.cwd;
  const r = routeOf(sel); routeEditor.set(r, slot === 'single' ? undefined : slot);
  syncRoute(); routeDialog.showModal(); routeDialog.querySelector('.slot[aria-pressed=true]')?.focus();
}
let routeBusy = false;
function syncRoute() {
  if (!sel || !routeEditor.route) return;
  const r = routeEditor.route, before = routeOf(sel), restart = r.mode === 'pair' && !samePair(r, sel.pair), running = sel.status === 'running';
  $('route-go').textContent = restart ? 'Restart with these models' : 'Switch now';
  $('route-go').disabled = routeBusy || sameRoute(r, before) || (restart && running);
  $('route-effect').textContent = sameRoute(r, before) ? 'This is the current setup.'
    : restart ? (running ? 'Wait for this run to finish, or stop it. The new pair needs a restart.' : 'The agent restarts on this conversation with the new pair. Your Apex features stay on.')
    : running ? 'Applies from the next model call.' : 'Applies from your next message.';
  syncRouteAuth();
}
function syncRouteAuth() { authNotice($('route-auth'), routeEditor.route); }
// Sign-in buttons for every login a route needs and does not have yet.
function authNotice(box, r) {
  const needed = !r ? [] : [...new Set((r.mode === 'pair' ? [r.plan.model, r.build.model] : [r.model]).map(id => modelById(id)?.provider))].filter(p => p && !ready(p));
  box.replaceChildren(); box.hidden = !needed.length;
  if (!needed.length) return;
  box.append(el('p', '', needed.length > 1 ? 'These models need sign-ins. Apex saves each one on this computer.' : `${signInWords(auth(needed[0]))} to use this model. Apex saves it on this computer.`));
  for (const provider of needed) { const b = el('button', 'btn primary', signInWords(auth(provider))); b.type = 'button'; b.disabled = loginBusy; b.onclick = () => openAuth(provider); box.append(b); }
}
$('route-cancel').onclick = () => routeDialog.close();
$('route-form').onsubmit = async e => {
  e.preventDefault(); if (!sel || routeBusy) return;
  const r = routeEditor.route, id = sel.id;
  routeBusy = true; $('route-error').textContent = ''; syncRoute();
  try {
    const body = r.mode === 'pair' ? {pair: {plan: r.plan, build: r.build}} : {model: r.model, thinking: r.thinking};
    const fresh = await post('/api/settings', {id, ...body});
    rememberModels(r); routeDialog.close();
    const words = r.mode === 'pair' ? `${shortName(r.plan.model)} plans at ${fresh.pair?.plan.thinking ?? r.plan.thinking}, ${shortName(r.build.model)} builds at ${fresh.thinking}` : `${modelLabel(fresh.model)} at ${fresh.thinking} thinking`;
    stateSig = ''; await refresh();
    if (fresh.relaunched) {
      const next = state.workspaces.flatMap(w => w.live).find(s => s.id === fresh.id);
      if (next) { if (sel) drafts.set(next.id, sessionDraft(id)); select(next); }
      add('note quiet', `Restarted on the same conversation. Now ${words}.`);
    } else if (sel?.id === id) {
      sel = {...sel, ...fresh}; header();
      add('note quiet', `Now ${words}. ` + (sel.status === 'running' ? 'Applies from the next model call.' : 'Applies from your next message.'));
    }
  } catch (err) { $('route-error').textContent = err.message; }
  finally { routeBusy = false; syncRoute(); }
};

/* launching a session */
const launch = $('launch');
let launchFor = null, choice = (() => {
  const saved = stored('launch', {});
  return {route: saved.route ?? {mode: 'single', model: saved.model ?? 'sol', thinking: saved.thinking ?? 'xhigh'}, timeBudget: saved.timeBudget ?? 600, evalMode: Boolean(saved.evalMode), preset: saved.preset ?? 'default'};
})();
// `set` is the picks, a function resolved when the preset applies, or null for every feature the model can run.
// An unknown remembered preset (such as the earlier default `all`) falls back to the first one.
const PRESETS = [
  {id: 'default', label: 'Default', note: 'What bare apex runs on Windows: the cache ledger, path and edit checks, cost, plan, report, resume, compaction at 300k, and undo in a Git repository. The default.',
    set: () => ({...state.defaults, features: [...state.defaults.features, ...(state.workspaces.find(w => w.path === launchFor?.cwd)?.checkpoints ? ['checkpoints'] : [])]})},
  {id: 'everything', label: 'All features', note: 'Every Apex feature this model can run. Measured at about twice stock Pi\'s cost and time, with no more tasks solved.', set: null},
  {id: 'lean', label: 'Lean context', note: 'Shorter reads, searches, edits and output.', set: {context: ['shape', 'mask', 'read', 'search', 'edit'], core: [], features: []}},
  {id: 'long', label: 'Long tasks', note: 'Todos, criteria, verification and loop checks.', set: {context: [], core: ['snapshot', 'contract', 'todo', 'verify', 'loops'], features: []}},
  {id: 'daily', label: 'Everyday safety', note: 'Cost, undo, planning and approvals.', set: {context: [], core: [], features: ['cost', 'checkpoints', 'plan', 'safety', 'report', 'resume']}},
  {id: 'plain', label: 'Plain agent', note: 'No Apex features. Any thinking level.', set: {context: [], core: [], features: []}},
];
const presetPicks = p => typeof p.set === 'function' ? p.set() : p.set ?? allFeatures();
function checked(group) { return [...launch.querySelectorAll(`input[data-group="${group}"]:checked`)].map(i => i.value); }
function allFeatures() { return Object.fromEntries(['context', 'core', 'features'].map(g => [g, [...launch.querySelectorAll(`input[data-group="${g}"]`)].map(i => i.value)])); }
const launchModels = () => { const r = launchEditor.route; return !r ? [] : (r.mode === 'pair' ? [r.plan.model, r.build.model] : [r.model]).map(modelById).filter(Boolean); };
const launchApex = () => launchEditor.route?.mode === 'pair' || Boolean(launchModels()[0]?.apex);
// Eval runs and the apex/auto router keep one model at xhigh; other Apex features take any level.
const strictLaunch = () => launchApex() && ($('evalmode').checked || checked('context').includes('route'));
const launchEditor = createEditor($('launch-editor'), {strict: strictLaunch, onchange: () => syncLaunch()});
function syncLaunchAuth() { authNotice($('launch-auth'), launchEditor.route); }
function applyChoice(c) {
  for (const g of ['context', 'core', 'features']) for (const i of launch.querySelectorAll(`input[data-group="${g}"]`)) i.checked = c[g].includes(i.value);
  $('evalmode').checked = Boolean(c.evalMode); syncLaunch();
}
function syncLaunch() {
  syncLaunchAuth();
  const models = launchModels(), apex = launchApex(), first = models[0];
  $('feature-pick').hidden = !apex; $('feature-note').hidden = apex;
  $('feature-note').textContent = apex || !first ? '' : `Apex features are unavailable for ${first.label} here. ${state.models.filter(m => m.apex).length === 1 ? `They run on ${state.models.find(m => m.apex).label}.` : 'They run on Muse and, on native Windows, the signed-in models.'} This model runs as the stock agent.`;
  for (const i of launch.querySelectorAll('#features input[type=checkbox]')) {
    const unavailable = Boolean(first?.unavailable?.includes(i.value)), off = Boolean(i.dataset.blocked) || unavailable;
    if (off) i.checked = false;
    i.disabled = off; i.closest('.check')?.classList.toggle('off', off);
    const note = i.closest('.check')?.querySelector('.unavailable'); if (note) { note.hidden = !unavailable; note.textContent = `Not available with ${first.label}`; }
  }
  // Eval runs and the auto route hold one model at xhigh; the editor locks its ladder, so keep the route in step.
  const r = launchEditor.route;
  if (r?.mode === 'single' && strictLaunch() && r.thinking !== 'xhigh') { r.thinking = 'xhigh'; launchEditor.render(); }
  else launchEditor.render();
  const tb = $('timebox'); if (tb) tb.hidden = !launch.querySelector('input[value=time]')?.checked;
  let total = 0;
  for (const d of launch.querySelectorAll('.group')) { const n = d.querySelectorAll('input:checked').length; total += n; d.querySelector('em').textContent = n ? `${n} on` : ''; }
  $('feature-count').textContent = total ? `${total} on` : 'none on';
  const preset = PRESETS.find(p => launch.querySelector(`input[name=preset][value=${p.id}]`)?.checked);
  $('preset-note').textContent = preset?.note ?? 'Your own selection.';
}
function buildLaunch() {
  // A remembered route stays only while its models are listed in the picker; otherwise start on the first usable model.
  const usable = id => { const m = modelById(id); return Boolean(m) && modelReady(m); };
  const known = r => r.mode === 'pair' ? pairable(modelById(r.plan.model)) && pairable(modelById(r.build.model)) && usable(r.plan.model) && usable(r.build.model) : usable(r.model);
  launchEditor.set(known(choice.route) ? choice.route : {mode: 'single', model: (state.models.find(modelReady) ?? state.models[0])?.id, thinking: 'xhigh'});
  const ps = $('presets'); ps.replaceChildren(el('legend', 'sr', 'Start from'));
  const pw = el('div', 'presets'), preset = PRESETS.find(p => p.id === choice.preset) ?? PRESETS[0];
  for (const p of PRESETS) {
    const l = el('label'), i = el('input'); i.type = 'radio'; i.name = 'preset'; i.value = p.id; i.checked = p === preset;
    i.onchange = () => applyChoice({...choice, ...presetPicks(p)});
    l.append(i, el('span', '', p.label)); pw.append(l);
  }
  ps.append(pw);
  const fe = $('features'); fe.replaceChildren();
  for (const g of state.groups) {
    const d = el('details', 'group'), sum = el('summary'); d.open = false;
    sum.append(el('span', '', g.title), el('small', '', g.blurb), el('em')); d.append(sum);
    const items = el('div', 'items');
    for (const f of g.features) {
      const l = el('label', 'check'), i = el('input'); i.type = 'checkbox'; i.value = f.flag; i.dataset.group = g.id;
      i.onchange = () => { for (const r of launch.querySelectorAll('input[name=preset]')) r.checked = false; syncLaunch(); };
      if (f.blocked) { i.dataset.blocked = '1'; }
      const s = el('span'); s.append(el('b', '', f.label), el('small', '', f.summary));
      const limit = f.blocked ? 'Blocked by the offline-only policy' : f.limited; if (limit) s.append(el('small', 'limit', limit));
      const na = el('small', 'limit unavailable'); na.hidden = true; s.append(na);
      l.append(i, s); items.append(l);
      if (f.needs === 'timeBudget') {
        const t = el('label', 'field timebox'); t.id = 'timebox'; t.append(document.createTextNode('Time budget in seconds'));
        const n = el('input'); n.type = 'number'; n.id = 'timebudget'; n.min = 1; n.max = 86400; n.value = choice.timeBudget ?? 600; t.append(n); items.append(t);
      }
    }
    d.append(items); fe.append(d);
  }
  applyChoice({...choice, ...presetPicks(preset)});
}
function openLaunch(cwd, file, title) {
  launchFor = {cwd, file}; $('launch-error').textContent = '';
  $('launch-h').textContent = file ? 'Resume session' : 'New session';
  $('launch-where').textContent = (file ? title + '. ' : '') + cwd;
  $('launch-go').textContent = file ? 'Resume session' : 'Start session';
  buildLaunch(); launch.showModal(); launch.querySelector('.slot')?.focus();
}
$('launch-cancel').onclick = () => launch.close();
$('launch-form').onsubmit = async e => {
  e.preventDefault(); const r = launchEditor.route, go = $('launch-go');
  const apex = launchApex(), pickedFor = group => apex ? checked(group) : [];
  const route = r.mode === 'pair' ? {pair: {plan: r.plan, build: r.build}} : {model: r.model, thinking: r.thinking};
  const body = {...launchFor, ...route, context: pickedFor('context'), core: pickedFor('core'), features: pickedFor('features'),
    timeBudget: Number($('timebudget')?.value), evalMode: apex && $('evalmode').checked};
  go.disabled = true;
  try {
    const {id} = await post('/api/start', body);
    const preset = launch.querySelector('input[name=preset]:checked')?.value ?? choice.preset;
    choice = {route: structuredClone(r), timeBudget: body.timeBudget || 600, evalMode: body.evalMode, preset};
    try { localStorage.launch = JSON.stringify(choice); } catch { /* remembered choices are a convenience */ }
    rememberModels(r);
    stateSig = ''; await refresh(); launch.close();
    const s = state.workspaces.flatMap(w => w.live).find(x => x.id === id); if (s) select(s);
  } catch (err) { $('launch-error').textContent = err.message; }
  go.disabled = false;
};

/* theme: a per-browser preference; the inline script in index.html applies it before first paint */
$('theme').value = stored('theme', 'dark');
$('theme').onchange = () => {
  const theme = $('theme').value;
  try { localStorage.theme = JSON.stringify(theme); } catch { /* storage blocked: the choice lasts until reload */ }
  if (theme === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme);
};

refresh().then(renderInfo); setInterval(refresh, 3000);
setInterval(() => { for (const t of document.querySelectorAll('[data-since]')) t.textContent = 'Running ' + dur(Date.now() - t.dataset.since); }, 1000);
