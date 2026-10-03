# Apex decisions

No behavior-changing Apex feature is default-on. No pass-rate or cost improvement is claimed.

| Change | Decision | Δpass rate ±95% CI | Δtokens | Δtoken dollars | Δwall time | Evidence |
|---|---|---|---|---|---|---|
| Pinned Pi launcher | Phase 0 control infrastructure; default behavior unchanged | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Offline argv/version checks |
| Harbor source commit pin | Required for reproducibility; same-numbered wheel differs | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Source/wheel audit and inert adapter tests |
| Offline accounting and trace store | Evaluation infrastructure only | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Synthetic usage/dedup/scope/cluster/hash/held-out tests |
| LF JSONL framing and trial identity checks | Repair offline measurement integrity | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Unicode/CRLF and duplicate-trial regressions |
| Frozen dataset registry and splits | Evaluation metadata only; dev selection still prospective | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Immutable Git pins, content hashes and scope tests; no benchmark contents fetched |
| Supplied prompts | Saved, inactive pending matching tools and ablations | Unmeasured | Unmeasured | Unmeasured | Unmeasured | Empty Pi resource manifest |
| Free-only eval policy and reservation guards | Evaluation control only; no active agent behavior | Unmeasured | Unmeasured | $0 additional spend | Unmeasured | Disabled/overcommitted/stale/model-policy guard regressions |
| Local preflight and process microcheck | Deterministic Phase 0 mechanics; no model calls | Unmeasured | Unmeasured | $0 additional spend | Recorded per check | Explicit local probes and real Pi tool-host survival/cleanup tests |
| Native session and end-to-end CLI pipeline gates | Complete local measuring-stick coverage; experimental agent features still inactive | Unmeasured | Unmeasured | $0 additional spend | Fixture timing only | 168 full-suite tests, native compaction/fresh SDK recovery and 24 synthetic pipeline checks |
| Phase 1–4 proposals | Deferred until real baseline/failure evidence | Unmeasured | Unmeasured | Unmeasured | Unmeasured | No Harbor baseline yet |

Every later feature decision must include exact configuration, commit, dev/held-out sample sizes and attempts, paired changes with uncertainty, cache-aware token dollars, wall time, and raw trace references. An interval crossing no change is inconclusive. A default must earn its activation through eval evidence.

Budget history: initial preparation used a $0 cap and no inference. The user now approved a $1 total cap and restricted testing to openrouter/meta/muse-spark-1.3-contributor. MAIN and FAST use that same physical model; plans reject any other selected model. The first synthetic native SDK smoke reserved $0.02 and reconciled at $0.000905606; its artifact verification passed but the four-request ceiling prevented final completion after one corrected read error. The separate six-request repeat passed with five actual requests, costing $0.001576502 from receipts. Total spend is $0.002482108 and remaining budget $0.997517892, with no outstanding reservation; confirmed spend and unresolved reservations are recorded in evals/spend.json. No benchmark gain is claimed.

Live micro evidence is limited to one fixture in two bounded configurations. Both had one corrected read bad-argument call. The cap failure and successful repeat are saved separately; no default behavior change or pass-rate gain follows from these observations. Guard error classification and reported-reasoning accounting repairs passed 20 focused tests plus the full 140-unit/8-native-tool gates.

Latest authorization supersedes that paid cap: continue free, without paid services. evals/config.json now disables paid runs with offline-only policy; historical receipts and unused $0.997517892 stay intact and frozen. No additional provider request, cloud service or paid sandbox is used. MAIN/FAST and xhigh remain unchanged. Local WSL2 plus Ubuntu Docker Engine is a documented prospective route, not a tested host or permission to run priced models.

The subsequent local completion request covers the remaining offline gates. Source review caught DefaultResourceLoader scanning ambient resources before no* filters; the session test substitutes empty discovery on its isolated loader instance, denies resource probes, and tests that fault. This test-only internal dependency is pinned to Pi 0.99.2 and requires re-audit on upgrade. No runtime extension, prompt override, core patch or success-rate gain is introduced. Fresh SDK restore uses explicit Muse/xhigh selection; semantic model resume and authenticated default model restoration are not measured.


## Phase 1: local experiments, no default promotion

The user authorized Phase 1 after local Phase 0 closure. Preserve free-only execution and the selected Muse/xhigh. Build public extensions without core patches; expose each experiment separately and keep all off. Complete local infrastructure, with benchmark acceptance explicitly pending.

