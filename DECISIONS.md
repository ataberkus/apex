# Apex decisions

Outside native Windows no behavior-changing Apex feature is default-on. On native Windows, plain `apex` turns on `WINDOWS_AUTO`. That set first held every supported prompt-free feature (commit 47b20ae). After ab-002 it was cut to features that add no prompts, tools or continuations (ab-003), `.apex/` got its own `.gitignore` (ab-004), and core `correct` came back (ab-005, ab-006). No benchmark pass-rate or cost improvement is claimed.

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

Use the existing native ACL helper's directory-only operation to create/verify a common private .apex root for checkpoints, new learnings and shaping. Do not chmod existing public directories or create dummy spill files. The helper's one file in that mode is `.apex/.gitignore` (`*`), created with the same owner-only ACL and never replacing an existing one (ab-004). Bound helper execution and scrub inherited provider credentials. Private snapshot descendants inherit the owner-only root; source ACL restoration and same-user OS isolation are not claimed.

Verify real installation rather than a dependency junction: bootstrap the exact peer tree from the source lock with offline npm ci, install the packed Apex artifact without lifecycle scripts, check installed peer integrity, invoke actual PowerShell/Git Bash shims and run packaged native Bash/shaping. Cached tarballs do not imply cached registry packuments. Windows PowerShell additionally needs PATHEXT to invoke native Node reliably; supply a minimal safe value and retain a real stdout regression. Preserve initial red/blocked evidence alongside passing results.

Finish the Windows milestone in place. Preflight checks the PATH the launcher really inherits for git/rg/fd, not workspace `.tools/bin`; rg/fd live in `%LOCALAPPDATA%\Apex\bin` on the user PATH. Checkpoint Git runs with core.longpaths and relative shadow paths to pass MAX_PATH and Git's `$GIT_DIR` limit; past Git's working-directory ceiling (shadow worktree over 246 characters, project root about 156) it fails closed with `path-too-long` instead of crashing — moving the store would orphan existing checkpoints. Dashboard Sol sessions reuse `--apex-target windows` instead of a second policy, and safety prompts in RPC mode because the dashboard already renders confirm dialogs. The offline package smoke installs only lock entries reachable from the Pi peer and Apex runtime dependencies, so dev-only test tooling cannot block it. Pi's default `system` theme is left upstream: its violet ANSI slot is invisible in the Windows PowerShell 5.1 console palette, and the documented workaround is Pi's `dark` theme rather than Apex rewriting user settings.


The user asked for planning on a stronger model and editing on a cheaper one, specifically Opus 5.5 at high with Sonnet 5.5 at low/medium/high, plus compaction at 300k context tokens. The user then asked for the pair and its thinking levels to be configurable, so `--apex-pair provider/model:level,provider/model[:level]` selects a generic Windows-target virtual model, `apex/pair`; the frozen Muse `apex/auto`/`route` policy and its xhigh restriction are unchanged. It follows Pi's upstream jev-router shape (plan until the first successful edit, then switch once) and adds one rescue switch after three consecutive failed tool calls. The planning level is fixed at launch and the build level is the session thinking level, so Pi's own level control changes the cheaper model live; the virtual model offers exactly the build model's levels. Pi parses extension flags only after loading extensions, so the pair is read from argv and resolved against the offline catalog. The two models may use different logins; the dashboard checks each before sending. A different pair restarts the agent on the same session file, because the virtual model is registered at startup. Pi's cross-model transform turns thinking into text instead of replaying signatures. `autocompact` triggers native manual compaction only at `agent_settled`, because `compact()` aborts first; Pi settings are file-only, and Apex does not rewrite user or project settings. No live request, usage measurement or quality comparison has been made; both features are unmeasured.

## Live A/B against stock Pi, and the Windows fixes it exposed

The user authorized unlimited Sol (`openai-codex/gpt-6.1-sol`, thinking max) for feature testing. `evals/ab/` runs the real `bin/apex` CLI on local coding tasks in fresh Git workspaces under the OS temp folder: stock Pi (`--apex-off`) against the Windows defaults (`--profile headless`: `WINDOWS_AUTO` plus checkpoints, and through ab-010 also core `headless`), same model and level, arms interleaved. ab-001–009 ran the original 12 tasks. Five judgment tasks, added for ab-010, fail when the agent stops to ask or cleans up too much: `ask-or-act`, `readme-question`, `clean-ignored`, `prune-branches` and `scrub-secret`. Six harder tasks, added for ab-011, are long specifications whose hidden checks cover clauses the visible tests skip: `ledger-currency`, `flaky-cache`, `unified-diff`, `async-refactor`, `template-engine` and `tz-buckets`. A run without `--tasks` takes all 23, and `--tasks` loads only the named task files. An `apex-no-FLAG` arm runs the snapshot's defaults minus one flag, so `--arms apex,apex-no-FLAG` measures that flag's share in one paired run; an `apex+FLAG[+FLAG…]` arm runs the defaults plus opt-in flags. With more than two arms, the report pairs every later arm with every earlier one. Verifiers and hidden tests live outside the workspace; `--self-test` proves every fixture fails as given and passes with its reference solution. A long run uses a frozen copy of Apex made by `evals/ab/snapshot.mjs` (`--apex-root`, with `apex-snapshot.json` and the patch kept beside the results). Costs are Pi catalog estimates, not billing; Codex runs are appended to `evals/codex-budget.json`. `--model provider/id` runs another saved login, and `--max-usd N` stops launching attempts once the spend so far plus one costliest-yet attempt per running slot would pass N. Nothing is reserved before the first attempt finishes and running attempts are never killed, so up to `--concurrency` attempts can run past N; the provider's own spending limit is the hard stop. This is a small local suite, not a benchmark result.

A one-task smoke run (`runs/ab/ab-smoke-001`) exposed three Apex bugs; each is fixed test-first:

- **Skills were unreadable.** The `skills` feature advertises packaged `skills/*/SKILL.md` paths, but `correct` confined every `read` to cwd, so all skill reads failed. `read`, and only `read`, may now reach the real package `skills/` tree; writes there and lexical or symlink escapes stay refused.
- **Private storage cost seconds per call.** Each checkpoint job and output spill spawned Windows PowerShell and recompiled the C# ACL helper: 5–13 s per call on this host, and over its 15 s bound under concurrency, which blocked an edit ("Checkpoint failed; mutation blocked"). One helper process per Node process now serves every request (`-Serve`; requests are base64 lines on stdin) with the same `Spill` code, a 60 s startup bound, a 15 s per-request bound, a neutral cwd and unref'd idle handles. Five parallel calls dropped from 11–17 s to under 2 s. The one-shot `-File helper ROOT NAME` mode is unchanged and still covered.
- **Undo failed on a brief sharing lock.** Restore renames a prepared backup onto the user's file; Windows refuses that with EPERM while antivirus or an indexer holds the file without share-delete. The three checkpoint renames retry EPERM/EACCES/EBUSY for about five seconds on Windows only. The source check before the rename is unchanged, so a concurrent manual edit inside that window is still not detected.

