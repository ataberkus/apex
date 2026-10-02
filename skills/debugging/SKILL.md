---
name: debugging
description: Use when diagnosing runtime failures, exceptions, or reproducible incorrect behavior in an existing program.
---

Reproduce the smallest failing input, distinguish expected from observed behavior, and trace the first incorrect state. Use diagnostic and error-handling counts to choose inspection points; they do not prove a cause. Change one cause at a time and rerun the original reproducer.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with an already installed Node executable and `--cwd /absolute/project` (use the public `CODEX_PRIMARY_RUNTIME_NODE` executable when provided). Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
