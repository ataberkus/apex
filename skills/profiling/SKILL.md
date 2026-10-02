---
name: profiling
description: Use when investigating performance bottlenecks, timing regressions, or benchmark methodology.
---

Define the workload and useful latency or throughput measure before optimizing. Use timing-site and benchmark evidence to find measurement entry points. The reported Node/V8 versions describe the probe runtime only. Measure repeated baseline and changed runs under comparable conditions; static signals do not identify hot paths.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with an already installed Node executable and `--cwd /absolute/project` (use the public `CODEX_PRIMARY_RUNTIME_NODE` executable when provided). Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
