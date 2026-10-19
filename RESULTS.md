# Apex results

Latest native verification is **Windows milestone completion (2026-10-19, Claude Opus 5.5)** at the end; earlier sections, including the Sol-era Windows results, are kept as history. **Final validation readiness** retains the prior broader-scope evidence. Local Phase 0 measuring-stick work and Phase 4 engineering have evidence, but full baseline exit criteria and Apex's definition of done remain pending. OpenRouter spending stays frozen. Codex OAuth usage history is in `evals/codex-budget.json` (its earlier $20 cap was removed; no Apex limit); the 2026-10-19 Claude acceptance runs are in `evals/claude-budget.json` under a $10 cap. No benchmark performance gain is claimed.

## Codex OAuth: unlimited Apex usage

The latest user authorization removes the Codex dollar cap rather than raising it. `evals/codex-budget.json` records `spending_policy: unlimited` and null cap/remaining allowance; previous measured costs are unchanged. Dashboard start/send gates are removed, and usage estimates remain visible. OpenRouter and benchmark restrictions remain unchanged; provider-side limits still apply.

Focused offline verification: **45 Node + 25 Python checks pass**. The dashboard regression starts and prompts a fixture session above the former cap while checking persisted usage; browser-script rendering shows usage without a finite allowance. No real provider request was made. Restart an already-running dashboard to load the change.

The following table is historical Phase 0 evidence, not the latest final-validation run.

| Validation | Result |
|---|---|
| npm run check | Passed: syntax, JSON, Pi/Harbor pins and price registry |
| npm test | 7 launcher + 25 provider-guard + 9 preflight + 4 process + 6 session + 117 Python tests passed (168 total, zero skips) |
| npm run micro | 8 real Pi tools, native service mechanics, native compaction/session restore and synthetic analysis pipeline passed |
| Local closure | Complete for offline infrastructure; full Phase 0 exit criteria false (validation/phase0-local.json) |
| Prior local tarball install smoke | Passed in an isolated Linux npm prefix; native Windows untested |
| Frozen dataset metadata | 89 Terminal-Bench 2.0 Git revisions; 18 prospective dev / 20 fixed held-out / 51 remainder; no task contents fetched |
| Git newline checkout smoke | core.autocrlf=true preserves and validates frozen metadata bytes |
| Paid model requests | 9, only the selected Muse model at xhigh |
| Benchmark trials | 0 |
| Confirmed model spend | $0.002482108 from all nine OpenRouter generation receipts |
| Historical unused / reserved | $0.997517892 / $0 within the earlier $1 cap; unused budget frozen |
| Free continuation spend / provider requests | $0 / 0 |

## Live synthetic model smoke

Pinned Pi 0.99.2's native SDK ran read/edit/write/bash in a fresh Linux fixture. No Apex prompts or features were active. Resource discovery, retries, automatic compaction and cache warming were disabled to bound auxiliary calls; this is a micro-test configuration, not the full stock-Pi Harbor baseline. Each payload used the exact model and xhigh; all receipts identify its official canonical dated slug.

| Run / request ceiling | Strict result | Actual requests | Uncached input | Cache-read | Cache-write | Output including thinking | Thinking | Wall seconds | Receipt dollars |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| muse-smoke-001 / 4 | FAIL: final reply blocked | 4 | 7,175 | 2,628 | 0 | 960 | 382 | 58.063 | $0.000905606 |
| muse-smoke-002 / 6 | PASS | 5 | 13,251 | 565 | 0 | 1,331 | 660 | 55.979 | $0.001576502 |

Both runs made and verified the exact requested files. Each initially supplied string null values for read's optional numeric arguments, then corrected them. The first run's extra turn consumed its ceiling before the final reply; its failed strict verdict and original trace/summary remain unchanged. The separate repeat changed only the request ceiling and its reservation, then verified and finished normally. No model, tool schema or prompt change was made. Fresh-shell checks after agent exit confirmed both fixtures, and raw event/session JSONL parses successfully.

Raw traces, provenance, receipts and separate analysis are under runs/model-smoke/<run-id>/. Requested model: openrouter/meta/muse-spark-1.3-contributor. Receipt model: meta/muse-spark-1.3-contributor-20260902. Thinking is a subset of output, never an extra billed token category. The first raw summary predates improved guard-reason/completion accounting; analysis.json records its cap failure and receipt reasoning count without rewriting the original.

