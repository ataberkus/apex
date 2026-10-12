# Apex

Apex is a Pi package and thin launcher. The current delivery scope is a **native Windows daily-driver**, documented in `WINDOWS_LOCAL.md`; Linux/container benchmark acceptance is deferred, not completed. Phases 0–3 have prior local verification; Phase 4 adds the guarded harness-evolution loop in `evolve/`, with fresh offline CLI/Git/raw-feedback verification. Outside native Windows, every behavioral feature is **off by default**; on native Windows, plain `apex` turns on the `WINDOWS_AUTO` set described below. No benchmark performance gain is claimed; the first live paired comparison against stock Pi is the A/B in `evals/ab/`. Read evolve/README.md for Phase 4, PHASE3_LOCAL.md for daily-driver scope, APEX_BUILD.md for the brief, NOTES.md for source contracts and RESULTS.md for evidence.

Benchmark/API policy remains **offline-only**: MAIN=FAST is **openrouter/meta/muse-spark-1.3-contributor**, xhigh, with the historical $0.997517892 unused OpenRouter budget frozen. The user separately authorized **unlimited Codex OAuth usage**, recorded in `evals/codex-budget.json` with no Apex spending cap; this supersedes the earlier $20 limit without unlocking OpenRouter or a benchmark launch. A real Windows Pi SDK four-tool Sol smoke passed. Current offline units pass; full micro acceptance remains blocked on Unix owned-process proofs. Baselines, held-out outcomes, feature ablations and the two-model definition of done remain pending.

## Native Windows (current scope)

No WSL, Docker, Python or Harbor is required for the native launcher and Windows-specific gates. Install native Node >=22.19.0, Git for Windows, pinned Pi, and `rg.exe`/`fd.exe` on the PATH the launcher inherits (for example `%LOCALAPPDATA%\Apex\bin` added to the user PATH; a workspace `.tools/bin` does not count). Secure storage additionally requires Windows PowerShell/.NET Framework with permission to run the bundled helper. In this source folder:

```powershell
npm ci --ignore-scripts
npm run preflight:windows
npm run check:windows
npm run test:windows
npm run micro:windows
npm run smoke:windows-package
```

The Windows micro report is separate from the original full gate. It tests native tools and Sol-selected **offline** feature composition. Live model compliance is covered separately by `node evals/micro/windows-live.mjs --run-id ID` (Codex OAuth; latest run `windows-sol-live-007` passed all 24 checks) and an interactive console acceptance (`validation/windows-terminal-acceptance.json`). The package smoke performs a fresh, locked offline npm installation of the Pi peer and Apex runtime dependency trees, tests actual PowerShell/Git Bash shims and packaged output recovery, and removes its temporary prefix. No dependency junction or online fallback is used.

On native Windows, plain `apex` (no Apex selection options) runs Sol/xhigh with only features that add no prompt sections, tools or continuations: context `cache`; core `correct` (cwd-confined paths, edit pre-checks and the TUI confirmation before catastrophic shell commands); features `cost,plan,report,resume,autocompact` (compaction past 300k context tokens; `--autocompact-tokens N` sets another threshold), plus `checkpoints` when the folder is a Git repository root. They still reach the model in three ways: `correct` changes the result of a refused or repaired tool call, checkpoints leave an `.apex/` folder in the workspace, and autocompact summarizes the context. On Windows `.apex/` carries its own `.gitignore` (`*`), so `git status` and `git add -A` skip it; `ls` still shows it. Every other feature (`shape`, `mask`, `read`, `search`, `edit`, `patch`, `lazy`, `snapshot`, `entrypoints`, `headless`, `contract`, `todo`, `verify`, `loops`, `diagnostics`, `remember`, `skills`, `safety`) is opt-in. The earlier everything-supported default cost ×2.1 and took ×2.3 the wall time of stock Pi with no pass-rate gain (ab-002 in `DECISIONS.md`). Under `--profile headless` the ab-006 default also added core `headless`, and cost ×1.12 (CI ×1.01–×1.23) at ×1.15 the wall time, both arms at 36/36. That flag's prompt section was the gap and changed no measured behavior (ab-008–ab-010), so `--profile headless` no longer adds it. Any explicit `--apex-target/--apex-context/--apex-core/--apex-features/--apex-eval` replaces the defaults; `apex --apex-off ...` runs stock Pi. Other platforms are unchanged.

