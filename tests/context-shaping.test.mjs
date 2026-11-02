import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, readdir, rm, mkdir, stat, writeFile, chmod, link} from 'node:fs/promises';
import {basename, join, resolve, relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createBashToolDefinition} from '@earendil-works/pi-coding-agent';
import {directoryLink, unixOnly} from './fixtures/filesystem.mjs';
import * as reference from './fixtures/shaping-d0c6d2b.mjs';

let shaping;
try { shaping = await import('../extensions/apex-context/shaping.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

async function shape(event, options) {
  assert.equal(typeof shaping?.shapeToolResult, 'function', 'real shaping module must exist');
  return shaping.shapeToolResult(event, options);
}
async function fixture(t) {
  const cwd = await mkdtemp(join(process.cwd(), 'shaping-fixture-'));
  t.after(() => rm(cwd, {recursive:true, force:true}));
  return cwd;
}
const event = (text, extra = {}) => ({toolName:'bash', toolCallId:'call-1', input:{command:'printf output'},
  content:[{type:'text', text}], isError:false, ...extra});
const textOf = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const linesOf = text => text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
const longOutput = () => ['HEAD', ...Array.from({length:160}, (_, i) => `ordinary output row ${i}`), 'TAIL'].join('\n');

test('short unchanged text is inert and creates no directory', async t => {
  const cwd = await fixture(t);
  assert.equal(await shape(event('plain result\n'), {cwd}), undefined);
  assert.deepEqual(await readdir(cwd), []);
});

test('module import is inert in a fresh process', async t => {
  const cwd = await fixture(t);
  assert.equal(typeof shaping?.shapeToolResult, 'function', 'real shaping module must exist');
  const file = resolve('extensions/apex-context/shaping.mjs');
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)});`],
    {cwd, encoding:'utf8'});
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(await readdir(cwd), []);
});

test('ANSI cleanup, carriage-return progress and repeated lines retain exact raw spill', async t => {
  const cwd = await fixture(t);
  const raw = '\u001b[31mHEAD\u001b[0m\nfetching 10%\rfetching 90%\rfetching 100%\n' +
    Array(12).fill('waiting').join('\n') + '\nDONE\n';
  const result = await shape(event(raw), {cwd});
  const output = textOf(result);
  assert.doesNotMatch(output, /\u001b|\r|fetching 10%|fetching 90%/);
  assert.match(output, /fetching 100%/);
  assert.match(output, /waiting.*×12/);
  assert.match(output, /HEAD/);
  assert.match(output, /DONE/);
  assert.equal(await readFile(result.details.apexShape.logPath, 'utf8'), raw);
  assert.equal(result.details.apexShape.logScope, 'hook-visible-result');
  assert.equal(result.details.apexShape.logFormat, 'text-content');
  assert.equal(result.details.apexShape.originalBytes, Buffer.byteLength(raw));
  assert.equal(result.details.apexShape.returnedBytes, Buffer.byteLength(output));
});

test('newline progress bars are condensed without hiding a progress-adjacent failure', async t => {
  const cwd = await fixture(t);
  const raw = 'HEAD\nfetch [====>      ] 10%\nfetch [======>    ] 30%\n' +
    'error: downloaded package is invalid\rfetch [==========>] 100%\nTAIL';
  const result = await shape(event(raw,{isError:true,input:{command:'npm install'}}),{cwd});
  const output = textOf(result);
  assert.doesNotMatch(output, /\[[=> .-]{5,}\]|10%/);
  assert.match(output, /30%/);
  assert.match(output, /error: downloaded package is invalid/);
  assert.match(output, /100%/);
  assert.equal(await readFile(result.details.apexShape.logPath,'utf8'),raw);
});

test('caps include newlines, omission markers and log reference while retaining head and tail', async t => {
  const cwd = await fixture(t);
  const result = await shape(event(longOutput()), {cwd, maxBytes:720, maxLines:12});
  const output = textOf(result);
  assert.ok(Buffer.byteLength(output) <= 720);
  assert.ok(linesOf(output) <= 12);
  assert.match(output, /HEAD/);
  assert.match(output, /TAIL/);
  assert.match(output, /omitted/);
  assert.match(output, /\.apex\/out\/[^\s]+\.log/);
});

test('Unicode long lines keep both ends without replacement characters or excess bytes', async t => {
  const cwd = await fixture(t);
  const raw = 'START-' + '🦊漢字'.repeat(800) + '-FINISH';
  const result = await shape(event(raw), {cwd, maxBytes:256, maxLines:8});
  const output = textOf(result);
  assert.ok(Buffer.byteLength(output) <= 256);
  assert.doesNotMatch(output, /\ufffd/);
  assert.match(output, /START-/);
  assert.match(output, /-FINISH/);
  assert.equal(await readFile(result.details.apexShape.logPath, 'utf8'), raw);
});

test('test failure context and assertion diff in the middle survive bounded selection', async t => {
  const cwd = await fixture(t);
  const raw = ['runner started', ...Array.from({length:80}, (_, i) => `PASS case ${i}`),
    'FAIL test/math.test.js', 'AssertionError: values differ', '- expected 42', '+ received 41',
    ...Array.from({length:80}, (_, i) => `PASS rest ${i}`), 'Tests: 1 failed, 160 passed'].join('\n');
  const result = await shape(event(raw, {isError:true, input:{command:'npm test'}}), {cwd,maxBytes:1200,maxLines:20});
  const output = textOf(result);
  for (const line of ['runner started','FAIL test/math.test.js','AssertionError: values differ',
    '- expected 42','+ received 41','Tests: 1 failed, 160 passed']) assert.ok(output.includes(line), line);
  assert.ok(Buffer.byteLength(output) <= 1200);
  assert.ok(linesOf(output) <= 20);
});

test('compiler diagnostics and package-manager failures survive the middle of output', async t => {
  const cwd = await fixture(t);
  for (const [command, diagnostic] of [['tsc --noEmit','src/main.ts(12,3): error TS2322: type mismatch'],
    ['npm install','npm ERR! ERESOLVE unable to resolve dependency tree']]) {
    const raw = ['HEAD', ...Array.from({length:90}, (_, i) => `step ${i}`), diagnostic,
      '  required by src/main.ts:14', ...Array.from({length:90}, (_, i) => `later ${i}`), 'Command exited with code 1'].join('\n');
    const result = await shape(event(raw, {isError:true,input:{command}}), {cwd,maxBytes:900,maxLines:16});
    assert.ok(textOf(result).includes(diagnostic));
    assert.match(textOf(result), /HEAD/);
    assert.match(textOf(result), /Command exited with code 1/);
  }
});

test('git diff keeps a hunk and changed lines with bounded head/tail', async t => {
  const cwd = await fixture(t);
  const raw = ['diff --git a/code.js b/code.js', ...Array.from({length:70}, (_, i) => ` context ${i}`),
    '@@ -72,2 +72,2 @@', '-old behavior', '+new behavior',
    ...Array.from({length:70}, (_, i) => ` later ${i}`), 'diff complete'].join('\n');
  const result = await shape(event(raw,{input:{command:'git diff'}}), {cwd,maxBytes:900,maxLines:16});
  assert.match(textOf(result), /@@ -72,2 \+72,2 @@/);
  assert.match(textOf(result), /-old behavior/);
  assert.match(textOf(result), /\+new behavior/);
  assert.match(textOf(result), /diff complete/);
});

test('native Bash structured output remains coherent with shaped content and status fields', async t => {
  const cwd = await fixture(t);
  const native = createBashToolDefinition(cwd, {exposeSessionEnvironment:false,operations:{
    async exec(_command, _cwd, {onData}) {onData(Buffer.from(longOutput())); return {exitCode:7};}
  }});
  const original = await native.execute('native', {command:'npm test'});
  const result = await shape(event('', {...original,input:{command:'npm test'}}), {cwd,maxBytes:700,maxLines:12});
  assert.equal(result.structuredContent.output, textOf(result));
  assert.equal(result.structuredContent.truncated, true);
  assert.equal(result.structuredContent.exit_code, 7);
  assert.equal(result.structuredContent.wall_time_seconds, original.structuredContent.wall_time_seconds);
  assert.equal(result.structuredContent.full_output_path, result.details.apexShape.logPath);
  assert.match(textOf(result), /Command exited with code 7/);
  assert.equal(original.structuredContent.output, longOutput());
});

test('nested native Bash JSON remains intact for codemode before parent output is shaped', async t => {
  const cwd = await fixture(t);
  const data = {padding:'x'.repeat(20 * 1024),answer:42};
  const raw = JSON.stringify(data);
  const native = createBashToolDefinition(cwd, {exposeSessionEnvironment:false,operations:{
    async exec(_command, _cwd, {onData}) {onData(Buffer.from(raw)); return {exitCode:0};}
  }});
  const original = await native.execute('codemode-parent/1',{command:'printf JSON'});
  const snapshot = structuredClone(original);
  assert.ok(Buffer.byteLength(raw) > 20 * 1024);
  for (const parentToolCallId of ['codemode-parent','']) {
    const nested = event('',{...original,toolCallId:'codemode-parent/1',parentToolCallId});
    assert.equal(await shape(nested,{cwd,maxBytes:8192,maxLines:120}),undefined);
    assert.deepEqual(original,snapshot);
    assert.deepEqual(JSON.parse(nested.structuredContent.output),data);
  }
  assert.deepEqual(await readdir(cwd),[]);
  const emitted = event('42',{toolName:'codemode',input:{code:'text(JSON.parse(result.output).answer)'}});
  assert.equal(await shape(emitted,{cwd}),undefined);
  assert.deepEqual(await readdir(cwd),[]);
  const parent = await shape(event(raw,{toolName:'codemode',input:{code:'text(result.output)'}}),{cwd});
  assert.ok(Buffer.byteLength(textOf(parent)) <= 8192);
  assert.equal(await readFile(parent.details.apexShape.logPath,'utf8'),raw);
});

test('native full-output pointer is preserved and spill contains only hook-visible text', async t => {
  const cwd = await fixture(t);
  const nativePath = join(cwd, 'native-full.log');
  await writeFile(nativePath, 'unseen earlier output\n' + longOutput());
  const raw = longOutput();
  const details = {fullOutputPath:nativePath,truncation:{truncated:true,totalBytes:90000},customDetail:42};
  const structuredContent = {output:raw,truncated:true,full_output_path:nativePath,exit_code:0,wall_time_seconds:0.1};
  const result = await shape(event(raw,{details,structuredContent}), {cwd,maxBytes:700,maxLines:12});
  assert.equal(result.details.fullOutputPath, nativePath);
  assert.equal(result.details.customDetail, 42);
  assert.equal(result.details.apexShape.nativeFullOutputPath, nativePath);
  assert.equal(result.details.apexShape.sourceTruncated, true);
  assert.equal(result.structuredContent.full_output_path, nativePath);
  assert.equal(await readFile(result.details.apexShape.logPath, 'utf8'), raw);
  assert.doesNotMatch(await readFile(result.details.apexShape.logPath, 'utf8'), /unseen earlier/);
  assert.deepEqual(details, {fullOutputPath:nativePath,truncation:{truncated:true,totalBytes:90000},customDetail:42});
});

test('real native Bash overflow distinguishes model text bytes from structured output bytes', async t => {
  const cwd = await fixture(t);
  const raw = ['UNSEEN ORIGINAL HEAD', ...Array.from({length:2600}, (_, i) => `native row ${i} with ordinary output`),
    'NATIVE TAIL'].join('\n');
  const native = createBashToolDefinition(cwd, {exposeSessionEnvironment:false,operations:{
    async exec(_command, _cwd, {onData}) {onData(Buffer.from(raw)); return {exitCode:0};}
  }});
  const previousTempDirectory = process.env.TMPDIR;
  let original;
  try {process.env.TMPDIR = cwd; original = await native.execute('overflow', {command:'printf output'});}
  finally {
    if (previousTempDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTempDirectory;
  }
  assert.equal(original.details.truncation.truncated, true);
  assert.equal(original.structuredContent.output, raw);
  assert.equal(original.structuredContent.truncated, false);
  assert.doesNotMatch(textOf(original), /UNSEEN ORIGINAL HEAD/);
  assert.equal(await readFile(original.details.fullOutputPath,'utf8'),raw);
  const result = await shape(event('',{...original}),{cwd,maxBytes:800,maxLines:14});
  assert.equal(result.details.fullOutputPath,original.details.fullOutputPath);
  assert.equal(result.structuredContent.full_output_path,original.details.fullOutputPath);
  assert.equal(result.details.apexShape.sourceTruncated,true);
  assert.equal(result.details.apexShape.originalBytes,Buffer.byteLength(textOf(original)));
  assert.equal(result.details.apexShape.structuredOriginalBytes,Buffer.byteLength(raw));
  assert.equal(await readFile(result.details.apexShape.logPath,'utf8'),textOf(original));
  assert.equal(result.structuredContent.output,textOf(result));
});

test('unknown custom structured schemas preserve the result without a spill', async t => {
  const cwd = await fixture(t);
  for (const [toolName, structuredContent] of [['custom',{output:longOutput(),rows:[1,2]}],
    ['bash',{output:longOutput(),truncated:false,exit_code:0,wall_time_seconds:0,extra:'custom'}],
    ['bash',{output:longOutput()}]]) {
    assert.equal(await shape(event(longOutput(),{toolName,structuredContent}), {cwd,maxBytes:300,maxLines:5}), undefined);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test('non-path custom details cannot corrupt the native structured path schema', async t => {
  const cwd = await fixture(t);
  const structuredContent = {output:longOutput(),truncated:false,exit_code:0,wall_time_seconds:0};
  const result = await shape(event(longOutput(),{details:{fullOutputPath:42},structuredContent}),
    {cwd,maxBytes:500,maxLines:8});
  assert.equal(result.details.fullOutputPath,42);
  assert.equal(result.structuredContent.full_output_path,result.details.apexShape.logPath);
  assert.equal(result.details.apexShape.nativeFullOutputPath,undefined);
  const nativePath = join(cwd,'valid-native.log');
  const native = await shape(event(longOutput(),{details:{fullOutputPath:42},
    structuredContent:{...structuredContent,full_output_path:nativePath}}),{cwd,maxBytes:500,maxLines:8});
  assert.equal(native.structuredContent.full_output_path,nativePath);
  assert.equal(native.details.apexShape.nativeFullOutputPath,nativePath);
});

test('nontext payloads survive exactly while the neighboring text is shaped', async t => {
  const cwd = await fixture(t);
  const image = {type:'image',data:'exact-base64-image',mimeType:'image/png'};
  const result = await shape(event(longOutput(),{toolName:'read',content:[{type:'text',text:longOutput()},image]}),
    {cwd,maxBytes:500,maxLines:8});
  assert.equal(result.content[1], image);
  assert.ok(Buffer.byteLength(textOf(result)) <= 500);
  assert.equal(await shape(event('',{content:[image]}),{cwd}), undefined);
});

test('malicious IDs cannot escape and simultaneous spills are exclusive and restrictive', async t => {
  const cwd = await fixture(t);
  const raw = longOutput();
  const results = await Promise.all(Array.from({length:16}, () => shape(event(raw,
    {toolCallId:'../../outside\n../..\\evil\0'}), {cwd,maxBytes:500,maxLines:8})));
  const paths = results.map(item => item.details.apexShape.logPath);
  assert.equal(new Set(paths).size, 16);
  for (const path of paths) {
    assert.equal(relative(join(cwd,'.apex','out'), path).includes('..'), false);
    assert.match(path, /\.log$/);
    assert.equal(await readFile(path,'utf8'), raw);
  }
  await t.test('POSIX private spill permissions', {skip: unixOnly}, async () => {
    for (const path of paths) assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(cwd,'.apex'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(cwd,'.apex','out'))).mode & 0o777, 0o700);
  });
  assert.equal((await readdir(join(cwd,'.apex','out'))).length, 16);
});

test('Windows spills have protected owner-only ACLs and refuse public directories or existing hard links',
  {skip:process.platform !== 'win32' && 'Requires native Windows ACLs'}, async t => {
  const cwd = await fixture(t);
  const raw = longOutput();
  const original = event(raw);
  const snapshot = structuredClone(original);
  const result = await shape(original, {cwd,maxBytes:500,maxLines:8});
  assert.deepEqual(original, snapshot);
  assert.ok(Buffer.byteLength(textOf(result)) <= 500);
  assert.equal(await readFile(result.details.apexShape.logPath,'utf8'),raw);
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const paths = [join(cwd,'.apex'),join(cwd,'.apex','out'),result.details.apexShape.logPath];
  const literals = paths.map(path => `'${path.replace(/'/g,"''")}'`).join(',');
  const inspect = spawnSync(executable, ['-NoLogo','-NoProfile','-NonInteractive','-Command', `
    $sid = [System.Security.Principal.SecurityIdentifier]
    $rows = @(${literals}) | ForEach-Object {
      $acl = Get-Acl -LiteralPath $_
      [pscustomobject]@{ owner=$acl.GetOwner($sid).Value; protected=$acl.AreAccessRulesProtected
        rules=@($acl.GetAccessRules($true,$true,$sid) | ForEach-Object {
          [pscustomobject]@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString()}
        })
      }
    }
    [pscustomobject]@{user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;entries=@($rows)} |
      ConvertTo-Json -Depth 5 -Compress
  `], {encoding:'utf8'});
  assert.equal(inspect.status,0,inspect.stderr);
  const acl = JSON.parse(inspect.stdout);
  for (const entry of acl.entries) {
    assert.equal(entry.owner,acl.user);
    assert.equal(entry.protected,true);
    assert.deepEqual(entry.rules,[{sid:acl.user,type:'Allow',rights:'FullControl'}]);
  }
  const helper = fileURLToPath(new URL('../extensions/apex-context/private-spill.ps1',import.meta.url));
  const collision = spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',helper,cwd,basename(result.details.apexShape.logPath)],
    {input:'must not overwrite the recoverable log',encoding:'utf8'});
  assert.equal(collision.status,1,collision.stderr);
  assert.equal(await readFile(result.details.apexShape.logPath,'utf8'),raw);
  const victim = join(cwd,'victim.log');
  const hardlinkName = `hardlink-${'a'.repeat(32)}.log`;
  const destination = join(cwd,'.apex','out',hardlinkName);
  await writeFile(victim,'unrelated original');
  await link(victim,destination);
  const hardlink = spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',helper,cwd,hardlinkName],
    {input:'must not modify either hard link',encoding:'utf8'});
  assert.equal(hardlink.status,1,hardlink.stderr);
  assert.equal(await readFile(victim,'utf8'),'unrelated original');
  assert.equal(await readFile(destination,'utf8'),'unrelated original');
  assert.equal((await stat(victim)).nlink,2);
  const publicCwd = await fixture(t);
  await mkdir(join(publicCwd,'.apex'));
  const unsafe = event(raw);
  const unsafeSnapshot = structuredClone(unsafe);
  await assert.rejects(() => shape(unsafe,{cwd:publicCwd,maxBytes:500,maxLines:8}), /retained raw output.*protected owner-only ACLs/s);
  assert.deepEqual(unsafe,unsafeSnapshot);
  assert.deepEqual(await readdir(join(publicCwd,'.apex')),[]);
});

