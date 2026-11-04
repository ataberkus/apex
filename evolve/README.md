# Guarded harness evolution

Phase 4 implements a proposer → integrity check → micro-gates → dev/held-out evaluation → decision loop. It does not enable inference, change the working checkout, or promote default flags. No real proposer or benchmark iteration has run.

## Offline commands

```bash
bun run micro:evolve
bun run evolve -- --help
bun run evolve -- plan --campaign evolve/campaigns/search --estimate-usd 0.10
```

The last command is a preflight, not a launch or an approved cost forecast. Current offline-only policy returns a blocked result before campaign inspection, credential lookup, SDK initialization or allocation.

After independently authorized baseline measurements exist:

```bash
python -m evolve prepare --campaign evolve/campaigns/search --campaign-id search \
  --history artifacts/apex-phase3-local.bundle --baseline-commit FULL_BASELINE_COMMIT \
  --records COMPLETE_BASELINE_RECORDS.json --trace-root runs \
  --integrity-terms REVIEWED_LITERAL_INVENTORY.json
python -m evolve import --campaign evolve/campaigns/search --proposal PROPOSAL.json
python -m evolve decide --campaign evolve/campaigns/search --records COMPLETE_CANDIDATE_RECORDS.json
```

Inputs are real normalized arrays from the existing analysis pipeline, covering every frozen dev/held-out task with the same complete repetition policy. Placeholder, missing, raw-shaped or mixed records are refused. `--synthetic` labels mechanical campaigns and prevents real execution or promotion; it never turns fixture outcomes into benchmark evidence.

`prepare` accepts a local Git repository or full-history bundle. It exports every reachable runtime version, exact hash-checked dev raw JSONL and allowlisted scores. Runtime snapshots contain bin/lib/extensions/prompts/skills/templates and package metadata, not evaluator code, dataset manifests, credentials or Git metadata. Held-out/full raw files are never opened by the exporter; held-out scores are aggregate-only. Cross-split references inside otherwise-dev feedback also block preparation.

`import` accepts one declared change: `{schema_version:1,kind,change,patch}`, where kind is prompt/tool/policy/code. Standard LF text Git patches may touch runtime source only. Private Git commits preserve source checkout isolation. Binary/mode/rename/copy tricks, links/reparse points, unsafe paths, no-ops, entire-root deletion and protected evaluator/package edits are refused before application. Every guarded candidate remains available as a prior version, including rejected candidates.

## Acceptance and leaderboard

Equal-task pass fractions use a paired task-cluster bootstrap with independent within-task attempt resampling. Dev's lower 95% delta bound must be **strictly positive**; held-out's lower bound must be **nonnegative**. Inconclusive results are rejected. At least three independent tasks per split, exact frozen membership, matching model/protocol/checksums and unique trial identities are required. Attempts are never collapsed into best-of-N results.

Decisions retain unknown token costs as unknown and label registry estimates separately from invoices. `decide` writes an aggregate JSON/Markdown leaderboard with candidate/base commits, patch hash, confidence intervals, token/cost/wall metrics and synthetic provenance. Held-out task identities and arbitrary record text are not published. Existing caller-supplied trace/result binding remains explicitly unverified.

## Authorized automation

`run` requires renewed paid-enabled permission, the selected Muse/xhigh policy, full real baseline feedback, reviewed expected-output literals, a whole-iteration estimate, available budget and a configured local Docker evaluator. `evolve/config.json` caps iterations at 10 and bootstrap samples at 5000; its image is intentionally unset. It must name an **already installed immutable image digest**; the controller never pulls or installs one.

The trusted Linux image must contain Bun 1.4.3 (on `PATH` as `bun`; every proposer, check, test, micro and pack step runs through it), Pi 1.4.0, the current Apex verification scripts/tests in `/opt/apex`, pinned Harbor/Python tooling and their existing offline dependencies. Proposer and verification resource limits apply only to engineering containers, not benchmark tasks. Verification containers use an ephemeral writable image filesystem and read-only candidate mounts; they receive no credentials or network. The proposer mounts curated corpus read-only and proposal output writable, with only confined read/list/submit tools. It cannot read `/proc`, environment, evaluator state, host paths or credentials. Discovery, retries, cache warming and compaction are disabled. The reused native request guard caps it at six physical requests, 6144 completion tokens/request and 32768-byte payloads, with a $0.03 catalog-token reservation ceiling; that is not an invoice guarantee.

The controller checks the exact Harbor source distribution, uses the explicit local Docker endpoint and an empty Docker config, and invokes unchanged benchmark attempts/resources/timeouts. It retains per-trial final outcomes and exact native sessions; missing/unscored/extra outcomes stop evaluation rather than being silently dropped. Candidate code never runs on the host. A failed/interrupted evaluation stops the campaign for review; no automatic replay or stale-lock takeover is provided.

Whole-iteration spend reservations include proposer, every dev/held-out attempt and container costs. Unknown billing retains its reservation. `reconcile --receipt FILE` is offline and requires reviewed caller-supplied receipts covering proposer/dev/heldout/container, finite amounts summing to billed_cost_usd and unique evidence files with matching SHA256 hashes. It records actual over-cap spend honestly and blocks new work; it does not authenticate invoices or impose a provider-side hard spending limit.

Integrity inventories are private JSON with `expected_outputs` literal strings and `reviewed:true`. Rules also include every frozen dataset task name/path, verifier identifiers and observed dev absolute paths. Lexical normalization catches literal references, not arbitrary obfuscation or semantic unity; adversarial proposals still require independent code review. No verifier/test contents are fetched to build the inventory.

## Observed verification

49 Phase 4 checks pass (6 Node, 43 Python); two file-symlink cases are skipped for host privilege restrictions. The actual CLI/Git/raw-file smoke passes 14 checks, with explicitly synthetic outcomes and no inference. Exporting the retained Phase 3 bundle passes for 12 real commits and 331 runtime files. Actual model-backed proposer, OCI verification and Harbor benchmarks remain unexercised. Broader project gates do not pass in this checkout: pinned local Pi/Harbor dependencies are absent, and earlier platform-specific tests also fail. See `validation/phase4-*.log`, `validation/phase4-micro.json` and RESULTS.md; earlier passing Phase 3 evidence is preserved, not reused as a fresh Phase 4 pass.