| Change | Local evidence | Δpass rate / CI | Δmodel tokens / dollars / wall time | Model runs | Default |
|---|---|---|---|---:|---|
| cache | Stable component hashes, unknown cache counters and mid-run delta regression | unknown | unknown | 0 | off |
| shape | 21 focused regressions; native hook fixture 38,390→6,536 bytes | unknown | unknown | 0 | off |
| mask | Native context projection/reopen; nested/recent/latest-read protection | unknown | unknown | 0 | off |
| compact | Verbatim active state/bookkeeping and offline cancellation | unknown | unknown | 0 | off |
| read/search/edit/patch | 24 real-file native tests; exact hash/queue/atomic failures/caps | unknown | unknown | 0 | off |
| lazy/route | 10 focused tests plus native classifier-disabled loadout and exact model checks | unknown | unknown | 0 | off |
| output | Stable named section and conservative exact-payload cap tests | unknown | unknown | 0 | off |

Each grouped row has individual add/remove variants in evals/phase1-ablations.json. The full local suite passed 272 tests and integrated micro gates; extra spend $0. No performance target is measured.

Review changed two combinations: preserve nested batches during masking, and never shape programmatic nested result inputs before codemode computes. This reduces potential masking eligibility but protects data and verification state. Preserve actual native full-output provenance; unknown structured schemas stay intact. With no openat binding, static symlinks/sibling races are tested but hostile external directory replacement cannot be guaranteed.

Pi's native cwd/project sections and provider delta folding prevent a universal across-task cache-prefix guarantee. Native lazy MCP exposure does not defer connection startup, and codemode models:true would expose paid classifiers; use models:false and register no server. MAIN=FAST and fixed xhigh mean routing is same-model mechanics, not a cheaper-model policy. ctags remains optional with an explicitly approximate fallback; patches support one existing file to retain atomic failure behavior. Broader variants stay pending evidence.

## Phase 2: local harness; promotion withheld

Preserve the user's free-only scope, sole Muse model and xhigh thinking. Native extensions provide the success-rate machinery without a Pi fork. All fourteen flags default off; no model experiment was run.

| Change | Local evidence | Δpass rate / 95% CI | Δtokens / dollars / wall time | Model runs | Default |
| --- | --- | --- | --- | ---: | --- |
| snapshot | Bounded one-time environment observation; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| entrypoints | Identifier/path/symbol entry ranking; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| headless | Static noninteractive mode and environment; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| contract | Guarded automatic and explicit manual acceptance criteria; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| todo | Serialized delta todos and one enforced steer; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| verify | At most two verify-before-finish continuations; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| loops | Bounded same-error/read/ping-pong intervention; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| bg | Owned detached background processes and command timeouts; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| time | Evaluator-budget notes at three thresholds; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| correct | Validated native argument corrections and interactive confirmation; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| diagnostics | Only newly introduced checker diagnostics; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| subagents | Depth-one fresh-context independent helper tools; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| max | Separate isolated multi-attempt configuration; focused/native fixtures | unmeasured | unmeasured | 0 | off |
| recovery | Native bounded retry profile and sticky same-model failed route; focused/native fixtures | unmeasured | unmeasured | 0 | off |

The final suite passes 432 tests with one optional TypeScript skip; 22 native core checks and all prior micro gates pass. Additional spend is $0. These measurements demonstrate local contracts, not solve rate. Independent reviews corrected quoting, process concurrency/key publication, deadline forwarding, helper accounting and per-request policy revocation. Source takes precedence: native settlement permits a gate to append its own message before rechecking continuation; settings overrides belong to launcher/SDK hosts.

Repository copies and installed project diagnostics are explicitly not OS sandboxes. Current max/recovery launch and model-backed helpers remain denied before allocation under frozen policy. Unattributed nested usage is unpriced; incomplete usage cannot become a free total. Keep the early credential-availability lookup, automatic registry-related approval rejection and first root fixture-environment failure in the evidence rather than recasting them as final passing isolation.

## Phase 3: default-off daily-driver package

The user authorized the next local phase under the existing free-only policy. Deliver native extension commands/hooks and deferred assets without changing Pi core or enabling priced inference. All nine flags default off; every flag has an add/remove configuration in evals/phase3-ablations.json. The autonomous agreement overrides generic design/plan/integration handoff menus; keep the dedicated local branch and package it, without remote push or main merge.

