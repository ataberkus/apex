# Native Windows milestone

Current scope: a native Windows daily-driver, not Harbor/Terminal-Bench completion. WSL, Docker, Linux image digests and Harbor are **not runtime prerequisites** for this milestone. Original benchmark criteria, frozen data and spending restrictions remain intact.

## Requirements and checks

- Native Windows Node >=22.19.0 and pinned Pi 0.99.2.
- Git for Windows/Git Bash, ripgrep (`rg.exe`) and fd (`fd.exe`) on the PATH the launcher inherits. Preflight checks that PATH only; a workspace `.tools/bin` is not counted. One working setup: copy `rg.exe`/`fd.exe` to `%LOCALAPPDATA%\Apex\bin` and append that folder to the user PATH (new shells pick it up).
- Windows PowerShell 5/.NET Framework, FullLanguage and permission to execute the bundled private-storage helper. Apex does not bypass execution policy.
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

Plain `apex` on native Windows applies `WINDOWS_AUTO` from `lib/windows-target.mjs` (see README "Native Windows"): every supported flag except `safety`, `compact`, `subagents` and `review`, with `checkpoints` only at a Git repository root and `headless` only with `--profile headless`. Any explicit Apex selection replaces the defaults; `--apex-off` runs stock Pi; non-Windows invocations are unchanged. Inspect an explicit configuration without inference:

```powershell
node bin/apex --apex-dry-run --apex-target windows --profile headless --apex-context "read,search,edit,shape" --apex-core "todo,verify" --apex-features "cost,checkpoints,plan,report" "Inspect this project"
```

`--apex-target windows` belongs in the Apex option prefix. It requires native Windows and selects exact `openai-codex/gpt-6.1-sol` at xhigh by default. An explicit `--provider` of `openai-codex`, `anthropic` or `opencode-go` with a plain catalog `--model` id selects that model instead, still at xhigh. API-key overrides, other providers, fallback lists, `:thinking` suffixes and model scopes other than the chosen `provider/model` are rejected. OAuth logins and the saved OpenCode Go key stay in a private Pi agent directory outside the project/package. The launcher selection is **not an OAuth credential validator, OS sandbox or provider-side spending cap**; it does not authenticate or reserve funds during dry-run. Ordinary non-dry-run prompts can consume account allowance.

The latest user instruction removes the previous $20 Codex-only testing cap; `evals/codex-budget.json` records no Apex dollar limit and preserves measured usage. OpenRouter spending remains frozen. Automated live tests still require bounded scope and physical requests/usage/deadline limits. The offline Windows gates read neither credentials nor that account and spend nothing. Auxiliary inference, model-generated `/plan`, independent `/review`, inferred compaction, max/recovery and automatic `apex resume` launch remain denied by the original offline policy. Literal `/plan save`, read-only plan enforcement, session inspection and native completed-transcript restoration work offline.

The dashboard uses the same selection: a GPT-6.1 Sol session with features starts with `--apex-target windows` (forced xhigh), and the New session dialog disables the unavailable route/output/bg/max/recovery flags. Selected safety prompts in both the terminal UI and dashboard sessions (Allow/Deny dialog).

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
