# Apex Phase 1 implementation plan

> For agentic workers: use test-first implementation, native inline integration and disjoint parallel workers. User authorization in APEX_BUILD.md and the current phase instruction governs execution.

**Goal:** Deliver an optional, source-compatible token-efficiency package with local correctness evidence and an honest ablation ledger.

**Architecture:** The context extension coordinates small independent modules; the launcher selects flags before Pi parses its own arguments. Persist edits only at native boundaries; keep selected model/thinking fixed and paid policy closed.

**Tech stack:** Node ESM, Pi 0.99.2, existing Python stdlib evaluation tools, TypeBox from pinned dependencies.

**Spec:** PHASE1_DESIGN.md and APEX_BUILD.md §3.

## Global constraints

- No paid/model/provider/account calls. `paid_runs_enabled=false`, `execution_policy=offline-only`.
- Exact MAIN=FAST: `openrouter/meta/muse-spark-1.3-contributor`; thinking `xhigh`.
- No Pi core changes, default-on experiments, dataset/task detection, benchmark content/verifier access or cross-task memory.
- No new product dependency is required. Existing Pi and native tools own the algorithms where possible.
- Credential values must never enter files, subprocess arguments, logs or artifacts.
- Root owns shared package/launcher/check/micro/docs integration and commits; workers own only their listed modules and tests.

## Review focus

1. Truncated native output and shaped programmatic results must retain accurate source/unknown information.
2. Branch switches, repeated prompts and reload must not reuse masked/dedup state from a different branch.
3. Failed/ambiguous/multi-file edits must not partly modify files; sibling mutations must serialize through Pi.
4. Invalid/offline compaction must cancel before authentication and never fall back to default summary inference.
5. Feature selection must never consume Pi option values or change the default control configuration.

## Task 1 — root: policy, launcher and extension coordinator

Files: `extensions/apex-context/index.mjs`, `extensions/apex-context/config.mjs`, `extensions/apex-context/cache.mjs`, `lib/launcher.mjs`, `bin/apex`, `tests/context-config.test.mjs`, `tests/context-integration.test.mjs`, existing launcher tests.

Interfaces: `parseContextFlags(value)` returns a frozen Set-compatible list of known features; feature names are `cache`, `shape`, `mask`, `compact`, `read`, `search`, `edit`, `patch`, `lazy`, `route`, `output`. `apexContext(pi)` registers flags only at factory time and initializes tools/state at session_start. Optional prefix `--apex-context` accepts comma-separated names or `all`; unknown/duplicate-invalid options fail before starting Pi. No option means the existing invocation is unchanged.

- [x] Write/run failing selection, inert-default, tool-name, prompt-stability and provider-cap tests.
- [x] Implement coordinator and session lifecycle; output/caches remain distinct flags.
- [x] Integrate worker exports exactly as below and verify focused tests.

## Task 2 — shaping worker

Files: `extensions/apex-context/shaping.mjs`, `tests/context-shaping.test.mjs`.

Produces `shapeToolResult(event, {cwd,maxBytes=8192,maxLines=120})` async → replacement `{content,structuredContent,details}` or undefined. Native result input includes toolName/input/content/details/structuredContent/isError. Command-aware selection is conservative and always preserves head/tail, failure/diff context and summary where bounded. Collapse repeated lines, ANSI/progress cleanup, preserve native fullOutputPath. Atomic exclusive owned log spill; preserve images and custom structured output semantics (skip unknown structured schemas). Record original/returned bytes, log scope and native source path in details.apexShape.

- [x] Write/run RED tests for content/schema coherence, native spill scope, Unicode caps, ANSI/repetition, command errors, images, malicious call IDs and simultaneous spills.
- [x] Implement using Pi truncation helpers and mutation queue; run focused GREEN tests, freeze files and report.

## Task 3 — context worker

Files: `extensions/apex-context/masking.mjs`, `extensions/apex-context/compaction.mjs`, `tests/context-masking.test.mjs`, `tests/context-compaction.test.mjs`.

Produces `planMasking(event,ctx,{keepTurns=4,thresholdTokens=4000})` → boundary result or undefined, preserving `event.entries` and no forced continuation. Use projected active branch and persisted edits. Produces `createCompactionHandler({policy,complete})` → native hook function; policy contains allowed_model,thinking_level,paid_runs_enabled,execution_policy. Dependency `complete` is injected only for unit mechanics; coordinator defaults to actual ctx.modelRegistry.complete after policy guard. Branch state types `apex-contract`, `apex-todo`; state data serialized/copy retained without paraphrase. Prompt is actual prompts/compaction.md. Preserve previous hook file bookkeeping and report response.usage.

- [x] Write/run RED tests for age resets, branch projection, recent/latest-read/contract preservation, batching/composition, structured payload skip, cancellation/no auth, repeated bookkeeping, verbatim state and reported usage.
- [x] Implement with pinned public boundaries, verify native session projection and focused GREEN; freeze/report.