| Change | Local evidence | Δpass rate / 95% CI | Δtokens / dollars / wall time | Model runs | Default |
| --- | --- | --- | --- | ---: | --- |
| cost | Native assistant/helper/summary usage, partial/replay/branch regression, TUI status | unmeasured | unmeasured | 0 | off |
| checkpoints | Real shadow Git, dirty/staged/untracked restore, branch IDs, conflicts/rollback/caps | unmeasured | unmeasured | 0 | off |
| review | Independent Phase 2 verify seam; policy before diff/SDK/inference | unmeasured | unmeasured | 0 | off |
| plan | Native command, nested/deferred gate, exact atomic PLAN.md, tool restore and core cooperation | unmeasured | unmeasured | 0 | off |
| remember | Bounded explicit facts, serialized append, native context files, eval-before-I/O denial | unmeasured | unmeasured | 0 | off |
| skills | Ten real static probes, native on-demand discovery/read, mechanical routing | unmeasured | unmeasured | 0 | off |
| safety | Scoped per-call TUI/dashboard-RPC approval/cancel/time bounds; no eval/headless prompts | unmeasured | unmeasured | 0 | off |
| report | Bounded actual native JSONL CLI, unknown/partial/subset/category accounting | unmeasured | unmeasured | 0 | off |
| resume | Exact persisted-session restore and inspection; free-policy/pending/torn refusal | unmeasured | unmeasured | 0 | off |

Independent reviews corrected branch-local checkpoint ID reuse, abandoned-branch undo, scoped flags and duplicate confirmation, boolean eval prompt loss, encoded skill paths, torn-tail subset/task accounting, and FIFO read races. Source-derived regressions distinguish native runtime contracts from mocks. Production probes do not execute project code. Estimates remain labeled, exact token-category attribution remains unavailable, and no local test proves a model-routing or dollar-per-solve gain.

Keep native completed-session restore instead of inventing a pi-durable API. Model-generated planning/review is guarded under free-only policy; offline literal plan save remains useful. Learnings are never loaded/written in explicit eval mode. Safety is UI approval, checkpoints cover regular files with bounded private storage, and neither is a sandbox. All new provider/auth/account/container calls and spend remain zero; the historical paid ledger is unchanged.

Final global verification caught an existing service lease anchored before detached initialization and a heavy-load session child timeout. Keep the failing evidence; add a real delayed-initialization regression and reserve the cleanup lease after readiness attempts. Limit offline unit-file concurrency to two instead of altering micro/Harbor deadlines or denial assertions. These are verification-harness fixes, not a new agent feature or benchmark resource change.

## Phase 4: guarded evolution, no empirical promotion

Use the existing stdlib trace normalization, frozen splits, metrics and budget guard instead of adopting another optimization dependency. A curated version/dev-raw corpus, confined native proposer tools and OCI isolation keep held-out trajectories and host evaluator state outside proposer access. Standard text patches produce private Git candidates, never modify this checkout or change defaults.

One declared proposal per iteration. Accept only when the paired hierarchical bootstrap gives dev lower 95% delta >0 and held-out lower delta >=0; otherwise reject, including uncertainty. Require complete equal repetitions, frozen memberships/checksums and consistent models/protocol. Distinct attempt policies remain separate configurations. Every leaderboard value is aggregate-only, with unknown costs and synthetic provenance preserved.

Known task names/paths, observed dev absolute paths and trusted expected-output literals are banned from patches. This is a lexical guard, not proof against semantic/obfuscated benchmark cheating. Whole-iteration estimates reserve budget before work; unobserved billing cannot release funds. Receipts are caller-reviewed evidence, not automatically authenticated invoices. No automatic failed-stage replay, stale-lock takeover, checkout promotion or provider hard spending cap was added.

Fresh local checks: 49 pass, two privilege skips; 14 real CLI/Git smoke checks; retained bundle export covers 12 actual commits/331 runtime files. Real solve-rate, token/dollar/wall deltas and top benchmark failure classes remain unmeasured; model runs/default promotions remain zero. Broad gates are not passing here because pinned dependencies are missing and earlier platform tests fail. No Pi core edit, dependency installation, remote push, provider request or added spend occurred.

## Latest authorization: remove the Codex cap

The user explicitly authorized unlimited Codex OAuth usage, superseding the earlier $20 testing cap. `evals/codex-budget.json` and final-validation metadata now record null dollar caps; recorded usage stays intact. Dashboard starts and prompts no longer have a dollar spending gate, and the UI reports usage estimates instead of remaining allowance. Provider-side limits, authentication, bounded automated-test scope and the frozen OpenRouter/benchmark policy remain unchanged. No provider request is required for this change.

## Final validation: scoped OAuth testing, no benchmark promotion

Restore pinned dependencies without changing Pi or Harbor core. Reuse the existing planner for the complete two-model/five-attempt matrix; a dependency SHA is not a substitute for this checkout's missing harness source revision. Plans stay metadata-only and cannot launch under the benchmark/API policy.

The user's Sol OAuth testing authorization and subsequent $20 Codex cap are separate from the frozen OpenRouter ledger. Native local access/tool verification passed; catalog equivalents are not subscription invoices. No private credential is packaged, printed or provisioned into a container by the metadata planner.

