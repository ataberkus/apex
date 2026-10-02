---
name: databases
description: Use when reviewing database schema, SQL migrations, query construction, or transaction boundaries.
---

Inspect schema changes, transaction boundaries, and query parameter conventions before changing persistence behavior. The probe counts static SQL and call patterns without opening data files or connecting to a database. Placeholder counts do not prove safe queries. Verify changes in an explicitly authorized disposable database fixture when one is available.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with an already installed Node executable and `--cwd /absolute/project` (use the public `CODEX_PRIMARY_RUNTIME_NODE` executable when provided). Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
