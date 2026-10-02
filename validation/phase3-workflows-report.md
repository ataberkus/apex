# Phase 3 workflows, learnings and safety

Task 3 is implemented in its owned modules, three focused test files and two internal templates. The latest focused run passed **30 tests, 0 failures**, using Node v24.19.0 at the public absolute `CODEX_PRIMARY_RUNTIME_NODE` path. No global npm/check/micro run, install, provider request, account access, credential read, core patch, remote operation or commit was performed by this worker.

## Test-first evidence

The initial run of the three newly written test files failed with three `ERR_MODULE_NOT_FOUND` errors because the implementation modules did not exist. After the first implementation, 23 tests passed. Four additional regression tests then failed as expected: previous-task assistant output could be saved, tool-use assistant text could be presented as final, and transient tool/persistence restoration failures could not be retried. The fixes passed all four. A later malformed-review-evidence regression failed before the review result validation fix. All 30 final tests pass.

Focused command:

```bash
env -i PATH="$PATH" LANG=C LC_ALL=C \
  CODEX_PRIMARY_RUNTIME_NODE="$CODEX_PRIMARY_RUNTIME_NODE" \
  PI_OFFLINE=1 npm_config_offline=true \
  npm_config_registry=http://127.0.0.1:9 \
  "$CODEX_PRIMARY_RUNTIME_NODE" --test \
  tests/features-workflows.test.mjs \
  tests/features-learnings.test.mjs \
  tests/features-safety.test.mjs
```

The run used only the listed environment values. Child Git fixture processes receive explicit public PATH/locale/offline values; review diff capture has its own small noninteractive environment, disables optional Git index writes and system/global Git configuration, and does not run a shell. The review test verifies the actual user Git index hash remains unchanged.

## Interfaces and native source evidence

| Interface | Result and behavior |
| --- | --- |
| `createPlanManager({cwd,pi,persist,branch,policy})` | `start`, `save`, `cancel`, `shutdown` return `{ok,active,reason?,path?,prompted?}`. `isActive()` returns a Boolean. `gate(event)` returns `undefined` or native `{block:true,reason}`. `finish(event,ctx)` returns native `{entries:[...]}` and preserves all existing boundary drafts. |
| Plan persistence | `persist({customType:'apex-plan-state',data})` receives a detached state object with version, active Boolean, per-plan UUID, task, previous tools, read tools and restoration status. Active state is reconstructed from the active branch or `compaction.details.apexState['apex-plan-state']`. |
| `runReview(options,ctx)` | Returns `{ok,blocked,reason?,result?}`. The injectable `verify(request,ctx)` receives `{cwd,task,commands:[],signal,policy}`. The default uses Phase 2 `createSubagentTools({policy})` and the native verify definition's `execute()` seam. |
| `createLearnings({cwd,evalMode})` | `tool()` returns deferred, sequential `remember`; `load()` returns `{ok,path,content}` or refusal; `append(fact)` returns `{ok,path,duplicate?}` or refusal. Exact path is `.apex/LEARNINGS.md`. |
| `createSafetyGate({pi,evalMode})` | `check(event,ctx)` returns `undefined` or native `{block:true,reason}`. Only TUI mode with dialog-capable UI invokes confirmation. |

Pi 0.99.2 source was read locally to establish actual APIs: `pi.sendUserMessage` always triggers a turn and accepts `expandPromptTemplates:false`; there is no `ctx.prompt` API. `pi.getAllTools()` exposes annotations. Native read/write/edit/search definitions have no annotations, verified by importing actual native definitions in a test. `ctx.ui.confirm` accepts `{signal,timeout}`. Native nested tool calls carry `parentToolCallId` and pass through the same `tool_call` hooks. Planning completion uses the current native branch after its persistent plan marker and the `agent_before_settle` outcome; it does not infer completion from a previous task's assistant.

## Verified behavior

