# Phase 1 shaping worker

Scope: `extensions/apex-context/shaping.mjs` and `tests/context-shaping.test.mjs`; no dependencies, commits, credential/provider/inference/network/dataset/verifier calls. Public Pi 0.99.2 `truncateHead`, `truncateTail`, `withFileMutationQueue`, and native Bash ToolDefinition were used.

## Commands and observed results

- `node --test tests/context-shaping.test.mjs`: initial RED, 0/16 passed, missing module assertions.
- Same command: GREEN 16/16 after implementation; a subsequent progress-bar RED was fixed, then GREEN 17/17.
- Same command: real native overflow accounting RED was fixed, then GREEN 18/18. Native fixture produced 95,122 original structured bytes, separately accounted from already-truncated hook text.
- `node --check extensions/apex-context/shaping.mjs` and `node --check tests/context-shaping.test.mjs`: exit 0.
- `npm test`: concurrent integration snapshot 134/138 Node tests passed; Python did not run because Node failed. Failures: `standard unified lines beginning with --- and +++ remain valid hunk data` (`context-patch.test.mjs:121`, invalid hunk line/multiple file headers), and three missing Phase 1 gate cases (`phase1-micro.test.mjs`: inert import, native offline factory, ambient resource denial). Root and tools worker were informed; root owns final suite verification.
- Two additional edge tests produced RED 18/20: malformed native-source metadata and process umask `0777`. Root authorized fixing them before final freeze. Native paths now use only nonempty string candidates, with a valid structured pointer preferred over malformed details. Only freshly created, owner/inode-validated directories are restored to 0700; fresh validated regular-file handles restore 0600. Unsafe existing directory modes are rejected unchanged. Final focused command: GREEN 20/20; syntax checks exit 0. No further whole-suite command was run, per root instruction.
- P2 review follow-up: inspected native `AgentSession._afterToolCall()` and codemode `toScriptValue()`; native hooks run before codemode consumes `structuredContent`. A real native Bash 20 KiB JSON fixture produced RED 20/21 because shaping corrupted the nested program input. All results with `parentToolCallId !== undefined` now skip shaping without mutation or spill; final parent output remains eligible. Focused `node --test tests/context-shaping.test.mjs`: GREEN 21/21; both syntax checks exit 0. Tiny parent output remains unchanged; oversized parent output is bounded with exact recoverable log.

## Verified behavior

Exact original joined text-content logs; ANSI, carriage-return and newline progress cleanup; counted repetition collapse; byte/line caps including markers/newlines; Unicode character boundaries; head/tail and prioritized test/compiler/package/diff failure context; coherent native Bash output/exit/time/truncated fields; preserved valid native source pointer; image identity; unknown custom structured schema skip; import/no-op inertness; 16 simultaneous exclusive spills with malicious IDs, owned 0700 directories/0600 files even under umask 0777; unsafe existing directories left unchanged; static `.apex`/`out` symlinks rejected; atomic synced hard-link publication with cleanup.

## Limits and final state

Frozen for root integration. Nested programmatic results, unknown structured schemas, ambiguous interleaved image captions, and spill failures preserve the original result. Only parent-emitted model observations are shaped. Tiny caps may fit only a short elision marker; the recovery path remains in `details.apexShape.logPath`. Logs are explicitly `logScope: hook-visible-result`, `logFormat: text-content`; they do not claim to contain native pretruncation command output. Native structured-original byte count is separate.

The sandbox has neither `/proc/self/fd` nor `/dev/fd` (probe returned ENOENT). Descriptor-relative anchors are preferred where available; the fallback uses lstat/realpath, owner/inode checks, O_NOFOLLOW/O_EXCL and native serialization before/after publication. Static symlink traversal is rejected, but unrelated hostile ancestor-directory renames during a syscall cannot be fully excluded through Node's public filesystem API without fd paths/openat bindings. Condensers are conservative heuristics and provide no model benchmark or provider-token savings evidence.
