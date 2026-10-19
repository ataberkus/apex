# Native Windows milestone

Current scope: a native Windows daily-driver, not Harbor/Terminal-Bench completion. WSL, Docker, Linux image digests and Harbor are **not runtime prerequisites** for this milestone. Original benchmark criteria, frozen data and spending restrictions remain intact.

## Requirements and checks

- Native Windows Node >=22.19.0 and pinned Pi 1.3.0.
- Git for Windows/Git Bash, ripgrep (`rg.exe`) and fd (`fd.exe`) on the PATH the launcher inherits. Preflight checks that PATH only; a workspace `.tools/bin` is not counted. One working setup: copy `rg.exe`/`fd.exe` to `%LOCALAPPDATA%\Apex\bin` and append that folder to the user PATH (new shells pick it up).
- Windows PowerShell 5/.NET Framework, FullLanguage and permission to execute the bundled private-storage helper. Apex does not bypass execution policy. RemoteSigned refuses the unsigned helper whenever Windows treats it as Internet-zone: a download mark (`Unblock-File`) or a Low integrity label inherited from a sandbox-labelled checkout (`icacls <script> /setintegritylevel M`; Git re-creates changed files with the inherited label). A refused helper fails closed and its error names the executable, script and command to run.
- Checkpoints are captured only before tools that may change the working tree; `todo`, `contract`, `explore` and `verify` never capture, so a checkpoint failure cannot block them.
- Checkpoints additionally require a real local Git repository in the task folder. Their shadow store sits under `.apex/checkpoints/<64-character key>/shadow`; Git cannot run from a working directory past 246 characters, so project roots longer than about 156 characters fail closed with `path-too-long` (Apex already enables `core.longpaths` and relative shadow paths).
- Python/uv/source-pinned Harbor remain development dependencies for the **full** historical test/check commands, not the native launcher.

From PowerShell or Git Bash in this source folder:

```powershell
npm ci --ignore-scripts
npm run preflight:windows
npm run check:windows
npm run test:windows
npm run micro:windows
npm run smoke:windows-package
```

`preflight:windows` is read-only: no credentials, model catalog requests, installs, Python or Docker probes. `check:windows` validates JavaScript syntax, source JSON, package resources and the native prerequisites without running Python. `test:windows` runs the Node suite and retains explicit capability skips; the original `npm test` still includes Python/Harbor analysis tests. `micro:windows` exercises tools, transcript restoration, context, core controls, daily-driver commands and Sol-selected offline feature composition. It records `validation/windows-native-micro.json` separately. A PASS here is **only Windows-native mechanics acceptance**; the original `npm run micro` and `validation/offline-micro.json` retain their broader scope and Unix process blockers.

`smoke:windows-package` packs the source and installs that tarball with the **exact pinned Pi peer** in a fresh temporary npm prefix. It bootstraps the peer's and Apex's runtime dependency trees from the existing lockfile with offline `npm ci` (dev-only test tooling is pruned), then installs the Apex tarball. It uses only the existing npm cache (`--offline`, preferring `.cache/npm`), disables lifecycle scripts/audit/funding, tests actual PowerShell/Git Bash npm shims and packaged native output recovery, then removes the prefix. No dependency junction is used. Missing cached packages produce BLOCKED, not an online fallback. This is not a global installation.

## Windows selection

Plain `apex` on native Windows applies `WINDOWS_AUTO` from `lib/windows-target.mjs` (see README "Native Windows"): only features that add no prompt sections, tools or continuations, namely context `cache`, core `correct` and features `cost`, `plan`, `report`, `resume` and `autocompact`, with `checkpoints` only at a Git repository root. `--profile headless` adds no Apex feature; core `headless` is opt-in, because its prompt section cost more without a measured benefit (ab-008–ab-010 in `DECISIONS.md`). The private `.apex/` folder holds its own `.gitignore` (`*`), so Git skips it, but `ls` still shows it. Any explicit Apex selection replaces the defaults; `--apex-off` runs stock Pi; non-Windows invocations are unchanged. Inspect an explicit configuration without inference:

```powershell
node bin/apex --apex-dry-run --apex-target windows --profile headless --apex-context "read,search,edit,shape" --apex-core "todo,verify" --apex-features "cost,checkpoints,plan,report" "Inspect this project"
```

`--apex-target windows` belongs in the Apex option prefix. It requires native Windows and selects exact `openai-codex/gpt-6.1-sol` at xhigh by default. An explicit `--provider` of `openai-codex`, `anthropic` or `opencode-go` with a plain catalog `--model` id selects that model instead. Thinking defaults to xhigh; `--thinking` can choose any level, except with eval isolation or the auto route, which stay at xhigh. API-key overrides, other providers, fallback lists, `:thinking` suffixes and model scopes other than the chosen `provider/model` are rejected. OAuth logins and the saved OpenCode Go key stay in a private Pi agent directory outside the project/package. The launcher selection is **not an OAuth credential validator, OS sandbox or provider-side spending cap**; it does not authenticate or reserve funds during dry-run. Ordinary non-dry-run prompts can consume account allowance.

