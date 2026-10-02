# Phase 2 process management — local evidence

Scope: `extensions/apex-core/process.mjs` and `tests/core-process.test.mjs`. No provider, credential, external network, package-installation, or Pi core operation was used. Root owns the subsequent global checks and native integrated gate.

## Implementation

`createBackgroundTool({cwd,env?,platform?,spawn?})` returns the native `bg` definition without spawning, opening files, starting timers, or installing shutdown handlers. `start`, `poll`, `tail`, and explicit `kill` share opaque 128-bit IDs. Tool text matches `structuredContent.text`; extra structured fields and `details.apexBg` report the same action and state.

Unix start uses Node's detached session/process-group semantics. Agent stdout/stderr are ignored; a small persistent supervisor owns the command's output pipes and writes only the newest 65,536 bytes to its restrictive log FD. The configuration pipe is closed after startup. Both the supervisor and command receive only an explicit environment allowlist (`PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`), with bounded values. Provider secrets and runtime loader variables are excluded.

State lives in `.apex/bg/` (0700); the ownership key, signed metadata, controls, acknowledgments, and logs use 0600 even under a zero umask. IDs disallow traversal, suffixes, and uppercase alternatives. Files use no-follow opens, regular-file/owner/permission/link-count checks, and bounded reads. Directory inode/device identity is rechecked. Atomic signed metadata replacement permits the previous safely opened inode to have zero remaining links, while rejecting multiple hard links. Ownership initialization writes a complete private temporary before publishing it with an exclusive hard link; concurrent first starts read the winning complete key. A bounded retry covers only the brief second link before the publisher removes its temporary.

This execution namespace has neither `/proc` nor a usable `ps` table. Consequently kill does **not** signal a persisted numeric PID. HMAC-authenticated, per-run-token requests reserve separate complete exclusive control slots; the live supervisor scans all 64 slots in each bounded tick, acknowledges every valid nonce separately, and signals only its own known live process group. Concurrent TERM cannot overwrite an explicit KILL. Up to 2048 signed acknowledgment records are retained for at most three seconds while the supervisor lives; accepted clients remove their own nonce acknowledgment, and the supervisor frees consumed slots. A full 64-slot queue rejects clearly, with no PID-based fallback. Even a test that deliberately re-signs metadata with an unrelated child's PID cannot redirect a signal to that child. TERM and INT handlers keep the supervisor alive if its command resists the requested signal, allowing a later explicit KILL. There is no automatic escalation and no exit/shutdown cleanup of required services.

`applyBashTimeout(event,{defaultSeconds=60,maxSeconds?})` mutates the native bash input, including nested hook calls. It preserves valid explicit positive finite timeouts, blocks invalid/over-maximum values, and bounds an absent default to `maxSeconds` when supplied.

## Test-first results

Initial command: `node --test tests/core-process.test.mjs` — seven failures, each the deliberate assertion that the process-management implementation did not yet exist. The implementation was added only after that red run. Subsequent red checks exposed an over-restrictive timeout default, an atomic-metadata unlink race, early supervisor exit being reported as startup pending, and a TERM-resistant command losing its live owner. Each was corrected with an exercised regression case.

Concurrency review added two further observed red regressions: a paused real supervisor lost its KILL request when another fresh manager published TERM (KILL rejected after acknowledgment timeout), and a separate real host delayed its actual new-key write while a concurrent first start rejected the visible incomplete key. Neither new test reads or emits the ownership key. These failures were corrected by exclusive per-request slots/nonce acknowledgments and complete atomic ownership publication, rather than process-local serialization or stale locks.

Final focused command: `node --test tests/core-process.test.mjs` — **12 passed, 0 failed, 0 canceled, 0 skipped; exit 0** (9246.304029 ms in the recorded run). `node --check extensions/apex-core/process.mjs` also exited 0.

The tests exercise:

