# Pi API/source notes for Apex — Phase 0

Research only, retrieved 2026-10-01; re-audited against the v1.3.0 release on 2026-10-19. No Pi feature code, package installation, provider/model request, benchmark execution, or user-machine change was made for this audit.

## Provenance and scope

| Item | Verified value |
|---|---|
| Official source | <https://github.com/earendil-works/pi> |
| Audited source commit | `71023aec1546d6d677a65669c5665c0927ce0dd0` (the `v1.3.0` release tag commit) |
| Commit time | `2026-10-15T20:57:27+02:00` |
| Commit subject | `Release v1.3.0` |
| CLI package/version in that commit | `@earendil-works/pi-coding-agent`, `1.3.0` |
| npm runtime requirement | Node.js `>=22.19.0` (`packages/coding-agent/package.json:95`) |
| Official release/changelog | [v1.3.0](https://github.com/earendil-works/pi/releases/tag/v1.3.0), dated 2026-10-15 (`packages/coding-agent/CHANGELOG.md:3`, [official changelog](https://pi.dev/changelog)) |
| Documentation | [latest](https://pi.dev/docs/latest), mutable; retrieved on the audit date, not independently pinned to the source commit |
| Local source | Temporary shallow fetch of the tag commit (and the previous audit commit, for diffing); inspected read-only and deleted afterwards |

The audited commit **is** the `v1.3.0` release tag commit (`git log -1`: `71023aec1546d6d677a65669c5665c0927ce0dd0`, `Release v1.3.0`), and `packages/coding-agent/package.json:3` declares `1.3.0`. This fixes the earlier mismatch: the previous audit pinned `8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d`, an unreleased commit 17 commits past the `v0.99.2` tag, so its source did not exactly describe any published package. Pin-relevant source fingerprints at the tag, for comparison with a future audit:

| Tag source file | SHA-256 at `v1.3.0` |
|---|---|
| `packages/coding-agent/src/core/extensions/types.ts` | `cb54c7a4fedb3473bb995694bbc1f2988c144fb0b802bfd1b656816bc25d0f25` |
| `packages/coding-agent/src/core/system-prompt.ts` | `5e28c82634113d0cca7ff5da6fa94e27aaae80e461cd5664ced9dbcef6f89089` |
| `packages/coding-agent/src/core/tools/file-mutation-queue.ts` | `33cb06ac9bcdf32c8b84d9d12e33be44c503a7670f668e003a3262cd34294d11` (unchanged since the previous audit) |
| `packages/coding-agent/src/core/settings-manager.ts` | `aef8fea51000f291c1c51d81fd9b30f7a2bdd0e68370ad84b969e5fd15667e98` |

The npm package installed in this repository's `node_modules/@earendil-works/pi-coding-agent` reports version `1.3.0`, and its `dist/core/extensions/types.d.ts` declares `BeforeAgentStartUserEvent` and `ToolRendererResolver`; installed runtime behavior remains untested here. Current official imports use `@earendil-works/*`; old `@mariozechner/*` or `@badlogic/*` examples must not silently define the target API.

Read the repository's [AGENTS.md](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/AGENTS.md) and [README](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/README.md). Their contribution rules require full-file inspection for audits, explicit-path git operations, no unsolicited commits, `--ignore-scripts` dependency hydration, and faux-provider testing rather than paid test calls. We changed neither upstream code nor its dependencies.

## Changes since the previous audit (8ce69e9 → v1.3.0)

Diff basis: `git diff 8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d 71023aec1546d6d677a65669c5665c0927ce0dd0 -- packages/coding-agent packages/agent/src`. Upstream release notes: `packages/coding-agent/CHANGELOG.md` sections 1.0.0–1.3.0. Unchanged files (byte-identical) include `compaction/compaction.ts`, `cache-warmer.ts`, `session-manager.ts`, `tools/file-mutation-queue.ts`, `tools/truncate.ts`, `tools/{edit,edit-diff,write,grep,find,ls,powershell,index}.ts`, `utils/shell.ts`, `utils/tools-manager.ts`, `virtual-models.ts`, `nested-tool-calls.ts` limits, and `extensions/tool-search/index.ts`.

| Area | Change relevant to Apex | Evidence |
|---|---|---|
| `before_agent_start` | `BeforeAgentStartEvent` is now `BeforeAgentStartUserEvent \| BeforeAgentStartCustomEvent`, discriminated by `messageType`. `"user"` keeps `prompt`/`images`; `"custom"` has `message: CustomMessage` and fires for an idle `pi.sendMessage(...,{triggerTurn:true})`, which previously started a run **without** `before_agent_start`. `systemPrompt`/`systemPromptOptions`/result type unchanged. Both new types are root exports. | `src/core/extensions/types.ts:932–957`; `runner.ts:168–171,1427–1476`; `agent-session.ts:1837–1941,2343–2350`; `src/index.ts:67–70` |
| Run start / busy state | `_startRun` marks the session busy before compaction check and `before_agent_start`; `sendUserMessage` while starting needs `deliverAs`; abort during start aborts at `agent_start`; pending bash/custom messages now flush after preparation. | `agent-session.ts:1104–1107,1831–1880,2103–2108` |
| `agent_settled` | Adds `aborted: boolean` (extension event, `AgentSessionEvent`, JSON wire). | `types.ts:1033–1037`; `agent-session.ts:203,1081–1090`; `docs/json.md` |
| Tool events | `tool_execution_end` (and nested executions, `AgentToolCallOutcome`) gain optional `durationMs`; `ToolRenderContext` gains `durationMs`, `outputPad`. | `types.ts:492–498,1121–1122`; `packages/agent/src/types.ts:453–454,531–539` |
| Tool definition API | New `reachesTools`, `ToolNamespace.aliases`, `ToolLoadout.getPromptGuidelines`, `pi.registerToolRenderer` + `ToolRenderers`/`ToolRendererResolver` exports; `ToolInfo` includes `reachesTools`. `exposure`/`defaultActive`/`prepareLoadout` semantics unchanged. | `types.ts:534–545,561–562,614–621,672–681,1723–1724,2122–2128`; `loader.ts:367–371`; `runner.ts:796–802` |
| Prompt sections | `BuildSystemPromptOptions.hiddenTools` (normalized, always present): hidden declarations leave the tools list and rules; skills hint becomes tool-neutral (`"indirect"`) if only a hidden reader exists. `sections`/`contextFiles`/`preamble` contract unchanged. Docs pointer adds `docs/codemode.md`. | `system-prompt.ts:16–20,41,65,150–181`; `skills.ts:355–371` |
| Active tools | Pattern allowlists (`*`), `+`/`-` tool modifiers, transcript loadout restore on resume (with modifiers), pending not-yet-registered tools, MCP-only-via-codemode/tool_search rule. | `agent-session.ts:267–288,443–458,526,1523–1558,1815–1826`; `sdk.ts:72–92,280–294`; `settings-manager.ts:88–139` |
| Built-in tools | Input schemas unchanged. `read` adds `outputSchema` + `structuredContent`. Bash structured-output descriptions shortened (1 MiB cap unchanged). Output spill files go through `utils/output-files.ts` (0600, `wx`). `formatReadLineRange` new root export. | `read.ts:27–38,72–77,216`; `bash.ts:24,56–62`; `utils/output-files.ts`; `src/index.ts:393` |
| Compaction | `serializeConversation()` omits thinking blocks. `CompactionResult`, `session_before_compact` contract, thresholds, defaults and `modelOverrides` resolution unchanged (now schema/`SETTINGS_DEFAULTS` backed). | `compaction/utils.ts:107–145`; `docs/compaction.md:280–290`; `settings-manager.ts:833–880` |
| Resource loading | `DefaultResourceLoaderOptions.disabledBuiltinExtensions`; package include/exclude patterns normalize paths (Windows separators); ancestor context-file shadowing compares directory real paths (symlinked worktree `AGENTS.md`). `packageManager.resolve` and `no*` flags otherwise unchanged. | `resource-loader.ts:253–260,276–313,577–583`; `package-manager.ts:43–49,678,697` |
| CLI | `--no-mcp`; `--tools`/`--exclude-tools` patterns and `+`/`-`; `--tui-mode` default fullscreen; `--provider` requires `--model`; print text mode exits 1 with a stderr warning on `length` stop. Experimental client/server/micro/mini CLI removed. | `src/cli/args.ts:38,143–161,191–192,320–340`; `src/modes/print-mode.ts:154–157` |
| Session format | Still v3 (`session-manager.ts` unchanged). Docs drop system-message `replace`; assistant messages document `thinkingLevel`; tool results document `nestedCalls`. | `docs/message-types.md` |
| Settings | Schema-backed settings (`settings-schema.ts`, `settings-defaults.ts`, published `$schema`); `quietStartup` accepts `"header"`; new `sessionShareDestination`; `tuiMode` default `fullscreen`; `codemode`/`cacheWarming` defaults unchanged (`on`, 3000, `streaming`). | `settings-defaults.ts:4–67`; `docs/settings.md` |
| Packaging | Version 1.3.0; internal deps exact-pinned `1.3.0`; `npm-shrinkwrap.json` and `@earendil-works/chord` dependency removed; `./client` and `./experimental/plugin` exports and `packages/agent/src/harness` removed; `schemas` shipped. Node `>=22.19.0` unchanged. | `packages/coding-agent/package.json` |

## Claims checked against actual source

Paths below are relative to the audited repository. Line numbers refer to the pinned commit.

| Claimed capability | Finding and exact contract | Evidence |
|---|---|---|
| `agent_before_settle` | **Exists.** Final actionable session boundary after low-level runs, automatic retries/recovery, and queued continuations. Uses `BoundaryResult`, may propose entries and one continuation. `agent_settled` is notification-only final completion and, since 1.x, carries `aborted: boolean`. `agent_end` alone is insufficient to report task completion. | `src/core/extensions/types.ts:973–1037,1447–1448,1644–1648`; `src/core/agent-session.ts:1081–1090,1983–2008` |
| `structuredContent` | **Exists.** Optional `JsonValue` on tool results. Model-facing `content` and required `details` remain distinct. Declare TypeBox `outputSchema`; codemode callers receive `structuredContent`, while ordinary model calls still see `content`. Replacing `content` in a result hook without returning `structuredContent` drops it. `isError: true` can preserve error data. Built-in `read` now declares an `outputSchema` and returns `structuredContent` (text string or `{type:"image",data,mimeType,note}`). | `packages/agent/src/types.ts:424–447`; coding-agent `src/core/extensions/types.ts:599–605,1267–1282,1478–1489`; `src/core/tools/read.ts:27–38,72–77,216` |
| `withFileMutationQueue` | **Exists, public root export**, but it is a process-local file mutation queue, not a cross-process or cross-machine lock. Wrap the complete read/validate/modify/write operation; merely queueing the final write is insufficient. | `src/core/tools/file-mutation-queue.ts`; `src/index.ts:391`; detailed audit below |
| `tool_search` | **Exists** as CLI built-in extension `builtin:tool-search`, registered inactive. Local BM25 search over registered metadata; loads inactive `codemode`/`deferred` candidates into the active set for the next request. Does not invent/download tools. Declares `reachesTools: () => "all"`. SDK must explicitly add `createToolSearchExtension()`. | `src/extensions/tool-search/index.ts:1–18`; `src/extensions/tool-search/tool.ts:217–244`; root export `src/index.ts:414` |
| `codemode` | **Exists** as CLI built-in extension, registered inactive until explicitly enabled or activated by MCP. Scripts execute in QuickJS and reach other tools through `ctx.executeTool`; no direct Node/filesystem/network/timer globals. SDK must explicitly add `createCodemodeExtension()`. | `src/extensions/codemode/index.ts:1–49`; `src/extensions/codemode/tool.ts`; `src/extensions/codemode/execute.ts`; root export `src/index.ts:410` |
| Deferred tools | **Exists** as `ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden"`. Exposure is Pi tool-loadout/callability behavior; it is not evidence for a provider-specific deferred-schema protocol. | `src/core/extensions/types.ts:500–516` |
| `compaction.modelOverrides` | **Exists** as configuration overlays for reserve/recent token budgets keyed by exact case-sensitive `provider/model` strings, not globs. It does not choose the model that generates a summary. Exact precedence/bounds below. | `src/core/settings-manager.ts:833–880`; `src/core/settings-schema.ts:12–27`; `docs/compaction.md:441+` |
| Virtual models | **Exists.** `pi.registerVirtualModel()`/`unregisterVirtualModel()`, public root types. Route every request to a credentialed physical model and thinking level. Physical responses and selected virtual model are recorded separately. Branch router state survives compaction; direct requests ignore it. | `src/core/extensions/types.ts:1906–1928`; `src/core/virtual-models.ts:1–238`; [official virtual-model guide](https://pi.dev/docs/latest/virtual-models) |

All paths beginning `src/` in this document mean `packages/coding-agent/src/` unless explicitly qualified. Source browsing can use the [pinned coding-agent tree](https://github.com/earendil-works/pi/tree/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent).

## Structured system prompt decision

Use `before_agent_start` to assign Apex-owned named entries in `event.systemPromptOptions.sections` and add concise `promptGuidelines` where appropriate. This is the verified extension seam for a workflow policy and a current, bounded task-state summary. Use a stable tag such as `apex_workflow` or `apex_context`, with body text only: Pi wraps named sections itself. Tags must match `^[a-z][a-z0-9_-]*$`, and `preamble` is reserved.

Preserve the host's selected tools, project context, skills, cwd, and unrelated extension sections. Assign each Apex section from current state on each invocation rather than repeatedly appending old text. Attach tool-specific `promptSnippet`/`promptGuidelines` to the tool definition so they are included only when the tool is active. This is an integration decision inferred from the verified contracts, not an implemented feature.

`BeforeAgentStartEvent` is a union discriminated by `messageType`: `"user"` (submitted/RPC prompt or `pi.sendUserMessage()`) carries `prompt`/`images`; `"custom"` (an idle `pi.sendMessage(...,{triggerTurn:true})`) carries the starting `message` and no `prompt`. Handlers that read `event.prompt` must narrow on `messageType` first; a returned `message` is added to either kind of run. `systemPrompt` is readonly rendered text; `systemPromptOptions` is mutable and normalized with all collection fields present. Later handlers observe earlier mutations. `BeforeAgentStartEventResult.systemPrompt` or `forceSystemPrompt` is a full opaque override; use only for an explicit full-replacement requirement. `customPrompt` replaces the default prefix, which also suppresses default tool/rules/docs sections, while project context, skills, addendum, cwd, and custom sections are still assembled. New normalized field `hiddenTools` lists selected tools whose declarations `prepareLoadout` hides; the default tools list and rules omit them, and the skills hint names no tool (`"indirect"`) when the only file reader is hidden. Returning a full prompt unnecessarily would discard Pi's composable prompt behavior.

Pi persists prompt/tool changes as system-message section deltas and tool additions/removals. `context` handlers receive conversation without system messages; Pi restores prompt and tools after them. `context_with_system` sees and owns the complete request transcript, including the leading system message; dropping it is reported but the returned output is still honored. Apex's normal prompt integration therefore belongs in `before_agent_start`, not a full-transcript context transformer.

Evidence: [system-prompt.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/system-prompt.ts):9–86,128–229; [runner.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/extensions/runner.ts):1300–1366,1427–1476; [agent-session.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/agent-session.ts):1837–1941; [extensions guide](https://pi.dev/docs/latest/extensions).

## Extension lifecycle, state, and tool composition

An extension exports a synchronous or async default factory receiving `ExtensionAPI`. Local TypeScript is loaded through `jiti`; distributable packages can bundle extensions, skills, prompts, and themes. The factory registers capabilities; it must not start persistent processes/watchers/timers because invocations may load extensions without starting a session. Start them in `session_start` or a tool/command, and clean up idempotently in `session_shutdown`.

`pi.on()` returns an unsubscribe function. Handlers dispatch in load/registration order with a snapshot for a dispatch already in progress. Events have specific return contracts; a notification event does not become transformative just because a handler returns an object. `tool_call` can mutate `event.input` in place or block; **mutations are not revalidated**, so an argument-rewriting extension must validate its own changes. A thrown `tool_call` handler error blocks the call. Tool calls from one assistant response can run in parallel; use `executionMode: "sequential"` for shared mutable in-memory state.

Session storage choices: tool result `details` for branch-relative tool state; `pi.appendEntry(customType,data)` for stored data excluded from model context; `pi.sendMessage()` for stored content included in model context; external files for data beyond one session. Reconstruct branch-sensitive state with `getBranch()`, not all file entries. Handle new/resume/fork/reload and session replacement; the old extension context becomes stale. `ctx.waitForIdle`, reload, tree navigation, and session replacement exist only in command-capable contexts because doing them from lifecycle callbacks can deadlock.

The session counts as busy (`isStreaming`) from the moment a run starts, including the pre-prompt compaction check and `before_agent_start`. `pi.sendUserMessage()` delegates to `prompt()`, which throws `Agent is already processing` unless `deliverAs` is `"steer"` or `"followUp"` while busy; messages sent during `before_agent_start` therefore join the starting run, and an abort requested meanwhile aborts it at `agent_start`. A `sendMessage(...,{triggerTurn:true})` while idle now emits `before_agent_start` with `messageType:"custom"`. Evidence: `src/core/agent-session.ts:1104–1107,1464–1466,1831–1941,2103–2108,2336–2350,2395–2423`.

`ExtensionToolContext.executeTool(name,args,{signal,onUpdate})` executes registered callable tools through normal schema validation and hooks. Nested IDs are `<parent id>/<n>` and events include `parentToolCallId`. Nested calls are not separate transcript tool-call/result entries: their bounded metadata is attached to the parent result as `nestedCalls`; output is returned to the parent tool. Nested result usage is accumulated automatically, so the parent reports its own usage only. `ctx.tools` exposes callable tools. Unknown/invalid/blocked/thrown calls return an `AgentToolCallOutcome` with `isError:true`, rather than rejecting; codemode subsequently maps failures to script errors according to its own adapter.

Nested metadata limits (`src/core/nested-tool-calls.ts:27–29`): 8 KiB of arguments per call, 32 KiB per parent tool result, at most 256 calls, and `complete:false` if anything was omitted. It never stores result payloads. Tool annotations are unverified author hints, not enforcement. All extensions execute inside Pi with Pi's OS rights.

`turn_end` and `agent_before_settle` chain `SessionBoundaryDraft` proposals. Returned `entries` replaces the accumulated draft list, so a composing handler must keep prior `event.entries` when appending. Returned `continue` replaces the accumulated continuation boolean. Pi validates/rebuilds the preview after each handler; a final invalid draft list yields no entries and no requested continuation. Unconditional continuations can loop. Check `outcome`, `context.canContinue`, pending work, and a bounded continuation condition. `agent_settled` is the proper final completion observer.

## Tool exposure and built-in codemode/search

| Exposure | Declared to model | Nested-call access |
|---|---|---|
| `direct` | While active; normally activated at registration | While active |
| `model-only` | While active; normally activated at registration | Never; suitable for orchestration/UI |
| `codemode` | Only if explicitly activated; otherwise listed by codemode | Whenever registered |
| `deferred` | Only if activated; omitted from codemode's upfront listing, searchable | Whenever registered |
| `hidden` | Never, activation ignored | Never |

`defaultActive:false` keeps `direct`/`model-only` tools initially inactive. `setActiveTools` ignores unknown and hidden names, and, under a CLI/SDK `--tools` allowlist that keeps unnamed MCP tools registered, also ignores those MCP tools unless they are non-`direct` and `tool_search` is registered (`_isActivatable`). A resumed session restores the transcript's last tool loadout (with `--tools +name/-name` modifiers on top) when tools come from `defaultTools`; restored or reloaded names not yet registered stay *pending* and activate on registration, until a `setActiveTools` call deactivates any tool or the next run starts. `getActiveTools()` therefore excludes pending names. Evidence: `src/core/agent-session.ts:443–458,526,1523–1558,1580–1584,1815–1826,3618–3622,3709–3711`. codemode/deferred callability does not require activation. There is no tool unregister method: re-register hidden to withdraw an existing tool. `prepareLoadout` can replace model-facing descriptions and hide declarations while leaving tools active/callable and retaining transcript state. Namespace instructions are not automatically listed; scripts can request them with `describeNamespace()`, which (like `searchTools({namespace})`) also accepts `ToolNamespace.aliases`. New in 1.x: `ToolDefinition.reachesTools(input)` (`"all"` or candidate words) lets late registrars (MCP) finish registering reached tools in their `tool_call` handler; `ToolInfo` now includes it; `ToolLoadout.getPromptGuidelines(name)`; `pi.registerToolRenderer((toolName,next)=>renderers)` chains renderers in load order. Evidence: `src/core/extensions/types.ts:534–545,561–562,614–621,672–681,1723–1724,2122–2128`.

`tool_search` uses BM25 (`k1=1.2`, `b=0.75`), with name/description/schema names+descriptions and namespace text; default limit is eight. `query` must be nonempty and `limit` a positive integer. The tool is `model-only`, registered inactive, and activates matched inactive codemode/deferred tools. Codemode's `searchTools()` ranks callable tools without changing the active set. Its `describeTool`/`describeNamespace` disclose their metadata. This mechanism can support cheap discovery without a classifier/model request.

Codemode scripts accept raw JavaScript and a first-line `// @options:` object, expose `tools`, `ALL_TOOLS`, `text`, `image`, `store/load`, and optional `models` classifier/catalog/image-generation helpers (`models.generateImages()` is new in 1.x; images a script shows are saved to output files). It uses fresh QuickJS execution per call, not this ChatGPT environment's V8 `functions.exec` API. Successful `store()` writes persist as `codemode-store` custom entries on the active branch; failed calls do not commit their writes. For `$0` Phase 0, do not invoke the exposed `models.classify` or any other provider-capable operation. Codemode's restricted JavaScript globals do not sandbox the underlying tool process or the extension code.

## Official documentation review

Every requested page below was accessible. The source checkout also supplies the corresponding Markdown files.

| Official guide/reference | Facts relevant to Apex |
|---|---|
| [How Pi Works](https://pi.dev/docs/latest/how-pi-works) | Interfaces share agent/session machinery; context follows active branch; tool results can trigger more turns; steering and follow-up have distinct queue boundaries. |
| [Extensions](https://pi.dev/docs/latest/extensions) | Contracts/lifecycle/modes/state above; use exported types as exact API reference. |
| [Compaction](https://pi.dev/docs/latest/compaction) | Append-only summaries; projected context and recovery ordering matter; implementation audit below. |
| [Virtual Models](https://pi.dev/docs/latest/virtual-models) | Selected virtual pair is distinct from dispatched physical pair; route reasons user/continuation/retry/direct; sticky continuation and retry can preserve cache/signature compatibility. |
| [Skills](https://pi.dev/docs/latest/skills) | `SKILL.md` frontmatter advertises name/description/path; full instructions load on demand. `/skill:name` forces loading. `disable-model-invocation:true` disables automatic selection. Supports user/project `.pi` and `.agents/skills`; project ancestor search stops at repo root. First duplicate wins with warning. |
| [Packages](https://pi.dev/docs/latest/packages) | npm/git/URL/local sources; local path loads without copying; npm version or git tag/commit is pinning. Manifest/resources declare extensions/skills/prompts/themes. Host Pi packages and `typebox` should be peer deps, not bundled duplicates. |
| [SDK](https://pi.dev/docs/latest/sdk) | `createAgentSession` ordinarily discovers resources/settings/auth and persists sessions. Explicit cwd, `SessionManager.inMemory`, `dispose` for controlled embedding. SDK does not auto-load CLI MCP/codemode/search extensions; add factories; MCP startup needs `bindExtensions`. `DefaultResourceLoaderOptions.disabledBuiltinExtensions` (new) drops named `builtin:` extensions even when settings or `-e` enable them; `noExtensions`/`noSkills`/`noPromptTemplates`/`noThemes` are unchanged (`resource-loader.ts:276–313,577–583`). |
| [JSON](https://pi.dev/docs/latest/json) | Strict LF JSONL, optional CR stripping, consume stdout continuously. Node `readline` splits valid Unicode separators and is unsuitable. JSON begins with session header. `message_update` is wire delta-only; `message_end` authoritative; `agent_settled` final (now `{"type":"agent_settled","aborted":false}`); `tool_execution_end` adds optional `durationMs`. |
| [RPC](https://pi.dev/docs/latest/rpc) | Bidirectional long-lived JSONL subprocess; no JSON session header; correlate unique request IDs. Prompt success acknowledges acceptance/queueing/handling, not run completion. Handled input starts no run. Closing stdin requests orderly shutdown; official `RpcClient` available. |
| [Settings](https://pi.dev/docs/latest/settings) | User and project settings overlay; combined resource lists; defaultTools supports full replacement or inherited +/- adjustments. CLI built-in extension resource IDs can be disabled. `cacheWarming` default is `streaming`, not off. 1.x: `--tools`/SDK `tools` accept `*` patterns, and a list of only `+name`/`-name` entries modifies `defaultTools` (also reapplied on reload/resume); `tuiMode` default is now `fullscreen`; settings have a published JSON Schema (`settings-defaults.ts`, `settings-schema.ts`). |
| [Configuration](https://pi.dev/docs/latest/configuration) | User config `~/.pi/agent`, `PI_CODING_AGENT_DIR`; project `.pi`; settings/models/auth/mcp and resources. Project trust gates resource loading, not instruction-file context. Project SYSTEM/APPEND_SYSTEM take precedence over user equivalents. |
| [Security](https://pi.dev/docs/latest/security) | No built-in per-tool approval/sandbox; cwd is not a filesystem boundary. Trust gates resource loading; AGENTS/CLAUDE instructions still load. JSON/print/RPC unresolved ask skips protected resources. Extensions can access credentials/files/history. |
| [Containerization](https://pi.dev/docs/latest/containerization) | Whole-process Docker/VM isolation covers extensions too. Tool-only Gondolin leaves host extensions and credentials in host process. Docs describe Docker, Docker Sandboxes, OpenShell, Gondolin; Windows practicality not executed here. |
| [MCP](https://pi.dev/docs/latest/mcp) | Built-in stdio/streamable HTTP, legacy SSE rejected; mcp.json; default codemode exposure and per-tool overrides; same extension tool hooks; no automatic tool-call retry because effects may already exist. MCP Apps UI resources omitted. 1.x adds `--no-mcp` (no servers, no MCP tools); a `--tools` allowlist without `mcp__` entries keeps MCP tools registered for codemode/tool_search only. |
| [Windows](https://pi.dev/docs/latest/windows) | Native default Git Bash; WSL uses Linux. Optional native powershell tool resolves pwsh.exe then Windows PowerShell with no profile/noninteractive flags. `!`/`!!` still use Bash even if PowerShell is active. |
| [Local llama.cpp](https://pi.dev/docs/latest/llama-cpp) | Documented local router path, loopback, `--jinja`, no single `--model`; LLAMA_BASE_URL/login, optional key; `/llama` loading then `/model` selection. No local model/hardware behavior was tested. |

## Protocol/session and $0 boundary

Session format is v3, JSONL with parent-linked tree entries. It now includes system messages with named section deltas and `toolsAdded`/`toolsRemoved`, `context_edit` omissions/replacements, and model-attributed standalone `usage` entries. Compaction saves a prompt/tool checkpoint; raw history remains present even when omitted from future model context. Do not equate all raw entries with the current model transcript. Assistant messages record actual physical provider/model/thinkingLevel; selection entries may name virtual models.

`agent_end {messages,willRetry}` closes one low-level run; `agent_settled {aborted}` is the final public session event. SDK streaming updates contain cumulative snapshots, but JSON/RPC strip cumulative `message` and `partial` from `message_update`, keeping `usage` and deltas. Final `message_end` provides the canonical finalized message. Extension events and public/wire events are distinct: the extension `turn_start` type includes turnIndex/timestamp, whereas the public JSON turn_start does not. Do not copy the extension declaration appendix as a wire protocol schema.

Shell tools get resolved per-call `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`; these describe selection, not a router's physical dispatch. User `!`/`!!` commands do not receive this metadata injection. CLI/RPC set `AI_AGENT=pi` and `PI_CODING_AGENT=true`; SDK embedding does not automatically do so.

`PI_OFFLINE`/`--offline` suppress automatic startup network work; it is **not** a prohibition on explicitly requested model/provider/tool traffic. The current defaults include `cacheWarming:"streaming"`, and cache warming can send a one-output-token request, storing its separate additive billing as `usage` kind `cache_warm`. `getSessionStats` sums standalone usage plus compaction/branch-summary and assistant/tool-result usage. For future zero-spend local/fixture validation, explicitly disable warming and any remote-capable models/classifiers, MCP processes, or package updates; this audit invoked none. An actual local-inference run or a faux-provider fixture remains unverified.

Source: `docs/json.md`, `docs/session-format.md`, `docs/environment-variables.md`; `src/core/cache-warmer.ts:329–351`; `src/core/session-manager.ts:1244–1259`; `src/core/agent-session.ts:4209–4245`. This also matters to Harbor adapters: an adapter skipping standalone `usage` entries undercounts cache-warming work; a raw-message conversion does not reconstruct context edits or structured system state.

## Compaction and official examples audit

`CompactionResult` requires `summary`, `firstKeptEntryId`, `tokensBefore`, with optional `estimatedTokensAfter`, `usage`, and `details`. `session_before_compact` may return `{cancel:true}` or `{compaction:result}`; returning the result object directly is not its handler contract. Preparation follows the canonical projected context after prior compaction and context edits, carrying old `messagesToSummarize`, split-turn `turnPrefixMessages`, `previousSummary`, `fileOps`, resolved settings, and the kept-tail boundary. System messages are replayed separately, not included in summarization. A tool result is never a standalone cut point; when a user-message span exceeds recent budget, its prefix can be summarized separately. Nothing is prepared when already at a compaction entry or no summarizable input exists.

Automatic threshold is strictly `contextTokens > contextWindow - reserveTokens`, with defaults 16,384 reserve and 20,000 recent. Valid provider usage is preferred; fallback estimation is approximately characters/4 plus 1,200 tokens per image. Checks occur before submitting a user prompt, before a continuing assistant response after tools, and after the final low-level agent run. Terminal tool batches skip the between-turn check when no next response is required, but still reach the post-run check. Final overflow/recoverable-length handling persists omissions of the failed attempt, compacts, and permits one retry. Success that crossed the ordinary threshold does not retry an already completed response. `agent_before_settle` sees repaired context after recovery.

Manual `AgentSession.compact(customInstructions?)` returns `Promise<CompactionResult>`, first aborts an active operation, and does not resume its interrupted turn. Manual compaction can run with auto-compaction disabled. Extension `ctx.compact(options?)` returns **void**; observe `onComplete`/`onError`, rather than awaiting its return value.

Built-in summary calls use `cacheRetention:"none"`, session stream/auth/settings, configured retry policy, and fresh routing IDs unless supplied. History output budget is `min(floor(0.8*reserveTokens),positive model.maxTokens)`; split-turn prefix uses 0.5. Error, length, or tool-call summaries are rejected. A split turn can require two LLM summary calls. Serialized tool-result content is truncated to 2,000 characters per result; since 1.x `serializeConversation()` omits assistant thinking (`utils.ts:107–145`). Returning a custom compaction is not a model-free operation unless the extension actually produces its result locally; source examples can call providers.

`compaction.modelOverrides` matches the exact case-sensitive `${provider}/${model.id}` key, including IDs containing slashes. `reserveTokens` and `keepRecentTokens` resolve independently as model override → ordinary compaction setting → defaults. They must be nonnegative safe integers, including zero; they are not clamped against the context window. Invalid ordinary input throws even when an override would otherwise replace it. `enabled` belongs to the ordinary compaction setting; per-model enabled does not apply. For virtual models, the budget key uses the **selected virtual model**, while threshold context-window checks use the dispatched physical model. Built-in summary routing is a `direct` request, whose router state is absent/ignored.

Compaction hook handlers execute sequentially: last truthy return replaces earlier result; cancellation short-circuits; thrown errors are reported and then swallowed. Use one coordinated hook if several Apex components contribute durable state. Custom summary `details` need an explicit package schema/replay contract; subsequent built-in compaction does not interpret an extension's `fromHook` details as built-in file-operation metadata.

Public root exports include `compact`, `generateSummary`, `generateSummaryWithUsage`, `serializeConversation`, and `CompactionResult`. They do **not** export `prepareCompaction`, `CompactionPreparation`, `completeSummarization`, `getSummarizationFailure`, or projected-context estimate helpers. Root `CompactionSettings` is the optional-input shape, now derived from the TypeBox settings schema (`settings-schema.ts:18–27,459`) and re-exported by settings-manager. Derive preparation type from `SessionBeforeCompactEvent["preparation"]`; avoid unsupported source deep imports.

Evidence: `src/core/compaction/compaction.ts:67–114,140–349,619–765,772–935,965–1119`; `src/core/compaction/utils.ts:93–155`; `src/core/agent-session.ts:573–590,767–843,2779–2914,2956–3114,3128–3232,3484–3493`; `src/core/settings-manager.ts:55–59,833–880`; `src/core/settings-schema.ts:12–27,459`; `src/core/settings-defaults.ts:9–13`; `src/core/extensions/runner.ts:1096–1124`; `src/index.ts:29–51,309–322`. Source tests covering these boundaries were inspected, not executed: `test/settings-manager-compaction.test.ts` and `test/suite/agent-session-compaction-model-overrides.test.ts`.

| Official example | Verified use and package caution |
|---|---|
| [todo.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/examples/extensions/todo.ts) | Full `{todos,nextId}` snapshots in result details; reconstruct current branch on session_start/session_tree; `/todos` custom component guarded to TUI. Example mutates shallow-copied item objects; future immutable task state should use its own discipline. Lines 105–205,283–295. |
| [truncated-tool.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/examples/extensions/truncated-tool.ts) | Head truncation, full-output file and visible pointer, queued file writes. Example `execSync(args.join(" "))` runs unescaped model-supplied shell arguments, blocks, and ignores abort; do not copy that execution method. Lines 56–134. |
| [dynamic-tools.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/examples/extensions/dynamic-tools.ts) | Late registerTool from session_start/commands works; prompt snippets/guidelines. Registered-name Set is process state, not durable package state. Lines 24–74. |
| [custom-compaction.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/examples/extensions/custom-compaction.ts) | Uses separate Gemini model through registry, abort signal, cache off. Header claims entire-context discard, but code summarizes old history/prefix and returns preparation.firstKeptEntryId, preserving recent tail. Unlike built-in, it does not reject length/error/tool-call output; fallback can make another provider call. Lines 4–7,24–116. |
| [jev-router.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/examples/extensions/jev-router.ts) | Typed virtual router: classifier chooses initial Sol/Terra; successful edit/write since latest user switches to Luna; direct requests always Luna; explicit updated branch state. Needs classifier/Codex credentials if run, so not an offline Phase 0 executable check. Lines 41–112. |
| [debug-provider.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/examples/extensions/debug-provider.ts) | Clones raw provider events, groups per turn, saves expandable custom entries at turn_end. Enablement is process local and captured event data unbounded; a bounded logger needs additional design. Lines 22–90. |
| [subagent/index.ts](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/examples/extensions/subagent/index.ts) | Separate Pi-process example, not a core in-process agent API. Single/parallel/chain modes; one nonempty mode, maximum eight parallel tasks/four concurrent. See details below. |

Subagents spawn `pi --mode json -p --no-session`, with `shell:false`, optional tools/model/thinking, and a temp `--append-system-prompt` file. Without an explicit agent model they inherit dispatch model/thinking; with a model they do not inherit thinking. Agent definitions are rediscovered per tool call. Default scope is user; project discovery finds nearest ancestor `.pi/agents`; project definitions override user definitions in both scope. Confirmation for untrusted project agents exists only when UI is available and confirmation enabled; headless mode has no confirmation step. No `--no-extensions` flag is passed, so child resource auto-discovery remains active. Separate process/context is not filesystem isolation.

Parallel output is capped at 50 KB/task; single and chain final output are uncapped. Details retain full messages, usage, and stderr. `getFinalOutput` returns only the first text block of the latest assistant response with text. The example sends SIGTERM and attempts delayed SIGKILL only when `!proc.killed`; inferred caveat: that property indicates signal delivery, not confirmed process exit, so it is not a robust worker shutdown guarantee. Evidence: `examples/extensions/subagent/index.ts:168–261,270–438,457–711`; `agents.ts:53–146`.

## Built-in tools and shell/output audit

| Tool | Advertised required parameters | Advertised optional parameters | Source schema |
|---|---|---|---|
| `read` | `path:string` | `offset:number`, `limit:number` | `src/core/tools/read.ts:14–18`; output schema `27–38` (new) |
| `write` | `path:string`, `content:string` | None | `src/core/tools/write.ts:11–14` |
| `edit` | `path:string`, `edits:{oldText:string,newText:string}[]` | None | `src/core/tools/edit.ts:21–41` |
| `bash` | `command:string` | `timeout:number` seconds | `src/core/tools/bash.ts:40–43` |
| `powershell` | `command:string` | `timeout:number` seconds | `src/core/tools/powershell.ts:23–27,49–56` |
| `grep` | `pattern:string` | `path,glob:string`; `ignoreCase,literal:boolean`; `context,limit:number` | `src/core/tools/grep.ts:21–33` |
| `find` | `pattern:string` | `path:string`, `limit:number` | `src/core/tools/find.ts:26–32` |
| `ls` | None | `path:string`, `limit:number` | `src/core/tools/ls.ts:11–14` |

Numeric advertised schemas use Type.Number, without integer/minimum constraints; tool-specific runtime checks differ. Defaults activate read/bash/edit/write. All eight factories exist; read-only selection is read/grep/find/ls. Paths resolve against execution cwd or factory cwd; absolute/outside-cwd targets are accepted. Path handling strips leading `@`, expands `~`, normalizes special spaces, supports file://, and maps common native Windows drive forms. Cwd is not a confinement boundary. Evidence: `src/core/tools/index.ts:95–105,164–192`; `path-utils.ts:40–49`; `src/utils/paths.ts:67–107`.

### Read and mutations

Read loads the whole text file into memory, decodes UTF-8, and splits LF. Offset is advertised one-based and executed as truthy offset → max(0,offset−1); past EOF throws. User limit slices before normal head truncation. Text has no injected line-number prefix. Continuation notices provide the next offset. An oversized first line yields an alternate shell-read suggestion instead of partial head text. Images use byte signatures (JPEG/PNG/GIF/WebP/BMP; recognized APNG/JPEG-LS rejected), ignore offset/limit, and undergo resize/conversion; image processing failures return an omission note. Fallback image limits are 2000×2000 and 4.5 MiB base64 payload, with model metadata overrides. Evidence: `read.ts:124–204`; `src/utils/mime.ts:3–33`; `image-process.ts:49–118`; `image-resize-core.ts:21–29`.

Write creates parents recursively and directly overwrites UTF-8. No append/backup/atomic rename/prior-read guard exists. Edit strips/restores BOM, matches with normalized LF, restores detected LF/CRLF style, and validates the complete batch before writing. All edits match original content, not earlier replacements. Empty oldText, empty edit list, missing/ambiguous matches, overlapping replacements, and an unchanged result fail. The advertised batch schema replaces legacy top-level oldText/newText, although argument preparation still normalizes that older form and accepts a string/singleton edits representation. Evidence: `write.ts:34–36,65–89`; `edit.ts:103–140,163–210`; `edit-diff.ts:11–24,300–361`.

The edit implementation falls back to fuzzy normalization: NFKC, trimmed trailing whitespace, smart quotes/dashes/special spaces. Uniqueness is checked in fuzzy-normalized content even when an exact match exists. If any edit needs fuzzy matching, changed line blocks come from normalized content; unchanged blocks are retained. This matters when Apex wants strict patch application: built-in edit is not purely byte-exact. Details include display diff, unified patch, and firstChangedLine; default context is four lines. Evidence: `edit-diff.ts:34–54,132–172,207–250,316–380`; `edit.ts:70–76,201–210`.

`withFileMutationQueue<T>(filePath:string,fn:()=>Promise<T>):Promise<T>` serializes same-key callbacks in order and allows different files concurrently. Existing targets use realpath(resolve(path)); ENOENT/ENOTDIR fall back to resolved path. Return/errors propagate and finally releases the queue. Both built-in mutations wrap the whole read/modify/write operation; abort checks keep the queue until awaited writes settle, although a post-write abort may report failure after bytes changed. It has no atomic-write, abort-argument, or cross-process guarantee. Inferences from module-local Maps: nested awaited acquisition for the same key can deadlock, and aliases through missing paths may use different keys. Separate Apex worker processes therefore need an explicit interprocess mutation strategy. Evidence: `file-mutation-queue.ts:1–61`; public `src/index.ts:386`; `write.ts:67–83`; `edit.ts:163–199`.

### Truncation and search

Shared model output defaults are 2,000 lines or 50×1024 bytes, whichever truncates first. Head truncation keeps complete lines and can return empty content when line one alone exceeds its byte budget; tail truncation may retain a UTF-8-safe tail of an oversized final line. Grep per-line truncation uses 500 JavaScript string characters plus a suffix. Evidence: `truncate.ts:11–13,78–160,168–275`.

Grep invokes rg with JSON/line-number/no-color/hidden flags, structured argument arrays, and `--` before pattern/path. Default limit is 100 match events; runtime clamps to at least one and stops rg at the limit. Context is constructed afterward by reading matching files; format distinguishes match `file:line:` from context `file-line-`. Final output has a 50 KiB head limit, no independent final line limit, and no spill file. rg exit one means no matches; other non-limit failures reject. Evidence: `grep.ts:119–168,197–307`.

Find invokes fd glob/hidden/no-color/max-results, default 1,000. Slash-containing patterns use full-path matching, usually prepend `**/`, and normalize Windows separators. Results are root-relative with slash separators; final head limit 50 KiB, no spill. A nonzero fd exit with output can still return it. Ls defaults to 500 entries, includes dotfiles, case-insensitive sorts, appends slash to directories, skips failed stat calls, and is one-level without gitignore filtering. It also uses 50 KiB head truncation and no spill. Evidence: `find.ts:13–24,111–128,171–214,244–299`; `ls.ts:83–160`.

rg/fd are native executables: prefer Pi's bin, then PATH (`fdfind` accepted), otherwise may download GitHub assets. Native Windows uses ZIP-packaged .exe assets. PI_OFFLINE truthy prevents missing-tool downloads. This is an offline portability prerequisite, not an LLM provider issue. Evidence: `src/utils/tools-manager.ts:14–17,29–101,257–380`.

### Shell processes, output, and background lifetime

Each tool call spawns a fresh shell with its own cwd/env (`bash -c` or PowerShell -Command). Shell cd, exported variables, aliases, and functions do not persist across calls. Files and surviving independent processes can persist. Bash commandPrefix is prepended with LF. Child env normally inherits Pi env and prepends Pi bin to PATH; agent tools refresh session metadata per call. Evidence: `bash.ts:97–122,186–225,268–275`; `src/utils/shell.ts:20–21,122–149`.

There is **no default shell timeout**. A supplied timeout must be finite, positive, and no more than 2,147,483.647 seconds. Abort/timeout kills the process tree: Unix process-group SIGKILL with PID fallback, Windows taskkill.exe /F /T /PID. Unix shell spawn is detached; native Windows is not. Successful completion performs no tree kill. Tracked shell PID is removed in finally. If background descendants hold inherited stdout/stderr, child-process waiting releases their streams after 100 ms idle following shell exit, resetting the idle timer when chunks arrive. Background processes can therefore outlive a successful tool call; this does not guarantee their lifetime or continuing output capture. Active tracked shells are cleaned on shutdown signals; completed calls are not a persistent job registry. Evidence: `bash.ts:22–37,115–165`; `src/utils/shell.ts:163–218`; `child-process.ts:16,38–137`; Windows regression test `test/bash-close-hang-windows.test.ts:13–40,84–124` was inspected, not run.

Agent bash/PowerShell combines stdout+stderr and retains a streaming UTF-8 display tail. When model display limits are exceeded, the accumulator creates an OS-temp log with **full raw output**, including prior chunks; since 1.x all such output files are created through `src/utils/output-files.ts` with mode `0600` and exclusive-create (`wx`) flags. Returned notices point to the full path; the accumulator does not delete it. Programmatic structured output is separate: `{output,truncated,full_output_path?,exit_code,wall_time_seconds}` with **1 MiB** retained output, first and last 512 KiB plus omission marker. Model content remains 2,000-line/50-KiB tail. Nonzero exits resolve with structured data and isError:true; timeout/abort throw with captured display text. Evidence: `src/utils/output-files.ts:14–34`; `output-accumulator.ts:57–118,144–176,239–256`; `bash.ts:22–24,56–62,276–408`.

User !/!! and direct RPC bash use separate `bash-executor.ts`, returning `BashResult`; they strip ANSI/control data/CR (1.x holds an escape sequence split across chunks until it completes), maintain a rolling buffer, and spill sanitized output. Cancellation returns cancelled:true with output produced so far, and there is no timeout parameter. !! output is excluded from model context. Evidence: `bash-executor.ts:20–37,48–146`; `agent-session.ts:3862–3920`.

Native Windows Bash resolution is explicit shell path → Git Bash under Program Files → PATH bash.exe; legacy System32/Sysnative WSL bash uses stdin -s. Unix is /bin/bash → PATH bash → sh. Native-only PowerShell rejects non-Windows, prefers pwsh.exe then powershell.exe, and runs -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command with UTF-8 output setup. Evidence: `src/utils/shell.ts:15–21,67–135`; `powershell.ts:16,32–36`.

## Limits and verification status

This is static source/documentation research. The repository's installed package was confirmed as 1.3.0 (see provenance), but we have not authenticated any provider, run local inference, benchmarked token/context effects, or tested extension loading in the actual published npm package. The exact source commit is pinned; docs/latest and registry state remain moving references. A linked minimal SDK example initially failed web retrieval, but local cloned examples were available. Raw GitHub source was blocked by the web opener but succeeded through ordinary targeted retrieval and the shallow checkout.

The public package export map does not expose arbitrary source deep imports. Source-defined helpers are not necessarily public API; package root exports must be checked separately. For example, root exports `ToolResultEvent` and result type guards, but not each named Bash/PowerShell/Read/etc result-event variant; consumers can narrow the union through those guards. Source and examples are MIT-licensed; the declaration appendix below is an audit extraction, not a new library implementation.

## Appendix — exact extension event/result declarations

Declarations are extracted from the `v1.3.0` `packages/coding-agent/src/core/extensions/types.ts`, with comments removed, plus its re-exported cache-warming declarations. Private base interfaces and shared draft types are included so the event contracts are interpretable. Imports and implementations are omitted. This is a source inventory, not a compilable module and not the JSON/RPC wire schema.

| Event name | Handler type (all return unsubscribe `() => void`) |
|---|---|
| `project_trust` | `ProjectTrustHandler` |
| `resources_discover` | `ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>` |
| `session_start` | `ExtensionHandler<SessionStartEvent>` |
| `session_info_changed` | `ExtensionHandler<SessionInfoChangedEvent>` |
| `session_before_switch` | `ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>` |
| `session_before_fork` | `ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>` |
| `session_before_compact` | `ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>` |
| `session_compact` | `ExtensionHandler<SessionCompactEvent>` |
| `session_compact_failed` | `ExtensionHandler<SessionCompactFailedEvent>` |
| `session_shutdown` | `ExtensionHandler<SessionShutdownEvent>` |
| `mcp_servers_change` | `ExtensionHandler<McpServersChangeEvent>` |
| `session_before_tree` | `ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>` |
| `session_tree` | `ExtensionHandler<SessionTreeEvent>` |
| `context` | `ExtensionHandler<ContextEvent, ContextEventResult>` |
| `context_with_system` | `ExtensionHandler<ContextWithSystemEvent, ContextEventResult>` |
| `cache_warming_decision` | `ExtensionHandler<CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult>` |
| `before_provider_request` | `ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>` |
| `before_provider_headers` | `ExtensionHandler<BeforeProviderHeadersEvent>` |
| `after_provider_response` | `ExtensionHandler<AfterProviderResponseEvent>` |
| `provider_stream_event` | `ExtensionHandler<ProviderStreamEvent>` |
| `before_agent_start` | `ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>` |
| `agent_start` | `ExtensionHandler<AgentStartEvent>` |
| `agent_end` | `ExtensionHandler<AgentEndEvent>` |
| `agent_before_settle` | `ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>` |
| `agent_settled` | `ExtensionHandler<AgentSettledEvent>` |
| `ui_prompt_start` | `ExtensionHandler<UIPromptStartEvent>` |
| `ui_prompt_end` | `ExtensionHandler<UIPromptEndEvent>` |
| `turn_start` | `ExtensionHandler<TurnStartEvent>` |
| `turn_end` | `ExtensionHandler<TurnEndEvent, TurnEndEventResult>` |
| `message_start` | `ExtensionHandler<MessageStartEvent>` |
| `message_update` | `ExtensionHandler<MessageUpdateEvent>` |
| `message_end` | `ExtensionHandler<MessageEndEvent, MessageEndEventResult>` |
| `tool_execution_start` | `ExtensionHandler<ToolExecutionStartEvent>` |
| `tool_execution_update` | `ExtensionHandler<ToolExecutionUpdateEvent>` |
| `tool_execution_end` | `ExtensionHandler<ToolExecutionEndEvent>` |
| `model_select` | `ExtensionHandler<ModelSelectEvent>` |
| `thinking_level_select` | `ExtensionHandler<ThinkingLevelSelectEvent>` |
| `tool_call` | `ExtensionHandler<ToolCallEvent, ToolCallEventResult>` |
| `tool_result` | `ExtensionHandler<ToolResultEvent, ToolResultEventResult>` |
| `user_bash` | `ExtensionHandler<UserBashEvent, UserBashEventResult>` |
| `input` | `ExtensionHandler<InputEvent, InputEventResult>` |

Subscription count: 41 (unchanged). Extracted local event/result/shared declarations: 101, plus 4 cache-warming declarations (`src/core/cache-warmer.ts`, unchanged). The 1.3.0 additions over the previous audit are the private `BeforeAgentStartEventBase`, `BeforeAgentStartUserEvent`, `BeforeAgentStartCustomEvent` (with `BeforeAgentStartEvent` now their union), `ToolRenderers`, and `ToolRendererResolver`; `AgentSettledEvent.aborted` and `ToolExecutionEndEvent.durationMs` are new fields.

```typescript
export interface ProjectTrustEvent {
	type: "project_trust";
	cwd: string;
}

export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

export interface ProjectTrustEventResult {
	trusted: ProjectTrustEventDecision;
	remember?: boolean;
}

export interface ProjectTrustContext {
	cwd: string;
	mode: ExtensionMode;
	hasUI: boolean;
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

export type ProjectTrustHandler = (
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

export interface McpServersChangeEvent {
	type: "mcp_servers_change";
	servers: RegisteredMcpServer[];
}

export interface SessionStartEvent {
	type: "session_start";
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
}

export interface SessionInfoChangedEvent {
	type: "session_info_changed";
	name: string | undefined;
}

export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	signal: AbortSignal;
}

export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
}

export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	reason: "manual" | "threshold" | "overflow";
	errorMessage?: string;
	aborted: boolean;
	willRetry: boolean;
	fromExtension: boolean;
}

export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	targetSessionFile?: string;
}

export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionInfoChangedEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

export interface ContextWithSystemEvent {
	type: "context_with_system";
	messages: AgentMessage[];
}

export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers";
	headers: ProviderHeaders;
}

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

export interface ProviderStreamEvent {
	type: "provider_stream_event";
	provider: ProviderId;
	api: Api;
	model: string;
	data: unknown;
}

interface BeforeAgentStartEventBase {
	type: "before_agent_start";
	readonly systemPrompt: string;
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

export interface BeforeAgentStartUserEvent extends BeforeAgentStartEventBase {
	messageType: "user";
	prompt: string;
	images?: ImageContent[];
}

export interface BeforeAgentStartCustomEvent extends BeforeAgentStartEventBase {
	messageType: "custom";
	message: CustomMessage;
}

export type BeforeAgentStartEvent = BeforeAgentStartUserEvent | BeforeAgentStartCustomEvent;

export interface AgentStartEvent {
	type: "agent_start";
}

export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

export type AgentActivityOutcome = "completed" | "aborted" | "error";

export interface CustomEntryDraft {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface CustomMessageEntryDraft {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
}

export interface ContextEditEntryDraft {
	type: "context_edit";
	targetId: string;
	replacement: ContextEditEntry["replacement"];
}

export interface CompactionEntryDraft {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string | null;
	details?: unknown;
	usage?: Usage;
}

export type SessionBoundaryDraft =
	| CustomEntryDraft
	| CustomMessageEntryDraft
	| ContextEditEntryDraft
	| CompactionEntryDraft;

export interface BoundaryContextPreview {
	contextEntries: ProjectedSessionEntry[];
	contextMessages: AgentMessage[];
	llmMessages: Message[];
	pendingMessages: AgentMessage[];
	canContinue: boolean;
}

export interface BoundaryState {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	outcome: AgentActivityOutcome;
}

export interface BoundaryResult {
	entries?: SessionBoundaryDraft[];
	continue?: boolean;
}

export interface AgentBeforeSettleEvent extends BoundaryState {
	type: "agent_before_settle";
}

export interface AgentSettledEvent {
	type: "agent_settled";
	aborted: boolean;
}

export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

export interface UIPromptStartEvent {
	type: "ui_prompt_start";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

export interface UIPromptEndEvent {
	type: "ui_prompt_end";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

export interface TurnEndEvent extends BoundaryState {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
	messageEntryId: string;
	toolResultEntryIds: string[];
}

export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: any;
	parentToolCallId?: string;
}

export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: any;
	partialResult: any;
	parentToolCallId?: string;
}

export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: any;
	isError: boolean;
	durationMs?: number;
	parentToolCallId?: string;
}

export type ModelSelectSource = "set" | "cycle" | "restore";

export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

export interface UserBashEvent {
	type: "user_bash";
	command: string;
	excludeFromContext: boolean;
	cwd: string;
}

export type InputSource = "interactive" | "rpc" | "extension";

export interface InputEvent {
	type: "input";
	text: string;
	images?: ImageContent[];
	source: InputSource;
	streamingBehavior?: "steer" | "followUp";
}

export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
	parentToolCallId?: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface PowerShellToolCallEvent extends ToolCallEventBase {
	toolName: "powershell";
	input: PowerShellToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface LsToolCallEvent extends ToolCallEventBase {
	toolName: "ls";
	input: LsToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

export type ToolCallEvent =
	| BashToolCallEvent
	| PowerShellToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| FindToolCallEvent
	| LsToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	parentToolCallId?: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	structuredContent?: JsonValue;
	isError: boolean;
	usage?: Usage;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface PowerShellToolResultEvent extends ToolResultEventBase {
	toolName: "powershell";
	details: PowerShellToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface LsToolResultEvent extends ToolResultEventBase {
	toolName: "ls";
	details: LsToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

export type ToolResultEvent =
	| BashToolResultEvent
	| PowerShellToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| FindToolResultEvent
	| LsToolResultEvent
	| CustomToolResultEvent;

export type ExtensionEvent =
	| ProjectTrustEvent
	| ResourcesDiscoverEvent
	| McpServersChangeEvent
	| SessionEvent
	| ContextEvent
	| ContextWithSystemEvent
	| CacheWarmingDecisionEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| AfterProviderResponseEvent
	| ProviderStreamEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentBeforeSettleEvent
	| AgentSettledEvent
	| UIPromptStartEvent
	| UIPromptEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type TurnEndEventResult = BoundaryResult;

export type AgentBeforeSettleEventResult = BoundaryResult;

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
}

export type UserBashEventResult =
	| {
			operations: BashOperations;
			result?: never;
	  }
	| {
			operations?: never;
			result: BashResult;
	  };

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	usage?: Usage;
}

export interface MessageEndEventResult {
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
		usage?: Usage;
	};
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export type ToolRenderers = Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult">;

export type ToolRendererResolver = (
	toolName: string,
	next: () => ToolRenderers | undefined,
) => ToolRenderers | undefined;

export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	warnings?: Array<{ path: string; warning: string }>;
	runtime: ExtensionRuntime;
}
```

Re-exported from `src/core/cache-warmer.ts`:

```typescript
export type CacheWarmingAction = "warm" | "stop";

export interface CacheWarmingDecision {
	phase: "streaming" | "idle";
	warmCost: number;
	missCost: number;
	continuationProbability: number;
	expectedSavings: number;
	economicsAvailable: boolean;
	action: CacheWarmingAction;
}

export interface CacheWarmingDecisionEvent
	extends Pick<CacheWarmingDecision, "warmCost" | "missCost" | "continuationProbability" | "action"> {
	type: "cache_warming_decision";
}

export interface CacheWarmingDecisionEventResult {
	action?: CacheWarmingAction;
}
```

## Upstream license for the extracted declarations

Source: [LICENSE](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/LICENSE).

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
