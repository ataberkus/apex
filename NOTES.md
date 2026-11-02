# Apex source notes

Audited 2026-10-01. Phase 0 research and offline measuring tools are prepared; real baselines have not run.

## Exact sources and runtime pins

| Component | Pin |
|---|---|
| Pi npm package | @earendil-works/pi-coding-agent 1.4.0 (was 1.3.0 before 2026-10-29, and 0.99.2 for the phase records below); bun.lock pins it and every transitive dependency by integrity |
| Audited Pi source | v1.4.0 tag 4a080252f06caf63a525d7873c5d94d3c23887e0 (previous audit: v1.3.0 tag 71023aec1546d6d677a65669c5665c0927ce0dd0; the first audit used unreleased 8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d, 17 commits after the v0.99.2 tag 005af57d) |
| Harbor runtime | git source 99218a4611e3bd76e49ce3b5f977e8c8134ad3ac; version label 0.23.0 |
| Reference adapter, research only | badlogic/pi-terminal-bench 0074c915dc7d8ceeba5f61b19e7b9aa078564fa3 |
| Validated environment | Linux x86_64; Node 24.19.0; Python 3.12.14 |
| User target | Windows local; exact container host remains unset |

Pi requires Node >=22.19.0; Harbor requires Python >=3.12. Upstream code was inspected read-only. No Pi core patch or upstream PR was needed.

### Pi 1.4.0 upgrade (from 1.3.0)

[The Pi API appendix](research/pi-api-notes.md) is re-audited for 1.4.0 and lists every change. `extensions/types.ts`, `runner.ts`, `system-prompt.ts`, `session-manager.ts`, `settings-manager.ts`, `resource-loader.ts` and `package-manager.ts` are byte-identical, and the internals Apex mirrors still hold: `ModelRuntime` has no `#private` fields and an unchanged `refresh`, `Settings.retry` keeps its shape, compaction and branch-summary usage entries still carry no model, `packageManager.resolve` still runs before the `no*` flags, `_prepareRun`/`_baseSystemPromptOptions`/`declareToolChanges` are unchanged, and the package entry point `resolvePi()` resolves did not move. Changes Apex adapts to:

- Resume and `/tree` now replay every tool-loadout system message on the branch (`getBranch()`), including those before a compaction, instead of the compaction-aware projection. The plan manager and the tree-navigation reset fold the same branch messages (`recordedToolNames(branchMessages(ctx))`), so a compaction without a loadout snapshot no longer makes Apex think Pi left the read-only loadout in place. The phase 3 micro harness checks its resume precondition on the branch as well.
- Pi now also activates extension tools the branch never added or removed (unless `defaultActive:false`) on resume and `/tree`. Apex's `session_start` already activates the context, lazy and browser tools it registers (`extensions/apex-context/index.mjs`), so this matches Apex's own behaviour.
- Eval-visible behaviour shifts that invalidate 1.3.0 baselines rather than break Apex: native compaction, split-turn and branch summaries request the model's output limit instead of `0.8 × reserveTokens` (history), `0.5 × reserveTokens` (split-turn prefix) or 4096 tokens (branch), so stock-Pi summary cost and length change (Apex's own `compact` hook still caps `maxTokens` at `reserveTokens`, which 1.4.0 still passes in `preparation.settings`); `/compact <instructions>` also steers split-turn summaries; `grep` runs `rg --no-config`; provider retries no longer fire on status-code digits inside request ids and do fire on more gateway/stream-disconnect errors; recovery from a cut-off response omits its tool results; attribution headers move into pi-ai's client identity (`before_provider_headers` no longer sees OpenRouter/OpenCode/NVIDIA attribution); Windows shell detection finds PowerShell and the WSL launcher outside `PATH` and accepts Store aliases.
- Apex's runtime `dependencies` contain no host-provided package (`@earendil-works/pi-*`, `@mariozechner/pi-*`, `typebox`, `@sinclair/typebox`), so 1.4.0's host-package warning does not fire for Apex; host Pi stays a `"*"` peer.
- Pi still ships no npm-shrinkwrap; Harbor's stock install and the Apex adapter now install exact Pi 1.4.0, still not lock-pinned beyond Pi itself.
- The upgrade's `bun run check` exposed an older drift: `autocompact` was in the JS feature list and `evals/phase3-ablations.json` but missing from `evals/feature_flags.py`. Python now lists all ten flags.