- Factory laziness and mutable/nested bash timeout defaults, fractional explicit timeouts, and maximum enforcement.
- A real detached service after its separate tool host exits naturally, a fresh factory loading persistent ownership, explicit group KILL, stopped heartbeat, and safe repeated kill.
- Real noisy stdout/stderr, capped disk logs and tail output, coherent native result text, and restrictive permissions under umask 000.
- Unsigned forged metadata, a stale signed heartbeat, even deliberately re-signed unrelated PID metadata, traversal, metadata/log symlinks, and both state-directory symlinks.
- Windows denial, malformed action/command/ID/caps, pre-call abort, an actual missing executable, and an actual early supervisor exit.
- Real delayed readiness timeout and in-flight abort: both return the opaque owned ID, retain the service, and permit later explicit management.
- A real TERM-resistant command retaining its supervisor and accepting a later explicit KILL.
- Concurrent KILL and TERM from fresh managers while the actual supervisor is paused, both calls fulfilling without false acknowledgment timeout, followed by confirmed stopped service heartbeat.
- Concurrent real first starts while one actual ownership-file write is delayed, both obtaining different owned IDs managed by a fresh factory.

## Concrete survival record

The final survival test emitted this sanitized diagnostic after the host had exited and the service had been explicitly stopped:

```json
{"proof":"heartbeat grows after successful tool-host exit","hostExitCode":0,"hostPid":18,"supervisorPid":29,"servicePid":37,"id":"f4e7df52e9434c0d44f4d70301d0a21f","bytesBeforeHostExitObservation":1,"bytesAfterOwnedKill":4,"observedAfterHostExit":true,"environmentSanitized":true,"ownedKillSignal":"SIGKILL","repeatedKillSafe":true,"externalNetworkCalls":0}
```

Heartbeat growth was first observed after the synchronous host process had returned exit 0. Following owned KILL, two observations 100 ms apart had identical byte counts. Final test cleanup uses only authenticated `bg` requests, direct `ChildProcess` handles captured when the fixture itself spawned an unrelated control child, and the fixture command's own stop-file fallback. The concurrent-KILL red fixture self-terminated through its stop file before fixture removal; the concurrent-first-start red fixture's successful owned process was killed through its returned ID. It never sends a bare signal to an unchecked persisted PID.

The first red TERM-resistance fixture lacked the later stop-file fallback and its directory was removed after failure; its original ID/path were not emitted, so its owner key cannot be recovered. A separate bounded cross-execution probe established the execution boundary's descendant cleanup: a real detached heartbeat child with a 10-second self-watchdog was started in one execution, then an immediate new execution observed bytes **1 → 1** across 300 ms, **904 ms** after launch, with `watchdogFired:false`. Each execution's host had PID 2/parent 1, confirming a fresh PID namespace. Thus the red descendant does not persist across that completed execution boundary. The probe used its own stop file and removed its own fixture; no persisted PID was signaled.

## Limits

`poll` reports authenticated supervisor heartbeat freshness, not application health. A missing heartbeat becomes `stale`; no PID-based cleanup is attempted. KILL acknowledgment is written immediately before the supervisor signals its own group; `terminating` becomes `exited` after a short bounded settling interval. Service stoppage in the survival test is independently established by the stopped heartbeat, rather than relying solely on that status.

Commands must remain foreground members of the owned process group. Daemonization, changing sessions/groups, and grandchildren that detach and independently redirect their output are outside this manager's ownership contract. Native Windows management fails explicitly. Unix behavior was exercised in the available Linux execution environment; other Unix platforms remain unmeasured.

Private state directories and identity/no-follow checks reject ordinary symlink replacement. Available portable Node filesystem APIs cannot eliminate an active same-user directory-renaming race between every check and syscall; a same-user actor can also read the internal ownership key. The mailbox design still prevents metadata PID manipulation from causing collateral process signals. The key is an internal ownership capability, not a provider/account credential.

Supervisor heartbeat/control timers are allocated only by an explicit start. A readiness timeout or cancellation after actual spawn returns the owned ID and leaves the service alive; only an explicit kill requests termination. Logs and metadata remain as bounded local records after exit. No inference-success, benchmark, or cost improvement is claimed from these local tests.