test('owned logs remain owner-readable under a restrictive process umask', {skip: unixOnly}, async t => {
  const unsafeCwd = await fixture(t);
  await mkdir(join(unsafeCwd,'.apex'));
  await chmod(join(unsafeCwd,'.apex'),0o777);
  assert.equal(await shape(event(longOutput()),{cwd:unsafeCwd,maxBytes:500,maxLines:8}),undefined);
  assert.equal((await stat(join(unsafeCwd,'.apex'))).mode & 0o777,0o777);
  assert.deepEqual(await readdir(join(unsafeCwd,'.apex')),[]);
  const cwd = await fixture(t);
  const previousUmask = process.umask(0o777);
  let result;
  try {result = await shape(event(longOutput()),{cwd,maxBytes:500,maxLines:8});}
  finally {process.umask(previousUmask);}
  assert.equal((await stat(result.details.apexShape.logPath)).mode & 0o777,0o600);
  assert.equal(await readFile(result.details.apexShape.logPath,'utf8'),longOutput());
});

test('symlinked output directories are rejected without writing outside .apex', async t => {
  const cwd = await fixture(t);
  const outside = await fixture(t);
  const reject = async () => {
    const original = event(longOutput());
    const snapshot = structuredClone(original);
    if (process.platform === 'win32') {
      await assert.rejects(() => shape(original,{cwd,maxBytes:500,maxLines:8}), /Apex retained raw output/);
    } else {
      assert.equal(await shape(original,{cwd,maxBytes:500,maxLines:8}), undefined);
    }
    assert.deepEqual(original,snapshot);
  };
  await directoryLink(outside, join(cwd,'.apex'));
  await reject();
  assert.deepEqual(await readdir(outside), []);
  await rm(join(cwd,'.apex'));
  if (process.platform === 'win32') {
    await shape(event(longOutput()),{cwd,maxBytes:500,maxLines:8});
    await rm(join(cwd,'.apex','out'),{recursive:true});
  } else {
    await mkdir(join(cwd,'.apex'),{mode:0o700});
  }
  await directoryLink(outside, join(cwd,'.apex','out'));
  await reject();
  assert.deepEqual(await readdir(outside), []);
});

