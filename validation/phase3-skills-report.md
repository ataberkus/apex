# Phase 3 deferred skills validation

Task 4 implements ten project Pi skills, ten relative `scripts/probe.mjs` entry points, and one Node-only scanner under `skills/_shared/` with no SKILL.md. The package's default skill list remains empty; advertising the ten paths is owned by the feature coordinator and must require the explicit skills flag. No personal skill installation or global configuration was performed.

## Red / green evidence

The first focused run, before any assets/probes existed, failed **17/17 tests** (0 passed). Failures identified missing frontmatter/resources, missing routing anchors, and missing executable probes. After implementation the same 17 tests passed. Six more boundary tests were added; that run passed **22/23**, with the expected failure for the unreported Git HEAD byte limit. Publishing that existing bound as `limits.gitHeadBytes` fixed the regression. Independent review then identified a regular-file-to-FIFO race before open. A child-only preload replaced the fixture file immediately before the production reader's actual filesystem open; the new behavioral test failed with **ETIMEDOUT at 2 seconds**. Adding `O_NONBLOCK` to that real open makes the post-open type check reject the FIFO promptly. The final focused run passed **24/24 tests**, with 0 failures, cancellations, skips, or todos; exit status 0.

Command (no install, provider, authentication, or network operations):

```sh
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  CODEX_PRIMARY_RUNTIME_NODE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node \
  PI_OFFLINE=1 npm_config_offline=true npm_config_registry=http://127.0.0.1:9 \
  /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test tests/features-skills.test.mjs
```

The focused harness performs **56 actual CLI probe executions** per complete run: **50 valid probes** and **6 expected CLI/root refusals**. All ten domain entry points execute their own real fixture, all ten execute against a private/symlink fixture, all ten execute against an unexecuted project-script fixture, and all ten execute against an empty project. The remaining 16 executions cover invalid arguments/missing roots, root symlink refusal, scanner budgets, worktree pointers, oversized HEAD, hardlinks, malformed manifests, and the FIFO replacement race. Fixture bytes/modes are compared before and after domain probes and the project-script test. The FIFO race uses test-process dependency instrumentation and a test-only mkfifo invocation; production probes create no subprocess. Owned temporary fixtures are removed in `finally` blocks. Global checks/tests/micro are reserved for the root coordinator and were not run by this worker.

## Interface and domain evidence

Invocation is an already installed Node executable plus the absolute probe-script path and `--cwd PATH`. The path resolves against the invocation directory. Any missing, duplicate, or unknown argument is refused before scanning. A valid probe emits exactly one bounded JSON object with `schema: 1`, `domain`, `mode: "static-offline"`, `ok`, `limits`, `scan`, and `facts`; a refusal has `ok: false` and a fixed error code. Exit status is 0 for a valid probe and 1 for refusal. No raw source text, manifest values, branch names, remotes, credentials, absolute project paths, or environment contents are returned.

| Domain | Real fixture evidence asserted |
| --- | --- |
| debugging | Diagnostic and error-handling patterns |
| test-writing | Test file, node:test declaration/import, assertion patterns |
| profiling | Two timing patterns, benchmark file, actual probe Node version |
| build-systems | Makefile/package manifests, npm lock metadata, build declaration |
| python-packaging | build-system/project tables and requirements file |
| numerics | NumPy import, least-squares and seeded-generator patterns |
| http | node:http import, server and timeout patterns |
| databases | Migration/schema, transaction, query and placeholder patterns |
| git-surgery | Directory marker, symbolic HEAD category, index/ignore presence, three conflict markers |
| security-hardening | Known control library, crypto and dynamic-execution patterns |

## Bounds and exclusions

| Resource | Enforced limit |
| --- | ---: |
| Directory entries examined | 1,024 |
| Directories opened | 32 |
| Directory depth below project root | 4 |
| Public text files read | 128 |
| Each public text file | 65,536 bytes |
| Total public text | 524,288 bytes |
| Additional Git HEAD text | 1,024 bytes |
| JSON output including newline | 16,384 bytes |

Real fixtures exercise the file/depth/oversize limits, the byte budget (eight 60 KiB files read, 480 KiB total; subsequent files skipped), the directory budget (32 opened, 31 child source files read), and the entry budget (1,024 examined, at most 128 read). Normal harness invocations check the output byte bound and have a 5-second process deadline; the FIFO race invocation has a 2-second deadline. These deadlines belong to the harness, not the production probe.

Scanning uses a public source/manifest allowlist. Hidden/private names, known dependency/build output directories, symlinks, hardlinks, special files, unsupported types, and oversized files are skipped before contents are read. Directory enumeration is bounded with opendir rather than an unbounded readdir allocation. File opens use O_NOFOLLOW and O_NONBLOCK and check inode/device, regular-file type, link count, and canonical path. A FIFO replacement is refused after the actual open without reading bytes or hanging. Metadata-only lockfiles and environment markers are never imported or activated. Git config/remotes, objects, refs, logs, index contents, database files, credential files, and worktree-pointer targets are not read. Git HEAD contents are reduced to symbolic/detached/unknown. Production code imports only built-in filesystem/path APIs; it creates no subprocess, socket, database connection, or installation and imports no project module.

## Limits of the evidence

Frontmatter and references are mechanically checked for all ten assets. Ten description-anchor fixtures each select exactly one description; this is **10/10 chosen phrase separations**, not a model routing evaluation. Static regex counts may include comments or strings and do not establish root causes, runtime hotspots, test coverage, safe SQL, or validated vulnerabilities. Declared/imported libraries are not claimed to be installed. Node/V8 facts refer only to the executable running the profiling probe. Skipped/truncated scans must be treated as incomplete evidence. Filesystem checks reduce accidental symlink traversal but are not an OS sandbox or a guarantee against hostile concurrent ancestor-directory swaps. No model call, dollar-per-solve result, solve-rate improvement, or default promotion is claimed.
