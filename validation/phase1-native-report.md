# Phase 1 native offline gate

Owned files: `scripts/micro-phase1.mjs`, `tests/phase1-micro.test.mjs`.

The gate exports `runPhase1Micro()` without importing Pi or allocating resources at module import. Its one child process is limited to 20 seconds and 64 KiB combined stdout/stderr, uses `PI_OFFLINE=1`, a fixture-owned `PI_CODING_AGENT_DIR`, and existing local search engines on PATH with `.tools/bin` first. The parent discards stderr and returns only fixed failure codes. Owned fixtures are removed on success and failure. Credential environment names are never copied to the child.

Before importing Pi, the child installs denial counters for Node HTTP/HTTPS/fetch/WebSocket/socket/TLS/DNS/datagram networking and blocks user/ancestor resource discovery. It then supplies forbidden credential-store callbacks to `ModelRuntime.create()` and denies runtime credential, authentication, classifier, image and chat inference methods. `session.agent.streamFunction` also throws and records an inference attempt. No provider or benchmark requests run.

Two native `DefaultResourceLoader.extensionFactories` invoke the actual Apex context and router defaults. A fixture-only API wrapper substitutes `all` only after the actual `apex-context-flags` flag has registered with its normal empty default. Pi 0.99.2's real session creation and `bindExtensions()` deliver `session_start`; MAIN/FAST remain exactly `openrouter/meta/muse-spark-1.3-contributor` with `xhigh`. Cache warming, automatic compaction and retry are disabled.

The gate executes registered native-compatible read/outline, grep/find/ls, edit, patch and bash definitions with a native runner tool context, then calls native `emitToolResult()`. Pi has no public top-level session tool execution method; its public `ctx.executeTool()` represents a nested call and is used for the codemode regression instead. Actual native tool_search changes the session's deferred patch declaration loadout. The pinned nested-call recorder's `takeRecord()` and `clear()` seams prevent retained test call scopes.

Native codemode uses the installed Pi QuickJS worker without installing an engine. Its selected loadout and schema omit model APIs, and actual execution of `return typeof models` returns `undefined`. A second native script calls `tools.bash()` through the real session nested executor, parses a 20,481-byte local JSON result with 4,096 elements and returns only the small count. An adversarial fixture removes the nested caller metadata before the actual shaping hook; the JSON parse then fails and the gate rejects the result. This catches loss of programmatic output fidelity despite coherent shaped content/structuredContent.

Native routing registration populates the actual virtual catalog entry; its actual registered route definition receives a native extension context and preserves the allowed physical model/thinking on continuation. This checks registration and deterministic routing mechanics, not provider request dispatch. Pi's native `agent.finishTurn()` persists masking drafts to the actual SessionManager; reopening the native transcript preserves the stub while original history remains intact. The separately seeded masking observation is explicitly synthetic text with a real local recovery log, because the masking policy conservatively skips structured shell payloads.

Forced native `session.compact()` reaches the actual coordinator hook once, receives cancellation before authentication/inference, and appends no compaction entry. Removing the compact feature in a negative fixture causes denied authentication and a failing gate, without reaching a provider.

## Explicit test isolation boundaries

- As in `micro-session.mjs`, both `DefaultPackageManager.resolve()` and `resolveExtensionSources()` are replaced with empty results. Pi applies no-resource flags after package resolution; flags alone would still inspect ambient user/ancestor resources. A negative fixture restores that discovery path and proves it is blocked.
- Pi 0.99.2's `registerVirtualModel()` updates its catalog synchronously, then schedules `refresh({allowNetwork:false})`, which performs account availability discovery. The gate suppresses this exact offline availability-refresh boundary while preserving native registration/catalog updates. Other refresh modes and all credential/auth/inference methods are denied. The passing run reports one suppressed local refresh.
- `PI_CODING_AGENT_DIR` is generated from the owned fixture. Native search otherwise probes `~/.pi/agent/bin` before searching PATH, even under `PI_OFFLINE`; setting the owned path prevents ambient binary discovery without installing or changing a tool engine.

## Verification

Initial RED: all three initial tests failed with `offline Phase 1 gate is missing` before the script existed. Additional negative fixture tests were observed failing with `unknown_fixture_mode` before their implementation. The JSON regression assertion was observed RED before its check was implemented. The shaper worker's nested-result fix had landed by first actual JSON execution, so this report does not claim a pre-fix native JSON failure; the explicit metadata-loss fault proves the completed gate detects that corruption.

- `node --check scripts/micro-phase1.mjs` — PASS.
- `node --check tests/phase1-micro.test.mjs` — PASS.
- `node --test tests/phase1-micro.test.mjs` — 5/5 PASS, about 8.5 seconds total.
- `node scripts/micro-phase1.mjs` — PASS, Pi 0.99.2; 16 checks true; two native extension factories; 11 configured tool definitions, nine initial active declarations and eight callable tools; one cancelled compaction hook; zero compaction entries.
- Passing counters: `{network:0,auth:0,inference:0,credentials:0}`; zero ambient discovery attempts; owned fixture removed.

Whole-package check/test/micro integration remains the root worker's verification step after component freeze.

## Synthetic local effects

| Fixture | Original bytes | Returned bytes | Returned/original |
| --- | ---: | ---: | ---: |
| Actual native bash hook-visible text, shaped at top-level hook | 38,390 | 6,536 | 0.170253 |
| Explicit synthetic text observation, persisted native masking projection | 26,600 | 177 | 0.006654 |

These are local UTF-8 byte counts for known fixtures. Provider token savings, cache hits, model correctness, latency, dollars per solved task, pass rate and confidence intervals are unmeasured. No feature is promoted or enabled by default.
