# Phase 3 checkpoint validation

Implemented `extensions/apex-features/checkpoints.mjs` and its focused real-files/Git suite. Final focused run: **23 tests passed, 0 failed, 0 skipped** on Node 24.19.0, 2026-10-01 (11.2 seconds). Root retains ownership of coordinator, launcher, global checks, commits and final integration review.

## API and persistence

`createCheckpointManager({cwd,sessionId,runGit?,limits?})` performs no filesystem access, child creation, timer creation or repository discovery. Explicit methods are awaitable: `capture(turnId,{signal}?)`, `finish(turnId,{signal}?)`, `list({signal}?)`, `restore(turnId,{signal}?)` and `shutdown()`.

Records live in `.apex/checkpoints/<sha256(sessionId)>/state.json`, scoped to exact canonical cwd and the stable caller-provided session ID. The session directory and shadow worktree are private directories; manifests use mode 0600 and atomic temporary-file replacement after fsync. Git commits persist opaque payload files in a separate shadow repository. Source `.gitignore` and `.gitattributes` never become operative shadow configuration. Full regular-file permission bits are recorded independently of Git's executable bit.

Capture is an awaitable barrier. Same-turn sibling calls share the same pending promise, and managers in one process with the same cwd/session share a serialized queue. Capture returns only after the shadow commit and manifest are saved. Finishing records the after snapshot, sorted changed paths and before/after hashes and permissions. List/results are detached objects with `turnId`, `status`, `beforeCommit`, optional `afterCommit`, `changedPaths`, `capturedAt`, and optional `finishedAt`. Restore returns `restored`, or `already-restored` on repetition. Errors carry `name: CheckpointError`, a bounded code and, when needed, recovery details.

The optional trusted `runGit(args,options)` seam receives `{cwd,env,signal,timeout,maxBuffer,encoding,input?}` and returns `{stdout,stderr?,code?/exitCode?}`. Runners must pipe `input` to child stdin and honor the signal. The default runner does both. No shell is used. Git children receive only PATH/LANG/LC_ALL/CODEX_PRIMARY_RUNTIME_NODE from the caller plus explicit local Git isolation settings. System/global Git configuration, fsmonitor, hooks, global exclusions, prompting, optional index locks and signing are disabled. Shadow Git is explicitly routed to its owned worktree, common directory and object directory.

## Restore behavior

Only changed regular files are restored. Before the first source mutation, every changed path must still exactly match its recorded post-turn bytes and permissions, and must remain a safe non-ignored path. An unrelated manual edit to an unchanged path remains untouched. Manual edits, deletions, permission changes, new symlink leaves or ancestors, hard links, private paths and external paths fail closed. No user-repository `reset`, `clean`, `stash`, add, commit or index write occurs; tests hash the staged user index before and after real restore and rollback.

Both desired files and rollback copies are completely prepared inside a private transaction directory. Files are replaced with rename or removed individually, with a fresh path/hash check immediately before each mutation. A durable marker is written to the shadow Git only after the actual source changes, then the manifest is saved. Failures roll back applied files in reverse order. Rollback ignores cancellation so it can restore the interrupted operation's previous state, but refuses concurrent manual edits instead of overwriting them. A rollback failure returns `rollback-failed` with exact affected paths and retains the private backups. A post-commit cleanup failure is explicitly reported as `cleanup-failed` with `status: restored`; it cannot silently roll back already-committed metadata.

Dirty and untracked source is preserved, including dirty deletion, creation, binary bytes, literal newline/UTF-8 filenames, CRLF and ordinary permission changes. Existing directory permissions are outside the snapshot; missing parents are created safely with ordinary permissions, and removing an added file can leave an empty directory. File-to-directory replacements, submodules/nonregular source, hard links, external worktree Git pointers and backslash paths are unsupported and refused.

## Bounds

| Bound | Default hard maximum |
| --- | ---: |
| Candidate files per snapshot | 5,000 |
| Snapshot bytes | 64 MiB |
| Individual file/blob bytes | 8 MiB |
| Checkpoint records per session | 50 |
| Logical snapshot history/storage admission | 256 MiB |
| Manifest bytes | 16 MiB |
| Textual Git output | 4 MiB |
| Git subprocess duration | 10 seconds |

