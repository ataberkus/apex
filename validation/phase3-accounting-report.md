# Phase 3 accounting and session report validation

Status: focused worker validation passes. The root agent owns global checks, native integration gates and commits.

## Owned deliverables and interfaces

- `extensions/apex-features/accounting.mjs`: pure `summarizeSession(entries, {branch, activeLeaf, context, model, pricing})` and `formatCost(summary)`.
- `lib/session-report.mjs`: asynchronous `readSessionReport(file, {maxBytes})` and `inspectResume(file)` using built-in filesystem APIs only.
- `tests/features-accounting.test.mjs`: 19 focused cases.
- `tests/session-report.test.mjs`: 15 focused cases with real temporary JSONL/files/symlinks/FIFO replacements, removed after each case.

Summary fields are `scope`, `totals`, `knownTotals`, `cost`, `model`, `currentTaskId`, `context`, `categories`, `topConsumers`, `tasks`, `completeness`, and `counts`. Token components retain native `input`, `cacheRead`, `cacheWrite`, and `output` names. `thinking` aliases the reported `reasoning` subset; `cacheWrite1h` is a cache-write subset. Neither is added to `totalTokens`. Missing or partial full totals are null; known observed amounts remain in `knownTotals`.

Branch selectors accept a native leaf ID, a native branch entry/ID array, or null for an empty branch. Omitted branch selects all stored entries, including abandoned siblings. Per-task attribution follows parent ancestry, not the most recently stored sibling snapshot. Custom control snapshots and compaction-preserved control data are used for attribution. Snapshot payloads are never returned.

`activeLeaf` is a separate optional native entry ID or null. It affects only `currentTaskId`, preserving session-wide totals/scope after live `/tree` navigation. An unknown active ID is refused. Omitted `activeLeaf` retains physical-last-entry behavior; null explicitly yields no current task.

Prices are explicit per-million USD token catalog estimates. Accepted inputs are a matching identity plus rates, a native model cost object with the selected `{provider,id}` supplied, a model-keyed rate map, or a `models` registry array. Native cost observations remain separate in `nativeEstimateUsd` and `knownNativeEstimateUsd`; they are labeled estimates, not invoices. `pricingEstimateUsd` remains unknown when required rates/model attribution/usage are unknown. Partial estimates remain available as known subtotals. Native compaction/branch summary usage does not inherit a guessed model.

Reader output contains safe metadata and the summary, not raw session entries. Resume output contains exact validated native v3 header fields, physical last-entry `leafId`, native active `branchIds`, routed `model`, `thinkingLevel`, `tornTail`, `unterminatedTail`, `pendingTools`, `replaySafe:false`, and `replayPerformed:false`. It never replays or modifies session data.

## Observed red/green evidence

All runs used the same focused invocation, with no npm scripts, installs, provider SDK initialization, model calls, credentials, or network operations:

```sh
env -i PATH=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 CODEX_PRIMARY_RUNTIME_NODE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node PI_OFFLINE=1 npm_config_offline=true npm_config_registry=http://127.0.0.1:9 /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node --test tests/features-accounting.test.mjs tests/session-report.test.mjs
```

1. Before modules existed: exit 1, 18 tests, 0 pass / 18 fail. Assertions exposed missing exported functions rather than import exceptions.
2. Initial implementation: exit 0, 18 pass / 0 fail.
3. Native safe-ID/model metadata and partial subset/header-leak regressions were added first: exit 1, 20 pass / 3 fail. Corrections then produced 23 pass / 0 fail.
4. Numeric aggregate and malformed native shape/depth regressions were added first: exit 1, 25 pass / 2 fail. Corrections then produced 27 pass / 0 fail.
5. Missing dedicated helper evidence and native extra-message category regressions were added first: exit 1, 27 pass / 2 fail. Final corrected run: exit 0, 29 tests, 29 pass / 0 fail, no cancelled/skipped/todo cases.
6. Root requested footer tokens/cache/context/model/task/session details. Two behavioral cases were added first: exit 1, 29 pass / 2 fail. The extended formatter then passed all 31 cases, exit 0, no cancelled/skipped/todo cases.
7. Root review found that live tree navigation must select task state separately from all-session accounting. A new regression was added first: exit 1, 31 pass / 1 fail. `activeLeaf` support then passed all 32 cases, exit 0, no cancelled/skipped/todo cases.
8. Review found torn-tail invalidation had covered only base session totals. A regression with reported thinking/cache-write subsets and explicit task attribution was added first: exit 1, 32 pass / 1 fail. Torn parsing now invalidates all full session/task totals, subset completeness and full native/pricing estimates while preserving known observations. Final focused run: 33 pass / 0 fail, exit 0, no cancelled/skipped/todo cases.
9. Final read-only review identified a regular-file-to-FIFO stat/open race. A child-only preload replaced the real session path with an unwritten FIFO immediately before the actual filesystem open. The regression first failed with `ETIMEDOUT` after 2 seconds: 33 pass / 1 fail, exit 1. Opening with `O_NONBLOCK` then let existing descriptor regular-file validation refuse the FIFO before any read. Final focused run: 34 pass / 0 fail, exit 0, no cancelled/skipped/todo cases; the FIFO case completed in approximately 249 ms. The child uses only the public runtime path, the environment whitelist, offline npm settings and local `mkfifo`, with no FIFO writer.

