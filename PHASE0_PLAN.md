# Apex Phase 0 Implementation Plan

> For agentic workers: execute small verified steps. The supplied APEX_BUILD.md is the authoritative specification; Phase 0 alone is active.

**Goal:** Learn the pinned Pi source and build a reproducible measuring stick before changing agent behavior.

**Architecture:** Apex stays a Pi package with a thin cross-platform launcher. Offline Python tools own evaluation accounting, trace ingestion, statistical reports, and run preparation. Harbor owns container lifecycle and verification. No feature or prompt override is active by default during baseline collection.

**Tech stack:** Node.js ESM, pinned Pi package, Python standard library, pinned Harbor.

**Spec:** APEX_BUILD.md, supplied by the user in this conversation.

## Global constraints

- Initial budget was $0, followed by a $1 cap for bounded testing. Latest instruction is free-only: no additional paid execution; unused cap frozen.
- Only openrouter/meta/muse-spark-1.3-contributor may be used, for both MAIN and FAST; credential environment name is OPENROUTER_API_KEY. Secrets remain outside source/artifacts.
- Target is Windows local execution; Docker/WSL/container host details are unset.
- Never modify Pi core without asking. Read source before implementing integration.
- No runtime task or dataset detection, test/verifier access, cross-task memory, or altered task resources/timeouts.
- Held-out trajectories must not enter tuning reports or failure analysis.
- Record raw traces, exact versions, harness commit, unknown measurements, and measurement limitations.
- No Phase 1–4 behavior changes and no default-on experimental features.

## Review focus

1. Missing usage/pricing must remain unknown, never become free tokens or zero dollars.
2. Repeated attempts must not be treated as independent tasks when calculating confidence intervals.
3. Budget preflight must reject absent/invalid caps and resist overcommitted reservations.
4. Held-out traces must remain inaccessible to the failure-analysis command.
5. Windows launch behavior, shell quoting, provider/model IDs, and container installation must follow source-verified interfaces.

## Task 1: Source and configuration

- [x] Preserve the supplied build brief as APEX_BUILD.md.
- [x] Inspect Pi AGENTS.md, README, requested documentation, types, compaction, tools, and examples; capture exact source identifiers in NOTES.md and appendices.
- [x] Inspect Harbor Pi implementation and dataset registry; capture CLI help/list and the /tests upload fix status.
- [x] Record source pins, official pricing provenance, and the user's configuration.

## Task 2: Offline measuring stick

Files: evals/analysis/, evals/micro/, tests/, evals/pricing.json.

Interfaces: Python `analyze_pi_trace(path, prices)` emits normalized task metrics; `summarize_runs(records, seed=0)` emits cluster-aware confidence intervals; synthetic micro fixtures never represent benchmark scores.

- [x] Write and run failing tests for usage accounting, duplicate streamed/final events, missing prices, malformed traces, and clustered statistics.
- [x] Implement normalization and reporting against the actual Pi JSON/session schema.
- [x] Add trace ingestion, source provenance, split manifests and held-out guards; keep failure labels provisional until dev traces exist.
- [x] Run the unit suite and offline micro-evals; report model-dependent micro-evals as pending.

## Task 3: Package and guarded run preparation

Files: package.json, bin/, scripts/, evals/harbor/, evals/config.json.

Interfaces: launcher invokes the exact pinned local Pi CLI; run preparation writes a plan only, requires explicit estimate/cap/model/container configuration for execution, and uses stock Pi or the Apex adapter as distinct configurations.

- [x] Write and run failing tests for pass-through arguments, unresolved configuration, budget validation, and protected held-out analysis.
- [x] Implement a portable launcher with unchanged stock Pi behavior during Phase 0.
- [x] Implement the Harbor installed-agent adapter using verified source signatures and isolated per-task session directories.
- [x] Add upgrade checks and a safe baseline run preparation command. Do not run a benchmark.

## Task 4: Verification and handoff

