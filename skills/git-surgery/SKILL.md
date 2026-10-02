---
name: git-surgery
description: Use when planning Git history repair, conflict resolution, worktree inspection, or recovery of repository changes.
---

Inspect the user's current work and choose a recoverable, narrowly scoped operation before changing history. The probe reports only repository-marker type, HEAD mode, index presence, ignore/attribute presence, and conflict-marker counts. It does not invoke Git, follow worktree pointers, read remotes, or modify the index. Preserve dirty work and obtain task-specific authorization for destructive history edits.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with an already installed Node executable and `--cwd /absolute/project` (use the public `CODEX_PRIMARY_RUNTIME_NODE` executable when provided). Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