Windows output recovery uses native protected ACL creation and real pinned handles, not chmod or a fake directory handle. Existing public directories fail closed; the original tool result survives. Constrain native fixture homes/account defaults before SDK discovery; ambient-fault cases request an explicit outside resource so denial does not depend on the user's installed home assets. Remove source-wording/wiring-only assertions; retain real native skill loading, path confinement and consumer behavior checks.

616 tests pass with 45 honest platform/privilege skips. The complete offline report remains BLOCKED/exit2 for missing Unix process proof rather than dropping later native gates or mislabeling the run PASS. No real benchmark outcomes, confidence-bound improvement, cost-per-solve gain or default promotion.

## Windows-only continuation: separate acceptance, not a benchmark waiver

The user selected native Windows for now. Add separate native preflight/check/test/micro commands; do not weaken the full gate or erase prior Windows/Unix failure evidence. Native use needs Node, pinned Pi, Git Bash, rg/fd and the Windows private-storage prerequisite, not Linux/Docker/Harbor. Keep explicit capability skips, with Windows ACL/junction/CRLF and native shell coverage rather than POSIX chmod/shebang substitutes.

An explicit launcher target selects exact Sol OAuth/xhigh for local Windows feature work; the original default/Muse model restriction and benchmark allowlist remain untouched. No feature is default-promoted. The target refuses bg/max/recovery and Muse-specific route/output; auxiliary model-backed features and automatic resume retain offline refusals. Selection does not authenticate OAuth or enforce the $20 cap: a future automated live test must reserve and guard the whole run independently. No paid request or ledger mutation in this continuation.

Use the existing native ACL helper's directory-only operation to create/verify a common private .apex root for checkpoints, new learnings and shaping. Do not chmod existing public directories or create dummy spill files. Bound helper execution and scrub inherited provider credentials. Private snapshot descendants inherit the owner-only root; source ACL restoration and same-user OS isolation are not claimed.

Verify real installation rather than a dependency junction: bootstrap the exact peer tree from the source lock with offline npm ci, install the packed Apex artifact without lifecycle scripts, check installed peer integrity, invoke actual PowerShell/Git Bash shims and run packaged native Bash/shaping. Cached tarballs do not imply cached registry packuments. Windows PowerShell additionally needs PATHEXT to invoke native Node reliably; supply a minimal safe value and retain a real stdout regression. Preserve initial red/blocked evidence alongside passing results.

Finish the Windows milestone in place. Preflight checks the PATH the launcher really inherits for git/rg/fd, not workspace `.tools/bin`; rg/fd live in `%LOCALAPPDATA%\Apex\bin` on the user PATH. Checkpoint Git runs with core.longpaths and relative shadow paths to pass MAX_PATH and Git's `$GIT_DIR` limit; past Git's working-directory ceiling (shadow worktree over 246 characters, project root about 156) it fails closed with `path-too-long` instead of crashing — moving the store would orphan existing checkpoints. Dashboard Sol sessions reuse `--apex-target windows` instead of a second policy, and safety prompts in RPC mode because the dashboard already renders confirm dialogs. The offline package smoke installs only lock entries reachable from the Pi peer and Apex runtime dependencies, so dev-only test tooling cannot block it. Pi's default `system` theme is left upstream: its violet ANSI slot is invisible in the Windows PowerShell 5.1 console palette, and the documented workaround is Pi's `dark` theme rather than Apex rewriting user settings.


The user asked for planning on a stronger model and editing on a cheaper one, specifically Opus 5.5 at high with Sonnet 5.5 at low/medium/high, plus compaction at 300k context tokens. The user then asked for the pair and its thinking levels to be configurable, so `--apex-pair provider/model:level,provider/model[:level]` selects a generic Windows-target virtual model, `apex/pair`; the frozen Muse `apex/auto`/`route` policy and its xhigh restriction are unchanged. It follows Pi's upstream jev-router shape (plan until the first successful edit, then switch once) and adds one rescue switch after three consecutive failed tool calls. The planning level is fixed at launch and the build level is the session thinking level, so Pi's own level control changes the cheaper model live; the virtual model offers exactly the build model's levels. Pi parses extension flags only after loading extensions, so the pair is read from argv and resolved against the offline catalog. The two models may use different logins; the dashboard checks each before sending. A different pair restarts the agent on the same session file, because the virtual model is registered at startup. Pi's cross-model transform turns thinking into text instead of replaying signatures. `autocompact` triggers native manual compaction only at `agent_settled`, because `compact()` aborts first; Pi settings are file-only, and Apex does not rewrite user or project settings. No live request, usage measurement or quality comparison has been made; both features are unmeasured.