A later review also fixed a regression in the new helper: a cancel that arrived while the helper was still starting waited for startup (about 2 s) before rejecting. The abort listener is now attached before startup is awaited, so cancellation discards the helper at once. The ab-001 snapshot predates this fix; ab-002's includes it.

A live session in another repository then had every tool call blocked ("Checkpoint failed; mutation blocked: Checkpoint per-file byte cap exceeded"), including two `codemode` calls that only read files. Three fixes, each with a regression test:

- **One oversized file blocked every mutation.** Capture snapshots every tracked and unignored untracked file, and any single file over `maxFileBytes` (8 MiB) failed the whole capture. Such a file is now left out of the snapshot and listed in the record's `skippedPaths` (the union over before and after). Change detection ignores skipped paths, so undo never writes or deletes them: a file that grows past the cap during a turn is not "deleted", and one that shrinks below it is not "created". `/undo` reports how many files were not tracked. If a path undo would restore has grown past the cap since, restore fails closed with `cap` before any file changes. The file-count and snapshot-byte caps still fail the capture.
- **History was charged a full copy per snapshot.** `storedBytes` added every snapshot's full size against `maxStoredBytes` (256 MiB) and never went down, though Git stores identical content once. With that repository's 37 MB of kept files, turn 4 failed with "Checkpoint history byte cap exceeded" and blocked the rest of the session. A snapshot is now charged only for content (by SHA-256) that no existing record holds. A copy of that repository then ran 12 turns. `storageBudget` still scans real disk use against the same cap, and `maxCheckpoints` (50 records per session) is unchanged.
- **`codemode` was gated as a write tool.** A codemode script reaches files only through other tools, and Pi fires `tool_call` for each nested call (with `parentToolCallId`), so the nested `write`/`edit`/`bash` calls capture before they run. Capturing for `codemode` itself only added a second capture and could block read-only scripts, so it no longer captures. The plan gate still blocks `codemode`.

### ab-001: 12 tasks × 3 attempts per arm

