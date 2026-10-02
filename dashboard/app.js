import {renderMarkdown, renderMessage} from './chat-content.mjs';
import {fileImageType, imageDataUrl, validateImages, IMAGE_TYPES, IMAGE_HELP, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES} from './attachments.mjs';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const post = (path, body) => fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
  .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; });
const ago = ms => { const m = Math.max(0, (Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? Math.round(m) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const base = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
const usd = n => '$' + (n < 0.1 ? n.toFixed(4) : n.toFixed(2));
const stored = (key, fallback) => { try { return JSON.parse(localStorage[key]) ?? fallback; } catch { return fallback; } };

let state = {workspaces: [], models: [], groups: []}, stateSig = '', sel = null, source = null, current = null;
let tools = new Map(), toolArgs = new Map(), view = newView(), seen = stored('seen', {}), asksSig = '';
const drafts = new Map(), pendingMarkdown = new Map();
let markdownTimer = 0;
const sessionDraft = id => { if (!drafts.has(id)) drafts.set(id, {message: '', images: [], reading: 0, sending: false, error: ''}); return drafts.get(id); };
const modelLabel = id => state.models.find(m => m.id === id)?.label ?? id ?? '';

function newView() { return {todos: new Map(), contract: null, files: new Map(), stats: null, commands: [], statuses: new Map(), widgets: new Map(), report: null}; }

let loginPopup = null, loginPopupFlow = null, loginBusy = false, authFor = 'openai-codex';
const auth = provider => state.auth?.[provider];
const providerOf = s => s?.provider ?? state.models.find(m => m.id === s?.model)?.provider;
// Signed in, or a provider the dashboard does not manage (OpenRouter reads its key from the environment).
const ready = provider => !auth(provider) || auth(provider).signedIn;
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
  const need = sel && !ready(providerOf(sel)) ? auth(providerOf(sel)) : null;
  $('login-needed').hidden = !need;
  if (need) { $('login-needed-text').textContent = `${signInWords(need)} to send messages. It is saved for future sessions.`; $('login-needed-button').textContent = signInWords(need); }
  syncLaunchAuth(); renderAuthDialog();
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
  for (const id of ['auth-retry', 'auth-signout', 'login-needed-button', 'launch-login']) $(id).disabled = loginBusy;
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
$('login-needed-button').onclick = () => openAuth(providerOf(sel));
$('launch-login').onclick = () => openAuth(chosenModel()?.provider);
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
  if (s.pending.length) return ['asks', 'Asks you'];
  if (s.status === 'running') return ['running', 'Working'];
  if (s.settled > (seen[s.id] ?? 0) && s.id !== sel?.id) return ['finished', 'Finished'];
  return ['idle', 'Idle'];
}
const meta = s => [label(s)[1], modelLabel(s.model), s.thinking].filter(Boolean).join(', ');

function sessionButton(s, onclick, extra) {
  const b = el('button', 'row'), [kind, words] = label(s);
  b.type = 'button'; b.setAttribute('aria-current', String(s.id === sel?.id));
  const small = el('small'); small.append(el('span', 'st ' + kind, words), document.createTextNode(extra ?? ', ' + modelLabel(s.model) + ' ' + s.thinking));
  b.append(el('b', '', s.title || 'New session'), small); b.onclick = onclick;
  return b;
}

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
    const h = el('h3', '', base(w.path)); h.title = w.path;
    const small = el('small', 'ws-path', w.path); small.title = w.path; title.append(h);
    const add = el('button', 'ghost', 'New session'); add.type = 'button'; add.setAttribute('aria-label', 'New session in ' + base(w.path)); add.onclick = () => openLaunch(w.path);
    const more = el('button', 'ghost more', 'More'); more.type = 'button'; more.setAttribute('aria-expanded', 'false');
    const menu = el('div'); menu.hidden = true;
    const reveal = el('button', 'ghost', 'Show in file explorer'); reveal.type = 'button'; reveal.onclick = () => post('/api/reveal', {path: w.path}).catch(e => alert(e.message));
    const remove = el('button', 'ghost more', 'Remove from list'); remove.type = 'button'; remove.title = 'Files and sessions stay on disk';
    remove.onclick = async () => { if (confirm(`Remove ${base(w.path)} from the list? Files and sessions stay on disk.`)) { await post('/api/workspaces/remove', {path: w.path}); refresh(); } };
    menu.append(reveal, remove);
    more.onclick = () => { menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); };
    head.append(title, add, more); sec.append(head, small, menu);
    for (const s of w.live) sec.append(sessionButton(s, () => select(s)));
    for (const s of w.saved) {
      const b = el('button', 'row'); b.type = 'button';
      const m = el('small'); m.append(el('span', 'st saved', 'Saved'), document.createTextNode(', ' + ago(s.mtime)));
      b.append(el('b', '', s.title), m); b.onclick = () => openLaunch(w.path, s.file, s.title); sec.append(b);
    }
    if (!w.live.length && !w.saved.length) sec.append(el('p', 'empty', 'No sessions yet.'));
    groups.append(sec);
  }
  const usage = state.codexUsage;
  $('codex-usage').textContent = usage ? `Codex usage estimate: ${usd(usage.used)}. No Apex spending cap.` : '';
}