### Pi 1.3.0 upgrade (from 0.99.2)

Phase sections below record the 0.99.2 contracts their evidence was gathered against. Changes Apex adapted to for 1.3.0:

- `before_agent_start` is a union on `messageType`. `"custom"` runs (an idle `pi.sendMessage(..., {triggerTurn:true})`) carry `message` and no `prompt`; apex-core still applies its mode section but starts no task boundary for them.
- Tool loadouts are transcript state: Pi's agent loop records the active-tool delta as a system message before each model request, and resume and `/tree` restore the branch's declared tools. `/plan` save/cancel restores prior tools after the planning requests were declared, so a session resumed before its next request would come back read-only; the plan manager undoes exactly that stale loadout (`recordedToolNames`, `createPlanManager`), and tree navigation only resets the old plan's loadout when the target branch declares none.
- `emitBeforeAgentStart(trigger, options)` and `_prepareRun` (live loadout wins unless a handler edits `selectedTools`) changed; the offline micro harnesses mirror the new sequence and record tool declarations like the agent loop.
- `ToolLoadout.getPromptGuidelines`, `systemPromptOptions.hiddenTools`, `agent_settled.aborted`, `tool_execution_end.durationMs` and `ToolInfo.reachesTools` are additive.
- Eval-visible behaviour shifts that invalidate 0.99.2 baselines rather than break Apex: compaction serialization and cross-model switches drop thinking, codemode's prompt is shorter, the TUI defaults to fullscreen.
- Pi no longer ships npm-shrinkwrap.json; only this repository's lockfile pins its third-party dependencies. Harbor's in-container `npm install -g` of stock Pi is not lock-pinned, and neither is the Apex adapter's install (Bun 1.4.3 from the official installer pinned to `bun-v1.4.3`, then `bun add --global --exact --ignore-scripts` of the exact Pi 1.3.0 peer and the Apex tarball).

Full exact event/result declarations, 41 pi.on signatures, requested document/source/example reviews, prompt contracts, and source lines are in [the Pi API appendix](research/pi-api-notes.md). These include re-exported cache-warming declarations and upstream MIT attribution. [Harbor notes](research/harbor-notes.md) preserve exact installed-agent contracts, CLI/dataset evidence and source/release differences. [Pricing notes](research/pricing-notes.md) cite official rates and exact API IDs.

## Built-in tool contracts

| Tool | Arguments |
|---|---|
| read | path; optional offset and limit |
| write | path, content |
| edit | path, edits: array of {oldText, newText} |
| bash | command; optional timeout in seconds |
| grep | pattern; optional path, glob, ignoreCase, literal, context, limit |
| find | pattern; optional path, limit |
| ls | optional path, limit |

Current edit already supports multiple disjoint edits, fuzzy matching, mutation queues and compact diffs. Each oldText matches the original file; overlapping edits fail. New old_string/new_string or patch tools would be separate ablated experiments, not assumed missing upstream behavior.

Default textual truncation is 2,000 lines or 50 KiB, whichever is first. read preserves the head, bash the tail. Bash already spills full output to a temporary log and reports its path; structured bash output is bounded separately at 1 MiB. Search/list limits differ (grep 100 matches, find 1,000 entries, ls 500 entries) and do not automatically spill all excess results. grep lines cap at 500 characters. read directs further ranged reads rather than spilling the source file.

Bash calls spawn fresh shells: cwd changes, exports and environment activation do not persist. No implicit per-command timeout is imposed. POSIX shells run in detached process groups; background descendants can survive a successful shell exit, while cancellation/timeouts kill the tracked group. Inherited stdout/stderr can keep a tool waiting. Detached services need redirected streams, and survival after a real agent exits is still a pending micro-eval.

grep uses ripgrep, find uses fd/fdfind, and ls uses filesystem APIs. The brief's shared ripgrep description therefore does not match these implementations. Native Windows Pi defaults to Git Bash; WSL uses the Linux path. PowerShell is an available optional built-in tool.

## Extension/prompt decisions

Use named before_agent_start sections and promptGuidelines for later Apex prompts, preserving Pi tool guidance, skills and project context. Do not replace the complete system prompt or use a custom SYSTEM.md during the Phase 0 control runs. All supplied prompts are copied under prompts/ but excluded from the Pi manifest and launcher.