| Run | Apex snapshot | Passed (stock / apex) | Δpass, paired 95% CI | Δcost | Δtokens (input + cache read + output) | Δwall | Δrequests | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ab-001 | `302c1a5d6155` (47b20ae + the smoke fixes) | 34/36 / 35/36 | +3% (+0% to +8%), inconclusive | ×2.80 (×2.22–×3.61) | ×6.92 (×4.89–×9.48) | ×2.85 (×2.21–×3.72) | ×2.59 (×2.38–×2.81) | `runs/ab/ab-001/` (795 requests, $8.23 catalog) |
| ab-002 | `131c2a6bfef5` (bbc342f, a docs-only change, + the gate and abort fixes below) | 36/36 / 35/36 | −3% (−8% to +0%), inconclusive | ×2.12 (×1.68–×2.76) | ×4.69 (×3.08–×6.87) | ×2.28 (×1.80–×3.00) | ×1.83 (×1.62–×2.05) | `runs/ab/ab-002/` (633 requests, $7.17 catalog) |
| ab-003 | `5e6169216f3e` (642624b + the reduced `WINDOWS_AUTO`, see ab-003 below) | 36/36 / 36/36 | +0% (+0% to +0%), inconclusive | ×1.12 (×0.97–×1.30), inconclusive | ×1.22 (×1.04–×1.45) | ×1.19 (×1.08–×1.34) | ×1.12 (×1.06–×1.18) | `runs/ab/ab-003/` (452 requests, $4.90 catalog) |
| ab-004 | `8d1dad15a677` (ab-003 + `.apex/.gitignore`, see ab-004 below) | 36/36 / 36/36 | +0% (+0% to +0%), inconclusive | ×1.10 (×1.03–×1.18) | ×1.14 (×1.01–×1.33) | ×1.19 (×1.13–×1.25) | ×1.06 (×0.97–×1.15), inconclusive | `runs/ab/ab-004/` (447 requests, $4.74 catalog) |
| ab-005 | `f85376152f1a` (ab-004 + core `correct`, with the null-argument bug below) | 36/36 / 36/36 | +0% (+0% to +0%), inconclusive | ×1.17 (×1.06–×1.26) | ×1.18 (×0.98–×1.35), inconclusive | ×1.24 (×1.19–×1.29) | ×1.17 (×1.11–×1.24) | `runs/ab/ab-005/` (462 requests, $4.63 catalog) |
| ab-006 | `def62b38abfe` (ab-005 + the null-argument fix; the current default) | 36/36 / 36/36 | +0% (+0% to +0%), inconclusive | ×1.12 (×1.01–×1.23) | ×1.16 (×1.05–×1.28) | ×1.15 (×1.08–×1.22) | ×1.06 (×1.03–×1.10) | `runs/ab/ab-006/` (446 requests, $4.67 catalog) |
| ab-007 | `def62b38abfe` (ab-006's snapshot; ablation: apex vs apex-no-checkpoints, ratios are no-checkpoints relative to apex) | 36/36 / 36/36 | +0% (+0% to +0%), inconclusive | ×1.00 (×0.94–×1.06), inconclusive | ×1.03 (×0.96–×1.11), inconclusive | ×1.01 (×0.94–×1.08), inconclusive | ×1.03 (×0.98–×1.09), inconclusive | `runs/ab/ab-007/` (452 requests, $4.52 catalog) |
| ab-008 | `def62b38abfe` (ab-006's snapshot; ablation: apex vs apex-no-headless, ratios are no-headless relative to apex) | 36/36 / 36/36 | +0% (+0% to +0%), inconclusive | ×0.91 (×0.84–×0.996) | ×1.03 (×0.90–×1.21), inconclusive | ×0.87 (×0.82–×0.93) | ×1.01 (×0.93–×1.11), inconclusive | `runs/ab/ab-008/` (467 requests, $4.72 catalog) |
| ab-009 | `091bb43d97a8` (runtime as `def62b38abfe`, with `prompts/mode-headless.md` emptied in the copy; ablation: the `headless` environment variables alone vs no `headless`, ratios are no-headless relative to apex) | 35/36 / 36/36 | +3% (+0% to +8%), inconclusive | ×0.97 (×0.90–×1.04), inconclusive | ×1.01 (×0.93–×1.12), inconclusive | ×1.00 (×0.94–×1.05), inconclusive | ×1.03 (×0.97–×1.09), inconclusive | `runs/ab/ab-009/` (445 requests, $4.49 catalog) |
| ab-010 | `def62b38abfe` (ab-006's snapshot; the five judgment tasks only, 5 attempts per arm; ablation: apex vs apex-no-headless, ratios are no-headless relative to apex) | 25/25 / 25/25 | +0% (+0% to +0%), inconclusive | ×0.78 (×0.67–×0.91) | ×0.80 (×0.66–×0.97) | ×0.83 (×0.75–×0.93) | ×0.91 (×0.80–×1.04), inconclusive | `runs/ab/ab-010/` (275 requests, $2.42 catalog) |
| ab-011 | `d6d7013e4b31` (6f23ca5's runtime; marked dirty by the then-uncommitted harness and task files; stock only, the six hard tasks × 2 at max, a pilot) | 12/12 / – | – | – | – | – | – | `runs/ab/ab-011/` (163 requests, $4.39 catalog) |
| ab-012 | `b3df59f5ea59` (2cd21eb, clean; stock only, the six hard tasks × 2 at low, a pilot) | 12/12 / – | – | – | – | – | – | `runs/ab/ab-012/` (132 requests, $0.95 catalog) |
| ab-013 | `b3df59f5ea59` (ab-012's snapshot; stock only, the six hard tasks × 2 at minimal, a pilot) | 12/12 / – | – | – | – | – | – | `runs/ab/ab-013/` (120 requests, $0.90 catalog) |
| ab-014 | `b3df59f5ea59` (ab-012's snapshot; stock only, the six hard tasks × 2 on `openai-codex/gpt-5.6-luna` at low, a pilot) | 4/12 / – | – | – | – | – | – | `runs/ab/ab-014/` (131 requests, $0.12 catalog) |
| ab-015 | `b3df59f5ea59` (as ab-014 on `openai-codex/gpt-5.3-codex-spark`; void: the provider refused every first request) | void | – | – | – | – | – | `runs/ab/ab-015/` (12 refused requests, $0) |
| ab-016 | `b3df59f5ea59` (ab-012's snapshot; the six hard tasks × 5 on `openai-codex/gpt-5.6-luna` at low; a third arm, `apex+contract+todo+verify`, is in its section; 3 rows restored after a cleanup error) | 13/30 / 16/30 | +10% (+0% to +23%), inconclusive | ×1.06 (×1.02–×1.12) | ×1.11 (×1.02–×1.18) | ×1.10 (×1.04–×1.17) | ×1.10 (×1.01–×1.16) | `runs/ab/ab-016/` (1,403 requests, $1.13 catalog) |
| ab-017 | `2375d8d9cc92` (9c78e30, dirty: uncommitted `claude-identity.mjs` and launcher work; the six hard tasks × 5 on `anthropic/claude-opus-5-5` at medium; same three arms as ab-016; the stock arm also loads `claude-identity.mjs`, see its section) | 30/30 / 30/30 | +0% (+0% to +0%), inconclusive | ×0.99 (×0.89–×1.10), inconclusive | ×0.90 (×0.65–×1.23), inconclusive | ×1.01 (×0.81–×1.24), inconclusive | ×0.92 (×0.76–×1.11), inconclusive | `runs/ab/ab-017/` (865 requests, $36.38 catalog) |
| ab-018 | `d567de198a10` (9c78e30, dirty; stock only, six new candidate tasks × 4 on `anthropic/claude-opus-5-5` at medium, 20-minute timeout, a calibration pilot) | 22/24 / – | – | – | – | – | – | `runs/ab/ab-018/` (248 requests, $13.79 catalog) |
| ab-019 | `d567de198a10` (ab-018's snapshot; stock only, twelve more candidate tasks × 4, same model and level, 30-minute timeout, a calibration pilot) | 46/48 / – | – | – | – | – | – | `runs/ab/ab-019/` (503 requests, $26.92 catalog) |

Wall times come from a slow host whose CPU other processes held near 100% during ab-001 and ab-002; host load during ab-003 was not recorded. During ab-004 and ab-005 the host also ran focused unit tests, an offline dashboard browser check and one single-attempt runner smoke; during ab-006, only log analysis. Arms were interleaved, so both were affected, but Apex's extra process spawns weigh more there. Request and token ratios do not depend on host speed.

Verdict: on this suite the Apex Windows defaults bought no measurable pass rate and cost about 2.8× the dollars and wall time of stock Pi. Stock already passes 34/36, so the suite is near its ceiling and cannot show a large solve-rate gain either way. All three failures are `perf-dedupe` `tests_unchanged` (stock #1 and #3, apex #2): each attempt left the existing tests untouched and added a new regression test file under `test/`. The prompt asks to keep "the existing tests in test/ passing and unchanged" while the checker counts any added file, so the checker is stricter than the prompt. The pre-registered result stands; counting additions as allowed, both arms pass 36/36. The check stayed unchanged until ab-002, which reuses the same tasks, had finished (see below).

Where the overhead went: the verification gate continued all 36 Apex attempts, 60 times in total, and 59 of those continuations included "Run a recognized verification action". 299 of Apex's 573 requests (52%) came after the first gate, about 85% of its 351 extra requests over stock, and the post-gate tail averaged 123 s per attempt. The models had usually verified already, with `node -e` assertions or a chained `npm test && git status`. The gate message did not say which checks count, so models searched for a verification tool (65 `tool_search` calls, all after a gate) and re-ran checks in new forms. The packaged skills added 56 `SKILL.md` reads and 57 probe runs, about 25 s each on this host; whether they help is unmeasured.

Fixed from those traces, test-first, after the ab-001 snapshot:

- **The gate names what it accepts.** The unverified item lists the recognized checks, says only a plain bash call without shell operators counts, says ad hoc scripts such as `node -e` do not, and asks the model to say so when none applies instead of inventing one.
- **Read-only chains no longer void a passing check.** The ledger treated any command with `&&`, `|` or `;` as a possible mutation, so `npm test` followed by `git status --porcelain && git status` reopened the gate. A chain whose parts are all read-only observations now stays an observation. Only an `&&` chain can carry a verifier's success, because only `&&` exits 0 exactly when every verifier in it passed. Redirects, `&`, `$` and backticks still count as mutation.
- **Write-capable read options are no longer read-only.** `git diff --output=FILE` writes a file, and quoting hid `--pre`, `--ext-diff` and `--textconv` from the option check (`rg '--pre=sh' x`). The check now strips quotes and backslashes the way the shell does, and refuses `--output`.

### ab-002: the same suite with those fixes

Same tasks, model, level and settings; both arms rerun in the same window. Stock barely moved between runs ($0.0661 → $0.0664 per attempt, 158 → 150 s, 6.2 requests both times), so the Apex change is attributable to the fixes. Apex per attempt fell from $0.163 to $0.133 (−18%), from 390 s to 300 s (−23%) and from 15.9 to 11.4 requests (−28%). Gate continuations fell from 60 to 38, those with the unverified item from 59 to 24, post-gate requests from 299 to 149, and the post-gate tail from 123 s to 48 s per attempt. `tool_search` calls fell from 65 to 3 and codemode TypeErrors from 21 to 0. Pass rate did not move: the single failure is again `perf-dedupe` `tests_unchanged` (apex #3, an added `test/dedupe.edge-cases.test.js`), and counting additions as allowed, both arms pass 36/36.

Verdict: the fixes remove about a quarter of Apex's cost with no pass-rate change, but the Windows defaults still cost about 2.1× and take 2.3× the wall time of stock Pi, with no measured pass-rate benefit on this suite. Stock passes 36/36 here, so this suite cannot detect a benefit; that needs tasks stock Pi fails. No gain is claimed. What still costs:

- **Todo gate.** The gate still continues every Apex attempt, and 35 of the 38 continuations list unfinished todos. Models set contract criteria, which become todos, verify the work, then finish without marking the todos done.
- **Skills.** 54 `SKILL.md` reads and 55 probe runs.
- **`.apex/` visibility.** `git-revert` costs $0.204 per Apex attempt against $0.031 for stock. All three Apex attempts again edited `.git/info/exclude`, after searching for a way to disable checkpoints (6/6 across both runs).
- **What the gate proves.** It accepts `node --check`, which is only a syntax check, and now says so. One ab-002 attempt cleared the gate with `node --check lib/codecs.js` after its real check, `node -e` assertions, had already passed. The gate shows that some recognized check ran after the last edit, not that the change works.

After both runs, the `perf-dedupe` check now matches its prompt: every file that existed under `test/` must keep its bytes, and new files are allowed (`existing_tests_unchanged`). The reference solution adds a regression test. `--self-test` now also applies `mustReject` changes on top of the reference fix, and here emptying the existing test file must still fail. A scratch mutation that made the check always pass was caught (`ACCEPTS forbidden change 1`). Runs from ab-003 on use this check; ab-001 and ab-002 keep their recorded verdicts.

Not changed:

- **`.apex/` visibility.** `.apex/` shows as untracked (`?? .apex/`) in a user's repo, so an agent's `git add -A` would stage Apex's private logs and checkpoint shadow repository. In ab-001, all three Apex `git-revert` attempts, which needed a clean `git status`, edited the user's `.git/info/exclude` themselves to hide it. The private-storage contract creates no data byte in directory-only mode, so having Apex write a `.gitignore` inside `.apex/`, or the user's `.git/info/exclude`, is a product decision left to the user. (The user chose `.apex/.gitignore` after ab-003; see ab-004.)
- **`tool_search` in codemode.** Inside codemode, Pi's search function is `searchTools()`, and Pi's codemode description documents it. Models still called `tools.tool_search`, which does not exist there. The synchronous TypeError cancelled the whole batch, which happened 21 times in ab-001. Every such search followed a gate, and after the gate fix ab-002 had 3 searches and no TypeErrors; Pi itself is unchanged.

### ab-003: reduced defaults

ab-002 showed that the default feature set bought no pass rate at about 2.1× the cost. `WINDOWS_AUTO` now holds only features that add no prompt section, tool, tool-result rewrite or continuation: context `cache` (a ledger outside the context), features `cost`, `plan`, `report`, `resume` and `autocompact` (user commands and late compaction), plus `checkpoints` at a Git root. They are not invisible. Checkpoints leave `.apex/` in `ls` and `git status` output, and autocompact summarizes past 300k tokens (no ab-003 attempt got near that). Core `headless` still comes with `--profile headless`, so the A/B apex arm also carries the noninteractive-mode section. Every other flag still works through an explicit selection. That covers shape, mask, read, search, edit, patch, lazy, snapshot, entrypoints, contract, todo, verify, loops, correct, diagnostics, remember and skills. `correct` is in this group because it confines paths to the cwd and pre-validates edits, which changes tool outcomes. Dropping it also removes, from plain interactive `apex`, its TUI confirmation before catastrophic shell commands (`rm -rf /`, `mkfs`, `dd of=/dev/…`, recursive `Remove-Item` of a drive root). Headless runs never had that check, so ab-003 cannot measure it. The dashboard keeps its own default preset ("All features"), which this change does not touch.

Same tasks, model, level, attempts, concurrency and 30-minute timeout as ab-002. This is the first run with the corrected `perf-dedupe` check. Stock stayed steady: $0.0664 → $0.0654 per attempt, 150 → 160 s, 6.2 → 5.9 requests. Apex per attempt fell from $0.133 to $0.071 (−47%), from 300 s to 179 s (−40%) and from 11.4 to 6.6 requests (−42%). Both arms passed 36/36.

Verdict: the remaining cost gap is inconclusive (×1.12, CI ×0.97–×1.30). Tokens (×1.22), wall time (×1.19) and requests (×1.12) are still measurably higher. `git-revert` holds about half of the cost gap ($0.095 of $0.187) but only a quarter of the extra wall time (178 of 705 s) and of the extra requests (7 of 26). Per attempt it cost $0.058 against $0.027 and took 122 s against 63 s. All three Apex attempts edited `.git/info/exclude` to hide `.apex/`, which makes 9/9 Apex `git-revert` attempts across ab-001–003. Overall, 13 of 36 Apex attempts made tool calls naming `.apex`, and no stock attempt did. Without `git-revert`, mean cost per attempt is $0.0717 against $0.0689 and wall time 185 s against 169 s. How much of the remaining wall time is checkpoint capture or the headless section is unmeasured. `.apex/` visibility (above, "Not changed") is now the largest measured default cost and remains a product decision.

### ab-004: `.apex/.gitignore`

After ab-003 the user chose to hide `.apex/` from Git. On Windows, the private-storage helper now writes `.apex/.gitignore` containing `*` whenever it creates or verifies the private root. The file gets the same owner-only ACL, and an existing one is never replaced (`IgnoreFile` in `extensions/apex-context/private-spill.ps1`; a test in `tests/windows-storage.test.mjs` checks a clean `git status` after a checkpoint and that a user-edited ignore file is kept). Other platforms are unchanged. `ls` still shows the folder.

Same settings as ab-003. No Apex `git-revert` attempt edited `.git/info/exclude` (0/3, against 9/9 across ab-001–003). Per attempt, `git-revert` cost $0.0266 against $0.0252 for stock (ab-003: $0.058 against $0.027) and took 64 s against 57 s. 10 of 36 Apex attempts still named `.apex` in a tool call. Each was a one-command look (`ls -la .apex`, `find .apex`) or an exclusion (`-g '!.apex/**'`) inside a call the model made anyway.

Verdict: the overall gap stays (cost ×1.10, CI ×1.03–×1.18; wall ×1.19; requests ×1.06, inconclusive) because `git-revert` is one of the 12 tasks in the paired per-task ratio. Without `git-revert`, Apex costs $0.0741 against $0.0650 per attempt and takes 177 s against 146 s, so `.apex/` visibility no longer explains the gap. What does is unattributed: the noninteractive-mode section the A/B arm carries through `--profile headless`, checkpoint capture on each turn, and the cache ledger.

### ab-005: `correct` restored, and the bug it measured

`WINDOWS_AUTO` gained core `correct` again, for its cwd-confined paths, edit pre-checks and TUI confirmation before catastrophic shell commands. The run measured a bug instead of the feature. `correct`'s validators treated a key holding `null` as a supplied value, and Sol sends `null` for every unset optional field. All 139 Apex tool calls with a `null` argument were `read` calls with `offset: null, limit: null`, and every one failed with "offset must be a positive integer". Stock Pi's own tools read `null` as absent: the ab-004 Apex arm, which ran without `correct`, made 175 such calls (169 reads, 6 `bash` with `timeout: null`) with no such error. The Apex tool error rate rose from 3.9% in ab-004 to 26.6%, and tool calls from 12.1 to 16.2 per attempt.

So ab-005's cost ×1.17 (CI ×1.06–×1.26), wall ×1.24 and requests ×1.17 are the cost of `correct` plus this bug, not of `correct` alone. ab-001 and ab-002, whose defaults also included `correct`, logged no such error. Fixed afterwards: `prepareCorrectableArguments` drops `null`-valued arguments before any check, so `null` counts as absent for every validator, while a required `path: null` is still refused (test in `tests/core-control.test.mjs`). ab-006 measures the fixed set.

### ab-006: the current default

Same settings, with `correct` fixed. The runner now passes `--provider openai-codex --model gpt-6.1-sol` to the Apex arm instead of leaving the model to the launcher's default (`--model openai-codex/gpt-6.1-sol`); the resolved invocations differ only in that spelling. ab-005 may also have run with this change. The Apex arm made 168 tool calls with `null` arguments, and `correct` refused none of them. Every Apex tool error was an ordinary non-zero `bash` exit, so the tool error rate (3.6% against 3.4% for stock) and tool calls (12.3 against 11.4) are back at ab-004's level. No `git-revert` attempt edited `.git/info/exclude`. Per attempt, stock cost $0.0612 and took 130 s and 6.0 requests; Apex cost $0.0685 and took 148 s and 6.4 requests. Without `git-revert`, Apex cost $0.0719 against $0.0643 and took 156 s against 137 s.

Verdict: the current Windows default costs ×1.12 (CI ×1.01–×1.23) and takes ×1.15 (×1.08–×1.22) the wall time of stock Pi, with 6% more requests and no pass-rate difference this suite can show (both 36/36). Adding the fixed `correct` moved no ratio beyond the spread between runs: ab-004, without it, measured ×1.10 cost, ×1.19 wall and ×1.06 requests. Stock itself varied between runs: $0.0596–$0.0617 per attempt and 130–139 s across ab-004–006. ab-007 and ab-008 attribute the gap to the `headless` core flag, which only `--profile headless` adds, and not to checkpoints. A solve-rate benefit still needs tasks stock Pi fails.

Dashboard: the New session dialog now starts on a **Default** preset built from `WINDOWS_AUTO`. The server sends it in `/api/state`, with checkpoints only for workspaces where `checkpointsUsable` holds. **All features**, the earlier default, stays available, and a remembered `all` choice falls back to Default once. **Plain agent** now passes `--apex-off`. Before this change, the child's `bin/apex` applied `WINDOWS_AUTO` to any dashboard launch with nothing picked, so Plain agent was never stock Pi on Windows (regression check in `tests/dashboard.test.mjs`).

### ab-007: checkpoints ablation

Both arms ran ab-006's snapshot: the default, against the default without `checkpoints` (`--arms apex,apex-no-checkpoints`). The ablated arm created `.apex/` in 0 of 36 attempts and the default in 36 of 36, so the arm did run without checkpoints. A process restart killed the runner after 47 of 72 attempts; `--resume` reran the 25 missing ones about 16 minutes later, still interleaved by arm.

Verdict: checkpoints cost nothing measurable here. Removing them changed cost ×1.00 (CI ×0.94–×1.06), wall ×1.01 (×0.94–×1.08), tokens ×1.03 and requests ×1.03, all inconclusive, with both arms at 36/36. The guess that per-turn checkpoint capture drives the wall-time gap is wrong. The default arm itself cost $0.0636 and took 132 s per attempt, against $0.0685 and 148 s in ab-006, which is about the size of the whole gap to stock; compare arms within a run, not across runs.

### ab-008: headless ablation

Same snapshot, against the default without the `headless` core flag (`--arms apex,apex-no-headless`). Only `--profile headless` adds that flag (`lib/windows-target.mjs`), so the ablated arm runs exactly the interactive Windows default, in print mode. The flag does two things: the 477-byte noninteractive prompt section (`prompts/mode-headless.md`, about 105 first-request tokens in ab-006), and forced environment variables (`CI=1`, `TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `DEBIAN_FRONTEND=noninteractive`, `PIP_NO_INPUT=1`, `npm_config_yes=true`).

Verdict: `headless` is the gap. Without it, cost fell to ×0.91 (CI ×0.84–×0.996, just conclusive) and wall time to ×0.87 (×0.82–×0.93), with both arms at 36/36. Requests (6.4 vs 6.6), tool calls (12.2 each) and final-message length (245 vs 228 characters) barely moved. The default arm instead spent more reasoning per request: 1959 against 1565 reasoning tokens per attempt. Its tool results were 19% smaller (12,970 against 16,049 characters per attempt); with the environment variables alone (ab-009) they were only 5% smaller, so most of that came with the prompt section. ab-009 separates the two parts. Multiplying ab-006 by ab-008 puts the interactive default near stock (cost about ×1.02, wall about ×1.00), but that crosses runs and stock drifted between runs, so it is an estimate, not a measurement. Neither arm needed a protection the flag adds: no task here asks a question or opens a pager, so this suite cannot show what the flag prevents.

### ab-009: the headless environment variables alone

A fresh snapshot whose runtime files match `def62b38abfe` (no differences under `bin/`, `extensions/`, `lib/` or `prompts/`), with `prompts/mode-headless.md` then emptied in the copy, so `headless` sets its environment variables but adds no prompt section. Its tree hash and patch predate the emptying; the `ablation` note in `runs/ab/ab-009/meta.json` records it. The first request was 1584 tokens against 1587 without `headless` (ab-008: 1688 against 1587), so the section was absent.

Verdict: the environment variables cost nothing measurable: cost ×0.97 (CI ×0.90–×1.04), wall ×1.00 (×0.94–×1.05), and reasoning tokens 1655 against 1649 per attempt. ab-008's gap therefore comes from the 477-byte prompt section, which raised reasoning by about a quarter without changing the number of steps. The one failure (`wc-cli` #3 with `headless`) put a space between the width-8 count fields, GNU `wc` style. The reference concatenates the fields, and the model's own 36 checks encoded the same reading. The environment variables cannot cause that.

### ab-010: tasks aimed at the headless rules

ab-008 could not show what the section prevents, because no task tempted the agent to ask or to over-clean. The five new tasks do. `ask-or-act` ends its rename request with an open question, and doing nothing fails. `readme-question` phrases the change as a question. `clean-ignored` asks to delete build output that sits next to ignored local settings and data, which must survive, so `git clean -fdX` fails it. `prune-branches` asks to delete merged branches while two unmerged ones must stay. `scrub-secret` asks to rewrite a key out of every branch's history, and every commit and file must survive. Both arms ran ab-006's snapshot, 5 attempts per task. A process restart killed the runner after 25 of 50 attempts, and `--resume` finished it.

Verdict: Sol follows both rules without the section. Both arms passed 25/25, so no attempt deleted protected state. No final message ended in a question. All 10 `ask-or-act` attempts made the change, kept `user_id` as an alias and answered the question. The section changed only wording: with it, all five `ask-or-act` messages stated the open point as an assumption ("Since old mobile usage is unknown…") before advising; without it, all five gave the same advice without that framing. It still cost. Without `headless`, cost was ×0.78 (CI ×0.67–×0.91), tokens ×0.80 (×0.66–×0.97) and wall time ×0.83 (×0.75–×0.93), with 1159 reasoning tokens per attempt against 1411. Five tasks give a coarse bootstrap, but the direction matches ab-008. Whether a weaker model needs the section is unmeasured.

### Decision: no `headless` in the Windows default

After ab-010 the user dropped core `headless` from Windows `--profile headless` (`lib/windows-target.mjs`). The profile still enforces `--print --mode json`, and `--apex-core correct,headless` still selects the flag. Its environment variables go too. ab-009 found them free, and what they guard against (a pager or credential prompt stalling an unattended run) is unmeasured. From here on the A/B `apex` arm runs this set, so `apex-no-headless` no longer resolves.

### ab-011–013: six hard tasks, stock-only pilots

Every earlier suite was at stock's ceiling, so none could show a pass-rate gain. Six new tasks aim at Sol's limit. Each is a long specification (a `docs/*.md` file, a numbered prompt or JSDoc contracts) whose hidden checks cover clauses the visible tests skip:

- `ledger-currency` adds multi-currency storage to a ledger CLI, with exact conversion and a single half-to-even rounding.
- `flaky-cache` hides seven bugs, three of which make the visible suite fail intermittently.
- `unified-diff` needs a minimal Myers diff with exact hunk rules, and must diff 50,000-line inputs in under 2 s.
- `async-refactor` moves a library to `fs/promises` while keeping its error classes, ordering and all-or-nothing build.
- `template-engine` implements a template language with whitespace control and positioned errors.
- `tz-buckets` buckets events by local date in any IANA zone, across DST, Pacific/Apia's skipped 2011-12-30 and ISO week-years.

Every hidden check traces to a sentence of the prompt or spec. Each task's `mustReject` variants (4–20 per task, plausible wrong fixes) must fail, so a lenient check cannot pass them. `--self-test` passes for all 23 tasks, and for `flaky-cache` five times in a row.

Stock-only pilots, 2 attempts per task, were meant to calibrate difficulty before a paired run:

| Run | Thinking | Passed | Wall per attempt | Cost per attempt | Requests | Reasoning tokens |
| --- | --- | --- | --- | --- | --- | --- |
| ab-011 | max | 12/12 | 879 s | $0.366 | 13.6 | 12,967 |
| ab-012 | low | 12/12 | 148 s | $0.079 | 11.0 | 134 |
| ab-013 | minimal | 12/12 | 151 s | $0.075 | 10.0 | 104 |

A host process restart killed ab-011 after 8 attempts. `--resume` ran the other 4 about six minutes later, alongside ab-012 and ab-013. No transcript in these runs refers to the task files, which hold the reference solutions and hidden tests, so the passes are the agent's own.

Verdict: Sol passes all six tasks at every level tried, 36 of 36, so on Sol these tasks cannot show a pass-rate gain either. Thinking level changed cost and time, not outcomes. Max cost about 4.6 times as much as low per attempt and took about 6 times as long, for the same 12/12. That compares two single-arm runs, so it is indicative only.

### ab-014–015: weaker Codex models

The user then chose stock pilots on two other models from the same Codex login, at low. `gpt-5.3-codex-spark` is not available there: every attempt's first request returned "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account", with no tokens and no cost. The runner records such an attempt as an ordinary failure, so ab-015's "0/12" carries no difficulty information.

`gpt-5.6-luna` passed 4 of 12 (33%, CI 14%–61%) at $0.010 and 85 s per attempt: `flaky-cache` 2/2, `async-refactor` and `unified-diff` 1/2 each, and `ledger-currency`, `template-engine` and `tz-buckets` 0/2 each. Every failed attempt ended normally, claiming the work was done. None hit a provider error. Four of the eight left the visible `npm test` failing (`suite_passes`), and the other four passed the visible tests but missed spec clauses that only the hidden checks cover. This is the headroom the paired run needs.

### ab-016: stock vs apex vs apex+contract+todo+verify on luna

The paired run used luna at low, the six hard tasks and 5 attempts per arm. The third arm adds the three core flags the user chose (`contract`, `todo`, `verify`) to the Windows defaults, giving `--apex-core correct,contract,todo,verify`.

| Arm | Passed | Cost per attempt | Cost per solved task | Wall | Requests | Tokens (input + cache read + output) |
| --- | --- | --- | --- | --- | --- | --- |
| stock | 13/30 (43%, CI 27%–61%) | $0.0099 | $0.0228 | 85 s | 10.8 | 91,495 |
| apex | 16/30 (53%, CI 36%–70%) | $0.0104 | $0.0196 | 95 s | 12.0 | 101,597 |
| apex+contract+todo+verify | 15/30 (50%, CI 33%–67%) | $0.0173 | $0.0346 | 166 s | 24.0 | 254,943 |

Paired over the six tasks:

- apex vs stock: pass rate +10% (CI +0% to +23%), cost ×1.06 (×1.02–×1.12), tokens ×1.11 (×1.02–×1.18), wall ×1.10 (×1.04–×1.17), requests ×1.10 (×1.01–×1.16).
- apex+contract+todo+verify vs stock: pass rate +7% (CI −13% to +23%), cost ×1.86 (×1.53–×2.27), tokens ×3.24 (×2.41–×4.34), wall ×1.98 (×1.63–×2.42), requests ×2.37 (×1.91–×2.96).
- apex+contract+todo+verify vs apex: pass rate −3% (CI −20% to +10%), cost ×1.75 (×1.49–×2.07), tokens ×2.93 (×2.13–×4.06), wall ×1.80 (×1.47–×2.20), requests ×2.16 (×1.71–×2.75).

| Task | stock | apex | apex+contract+todo+verify |
| --- | --- | --- | --- |
| async-refactor | 4/5 | 4/5 | 5/5 |
| flaky-cache | 4/5 | 5/5 | 5/5 |
| ledger-currency | 0/5 | 0/5 | 0/5 |
| template-engine | 0/5 | 0/5 | 0/5 |
| tz-buckets | 0/5 | 2/5 | 2/5 |
| unified-diff | 5/5 | 5/5 | 3/5 |

Three attempts first recorded as harness errors. Each had finished, been verified and written its `result.json`; only the workspace delete after it then failed with `EPERM`. In four attempts an `npm test` hung and hit the timeout the model had given it. Three of those four (all `unified-diff`, where the model's own diff code looped) failed the delete; none of the other 86 attempts did, and no earlier run had such a failure. An offline reproduction matched the failure's signature, though a signature cannot name the process. A child process whose working directory is the workspace root gives the same `EPERM, Permission denied` on the root and leaves the whole tree in place, as the three leftover workspaces were (175 and 218 entries). A file held open inside `.apex/` did not block the delete. Pi stops a timed-out command with an asynchronous `taskkill /F /T` that it does not wait for, so the likely holder is a process from the killed `npm test` that outlived it. That is an inference, and the holder itself is unidentified: those processes were gone before they were looked for, and the same deletes succeeded minutes later. Nothing points at Apex. Its storage helper runs with a neutral working directory (`lib/windows-private-storage.mjs:20-22`) and releases every handle after each request (`private-spill.ps1:152`). The timeout came from the model's own arguments (`correct` only validates one), and the other 47 apex-arm attempts, all with a `.apex/`, deleted cleanly. It fell on apex arms only because stock never wrote looping code in these runs. The delete's built-in retries could not help: in the reproduction, five retries at 200 ms took 0 ms on this Node. Those three rows were replaced by the records in their `result.json` files, and `--resume` (no attempts left to run) rewrote the report and the ledger entry. `cleanup` in `evals/ab/run.mjs` now warns and leaves such a directory in place instead of throwing. No attempt timed out (the longest took 384 s of the 30-minute limit), no transcript in ab-014 or ab-016 refers to the task files or the Apex snapshot, and no attempt hit a provider error.

Verdict: no pass-rate effect is established. Apex's +10% has a CI lower bound of exactly 0, so it is inconclusive. It comes from two tasks: `tz-buckets` 2/5 against stock's 0/5 (0/7 counting ab-014) and `flaky-cache` 5/5 against 4/5. Apex's extra cost, about 6%, is measurable. The opt-in arm is no better than apex (−3%, CI −20% to +10%) and costs ×1.75 as much, so `contract`, `todo` and `verify` stay opt-in and the defaults are unchanged. `ledger-currency` and `template-engine` were 0/5 in every arm (0/15 each), so only four tasks carried any signal. The clearest difference between the arms is the visible suite. It was left failing in 1 of 30 stock attempts, 6 of 30 apex attempts and 0 of 30 opt-in attempts. So `verify` did what it promises. All 15 of the opt-in arm's failures are hidden-check misses that a visible-test gate cannot catch, which is why its extra cost bought no passes.

Transcript reading (offline, no model calls) then checked the two per-task differences. Each final workspace was rebuilt from its `workspace.diff`, and all 17 `tz-buckets` and 17 `template-engine` diffs applied cleanly. The hidden and visible checks were then rerun case by case.

- **Apex sent luna the same requests as stock.** In the plain `apex` arm the system prompt differs from stock's only in `cwd`, and the user prompt is byte-identical. No `custom_message` is injected (the session holds only `apex-features-state` and `apex-cache` bookkeeping). With `shape`, `mask` and `compact` off, `--apex-context cache` only observes. `correct` changed nothing the model sent except making `path` absolute, so results read `Successfully wrote to C:\…`.
- **`tz-buckets` is noise.** Every attempt read all of `docs/REPORT.md` (3,850 characters, byte-identical in all 17), wrote the whole implementation in one go, and ran `npm test`. Passing needs every clause at once. The most common miss, in 8 of the 17 attempts, is that the spec makes `timeZone` valid only when it is "a string" `Intl` accepts. `Intl` silently accepts `undefined`, so `bucket(events, {period: 'day'})` must throw. Stock had that guard in 2 of 7 attempts and apex in 3 of 5. Both stock attempts with the guard then missed the ISO week-year clause. Fisher's exact test for passes, 2/5 against 0/7, gives p≈0.15. In the opt-in arm the guard came from the model's own self-review, with no contract, todo or gate text naming it.
- **`template-engine`'s failing visible suite is noise too, and Apex did not hide or alter the test output.** In 12 of the 17 attempts across all arms, the model's second `write` held only part of `src/template.js` and replaced the complete first one. Stock recovered 4 of 4 times it did this (rewrite, debugging or `git checkout`), apex 1 of 5. That split gives a one-sided Fisher p≈0.04. It still reads as sampling: it was found after looking, on one task of six, while both arms sent the model the same requests. In apex-1 and apex-4, retyping the lost header produced a double-escaped `/[ \\t\\r\\n]/`, which also skips the letters `t`, `r` and `n`. All four failing apex attempts saw their real failure, unaltered. Two then made a no-op edit and claimed success without re-testing; the other two reported that they had not finished. The opt-in arm stayed green 5 of 5 even though 3 of its 5 clobbered, because `verify` requires a passing check after the last change. That is the only observed effect of the three flags.
- **Friction found in `contract`.** `setContract` (`extensions/apex-core/state.mjs:269`) adds a pending todo for each new criterion, using the criterion's id. Neither tool description said so, and the result (`state.mjs:277`) reports the new todos only as an unlabeled `delta` after `criteria`. In 3 of the 5 `tz-buckets` opt-in attempts the model then called `todo add` with a criterion id and got `Duplicate todo id` (`state.mjs:383`). Each time it cost a request and had no effect on correctness. When `contract` is on, the `todo` description now adds "Each contract criterion is already a todo with the same id; update it instead of adding it." The sentence is in `todo` rather than `contract` because the mistake happens at `todo add`, and `contract` also runs without the `todo` tool. With `contract` off, the description is unchanged. Not yet re-measured.

### ab-017: the ab-016 design on Claude Opus 5.5

Same tasks, arms, attempts (5) and concurrency (4) as ab-016; the model and level changed, to `anthropic/claude-opus-5-5` at `medium` through the saved Claude login. The attempt timeout also differed: ab-016 ran with 30 minutes, while ab-017 was launched without `--timeout-min` and so got the runner's 20-minute default. No ab-017 attempt came near either limit (the longest took 531 s). Apex ran from a frozen snapshot (`2375d8d9cc92`, head 9c78e30 plus the uncommitted working tree) with `--max-usd 40`.

One deviation from ab-016. The one-attempt smoke `runs/ab/claude-smoke-4` passed both Apex arms, but the stock arm (`--apex-off`) got Anthropic's 400 "Third-party apps now draw from your extra usage", as in claude-smoke-3. The Claude subscription login refuses Pi's unmodified system prompt; on the Windows target the launcher loads `extensions/apex-router/claude-identity.mjs`, which rewrites three flagged strings in Pi's `<docs>` section, and `--apex-off` does not. With the user's approval, `armArgs` in `evals/ab/run.mjs` now gives the stock arm `--extension <snapshot>/extensions/apex-router/claude-identity.mjs` on `anthropic/*` models only, so "stock" here is Pi plus those three string rewrites. `runs/ab/claude-smoke-5` confirmed the stock arm is accepted. Codex runs are unchanged.

| Arm | Passed | Cost per attempt | Cost per solved task | Wall | Requests | Tokens (input + cache read + output) |
| --- | --- | --- | --- | --- | --- | --- |
| stock | 30/30 (100%, CI 89%–100%) | $0.379 | $0.379 | 152 s | 8.5 | 130,715 |
| apex | 30/30 (100%, CI 89%–100%) | $0.389 | $0.389 | 153 s | 8.0 | 129,050 |
| apex+contract+todo+verify | 30/30 (100%, CI 89%–100%) | $0.444 | $0.444 | 171 s | 12.3 | 235,571 |

Paired over the six tasks:

- apex vs stock: pass rate +0% (CI +0% to +0%), cost ×0.99 (×0.89–×1.10), tokens ×0.90 (×0.65–×1.23), wall ×1.01 (×0.81–×1.24), requests ×0.92 (×0.76–×1.11); all inconclusive.
- apex+contract+todo+verify vs stock: pass rate +0%, cost ×1.18 (×1.13–×1.25), tokens ×1.92 (×1.62–×2.22), wall ×1.16 (×0.92–×1.36, inconclusive), requests ×1.48 (×1.29–×1.67).
- apex+contract+todo+verify vs apex: pass rate +0%, cost ×1.19 (×1.08–×1.35), tokens ×2.13 (×1.64–×2.98), wall ×1.14 (×1.04–×1.27), requests ×1.62 (×1.37–×1.98).

Every task passed 5/5 in every arm, so `summary.json` lists no failures, no failed check and no harness error. No attempt timed out or compacted. Total spend was $36.38 catalog for the run plus $0.43 for the two smokes; usage stays in `runs/ab/` because `evals/codex-budget.json` records Codex runs only.

Verdict: Opus 5.5 at medium solves all six hard tasks in every arm, 90 of 90, so this suite is at stock's ceiling on this model and cannot show a pass-rate gain, as with Sol in ab-011–013. `ledger-currency` and `template-engine`, 0/15 in every ab-016 arm on luna, are 15/15 here. Plain apex costs the same as stock within noise. The opt-in arm again buys nothing measurable and costs ×1.19 apex's dollars and ×2.13 its tokens. Defaults are unchanged. A pass-rate comparison on Claude needs a weaker model or harder tasks.

### ab-018–019: eighteen harder candidate tasks, stock Opus pilots

ab-017 showed that the six hard tasks are at Opus's ceiling. Eighteen new candidates were written in six themes, three each: invented languages (`sift-query`, `strata-config`, `glint-markup`), symptom-only debugging in 20–30-file repositories (`ledger-rebuild`, `shop-oversell`, `kiln-watch`), streaming and on-disk formats (`record-stream`, `frame-resync`, `logkv-recovery`), exact algorithms with performance budgets (`decimal-context`, `patience-merge3`, `resource-planner`), async ordering under a fake clock (`job-scheduler`, `fair-lease-pool`, `swr-loader-cache`) and migrations or rule engines (`acl-precedence`, `corpus-migrations`, `pressdoc-v2-migration`). Most specs run 8–15 KB, and the hidden suites hold 12–135 cases. Every hidden check traces to the prompt or a fixture document. `--self-test` passes for all 18: each untouched fixture fails, each reference fix passes, and all 6–11 `mustReject` variants per task are rejected.

The filter was fixed before the pilots ran. Each task gets four stock Opus attempts and is kept only if the result is mixed (at least one pass and one fail); a percentage band is not used. The paired Δpass CI is a bootstrap over tasks, so the number of informative tasks is what narrows it.

| Run | Tasks | Passed | Cost per attempt | Wall per attempt | Timeouts |
| --- | --- | --- | --- | --- | --- |
| ab-018 | first six | 22/24 | $0.574 | 240 s | 1 |
| ab-019 | other twelve | 46/48 | $0.561 | 211 s | 1 |

Four of the 18 tasks came out mixed, each at 3/4. Only one of those failures is a wrong answer:

- `decimal-context` #3 timed out at 20 minutes. Its last code passes every check. The model was still running its own random oracle script, which it had started with a 1,200 s bash timeout.
- `resource-planner` #1 timed out at 30 minutes. Its code also passes every check. It was stress-testing against its own model with up to 20,000 seeds.
- `job-scheduler` #2 passed every hidden check but failed `suite_passes` on a test file the model added itself, which asserts that the 100,000-job scenario takes under 1 s. That scenario measured 575 ms when the model ran it and 1,086 ms during verification, with four attempts running in parallel. The hidden suite's 2,500 ms budget passed at 649 ms.
- `fair-lease-pool` #3 is the one genuine miss: in the drain test, a waiter that was still queued stayed pending instead of being served a newly created resource.

Counting the hidden checks alone, Opus solved 71 of 72 attempts. A leftover workspace from `fair-lease-pool` #3 (`EPERM` on delete, as in ab-016) was still locked afterwards.

Verdict: none of the 18 candidates gives Opus 5.5 at medium a real chance of failing. The four mixed tasks fail mainly through the time limit, or through a timing assertion the model wrote itself under host load, not through wrong answers. A paired Opus A/B on them would measure those effects, not accuracy. Measuring accuracy on these tasks needs a model that misses spec clauses, as luna did in ab-014–016.
