---
name: build-systems
description: Use when diagnosing build configuration, compiler pipelines, dependency lockfiles, or reproducible build setup.
---

Identify the declared build entry point, toolchain, and lockfile before changing configuration. Distinguish source errors from configuration and environment errors. The probe lists manifest and lockfile categories and whether a build script is declared; it does not run builds or resolve dependencies. Validate a targeted change with the project's authorized build command.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with Bun (`bun`, the runtime Apex runs on) and `--cwd /absolute/project`. Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