Verified seams include agent_before_settle/agent_settled, structuredContent/outputSchema, withFileMutationQueue, registerVirtualModel, codemode/deferred exposure and tool_search. The mutation queue is process-local. tool_result content replacement without structuredContent drops the old structured value; keep both shapes coherent. compaction.modelOverrides keys are exact provider/model strings, not globs and not summary-model selection. cacheWarming defaults to streaming and can emit additive standalone usage entries.

The audit distinguishes extension events from public JSON/RPC wire events. message_end is authoritative; streamed snapshots are not additional billable calls. agent_settled is the final public boundary. Cache-warm, summary and nested tool usage must be included when reported. Reasoning is a subset of output and must not be billed twice. Missing provider reasoning breakdown remains unknown.

## Harbor differences and dataset metadata

The published PyPI Harbor 0.23.0 wheel and current source commit share a version label but differ. The source-pinned runtime has the Pi ATIF converter required here; the wheel does not. The old external adapter imports ExecInput and uses a removed install/run interface. Apex subclasses the pinned current Pi adapter instead.

The old /tests upload patch is already present in current Docker upload_dir (copies source/. with fallback). No upload patch was applied. The inherited Harbor ATIF converter omits some native Pi usage/context entries; retain raw JSONL and use Apex accounting rather than ATIF alone for spend. MCP is disabled in this Phase 0 adapter because Harbor's current MCP bridge expects Pi 0.84.1–0.85.x, conflicting with the fixed 0.99.2 runtime.

CLI captures are in validation/harbor-run-help.txt, harbor-datasets.txt and harbor-datasets-legacy.txt. The default dataset command now links the Hub; --legacy returns the metadata table. Verified legacy names include terminal-bench@2.0, swebench-verified@1.0, swebench_multilingual@1.0, swebenchpro@1.0 and swesmith@1.0. Terminal-Bench 2.1 exists in the Hub as terminal-bench/terminal-bench-2-1; the legacy table does not establish terminal-bench@2.1. Resolve immutable dataset revisions before live runs.

Native Windows/Docker execution was not tested. The latest free-only setup guide proposes WSL2 with Docker Engine and Compose directly inside Ubuntu, inferred from Microsoft's WSL2 and Docker's Ubuntu instructions. No paid sandbox subscription or Docker Desktop is required for that route; the combined host setup remains unverified.

The unpaid continuation freezes only the terminal-bench@2.0 row from the pinned Harbor registry.json. All 89 task definitions point to Git commit 69671fbaac6d67a7ef0dfec016cc38a64ef7a77c. The local snapshot and its metadata manifest record hashes and an 18/20 prospective dev/held-out split. Benchmark task contents were not fetched, and container image digests are unresolved. Other datasets, including 2.1, require separate snapshots.

Harbor's cli/jobs.py accepts --registry-path and repeatable --include-task-name filters. The registry factory routes local JSON through JsonRegistryClient, and GitTaskId preserves the supplied task revision. Apex plans use these source-verified interfaces and record selected task and total trial counts; they perform no execution.

## Measuring limits

Reports use equal-task mean pass fractions and a task-cluster percentile bootstrap, keeping repeated attempts together. Primary token dollars per solved task divide all trial spend by successful trials. Best-of-N unique-task success is a separate descriptive statistic, not the ordinary repetition protocol.

Price entries are dated official standard-rate examples; the selected OpenRouter Muse row records current official provenance. Machine scope limits enforce context-price bands; out-of-scope requests remain unpriced. Nonzero 1-hour cache writes require a distinct rate. Token dollars exclude explicit cache storage, tools, containers, premiums, taxes and negotiated discounts. Full billed totals are unknown without billing data.

Exact system/tool/conversation token attribution, physical peak context and error root causes are not recoverable from arbitrary raw JSONL alone. The analyzer labels unavailable data and lower-bound proxies instead of reporting invented precision. Failure suggestions are provisional; a human-confirmed label needs evidence and a dev trace. No held-out traces were inspected.

Pi docs/json.md specifies LF-framed JSONL. Python str.splitlines() also splits literal Unicode U+2028/U+2029/U+0085 inside valid JSON strings, so both Apex readers now split only on LF; CRLF remains accepted. Normalization preserves run and available Harbor trial identity. Reports reject duplicate run/task/attempt, trial UUID or result hashes. The trace/result association remains caller-supplied and is not proven by matching task names.

## Local environment findings