The latest user instruction removes the previous $20 Codex-only testing cap; `evals/codex-budget.json` records no Apex dollar limit and preserves measured usage. OpenRouter spending remains frozen. Automated live tests still require bounded scope and physical requests/usage/deadline limits. The offline Windows gates read neither credentials nor that account and spend nothing. Auxiliary inference, model-generated `/plan`, independent `/review`, inferred compaction, max/recovery and automatic `apex resume` launch remain denied by the original offline policy. Literal `/plan save`, read-only plan enforcement, session inspection and native completed-transcript restoration work offline.

The dashboard uses the same selection: a GPT-6.1 Sol session with features starts with `--apex-target windows` at the thinking level you pick, and the New session dialog disables the unavailable route/output/bg/max/recovery flags. Its default preset is `WINDOWS_AUTO` (checkpoints only at a Git root), and Plain agent passes `--apex-off`. Selected safety prompts in both the terminal UI and dashboard sessions (Allow/Deny dialog).

**Model pair.** `--apex-pair PLAN,BUILD` selects the virtual model `apex/pair` (`extensions/apex-router/pair.mjs`). PLAN is `provider/model:level` and BUILD is `provider/model[:level]`, for example `bin/apex --apex-target windows --apex-pair anthropic/claude-opus-5-5:high,anthropic/claude-sonnet-5-5:medium`. Both models must be in the catalog of a Windows login (Codex, Claude, OpenCode Go) and support the level you give; the providers may differ, and each needs its own sign-in. Leave out `--provider`, `--model` and `--models`. The build level comes from the spec or `--thinking` (not both) and defaults to `medium`; it is the session thinking level, so it can change in Pi or the dashboard while the planning level stays fixed. Each message you write is planned by the planning model. After the first successful `edit`/`write`/`apply_patch` of that request, the build model continues. Three failed tool calls in a row on the build model hand the rest of the request back to the planning model. A request switches at most twice because each switch re-sends the context without the other model's prompt cache. Compaction summaries go to the build model.

The dashboard's New session dialog has a **One model / Plan + build** switch. In Plan + build, choose a card (Plan or Build), then a model from the list and a thinking level on the ladder; the list shows only signed-in providers, with starred favorites and recent picks first. The strip above the message box shows the current setup and highlights the model working now. Click it to change models in a running session: a different single model, a different build level, or switching between a single model and the same pair applies from the next message, while a new pair or planning level restarts the agent on the same conversation. Single models and pairs can use any level their models support; only eval isolation and the auto route stay at xhigh. Pi passes the other model's thinking as plain text. This is not a measured saving; `/cost` attributes every request to the model that answered.

**Autocompact.** The `autocompact` feature (on in the Windows defaults) runs Pi's own compaction when a run settles above its threshold, 300k context tokens by default, on a model with a larger window. `--autocompact-tokens N` (a whole number from 1 to 100000000, only with `autocompact` selected) sets another threshold, for example `bin/apex --autocompact-tokens 200000`; the dashboard's New session dialog has the same field. A threshold at or above the model's context window never compacts. Waiting for the run to settle avoids aborting work in progress, so one long request can pass the threshold before compaction. Pi's built-in threshold near the full window remains the fallback.

### Unavailable/deferred

- Core `bg`, `max`, `recovery`: unavailable in the Windows target. `bg` refusal before allocation is tested; Unix survival is not disguised as a Windows pass.
- Context `route`, `output`: Muse-specific; unavailable with Sol. `all` rejects if it would select these unsupported capabilities—choose supported names explicitly.
- OCI proposer execution, Harbor benchmarks and two-model performance/cost targets: deferred, not waived or completed.
- POSIX executable modes, FIFOs and Unix process groups: out of Windows scope.
- File-symlink proofs requiring Windows privileges: still unexercised when privileges are absent. Directory-junction, hard-link, ACL and rollback coverage remains active. No elevation is requested.
- Windows PowerShell 5.1 console (conhost): Pi's default `system` theme draws inline code, list bullets and other violet accents in ANSI palette slot 5, which that console's palette maps to its own background, so those spans look blank. Pick Pi's `dark` theme once via `/settings` (it persists; its truecolor violet was verified readable there). Apex does not rewrite Pi settings.

## Storage and recovery

Shaping, checkpoints and newly written learnings share atomic owner-only Windows `.apex` creation. Existing public `.apex` directories are rejected for private writes without silently changing ACLs. Back up/review any existing directory before migrating it; do not delete existing checkpoints just to make a check green. Private spills pin native ancestor handles, reject reparse/hard-link entries and retain exact hook-visible output. Checkpoint snapshots inherit the private root and preserve source bytes and the user's Git index; source ACL restoration, cross-process checkpoint locking and interrupted transaction replay are not claimed.

## Evidence and completion

Fresh evidence is recorded in `RESULTS.md` and `validation/windows-*.json`/logs. `test:windows` has 486 Node passes and 43 explicit skips; the earlier full Node+Python run (646 passes, 45 skips) is audited in `validation/windows-skip-audit.json`: 29 outside native Windows scope, 15 file-symlink privilege restrictions and one unavailable optional TypeScript checker. Six native micro contracts cover 123 checks, including 36 Sol-selected offline checks; clean installation covers seven real package/CLI/spill checks. Live Sol feature acceptance (`windows-sol-live-007`, 24 checks, 10 requests) and an interactive PowerShell-console acceptance (`validation/windows-terminal-acceptance.json`) pass. These are not solve-rate or billing evidence. The original full-project definition of done remains false; Linux/Harbor/benchmark work stays deferred.
