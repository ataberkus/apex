# Phase 1 tools worker

Owned files: `extensions/apex-context/tools.mjs`, `extensions/apex-context/patch.mjs`, `tests/context-tools.test.mjs`, `tests/context-patch.test.mjs`. No dependencies, core changes, provider/auth/network calls, commits or shared-file edits.

Native Pi 0.99.2 definitions, `prepareArguments`, renderers, optional `outputSchema`, session projection and `withFileMutationQueue` were inspected before implementation. Parameters use ordinary JSON Schema because TypeBox is a nested pinned Pi dependency rather than an independently resolvable root dependency. Native definitions remain the implementation boundary.

Commands and evidence:

- Initial `node --test tests/context-tools.test.mjs tests/context-patch.test.mjs`: RED, 0/16 passed; factories absent.
- Additional adversarial regressions exposed and fixed rejection of valid `---`/`+++` hunk data and fabricated totals for newline filenames.
- Final same focused command: GREEN, 24/24 passed, no skips; 3.72 seconds in the final recorded run.
- `node --check extensions/apex-context/tools.mjs`: PASS.
- `node --check extensions/apex-context/patch.mjs`: PASS.
- `git diff --check`: unavailable in the assigned cwd (`Not a git repository`); no Git metadata was changed.

Implemented behavior:

- Flags remain independent and imports/factories inert. `read`, `grep`, `find`, `ls`, `edit` retain conventional directly active names; `search` definitions explicitly set `defaultActive:true`. `apply_patch` is direct with `patch`, deferred only with `patch,lazy`.
- Read defaults to 80 lines, preserves native byte caps/continuation notices and image content. Outline uses an existing ctags JSON implementation when available and an explicitly approximate language-pattern fallback otherwise. NUL/invalid-UTF-8 files get a byte-count binary notice.
- Dedup requires identical whole-file and requested-range hashes, identical original observation content and the original read toolCallId still unmasked in the native active projection. Masked/empty/missing/compacted/other-branch observations and fresh factories cannot create pointers; no pointer chains. Cache holds at most 256 ranges.
- Edit conventional aliases, shorthand and native legacy/object/string preparation delegate multi-edit, fuzzy whitespace matching and realpath mutation serialization to Pi. Ambiguity/overlap failures leave files untouched and return at most three bounded approximate candidates. Successful diff text and structured text agree.
- Search delegates native caps and groups unambiguous grep rows. Early-stop totals and ambiguous plain-text filenames remain unknown. Absent PATH engines fail before native delegation; no engine installation is attempted.
- Patch accepts one existing UTF-8 file in a plain unified format, checks exact context/counts/old and new positions, then performs a queued same-directory atomic rename. BOM, unchanged CRLF/mixed endings, final-newline markers, permission bits and sibling native edits are covered. Creates/deletes/renames/multiple files/traversal/outside-cwd symlinks/git metadata/apply_patch envelopes are rejected before writing.

Limits: Read still reads the native full file before reducing model-visible text; dedup is a context-byte optimization, not an I/O optimization. ctags is optional and legacy ctags without JSON falls back. fd/fdfind is absent on this environment's PATH, so `find` availability is honestly reported rather than fabricated. The authorized launcher must retain Pi offline mode as the native download fail-closed backstop. Patch atomicity covers one queued file and process-visible rename, not power-loss durability, hard-link identity or transactions involving external writers. Modified lines use the file's first observed newline convention. No model performance, provider token savings, cost or pass rate was measured.