- [x] Run npm run check, npm test, and npm run micro; save validation evidence.
- [x] Request an independent code review and fix material defects.
- [x] Write DECISIONS.md, RESULTS.md, README.md and progress records with measured offline results, remaining blockers, and spend $0.
- [x] Commit honest measured effects using the explicit agent identity recorded below; no user identity or remote push.
- [x] Package and save the deliverable; state clearly that Phase 0 baseline exit criteria remain pending.

## Execution status

Source/configuration, offline measuring infrastructure, package launcher and adapter are implemented and verified. Model-dependent micro-evals, real baselines, discriminating dev selection, top-five failure rankings and exact token-category attribution remain blocked/pending. This plan's preparation and bounded unpaid continuation are verified; the phase exit criteria are not met.

## Unpaid continuation

The user requested continuation with the earlier $0 cap and deferred model setup still in effect. This bounded update repairs real offline measurement defects and makes future baseline plans reproducible; it adds no active agent behavior.

1. Read JSONL using LF framing so valid literal Unicode separators inside model/tool strings do not corrupt records; preserve CRLF and held-out protections.
2. Freeze the pinned Harbor registry's Terminal-Bench 2.0 metadata and prospective 18/20 dev/held-out split without fetching benchmark task contents. Require a validated frozen manifest in run plans, record hashes and trial counts, and use Harbor's local registry and exact task-name filters.
3. Preserve run/trial provenance in normalized metrics and reject duplicate result/trial identities before computing scores or spend.
4. Run check, full tests and offline micro-evals, obtain independent review, commit honest effects, and refresh the deliverable. Model runs, runtime feature work, and native Windows/container validation remain pending.

Registry Git revisions freeze task definitions; image digests are still unresolved. The dev subset is prospective until baseline outcomes establish discrimination. Held-out membership must stay fixed while tuning.

## Rulings

- The user's explicit agreement to work autonomously supplies implementation authorization. Extra design-review gates in generic workflow skills do not add a new approval requirement here.
- The initial $0 cap blocked inference. The subsequent $1 cap authorizes bounded calls to the selected Muse model; every run needs a compatible estimate and spend reservation.
- User git identity is unset. A local reproducibility snapshot uses the explicit agent author/committer Apex build agent <apex-build@localhost>; no user identity is inferred and no remote push occurs.

## Authorized model smoke

The user supplied an OpenRouter testing credential, selected Muse Spark 1.3 Contributor exclusively, and then approved a $1 total cap. Exact pinned Pi runtime lookup confirms the model already exists; custom provider/model definitions are unnecessary. A metadata-only key GET authenticated successfully.

Reserve $0.02 for one native stock Pi SDK synthetic four-tool task in a fresh Linux fixture directory. The user selected xhigh thinking. Use the explicit model, at most four requests and 6144 completion tokens per request, a 32768-byte request payload cap plus a conservative 4096-token protocol allowance, no SDK retries or auxiliary model calls, and a 120-second smoke limit. At published input/output rates the uncached upper estimate is $0.0196608. These caps are synthetic micro-test configuration, not Harbor task timeout/resource changes. Save native raw traces with the harness commit, inspect exact files and post-edit verification, and reconcile authoritative OpenRouter generation receipts before releasing the reservation. The filesystem directory is isolated for context, not an OS sandbox.

The test does not establish benchmark pass rate, Windows support, or an Apex feature gain. Harbor still needs a container host; all ten supplied prompts and all later-phase features remain inactive.

The first live run cost $0.000905606 by four provider receipts. It recovered from a read argument error and verified both artifacts, but the four-request ceiling blocked its final reply. Preserve that failed result. A separate run with --max-requests 6 reserves $0.03 (upper catalog estimate $0.0294912); prompt/tools/model remain unchanged. Guard reasons and explicit raw reasoning breakdown are recorded so SDK error wrapping cannot obscure measurement. This is a micro-harness resource limit, never a benchmark timeout/resource change.

The six-request repeat passed at five actual requests. All nine generation receipts reconcile to $0.002482108, leaving $0.997517892 and no unresolved reservation. Raw failed/successful trajectories remain separate; broader micro-evals and Harbor baselines still need work.