The initial Harbor metadata call required socksio==1.0.0 for this workspace's proxy transport. No proxy values or credential values were saved. Pi's automatic fd extraction failed because archive ownership changes are unsupported here. A pinned official fd 10.3.0 binary was installed only in workspace tooling; provenance is in validation/fd-dependency.json. Pi core remains unchanged.

## Selected provider and thinking configuration

The user authorized a $1 total testing cap, restricted both MAIN and FAST to openrouter/meta/muse-spark-1.3-contributor, and selected xhigh. Pi 0.99.2 already contains this physical model; no custom model definition is needed. The model's thinkingLevelMap maps xhigh to xhigh and off to null, so off would clamp to minimal. ModelRuntime.getPhysicalModel(provider, id) resolves the exact catalog model; explicitly passing that object to createAgentSession avoids fuzzy/default model selection. OPENROUTER_API_KEY is the credential environment name. ModelRuntime.setRuntimeApiKey(provider, key) stores a runtime map override without credential-file persistence; removeRuntimeApiKey clears it.

Native OpenRouter requests contain reasoning: {effort: "xhigh"}. SDK createAgentSession accepts thinkingLevel: "xhigh", Pi CLI uses --thinking xhigh, and the pinned Harbor PiOptions exposes thinking (alias reasoning_effort), compiled by Cli("--thinking"). Harbor plans use --agent-kwarg thinking=xhigh equally for stock Pi and Apex. Passing both alias spellings is rejected, so no additional --effort is emitted. The Apex installed-agent wrapper preserves the inherited flag. Automatic compaction inherits session thinking, but is disabled in the bounded smoke to prevent auxiliary requests.

Official selected-model metadata is saved in research/openrouter-model-public.json. Its canonical response slug is meta/muse-spark-1.3-contributor-20260902. Published prompt/output/cache-read rates are $0.10/$0.20/$0.002 per million tokens; no cache-write price is published, so the billing registry records null. Pi's catalog cacheWrite: 0 is a metadata default rather than independently verified billing. The authoritative reconciliation endpoint is GET https://openrouter.ai/api/v1/generation?id=GENERATION_ID; total_cost and native_tokens_* are allowlisted in saved receipts. Model/response identity is checked against the requested and officially published canonical slug.

## Free-only continuation contracts

The latest user instruction disables additional paid execution. Historical selected model/thinking/budget/receipts remain recorded; configuration has paid_runs_enabled=false and execution_policy=offline-only. Python validate_budget vetoes offline-only independently of the enable flag. Live provider smoke calls assertPaidRunAuthorized(config, ledger, {runId, maxSpendUsd}) before key lookup, SDK initialization or run-directory creation; it validates the exact model/xhigh policy, reconciled active totals and a unique current reservation. Dry-run stays inference-free.

scripts/preflight.mjs exports runPreflight({projectRoot=process.cwd()}) and classifyReadiness(checks). Import is inert. CLI --json returns tooling-ready/exit 0 or blocked/exit 2; neither status authorizes inference or proves container/image capacity. The exact Harbor direct_url VCS commit is required. Python metadata uses -I -B, subprocess probes use shell:false, a 5-second timeout, a 32-KiB output cap and an environment whitelist. Docker --config points to an empty workspace temporary directory and --host explicitly selects the local Unix socket or Windows named pipe; only version/info/Compose version/up --help are queried. Inherited provider/proxy/Docker settings are not forwarded.

scripts/micro-process.mjs exports runProcessMicro(), inert on import. It checks pinned native createBashTool in a child host on Linux only: setsid/nohup plus redirected stdin/stdout/stderr, localhost port 0, random authenticated endpoint, post-host-exit health and self-SIGTERM cleanup with a bounded watchdog. It does not initialize AgentSession or contact a provider. Its proof is native tool-host mechanics, not full model/agent exit survival. Unsupported OS/helpers/package versions are explicitly SKIP; failures remain FAIL. CI integrates this alongside the existing eight tool contracts without activating any Apex feature.

This managed workspace exposed generated fixture remnants in later tool calls despite in-process removal checks. Saved loopback endpoints refused connections; generated-only remnants were removed and absence confirmed in a fresh call. No general cross-process filesystem or native Windows cleanup claim follows from this workspace check.

## Offline session and local runtime audit

Native AgentSession.compact(customInstructions?) emits session_before_compact before obtaining default-summary auth. A hook may return {cancel:true} or {compaction:{summary,firstKeptEntryId,tokensBefore,details}}; a custom result bypasses default summary inference. Extension hook exceptions can be caught by the runner and fall through, so an offline check must return cancellation on invalid fixture state and separately deny/count summary, agent and network transport attempts. Deterministic custom summaries test native compaction mechanics only.

