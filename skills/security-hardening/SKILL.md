---
name: security-hardening
description: Use when evaluating security controls, input validation, cryptographic API use, or structural hardening opportunities.
---

Identify the trust boundary and required invariant, then trace the relevant input and control path. The probe reports declared control libraries and static API patterns only; these are review leads, not validated vulnerabilities. Never request or read credentials. Prefer a focused reproducer and a test of the repaired security property over broad speculative changes.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with an already installed Node executable and `--cwd /absolute/project` (use the public `CODEX_PRIMARY_RUNTIME_NODE` executable when provided). Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
