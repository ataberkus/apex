# Raw run storage

No benchmark runs exist yet. Ingested trajectories use:

`runs/<run-id>/<task-id>/attempt-<n>/trace.jsonl`

Each has metadata.json with harness commit, split, SHA-256 and size. Never overwrite raw evidence; incomplete logs are still preserved. Analyze authoritative native Pi session logs and retain streamed events separately when available. Harbor ATIF alone loses some Pi usage/context entries.

Failure-analysis tooling accepts only dev traces. Reports accept normalized aggregate measurements, including held-out metrics without raw text. This application-level guard supplements separate permissions/workspaces for a future proposer; it is not an OS sandbox against a program that intentionally opens files.
