import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, open, readlink, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEditToolDefinition} from '@earendil-works/pi-coding-agent';

const knownTools = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', 'powershell']);
const pathTools = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);
// The skills feature advertises these files to the model by absolute path, so read may reach them outside cwd.
const skillsRoot = fileURLToPath(new URL('../../skills/', import.meta.url));
const owns = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const textOf = event => (event?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
const bounded = (value, bytes) => {
  const buffer = Buffer.from(String(value));
  if (buffer.length <= bytes) return buffer.toString();
  // Drop an incomplete UTF-8 suffix so the encoded result stays within its byte cap.
  return buffer.subarray(0, bytes).toString('utf8').replace(/\ufffd$/, '');
};

function alias(input, canonical, alternatives) {
  const names = [canonical, ...alternatives].filter(name => owns(input, name));
  if (!names.length) return;
  const value = input[names[0]];
  if (names.some(name => input[name] !== value)) throw new Error(`Conflicting ${canonical} aliases: ${names.join(', ')}`);
  input[canonical] = value;
  for (const name of alternatives) delete input[name];
}

function string(input, key, required = false) {
  if ((required || owns(input, key)) && typeof input[key] !== 'string') throw new Error(`${key} must be a string`);
}
function positive(input, key) {
  if (owns(input, key) && (!Number.isSafeInteger(input[key]) || input[key] <= 0)) throw new Error(`${key} must be a positive integer`);
}
function boolean(input, key) {
  if (owns(input, key) && typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
}
function replacement(value) {
  if (!record(value)) throw new Error('Each edit must be an oldText/newText object');
  const edit = {...value};
  alias(edit, 'oldText', ['old_string', 'old_text']);
  alias(edit, 'newText', ['new_string', 'new_text']);
  string(edit, 'oldText', true);
  string(edit, 'newText', true);
  if (!edit.oldText) throw new Error('oldText must not be empty');
  return edit;
}

/** Pre-schema normalization. Returns fresh known-tool arguments; never modifies model arguments. */
export function prepareCorrectableArguments(toolName, input) {
  if (!knownTools.has(toolName)) return input;
  if (!record(input)) throw new Error('Tool input must be an object');
  const args = {...input};
  // Strict function schemas (Codex) send null for every unset optional field; Pi's own tools read that as absent.
  for (const key of Object.keys(args)) if (args[key] === null) delete args[key];
  if (pathTools.has(toolName)) {
    alias(args, 'path', ['file_path', 'filePath']);
    string(args, 'path', ['read', 'write', 'edit'].includes(toolName));
    if (owns(args, 'path') && (!args.path.trim() || args.path.includes('\0'))) throw new Error('path must be nonempty and contain no NUL');
  }
  if (toolName === 'read') {
    alias(args, 'offset', ['start_line']);
    alias(args, 'limit', ['max_lines']);
    positive(args, 'offset');
    positive(args, 'limit');
    if (owns(args, 'mode') && !['text', 'outline'].includes(args.mode)) throw new Error('mode must be text or outline');
  } else if (toolName === 'write') {
    alias(args, 'content', ['text']);
    string(args, 'content', true);
  } else if (toolName === 'edit') {
    alias(args, 'oldText', ['old_string', 'old_text']);
    alias(args, 'newText', ['new_string', 'new_text']);
    let edits = args.edits;
    if (typeof edits === 'string') {
      try { edits = JSON.parse(edits); } catch { throw new Error('edits must contain valid JSON or an array'); }
    }
    if (record(edits)) edits = [edits];
    if (edits !== undefined && !Array.isArray(edits)) throw new Error('edits must be an array');
    edits = (edits ?? []).map(replacement);
    if (owns(args, 'oldText') || owns(args, 'newText')) {
      edits.push(replacement({oldText: args.oldText, newText: args.newText}));
      delete args.oldText;
      delete args.newText;
    }
    if (!edits.length || edits.length > 128) throw new Error('edit requires 1 to 128 replacements');
    args.edits = edits;
  } else if (toolName === 'grep' || toolName === 'find') {
    alias(args, 'pattern', toolName === 'grep' ? ['query'] : ['glob']);
    string(args, 'pattern', true);
    alias(args, 'limit', ['max_results']);
    positive(args, 'limit');
    if (toolName === 'grep') {
      alias(args, 'ignoreCase', ['ignore_case']);
      boolean(args, 'ignoreCase');
      boolean(args, 'literal');
      string(args, 'glob');
      if (owns(args, 'context') && (!Number.isSafeInteger(args.context) || args.context < 0)) throw new Error('context must be a nonnegative integer');
    }
  } else if (toolName === 'ls') {
    alias(args, 'limit', ['max_results']);
    positive(args, 'limit');
  } else {
    alias(args, 'command', ['cmd']);
    string(args, 'command', true);
    if (owns(args, 'timeout') && (!Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout * 1000 > 2147483647))
      throw new Error('timeout must be finite positive seconds within the native timeout limit');
  }
  return args;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function resolvedExistingAncestor(candidate, depth = 0) {
  if (depth > 32) throw new Error('path contains too many symbolic links');
  let ancestor = candidate;
  const suffix = [];
  while (true) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) {
        const target = path.resolve(path.dirname(ancestor), await readlink(ancestor));
        return path.join(await resolvedExistingAncestor(target, depth + 1), ...suffix);
      }
      return path.join(await realpath(ancestor), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function confinedPath(cwd, value, {readOnly = false} = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('A working directory is required for confined paths');
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, value);
  if (readOnly && inside(path.resolve(skillsRoot), absolute)) {
    const resolved = await resolvedExistingAncestor(absolute);
    if (inside(await realpath(skillsRoot), resolved)) return resolved;
  }
  if (!inside(root, absolute)) throw new Error('Tool path must be confined to cwd; path is outside the working directory');
  const realRoot = await realpath(root);
  const resolved = await resolvedExistingAncestor(absolute);
  if (!inside(realRoot, resolved)) throw new Error('Tool path resolves outside the confined working directory');
  return resolved;
}

async function boundedFile(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('edit path must be a regular file');
    if (info.size > 2 * 1024 * 1024) throw new Error('Edit precondition scan is bounded to 2 MiB; use a smaller file or another explicit mutation tool');
    const bytes = Buffer.alloc(info.size);
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

function closestCandidates(bytes, edits) {
  const terms = new Set(edits.flatMap(edit => bounded(edit.oldText, 1000).match(/[\w$]+/g) ?? []).slice(0, 128));
  const lines = bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n').slice(0, 20000);
  const candidates = lines.map((line, index) => ({line, index,
    score: (bounded(line, 1000).match(/[\w$]+/g) ?? []).filter(word => terms.has(word)).length,
  })).filter(item => item.score).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
  return '\nClosest candidates (approximate; no edit applied):\n' + (candidates.length ?
    candidates.map(item => `${item.index + 1}: ${bounded(item.line, 350)}`).join('\n') : 'none in the bounded scan; read the relevant range.');
}

function shellCommandWords(command) {
  const commands = [];
  let words = [];
  let word;
  let quote;
  let syntax = '';
  const flushWord = () => { if (word) words.push(word); word = undefined; };
  const flushCommand = () => { flushWord(); if (words.length) commands.push(words); words = []; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (!quote && char === '#' && !word) {
      while (index < command.length && command[index] !== '\n') index++;
      flushCommand();
      syntax += '\n';
      continue;
    }
    if (!quote && /[;\n|&()]/.test(char)) { flushCommand(); syntax += char; continue; }
    if (!quote && /\s/.test(char)) { flushWord(); syntax += char; continue; }
    word ??= {text: '', homeExpansion: false, tildeExpansion: false};
    if (!quote && (char === '"' || char === "'")) { quote = char; continue; }
    if (quote && char === quote) { quote = undefined; continue; }
    if (char === '\\' && quote !== "'" && index + 1 < command.length) {
      const next = command[index + 1];
      if (!quote || /[$`"\\\n]/.test(next)) {
        if (next !== '\n') word.text += next;
        index++;
        syntax += ' ';
        continue;
      }
    }
    if (char === '$' && quote !== "'" && /^(?:\$HOME(?=\W|$)|\$\{HOME\})/.test(command.slice(index))) word.homeExpansion = true;
    if (char === '~' && !quote && !word.text) word.tildeExpansion = true;
    word.text += char;
    if (!quote) syntax += char;
  }
  flushCommand();
  return {commands, syntax};
}

function destructiveCommandWords(words) {
  let index = 0;
  while (/^[A-Za-z_][\w]*=/.test(words[index]?.text ?? '')) index++;
  // Only common direct execution wrappers are recognized; this is not shell evaluation.
  while (words[index]) {
    const name = path.posix.basename(words[index].text);
    if (!['sudo', 'command', 'exec', 'nohup'].includes(name)) break;
    index++;
    while (words[index]?.text.startsWith('-')) {
      const option = words[index++].text;
      if (option === '--') break;
      if (name === 'command' && option !== '-p') return [];
      if (name === 'sudo' && ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from',
        '-D', '--chdir', '-R', '--chroot', '-r', '--role', '-t', '--type'].includes(option) || name === 'exec' && option === '-a') index++;
    }
  }
  return words.slice(index);
}

function catastrophic(command) {
  const {commands, syntax} = shellCommandWords(command);
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/.test(syntax)) return true;
  for (const words of commands) {
    const [executable, ...args] = destructiveCommandWords(words);
    const name = path.posix.basename(executable?.text ?? '');
    if (/^(?:mkfs(?:\.[\w]+)?|shutdown|reboot|halt|poweroff)$/.test(name)) return true;
    if (name === 'dd' && args.some(arg => /^of=\/dev\//.test(arg.text))) return true;
    if (name !== 'rm') continue;
    let recursive = false;
    let force = false;
    let options = true;
    let rootOrHome = false;
    for (const arg of args) {
      if (options && arg.text === '--') { options = false; continue; }
      if (options && arg.text.startsWith('-')) {
        if (arg.text === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg.text)) recursive = true;
        if (arg.text === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg.text)) force = true;
        continue;
      }
      rootOrHome ||= arg.text.startsWith('/') && path.posix.normalize(arg.text) === '/' ||
        arg.homeExpansion && /^(?:\$HOME|\$\{HOME\})(?:\/)?$/.test(arg.text) ||
        arg.tildeExpansion && /^~\/?$/.test(arg.text);
    }
    if (recursive && force && rootOrHome) return true;
  }
  return /\b(?:Remove-Item|del|rd)\b[^\n;]*(?:-Recurse|\/s)[^\n;]*\s(?:[A-Z]:\\|\$HOME)\s*$/i.test(command);
}

/** Native hook contract: mutate event.input in place, or return Pi's block result. */
export async function correctToolCall(event, ctx, {headless = true, confirm} = {}) {
  if (!knownTools.has(event?.toolName)) return undefined;
  try {
    const args = prepareCorrectableArguments(event.toolName, event.input);
    if (pathTools.has(event.toolName)) args.path = await confinedPath(ctx?.cwd, args.path ?? '.', {readOnly: event.toolName === 'read'});
    if (event.toolName === 'edit') {
      const bytes = await boundedFile(args.path);
      if (bytes.includes(0)) throw new Error('Edit precondition requires a text file');
      // Pi's own matching handles BOM, CRLF, tolerant whitespace, ambiguity and overlap.
      // Operations contain captured bytes and a no-op writer; this check cannot modify files.
      const native = createEditToolDefinition(ctx.cwd, {operations: {
        access: async () => {}, readFile: async () => bytes, writeFile: async () => {},
      }});
      try { await native.execute(event.toolCallId, args, undefined, undefined, {cwd: ctx.cwd}); }
      catch (error) { throw new Error(bounded(error.message, 1500) + closestCandidates(bytes, args.edits)); }
    }
    if (!headless && ctx?.hasUI === true && ctx?.mode === 'tui' && ['bash', 'powershell'].includes(event.toolName) && catastrophic(args.command)) {
      const ask = confirm ?? (ctx.ui?.confirm ? command => ctx.ui.confirm('Confirm catastrophic command', bounded(command, 2000)) : undefined);
      if (!ask || await ask(args.command, event, ctx) !== true) return {block: true, reason: 'Catastrophic command was not confirmed in the TUI'};
    }
    // Keep Pi's original reference so sibling handlers and native execute receive the patch.
    for (const key of Object.keys(event.input)) delete event.input[key];
    for (const [key, value] of Object.entries(args)) Object.defineProperty(event.input, key, {value, writable: true, configurable: true, enumerable: true});
    return undefined;
  } catch (error) { return {block: true, reason: bounded(error.message ?? error, 3500)}; }
}

function fingerprint(value) {
  try { return hash(JSON.stringify(value)); } catch { return hash(String(value)); }
}
function boundedMapSet(map, key, value, limit = 64) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

export function createLoopBreaker({maxNotes = 2} = {}) {
  if (!Number.isSafeInteger(maxNotes) || maxNotes < 0 || maxNotes > 20) throw new Error('maxNotes must be an integer from 0 to 20');
  const failures = new Map();
  const reads = new Map();
  const edits = new Map();
  let notes = 0;
  const emit = (kind, n, summary) => {
    if (n !== 3 || notes >= maxNotes) return undefined;
    notes++;
    return {kind, n, failure_summary: bounded(summary, 1200), thinking: 'xhigh'};
  };
  return {
    observe(event) {
      if (event?.type !== 'tool_result') return undefined;
      const output = textOf(event);
      if (event.isError) {
        const key = fingerprint([event.toolName, event.input, output]);
        const count = (failures.get(key) ?? 0) + 1;
        boundedMapSet(failures, key, count);
        return emit('failure', count, `${event.toolName}: ${bounded(JSON.stringify(event.input), 400)}\n${output}`);
      }
      if (event.toolName === 'read') {
        const key = fingerprint([event.input, event.content]);
        const count = (reads.get(key) ?? 0) + 1;
        boundedMapSet(reads, key, count);
        return emit('read', count, `Repeated identical read: ${JSON.stringify(event.input)}`);
      }
      if (event.toolName === 'edit') {
        let args;
        try { args = prepareCorrectableArguments('edit', event.input); } catch { return undefined; }
        const key = args.path;
        const forward = fingerprint(args.edits.map(edit => [edit.oldText, edit.newText]));
        const reverse = fingerprint(args.edits.map(edit => [edit.newText, edit.oldText]));
        const prior = edits.get(key);
        const count = prior?.forward === reverse ? prior.count + 1 : 1;
        boundedMapSet(edits, key, {forward, count});
        return emit('ping-pong', count, `Reversed the same edit regions repeatedly in ${args.path}`);
      }
      return undefined;
    },
    reset() { failures.clear(); reads.clear(); edits.clear(); notes = 0; },
  };
}

export function createTimeTracker({seconds, elapsedSeconds=0, now = () => performance.now()}) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('seconds must be finite and positive');
  if(!Number.isFinite(elapsedSeconds)||elapsedSeconds<0||elapsedSeconds>86400)throw new Error('restored elapsed seconds must be bounded and nonnegative');
  let start;
  let latest;
  const emitted = new Set();
  const reset = (elapsed=0) => {
    start = now()-elapsed*1000;
    if (!Number.isFinite(start)) throw new Error('monotonic clock must return a finite number');
    latest = start;
    emitted.clear();
  };
  reset(elapsedSeconds);
  return {
    poll() {
      const current = now();
      if (Number.isFinite(current)) latest = Math.max(latest, current);
      const elapsed = Math.max(0, (latest - start) / 1000);
      return [0.5, 0.75, 0.9].filter(threshold => elapsed >= seconds * threshold && !emitted.has(threshold)).map(threshold => {
        emitted.add(threshold);
        return {threshold, remaining: Math.max(0, seconds - elapsed), total: seconds, elapsed};
      });
    }, reset,
  };
}

const checkerEnv = () => ({...Object.fromEntries(['PATH','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR','TEMP','TMP','SystemRoot','WINDIR']
  .filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]])),CI: '1', PAGER: 'cat', GIT_PAGER: 'cat',
  npm_config_offline:'true',npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false',
  npm_config_registry:'http://127.0.0.1:9/',
  npm_config_yes: 'false', PIP_NO_INPUT: '1', CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0',
  GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GOENV: 'off', CGO_ENABLED: '0'});
async function defaultRunCommand(command, args, {cwd, timeoutMs, maxOutputBytes, env}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, {cwd, env, windowsHide: true, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']}); }
    catch { resolve({code: 127, stdout: '', stderr: ''}); return; }
    const stdout = [];
    const stderr = [];
    let remaining = maxOutputBytes;
    let finished = false;
    const finish = (code, extra = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), ...extra});
    };
    const kill = () => {
      try {
        // Cargo/go can spawn compiler children which inherit output pipes. Kill the owned group.
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const collect = bucket => bytes => {
      if (finished) return;
      bucket.push(bytes.subarray(0, remaining));
      remaining -= Math.min(remaining, bytes.length);
      if (remaining === 0) { kill(); finish(127, {truncated: true}); }
    };
    const timer = setTimeout(() => { kill(); finish(127, {timedOut: true}); }, timeoutMs);
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', () => finish(127));
    child.once('close', code => finish(code ?? 127));
  });
}

function commandOutput(value) {
  const stdout = String(value?.stdout ?? '');
  const stderr = String(value?.stderr ?? '');
  const raw = stdout + (stdout && stderr ? '\n' : '') + stderr;
  return {code: value?.code ?? value?.exitCode ?? value?.status ?? 127, output: bounded(raw, 65536),
    truncated: value?.truncated === true || Buffer.byteLength(raw) > 65536, timedOut: value?.timedOut === true};
}
async function findManifest(cwd, file, name) {
  let directory = path.dirname(file);
  while (inside(cwd, directory)) {
    const candidate = path.join(directory, name);
    try { if ((await stat(candidate)).isFile()) { await confinedPath(cwd, candidate); return candidate; } } catch {}
    if (directory === cwd) break;
    directory = path.dirname(directory);
  }
  return undefined;
}

// Bun has no `--check`: the child parses the file with Bun's transpiler, never runs it, and like `node --check` prints
// the first error as `file:line:column` and `SyntaxError: message`. The path is embedded in the script: `bun -e`
// would run a trailing file argument.
const bunSyntaxCheck = file => `const file=${JSON.stringify(file)};try{new Bun.Transpiler({loader:'js'}).transformSync(require('node:fs').readFileSync(file,'utf8'))}`
  + "catch(error){const item=error.errors?.[0]??error;console.log(file+':'+(item.position?.line??1)+':'+((item.position?.column??0)+1)+'\\nSyntaxError: '+item.message);process.exit(1)}";

function diagnosticErrors(checker, output) {
  let rows;
  if (checker === 'bun') {
    const lines = output.split(/\r?\n/);
    const location = lines.find(line => /\.(?:[cm]?js):\d+(?::\d+)?$/.test(line)) ?? 'JavaScript';
    rows = lines.filter(line => /^SyntaxError:/.test(line)).map(line => `${location}: ${line}`);
  } else if (checker === 'pyright') {
    try {
      rows = JSON.parse(output).generalDiagnostics.filter(item => item.severity === 'error').map(item =>
        `${item.file}:${item.range.start.line + 1}:${item.range.start.character + 1}: ${item.message}`);
    } catch { rows = []; }
  } else {
    const patterns = {tsc: /\berror TS\d+:|:\s*error\b/i, ruff: /:\d+:\d+:\s+[A-Z]+\d+\b/,
      go: /\.go:\d+(?::\d+)?:/, cargo: /:\s*error(?:\[|:)|^error(?:\[|:)/};
    rows = output.split(/\r?\n/).filter(line => patterns[checker].test(line));
  }
  const unique = [...new Set(rows.map(row => bounded(row.trim(), 1000)))];
  let bytes = 0;
  const errors = unique.filter(row => { bytes += Buffer.byteLength(row) + 1; return bytes <= 8000; }).slice(0, 40);
  return {errors, truncated: errors.length !== unique.length};
}

function newDiagnosticErrors(baseline, current) {
  // Compare error identities as a multiset: edits that insert lines can move old errors.
  const identity = error => error.replace(/\(\d+,\d+\)(?=:)/g, '').replace(/:\d+(?::\d+)?(?=:)/g, '');
  const existing = new Map();
  for (const error of baseline) {
    const key = identity(error);
    existing.set(key, (existing.get(key) ?? 0) + 1);
  }
  return current.filter(error => {
    const key = identity(error);
    const count = existing.get(key) ?? 0;
    if (!count) return true;
    existing.set(key, count - 1);
    return false;
  });
}

/** Fixed existing checkers only; each tool-call id owns a pre-edit baseline. */
export function createDiagnostics({cwd, runCommand = defaultRunCommand}) {
  const root = path.resolve(cwd);
  const pending = new Map();
  const installed = new Map();
  let generation = 0;
  const skipped = (event, reason, extra = {}) => ({status: 'skipped', toolCallId: event?.toolCallId ?? '', checker: null,
    errors: [], newErrors: [], reason: bounded(reason, 600), ...extra});
  const run = async (command, args, timeoutMs = 5000) => {
    try { return commandOutput(await runCommand(command, args, {cwd: root, timeoutMs, maxOutputBytes: 65536,
      networkAllowed: false, env: checkerEnv()})); }
    catch (error) { return {code: 127, output: bounded(error.message, 600), truncated: false, timedOut: false}; }
  };
  const available = command => {
    if (!installed.has(command)) installed.set(command, run(command, [command === 'go' ? 'version' : '--version'], 1000).then(value => value.code === 0 && !value.timedOut && !value.truncated));
    return installed.get(command);
  };
  const select = async file => {
    const extension = path.extname(file).toLowerCase();
    const relative = path.relative(root, file);
    const bunCommand = path.isAbsolute(process.execPath) ? process.execPath : 'bun';
    if (['.js', '.mjs', '.cjs'].includes(extension) && await available(bunCommand))
      return {checker: 'bun', command: bunCommand, args: ['-e', bunSyntaxCheck(file)]};
    if (['.ts', '.tsx', '.jsx'].includes(extension) && await available('tsc'))
      return {checker: 'tsc', command: 'tsc', args: ['--noEmit', '--pretty', 'false', '--incremental', 'false', '--skipLibCheck', ...(extension === '.jsx' ? ['--allowJs', '--checkJs'] : []), relative.startsWith('-') ? './' + relative : relative]};
    if (extension === '.py') {
      if (await available('ruff')) return {checker: 'ruff', command: 'ruff', args: ['check', '--output-format', 'concise', '--no-cache', '--no-config', '--', relative]};
      if (await available('pyright')) return {checker: 'pyright', command: 'pyright', args: ['--outputjson', relative]};
    }
    if (extension === '.go' && await available('go')) return {checker: 'go', command: 'go', args: ['vet', relative]};
    if (extension === '.rs' && await available('cargo')) {
      const manifest = await findManifest(root, file, 'Cargo.toml');
      if (manifest) return {checker: 'cargo', command: 'cargo', args: ['check', '--offline', '--locked', '--quiet', '--message-format=short', '--manifest-path', manifest, '--target-dir', path.join(root, '.apex', 'diagnostics-target')]};
    }
    return undefined;
  };
  const check = async selection => {
    const output = await run(selection.command, selection.args);
    const parsed = diagnosticErrors(selection.checker, output.output);
    const incomplete = output.timedOut || output.truncated || parsed.truncated || (output.code !== 0 && !parsed.errors.length);
    return {...parsed, incomplete, truncated: output.truncated || parsed.truncated, timedOut: output.timedOut};
  };
  return {
    async before(event) {
      if (!['write', 'edit'].includes(event?.toolName)) return skipped(event, 'Not a supported file mutation');
      if (typeof event.toolCallId !== 'string' || !event.toolCallId) return skipped(event, 'A tool-call id is required');
      const epoch = generation;
      try {
        const file = await confinedPath(root, event.input?.path);
        let existed = true;
        try {
          const info = await stat(file);
          if (!info.isFile() || info.size > 2 * 1024 * 1024) return skipped(event, 'Baseline requires a regular file no larger than 2 MiB');
        } catch (error) {
          if (error.code !== 'ENOENT' || event.toolName !== 'write') throw error;
          existed = false;
        }
        const selection = await select(file);
        if (!selection) return skipped(event, 'No installed checker available for this file');
        const baseline = existed ? await check(selection) : {errors: [], incomplete: false, truncated: false};
        if (epoch !== generation) return skipped(event, 'Diagnostics were reset during the baseline');
        if (baseline.incomplete) return skipped(event, 'Baseline checker was incomplete; no diagnostic difference can be trusted', {checker: selection.checker, truncated: baseline.truncated});
        boundedMapSet(pending, event.toolCallId, {selection, baseline: baseline.errors, file, epoch});
        return {status: 'baseline', toolCallId: event.toolCallId, checker: selection.checker,
          errors: baseline.errors, newErrors: [], truncated: false};
      } catch (error) { return skipped(event, error.message); }
    },
    async after(event) {
      const baseline = pending.get(event?.toolCallId);
      pending.delete(event?.toolCallId);
      if (!baseline) return skipped(event, 'No complete pre-edit baseline for this tool call');
      if (event.isError) return skipped(event, 'Mutation failed; diagnostics skipped');
      try {
        await confinedPath(root, baseline.file);
        const output = await check(baseline.selection);
        if (baseline.epoch !== generation) return skipped(event, 'Diagnostics were reset during the checker');
        if (output.incomplete) return skipped(event, 'Post-edit checker was incomplete', {checker: baseline.selection.checker, truncated: output.truncated});
        return {status: 'diagnostics', toolCallId: event.toolCallId, checker: baseline.selection.checker,
          errors: output.errors, newErrors: newDiagnosticErrors(baseline.baseline, output.errors), truncated: false};
      } catch (error) { return skipped(event, error.message); }
    },
    reset() { generation++; pending.clear(); installed.clear(); },
  };
}
