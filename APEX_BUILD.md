# Build brief: Apex — a token-efficient, benchmark-grade coding agent built on Pi

> **For the human:** Save this file as `APEX_BUILD.md` in an empty folder. Open a strong coding agent in that folder (Claude Code, Codex CLI, or Pi itself) and send: **"Read APEX_BUILD.md completely, then start Phase 0."** It will ask for your API keys, models, and a spending cap before running anything paid. "Apex" is a working name — rename it everywhere if you like. Everything below is addressed to the building agent.

---

## 0. Mission

You are the lead engineer building **Apex**, a terminal coding agent built on **Pi** (repo: https://github.com/earendil-works/pi — MIT; docs: https://pi.dev/docs/latest). Goals, in priority order:

1. **Solve more tasks** than stock Pi, and than each model's own vendor harness, with the same model — measured on Terminal-Bench 2.x (run through Harbor) and SWE-bench-style repository tasks.
2. **Cost less per solved task** than stock Pi: fewer uncached input tokens, fewer output and thinking tokens, fewer dollars.
3. **Add daily-driver features** without making every request more expensive.

Why this is realistic: on Terminal-Bench 2.0 the harness moves scores a lot. ForgeCode reported about 10 points above the vendor's own published number using the same Gemini model; the same Claude Opus model scored 58.0% in one harness and 74.7% in another; an automatically searched harness (Meta-Harness) reached 76.4% with that model. Those gains came from diagnosing specific failure modes and fixing them one at a time — not from one clever prompt.

**Governing metric:** pass rate (mean ± 95% CI over repeated runs) and dollars per solved task. Intuition proposes; evals decide.

## 1. Rules

1. **Build on Pi; don't fork it.** Deliver Apex as a Pi package (extensions, skills, prompt templates, system prompt) plus a thin `apex` launcher. Pi moves fast, and staying a package means upstream fixes arrive for free. Patch Pi core only when no extension point exists; keep such patches as a small, documented patch series and draft an upstream PR for each. Pin the Pi version and write `scripts/upgrade-pi.sh` (bump → `npm run check` → tests → micro-evals).
2. **The source beats this document.** This brief reflects Pi's docs as of October 2026. Read the real code before designing (Phase 0). Where they disagree, follow the source and record the difference in `NOTES.md`.
3. **Every feature is a flag with an ablation.** Nothing becomes default unless evals show it raises pass rate, or holds pass rate while cutting cost. Log evidence in `DECISIONS.md`: change → Δpass rate (± CI), Δtokens, Δ$, Δwall time, runs used.
4. **Zero-token features first.** Logic in harness code (hooks, commands, routers, UI) costs no tokens. Anything the model sees on every request (system prompt, tool schemas, injected notes) must earn its tokens in an eval.
5. **Benchmark integrity.** No task-ID or dataset detection, no hardcoded answers, no reading verifier or test files, no changes to task timeouts or resources, no memory carried between eval tasks. Tune on a dev split; report held-out and full runs. Results that use N parallel attempts are reported as a separate configuration. Top leaderboard entries get re-run by the maintainers — an unreproducible score is worse than no score.
6. **Spend guard.** Ask me for a budget cap before any benchmark run. Estimate the cost before each run and ask before exceeding it. Iterate on small subsets; full runs only at milestones.
7. **Small verified steps.** After each change: `npm run check`, unit tests, micro-evals. Commit messages state the measured effect.
8. **Consistent names.** Tool names used in the prompts (§6) must match the tools you actually implement; update both together.

## 2. Phase 0 — Learn Pi and build the measuring stick (no features yet)

**Ask me once, up front:** which providers and API keys I have; the MAIN model (strongest) and FAST model (cheap and quick); the budget cap; where containers run (local Docker or a cloud sandbox such as Daytona or Modal); my OS.

**Read, then write exact names and signatures into `NOTES.md`:**
- Repo root `AGENTS.md` and `README.md`; `packages/coding-agent/docs/`: how-pi-works, extensions, compaction, virtual-models, skills, packages, sdk, json, rpc, settings, configuration, security, containerization, mcp.
- `packages/coding-agent/src/core/extensions/types.ts` (every event and result type), `src/core/compaction/`, and the source of the built-in tools (read, write, edit, bash, grep, find, ls). Answer in NOTES.md: current truncation limits and whether full output is already spilled to a file; whether shell state persists between bash calls; how background processes behave; the edit tool's argument names.
- `packages/coding-agent/examples/extensions/`: `todo.ts`, `truncated-tool.ts`, `dynamic-tools.ts`, `custom-compaction.ts`, `jev-router.ts`, `debug-provider.ts`, and any subagent examples.
- Decide how Apex's system prompt is installed: a launcher-set agent directory (`PI_CODING_AGENT_DIR`) containing `SYSTEM.md`, or `before_agent_start` prompt sections. Prefer structured sections so Pi keeps appending context files, the skills list, and tool guidance.
- Record provider pricing (input, cache read, cache write, output) from official pricing pages in `evals/pricing.json` so dollar figures are correct.

**Build the eval harness (`evals/`):**
- **Harbor** (`uv tool install harbor`). Check `harbor run --help` and `harbor datasets list` for current dataset names: Terminal-Bench 2.0 for leaderboard comparability, 2.1 as the cleaner dev target, plus SWE-bench variants. Baseline stock Pi with Harbor's built-in `pi` agent. Then write an Apex installed-agent adapter (references: Harbor PR #1272 and https://github.com/badlogic/pi-terminal-bench — check whether the `/tests` upload fix described there is still needed) that installs Pi + Apex and runs headless with JSON event logs.
- **Splits:** a dev subset of ~15–20 discriminating tasks (drop tasks that every agent passes or every agent fails); a held-out subset of ~20 tasks whose trajectories you never study while tuning; full runs at 5 attempts per task (the official leaderboard protocol) only at milestones.
- **Metrics per task and run:** pass; input tokens split into uncached / cache-read / cache-write; output and thinking tokens; $; wall time; turns; tool calls per tool; tool errors by class (wrong tool, bad arguments, precondition not met); compactions; peak context. Report mean ± 95% CI. A difference inside the noise is not a win.
- **Trace store:** every trajectory saved raw (JSONL) under `runs/<run-id>/<task>/`, tagged with the harness commit hash. Raw traces, not summaries — you need them for failure analysis and Phase 4.
- **Failure classifier:** label each failed trace — wrong entry point, tool misuse, timeout, premature finish, dependency/environment mistake, didn't verify, broke existing behavior, doom loop, lost context after compaction, other. This table sets your priorities.
- **Micro-evals** (run in minutes; they gate every change): tool-call correctness per tool per model; edit apply rate; todo compliance on multi-step tasks; verify-before-finish rate; compaction survival (resumes correctly after a forced compaction); background-service survival after the agent exits; skill-routing accuracy.

**Exit criteria:** a baseline table for stock Pi (dev, held-out, and full Terminal-Bench if budget allows), the top five failure classes, and a token breakdown (share of input from tool results vs. system/tools vs. conversation).

## 3. Phase 1 — Token efficiency (`extensions/apex-context`)

Phase 1 comes first because cheaper runs make every later experiment cheaper. Exception: if one success-rate failure class dominates the Phase 0 table (for example premature finish), fix that first.

Target: dollars per solved task ≤ 60% of stock Pi with no pass-rate loss. Implement in this order and measure each item.

1. **Cache discipline** (the largest lever, and free).
   - Keep the request prefix byte-stable: system prompt and tool list fixed for the whole run, and identical across tasks and sessions so concurrent runs can share the provider's cached prefix where supported. Never put timestamps, remaining time, git status, or anything volatile in the system prompt; deliver volatile information as small appended messages.
   - The transcript is append-only; don't rewrite old messages per request. Tool-set changes go through Pi's delta mechanism and should be rare.
   - Router stickiness: continuations and retries stay on the same physical model (return `previous` / `failed`) except at planned phase switches.
   - Check, per provider, whether changing the thinking level invalidates cached messages; if it does, change it only at phase boundaries.
   - Treat cache-hit rate as a first-class metric and fail CI on regressions.
2. **Tool-result shaping** (`tool_result` hook; extend Pi's existing truncation rather than duplicating it).
   - Strip ANSI codes and progress bars, collapse repeated lines (`…×312`), keep head + tail with a clear truncation marker.
   - Spill full output to `.apex/out/<id>.log` and tell the model the path, so it greps the log instead of re-running the command.
   - Command-aware condensers: test runners → failing tests, assertion diffs, summary line; package managers → errors plus final status; compilers and linters → first N distinct errors with file:line; `git diff` / `git log` → capped.
   - When a handler replaces `content`, it must replace `structuredContent` too.
3. **Batched observation masking.** Old tool results are usually the largest input cost. Replace tool results older than the last K turns with one-line stubs, e.g. `[elided: bash "pytest -x" → exit 1, 812 lines; full log .apex/out/123.log]`. Apply masking in batches (for example when the unmasked older region exceeds T tokens) as persisted context edits at `turn_end`, so the cached prefix breaks rarely. Never mask the task, the contract or todo state, or the latest read of a file that is about to be edited. Tune K and T per model and measure both $ and pass rate — with caching on, old results already cost cache-read prices, so savings are smaller than raw token counts suggest. Evidence: JetBrains/TUM found simple observation masking roughly halves cost versus an unmanaged agent while matching LLM summarization's solve rate (arXiv 2508.21433).
4. **Coding-specific compaction** (`session_before_compact`): summarize with the FAST model using §6.6; copy todo and contract state verbatim from branch state — never paraphrase it; keep Pi's read/modified file lists. Tune `reserveTokens` / `keepRecentTokens` per model via `compaction.modelOverrides`. Gate with the compaction-survival micro-eval.
5. **Cheaper reading and search.**
   - Enable `grep`, `find`, `ls` (ripgrep-backed) with result caps and per-file grouping; on overflow, return counts and suggest narrowing.
   - `read` defaults to line ranges for large files; add an outline mode (tree-sitter or ctags symbols with line numbers) so the model reads the right 80 lines instead of 2,000.
   - Re-read dedup: if a file is unchanged (hash) and its last read is still unmasked in context, return a short pointer to it; if it changed, optionally return a diff since that read (flag it; measure it).
6. **Cheaper, more reliable edits.** Match the edit tool's shape to each model family's training priors: exact-replacement edits with conventional argument names (ForgeCode measured fewer tool-call errors after renaming its arguments to `old_string` / `new_string`), and a patch-style tool for models trained on patch formats. Pick per model with micro-evals. Add multiple edits per call, whitespace-tolerant matching that returns the closest match on failure, and a compact diff as the result — never the whole file.
7. **Lazy capabilities.** Rarely used tools (MCP servers, web, tmux, LSP, …) get `deferred` or `codemode` exposure so they cost nothing until needed; use Pi's `tool_search` and `codemode`. Encourage codemode for bulk work (read ten files and print only the matches; apply one change across many files), since only printed results enter context.
8. **Routing and thinking policy** (`pi.registerVirtualModel`, id `apex/auto`): MAIN for planning and verification; FAST for mechanical execution, subagents, contract extraction, and summaries. Progressive thinking: high for roughly the first 10 assistant messages, low or medium during execution, high again after a failed verification or a detected loop. ForgeCode credits a tiered policy like this, plus low-thinking subagents, for part of its climb to 78.4% on Terminal-Bench 2.0. Keep the phase in router state.
9. **Output discipline.** The system prompt forbids narration; where the provider allows it, cap output tokens on routine turns.

## 4. Phase 2 — Success rate (`extensions/apex-core`)

Target: pass rate above stock Pi with the same model, by more than the CI. Every item sits behind a flag and gets measured. Start with items 1, 3, 5 and 6 — the largest published gains — then follow your failure table.

1. **Environment snapshot**, injected once as the first context message (not in the system prompt): OS/distro, shell, CPU/RAM/disk, user, working-directory tree (depth 2, gitignore-aware), runtimes and versions, package managers, key CLIs present or missing, git status, listening ports and running services, network reachability (2-second probe), build and test entry points (Makefile, package.json scripts, pyproject, etc.). About 600 tokens at most. Meta-Harness's automatically discovered Terminal-Bench harness did exactly this to eliminate wasted probing turns (arXiv 2603.28052).
2. **Entry-point discovery:** extract identifiers, paths, and keywords from the task; rank candidate files (ripgrep hits + symbol map + filename match); append the top ~10 with one-line reasons to the snapshot.
3. **Headless profile** (`--headless` via `pi.registerFlag()`; auto-on in print/json/rpc modes or without a TTY): appends §6.2 instead of §6.3; sets the environment for non-interactivity (`CI=1`, `DEBIAN_FRONTEND=noninteractive`, `PAGER=cat`, `GIT_PAGER=cat`, `PIP_NO_INPUT=1`, `npm_config_yes=true`, …).
4. **Task contract:** one FAST-model call (§6.7) turns the task into verifiable requirements. Send it into context (`pi.sendMessage`) and mirror it in structured state; it seeds the todo list and drives the gate below.
5. **Enforced todo** (start from Pi's `todo.ts`): if the task has three or more steps and no todo exists after two turns, steer once; show only list deltas. ForgeCode's Terminal-Bench 2.0 pass rate went from 38% to 66% when its todo tool became enforced instead of optional.
6. **Verification gate** (`agent_before_settle`): before the run settles, check (a) every todo item is done or dropped with a reason, (b) at least one verification action happened after the last file change, (c) contract artifacts exist at exact paths in the right format. If not, append §6.8 and continue. At most two forced continuations per run — an unguarded continuation loops forever.
7. **Loop breaker:** the same command with the same error three or more times, edit ping-pong on the same lines, or repeated identical reads → append §6.9 and raise thinking for one turn.
8. **Process management:** a `bg` tool (start / poll / tail / kill; detached with setsid + nohup; logs in `.apex/bg/`) and default per-command timeouts so a hung command can't eat the time budget. Explicitly test that required services survive agent exit. Optional deferred `tmux` tool for genuinely interactive programs (REPLs, curses UIs).
9. **Time awareness:** `--time-budget` (the Harbor adapter passes the task timeout when available). Append §6.10 at 50%, 75% and 90% of the budget. Never in the system prompt.
10. **Tool-call correction** (`tool_call` hook): normalize near-miss argument names, resolve relative paths, check that the edit target text exists before executing (return the closest candidates if not), and — in interactive mode only — confirm catastrophic commands.
11. **Post-edit diagnostics:** when a fast checker exists (`tsc --noEmit`, pyright or ruff, `go vet`, `cargo check`), run it on touched files and append only the errors the edit introduced.
12. **Subagents** (depth 1, FAST model, fresh context): `explore` (§6.4) and `verify` (§6.5). A fresh context doesn't inherit the main agent's assumptions.
13. **`max` profile** (off by default): N independent attempts in isolated copies of the environment (git worktrees for repository tasks, container snapshots otherwise), pick by verification results, tie-break with a judge. Always reported as its own configuration.
14. **Recovery:** provider errors → retry with backoff, then fail over through the router's `failed` path.

## 5. Phase 3 — Daily-driver features (zero-token or deferred)

- **`/cost` footer:** uncached / cached / output tokens, cache-hit %, $ per task and per session, context %, routed model.
- **Checkpoints + `/undo`:** shadow-git snapshot before each file-mutating turn; restore by turn.
- **`/review`:** run `verify` on the current diff.
- **`/plan`:** read-only mode (only read and search tools active) that writes `PLAN.md`, then switches back.
- **Project learnings:** a `remember` tool that appends durable project facts (build commands, gotchas) to `.apex/LEARNINGS.md`, loaded like AGENTS.md. Disabled in eval mode.
- **Skills** (short SKILL.md + scripts, loaded on demand): debugging, test-writing, profiling, build systems, Python environments and packaging, numerics and data fitting, web servers and HTTP, databases, git surgery, security hardening.
- **Interactive safety profile:** confirm destructive or open-world tool calls using tool annotations (the pattern is in Pi's extension docs); off in sandboxed eval mode.
- **`apex report <session>`:** token breakdown by category and the top token consumers.
- **Crash resume:** check whether `@earendil-works/pi-durable` provides resumable runs; use it if so.

## 6. Runtime prompts

Write these as files under `prompts/`, then change them only with eval evidence. Keep the core system prompt under ~900 tokens. Placeholders in `{braces}` are filled by harness code.

### 6.1 `prompts/system.md` — core system prompt

```text
You are Apex, an autonomous coding agent working in a terminal. You carry each task through to a verified result with your tools, then report briefly.

# Workflow
1. Orient. Read the task and the environment snapshot. Identify the exact deliverables (files, paths, formats, commands, expected output) and constraints. For work with three or more steps, create a todo list before acting and keep it current.
2. Locate. Search before reading. Start from the suggested entry points. Read only the line ranges you need.
3. Act. Make the smallest change that fully solves the task. Prefer editing to rewriting. Put independent reads and searches in the same turn so they run in parallel.
4. Verify. After your last change, prove it works: run the tests, the program, or a check you write, and confirm each deliverable exists exactly as specified. If a check fails, fix it and verify again.
5. Finish. Stop once every requirement is verified, or once you've established that something can't be done — then say exactly what and why.

# Tools
- read: use offset/limit or the outline for large files. Don't re-read files that haven't changed.
- edit: the text you replace must match exactly once; include a few lines of context. Use write only for new files or small full rewrites.
- bash: non-interactive commands only (yes-flags; no pagers, editors, or prompts). Add a timeout to anything that could hang. Don't rely on shell state (cd, exports, activated environments) carrying over between calls: chain with && and use absolute paths.
- bg: start long-running processes here (or with `setsid nohup CMD > LOG 2>&1 &`) and poll their logs. Anything the task needs running at the end must still be running after you exit — check it.
- Truncated output is saved to a log file. Search that file instead of re-running the command.
- explore / verify: use explore for broad codebase questions and verify for an independent check of finished work. Handle small lookups yourself.

# When stuck
If an approach fails twice, don't repeat it unchanged. State the actual error, list plausible causes, and check your assumptions — paths, working directory, versions, and which interpreter and environment the task's own commands use. Then change approach.

# Environment
Install dependencies where the task's own commands will run (the default interpreter and PATH) unless the task says otherwise. Before finishing, confirm the result works from a fresh shell, not just inside your session.

# Efficiency
Time and tokens are budgeted. Think before acting, but don't narrate plans or repeat tool output back. Keep messages short. Final message: what changed, how it was verified, and any assumptions — a few lines.

# Integrity
Never fake success. Don't hardcode expected outputs, special-case test inputs, weaken or delete tests, or claim a check you didn't run. If something can't be done, say so plainly.
```

### 6.2 `prompts/mode-headless.md`

```text
# Headless mode
No one is available to answer questions. Don't ask for clarification or confirmation: take the most reasonable interpretation, note your assumptions in the final message, and keep working until the result is verified. Don't delete files, processes, or state that the deliverable depends on; clean up only what the task asks for. Short time notes may appear during the run; when time is short, converge on a working, verified solution rather than a perfect one.
```

### 6.3 `prompts/mode-interactive.md`

```text
# Interactive mode
A user is present. Ask a question only when a wrong guess would be costly or hard to undo; otherwise proceed on a reasonable assumption and mention it. Before destructive or irreversible actions outside the project (deleting data, force-pushing, changing system configuration), get confirmation.
```

### 6.4 Subagent: `explore`

```text
You are a read-only codebase scout. Answer the question you were given using search and targeted reads. Don't modify anything.
Reply in at most ~300 tokens:
1. The direct answer.
2. Evidence as `path:line — what is there` lines.
3. Open questions, only if they matter.
Don't describe your process.
```

### 6.5 Subagent: `verify`

```text
You are an independent verifier. You receive the task's requirements and the current changes. Your job is to find real defects, not to approve.
1. Check each requirement concretely: run the tests or the program, inspect output files (exact path, format, content), and try the edge cases the task mentions.
2. Check that previously working behavior still works (run existing tests where they exist).
Don't modify project files. Reply with `VERDICT: PASS` or `VERDICT: FAIL`, then for each failure: the requirement, the evidence (command plus the relevant output lines), and the likely fix. Be brief.
```

### 6.6 Compaction summary instructions

```text
Summarize this coding session so work can continue without the original messages. Be concrete and terse; prefer exact paths, commands, and values over prose. Use these sections and omit any that would be empty:
## Goal and deliverables (exact paths, formats, acceptance checks)
## Constraints and preferences
## Verified facts (with path:line where relevant)
## Working commands (build / test / run, with working directory)
## Tried and failed (approach → why it failed)
## Current state and hypothesis
## Todo (copied verbatim from the latest todo state)
## Next step
Include tool output only where specific lines matter.
```

### 6.7 Contract extraction (FAST model)

```text
Extract the acceptance criteria from the task below as a JSON array. Each item: {"id": "R1", "requirement": "...", "check": "..."}, where "check" is a concrete way to verify it (a command, a file path with expected format or content, a value with tolerance). Include requirements the task clearly implies (for example: output at the exact stated path; existing tests keep passing). Don't invent requirements. Output only JSON.

Task:
{task}
```

### 6.8 Verification-gate message

```text
Before finishing, these items are still open:
{unmet_items}
Resolve and verify each one, or state concretely why it can't be done. Then finish.
```

### 6.9 Loop-breaker message

```text
The same failure has now happened {n} times: {failure_summary}. Stop repeating this approach. State the exact error, list two or three different possible causes, and choose a different approach.
```

### 6.10 Time note

```text
Time check: about {remaining} of {total} left. Converge on a working result, verify it, and finish.
```

## 7. Phase 4 — Self-improvement loop (`evolve/`)

Automate harness engineering, following Meta-Harness (arXiv 2603.28052; code at https://github.com/stanford-iris-lab/meta-harness):

- A proposer agent (Claude Code, Codex, or Pi) gets filesystem access to every prior harness version, its raw traces, and its scores, and proposes one change per iteration (prompt, tool, policy, or code).
- Evaluate each proposal on the dev split. Accept only if dev improves beyond noise and held-out doesn't regress. Keep a variant leaderboard in `evolve/leaderboard.md`.
- Give the proposer raw traces, not just scores or summaries — the paper's ablations found that score- or summary-only feedback produced much weaker harnesses.
- Guardrails: the proposer never sees held-out traces; reject patches that mention dataset task names, task-specific paths, or expected outputs; cap iterations by budget. The paper also caught a regression where added "cleanup" instructions made the agent delete state it still needed — expect surprises like that and let the evals catch them.

## 8. Deliverables and definition of done

```text
apex/
  package.json              # Pi package manifest (fields per docs/packages.md)
  prompts/                  # §6 files
  extensions/
    apex-context/           # Phase 1
    apex-core/              # Phase 2
    apex-router/            # virtual model + thinking policy
    apex-features/          # Phase 3
  skills/
  templates/                # prompt templates: /plan, /review, …
  bin/apex                  # launcher: pi + Apex + profile (default | headless | max)
  scripts/upgrade-pi.sh
  evals/harbor/  evals/micro/  evals/analysis/  evals/pricing.json
  runs/  evolve/
  NOTES.md  DECISIONS.md  RESULTS.md  README.md
```

**Done** means `RESULTS.md` shows, for at least two MAIN models (ideally from different providers): stock Pi vs. Apex on full Terminal-Bench (5 attempts per task) plus the dev and held-out splits — pass rate ± CI, $ per solved task, tokens per task (uncached / cached / output), wall time — and an ablation row for every default-on feature.

Targets: pass rate above stock Pi outside the CI; $ per solved task ≤ 60% of stock Pi. If a target is missed, report that honestly, with what was learned and what to try next.

## 9. Pitfalls

- Don't start processes, sockets, watchers, or timers in an extension factory; start them from `session_start` and clean up idempotently in `session_shutdown`. Reload replaces the extension runtime.
- Guard every `continue: true` returned from `turn_end` or `agent_before_settle`; unconditional continuation loops.
- Tool calls from one assistant message can run in parallel: don't assume sibling results exist, and wrap read-modify-write operations in `withFileMutationQueue()`.
- Nested `ctx.executeTool()` calls don't add transcript entries; the calling tool must report their results itself and include nested model usage.
- Changing tools or the prompt mid-run can force a full transcript checkpoint and lose the cache.
- Background processes that inherit stdout can keep the bash tool waiting; always redirect their output.
- Tuning on the same tasks you report is overfitting. Keep the held-out split honest.

## 10. Working agreement

At the end of each phase, report: what you built, measured results, the top remaining failure classes, spend so far, and next steps. Ask before exceeding the budget or changing Pi core. Otherwise, work autonomously until the phase's exit criteria are met.

## References

- Pi: https://github.com/earendil-works/pi · docs https://pi.dev/docs/latest (extensions, compaction, virtual-models, configuration)
- Harbor (official Terminal-Bench harness): https://github.com/harbor-framework/harbor · Pi agent support: PR #1272 · adapter reference: https://github.com/badlogic/pi-terminal-bench
- Terminal-Bench 2.0 leaderboard: https://www.tbench.ai/leaderboard/terminal-bench/2.0
- ForgeCode, "Benchmarks Don't Matter — Until They Do" (seven failure modes and fixes): https://forgecode.dev/blog/benchmarks-dont-matter/ · Part 2: https://forgecode.dev/blog/gpt-5-4-agent-improvements/
- Meta-Harness: End-to-End Optimization of Model Harnesses — arXiv 2603.28052 · https://github.com/stanford-iris-lab/meta-harness
- The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management — arXiv 2508.21433