- Offline planning enters read/search-only mode and persists active state without reading the model or sending a user message. Only `read`, `grep`, `find` and `ls` pass; bash, writes, edits, remember, codemode and unknown deferred/nested calls are blocked.
- Manual save preserves literal Markdown, including backticks, dollar signs and newlines, at exact `PLAN.md`. Writes are staged in a unique same-directory file, fsynced and atomically renamed. Symlink/nonregular targets are rejected. Concurrent target changes are compared before replacement. The normal path, cancel, shutdown, send error, failed write and failed completed boundary restore the prior tool selection.
- Reload preserves active plan enforcement and original tools, including state carried through compaction. Completed boundaries append an honest completion/error custom message while preserving prior drafts. Pending messages/continuations do not save. Aborted/error outcomes, missing output, previous-task output and assistant tool-use output cannot claim completion. Transient tool/persistence restoration failure is reported and retried on subsequent cancel/shutdown/start.
- Future authorized planning is tested only with injected message sending. Policy requires the exact Muse model and xhigh; the selected physical model or the fixed `apex/auto` virtual model and selected xhigh are checked before sending. The current offline policy starts no request.
- Review policy denial precedes cwd/task/context access, Git subprocess allocation, template reads and callbacks. The authorized injected seam receives actual current tracked staged+unstaged Git diff and requirements. Alternate policy identities, non-Git/unborn history, failed or malformed/noncomplete native verification evidence cannot claim success. No real auxiliary model session was run.
- Explicit learnings leave existing `AGENTS.md` unchanged and provide a bounded detached context-file record for the coordinator to append when selected. Concurrent appends across instances in this runtime serialize; duplicates are not added. Missing load creates no file. Eval mode rejects before cwd or tool-parameter getters and before filesystem work. Aborted calls, empty/NUL/oversized facts, excessive fact counts, oversized files and directory/file symlinks are refused.
- Safety uses conservative built-in classifications plus unverified annotation hints. File mutations, unknown custom tools, destructive/contradictory/open-world hints and general shell execution prompt in TUI. Simple literal echo/printf/pwd commands avoid destructive-string false positives. Nested calls receive the same check. Dialogs identify the actual tool and bounded arguments, have per-call cancellation and a 15-second timeout, and never cache approval. Decline, UI error, pre-abort, pending cancellation and an unresponsive UI block; late approval cannot undo the block. Eval, JSON, print, RPC and unavailable UI never invoke dialogs or query annotations.

## Bounds and limitations

- Plan Markdown is capped at 128 KiB and tasks at 20,000 characters. Prior tool lists are bounded to 256 names. Native selection restoration returns the previously captured set; the coordinator must shut down the old manager before replacing it on tree/fork/reload transitions. A failed persistence write may leave a stale active branch record until the reported retry succeeds; no success is claimed in this situation.
- Learnings allow 1,024 UTF-8 bytes per fact, 128 facts and 32 KiB of context. Serialization is in-process; external concurrent file changes are detected and refused. This implementation uses Node path/identity/no-follow checks and atomic replacement, not an operating-system directory-handle sandbox. Fully adversarial directory swaps by another local process are outside its guarantees. No automatic `AGENTS.md` editing occurs.
- Review diff capture is limited to 12,000 UTF-8 bytes and five seconds. It includes tracked staged and unstaged changes relative to HEAD. Untracked files, full binary changes and repositories without HEAD require separate inspection and are stated in the prompt/refusal. No test commands are implicitly executed. A future complete native review result still does not establish semantic correctness or execution-based verification.
- Safety approval is TUI UX, not an OS sandbox. Annotation hints are unverified. Headless/eval modes deliberately add no confirmation flow; existing policy/tool constraints remain responsible for execution authority. The simple literal-shell exemption is intentionally narrow and does not evaluate shell programs.
- The root owns coordinator registration, CLI command parsing, context-file selection, core plan-mode cooperation, compaction keys, native integration gates, global checks and commits. These were not edited by this worker. Paid routing, model accuracy, dollars per solve, empirical pass-rate improvements and default promotion remain unmeasured.