## Verified behavior

- Hand-calculated all-session and branch totals, USD estimates, independent request identities and detached snapshots.
- Replay by exact native entry ID, helper request ID and assistant response ID counted once; conflicting identity payloads refused. Equal requests with distinct identities remain distinct.
- Native assistant, compaction, branch-summary, standalone usage and auxiliary tool usage counted once; details-only helper snapshots and unattempted offline tool denials are excluded.
- Missing or aborted helper evidence retains known amounts while invalidating full totals and full cost. An incurred extraction snapshot without its dedicated helper record reports missing accounting without billing snapshot usage again.
- Reported thinking and one-hour cache writes are subsets. Missing subsets remain unknown; partial requests cannot claim complete subset totals.
- Unknown context token counts/rates/model attribution never become invented percentages or free spend. Existing native cost observations remain clearly labeled estimates.
- Compact status includes uncached input, cache-read/write, output, cache-hit percentage (`cacheRead / (input + cacheRead + cacheWrite)`), context percentage, routed model, session estimate/unknown and explicit active task estimate/unknown. Current task follows the native active leaf's explicit task ancestry, excluding a more recent sibling's task. Unidentified task text is never invented. Very small positive costs display `<$0.0001`, preserving their nonzero meaning. The status labels estimates as not invoices.
- UTF-8 byte counts and explicit byte/4 proxies for user, assistant, thinking, tool-call arguments, tool results, summaries, system, injected custom and native bash-execution content. Top consumers contain only metadata/byte proxies; prompt text, tool arguments/results and control state are not echoed.
- Real native JSONL with siblings, pending/completed tool calls, safe custom IDs and assistant model changes. Active branch pending state excludes abandoned siblings.
- Valid unterminated JSON records distinguished from a torn final JSON fragment. Torn reports invalidate all full session and per-task totals, thinking/cache-write subsets, completeness flags and full native/pricing estimates; known totals and known estimates are retained. Files were compared byte-for-byte before/after inspection.
- Malformed interior JSON, invalid UTF-8, nonnative/future headers, unexpected header fields, conflicting IDs, missing/forward parents, cycles, malformed message/tool shapes and excessive nesting rejected with bounded messages.
- Oversized files and invalid byte limits rejected; file/parent symlinks and nonregular paths refused.
- A regular session path replaced by an unwritten FIFO after pre-open validation is refused promptly at real descriptor validation. The regression exercises the production open rather than substituting a mocked file handle.
- Last physical replay record determines native resume leaf while usage deduplicates independently.
- Unsafe aggregate token/cost arithmetic fails explicitly instead of returning rounded or infinite totals.

## Limits and source rulings

Default file bound is 8 MiB; caller-selected maximum is 32 MiB; individual JSONL lines are limited to 1 MiB; nesting is limited to 64 levels and parsed line nodes to 200,000. Pure aggregation supports at most 100,000 entries. The reader uses regular-file/inode/device checks, no-follow/nonblocking opening, growth/change checks, and symlink checks before and after reading. Its bounded result omits the raw parsed payload.

Current Pi 0.99.2 native session-manager source was read locally to confirm safe custom session-ID syntax, header v3 fields, parent-based branch traversal, last physical entry as reopened leaf, assistant model-setting fallback, and native loader tail repair. The native loader appends LF to unterminated files; calling it would violate read-only inspection. The implementation therefore parses independently without SDK initialization. Root's upcoming native `SessionManager` integration gate is responsible for actual reopen parity.

Only complete native v3 sessions are accepted; no migrations or repair writes occur. Malformed interior records fail closed, while a malformed unterminated final fragment is explicitly marked torn. This is more conservative than Pi's permissive malformed-line skipping. Byte proxies are estimates of stored content, not tokenizer output or exact input attribution. Registry/native cost fields are estimates, not provider invoices. Resume inspection supplies evidence and warnings only; durable replay and in-flight side-effect recovery remain unsupported.