Inspect an explicit Sol selection without starting inference:

```powershell
node bin/apex --apex-dry-run --apex-target windows --profile headless --apex-context "read,search,edit,shape" --apex-features "cost,checkpoints,plan,report" "Task"
```

This native-only target selects exact Codex OAuth Sol/xhigh by default without changing the frozen benchmark policy. With an explicit `--provider openai-codex|anthropic|opencode-go` and a plain catalog `--model` id it runs that signed-in model instead. Thinking defaults to xhigh and `--thinking` can pick any level, except that eval isolation and the auto route stay at xhigh; fallback lists, `:thinking` suffixes and `--api-key` are refused. It rejects bg/max/recovery and Muse-specific route/output; choose explicit flags instead of all. `--apex-pair PLAN,BUILD` instead plans each request on one model and builds on another, each at its own thinking level, for example `--apex-pair anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5:medium` (see `WINDOWS_LOCAL.md`). Auxiliary model work and automatic resume remain denied. The target is not a credential validator; Codex testing is uncapped by Apex, while automated live tests still require bounded scope and operational limits. See `WINDOWS_LOCAL.md` for support limits, private storage and remaining live/interactive acceptance.

## Full evaluation/development toolchain

Requirements: Node >=22.19.0, Python >=3.12, uv, Git, Bash, ripgrep and fd/fdfind. Pi on native Windows uses Git Bash. The pinned local Pi/Harbor installation, native launcher help, SDK tool execution and Windows private output spills are verified. Windows shaping requires Windows PowerShell/.NET Framework with permission to run `extensions/apex-context/private-spill.ps1`; failures preserve raw output and report the missing prerequisite. Existing public `.apex`/`out` directories are rejected, not silently permission-modified. SETUP_FREE.md describes the still-unverified WSL2/Linux-container setup, requiring no paid sandbox subscription.

In Bash/WSL, inside this folder:

```bash
npm ci --ignore-scripts
UV_TOOL_DIR="$PWD/.tools/uv" UV_TOOL_BIN_DIR="$PWD/.tools/bin" UV_CACHE_DIR="$PWD/.cache/uv" \
  uv tool install --with socksio==1.0.0 \
  git+https://github.com/harbor-framework/harbor@99218a4611e3bd76e49ce3b5f977e8c8134ad3ac
npm run check
npm test
npm run micro
npm run preflight
```

Install fd/fdfind and ripgrep through their official distribution instructions before micro-evals. These tools are test dependencies, not bundled into Apex. On the build workspace, fd 10.3.0 was installed under workspace tooling after Pi's automatic extraction failed on ownership changes.

For native PowerShell, set the tool directories before the same uv installation:

```powershell
$env:UV_TOOL_DIR = Join-Path $PWD ".tools/uv"
$env:UV_TOOL_BIN_DIR = Join-Path $PWD ".tools/bin"
$env:UV_CACHE_DIR = Join-Path $PWD ".cache/uv"
uv tool install --with socksio==1.0.0 git+https://github.com/harbor-framework/harbor@99218a4611e3bd76e49ce3b5f977e8c8134ad3ac
npm ci --ignore-scripts
npm run check
npm test
npm run micro
npm run preflight
```

The Node scripts select the workspace Harbor Python when available. Otherwise set APEX_PYTHON to the absolute Python executable containing this exact Harbor commit. The published PyPI 0.23.0 wheel is different despite the same version number; npm run check validates direct_url commit metadata. Do not substitute a plain global Harbor installation. Preflight is a read-only tooling check: JSON, exit 2 when blocked, no installs, image pulls, containers or model calls. It uses only the explicit local Docker endpoint with an empty temporary config, ignoring inherited remote contexts and credentials. No engine is available in this build workspace.