These two configurations on one synthetic fixture are not a population pass-rate estimate, a benchmark comparison or evidence for enabling a feature. Read's repeated argument error is a candidate for later investigation; benchmark failure rankings still require dev trajectories. Per-model grep/find/ls, todo compliance, forced-compaction survival, model-directed service survival and skill routing remain pending.

## Free continuation

Both paid smoke execution and budget planning now honor offline-only policy. Live smoke refuses before credential lookup, SDK initialization or run-directory creation. Enabling a future paid run also requires the sole selected model, xhigh and a unique active reservation in a consistent ledger. No paid calls, account operations, cloud resources or system installations were performed in this continuation.

The process microcheck invokes actual pinned Pi createBashTool in a separate host, launches an ephemeral loopback service and verifies health only after that host exits. It scrubs inherited environment values, redirects service streams, authenticates owned service cleanup and checks repeated cleanup. Failure regressions cover missing readiness and interrupted HTTP responses with bounded watchdog cleanup. This proves Linux native tool mechanics, not model behavior or full agent/Windows/container survival. Evidence: validation/process-micro.json.

The local preflight checks installed Node/Python/Pi/Harbor pins and explicit local Docker/Compose readiness with bounded, credential-free child environments and an empty temporary Docker configuration. It performs no install, image pull, container creation or model call. Here it returns blocked (exit 2): Docker CLI, daemon, Compose and --wait support are unavailable. Node, Python, Pi, Harbor source pin and free policy checks pass. Evidence: validation/local-preflight.json. SETUP_FREE.md documents the proposed Windows/WSL local setup; that setup remains untested.

The session gate forces actual native AgentSession compaction with a deterministic test extension, verifies read/modified file bookkeeping and preserved recent context/branch state, then restores the same context through a fresh native SDK session. Another reopen skips a torn JSONL fragment and separates subsequent appended entries. Six focused tests include cancelled compaction, lost contract, absent hook and denied ambient discovery; failures cannot invoke auth or inference and cannot pass. The passing integrated gate records zero network, auth, inference, credential and ambient-discovery attempts. Evidence: validation/session-micro.json. This is transcript/control-flow mechanics, not model-directed survival, inferred summarization, power-loss durability or in-flight tool recovery.

The pipeline gate exercises real ingestion, normalization, explicit record-array assembly, reporting and failure-analysis CLIs on temporary synthetic fixtures. Its 24 checks cover byte/hash integrity, trial identity, unknown prices/observations, duplicate rejection and held-out refusal before trace access. The fixture's statistics and placeholder provenance are explicitly synthetic and are excluded from benchmark rows. Evidence: validation/pipeline-micro.json. All new gate imports are inert and child environments are scrubbed. Independent review found no remaining material defect.

## Benchmark results

| Configuration/split | Trials | Pass rate ±95% CI | Dollars / successful trial | Tokens / trial | Wall time |
|---|---:|---|---|---|---|
| Stock Pi / dev | 0 | Not measured | Not measured | Not measured | Not measured |
| Stock Pi / held-out | 0 | Not measured | Not measured | Not measured | Not measured |
| Stock Pi / full Terminal-Bench, 5 attempts | 0 | Not measured | Not measured | Not measured | Not measured |
| Apex / dev, held-out, full | 0 | Not measured | Not measured | Not measured | Not measured |

Top five benchmark failure classes and token shares from tool results, system/tools and conversation are unavailable without real baseline trajectories and request attribution. Targets of higher pass rate and ≤60% dollars per solved task are untested. No behavior-changing Apex feature is active.

Before a baseline: obtain renewed model-execution authorization, select the container host, resolve image digests and review a whole-run estimate against the current ledger. Current free-only policy blocks priced Muse inference even with a free local engine. Terminal-Bench 2.0 definitions and prospective splits are frozen; select discriminating dev tasks only after stock Pi outcomes. Other datasets need separate immutable snapshots. Held-out traces never enter tuning. The user's sole-model restriction currently excludes the brief's eventual two-MAIN-model comparison.

Measurement limits: native Windows and real container installation/run remain untested. Directory isolation in the micro-test is not an OS filesystem sandbox. Pi catalog costs differ from account-adjusted generation receipts, so the ledger uses receipts. Unpublished cache-write prices remain unknown; no positive cache-write tokens were observed. Exact token-category attribution and physical peak context are still unavailable. Full future container/tool/storage/tax charges require separate accounting.


