import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonRuntime } from './python-runtime.mjs';

const PINS = Object.freeze({
  pi_version: '1.4.0',
  pi_source_commit: '4a080252f06caf63a525d7873c5d94d3c23887e0',
  harbor_version: '0.23.0',
  harbor_commit: '99218a4611e3bd76e49ce3b5f977e8c8134ad3ac',
  node_minimum: '22.19.0',
  python_minimum: '3.12.0',
});

const PYTHON_METADATA = `
import importlib.metadata as metadata
import json
import platform

harbor_version = None
harbor_commit = None
try:
    distribution = metadata.distribution("harbor")
    harbor_version = distribution.version
    direct_url = json.loads(distribution.read_text("direct_url.json") or "{}")
    harbor_commit = direct_url.get("vcs_info", {}).get("commit_id")
except (metadata.PackageNotFoundError, ValueError, TypeError, AttributeError, OSError):
    pass
print(json.dumps({"python_version": platform.python_version(), "harbor_version": harbor_version, "harbor_commit": harbor_commit}))
`;

function version(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][a-zA-Z0-9.-]+)?$/);
  return match ? match.slice(1, 4).join('.') : null;
}

function atLeast(actual, minimum) {
  if (!actual) return false;
  const current = actual.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

function readJson(filename) {
  try {
    const value = JSON.parse(readFileSync(filename, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function commandEnvironment() {
  const environment = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'Temp', 'Tmp']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function probe(command, args, options) {
  try {
    const result = spawnSync(command, args, options);
    if (result.error || result.status !== 0) {
      const reason = result.error?.code === 'ENOENT' ? 'missing-executable'
        : result.error?.code === 'ETIMEDOUT' ? 'timed-out' : 'probe-failed';
      return { ok: false, reason };
    }
    return { ok: true, stdout: typeof result.stdout === 'string' ? result.stdout.trim() : '' };
  } catch {
    return { ok: false, reason: 'probe-failed' };
  }
}

export function classifyReadiness(checks) {
  const required = checks.filter(check => check.required !== false);
  return required.length > 0 && required.every(check => check.status === 'pass') ? 'tooling-ready' : 'blocked';
}

/** Read-only tooling probes. This does not assess or run a model or benchmark. */
export function runPreflight({ projectRoot = process.cwd() } = {}) {
  const root = path.resolve(projectRoot);
  const checks = [];
  const addCheck = (id, passed, details = {}) => checks.push({ id, status: passed ? 'pass' : 'blocked', required: true, ...details });
  const options = { cwd: root, env: commandEnvironment(), encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 32768 };
  const pins = readJson(path.join(root, 'evals', 'versions.json'));
  const config = readJson(path.join(root, 'evals', 'config.json'));

  addCheck('version-pins', pins?.pi?.version === PINS.pi_version
    && pins?.pi?.source_commit === PINS.pi_source_commit
    && pins?.pi?.node_minimum === PINS.node_minimum
    && pins?.harbor?.version === PINS.harbor_version
    && pins?.harbor?.commit === PINS.harbor_commit,
  { message: 'Project version pins must match the approved Pi and Harbor sources.' });
  addCheck('execution-policy', config?.paid_runs_enabled === false && config?.execution_policy === 'offline-only',
    { message: 'Paid runs must be disabled and execution policy must be offline-only.' });

  const bunVersion = version(process.versions.bun);
  addCheck('bun', atLeast(bunVersion, '1.4.3'), { observed: bunVersion, minimum: '1.4.3' });

  const piPackage = readJson(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'));
  const piVersion = version(piPackage?.version);
  addCheck('pi-pin', piPackage?.version === PINS.pi_version, { observed: piVersion, expected: PINS.pi_version });

  let pythonMetadata = null;
  let pythonReason = 'missing-executable';
  try {
    const runtime = pythonRuntime(root, options);
    const result = probe(runtime.command, [...runtime.prefix, '-I', '-B', '-c', PYTHON_METADATA], options);
    pythonReason = result.reason ?? 'invalid-metadata';
    if (result.ok) {
      try { pythonMetadata = JSON.parse(result.stdout); } catch { /* Output is never echoed. */ }
    }
  } catch { /* Interpreter paths and errors may contain private values. */ }
  const pythonVersion = version(pythonMetadata?.python_version);
  const harborVersion = version(pythonMetadata?.harbor_version);
  const harborCommit = typeof pythonMetadata?.harbor_commit === 'string' && /^[a-f0-9]{40}$/i.test(pythonMetadata.harbor_commit)
    ? pythonMetadata.harbor_commit.toLowerCase() : null;
  addCheck('python', atLeast(pythonVersion, PINS.python_minimum), {
    observed: pythonVersion, minimum: PINS.python_minimum, ...(pythonVersion ? {} : { reason: pythonReason }),
  });
  addCheck('harbor-pin', pythonMetadata?.harbor_version === PINS.harbor_version && harborCommit === PINS.harbor_commit, {
    observed_version: harborVersion, observed_commit: harborCommit,
    expected_version: PINS.harbor_version, expected_commit: PINS.harbor_commit,
    message: 'Installed Harbor must include the pinned VCS commit; a same-version wheel is insufficient.',
  });

  const localDocker = {
    endpoint_scope: 'local',
    endpoint: process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock',
    cli_available: false,
    daemon_reachable: false,
    daemon_os: null,
    compose_available: false,
    compose_wait_supported: false,
    ready: false,
  };
  let configDirectory;
  try {
    configDirectory = mkdtempSync(path.join(root, '.apex-preflight-'));
    const dockerArgs = ['--config', configDirectory, '--host', localDocker.endpoint];
    const docker = probe('docker', [...dockerArgs, '--version'], options);
    const dockerVersion = docker.ok ? version(docker.stdout.match(/^Docker version (\S+),?/)?.[1]?.replace(/,$/, '')) : null;
    localDocker.cli_available = docker.ok && dockerVersion !== null;
    addCheck('docker-cli', localDocker.cli_available, { observed: dockerVersion, ...(localDocker.cli_available ? {} : { reason: docker.reason ?? 'invalid-version' }) });

    const unavailable = { ok: false, reason: 'docker-unavailable' };
    const info = localDocker.cli_available ? probe('docker', [...dockerArgs, 'info', '--format', '{{.OSType}}'], options) : unavailable;
    localDocker.daemon_reachable = info.ok;
    localDocker.daemon_os = info.ok && ['linux', 'windows'].includes(info.stdout) ? info.stdout : null;
    addCheck('docker-daemon', localDocker.daemon_reachable && localDocker.daemon_os === 'linux', {
      observed_os: localDocker.daemon_os, expected_os: 'linux',
      ...(info.ok ? {} : { reason: info.reason }),
      message: 'The local daemon must support Linux containers. Windows users can run this check inside WSL2 Ubuntu.',
    });

    const compose = localDocker.cli_available ? probe('docker', [...dockerArgs, 'compose', 'version', '--short'], options) : unavailable;
    const composeVersion = compose.ok ? version(compose.stdout) : null;
    localDocker.compose_available = compose.ok && composeVersion !== null;
    addCheck('docker-compose', localDocker.compose_available, { observed: composeVersion, ...(localDocker.compose_available ? {} : { reason: compose.reason ?? 'invalid-version' }) });
    const help = localDocker.compose_available ? probe('docker', [...dockerArgs, 'compose', 'up', '--help'], options) : unavailable;
    localDocker.compose_wait_supported = help.ok && /(?:^|\s)--wait(?:\s|=|,|$)/m.test(help.stdout);
    addCheck('compose-wait', localDocker.compose_wait_supported, { message: 'Pinned Harbor requires Docker Compose up --wait support.' });
  } catch {
    for (const id of ['docker-cli', 'docker-daemon', 'docker-compose', 'compose-wait']) {
      if (!checks.some(check => check.id === id)) addCheck(id, false, { reason: 'local-config-unavailable' });
    }
  } finally {
    if (configDirectory) {
      try { rmSync(configDirectory, { recursive: true, force: true }); }
      catch { addCheck('temporary-config-cleanup', false, { reason: 'cleanup-failed' }); }
    }
  }
  localDocker.ready = localDocker.cli_available && localDocker.daemon_reachable && localDocker.daemon_os === 'linux'
    && localDocker.compose_available && localDocker.compose_wait_supported;

  return {
    schema_version: 1,
    readiness: classifyReadiness(checks),
    tooling_only: true,
    paid_execution: false,
    version_pins: { ...PINS },
    checks,
    local_docker: localDocker,
    scope: 'Prerequisite tooling only. Containers, images, inference, and benchmarks were not run.',
    windows_guidance: 'Use WSL2 Ubuntu with Docker Engine and Compose for Linux tasks. That Windows setup has not been validated by this check.',
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.slice(2).some(argument => argument !== '--json')) {
    process.stdout.write(`${JSON.stringify({ readiness: 'blocked', tooling_only: true, paid_execution: false, reason: 'unsupported-arguments' })}\n`);
    process.exitCode = 2;
  } else {
    const report = runPreflight();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.readiness === 'tooling-ready' ? 0 : 2;
  }
}