npm run micro also checks forced native compaction and fresh SDK transcript restoration with a deterministic fixture summary and blocked transport, then a synthetic ingest→normalize→report CLI pipeline. These are free mechanics/accounting checks, not model solve-rate evidence. JSON evidence is saved under validation/. Torn-tail recovery skips corrupt fragments; it does not reconstruct them or prove power-loss durability.

## Final validation

`evals/final-validation.json` and the existing Harbor planner prepare **12 metadata-only plans**: two exact models × stock Pi/default-off Apex × dev/heldout/full, xhigh, five attempts. No default-on ablations exist. Run:

```bash
python -m evals.harbor.final_validation --apex-package /absolute/path/to/apex.tgz --output runs/final-validation-plan.json
```

The CLI exits 2 while blocked and emits no executable Harbor argv. Required: reviewed complete benchmark scope/budget, a real harness source revision, trusted Linux containers and resolved image digests, real baseline data, and private container credential provisioning. Host Sol OAuth login is not Harbor provisioning; the pinned stock Pi adapter does not forward Codex OAuth, and Apex's current configuration directory is inside logs. Credentials stay outside this repository and all packages.

On Windows, `npm run micro` exercises every reachable native contract, retains the unsupported Unix background proof as `FAIL`/`SKIP`, records overall `BLOCKED`, and exits 2. It does not claim a complete micro pass. `validation/offline-micro.json`, `validation/final-unit-verified.log` and `runs/model-smoke/sol-oauth-001/summary.json` distinguish offline/synthetic evidence from the real local OAuth access smoke.


## Launcher

```bash
node bin/apex --apex-help
node bin/apex --apex-dry-run --profile headless --model provider/model "Task"
node bin/apex --version
```

These commands perform no model inference. A normal task invocation will use Pi's configured credentials and can incur provider charges; benchmark tasks remain blocked pending a container host; see RESULTS.md for the live synthetic smoke.

Apex options occupy the prefix, before all Pi arguments. default forwards Pi arguments unchanged; headless ensures --print --mode json. Pi option values and literal task text are preserved. Use -- to end option parsing for tasks beginning with a dash. Equals-mode arguments are unsupported by pinned Pi; use --mode json. With no --apex-context prefix, no extra prompt, tools, environment snapshot or thinking policy is injected.

The package declares host Pi as a peer and pins local development Pi 0.99.2. The package declares three inert-by-default context, core and daily-driver extensions. Installing it registers selection flags but adds no model-visible resource until enabled. Virtual apex/auto is a separate explicit extension loaded by the route option before model selection.

## Dashboard

```bash
npm run dashboard
```

`npm run dashboard` opens the dashboard in your default browser automatically once the server is listening, using the authenticated startup-token URL. The URL is also printed as a fallback (the token changes on every start; set `APEX_DASH_PORT` to move the port). To start without opening a browser, use `node dashboard/server.mjs`. Add project folders with Add workspace (type a path or browse), then start or resume sessions under each one. Every session is its own `apex --mode rpc` process streamed live to the browser. Clicking a saved or archived session shows its transcript read-only, straight from the session file, without starting an agent; **Resume** in that view opens the resume dialog. The left column groups sessions by workspace and lists any that need you (an approval, a finished turn, an error) at the top. The right column shows the agent's todos, acceptance criteria and changed files, token and context usage, and the slash commands it exposes (type `/` in the message box). Edits render as unified or split diff cards, and the safety feature's approval questions appear above the message box.

Chat messages support Markdown: headings, emphasis, lists, task lists, tables, quotes, links and fenced code blocks with a Copy button. Formatting updates during streaming and works in resumed history. Raw HTML is displayed as text; external Markdown images load only when you click **Load image**.

