# Phase 3 accounting/session/checkpoint review

Independent read-only spec and quality review of `extensions/apex-features/accounting.mjs`, `lib/session-report.mjs`, `extensions/apex-features/checkpoints.mjs`, their focused tests, the Task 1/2 briefs, and PHASE3_DESIGN.md. Native shapes were checked against the installed Pi 0.99.2 SessionManager declarations/source. Coordinator call sites were inspected to assess native tree navigation and checkpoint IDs; no coordinator or worker implementation/test was edited by this review. The implementation owner's separately authorized scanner FIFO fix remains outside this review scope.

## Final disposition

**No unresolved correctness finding remains in this scoped review after the fixes below.** Practical limits are recorded separately and should remain explicit for this opt-in feature.

**Resolved P2 — checkpoint readers detected growth after an unbounded allocation/read.** The reviewed `sourceFile()` and `privateFile()` originally called `handle.readFile()` after an initial descriptor size check. A growing regular file was fully read before the post-read check rejected the change, exceeding the advertised I/O/allocation cap and postponing cancellation. A temporary offline fixture exercised the real production reader with test-only dependency instrumentation: a six-byte source file passed the descriptor stat under `maxFileBytes: 32`, then 4,096 bytes were appended immediately after that stat. The actual read returned **4,102 bytes** before capture rejected with `code: "conflict"`.

The owner replaced both full-file reads with one buffer bounded by `min(initialSize + 1, configuredCap + 1)`, positional read chunks of at most 128 KiB, cancellation checks before/after each chunk, and the retained descriptor size/identity/time checks. Lifecycle signals now propagate through all metadata loads. Source and manifest growth regressions both pass. An independent rerun of the original six-byte/32-byte-cap fixture consumed only **7 bytes** and rejected the growth with conflict: `{"configuredFileCap":32,"initialFileBytes":6,"actualBytesRead":7,"refusal":"conflict"}`. Temporary fixtures were removed, and no implementation or persistent test was edited by this review.

## Findings addressed during review

1. **Native active task and checkpoint branch isolation.** Initial coordinator code summarized all entries without the active native leaf and regenerated numeric checkpoint IDs from branch-local counters. Native tree navigation could therefore display a sibling task or reuse a sibling's checkpoint ID; undo selected from all session records. Latest code passes `activeLeaf`, restores a session-wide counter ceiling from all entries/persisted records, and filters undo through branch-owned checkpoint IDs. The accounting regression for native navigation passed in the refreshed focused run. Coordinator integration regressions were read but are owned/verified by root.
2. **Torn-tail subsets and task totals.** Initial session-report handling invalidated base session totals/costs but left thinking/cache-write subsets, thinking completeness, and per-task full totals/costs intact. Latest code invalidates every full total, subset, task completeness and full estimate while preserving observed `knownTotals`. The new torn-tail regression passed.
3. **FIFO replacement before open.** Pre-open lstat checks originally permitted a regular-file-to-FIFO replacement to block the actual open. Latest checkpoint source/private readers and session reader use `O_NONBLOCK` with descriptor validation. Real FIFO replacement regressions passed; the analogous separately authorized skill scanner fix passed its own behavioral test.
4. **Shadow attributes could enable clean filters.** Original shadow validation rejected external indirection but accepted regular `info/attributes`, which could activate local Git filters despite disabled hooks/global config. Latest code rejects custom shadow attributes before snapshot Git commands. A temporary configured-filter fixture was refused with the metadata/custom-attributes error; the focused custom-attributes regression passed. The first ad hoc fixture attempt lacked the deliberately empty template's info directory, was corrected, and both temporary fixtures were removed. No inference or provider was used.

## Verification and positive evidence

The initial focused run passed **50/50**. Concurrent review fixes expanded that to **55/55**. After the bounded-reader fix, the final fresh complete focused run passed **57/57**: 19 accounting, 15 session-report, and 23 checkpoint tests; 0 failures, cancellations, skips or todos, exit 0.

```sh
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  CODEX_PRIMARY_RUNTIME_NODE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node \
  PI_OFFLINE=1 npm_config_offline=true npm_config_registry=http://127.0.0.1:9 \
  /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node --test \
  tests/features-accounting.test.mjs tests/session-report.test.mjs tests/features-checkpoints.test.mjs
```

Tests exercise all-session versus selected-branch totals, ancestor-based task attribution, identical replay versus distinct request identities, missing/partial/zero usage, native usage categories, thinking/cache-write subsets, unknown pricing/context, arithmetic limits and no prompt/tool payload echo. Native compaction and branch-summary entries carry optional usage without native provider/model fields; keeping their independent pricing attribution unknown is appropriate. Session parsing rejects malformed/interior/oversized/symlink/native-shape data, distinguishes torn versus unterminated tails, and reports unresolved tools from the native physical active branch without replaying them.

Real checkpoint fixtures verify dirty/staged/untracked source, create/delete/mode changes, unchanged user index, same-process sibling serialization, persisted reopening/session isolation, detached record lists, manual post-turn conflicts, ignored/private/symlink/hardlink exclusions, caps, cancellation/timeouts, binary/CRLF/newline names, shadow-indirection refusal, and rollback after durable marker failure. Rollback refuses concurrent edits and retains explicit recovery backups rather than overwriting them. The factory remains inert; only explicit methods initiate bounded local Git/I/O.

## Remaining practical limits

Checkpoint queues serialize managers in the same process, not separate processes opening the same session concurrently. Worktree-style `.git` pointer files are refused; local `.git` or the supported `version-control` directory is required. Source directory topology is not recorded: file-to-directory and directory-to-file replacement can be refused by regular-file/ancestor checks, and removing created files can leave empty directories. These are safe refusals/incomplete directory cleanup, not demonstrated source loss. Persistent captured records must be finished before undo; uncompleted crash captures are not silently assumed to contain a trustworthy after-state. The feature remains opt-in, and these fixtures establish mechanical behavior rather than solve-rate, billing, durability-across-power-loss, or model-routing results.

Reviewed source SHA-256 at the refreshed test snapshot:

| File | SHA-256 |
| --- | --- |
| accounting.mjs | a6a6a4e0104958b53111dea8ce9e434fe2bd5c0edf3fb5efba5d9ec3d2a7cfc1 |
| session-report.mjs | 195648218a07a21ff2e4f2f282ee3728c04bf3b05966338ddc1f79dbb5eee648 |
| checkpoints.mjs | 35ca8ae55706c5bb82f15bd40542d03ac6b300f93caf0a4c90f38e8b67a9d3f3 |

Global npm/check/micro, installation, remote operations, providers, account/credential access, and commits were not used. New paid spend: **$0**.
