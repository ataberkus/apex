# Deferred Pi skills

These ten project package assets are advertised only when Apex's `skills` feature is explicitly enabled. The default `package.json` Pi skill list remains empty. They require no personal installation.

| Skill | Primary use | Probe evidence |
| --- | --- | --- |
| debugging | Runtime failures | Diagnostic, error-handling, and async sites |
| test-writing | Test coverage | Test files, known frameworks, and assertion sites |
| profiling | Performance bottlenecks | Timing sites, benchmark files, and probe Node/V8 runtime |
| build-systems | Build configuration | Public manifests, lockfile categories, and build declaration |
| python-packaging | Python distribution | pyproject tables, dependency files, environment-marker metadata |
| numerics | Numeric accuracy | Known numeric libraries, fitting, tolerance, and random sites |
| http | HTTP server behavior | Framework, server, route, timeout, and TLS sites |
| databases | Database schema | Migration, schema, transaction, query, and placeholder sites |
| git-surgery | Git history recovery | Marker type, HEAD mode, index presence, conflict markers |
| security-hardening | Security controls | Control libraries, validation, crypto, dynamic-execution sites |

Every skill references its own `scripts/probe.mjs` relative to its SKILL.md. Invoke the script using an already installed Node executable and `--cwd PATH`. Each script emits one JSON object, exits zero on a valid probe and one on a bounded error, and accepts no other arguments. Resolve the script from its skill directory; the project path may be absolute or relative to the invocation directory.

Probes read public source/manifests without importing or executing project code. They do not spawn commands, use the network, connect to databases, read database contents, inspect credentials, install dependencies, or mutate project files. Lockfiles, environment markers, index, and ignore/attribute files are inspected as metadata only. Git HEAD is read up to 1 KiB and only its symbolic/detached category is returned; worktree pointers, remotes, refs, logs, and objects are never read.

The shared scanner is in `_shared/` with no SKILL.md, so it is not a discoverable skill. Per-probe limits are 1,024 directory entries, 32 directories, depth 4, 128 public text files, 64 KiB per file, 512 KiB total public text, and 16 KiB output. JSON reports skipped files and truncation. Aggregate patterns can match comments and strings; absence of evidence is not absence of a problem. No model-routing accuracy, performance gain, or solve-rate improvement has been measured. Description-anchor fixtures verify only mechanical separation of ten chosen phrases.
