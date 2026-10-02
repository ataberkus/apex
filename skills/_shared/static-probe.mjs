import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const LIMITS = Object.freeze({ entries: 1024, directories: 32, depth: 4, files: 128, fileBytes: 65536, totalBytes: 524288, gitHeadBytes: 1024, outputBytes: 16384 });
const SOURCE = new Set(['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.py', '.sql', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.go', '.java', '.kt', '.rb']);
const MANIFESTS = new Set(['package.json', 'tsconfig.json', 'Makefile', 'CMakeLists.txt', 'meson.build', 'build.gradle', 'pom.xml', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'pytest.ini']);
const LOCKS = new Map([['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['yarn.lock', 'yarn'], ['pnpm-lock.yaml', 'pnpm'], ['uv.lock', 'uv'], ['poetry.lock', 'poetry'], ['Cargo.lock', 'cargo']]);
const EXCLUDED = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '__pycache__', 'target', 'venv', 'env', 'private', 'secrets', 'credentials']);
const PRIVATE = /(?:^|[-_.])(?:secret|secrets|credential|credentials|auth|token|tokens|password|passwd|private|id_rsa|id_ed25519)(?:[-_.]|$)|\.(?:pem|key|p12|pfx|sqlite|sqlite3|db)$/i;

function requirements(name) { return /^requirements(?:[-.][\w-]+)?\.txt$/i.test(name); }
function privateName(name) { return name.startsWith('.') || PRIVATE.test(name); }
function count(files, pattern) { return files.reduce((sum, file) => sum + (file.text.match(pattern)?.length ?? 0), 0); }
function knownLibraries(files, names) {
  const declared = new Set();
  for (const file of files.filter(file => file.name === 'package.json')) {
    try {
      const manifest = JSON.parse(file.text);
      for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        if (manifest[group] && typeof manifest[group] === 'object') for (const name of Object.keys(manifest[group])) declared.add(name);
      }
    } catch { /* Malformed manifests provide no dependency evidence. */ }
  }
  return names.filter(name => declared.has(name) || files.some(file => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:["']${escaped}(?:["'/])|\\b(?:import|from)\\s+${escaped}(?:\\b|\\.))`).test(file.text);
  }));
}

// No project modules are imported. Public text is read into a bounded buffer;
// only fixed categories and aggregate counts can reach the JSON response.
async function boundedRead(path, expected, maxBytes) {
  let handle;
  try {
    if (await realpath(path) !== path) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || (expected && (stat.ino !== expected.ino || stat.dev !== expected.dev))) return null;
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes || await realpath(path) !== path) return null;
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytes: bytesRead };
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

async function scanRoot(cwd) {
  const scan = { entries: 0, directories: 0, filesRead: 0, bytesRead: 0, truncated: false, skipped: { private: 0, symlinks: 0, unsupported: 0, oversized: 0, depth: 0, unreadable: 0, excluded: 0, special: 0 } };
  const files = [];
  async function walk(dir, depth) {
    if (scan.directories >= LIMITS.directories) { scan.truncated = true; return; }
    if (depth > LIMITS.depth) { scan.skipped.depth++; scan.truncated = true; return; }
    let directory;
    try {
      const stat = await lstat(dir);
      if (stat.isSymbolicLink() || await realpath(dir) !== dir) { scan.skipped.symlinks++; return; }
      directory = await opendir(dir);
      scan.directories++;
    } catch { scan.skipped.unreadable++; return; }
    const entries = [];
    // opendir prevents an unbounded readdir allocation in huge directories.
    try {
      for await (const entry of directory) {
        if (scan.entries >= LIMITS.entries) { scan.truncated = true; break; }
        scan.entries++;
        entries.push(entry.name);
      }
    } catch { scan.skipped.unreadable++; }
    entries.sort();
    for (const name of entries) {
      const path = join(dir, name);
      let stat;
      try { stat = await lstat(path); } catch { scan.skipped.unreadable++; continue; }
      if (stat.isSymbolicLink()) { scan.skipped.symlinks++; continue; }
      if (privateName(name)) { scan.skipped.private++; continue; }
      if (EXCLUDED.has(name)) { scan.skipped.excluded++; continue; }
      if (stat.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1) { scan.skipped.special++; continue; }
      if (!SOURCE.has(extname(name)) && !MANIFESTS.has(name) && !LOCKS.has(name) && !requirements(name)) { scan.skipped.unsupported++; continue; }
      const relativePath = relative(cwd, path).replaceAll(sep, '/');
      if (LOCKS.has(name)) { files.push({ name, path: relativePath, text: '', metadataOnly: true }); continue; }
      if (stat.size > LIMITS.fileBytes) { scan.skipped.oversized++; scan.truncated = true; continue; }
      if (scan.filesRead >= LIMITS.files || scan.bytesRead + stat.size > LIMITS.totalBytes) { scan.truncated = true; continue; }
      const result = await boundedRead(path, stat, Math.min(LIMITS.fileBytes, LIMITS.totalBytes - scan.bytesRead));
      if (!result) { scan.skipped.unreadable++; continue; }
      scan.filesRead++;
      scan.bytesRead += result.bytes;
      files.push({ name, path: relativePath, text: result.text });
    }
  }
  await walk(cwd, 0);
  return { scan, files };
}

async function metadata(cwd, name) {
  const path = join(cwd, name);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || await realpath(path) !== path) return null;
    return stat;
  } catch { return null; }
}