## Phase 1 local implementation

All eleven Phase 1 experiments are implemented behind individual flags and remain off by default. npm run check, npm test (**151 Node + 121 Python = 272**, zero skips) and integrated npm run micro pass. The native Phase 1 gate passes **16 checks**, including classifier-disabled codemode, intact 20,481-byte nested JSON parsing, persisted masking/reopen and offline compaction cancellation. Fresh independent source review found no remaining material defect. See PHASE1_LOCAL.md and validation/phase1-local.json for scope. New provider requests/spend: **0 / $0**.

| Local fixture | Before / after observed bytes | What it proves | What it does not prove |
|---|---:|---|---|
| Actual native Bash hook-visible text shaping | 38,390 / 6,536 | Bounded recoverable display result | Provider tokens/cache hits/cost or solve rate |
| Explicitly synthetic persisted observation masking | 26,600 / 177 | Native edit persistence, projection and reopen | Real-observation eligibility or compaction semantics |

The 0.6 dollars-per-solved target, pass-rate nonregression and all model ablation effects are **unmeasured**, not wins. evals/phase1-ablations.json has null performance deltas/CI/tokens/dollars/wall time, model_runs_used=0 and no default promotion for every flag. Stock baselines and benchmark failure rankings still require a container engine and renewed paid-run authorization. MAIN=FAST Muse and xhigh remain fixed; cross-model/lower-thinking savings were not implemented under another name.

## Phase 2 local implementation

Fourteen default-off success-rate experiments are implemented on Pi 0.99.2 without core patches. Final offline checks pass: **432 unit tests** (302 Node + 130 Python), **one optional TypeScript skip**, and **22 native Phase 2 checks** plus all previous integrated gates. Two independent source reviews have no remaining material findings. Native contract/todo/gate/order/reload/process mechanics and denied auxiliary paths are real; inputs are script-seeded and model fixtures synthetic. PHASE2_LOCAL.md and validation/phase2-local.json state the scope and development isolation exceptions.

