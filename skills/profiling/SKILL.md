---
name: profiling
description: Use when investigating performance bottlenecks, timing regressions, or benchmark methodology.
---

Define the workload and useful latency or throughput measure before optimizing. Use timing-site and benchmark evidence to find measurement entry points. The reported runtime name and version describe the probe runtime only. Measure repeated baseline and changed runs under comparable conditions; static signals do not identify hot paths.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with Bun (`bun`, the runtime Apex runs on) and `--cwd /absolute/project`. Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