async function refresh() {
  let data;
  try { data = await (await fetch('/api/state')).json(); } catch { return; }
  const sig = JSON.stringify(data);
  if (sig === stateSig) return;
  stateSig = sig; state = data;
  const fresh = state.workspaces.flatMap(w => w.live).find(s => s.id === sel?.id);
  if (fresh) { sel = fresh; seen[sel.id] = sel.settled; localStorage.seen = JSON.stringify(seen); }
  else if (sel) sel = {...sel, status: 'done', pending: []};
  renderAuth(); header(); renderSide(); renderAsks();
  if (!sel) { $('log').replaceChildren(); blank(); }
}

function header() {
  const empty = !sel;
  $('title').textContent = sel?.title || (empty ? 'Pick a session' : 'New session');
  $('where').textContent = empty ? 'Choose one on the left, or start a new one in a workspace.' : `${sel.cwd}, ${modelLabel(sel.model)} at ${sel.thinking}, ${label(sel)[1].toLowerCase()}`;
  const running = sel?.status === 'running', alive = running || sel?.status === 'idle';
  $('stop').hidden = !running; $('end').hidden = !alive;
  $('where').className = empty ? '' : 'path'; $('form').hidden = empty;
  syncComposer();
}

function select(s) {
  if (sel) sessionDraft(sel.id).message = $('box').value;
  sel = s; source?.close(); current = null; tools.clear(); toolArgs.clear(); view = newView(); asksSig = '';
  clearTimeout(markdownTimer); markdownTimer = 0; pendingMarkdown.clear();
  $('box').value = sessionDraft(s.id).message; $('slash').hidden = true; renderAttachments();
  seen[s.id] = s.settled ?? 0; localStorage.seen = JSON.stringify(seen);
  $('log').replaceChildren(); renderQueued(); header(); renderSide(); renderAsks(); renderInfo();
  renderAuth();
  document.body.dataset.pane = 'chat';
  source = new EventSource('/api/events?id=' + s.id);
  source.onmessage = e => { const log = $('log'), stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80; handle(JSON.parse(e.data)); if (stick) log.scrollTop = log.scrollHeight; };
  source.onerror = () => source.close();
  $('box').focus();
}