For models that accept images, use **Add images**, paste an image into the message box, or drag images onto the conversation. Preview and remove attachments before sending; click any image preview to enlarge it. PNG, JPEG, WebP and GIF are supported, with up to 4 images per message, 5 MB each and 10 MB total. Image-only messages and image steering during a running turn are supported. Model capabilities are read from Pi's catalog and the live agent; unsupported models disable uploads, and the server also rejects image input for them. Draft text and attachments stay with their session and are retained if sending fails. Attachments travel as Pi image content blocks and remain visible in saved chat history; they are not written to browser localStorage.

**✨** beside Add images (or Ctrl+Shift+E in the message box) rewrites the draft into a clearer prompt that names the real files and symbols it refers to. It runs one read-only `--print` agent in the session's folder through the same launcher, on the session's model (a pair's build model) at medium thinking, with only Pi's `read`, `grep`, `find` and `ls` tools, no extensions, skills or saved session; the draft and the last six conversation messages go in on stdin. While it runs the draft is read-only, Send waits, the status line shows each lookup and the button turns into **✕** to cancel. The result replaces the draft without sending it; Undo in the notice or Ctrl+Z restores the original. Empty drafts and drafts starting with `/` or `!` can't be enhanced. Attached images are not passed to the enhancer.

The sidebar lists three logins: **Codex** (ChatGPT subscription, OAuth), **Claude** (Claude Pro or Max subscription, OAuth) and **OpenCode Go** (API key). Sign in from the sidebar, the New session dialog or the unsigned-session banner. For Codex, Apex opens the provider's browser login and uses Pi's native PKCE/callback flow. For Claude, Apex runs oh-my-pi's own sign-in (`@oh-my-pi/pi-ai`: PKCE with a separate random state, a `localhost:54545` callback, the token exchange at `api.anthropic.com`, the account/organization identity hook and Claude Code's refresh headers) in place of Pi's. oh-my-pi ships Bun-only TypeScript, so the dashboard runs it in a short-lived [Bun](https://bun.sh) process (`dashboard/omp-sidecar.mjs`); Claude sign-in, refresh and usage need `bun` on `PATH`. After you complete sign-in, Pi saves the OAuth credentials in `auth.json` inside `PI_CODING_AGENT_DIR` (by default `%LOCALAPPDATA%\Apex\sol-oauth`); later dashboard and agent sessions reuse that login and Pi refreshes it when needed (agent sessions use Pi's own Claude refresh). Tokens are never returned to the dashboard page or stored in browser localStorage. If automatic return fails, expand **Browser did not return?** and paste the full callback URL (`http://localhost:1455/auth/callback?...` for Codex, `http://localhost:54545/callback?...` for Claude) or, for Claude, the `code#state` it shows; either must belong to the current sign-in attempt. Cancel does not remove a previously saved login; **Manage → Sign out** does. OpenCode Go has no OAuth in Pi: paste the key once and Pi saves it in the same `auth.json` (an `OPENCODE_API_KEY` in the dashboard's environment also works). Unsigned sessions show a sign-in action and refuse prompts before any model request; after sign-in, send or retry your message. Anthropic's consumer terms may restrict using a Pro/Max login outside its own apps; check them before relying on Claude OAuth here.

The New session dialog lists every Apex feature (context, success-rate and daily-driver groups) with a plain-language summary and its limits. It starts on the **Default** preset, the set plain `apex` gets on native Windows, with checkpoints only when the workspace is a Git repository root. **All features** selects everything the model can run, and **Plain agent** runs stock Pi (`--apex-off`). A remembered choice of the earlier default, All features, falls back to Default once. Muse Spark 1.3 needs `OPENROUTER_API_KEY` in the environment that started the dashboard. The model list is read from Pi's installed catalog for each login provider (the same catalog the agent resolves), so new models appear with Pi upgrades. Start with one model or a Plan + build pair, star favorites, and change models in a running session from the strip above the message box (see `WINDOWS_LOCAL.md`). On native Windows, every Codex, Claude and OpenCode Go model runs features through the same `--apex-target windows` selection as `bin/apex`, at the thinking level you pick (eval isolation and the auto route stay at xhigh); the dialog disables route, output, bg, max and recovery for them. The server builds the same prefix flags as `bin/apex` and validates them with the launcher's own steps, so policy refusals read as errors in the dialog. Features that need paid execution (max, recovery) are blocked, and background processes, subagents and review carry their own limits. Selected safety shows each confirmation as an Allow/Deny dialog. Codex, Claude and OpenCode Go use the `PI_CODING_AGENT_DIR` logins (default `%LOCALAPPDATA%\Apex\sol-oauth`). Sessions are normal Pi session files, so they also resume in the terminal UI; do not open the same session in both at once. The server binds loopback only, requires the startup token cookie, a loopback Host and a same-origin Origin for writes, and runs agents with your user's permissions. Per-session costs are catalog estimates. There is no Apex spending cap for Codex sessions. The sidebar footer and the Usage tab show subscription usage for signed-in Claude and Codex logins from oh-my-pi's usage providers, the same 5-hour/7-day windows and resets omp's `/usage` shows; it refreshes at most once a minute.

With **Autocompact** checked, the dialog shows a context-token threshold field, prefilled with 300000 (or your last launch's value). The server passes it as `--autocompact-tokens`, the same option `bin/apex` takes; it must be a whole number from 1 to 100000000.

## Phase 1 experiments

Features: cache, shape, mask, compact, read, search, edit, patch, lazy, route, output. Each defaults off and has add/remove ablations in evals/phase1-ablations.json. PHASE1_DESIGN.md and PHASE1_LOCAL.md describe behavior, evidence and limitations.

```bash
node bin/apex --apex-dry-run --apex-context read,search,edit,shape --profile headless "Task"
node bin/apex --apex-dry-run --apex-context all --profile headless "Task"
```

Dry-run resolves flags without starting Pi or inference. Actual task execution can incur provider charges and is not authorized by the free-only build work. Original feature invocations without `--apex-target windows` select only the allowed Muse physical model, at xhigh unless `--thinking` picks another level. route resolves apex/auto back to that same model; continuation/retry pairs stay fixed. The route and eval isolation stay at xhigh, and cross-model routing is unavailable under this selection.

read defaults to 80 lines; outline uses an existing ctags executable when available and otherwise labels its symbol hints approximate. Unchanged reads deduplicate only while their original unmasked observation is on the active branch. edit exposes old_string/new_string and delegates Pi's native multi-edit/whitespace/queue. apply_patch supports a strict plain unified patch to one existing file; creates/deletes/multifile/git-envelope patches fail before writing. Only this optional patch is deferred with lazy; codemode/tool_search are native Pi capabilities with model classification disabled.

shape spills actual hook-visible text under .apex/out with accurate native full-output provenance; it preserves unknown structured schemas. mask batches persisted context edits and protects recent/latest reads, errors, nested batches and observations without recovery logs. compact currently cancels before auth/inference: free policy does not authorize summaries. Its separately tested completion path preserves exact state and usage, but is not live billing-validated. cache records prefix hashes and native cache counters outside model context. output contributes a stable short section and lowers only a recognized existing Muse cap on routine turns.

Pi includes cwd/project context in requests and some provider adapters fold deltas into the initial prefix. Full across-task cache reuse is unverified. Deferred MCP visibility does not defer connection startup; Apex registers no MCP server. External ctags and real model solve-rate/cost remain unmeasured here; native Windows tooling is covered by the separate Windows milestone above. No local fixture reduction is a dollars-per-solved or pass-rate result.

For future authorized Harbor variants add --context-flags read,shape to evals.harbor.plan with --agent apex. It writes the distinct configuration and context_flags agent option; it cannot execute or bypass free-policy/budget checks. Existing stock controls stay unchanged.

## Prepare a baseline without launching it

evals/config.json records the exact model selection, xhigh thinking, historical cap and offline-only policy. No API key is needed for preparation. The model allowlist rejects plans for other models. A Harbor run still needs a configured container environment, a frozen dataset manifest, a whole-run estimate, and current spend/reservations from evals/spend.json. Paid execution is disabled; the unset container host also blocks benchmark plans. Secret values never belong in source, command-line arguments or archived logs.

```bash
python -m evals.harbor.plan --run-id pilot --estimate-usd WHOLE_RUN_ESTIMATE \
  --spent-usd CONFIRMED_SPEND --reserved-usd CURRENT_RESERVATIONS \
  --harness-commit FULL_GIT_COMMIT --output validation/pilot-plan.json
```

Replace the amount placeholders with numbers from the actual forecast and ledger, and FULL_GIT_COMMIT with the full local harness commit. The command only writes a reviewable plan and exits 2 when blocked. It has no execute flag and makes no spend reservation. It is an estimate preflight, not a provider-side billing cap. Recheck actual spend and concurrent reservations before any authorized launch.

For stock Pi, the plan uses Harbor's built-in pi agent with version=0.99.2. Both stock and Apex receive --agent-kwarg thinking=xhigh from the configured level. For Apex, create a local tarball with npm pack --ignore-scripts and add --agent apex --apex-package ABSOLUTE_TARBALL.tgz. The adapter's import path is evals.harbor.apex:ApexAgent; run Harbor from this project so the module is importable. The adapter reuses native JSON sessions and parent provider/accounting behavior, installs the Apex tarball, and uses the headless launcher. MCP is unsupported in this Phase 0 adapter because the parent bridge targets a different Pi version range.

Run generated argv using the **source-pinned workspace Harbor executable**, or explicitly put its bin directory first on PATH after npm run check. Plans name harbor for portability, so a different PATH entry would defeat the source pin. No task timeout, resources, verifier, retries, upload or cloud launch options are changed by the plan. Model/provider IDs are restricted to safe identifiers because the parent Pi adapter interpolates them into a shell command.

The supplied evals/datasets/terminal-bench-2.0/ snapshot contains all 89 tasks from the pinned Harbor registry, each at an immutable Git revision. Its manifest freezes 18 prospective dev tasks and 20 held-out tasks; 51 remain outside those subsets. Task contents, verifier code, tests and trajectories were not fetched. Container image digests are unresolved. The dev sample remains prospective until stock Pi outcomes identify discriminating tasks; keep held-out membership fixed while tuning.

```bash
python -m evals.harbor.datasets verify evals/datasets/terminal-bench-2.0/manifest.json \
  --dataset terminal-bench@2.0 --split dev
```

Run plans default to the dev split. Use --split heldout or --split full explicitly. Every ready plan supplies Harbor's --registry-path and includes exact task-name filters for subsets, plus the manifest/registry hashes and planned trial count. Revalidate those files before any authorized launch. The plan remains a review artifact and has no execution or reservation side effects. The snapshot flow accepts absent/empty custom metrics only. Case-insensitive task-name collisions are rejected because Windows Harbor filtering folds case. .gitattributes preserves LF bytes for frozen metadata and shell launchers during Git checkout.

The dataset metadata capture also confirms SWE variants. Terminal-Bench 2.1 is present as terminal-bench/terminal-bench-2-1; do not invent an unverified legacy @2.1 alias or reuse the 2.0 snapshot for it. Freeze a separate immutable manifest before planning another dataset.

## Preserve and analyze results

Raw ingestion accepts native Pi session JSONL, including interrupted logs, and never overwrites an attempt. Example after an authorized run:

```bash
python -m evals.analysis.trace_store --source NATIVE_SESSION.jsonl \
  --run-id pilot --task-id TASK_NAME --attempt 1 --split dev \
  --harness-commit FULL_GIT_COMMIT
python -m evals.analysis.normalize runs/pilot/TASK_NAME/attempt-1 \
  --result HARBOR_RESULT.json --configuration-id STOCK_PI_MODEL_SETTINGS \
  --output validation/task-metrics.json
```

normalize reads the final Harbor reward/timing artifact, not verifier code or tests. It emits measurements without raw task text, preserving run and available Harbor trial identities. Trace/result association is caller-supplied and is not independently verified by a task-name match. Binary rewards must be scored and match the task; unscored/error outcomes must be retained and given an explicit reporting policy, never silently dropped. Keep the raw session, filtered CLI log, resolved config, result and ATIF together; ATIF omits some native Pi usage/context data.

Collect normalized records for **one configuration** into a JSON array, then:

```bash
python -m evals.analysis.report METRICS_ARRAY.json \
  --output validation/report.json --markdown validation/report.md
python -m evals.analysis.failures runs/pilot/TASK_NAME/attempt-1
```

The report includes equal-task pass rate and task-cluster bootstrap confidence intervals. Duplicate run/task/attempt, trial UUID or result-hash identities are rejected instead of counted twice; missing identities produce a provenance warning. Every attempt's cost contributes; primary dollars per solved task use successful trials, not a best-of-N selection. Small-sample intervals and unknown/incomplete usage are explicitly labeled. Thinking is a subset of output. Prices are exact provider/model snapshots with machine-checked scope bounds; absent rates do not mean free tokens. Costs are token dollars, not full invoice totals or container charges.

Failure analysis is dev-only. Suggestions are provisional; confirm with --label and concrete --evidence to write a classification. Held-out/full raw traces are rejected before their content is loaded. A future proposer additionally needs separate filesystem access controls; this guard is not an OS sandbox. Exact input-category attribution and physical peak context are still unavailable from arbitrary session traces alone.

## Upgrade and next phase

```bash
scripts/upgrade-pi.sh NEW_VERSION FULL_UPSTREAM_SOURCE_COMMIT
# PowerShell/native equivalent:
node scripts/upgrade-pi.mjs NEW_VERSION FULL_UPSTREAM_SOURCE_COMMIT
```

Read the new Pi source first. The script pins the dependency, refreshes runtime pin references, then runs check → tests → offline micro-evals. API/schema tests remain intentional adoption gates; a compatible upgrade may still need reviewed test expectations and source notes. No paid micro-eval or core patch is attempted automatically.

Phase 0 ends only after real dev/held-out baselines, failed-trace priorities and token attribution exist (full runs if budget permits). Do not enable Phase 1 features before that evidence. The user's latest instruction supersedes the earlier paid-testing authorization: only free offline work continues. Container-host setup and renewed model-execution authorization are required before Harbor baselines.

## Explicit live micro-test

The provider smoke is never part of npm test or npm run micro. Under the current offline-only policy it refuses execution before key lookup, SDK initialization or run-directory creation. Earlier paid runs required an explicit run ID, full harness commit and active unique reservation; model, xhigh, output/payload size, physical sends and time were bounded. --dry-run initializes the pinned SDK without inference. A future paid run needs renewed authorization and a consistent ledger before its gate can pass. Credentials must remain transient; the runner removes them before tools start and redacts credential echoes before native session persistence.

## Phase 2 opt-in success-rate harness

Fourteen flags are available through `--apex-core`: snapshot, entrypoints, headless, contract, todo, verify, loops, bg, time, correct, diagnostics, subagents, max, recovery. All default off. See PHASE2_LOCAL.md for verified scope and limits, and evals/phase2-ablations.json for separate add/remove variants with unmeasured performance effects.

Resolve a configuration without starting Pi:

```bash
node bin/apex --apex-dry-run --profile headless \
  --apex-context read,route --apex-core snapshot,entrypoints,headless,todo,verify,bg,time \
  --time-budget 600 --provider openrouter --model meta/muse-spark-1.3-contributor --thinking xhigh
```

Apex options must precede Pi arguments and task text. Time notes require an explicit effective deadline; the Harbor adapter never changes the evaluator timeout. A task containing option-like text cannot change the launcher prefix.

The manual `contract` and `todo` tools, confined artifact checks, two-continuation verification gate, argument correction, local checkers and authenticated background manager work locally. Contract extraction and explore/verify inference are denied before provider access under the current free-only policy. Max orchestration and recovery settings have tested future seams, but current max/recovery launches refuse before allocation. Repository copies and installed diagnostics are not an OS sandbox. Unix background processes must remain in their owned foreground process group; Windows is explicitly unsupported.

All model-backed paths require the selected physical Muse model and xhigh; MAIN and FAST are the same model. No benchmark improvement or default promotion follows from offline tests.

## Phase 3 daily-driver features

Flags: cost,checkpoints,review,plan,remember,skills,safety,report,resume. Select with an Apex prefix; all default off. Each has add/remove variants with unmeasured effects in evals/phase3-ablations.json. Examples below only inspect or construct local commands:

```bash
node bin/apex --apex-dry-run --apex-features cost,checkpoints,plan,skills --profile headless "Task"
node bin/apex report /absolute/session.jsonl --json
node bin/apex resume /absolute/completed-session.jsonl --apex-dry-run
```

Selected native commands are `/cost`, `/undo [turn-ID]`, `/plan TASK`, `/plan save LITERAL-MARKDOWN`, `/plan cancel`, `/review [requirements]`, `/report`, and `/resume-info [session-file]`. `/cost` uses native usage, explicit task/session totals, cache-hit/context percentages and current model; estimates are not invoices. Unknown or partial costs stay unknown. Standalone report labels token categories as UTF-8 bytes/4 proxies and never prints raw task/tool content.

Checkpoints use private shadow Git and preserve staged, dirty and untracked source without changing the user's Git index. Undo only offers completed checkpoints from the active branch and refuses manual post-turn conflicts. Limits: local `.git` or `version-control` directory, regular files, 64 MiB per snapshot and 256 MiB stored budget. Files over 8 MiB, and the largest files once a snapshot would pass 64 MiB, are left out and never touched by undo. Only the newest 50 turns that changed files are kept: older records are dropped instead of blocking, and turns that change nothing leave no record. External worktree pointers, empty-directory lifecycle, cross-process locking and automatic recovery of interrupted restore transactions are unsupported. A failed capture blocks its mutation.

Plan mode enforces read/grep/find/ls at the tool-call boundary, including nested/deferred calls. It saves completed plan text to exact PLAN.md and restores prior tools on finish/cancel/error/shutdown. Under the current policy it enters read-only mode without starting inference; `/plan save` accepts literal user Markdown. Model-generated plans and independent `/review` remain blocked before model work. Native completed-session restoration is tested; unresolved tool calls and torn tails refuse automatic CLI resume, and no in-flight tool replay is provided. The optional pi-durable integration is unverified and no new package is installed.

The deferred `remember` tool explicitly appends bounded project facts to `.apex/LEARNINGS.md`; selected facts join native context files. `--apex-eval` disables all learnings registration/load/write before access. Harbor feature variants always pass that explicit mode. Selected safety adds bounded per-call confirmations in the TUI and dashboard (RPC) sessions; headless/eval has no dialogs. Tool annotation hints do not provide an OS sandbox.

Ten selected skills advertise short metadata and load full bodies only on demand. Their `scripts/probe.mjs --cwd PATH` commands read bounded public source and produce static domain facts without project execution, network or database calls. Mechanical descriptions/probes are tested; model skill-routing accuracy is unmeasured. Templates stay internal to plan/review commands.

## Phase 4 self-improvement

```bash
npm run micro:evolve
npm run evolve -- --help
npm run evolve -- plan --campaign evolve/campaigns/search --estimate-usd 0.10
```

The offline CLI exports every prior runtime version and exact dev raw traces, guards one proposed patch in private Git, compares complete dev/held-out measurements beyond noise and persists an aggregate variant leaderboard. `run` implements authorized OCI proposer → offline verification → pinned Harbor dev/held-out evaluation, but current policy denies it before credentials or allocation. Iteration/spend guards retain unknown bills; synthetic decisions never promote a variant.

Fresh Phase 4 evidence: 49 passing checks, two privilege skips, 14 actual CLI smoke checks and 12 retained-history commits exported. Pinned dependencies and native Windows gates have since been restored (see the Windows milestone above). Native proposer/container execution and benchmark acceptance remain unverified; the original full micro scope retains its Unix process blocker. See evolve/README.md, RESULTS.md and validation/phase4-local.json for prerequisites, protocol, guard ceilings and evidence.

