import path from 'node:path';

// Shared, so neither may carry the g or y flag (test/exec would then keep lastIndex between calls).
const WINDOWS_DELETE_WORD = /\b(?:Remove-Item|del|rd)\b/i, WINDOWS_RECURSE_FLAG = /-Recurse|\/s/i;
// Shapes from omp's CRITICAL_BASH_PATTERNS, matched on words so quoted text never counts.
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const PIPE_SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'iex', 'invoke-expression']);
const EVALUATORS = new Set(['eval', 'iex', 'invoke-expression']);
const SUBSTITUTED = new Set(['bash', 'sh', 'zsh', 'fish', 'source', '.']);
const POWERSHELL_HOST = new Set(['stop-computer', 'restart-computer', 'format-volume', 'clear-disk']);
const FETCHED_ARGUMENT = /^(?:\$\(|`)\s*(?:curl|wget|fetch|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?(?=[\s)`]|$)/i;
const PROTECTED_TARGET = /^\/dev\/(?:sd|nvme|hd|mmcblk|r?disk)|^\/etc\/(?:passwd|shadow|sudoers)$/;
const REDIRECT = /^(?:\d+|&)?>>?[&|]?/;

/** Words of each unquoted command; `sep` holds the non-blank separators before it, `literalFrom` the first quoted/escaped offset. */
function shellCommandWords(command) {
  const commands = [];
  let words = [];
  let word;
  let quote;
  let syntax = '';
  let sep = '';
  const flushWord = () => { if (word) words.push(word); word = undefined; };
  const flushCommand = () => { flushWord(); if (words.length) { words.sep = sep; sep = ''; commands.push(words); } words = []; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (!quote && char === '#' && !word) {
      while (index < command.length && command[index] !== '\n') index++;
      flushCommand();
      syntax += '\n';
      sep += '\n';
      continue;
    }
    // `&>` and `>&` are redirections, not a background separator.
    const redirect = char === '&' && !quote && (command[index + 1] === '>' || word?.text.endsWith('>') && word.literalFrom > word.text.length - 1);
    if (!quote && !redirect && /[;\n|&()]/.test(char)) { flushCommand(); syntax += char; sep += char; continue; }
    if (!quote && /\s/.test(char)) { flushWord(); syntax += char; continue; }
    word ??= {text: '', homeExpansion: false, tildeExpansion: false, literalFrom: Infinity};
    if (!quote && (char === '"' || char === "'")) { quote = char; word.literalFrom = Math.min(word.literalFrom, word.text.length); continue; }
    if (quote && char === quote) { quote = undefined; continue; }
    if (char === '\\' && quote !== "'" && index + 1 < command.length) {
      const next = command[index + 1];
      if (!quote || /[$`"\\\n]/.test(next)) {
        word.literalFrom = Math.min(word.literalFrom, word.text.length);
        if (next !== '\n') word.text += next;
        index++;
        syntax += ' ';
        continue;
      }
    }
    if (char === '$' && quote !== "'" && (command.startsWith('${HOME}', index) || command.startsWith('$HOME', index) && !/\w/.test(command[index + 5] ?? ''))) word.homeExpansion = true;
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

// Linear equivalent of /\b(?:Remove-Item|del|rd)\b[^\n;]*(?:-Recurse|\/s)[^\n;]*\s(?:[A-Z]:\\|\$HOME)\s*$/i, which
// backtracks cubically on long single-line commands and froze the TUI. The target is pinned to the end, so the \s before
// it has a fixed position, and the word and the flag must both lie in the [\n;]-free segment ending there.
function windowsRecursiveRootDelete(command) {
  const trimmed = command.trimEnd(); // trimEnd strips exactly the \s set
  const targetLength = /[A-Z]:\\$/i.test(trimmed) ? 3 : /\$HOME$/i.test(trimmed) ? 5 : 0;
  const space = trimmed.length - targetLength - 1; // may be '\n', as in the regex
  if (!targetLength || space < 0 || !/\s/.test(trimmed[space])) return false;
  const start = Math.max(trimmed.lastIndexOf('\n', space - 1), trimmed.lastIndexOf(';', space - 1)) + 1;
  const segment = trimmed.slice(start, space);
  // Word hits never nest, so the leftmost one also ends first and leaves the longest tail for the flag.
  const word = WINDOWS_DELETE_WORD.exec(segment);
  return word !== null && WINDOWS_RECURSE_FLAG.test(segment.slice(word.index + word[0].length));
}

const lowerName = word => (word?.text.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
// A pipe, possibly closing a group before it or opening one after it, continues the pipeline: `(iwr x).Content | iex`.
const piped = words => /^\)*(?:\|&?\(*)?$/.test(words.sep ?? '');
const isRoot = word => word.text.startsWith('/') && path.posix.normalize(word.text) === '/';
function operandsOf(args) {
  const operands = [], options = [];
  let parsing = true;
  for (const arg of args) {
    if (parsing && arg.text === '--') parsing = false;
    else if (parsing && arg.text.startsWith('-') && arg.text.length > 1) options.push(arg.text);
    else operands.push(arg);
  }
  return {operands, options};
}
const recursiveOption = options => options.some(option => option === '--recursive' || /^-[A-Za-z]*R[A-Za-z]*$/.test(option));

function protectedWrite(words) {
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const match = REDIRECT.exec(word.text);
    if (match && match[0].length <= word.literalFrom) {
      const target = word.text.length > match[0].length ? word.text.slice(match[0].length) : words[index + 1]?.text;
      if (PROTECTED_TARGET.test(target ?? '')) return true;
    }
  }
  return false;
}

/** True for shell or PowerShell commands that are virtually never legitimate in automation; quoted text never counts. */
export function catastrophic(command) {
  const {commands, syntax} = shellCommandWords(command);
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/.test(syntax)) return true;
  let fetched = false;
  for (let index = 0; index < commands.length; index++) {
    const words = commands[index];
    if (protectedWrite(words)) return true;
    const [executable, ...args] = destructiveCommandWords(words);
    const name = path.posix.basename(executable?.text ?? '');
    const lower = lowerName(executable);
    if (!piped(words)) fetched = false;
    if (fetched && PIPE_SHELLS.has(lower)) return true;
    if (FETCHERS.has(lower)) fetched = true;
    if (/^(?:mkfs(?:\.[\w]+)?|shutdown|reboot|halt|poweroff)$/.test(name) || POWERSHELL_HOST.has(lower)) return true;
    if (name === 'dd' && args.some(arg => /^of=\/dev\//.test(arg.text))) return true;
    if (EVALUATORS.has(lower) || SUBSTITUTED.has(lower)) {
      if (args.some(arg => FETCHED_ARGUMENT.test(arg.text))) return true;
      const next = commands[index + 1];
      const last = args.at(-1);
      const opener = last === undefined ? EVALUATORS.has(lower) : last.literalFrom === Infinity && (last.text === '$' || last.text === '<' && SUBSTITUTED.has(lower));
      if (opener && next?.sep === '(' && FETCHERS.has(lowerName(destructiveCommandWords(next)[0]))) return true;
    }
    const {operands, options} = operandsOf(args);
    if (name === 'tee' && operands.some(arg => PROTECTED_TARGET.test(arg.text))) return true;
    if (name === 'shred' && operands.some(arg => arg.text.startsWith('/dev/'))) return true;
    if ((name === 'chmod' || name === 'chown') && recursiveOption(options) && operands.some(isRoot)) return true;
    if (name === 'kill' && operands.some(arg => arg.text === '1') && args.some((arg, at) => /^-(?:9|(?:SIG)?KILL)$/i.test(arg.text) ||
      ['-s', '-n'].includes(arg.text) && /^(?:9|(?:SIG)?KILL)$/i.test(args[at + 1]?.text ?? ''))) return true;
    if ((name === 'init' || name === 'telinit') && args[0]?.text === '0') return true;
    if (['nc', 'ncat', 'netcat'].includes(name) && options.some(option => /^-[A-Za-z]*[ec][A-Za-z]*$/.test(option) || /^--(?:sh-)?exec(?:=|$)/.test(option))) return true;
    if (name !== 'rm') continue;
    let recursive = false;
    let force = false;
    let parsing = true;
    let rootOrHome = false;
    for (const arg of args) {
      if (parsing && arg.text === '--') { parsing = false; continue; }
      if (parsing && arg.text.startsWith('-')) {
        if (arg.text === '--no-preserve-root') return true;
        if (arg.text === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(arg.text)) recursive = true;
        if (arg.text === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg.text)) force = true;
        continue;
      }
      rootOrHome ||= isRoot(arg) ||
        arg.homeExpansion && /^(?:\$HOME|\$\{HOME\})(?:\/)?$/.test(arg.text) ||
        arg.tildeExpansion && /^~\/?$/.test(arg.text);
    }
    if (recursive && force && rootOrHome) return true;
  }
  return windowsRecursiveRootDelete(command);
}