test('newline-heavy output and very small valid caps remain bounded', async t => {
  const cwd = await fixture(t);
  for (const [maxBytes,maxLines] of [[120,3],[16,1],[1,1]]) {
    const result = await shape(event('HEAD\n' + '\n'.repeat(500) + 'TAIL'), {cwd,maxBytes,maxLines});
    assert.ok(Buffer.byteLength(textOf(result)) <= maxBytes);
    assert.ok(linesOf(textOf(result)) <= maxLines);
    assert.equal(result.details.apexShape.returnedBytes, Buffer.byteLength(textOf(result)));
  }
});

test('invalid caps fail before any filesystem mutation', async t => {
  const cwd = await fixture(t);
  for (const options of [{maxBytes:0},{maxLines:0},{maxBytes:NaN},{maxLines:1.5}]) {
    await assert.rejects(() => shape(event(longOutput()),{cwd,...options}), /positive integer/);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test('non-read results are byte-identical to the d0c6d2b shaper over seeded random outputs and caps', async t => {
  const cwd = await fixture(t);
  let seed = 20261102;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const pick = items => items[Math.floor(random() * items.length)];
  const atoms = ['ok', 'compiled', 'FAIL test', 'Error: boom', '@@ -1,2 +1,3 @@', '+added', '-removed', '  context',
    'src/a.ts:12:5 warning', 'émoji 😀 multi', '中文字符', '', '   ', 'npm ERR! x', 'not ok 3', 'Traceback (most recent call last):',
    '[=====>    ] 45%', 'x'.repeat(300), 'y'.repeat(9000), '+++ b/file', 'E   assert 1 == 2', 'fetch 10%\rfetch 100%',
    'warn\rerror: overwritten', '\u001b[31mred\u001b[0m', `AssertionError: ${'z'.repeat(2500)}`, `+${'q'.repeat(700)}`, `-${'й'.repeat(90)}`];
  const commands = ['npm test', 'git diff', 'git log -p', 'npm install', 'tsc -p .', 'pytest -x', 'make', 'ls -la'];
  const capList = [[8192,120],[2000,30],[500,10],[120,3],[60,2],[30,1],[1,1],[200,1],[20000,400],[64,400]];
  let shaped = 0;
  for (let index = 0; index < 120; index++) {
    const lines = Array.from({length:Math.floor(random() ** 2 * 600)}, () => {
      let line = pick(atoms);
      if (random() < 0.5) line += ` ${Math.floor(random() * 1e6)}`;
      return random() < 0.1 ? line + line : line;
    });
    const raw = lines.join(random() < 0.1 ? '\r\n' : '\n') + (random() < 0.5 ? '\n' : '');
    const toolName = pick(['bash', 'bash', 'powershell', 'grep', 'find', 'codemode']);
    const structured = ['bash', 'powershell'].includes(toolName) && random() < 0.3 ?
      {structuredContent:{output:raw, truncated:false, exit_code:1, wall_time_seconds:0.5}} : {};
    const input = event(raw, {toolName, toolCallId:`diff-${index}`, input:{command:pick(commands)}, ...structured});
    const [maxBytes, maxLines] = random() < 0.7 ? pick(capList) : [1 + Math.floor(random() * 12000), 1 + Math.floor(random() * 200)];
    const before = await reference.shapeToolResult(structuredClone(input), {cwd, maxBytes, maxLines});
    const after = await shape(structuredClone(input), {cwd, maxBytes, maxLines});
    if (!before) { assert.equal(after, undefined, `case ${index}`); continue; }
    shaped++;
    // Spill names are random; everything else, including model text and metadata, must match exactly.
    const expected = JSON.stringify(before).replaceAll(basename(before.details.apexShape.logPath), basename(after.details.apexShape.logPath));
    assert.equal(JSON.stringify(after), expected, `case ${index}: ${maxBytes} bytes, ${maxLines} lines, ${lines.length} input lines`);
    // Caps the reference output fills exactly, or misses by one byte or line, probe the acceptance boundary.
    const {returnedBytes, returnedLines} = before.details.apexShape;
    for (const [boundBytes, boundLines] of [[returnedBytes, returnedLines], [Math.max(1, returnedBytes - 1), returnedLines],
      [returnedBytes, Math.max(1, returnedLines - 1)]]) {
      const bounded = await shape(structuredClone(input), {cwd, maxBytes:boundBytes, maxLines:boundLines});
      const pointer = `[Apex shaped; hook log .apex/out/${basename(bounded.details.apexShape.logPath)}]`;
      const text = reference.selectText(reference.cleanText(raw), pointer, input, boundBytes, boundLines);
      assert.equal(textOf(bounded), text, `case ${index}: ${boundBytes} bytes, ${boundLines} lines`);
      assert.equal(bounded.details.apexShape.returnedLines, linesOf(text));
    }
  }
  assert.ok(shaped > 80, `only ${shaped} shaped cases`);
});

test('selection work stays linear: a 1 MB git diff scans a bounded multiple of its input', async t => {
  const cwd = await fixture(t);
  const lines = [];
  for (let index = 0, size = 0; size < 1 << 20; index++) {
    const line = index % 7 === 0 ? `@@ -${index},7 +${index},8 @@ function f${index}()` :
      index % 3 ? `+  const v${index} = compute(${index});` : `   unchanged line ${index}`;
    lines.push(line);
    size += line.length + 1;
  }
  const raw = lines.join('\n') + '\n';
  // Count characters handed to Buffer.byteLength (shaping and Pi's truncateHead both measure through it).
  // Re-rendering the selection for every candidate scanned roughly 1900x this input; incremental
  // accounting scans each candidate line a few times.
  const byteLength = Buffer.byteLength;
  let scanned = 0;
  let result;
  Buffer.byteLength = function (value, ...rest) {
    if (typeof value === 'string') scanned += value.length;
    return byteLength.call(this, value, ...rest);
  };
  try { result = await shape(event(raw, {input:{command:'git diff'}}), {cwd}); }
  finally { Buffer.byteLength = byteLength; }
  const output = textOf(result);
  assert.ok(Buffer.byteLength(output) <= 8192 && linesOf(output) <= 120);
  assert.match(output, /^@@ -0,7 \+0,8 @@ function f0\(\)\n/);
  // The floor proves the probe saw the work: a runtime that bypassed the patched property would scan 0.
  assert.ok(scanned >= raw.length, `probe saw only ${scanned} characters`);
  assert.ok(scanned < 25 * raw.length, `${(scanned / raw.length).toFixed(1)}x input scanned`);
});