const add = (cls, text) => { const e = el('div', cls, text); $('log').append(e); return e; };
const text = c => typeof c === 'string' ? c : (c ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n\n');
const message = (role, content) => renderMessage(add(role), content);
function queueMarkdown(node, value) {
  pendingMarkdown.set(node, value);
  if (!markdownTimer) markdownTimer = setTimeout(() => {
    markdownTimer = 0;
    const log = $('log'), stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    for (const [target, sourceText] of pendingMarkdown) if (target.isConnected) renderMarkdown(target, sourceText);
    pendingMarkdown.clear(); if (stick) log.scrollTop = log.scrollHeight;
  }, 50);
}
function updateAssistant(event) {
  current ??= {node: add('assistant'), blocks: new Map()};
  const index = event.contentIndex ?? 0;
  if (!current.blocks.has(index)) {
    const node = el('div', 'markdown'); current.node.append(node); current.blocks.set(index, {node, value: ''});
  }
  const block = current.blocks.get(index);
  block.value = event.type === 'text_end' ? event.content : block.value + event.delta;
  queueMarkdown(block.node, block.value);
}
const brief = a => String(a?.command ?? a?.path ?? a?.file_path ?? a?.pattern ?? a?.action ?? '').split('\n')[0].slice(0, 160);
function tool(id, name, args) { const d = el('details', 'tool'); d.append(el('summary', '', (name + '  ' + brief(args)).trim())); $('log').append(d); tools.set(id, d); toolArgs.set(id, args); return d; }
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
function diffCard(name, path, rows, args, r) {
  const card = el('div', 'diff'), head = el('div', 'diff-head'), body = el('div', 'diff-body');
  const badge = el('span', 'badge ' + name, name === 'edit' ? 'M' : 'W'); badge.title = name === 'edit' ? 'Modified' : 'Written';
  const parts = String(path ?? name).split(/[\\/]/).filter(Boolean), file = el('span', 'file', parts.length > 3 ? '.../' + parts.slice(-3).join('/') : parts.join('/'));
  file.title = path ?? '';
  const plus = rows.filter(x => x.t === 'add').length, minus = rows.filter(x => x.t === 'del').length;
  const stat = el('span', 'stat'); stat.append(el('span', 'plus', '+' + plus), el('span', 'minus', '\u2212' + minus));
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
  const d = tools.get(id) ?? tool(id, name), args = toolArgs.get(id);
  if (!bad) learn(name, args, r);
  const rows = bad ? null : name === 'edit' && r?.details?.diff ? parseDiff(r.details.diff) : name === 'write' && typeof args?.content === 'string' ? writeRows(args.content) : null;
  if (!rows) return result(d, r, bad);
  const card = diffCard(name, args?.path, rows, args, r);
  d.replaceWith(card); tools.set(id, card);
}

// Queue updates are complete snapshots. Keep pending input separate from the
// transcript: Pi removes it from the queue before emitting the user message.
function renderQueued(queue = {}) {
  const panel = $('queued'); panel.replaceChildren();
  for (const [kind, title] of [['steering', 'Queued steering'], ['followUp', 'Queued follow-up']]) {
    for (const message of queue[kind] ?? []) {
      const item = el('div', 'user');
      item.append(el('small', 'queued-label', title), el('p', '', message)); panel.append(item);
    }
  }
  panel.hidden = !panel.children.length;
}

function handle(r) {
  $('log').querySelector('.blank')?.remove();
  if (r.type === 'message_start' && r.message.role === 'assistant') current = null;
  else if (r.type === 'message_update' && ['text_delta', 'text_end'].includes(r.assistantMessageEvent?.type)) updateAssistant(r.assistantMessageEvent);
  else if (r.type === 'message_end') {
    if (r.message.role === 'user') message('user', r.message.content);
    else if (r.message.role === 'assistant') {
      // Completed content is authoritative, even when it differs from the streamed deltas.
      const target = current?.node ?? (text(r.message.content) ? add('assistant') : null);
      for (const block of current?.blocks.values() ?? []) pendingMarkdown.delete(block.node);
      if (target) renderMessage(target, r.message.content);
      if (r.message.errorMessage) add('note', r.message.errorMessage);
      current = null;
    }
  } else if (r.type === 'queue_update') renderQueued(r);
  else if (r.type === 'tool_execution_start') tool(r.toolCallId, r.toolName, r.args);
  else if (r.type === 'tool_execution_end') finish(r.toolCallId, r.toolName, r.result, r.isError);
  else if (r.type === 'extension_ui_request') {
    if (r.method === 'notify') add('note ext', r.message);
    else if (r.method === 'setStatus') r.statusText ? view.statuses.set(r.statusKey, r.statusText) : view.statuses.delete(r.statusKey);
    else if (r.method === 'setWidget') r.widgetLines?.length ? view.widgets.set(r.widgetKey, r.widgetLines) : view.widgets.delete(r.widgetKey);
    else if (['select', 'confirm', 'input', 'editor'].includes(r.method)) stateSig = '', refresh();
  } else if (r.type === 'response') {
    if (!r.success) add('note', r.error);
    else if (r.command === 'get_messages') for (const m of r.data.messages) {
      if (m.role === 'user') message('user', m.content);
      else if (m.role === 'assistant') for (const p of m.content) { if (p.type === 'text' && p.text) message('assistant', [p]); else if (p.type === 'toolCall') tool(p.id, p.name, p.arguments); }
      else if (m.role === 'toolResult') finish(m.toolCallId, m.toolName, m, m.isError);
    } else if (r.command === 'get_session_stats') view.stats = r.data;
    else if (r.command === 'get_commands') view.commands = r.data.commands ?? [];
  } else if (r.type === 'dashboard_exit') {
    for (const label of $('queued').querySelectorAll('.queued-label')) label.textContent = 'Not delivered — session ended';
    add(r.code === 0 ? 'note quiet' : 'note', r.code === 0 ? 'Session ended. Pick it under Saved to continue.' : `The agent stopped (exit ${r.code}).\n${r.stderr}`);
  }
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
  if (view.statuses.size || view.widgets.size) {
    section(plan, 'From extensions');
    for (const t of view.statuses.values()) plan.append(el('p', '', t));
    for (const lines of view.widgets.values()) plan.append(el('p', '', lines.join('\n')));
    plan.lastChild.style.whiteSpace = 'pre-wrap';
  }

  use.replaceChildren(); section(use, 'This session');
  const s = view.stats;
  if (!sel) hint(use, 'Open a session to see its usage.');
  else if (!s) hint(use, 'Usage appears after the first turn.');
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
  if (state.codexUsage) { section(use, 'Codex usage estimate'); use.append(el('p', '', `${usd(state.codexUsage.used)}. No Apex spending cap.`), el('small', '', 'Counts only this dashboard and earlier recorded tests. Catalog estimate, not an invoice.')); }

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
const acceptsImages = () => (sel?.input ?? state.models.find(m => m.id === sel?.model)?.input ?? []).includes('image');
let settingsBusy = false;
const pickSigs = new Map(); // rebuild options only when they change, so an open list is not reset by polling
function syncSettings() {
  const picks = [[$('model-pick'), state.models.map(m => [m.id, `${m.label} (${m.group})`]), sel?.model], [$('thinking-pick'), (sel?.levels ?? state.thinking ?? []).map(t => [t, t]), sel?.thinking]];
  for (const [select, options, value] of picks) {
    if (value && !options.some(([id]) => id === value)) options.push([value, value]);
    const sig = JSON.stringify(options);
    if (pickSigs.get(select) !== sig) { pickSigs.set(select, sig); select.replaceChildren(...options.map(([id, words]) => { const o = el('option', '', words); o.value = id; return o; })); }
    select.value = value ?? '';
    select.disabled = !sel || !['idle', 'running'].includes(sel.status) || Boolean(sel.locked) || settingsBusy;
  }
  $('settings-note').hidden = !sel?.locked;
}
async function changeSettings(change) {
  if (!sel || settingsBusy) return;
  const id = sel.id, draft = sessionDraft(id), before = sel;
  settingsBusy = true; draft.error = ''; syncComposer();
  try {
    const fresh = await post('/api/settings', {id, ...change});
    if (sel?.id === id) {
      sel = {...sel, ...fresh};
      const what = fresh.model !== before.model ? `Model set to ${modelLabel(fresh.model)} at ${fresh.thinking} thinking` : `Thinking set to ${fresh.thinking}`;
      add('note quiet', what + (sel.status === 'running' ? '. Applies from the next model call.' : '. Applies from your next message.'));
    }
  } catch (err) { draft.error = err.message; }
  finally { settingsBusy = false; if (sel?.id === id) header(); stateSig = ''; refresh(); }
}
$('model-pick').onchange = () => changeSettings({model: $('model-pick').value});
$('thinking-pick').onchange = () => changeSettings({thinking: $('thinking-pick').value});
const canCompose = () => sel && ['idle', 'running'].includes(sel.status) && ready(providerOf(sel));
function syncComposer() {
  const draft = sel ? sessionDraft(sel.id) : null, ready = canCompose(), vision = acceptsImages();
  $('box').disabled = !ready || Boolean(draft?.sending);
  $('send').disabled = !ready || Boolean(draft?.sending || draft?.reading) || (!vision && Boolean(draft?.images.length)) || (!$('box').value.trim() && !draft?.images.length);
  $('attach').disabled = $('image-files').disabled = !ready || !vision || Boolean(draft?.sending || draft?.reading) || (draft?.images.length ?? 0) >= MAX_IMAGES;
  $('send').textContent = draft?.sending ? 'Sending…' : sel?.status === 'running' ? 'Steer' : 'Send';
  $('attachment-hint').textContent = !sel ? 'Open a session to attach images.' : !vision ? `${modelLabel(sel.model)} accepts text only. Image attachments are unavailable.` : IMAGE_HELP + ' Paste or drop images here.';
  const status = draft?.reading ? 'Preparing images…' : draft?.images.length ? `${draft.images.length} image${draft.images.length === 1 ? '' : 's'} attached.` : '';
  $('attachment-status').textContent = status; $('attachment-status').hidden = !status;
  $('composer-error').textContent = draft?.error || ''; $('composer-error').hidden = !draft?.error;
  syncSettings();
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
  const list = slashMatches();
  if (!slash.hidden && list.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); slashAt = (slashAt + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; drawSlash(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && list.length && $('box').value !== '/' + list[slashAt].name.replace(/^\//, ''))) { e.preventDefault(); pick('/' + list[slashAt].name.replace(/^\//, '')); return; }
    if (e.key === 'Escape') { slash.hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('form').requestSubmit(); }
};
$('form').onsubmit = async e => {
  e.preventDefault(); if (!canCompose()) return;
  const id = sel.id, draft = sessionDraft(id), messageText = $('box').value.trim();
  if (draft.sending || draft.reading || (!messageText && !draft.images.length)) return;
  draft.message = $('box').value; draft.sending = true; draft.error = ''; syncComposer(); renderAttachments();
  try {
    const images = draft.images.map(({type, data, mimeType}) => ({type, data, mimeType}));
    await post('/api/send', {id, message: messageText, ...(images.length ? {images} : {})});
    draft.message = ''; draft.images = [];
    if (sel?.id === id) { $('box').value = ''; slash.hidden = true; }
  } catch (err) { draft.error = err.message; if (sel?.id === id) add('note', err.message); }
  finally { draft.sending = false; if (sel?.id === id) { renderAttachments(); syncComposer(); if (canCompose()) $('box').focus(); } }
  setTimeout(() => { stateSig = ''; refresh(); }, 300);
};
$('stop').onclick = () => post('/api/abort', {id: sel.id});
$('end').onclick = async () => { await post('/api/stop', {id: sel.id}); setTimeout(() => { stateSig = ''; refresh(); }, 800); };

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

/* launching a session */
const launch = $('launch');
let launchFor = null, choice = stored('launch', {model: 'sol', thinking: 'xhigh', context: [], core: [], features: [], timeBudget: 600, evalMode: false});
const PRESETS = [
  {id: 'plain', label: 'Plain agent', note: 'No Apex features.', set: {context: [], core: [], features: []}},
  {id: 'lean', label: 'Lean context', note: 'Shorter reads, searches, edits and output.', set: {context: ['shape', 'mask', 'read', 'search', 'edit'], core: [], features: []}},
  {id: 'long', label: 'Long tasks', note: 'Todos, criteria, verification and loop checks.', set: {context: [], core: ['snapshot', 'contract', 'todo', 'verify', 'loops'], features: []}},
  {id: 'daily', label: 'Everyday safety', note: 'Cost, undo, planning and approvals.', set: {context: [], core: [], features: ['cost', 'checkpoints', 'plan', 'safety', 'report', 'resume']}},
];
function checked(group) { return [...launch.querySelectorAll(`input[data-group="${group}"]:checked`)].map(i => i.value); }
function chosenModel() { return state.models.find(m => m.id === $('launch-model').value) ?? state.models[0]; }
function syncLaunchAuth() {
  const a = auth(chosenModel()?.provider);
  $('launch-auth').hidden = !a || a.signedIn;
  if (a) { $('launch-auth-text').textContent = `${signInWords(a)} to use this model. Apex saves the ${loginWord(a)} on this computer.`; $('launch-login').textContent = signInWords(a); }
}
function applyChoice(c) {
  for (const g of ['context', 'core', 'features']) for (const i of launch.querySelectorAll(`input[data-group="${g}"]`)) i.checked = c[g].includes(i.value);
  $('evalmode').checked = Boolean(c.evalMode); syncLaunch();
}
function syncLaunch() {
  syncLaunchAuth();
  const model = chosenModel(), usesApex = model.apex;
  $('launch-model-note').textContent = `${model.billing} ${model.input?.includes('image') ? 'Text and images.' : 'Text only.'}`;
  for (const id of ['presets', 'features', 'evalrow']) $(id).hidden = !usesApex;
  $('feature-note').hidden = usesApex;
  $('feature-note').textContent = usesApex ? '' : `Apex features are unavailable for ${model.label} here. ${state.models.filter(m => m.apex).length === 1 ? `They run on ${state.models.find(m => m.apex).label}.` : 'They run on Muse and, on native Windows, the signed-in models.'} This model runs as the stock agent.`;
  for (const i of launch.querySelectorAll('#features input[type=checkbox]')) {
    const unavailable = Boolean(model.unavailable?.includes(i.value)), off = Boolean(i.dataset.blocked) || unavailable;
    if (off) i.checked = false;
    i.disabled = off; i.closest('.check')?.classList.toggle('off', off);
    const note = i.closest('.check')?.querySelector('.unavailable'); if (note) { note.hidden = !unavailable; note.textContent = `Not available with ${model.label}`; }
  }
  const any = usesApex && (['context', 'core', 'features'].some(g => checked(g).length) || $('evalmode').checked);
  const th = $('thinking'), locked = usesApex && any;
  if (locked) th.value = 'xhigh';
  th.disabled = locked; $('thinking-note').textContent = locked ? 'Apex experiments run at xhigh.' : '';
  const tb = $('timebox'); if (tb) tb.hidden = !launch.querySelector('input[value=time]')?.checked;
  for (const d of launch.querySelectorAll('.group')) { const n = d.querySelectorAll('input:checked').length; d.querySelector('em').textContent = n ? `${n} on` : ''; }
}
function buildLaunch() {
  const pick = $('launch-model'), groups = new Map(); // models come from the provider catalogs, grouped by sign-in
  for (const m of state.models) {
    if (!groups.has(m.group)) { const g = el('optgroup'); g.label = m.group; groups.set(m.group, g); }
    const o = el('option', '', m.label); o.value = m.id; groups.get(m.group).append(o);
  }
  pick.replaceChildren(...groups.values()); pick.value = state.models.some(m => m.id === choice.model) ? choice.model : state.models[0]?.id ?? ''; pick.onchange = syncLaunch;
  const th = $('thinking'); th.replaceChildren(...state.thinking.map(t => new Option(t, t))); th.value = state.thinking.includes(choice.thinking) ? choice.thinking : 'xhigh';
  const ps = $('presets'); ps.replaceChildren(el('legend', '', 'Start from')); const pw = el('div', 'choice');
  for (const p of PRESETS) {
    const l = el('label'), i = el('input'); i.type = 'radio'; i.name = 'preset'; i.value = p.id; i.onchange = () => applyChoice({...choice, ...p.set});
    l.append(i, el('b', '', p.label), el('small', '', p.note)); pw.append(l);
  }
  ps.append(pw);
  const fe = $('features'); fe.replaceChildren();
  for (const g of state.groups) {
    const d = el('details', 'group'), sum = el('summary'); d.open = false;
    sum.append(el('span', '', g.title), el('small', '', g.blurb), el('em')); d.append(sum);
    const items = el('div', 'items');
    for (const f of g.features) {
      const l = el('label', 'check'), i = el('input'); i.type = 'checkbox'; i.value = f.flag; i.dataset.group = g.id; i.onchange = syncLaunch;
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
  applyChoice(choice);
}
function openLaunch(cwd, file, title) {
  launchFor = {cwd, file}; $('launch-error').textContent = '';
  $('launch-h').textContent = file ? 'Resume session' : 'New session';
  $('launch-where').textContent = (file ? title + '. ' : '') + cwd;
  $('launch-go').textContent = file ? 'Resume session' : 'Start session';
  buildLaunch(); launch.showModal(); $('launch-model').focus();
}
$('launch-cancel').onclick = () => launch.close();
$('launch-form').onsubmit = async e => {
  e.preventDefault(); const model = chosenModel(), go = $('launch-go');
  const pickedFor = group => model.apex ? checked(group) : [];
  const body = {...launchFor, model: model.id, thinking: $('thinking').value, context: pickedFor('context'), core: pickedFor('core'), features: pickedFor('features'),
    timeBudget: Number($('timebudget')?.value), evalMode: model.apex && $('evalmode').checked};
  go.disabled = true;
  try {
    const {id} = await post('/api/start', body);
    choice = {model: model.id, thinking: body.thinking, context: body.context, core: body.core, features: body.features, timeBudget: body.timeBudget || 600, evalMode: body.evalMode};
    localStorage.launch = JSON.stringify(choice);
    stateSig = ''; await refresh(); launch.close();
    const s = state.workspaces.flatMap(w => w.live).find(x => x.id === id); if (s) select(s);
  } catch (err) { $('launch-error').textContent = err.message; }
  go.disabled = false;
};

refresh().then(renderInfo); setInterval(refresh, 3000);