## Free continuation

The user's latest instruction is to continue free without paid services. Treat this as zero additional paid execution: preserve the historical $1 cap and receipts, but set paid_runs_enabled=false and execution_policy=offline-only. Do not create cloud accounts, run inference, install a daemon or change system configuration. The existing autonomous Phase 0 agreement covers this bounded infrastructure update.

- [x] Root: test then implement assertPaidRunAuthorized(config, ledger, {runId, maxSpendUsd}) and invoke it before reading a credential, creating a run directory or initializing the SDK for live smoke. Disabled policy, stale/absent reservation, overcommitted budget and a changed model must fail closed; dry-run stays unpaid.
- [x] Preflight worker: add scripts/preflight.mjs plus focused tests, a read-only portable check of Node/Python/Harbor/Docker availability and engine readiness. Keep missing/unverified components visible; no installs, downloads, containers, model calls or environment-value logging.
- [x] Process worker: add scripts/micro-process.mjs and tests/process-micro.test.mjs. A separate native Pi tool host starts its own detached loopback fixture; check survival after host exit and clean up only the owned process. Label this deterministic mechanics evidence, not model behavior; unsupported platforms explicitly skip.
- [x] Root: integrate the process check with the offline gate; capture current local readiness and document a free Windows/WSL path from primary sources. Native Windows and real Harbor remain untested here.
- [x] Root: run check/unit/micro gates and independent review; exact-version and source-pin regressions pass. Gates: 159 unit tests, eight native tools and native process mechanics PASS, local preflight blocked by Docker. New provider spend is $0. Commit and saved delivery record are in the artifact manifest.

## Local Phase 0 closure

The user approved finishing Phase 0 locally after the free-only next-step explanation. Complete the local measuring stick; do not reinterpret this as authorization for priced inference or claim the baseline exit criteria have been met. This bounded extension of the existing eval flow follows the autonomous working agreement; no extra generic workflow approval gate applies.

1. Audit the installed Pi contracts and local container feasibility. No installation, provider/account call, cloud resource, task/verifier access or core patch.
2. Add an inert native-session mechanics microcheck and focused regression tests: forced compaction through an extension-provided deterministic summary; preserved recent context/file bookkeeping; saved session reopened in a fresh process; partial-tail recovery and branch state where the actual source permits them. Use no model transport or fake benchmark result. A throwing network/transport guard records any attempt as failure.
3. Add an end-to-end synthetic pipeline microcheck: raw ingest CLI → normalization CLI → explicitly assembled records → report CLI; hash/provenance consistency, duplicate rejection, and held-out failure CLI refusal before trace read. Fixture statistics are labeled synthetic and are never entered into RESULTS.md benchmark rows.
4. Integrate these checks into npm run micro, capture structured evidence, rerun check/tests/micro and local preflight, and obtain independent review.
5. Write a local closure matrix listing completed infrastructure, pending model-dependent gates, missing engine and unmet phase exit criteria; preserve frozen splits and prior paid traces/spend. Commit the measured offline effect and save a complete source/history/evidence archive.

Planned new interfaces: scripts/micro-session.mjs exports runSessionMicro() returning an offline_session_contract result with provider_calls=0 and explicit mechanics checks; evals/micro/pipeline.py exports run_pipeline_micro(project_root) returning an offline_pipeline_contract result with benchmark_runs=0. Tests belong to tests/session-micro.test.mjs and tests/test_pipeline_micro.py. Root owns evals/micro/run.py integration and documentation. Worker-owned files are disjoint.

Closure verification: steps 1–4 passed; native session gate has six focused regressions and pipeline gate has three. Full gates pass 168 unit tests, eight native tools and process/session/pipeline checks, zero skips. Independent review resolved ambient discovery before completion; fresh SDK restoration is verified with fixed Muse/xhigh and no auth/inference. PHASE0_LOCAL.md and validation/phase0-local.json state local scope complete while baseline exit criteria remain false. Source/evidence/history commit and saved delivery are recorded in the artifact manifest; no additional paid spend occurred.
