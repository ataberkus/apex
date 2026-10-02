---
name: python-packaging
description: Use when working on Python distribution metadata, environment layout, pyproject tables, or package dependency declarations.
---

Check build-system and project metadata, declared dependency files, and interpreter assumptions. The environment marker is directory metadata only; no environment is activated. The probe does not import Python packages or infer installed versions. Separate a packaging defect from an interpreter mismatch and validate with an already available, authorized interpreter.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with an already installed Node executable and `--cwd /absolute/project` (use the public `CODEX_PRIMARY_RUNTIME_NODE` executable when provided). Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