## Task 4 — tools worker

Files: `extensions/apex-context/tools.mjs`, `extensions/apex-context/patch.mjs`, `tests/context-tools.test.mjs`, `tests/context-patch.test.mjs`.

Produces `createEfficientTools({cwd,features})` → array of native compatible ToolDefinition objects. Read has bounded default range, explicit `mode: outline` (ctags if available, clearly labeled approximate fallback otherwise), unchanged-image behavior; reread pointer only for unchanged hash/same range and original observation still unmasked on active branch. Native search caps/grouping and accurate overflow facts. Edit schema uses `path`, `edits:[{old_string,new_string}]` and supports one replacement shorthand; delegates native multi-edit/whitespace matching and queue. Failures give bounded candidates without writing. Patch tool named `apply_patch` accepts unified exact-context patch, uses native mutation queue and rejects unsupported creates/deletes/multifile atomicity rather than silently applying partly; compact diff results. Exposures become codemode/deferred only with lazy enabled.

- [x] Write/run RED real-file/native tests for stale/masked/ranged reads, large/binary/images, CRLF/BOM, simultaneous edits, whitespace/ambiguity/overlap, strict patch validation/atomicity and caps.
- [x] Implement, focused GREEN tests, freeze/report; no shared edits or commits.

## Task 5 — router/lazy worker

Files: `extensions/apex-router/index.mjs`, `extensions/apex-context/lazy.mjs`, `tests/context-router.test.mjs`, `tests/context-lazy.test.mjs`.

Produces `createApexRouter({main,fast,thinkingLevel='xhigh'})` → native virtual model definition id `apex/auto`, persisted phase state, physical-model exact lookup. previous/failed continuation/retry stickiness; no changed physical model/level outside allowed policy. `registerLazyTools(pi)` registers native tool_search and codemode if exported, or exact local thin definitions using public seams if not; code execution must match native support, no arbitrary external capability claimed. No provider/network initialization.

- [x] Write/run RED stickiness/phase/invalid model/disabled thinking/cache fixtures and native exposure/loadout tests.
- [x] Implement exact native contracts, focused GREEN tests, freeze/report.

## Task 6 — root: validation, evaluation adapter, review and save

Files: `scripts/micro-phase1.mjs`, `evals/micro/run.py`, `evals/harbor/apex.py`, `evals/phase1-ablations.json`, `validation/phase1-local.json`, package/check/docs.

- [x] Write/run failing offline integration gate and adapter feature-options tests; implement with provider/auth/network guards and no model data fabrication.
- [x] Each substantial component gets check/tests/micro; root verifies shared integration after worker completion.
- [x] Run whole check/test/micro and source diff checks; obtain independent review and fix material defects.
- [x] Record local bytes/loadout/context reductions only as synthetic fixtures; dollars/pass-rate/CI unknown for each flag. No promotion default.
- [x] Commit exact measured effect; preserve source/history/evidence/raw prior traces in a new credential-scanned package and save it.

## Ledger

Initial base: `baf0b75262a9ff8c49aa01ee302e16467ece688a`. Branch `apex-phase1` created from clean local closure. Pre-flight interfaces: coordinator→shaping replacement; coordinator→mask boundary; coordinator→compaction guarded hook; coordinator→tool definitions; coordinator→router/lazy registration. All feature modules import independently and have no factory-time side effects. Api audit notes are appended to NOTES.md during integration.


## Completion ledger

Task 1: configuration/cache/launcher/coordinator focused RED→GREEN; per-request cache observation now detects tool deltas without editing messages. Task 2: 21 shaping regressions GREEN, including nested program input preservation and restrictive umask/source pointer cases. Task 3: 27 compaction/masking regressions GREEN, including native projection/reopen and conservative preservation of nested batches. Task 4: 24 native real-file tests GREEN, including full-file hash guard and strict hunk data. Task 5: 10 router/lazy tests GREEN; actual selected codemode was checked in SDK integration. Task 6: five native gate regressions and 16 success checks PASS; full npm test 151 Node + 121 Python = 272, zero skips; integrated npm run micro PASS, no inference/spend. Fresh independent review found no remaining material defect. Source/evidence/history commit and delivery hashes are in the final archive manifest.

Ruling: preserve all nested parent observations and skip shaping nested program results — keeps script inputs, hidden failures and latest reads intact — fewer observations may be eligible for byte reductions, to be measured later.
Ruling: maintain every flag off and leave benchmark acceptance false under free-only policy — no solve-rate/cost evidence exists — local implementation cannot prove the target.
Ruling: output prefix claims cover Apex components only; ctags fallback is approximate, patch scope is one existing file, and routed thinking remains xhigh — follow source/authorization rather than claiming unsupported capabilities — broader variants require separate eval evidence.