SessionManager.create(cwd, explicitSessionDir), appendMessage(message), appendCustomEntry(customType,data), appendCompaction(summary,firstKeptEntryId,tokensBefore,details,fromHook,usage), getBranch() and buildSessionContext() are the native persistence seams. A user message already triggers disk persistence in 0.99.2. SessionManager.open(path, explicitSessionDir, cwdOverride) skips malformed JSONL fragments and appends a separating newline after an unterminated tail; it retains the corrupt bytes rather than reconstructing them. Branch-only movement remains in-memory until an append. Plain custom state is outside model context and must be restored by its owner from the active branch. No fsync, tool replay, provider-queue recovery or background-process restart guarantee was found; fresh-process reopening must not be called power-loss durability.

The current local runtime audit finds no Docker/Podman/nerdctl/engine/Compose executable or standard visible engine socket. /proc, /sys and /run are not exposed, so container namespace/cgroup support cannot be established. UID 0 and a Linux kernel label alone do not prove container privilege. Source-pinned Harbor's Docker preflight requires docker info, and its runtime uses docker compose. No genuine local container trial can run here as configured; no engine or system installation was attempted.

DefaultResourceLoader.reload() calls DefaultPackageManager.resolve() before applying its noExtensions/noSkills/noContextFiles filters. The package manager can discover home/ancestor resources even with a fixture agentDir. The offline session gate disables project trust, substitutes empty resource resolution on that test loader instance, and installs read/probe guards before SDK import. This is a pinned internal test boundary, not an Apex runtime extension or Pi core patch. Native inline hook loading and compaction still execute. The earlier paid smoke's discovery_disabled field describes model-visible resource suppression; it is not proof that every ambient filesystem discovery probe was prevented. Those historical traces remain unchanged.

The offline gate additionally reopens a saved SessionManager in another process and constructs a guarded createAgentSession with the same explicit physical Muse/xhigh selection; both session.messages and agent.state.messages must equal the saved compaction-aware context. This checks restoration under fixed supplied options, not automatic authenticated model selection, semantic summarization or continuing an interrupted provider request. Cancellation, missing contract, missing deterministic hook and ambient discovery all produce FAIL rather than invoking inference.

The synthetic evaluation pipeline exercises the public ingestion, normalization, reporting and failure CLIs. normalize emits one object per attempt; report requires an explicitly assembled array (or runs array object). The fixture's positive cache-write usage with an unknown price must keep full cost unknown; one task cluster keeps CI unknown. Caller-supplied trace/result binding remains unverified. Duplicate trial IDs are rejected, and held-out failure analysis refuses before opening even a missing trace. These are regression proofs, not empirical benchmark observations.


## Phase 1 source contracts and deviations

Pi 0.99.2 public hooks are tool_result → ToolResultEventResult, turn_end → BoundaryResult, session_before_compact → SessionBeforeCompactResult, before_agent_start → mutable systemPromptOptions.sections, and before_provider_request → replacement payload. Source: core/extensions/types.ts and runner.ts. Boundary entries replace earlier arrays, so Apex composes event.entries and never returns a masking continuation. event.turnIndex resets on agent_start; masking ages projected active assistant turns instead. Native context_edit replacements preserve tool identity/status; raw entries stay in the session, projection and reopen retain replacements. Ordinary final tool messages do not persist structuredContent (pi-ai types / agent-loop createToolResultMessage); hooks still need coherent structured results for codemode callers. Unknown custom persisted structured fields stay unmasked.

Previous fromHook compaction file lists are excluded from native extraction, so Apex explicitly unions earlier details.readFiles/modifiedFiles. Contracts/todos use active-branch apex-contract/apex-todo JSON, copied after the summary and retained in details.apexState. Offline/errors return cancellation because thrown hooks can be caught and otherwise fall through to default summary inference. Model completion options for Muse's openai-completions API use reasoningEffort:xhigh; usage is returned with compaction. Live summary spending/reservation reconciliation remains disabled and unvalidated.

registerVirtualModel accepts a native definition provider:apex,id:auto with route(request,ctx) → {model,thinkingLevel,state?}. previous is the latest successful physical response; failed is the retry's physical failed pair; direct calls have no branch state. Changed router state is persisted before dispatch. Catalog lookup/canonicalization requires a physical model. Apex exposes only Muse/xhigh, computes phases from successful active-branch assistants or apex-routing custom state, and supplies no lower-thinking policy under the user's fixed selection.