Callers may reduce these limits. Storage scans include abandoned snapshots and retained transaction backups; snapshot admission reserves a new mirror plus uncompressed-object and metadata allowances. Restore admission reserves both transaction directions. This is a conservative application budget, not a kernel disk quota; a child operation can add Git overhead between scans. Once a limit or unsafe path is encountered, the operation is refused. There is no automatic eviction. A finish failure leaves the capture unfinished and undo unavailable until a valid post-turn finish can be recorded.

Ignored files are excluded using the user's local Git ignore rules, including forced tracked ignored paths. Conventional private paths (Apex state, Git metadata, dependency/cache/tool directories, environment files, auth/credential files and common key filenames) are excluded; arbitrary secret content under an otherwise ordinary source filename is not classified. Private storage/shadow Git symlinks, alternate object stores, common-directory pointers and custom shadow attributes are rejected.

## Test evidence

The suite first failed because the implementation module did not exist. The first implementation run exposed an invalid `check-ignore -z` invocation (12/13 failures); the correction uses NUL-delimited stdin. A subsequent run exposed Git's ancestor-symlink error arriving before the manager's own check (12/13 passed); parent validation now precedes the restore ignore query. The filter fixture initially lacked an `info` directory under template-free Git initialization (19/20 passed); that fixture setup was corrected. A final targeted FIFO follow-up demonstrated real blocking opens: an isolated child replaced a regular source with a FIFO immediately after successful `lstat` and hit its 1.5-second test guard; after correcting source opens, the same test separately demonstrated the manifest open blocking. Both readers now use `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, verify the opened descriptor is a regular single-link file within its cap before reading, and verify size/times after reading. The final FIFO case exercised both refusals successfully in 441 ms under a 3-second subprocess guard. All runs were focused, offline and used real temporary Git repositories.

An independent review then identified that a regular file could grow between descriptor inspection and `readFile`, causing allocation beyond the admitted byte limit before the consistency check rejected it. Two test-first child-process regressions grew real source and manifest files immediately after their first descriptor stat and intercepted every descriptor read. Both initially failed because the reader called unbounded `readFile`. Source and metadata now allocate exactly `min(initial descriptor size + 1, configured byte cap + 1)` bytes and perform positional `handle.read` calls of at most 128 KiB, checking cancellation before and after every chunk. The extra byte detects growth while the allocation and bytes consumed remain bounded. Descriptor identity, size and timestamp checks remain after reading. Every manifest load propagates its available lifecycle/caller signal. Both growth tests now prove there is no `readFile` call, no buffer or total read beyond the admission bound, and no oversized chunk before conflict/metadata refusal.

The final 23 cases cover inert factory/pre-abort; dirty/staged/untracked/add/delete/permission restore and unchanged index hashes; sibling and separate-manager capture concurrency; persisted reopen/session isolation/detached records; content/mode/deletion conflicts; ignored/private preservation; source/private/shadow symlinks; newly ignored restore refusal; malformed metadata; file/byte/history/record caps; actual post-apply failure rolling back modified/added/deleted/mode changes; unfinished-turn refusal; cancellation; custom local `version-control` metadata; exact binary/CRLF/literal filename restore; hard links; unchanged manual paths; actual shutdown of active and queued jobs; bounded Git timeout; rollback's concurrent-edit refusal and retained recovery backups; blob reads beyond the text-output cap; external shadow indirection; rejection of untrusted shadow attributes before filter execution; actual regular-to-FIFO replacement immediately between path inspection and source/manifest opens; and the two descriptor-growth allocation/read regressions. These injections change only isolated test children; they add no production test seam.

Command:

```sh
env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  CODEX_PRIMARY_RUNTIME_NODE="$CODEX_PRIMARY_RUNTIME_NODE" PI_OFFLINE=1 \
  npm_config_offline=true npm_config_registry=http://127.0.0.1 \
  node --test tests/features-checkpoints.test.mjs
```

This is bounded local correctness evidence. It does not measure daily-driver undo success rates. The manager does not provide an OS sandbox, cross-process locking, fully atomic multi-file filesystem transactions, automatic recovery after process termination, or protection against a hostile process racing directory checks. The coordinator must await capture before every sibling's first mutation and await turn completion before finish/undo; branch selection and stable turn identifiers remain its responsibility. No provider, auth, credential, network, package installation, Pi core modification or global test command was used by this worker.