async function gitFacts(cwd, files) {
  const marker = await metadata(cwd, '.git');
  const facts = { repositoryMarker: marker?.isDirectory() ? 'directory' : marker?.isFile() ? 'file' : 'absent', headMode: 'unknown', indexPresent: false, ignoreFilePresent: Boolean(await metadata(cwd, '.gitignore')), attributesFilePresent: Boolean(await metadata(cwd, '.gitattributes')), conflictMarkerSites: count(files, /^(?:<{7}|={7}|>{7})(?: |$)/gm) };
  // A .git file is only reported as a worktree marker; never follow its path.
  if (marker?.isDirectory()) {
    const git = join(cwd, '.git');
    const headStat = await metadata(git, 'HEAD');
    if (headStat?.isFile()) {
      const head = await boundedRead(join(git, 'HEAD'), headStat, LIMITS.gitHeadBytes);
      if (head) facts.headMode = /^ref: refs\/[\w./-]+\s*$/.test(head.text) ? 'symbolic' : /^[a-f0-9]{40,64}\s*$/i.test(head.text) ? 'detached' : 'unknown';
    }
    facts.indexPresent = Boolean((await metadata(git, 'index'))?.isFile());
  }
  return facts;
}

async function factsFor(domain, cwd, files) {
  const source = files.filter(file => SOURCE.has(extname(file.name)));
  const names = new Set(files.map(file => file.name));
  switch (domain) {
    case 'debugging': return {
      sourceFiles: source.length,
      diagnosticSites: count(source, /\b(?:console\.(?:error|warn)|debugger|logging\.(?:error|exception|warning))\b/g),
      errorHandlingSites: count(source, /\b(?:throw|catch|raise|except)\b/g),
      asyncSites: count(source, /\b(?:async|await|Promise)\b/g),
      sourceMapDirectiveSites: count(source, /sourceMappingURL\s*=/g),
    };
    case 'test-writing': return {
      testFiles: source.filter(file => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:^test_|[._-](?:test|spec)\.)/.test(file.path)).length,
      frameworks: knownLibraries(files, ['node:test', 'jest', 'vitest', 'mocha', 'pytest', 'unittest']),
      assertionSites: count(source, /\b(?:assert(?:\.[\w]+)?|expect)\s*\(?/g),
      testCaseSites: count(source, /\b(?:test|it|describe)\s*\(|\bdef\s+test_/g),
    };
    case 'profiling': return {
      timingSites: count(source, /\b(?:performance\.(?:now|mark|measure)|process\.hrtime(?:\.bigint)?|time\.(?:perf_counter|monotonic)|console\.time)\s*\(/g),
      benchmarkFiles: source.filter(file => /(?:^|\/)(?:bench|benchmark|benchmarks)(?:\/|$)|[._-]bench\./.test(file.path)).length,
      profilingLibraries: knownLibraries(files, ['benchmark', 'tinybench', 'cProfile', 'tracemalloc', 'pyinstrument']),
      runtime: { node: process.versions.node, v8: process.versions.v8, architecture: process.arch },
    };
    case 'build-systems': {
      let buildScriptDeclared = false;
      for (const file of files.filter(file => file.name === 'package.json')) {
        try { const scripts = JSON.parse(file.text).scripts; if (scripts && typeof scripts === 'object' && typeof scripts.build === 'string') buildScriptDeclared = true; } catch {}
      }
      return { manifests: [...names].filter(name => MANIFESTS.has(name) && name !== 'tsconfig.json').sort(), packageManagers: [...new Set(files.filter(file => LOCKS.has(file.name)).map(file => LOCKS.get(file.name)))].sort(), buildScriptDeclared, typescriptConfig: names.has('tsconfig.json') };
    }
    case 'python-packaging': {
      const pyproject = files.filter(file => file.name === 'pyproject.toml');
      return { pyproject: pyproject.length > 0, buildSystemTable: pyproject.some(file => /^\[build-system\]\s*$/m.test(file.text)), projectTable: pyproject.some(file => /^\[project\]\s*$/m.test(file.text)), requirementsFiles: files.filter(file => requirements(file.name)).length, setupFile: names.has('setup.py') || names.has('setup.cfg'), environmentMarker: Boolean((await metadata(cwd, '.venv'))?.isDirectory()), lockManagers: [...new Set(files.filter(file => ['uv.lock', 'poetry.lock'].includes(file.name)).map(file => LOCKS.get(file.name)))].sort() };
    }
    case 'numerics': return {
      libraries: knownLibraries(files, ['numpy', 'scipy', 'pandas', 'statsmodels', 'torch', 'jax']),
      fittingSites: count(source, /\b(?:lstsq|least_squares|curve_fit|polyfit|LinearRegression)\s*\(/g),
      randomSites: count(source, /\b(?:default_rng|randn|random|seed|manual_seed)\s*\(/g),
      toleranceSites: count(source, /\b(?:isclose|allclose|approx)\s*\(|\b(?:rtol|atol)\s*=/g),
      specialFloatSites: count(source, /\b(?:isnan|isfinite|isinf)\s*\(/g),
    };
    case 'http': return {
      frameworks: knownLibraries(files, ['node:http', 'node:https', 'express', 'fastify', 'koa', 'flask', 'django', 'aiohttp', 'uvicorn']),
      serverSites: count(source, /\b(?:createServer|listen|serve|run_app)\s*\(/g),
      routeSites: count(source, /\.(?:get|post|put|patch|delete|route)\s*\(|@\w+\.route\s*\(/g),
      timeoutSites: count(source, /\b(?:AbortSignal\.timeout|setTimeout)\s*\(|\b(?:requestTimeout|headersTimeout|timeout)\s*[:=]/g),
      tlsSites: count(source, /(?:["']node:https["']|\bssl_context\s*=|\bhttps\.createServer\s*\()/g),
    };
    case 'databases': return {
      migrationFiles: files.filter(file => extname(file.name) === '.sql' && /(?:^|\/)migrations?(?:\/|$)/.test(file.path)).length,
      schemaSites: count(source, /\bCREATE\s+(?:TABLE|INDEX|VIEW)\b/gi),
      transactionSites: count(source, /\b(?:BEGIN|COMMIT|ROLLBACK)\b|\.(?:transaction|beginTransaction)\s*\(/gi),
      querySites: count(source, /\.(?:query|execute|executemany|prepare)\s*\(/g),
      placeholderSites: count(source, /\$\d+\b|\?(?=[\s"'),;]|$)|%s\b/g),
      declaredClients: knownLibraries(files, ['pg', 'mysql2', 'better-sqlite3', 'sqlite3', 'sqlalchemy', 'psycopg', 'psycopg2']),
    };
    case 'git-surgery': return gitFacts(cwd, files);
    case 'security-hardening': return {
      controlLibraries: knownLibraries(files, ['helmet', 'bcrypt', 'argon2', 'csrf', 'cryptography']),
      cryptoSites: count(source, /\b(?:randomBytes|timingSafeEqual|scrypt|pbkdf2|compare_digest|token_bytes)\s*\(/g),
      validationSites: count(source, /\b(?:safeParse|validate|escapeHtml|sanitize)\s*\(/g),
      dynamicExecutionSites: count(source, /\b(?:eval|exec)\s*\(|\bnew\s+Function\s*\(|\bpickle\.loads\s*\(/g),
      transportControlSites: count(source, /\b(?:Strict-Transport-Security|Content-Security-Policy|SameSite)\b/gi),
    };
    default: throw new Error('unknown-domain');
  }
}

export async function runProbe(domain, args = process.argv.slice(2)) {
  const base = { schema: 1, domain, mode: 'static-offline', limits: LIMITS };
  let result;
  if (args.length !== 2 || args[0] !== '--cwd' || typeof args[1] !== 'string' || args[1].length === 0 || args[1].includes('\0')) {
    result = { ...base, ok: false, error: 'invalid-arguments' };
  } else {
    const cwd = resolve(args[1]);
    try {
      const stat = await lstat(cwd);
      if (stat.isSymbolicLink() || await realpath(cwd) !== cwd) result = { ...base, ok: false, error: 'unsafe-root' };
      else if (!stat.isDirectory()) result = { ...base, ok: false, error: 'unreadable-root' };
      else {
        const { scan, files } = await scanRoot(cwd);
        result = { ...base, ok: true, scan, facts: await factsFor(domain, cwd, files) };
      }
    } catch { result = { ...base, ok: false, error: 'unreadable-root' }; }
  }
  let json = JSON.stringify(result);
  if (Buffer.byteLength(json) + 1 > LIMITS.outputBytes) { result = { ...base, ok: false, error: 'output-limit' }; json = JSON.stringify(result); }
  process.stdout.write(`${json}\n`);
  if (!result.ok) process.exitCode = 1;
}
