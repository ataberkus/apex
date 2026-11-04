---
name: test-writing
description: Use when improving test coverage, adding regression cases, or designing assertions for specified program behavior.
---

Derive expected results from the requirement before reading implementation details. Cover the relevant success, failure, and boundary cases with real inputs. Use detected frameworks and assertion counts to locate existing conventions; counts do not measure coverage. Demonstrate that a regression test fails before the fix and passes afterward.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with Bun (`bun`, the runtime Apex runs on) and `--cwd /absolute/project`. Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