Native createCodemodeExtension({models:false}) and createToolSearchExtension() are public exports. Default codemode models:true exposes classifier model calls, so actual selected loadout must be tested. Native tool registration precedence follows extension order; the context extension is explicitly loaded before builtins. Lazy exposure is a visibility mechanism, not a permission/connection gate. Enabled MCP servers can connect on session_start even while deferred, and namespace summaries still cost context; Apex registers none.

OpenAI-completions adapters can fold system/tool deltas into their first provider prefix when mid-conversation support is absent. Pi's cwd/project sections also vary across tasks. Apex can keep its own section/loadout stable and record cache counters; no identical across-task wire prefix or actual provider cache improvement is established offline. Muse reasoning/cache interactions require authorized measurements. before_provider_request lacks the physical-model callback argument; Apex output shaping therefore validates exact Muse payload identity/effort, lowers only one existing known cap and preserves all other fields. It is not an offline-denial hook.

Native read already supports images/offset/limit; Apex adds an 80-line default, existing-ctags outline or clearly approximate language hints, whole-file/range hash checks against original visible active observations. Native edit already implements multiple disjoint edits and whitespace matching; the wrapper supplies conventional old_string/new_string names and bounded failure candidates. Native find uses fd/fdfind, not ripgrep, and can try downloading absent engines; Apex preflights local helpers and refuses installation. withFileMutationQueue is public, process-local and non-reentrant; do not lock then call native edit on the same path. The patch variant deliberately supports one existing-file unified transaction only; multi-file changes would require an independent transaction design and ablation.

## Phase 2 source-backed integration

Pinned Pi 0.99.2 remains unchanged. `before_agent_start(event,ctx)` receives the raw user prompt and structured `event.systemPromptOptions.sections`; static mode guidance adds a named section while native context-file/skill/tool sections remain. Initial snapshot and volatile notes are custom messages. `pi.appendEntry(customType,data)` is non-model branch state; contract/todo/control entries are restored through Phase 1 compaction verbatim.

`agent_before_settle` composes `{entries,continue}` drafts. A final-assistant preview initially has `context.canContinue=false`; `_runBeforeSettleBoundary` rechecks after committing the gate's own custom message. Requiring the initial boolean would disable ordinary verification gates. Abort/error/pending conditions are rejected; maximum two gate continuations and one missing-todo steer per user run.

Native tool definitions use `prepareArguments` before schema validation. `tool_call` input mutations are not revalidated, so correction normalizes aliases before validation and explicitly checks hook mutations/path/preconditions. Sibling and nested events have IDs/parent IDs; mutation start and completion both invalidate stale verification. `ctx.executeTool` is available in tool context, and parent execution reports nested outputs/usage; core leaves machine-readable results intact.

`ctx.mode` distinguishes tui/rpc/json/print. Destructive direct commands get the interactive confirmation only in a real TUI. Narrow quote-aware token parsing covers quoted root and expanded HOME operands; it is not general shell static analysis. No confirmation flow is added to headless evaluations.

Extension settings are cloned through `pi.getSettings()`, not writable. The recovery launcher owns a temporary native agent settings profile and cleans it on child exit/error; free-only policy denies before creating that profile. Auxiliary SDK sessions receive an explicit model/runtime, restricted resources/tools, fresh history and xhigh. Live policy/model/effort/signal checks wrap every runtime request and awaited preparation step. Abort, unsubscribe and disposal are independently attempted; observed usage survives failure.

Harbor's actual evaluator timeout is external to the installed agent's command timeout. Only explicit `time_budget_sec` is forwarded for time notes; decimal text bridges Python float values and the launcher's strict parser, without modifying trial deadlines/resources. Elapsed time and emitted thresholds survive reload and compaction.

Background control signs per-nonce bounded mailboxes and publishes a complete ownership key atomically. Supervisors signal their own live group; callers never trust a persisted PID. Heartbeat freshness is not service health. Portable filesystem checks do not promise resistance to a hostile same-user directory-replacement actor.

Dedicated `apex-helper-usage` records account contract calls once even after abort/error/stale branch handling. Direct subagent results carry physical attribution/completeness; missing or partial usage leaves total dollars unknown. Unattributed nested aggregates stay conservatively unpriced. Fixture accounting is not provider receipt reconciliation.

