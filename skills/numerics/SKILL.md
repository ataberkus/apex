---
name: numerics
description: Use when assessing numeric accuracy, curve fitting, floating-point tolerances, or reproducible random calculations.
---

State units, shapes, precision, and a reference result before changing a calculation. Check conditioning, residuals, tolerance choice, and seed assumptions. Static library and fitting-site evidence locates relevant code; it does not execute mathematics or establish stability. Compare the chosen fix against analytic or independently computed small cases.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with an already installed Node executable and `--cwd /absolute/project` (use the public `CODEX_PRIMARY_RUNTIME_NODE` executable when provided). Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
