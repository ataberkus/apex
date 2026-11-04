# Phase 3 independent assets and eval integration review

Reviewed the ten skill assets, their entry points, `skills/_shared/static-probe.mjs`, skills tests/report, Python feature validation, Harbor adapter/planner, Phase 3 registry and focused adapter tests against `PHASE3_DESIGN.md` and `APEX_BUILD.md` §5. This reviewer changed only this report. No implementation edits, global npm/check/micro, installation, provider/auth/credential access, network request or remote operation occurred.

**Result:** no blocking issue found in the covered normal inputs. One low-priority filesystem race robustness gap is recorded below. Focused verification passed **23/23 skills tests** and **16/16 Python adapter/planner tests**.

## Finding

### Low: a regular-file-to-FIFO race can stall a production skill probe

`skills/_shared/static-probe.mjs` `boundedRead()` opens a path with `O_RDONLY | O_NOFOLLOW` after the caller's `lstat()` and a canonical-path check. It checks regular-file type and inode/device after opening. If a source file is replaced by a FIFO between the metadata check and `open()`, the read-only open can wait for a writer before returning, so the later descriptor check cannot reject it. Static special files are correctly skipped, and symlink/hardlink defenses are present; this finding concerns only a concurrent replacement of an initially regular file.

The report states that the five-second deadline belongs to the test harness rather than production. Byte, file, directory and JSON limits therefore do not provide a production execution deadline for this condition. Suggested narrow fix: include `O_NONBLOCK` on the read-only open, retain the existing descriptor regular-file/inode checks, and add a regression that replaces a regular fixture with a FIFO before the open seam. This is a source-level finding; an adversarial concurrent FIFO replacement was not executed during this review. It does not establish an out-of-project read or write.

## Evidence assessed

| Requirement | Review evidence |
| --- | --- |
| Ten short skills loaded on demand | Ten matching frontmatter names and descriptions, one exact relative `scripts/probe.mjs` reference per skill, no discoverable shared helper skill. `package.json` retains an empty native skill list. The selected coordinator `resources_discover` hook advertises only the ten skills. |
| Native lifecycle and laziness | Pi 0.99.2 `AgentSession.bindExtensions()` emits `session_start` before `extendResourcesFromExtensions()`, which emits `resources_discover`. The coordinator sets flags in startup before discovery. Startup/reload ordering therefore supports selected discovery; default-off flags return no resources. Full skill content is not added through a prompt template expansion. |
| Real, read-only offline probes | Each entry point calls its fixed domain in the same built-in-only scanner. No child process, shell evaluation, project import, package resolution, database client, socket or installation exists in the scanner or entry points. Probes compute aggregate categories from real fixture files; profiling Node/V8 values identify only the running probe. |
| Sensitive content and traversal | Public source/manifest allowlists; private/hidden/dependency/build exclusions; symlink/hardlink/special-file refusal; bounded no-follow reads and inode/canonical-path checks. No source strings, manifest values, absolute project paths, branches, remotes or environment values are emitted. `.git` file pointers are not followed; only bounded HEAD category and index/ignore/attribute presence are reported. |
| Bounds and honest interpretation | Enforced entry/directory/depth/file/per-file/total-text/output caps. Static regex counts and declared libraries are labeled as static evidence, not installed packages, validated bugs, test coverage or runtime hotspots. Tests demonstrate cap behavior, empty/malformed manifests, privacy, pointer/symlink/hardlink rejection, and unexecuted malicious fixture code. |
| Python default preservation | Pure nine-feature parser defaults to empty. Existing adapter run string receives no feature/eval arguments when features are absent. Planner adds `feature_flags` only as its final optional parameter, retaining prior positional calls and variant labels. |
| Eval isolation | Feature variants insert `--apex-features FLAGS --apex-eval` before Pi/task arguments. Eval is explicit selected-variant configuration, not inferred from dataset or task text. Plan JSON records `eval_mode`; the root extension implements the actual pre-I/O learnings refusal. |
| Exact model and thinking | Selected context/core/feature variants require exact `openrouter/meta/muse-spark-1.3-contributor` and xhigh before parent initialization; selected variants default omitted thinking to xhigh. Effective provider changes are rejected before environment execution. The pinned Harbor `PiOptions` thinking alias matches adapter precedence. |
| Literal task and evaluator contract | Shell replacement uses the verified unquoted native run fragment and `shlex.quote` for selected flags. Task bytes remain in the parent-provided quoted argument. Combined phase prefixes retain explicit time notes while leaving actual evaluator timeout/resources untouched. |
| Preparation/free-only guards | Planner has no execute option, execution or reservation. Stock control cannot select features; unknown/duplicate/non-string flags, alternate model/thinking, invalid package and free-only budget policy produce no Harbor argv. Offline policy blocks even zero estimates. |

## Focused commands and results

The following commands ran with the explicit public PATH/locale/Node whitelist, `PI_OFFLINE=1`, npm offline mode and loopback registry. Python uses the already installed source-pinned Harbor runtime; no package installation occurred.

```bash
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  CODEX_PRIMARY_RUNTIME_NODE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node \
  PI_OFFLINE=1 npm_config_offline=true npm_config_registry=http://127.0.0.1:9 \
  /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --test tests/features-skills.test.mjs

env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  CODEX_PRIMARY_RUNTIME_NODE=/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node \
  PI_OFFLINE=1 npm_config_offline=true npm_config_registry=http://127.0.0.1:9 \
  .tools/uv/harbor/bin/python -m unittest discover -s tests -p test_phase3_adapter.py -v
```

Skills: 23 passed, 0 failed, exit 0, approximately 9.15 seconds. Adapter/planner: 16 passed, exit 0, approximately 0.057 seconds reported by unittest. Skill tests spawn only the fixed local Node probe entry points against disposable fixtures, with five-second child deadlines. Python container commands are captured by `FakeEnvironment`, never executed.

## Coverage limits

The ten chosen description-anchor phrases prove mechanical asset separation only. They do not measure native model routing accuracy, solve quality, performance or dollars per solve. No model inference, provider transport or real Harbor container run was performed. The focused Python tests verify prefix forwarding; the root's native gate remains responsible for proving the forwarded eval flag prevents learnings registration/load/write. This review read that coordinator path and found it consistent with the explicit configuration. Production time bounds and concurrent file replacement remain the specific probe gap above; hostile ancestor-directory swap guarantees were already explicitly excluded by the worker report.