## Phase 3 source contracts and rulings (Pi 0.99.2)

`pi.registerCommand(name, {description?, getArgumentCompletions?, handler: async(args, ctx)})` receives verbatim remaining arguments; native commands dispatch before `input`. `pi.sendUserMessage(content, {deliverAs?, expandPromptTemplates?})` allocates a turn; there is no `ctx.prompt()` or `pi.getResources()`. Use `resources_discover` -> `{skillPaths?,promptPaths?,themePaths?}` after `session_start`, and append `{path,content}` to `before_agent_start.systemPromptOptions.contextFiles`. `getActiveTools`, `setActiveTools`, `getAllTools` do not fence deferred/codemode nested execution: `tool_call` must reject planning mutations.

`pi.getFlag(name)` is scoped to flags registered by that extension (loader.js). Cross-extension Apex safety/eval and context-tool selections therefore use inert owner-scoped WeakMaps keyed by the shared native session manager; tasks cannot set those through transcript text. A scoped-flag regression exposed and corrected the older core/context compatibility query. Pinned parseArgs consumes a following positional token for unknown extension flags before registration; internal eval forwarding uses `--apex-eval=true`, while the public Apex prefix is a boolean switch. Filesystem skill URLs use `fileURLToPath` to preserve spaces/#.

`ctx.ui.setStatus(key,text|undefined)` retains the native footer. `ctx.getContextUsage()` may be undefined or have null tokens/percent. Native footer totals use `getEntries()` across branches; current task attribution uses `getLeafId()` without narrowing session totals. `ReadonlySessionManager` includes getCwd/getSessionId/getSessionFile/getLeafId/getBranch/getEntries. Tree navigation retains the same session; checkpoint IDs need a session-wide high-water counter plus persisted-store reconciliation, while eligible undo IDs stay in active-branch custom state. Coding compaction preserves apex-plan-state and apex-features-state verbatim.

`session_start` reasons startup/reload/new/resume/fork and `session_shutdown` quit/reload/new/resume/fork delimit allocations. `agent_settled` follows all continuations/retries; `agent_before_settle` composes entries and optional continuation. Finish checkpoints at completed turn/settlement boundaries rather than sibling tool-result arrivals. Command contexts expose waitForIdle/switchSession/newSession/fork/navigateTree. Extension hooks use the shared manager identity; contexts are not reused across a session replacement.

No `@earendil-works/pi-durable` dependency exists in the installed pin/lock. Public official package metadata describes a separate durable runtime, but its exact README/source API could not be fetched through the available reader. No guessed integration or install is used. Native exact completed-session restore is the tested fallback; durable in-flight side-effect replay remains unverified. Read-only JSONL inspection avoids native loadSessionEntries because that reader repairs unterminated tails. Apex distinguishes valid unterminated/torn tails and never mutates inspected files.

Nonblocking no-follow opens followed by descriptor type/identity checks prevent regular-file-to-FIFO replacement hangs in the report, checkpoint and static-probe readers. Private shadow Git configuration is reviewed separately from user repository metadata. These checks are not an OS jail or guarantees against hostile external ancestor swaps. No upstream Pi file was changed.

Final offline-suite investigation: the detached process micro service arms its watchdog after initialization, which can occur after tool-host exit. A real 750 ms startup-delay/readiness-refusal regression reproduced missing cleanup confirmation; the missing-endpoint fallback now reserves a full bounded lease after the final readiness attempt, preserving authenticated cleanup and failure status. This affects only the native process mechanics gate, not task timeouts. A separate full-suite session fault hit its unchanged five-second child watchdog under nine parallel test files; the unit runner now limits offline file concurrency to two rather than changing fixture/Harbor deadlines or weakening denial assertions. Initial failed logs remain preserved.

## Phase 4 source contracts