Additional provider requests/spend: **0 / $0**; historical total remains nine requests/**$0.002482108**. Every flag has null pass-rate/CI/token/dollar/wall-time deltas and zero model ablation runs in evals/phase2-ablations.json. Same-model improvement, top-five benchmark failure classes, full/held-out outcomes and cost targets remain unmeasured. No feature is promoted, and Phase 0/1 empirical exits remain pending. The next permitted empirical step requires a configured container host, renewed model-execution authorization and an estimated stock baseline; the present free-only policy remains binding.

## Phase 3 local implementation

Nine daily-driver flags are implemented on pinned Pi 0.99.2 and remain default-off: cost,checkpoints,review,plan,remember,skills,safety,report,resume. Final offline checks pass **586 tests** (440 Node + 146 Python), with **one optional TypeScript skip**, **31 native Phase 3 checks** and all earlier micro gates. Independent reviews have no remaining material findings. PHASE3_LOCAL.md and validation/phase3-local.json distinguish local implementation from pending empirical acceptance.

Real native commands, hooks, session/resource persistence, nested readonly enforcement, shadow-Git undo and CLI report/denial paths are exercised. Token/cost messages in those fixtures are script-seeded; category shares are labeled stored-content UTF-8 bytes/4 proxies. Unknown partial/torn/helper costs remain unknown. Model-generated plan/review and automatic priced resume are blocked; native completed-session restore provides no in-flight side-effect replay. Ten skill probes are real static file observations, not model-routing results.

New provider requests/spend: **0 / $0**. Historical total remains nine requests/**$0.002482108**, unused **$0.997517892** frozen, reserved $0. Every Phase 3 flag has null pass-rate/CI/token/dollar/wall-time deltas and zero model runs in evals/phase3-ablations.json. No benchmark trial or default promotion occurred; top five benchmark failure classes and all performance targets remain unmeasured.

Development evidence retains an initial full-suite service-watchdog failure, its real delayed-start red/green regression, and a separate unchanged five-second session fault timeout under nine concurrent unit files. Final cleanup reserves a bounded post-readiness lease and the offline unit runner limits file concurrency to two; benchmark resources, timeouts and protocol are unchanged. Final source has fresh check/full-suite/micro evidence after all fixes. Optional durable integration, native Windows and actual container/model runs remain unverified.

## Phase 4 guarded self-improvement loop

Implemented offline prepare/import/decide/plan/reconcile commands and the authorization-gated automated OCI proposer → micro → pinned Harbor dev/held-out → decision path. Every prior runtime version and hash-checked dev raw trajectory is available to the proposer; held-out raw content and task identities remain excluded. Private Git candidates, benchmark-literal guards, exact repetition/provenance checks, confidence-bound acceptance and an aggregate leaderboard are implemented. No candidate changes the checkout or default flags.

Fresh Phase 4 verification: **49 checks pass** (6 Node + 43 Python), **two file-symlink privilege skips**, and **14 real CLI/Git/raw-file smoke checks pass**. The retained Phase 3 bundle exports **12 real commits / 331 runtime files**, with its temporary export removed. These checks exercise synthetic accepted/rejected decisions, raw framing, missing/poison held-out exclusion, private candidate commits, budget reservations/receipts, iteration cap and early offline refusal. Constructed outcomes and token usage are not solve-rate or billing evidence.

At Phase 4 delivery, broad project gates did not pass: local Pi/Harbor were missing and older fixtures assumed POSIX file symlinks/FIFOs/paths. Those failure logs remain under validation/phase4-integrated-*.log. The final-validation section records the subsequent pinned-toolchain restoration and native Windows verification; it does not overwrite earlier evidence. Actual native proposer, OCI verification and benchmark runs remain unexercised.

New inference/provider requests and spend: **0 / $0**. Historical total remains nine requests / **$0.002482108**; **$0.997517892** remains frozen, reserved $0. No benchmark iteration or default promotion occurred. Top five benchmark failure classes, dev/held-out improvements, dollars-per-solve targets and the two-model definition of done remain unmeasured.

Empirical acceptance requires renewed model-execution authorization, real complete baseline trajectories/measurements, reviewed expected-output literals, pinned local dependencies and a configured trusted digest-pinned Linux image/container evaluator. Lexical guards cannot prove semantic unity or detect arbitrary obfuscation; caller-reviewed receipt hashes do not authenticate invoices or enforce provider billing. Phase 4 engineering is smoke-verified locally; its empirical acceptance and full project definition of done remain false.

## Final validation readiness

- Pinned Pi 0.99.2 and Harbor 0.23.0 at 99218a4611e3bd76e49ce3b5f977e8c8134ad3ac restored locally; Node 24.19.0, Python 3.13.7 and local rg/fd observed. Syntax/JSON/source-pin checks pass.
- Full offline unit command passes: **423 Node + 193 Python = 616 passing tests**, **43 Node + 2 Python = 45 capability skips**, zero failures. `validation/final-unit-verified.log` records the actual run.
- Real native launcher help, opt-in shape CLI loading, profiling/database probes and long Bash output shaping pass. Windows spills have protected owner-only ACLs, pinned non-reparse ancestors, exclusive creation and exact raw recovery. Supported junction/privacy/rollback checks stay active; POSIX mode/FIFO/process-group and unavailable file-symlink proofs remain explicitly unexercised.
- Extracted `artifacts/final-validation/apex-agent-pi-0.0.0.tgz` with Python's archive data filter and supplied the already-installed pinned Pi peer dependency through a temporary junction. Packaged headless/shape CLI help and real native Bash shaping pass: **160 returned bytes**, preserved exit code **0**, exact raw spill recovery. Evidence: `validation/final-packaged-cli-help.log` and `validation/final-packaged-native-spill.log`; no model request.
- Complete offline micro orchestration reaches session, context, core, daily-driver, evolution and analysis contracts with zero provider calls. Overall **BLOCKED / exit 2**: native owned-process survival and Unix process-group cleanup require Linux. The original Phase 2 failure and process skip remain in `validation/offline-micro.json`; this is not a full micro pass.
- Real **openai-codex/gpt-6.1-sol**, OAuth, xhigh, Windows Pi SDK smoke passes all four tools and post-edit Bash assertions: **5 requests**, **19.366 s**, **3,441 uncached input / 3,584 cache-read / 225 output tokens**. Raw events/session and checks: `runs/model-smoke/sol-oauth-001/`. No inference fallback or benchmark task ran.
- Sol catalog token estimate: **$0.0094904**; actual subscription billing **unknown**, not zero or an API invoice. At the time a separate **$20 Codex testing cap** left **$19.9905096 catalog-equivalent allowance**; that cap was later removed (see Codex OAuth above). `evals/spend.json` and its historical OpenRouter totals remain unchanged; no OpenRouter request was added.
- Metadata CLI prepares all **12 paired plans**, five attempts/task, for the two models and dev/heldout/full: 90 dev, 100 held-out and 445 full trials per model/configuration. Plans remain blocked with `harbor_argv=null` and unknown costs; no invented source SHA, benchmark data, pass-rate CI, dollar-per-solve improvement or default promotion.

Remaining acceptance blockers: stopped Linux Docker daemon, unavailable WSL, unresolved images, missing actual harness source revision and real complete baselines, private Sol container provisioning, and reviewed complete two-model benchmark scope/budget. The user-approved local Codex testing usage does not authorize the frozen OpenRouter budget or substitute for these prerequisites. Benchmark plans keep every flag off and promote no benchmark default (default-on benchmark ablations: **0**); project definition of done: **false**. Native Windows is the exception: plain `apex` there turns on `WINDOWS_AUTO` (see Windows milestone completion).

## Windows-only continuation

The user narrowed the current target to native Windows. This does not convert Linux-only proofs into passes or satisfy the original two-model benchmark definition of done. `WINDOWS_LOCAL.md` defines the separate milestone; Docker/WSL/Harbor are not prerequisites for the native launcher or Windows-specific gates.

- Added `preflight:windows`, `check:windows`, `test:windows` and `micro:windows`, without weakening the original full commands. Native readiness probes are bounded/read-only and inherit no provider credentials, remote Docker settings, shell startup files or user OAuth profile.
- Added explicit `--apex-target windows`: at the time exact openai-codex/gpt-6.1-sol at xhigh, no automatic feature activation (the default is now Claude Opus 5.5 at medium; see Windows milestone completion). Unsupported bg/max/recovery and Muse-only route/output are rejected. Other provider/model/API-key selections are rejected; the target is not a billing guard or credential validator. Original auxiliary-inference/automatic-resume refusals and all benchmark policy/ledger files remain unchanged.
- Real native Windows micro acceptance: **six contracts / 123 checks PASS**, including **36 Sol-selected offline checks**. Script-seeded calls exercise readonly plans, exact save, checkpoint/undo/reopen, learnings/eval isolation, skills, accounting, report/resume inspection, efficient read/edit/search, Unicode/spaced/case-insensitive paths, CRLF and secure shaping composed with checkpoints. Network/auth/inference/credential counters remain zero. Evidence: `validation/windows-native-micro.json`.
- Fixed shared `.apex` creation: checkpoints and learnings now cooperate with shaping's atomic owner-only Windows ACL root. Existing public roots refuse private writes without silently changing permissions. New native regression checks prove checkpoint-first/remember-first composition, exact raw recovery, unchanged Git index, CRLF restore, inherited private storage ACLs and cancellation before allocation. POSIX mode restoration is not claimed.
- Fresh full suite: **453 Node + 193 Python = 646 passes**, **43 Node + 2 Python = 45 capability skips**, zero failures. Skips are retained, not relabeled as Windows passes. The 45-skip audit identifies **29 outside-native-scope**, **15 file-symlink privilege** and **one optional TypeScript checker** skip; new Windows ACL/composition/native-shell regressions replace missing native coverage without pretending the skipped proofs ran. Evidence: `validation/windows-unit-verified.log` and `validation/windows-skip-audit.json`; native-only command retains the Node capability skips and does not require Python/Harbor.
- Clean packaged installation: locked offline `npm ci` installs the exact peer dependency tree into a fresh npm prefix, followed by the Apex tarball, with scripts/audit/funding disabled. **Seven checks PASS**: real package/peer (matching lock integrity), actual PowerShell/Git Bash `apex` commands, packaged Sol dry-run, selected extension CLI loading and real packaged Bash spill recovery. No dependency junction; temporary install removed. **16,800 raw bytes → 110 returned bytes**, exact recovery, exit code 0. Evidence: `validation/windows-package-smoke.json` and `artifacts/windows-native/`.
- Earlier clean-install attempts exposed absent registry packuments despite cached tarballs, and PowerShell's missing-PATHEXT silent native-command behavior. Failure logs/JSON are retained. The final runner uses the frozen dependency lock and a minimal native PATHEXT; a real PowerShell→Node stdout regression passes. No online fallback or system/global installation was attempted.

New provider requests/spend at that point: **0 / $0**. Live and interactive acceptance followed later (see Windows milestone completion). File-symlink boundaries requiring unavailable Windows privileges remain unexercised; supported junction/hard-link/ACL checks stay active. No benchmark run, measured performance gain, benchmark default promotion or claim of full project completion.

### Sol-era Windows acceptance (history)

- Live Sol feature acceptance `windows-sol-live-007` (Codex OAuth, gpt-6.1-sol, xhigh): **24/24 checks PASS** — read/search/edit/write/bash/patch, lazy tools, contract/todo/verification gate, shaping with exact recovery, remember, skills, checkpoint `/undo`, accounting, resume, offline auxiliary refusals, network policy and zero extension errors. **10 physical requests**, 154.5 s, catalog estimate **$0.25997** (not an invoice). Evidence: `validation/windows-live-windows-sol-live-007.json`, raw events under `runs/model-smoke/windows-sol-live-007/`.
- Earlier live runs 005/006 failed `/undo` with Git `cannot lock ref` past MAX_PATH; that evidence is retained. Checkpoint Git now uses `core.longpaths` and relative shadow paths, and fails closed with `path-too-long` beyond Git's 246-character working-directory limit (project roots up to about 156 characters work). Regressions cover a 135-character root that captures/undoes and a 185-character root that refuses.
- Interactive console acceptance in the Windows PowerShell 5.1 console host: safety Allow/Deny dialogs (denied calls blocked, approved edit applied), `/cost`, `/undo` of an edit and of `/plan save`, offline `/plan` and cancel, `/report`, Ctrl+D exit to the shell. **PASS**; about $0.026 catalog estimate. Pi's default theme hides violet inline-code spans in that console's palette; the `dark` theme workaround is documented. Evidence: `validation/windows-terminal-acceptance-2026-10-02.json`.
- Dashboard: Sol sessions with features launch through `--apex-target windows` (forced xhigh; route/output/bg/max/recovery disabled and server-rejected); selected safety now prompts in RPC sessions as Allow/Deny dialogs. Live browser check with the "Everyday safety" preset: the session process ran `--apex-target windows --apex-features cost,checkpoints,plan,safety,report,resume`; Allow applied the edit with a diff, Deny blocked it, an unanswered prompt was denied after the 15 s safety timeout, and `/undo` restored the file. About $0.01 catalog estimate.
- Preflight checks git/rg/fd on the PATH the launcher inherits instead of workspace `.tools/bin`, which had reported ready while the launcher could not find rg/fd. `rg.exe` 15.2.0 and `fd.exe` 10.5.0 are installed in `%LOCALAPPDATA%\Apex\bin` on the user PATH.
- The package smoke had become BLOCKED (`ENOTCACHED xmlchars`) after dev-only `jsdom` entered the lock; its bootstrap now keeps only lock entries reachable from the Pi peer and Apex runtime dependencies. **Seven checks PASS** again (16,800 → 110 bytes, exact recovery).
- Fresh gates: `check:windows` PASS; `test:windows` **486 pass / 43 explicit skips / 0 fail** (529 Node tests, `validation/windows-native-unit-verified.log`); `micro:windows` six contracts PASS with zero provider calls.

Remaining out of Windows scope: Unix `bg`/`max`/`recovery`, POSIX modes/FIFOs/process groups, file-symlink proofs without Windows privileges, Harbor/benchmarks and the two-model definition of done.

## Windows milestone completion

Fresh run on 2026-10-19 against the current code (head `5f8c2d0` plus the uncommitted working tree). Sol is no longer available to the user, so the Windows default is now **Claude Opus 5.5 (`anthropic/claude-opus-5-5`) at medium** through the Claude Pro/Max login. The sections above stay as history.

Defaults and opt-ins (consistent with `WINDOWS_LOCAL.md` and `PROGRESS.md`): plain `apex` on native Windows turns on `WINDOWS_AUTO` = context `cache`, core `correct`, features `cost`, `plan`, `report`, `resume`, `autocompact`, plus `checkpoints` at a Git root. Every other supported flag and `--apex-pair` is opt-in. `bg`, `max`, `recovery`, `route` and `output` stay unavailable on the Windows target.

Offline gates (zero provider calls):

| Gate | Result | Evidence |
|---|---|---|
| `check:windows` | PASS | `validation/windows-check-2026-10-19.log` |
| `test:windows` | 574 tests: **531 pass, 0 fail, 43 skips** | `validation/windows-native-unit-2026-10-19.log` |
| Skip audit | the 43 skipped tests are exactly the audited Node list: 29 outside native Windows scope, 13 file-symlink privilege, 1 TypeScript checker | `validation/windows-skip-audit.json` (`revalidated`) |
| `micro:windows` | **PASS**, six contracts, 123 checks (tools 8, session 11, context 16, core 21, features 31, default 36 on Opus/medium) | `validation/windows-native-micro.json`, `validation/windows-native-micro-2026-10-19.log` |
| `smoke:windows-package` | **PASS**, seven checks; packaged Windows selection resolves Opus 5.5 at medium; 16,800 raw → 110 returned bytes with exact recovery | `validation/windows-package-smoke.json`, `validation/windows-package-2026-10-19.log` |

Live acceptance on Opus 5.5 at medium (catalog estimates, not invoices; ledger `evals/claude-budget.json`, $10 cap):

| Run | Result | Requests | Estimate |
|---|---|---:|---:|
| OAuth refresh probe: Pi refreshed the expired Claude token itself | PASS | 1 | $0.004181 |
| `windows-claude-live-001`: guarded SDK feature run with every supported context/core flag and all features (follow-up to `windows-sol-live-007`) | **24/24 PASS**, 156.7 s | 10 | $0.7214326 |
| PowerShell 5.1 console: plain `apex` defaults (edit, `/cost`, `/undo`, `/plan` read-only turn saved to PLAN.md and undone, `/plan cancel`, `/report`, `/resume-info`, autocompact at 42k, reopen) and opt-in safety (Esc denies, Enter allows edit and bash) | **PASS** | 14 | $0.388272 |
| Dashboard: Default preset (edit, `/cost`, `/undo`, `/plan`, `/report`, `/resume-info`), Plain agent, Everyday safety (Deny, Allow, Allow all, Auto-approve off) | **PASS** | 12 | $0.037443 |
| `--apex-pair anthropic/claude-opus-5-5:low,anthropic/claude-haiku-4-5:low` headless smoke | PASS | 2 | $0.021117 |
| **Total** | | **39** | **$1.1724456** |

No OpenRouter request was made. One console launch before the fix below selected OpenRouter Muse and was exited before any prompt (0 requests). Evidence: `validation/windows-live-windows-claude-live-001.json`, `validation/windows-terminal-acceptance.json`, `validation/windows-dashboard-acceptance.json`, `validation/windows-optin-audit.json` (every default and opt-in mapped to its evidence), summary `validation/windows-local.json`.

Windows-specific fixes found by this acceptance:

- `apex --apex-features safety,cost,checkpoints` (an explicit selection without `--apex-target`) fell through to the benchmark path and selected frozen OpenRouter Muse at xhigh. On native Windows an explicit context/core/features selection now keeps the Windows target unless it names a Muse model (`lib/windows-target.mjs`).
- After autocompact, `/cost` showed the session as unknown because Pi 0.99.2 writes native compaction usage without a model. Native compaction and branch-summary usage is now priced on the session model, which is the model Pi compacts with.
- A plan turn saved PLAN.md silently, and `/plan cancel` answered "Plan mode updated." The plan outcome is now notified ("Plan saved to PLAN.md; prior tools restored."), `/plan` explains that the next message is planned and saved, and cancel says whether it left plan mode.
- The live micro runner, package smoke and offline contracts moved from Sol to the Opus default; the Phase 3 offline CLI check names Muse explicitly so it still exercises the benchmark max-profile refusal on Windows.

Remaining Windows gaps, each with its reason: file-symlink boundaries (a Windows privilege this account lacks; no elevation requested); the optional TypeScript diagnostic checker (not installed); core `bg` (Unix session leaders and process groups, no Node Job Object API); core `max`/`recovery` (free-only offline policy, not Windows); context `route`/`output` (Muse-specific); POSIX modes/FIFOs/process groups (outside Windows scope); Pi's conhost palette (use the `dark` theme), its `pi --session` exit hint and its static Anthropic third-party warning (Pi behavior). Harbor/benchmarks and the two-model definition of done stay deferred and unchanged.
