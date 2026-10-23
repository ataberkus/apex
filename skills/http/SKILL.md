---
name: http
description: Use when inspecting HTTP server routing, request timeouts, response handling, or local web service behavior.
---

Trace request parsing, route selection, status handling, and timeout ownership. Use declared framework and server-site evidence to choose the relevant files. No server is started and no request is sent. Reproduce behavior with an authorized local fixture, then check malformed input, cancellation, and the affected response contract.

Resolve `scripts/probe.mjs` relative to this SKILL.md. Run that absolute script path with Bun (`bun`, the runtime Apex runs on) and `--cwd /absolute/project`. Read its bounded JSON and scan limits before drawing conclusions.

The probe is read-only and offline. It skips private files and symlinks, imports no project code, runs no project commands, and performs no installs. Missing evidence stays unknown; static counts can include comments and strings.