The [pinned Pi SDK](https://github.com/earendil-works/pi/blob/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d/packages/coding-agent/docs/sdk.md) supports explicit model/runtime/settings/session/resource/tool selection. The proposer uses inline registered read/list/submit tools only, disabled resource discovery and in-memory credentials/session. It reuses `evals/micro/provider-smoke.mjs` request/redaction guards instead of treating swallowed extension-hook exceptions as a physical-send limit. The SDK/OCI model-backed path is implemented but not exercised without renewed authorization and pinned tooling.

The [pinned Harbor trial layout](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/models/trial/paths.py) uses per-trial `result.json` and `agent/pi/sessions/*.jsonl`; collection refuses ambiguity and reads no verifier files. The exact installed source distribution is checked before `harbor.cli.main:app` is invoked through its interpreter. The controller preserves the existing plan's dataset filters, attempts, task deadlines and resources. Its own container/output watchdogs are engineering safeguards, not benchmark timeout changes.

Current checkout has no Git metadata or local pinned node_modules/Harbor environment. The retained Phase 3 full-history bundle supplies 12 real prior commits, all exported successfully without changing it. Existing `runs/README.md` and unregistered native model-smoke layouts coexist with evaluator attempt metadata; rule construction ignores non-attempt artifacts while requiring every supplied dev attempt and validating every encountered registered metadata entry.

Requested Muse and its observed canonical OpenRouter slug are an explicit known identity pair; arbitrary requested/observed changes still fail comparison. Native JSONL bytes, including CRLF framing, survive curated feedback export. Missing/poison held-out raw files are rejected or excluded based on split metadata before content access. Existing normalized caller-supplied trace/result association remains unverified, never relabeled authenticated.


## Performance-sensitive source contracts (2026-11-02)

The optimizations recorded in `DECISIONS.md` (performance pass) rest on these source facts. A change to any of them must rerun the matching differential test. Each test compares against a frozen `tests/fixtures/*-d0c6d2b.mjs` reference. Replace a reference only on purpose, when behavior is meant to change; `accounting-d0c6d2b.mjs` is pinned by SHA-256.

- **Pi sessions are append-only.** `SessionManager` only pushes to `fileEntries` and reassigns it in `newSession`, `_loadEntries` and `createBranchedSession`. `getEntries()` returns the same entry objects. The incremental summarizer detects a new history only by length and by the identity of the last processed entry (`features-accounting-incremental`).
- **Pi prepares tool calls one at a time** (`agent-loop.js`), so checkpoint `capture`/`finish` never overlap within a session in the product. The checkpoint module still keeps d0c6d2b's concurrent-call semantics (`features-checkpoints-equivalence`, `features-checkpoints-io`).
- **Checkpoint stat cache:** Bun's bigint `lstat`/`fstat` expose `dev`, `ino`, `mtimeNs` and `ctimeNs`. A filesystem reporting `ino` 0 rewrites the whole mirror every snapshot. The cache stays off on win32.
- **Git index stat data on Windows:** Git for Windows records ctime as the file's creation time and fills dev, ino, uid and gid itself, so Bun's `lstat` never matches an index entry. A test that forges an entry must keep Git's own stat fields; `features-checkpoints-io` changes only the size, which Git zeroes on a racily clean entry, and the blob.
- **Shadow auto maintenance:** after a commit, Git 2.4x runs `gc --auto`, while Git for Windows 2.56 runs a geometric repack, which packs loose objects and prunes nothing. `FOREGROUND_GC` keeps either inside the job (the trace shows `maintenance run --auto --no-detach`). The auto-gc test pins the gc task through its own Git wrapper.
- **Pi's edit dry run calls `ops.writeFile` only after every edit has matched**, and writer errors are not wrapped. The correction pre-check stops at the writer with a private sentinel (`core-control`).
- **Read results always carry `structuredContent`** (Pi `read.js` `toReadOutput`, Apex `efficientRead`), so `shapeToolResult` never shapes them. `selectText`'s incremental fit assumes `render()` emits newline-free elements ending in the pointer, and ASCII digits in gap markers (`context-shaping`).
- **Marked 18.0.11:** tokens without `text` (list, table, hr, space, def) are built from their `raw` alone, and inline state flows only forward. Streaming reuse keys on type, raw and text, and any change in the reference-link map rebuilds everything. Do not add suffix lexing. `appendTokens` must stay stateless between top-level tokens. Click handlers must read their strings from the DOM, never capture token strings, which are slices of the paint's whole source. After any Marked upgrade, rerun `dashboard-content`.
- **Dashboard details column:** `infoSnapshot()` must list every input `renderInfo`/`renderUsage` reads. Objects compared by identity must be replaced, never mutated in place.
- **Dashboard replay:** `replayLine()` in `dashboard/server.mjs` drops event types `app.js` does not render. If `app.js` starts rendering one, keep it there. `dashboard-replay` extracts `replayLine`, `eachLine` and `enhanceInput` from the server source by declaration shape, so keep those as top-level `function` declarations.
