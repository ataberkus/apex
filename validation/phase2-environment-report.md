# Phase 2 environment and entry-point evidence

Implemented only `extensions/apex-core/environment.mjs` and its focused tests. No provider,
auth, credential, installation, benchmark-task, or verifier-definition operations were used.
No project script was executed. No real external reachability request was made.

## Verification

- Initial red run: `node --test tests/core-environment.test.mjs`, exit 1; all 10 initial
  tests failed with the expected missing environment API assertion.
- Further test-first failures covered manifest `../` targets, ignore character classes,
  malformed ignore patterns, split UTF-8 output, project-local PATH scripts, escaped
  entry paths, deeper identifier/symbol discovery, missing-rg fallback and source limits.
- Initial complete focused run: `node --test tests/core-environment.test.mjs`, exit 0; **19 tests
  passed, zero failures/cancellations/skips**, 3,466.543 ms.
- `node --check extensions/apex-core/environment.mjs`, exit 0.
- Root owns whole-project check/unit/micro verification and integration. This worker
  does not claim those gates have passed.

Tests use real temporary project files. Native child fixtures exercise flood output,
timeouts, split Unicode bytes, credential-free child environments, project-local PATH
exclusion and import-only behavior. Their child environments contain only PATH, locale,
timezone and an intentional secret canary for the inheritance test. The two-second
authorized reachability branch is tested with an injected command adapter, so it makes
no external request. Installed-rg availability is injected in source-ranking tests;
identifier and symbol scoring reads real bounded fixture files.

## Final reviewer coverage and frozen verification

Added explicit distro, shell and current-user observations, package-manager versions
and declarations, and static Makefile/pyproject build/test hints. Four new tests first
failed with the expected missing-field/hint assertions; a strengthened version-display
assertion also failed before implementation. Makefile recipes, including a `$(shell ...)`
sentinel, never executed; generic test/verifier manifests stayed unread.

Final verification used only this focused file under a sanitized environment:

```sh
env -i PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin LANG=C LC_ALL=C TZ=UTC CODEX_PRIMARY_RUNTIME_NODE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node --test tests/core-environment.test.mjs
```

Result: exit 0; **23/23 passed**, zero failures/cancellations/skips, **3,561.642 ms**.
This includes the existing regression proving all ten escaped entry paths fit before
local-tool observations within the default 2,400-byte budget. Entry paths remain
prioritized; paths/reasons may be abbreviated, and later observations can be cut by
the overall byte budget. No global npm command, install, provider, credential or live
external request was performed. The three owned files are frozen for root integration.

## Interfaces and bounds

- Exports `captureEnvironment({cwd,task,entrypoints,networkAllowed,maxBytes,runCommand})`
  and `rankEntryPoints({cwd,task,limit,runCommand})`. Import creates no process, timer,
  file or socket.
- `runCommand(command,args,options)` receives cwd, timeoutMs, maxOutputBytes,
  networkAllowed, a small sanitized env and an AbortSignal. Results accept `code` or
  `exitCode`, stdout/stderr, and optional timedOut/truncated/error fields.
- Model-visible snapshot is capped at 2,400 UTF-8 bytes, including the default top
  ten ranked entries; a smaller nonnegative integer budget is honored. Structured
  details retain exact paths. Display paths and reasons may be abbreviated.
- Snapshot listing stays depth two; dependency/cache/output trees, hidden files,
  symlinks and scoped `.gitignore` exclusions are omitted. Listing caps: 400 paths
  and 1,024 directory entries per directory. Manifests/configs read at most 32 KiB.
- Distro reads only fixed `/etc/os-release` or `/usr/lib/os-release` metadata, at most
  4 KiB, with an unavailable fallback. The files are parsed as data, never sourced.
  Current-user lookup uses guarded OS userInfo; shell is bounded environment/OS text
  and is never executed. User home paths are not retained or displayed.
- Package-manager probes are fixed `pip3 --version` and `uv --version`, one second/
  512 bytes each. npm/pnpm/yarn/bun declarations and known lockfile names provide
  static hints; corepack-backed shims and npm are not invoked. Make has only a fixed
  `--version` probe. Makefile targets, pyproject tool section names/build backend and
  build/test entry ranking are extracted statically from bounded manifests.
- Separate entry discovery reaches depth six, at most 600 paths and 750 ms checked
  at traversal boundaries. It applies the same ignore rules plus generic test,
  spec, fixture, eval, benchmark and verifier conventions.
- Content assistance examines at most 20 normal project source paths, first 64 KiB
  per file, with a separate 750 ms checked budget. Unknown source trees receive
  metadata ranking. Literal identifier and declared-symbol hits improve scores;
  source chunks and symbol text never enter snapshot text or details.
- Missing/timed-out rg explicitly selects metadata-only ranking. Details include
  `entryPointDiscovery` status, limits, sourceFiles and truncation. Filename/manifest
  ranking remains deterministic and available without rg.
- Local command probes have a one-second deadline and at most 2,048 aggregate
  stdout/stderr bytes. Git/service/disk observations use 1,024-byte caps. Native
  floods are killed; native hangs receive SIGKILL at deadline. The snapshot returns
  at deadline even if an injected adapter ignores its AbortSignal.
- Default network status is explicitly skipped. Only literal `networkAllowed: true`
  enables the fixed example.com HEAD probe: two seconds, 512 bytes, curl config
  disabled, with no provider or auth endpoint.
- Native probe environments discard arbitrary inherited variables, relative PATH
  components and PATH directories inside the project. Git interactive/global-system
  configuration, Go telemetry/toolchain downloads and Rust auto-install/update
  behavior are disabled by explicit environment settings.

## Limits and unmeasured effects

Entry scores are discovery heuristics, not semantic correctness claims. Bounded first
chunks can miss symbols beyond 64 KiB, files beyond the first 20 eligible paths, paths
beyond depth six or a capped scan, and unconventional source trees. Generic exclusions
do not identify particular benchmark datasets or task names.

The local ignore matcher supports scoped rules, negation, anchoring, directory patterns,
wildcards, recursive `**`, common character classes and escaped characters. It does
not consume global Git ignore configuration or implement every Git wildmatch edge
case such as POSIX character classes. At most 256 rules per bounded ignore file are
read. Malformed patterns cannot execute arbitrary regexes or trigger backtracking.

Filesystem budgets are checked at operation boundaries; they do not forcibly cancel
an individual OS filesystem operation. A custom command adapter is responsible for
stopping any resource it creates when its signal aborts. Runtime, disk, git and local
service observations are best effort and platform-dependent; unavailable tools are
labeled. No live external connectivity, model success-rate/cost delta, provider retry
behavior or benchmark acceptance claim is inferred from these local tests.
