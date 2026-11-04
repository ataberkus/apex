# Phase 1 design

APEX_BUILD.md §3 is the binding specification. The user requested Phase 1 after accepting local Phase 0 closure. Existing free-only authorization remains: no inference, provider/account requests, cloud resources, engine installation or Pi core changes. MAIN and FAST both remain `openrouter/meta/muse-spark-1.3-contributor`; thinking remains `xhigh`.

## Architecture

Use a Pi extension package and thin launcher. One extension entry coordinates independent modules for result shaping, persisted observation masking, compaction, efficient native tool wrappers, and virtual routing. All experimental features default to off. The launcher exposes `--apex-context <comma-separated flags>` as an Apex prefix, validates it, loads the extension explicitly and passes Pi's registered `--apex-context-flags`. Direct package loading is inert without flags. Feature state is session-local and is restored only from the active branch when necessary; no cross-task memory.

Native tool wrappers retain `read`, `edit`, `grep`, `find` and `ls`, adding bounded read/outline and conventional edit arguments only when enabled. `apply_patch` is a separate opt-in tool. Reuse Pi's truncation, multi-edit algorithm and file mutation queue. Keep coherent content and structuredContent for programmatic callers. Do not claim the shaped hook has unseen original output: native bash already spills full overflow; preserve that pointer. Additional spills store the actual hook-visible result with restrictive permissions and collision-resistant names beneath `.apex/out/`.

Masking creates batches of persisted `context_edit` entries at `turn_end`, never per-request transient rewrites, preserves other extensions' drafts, and never forces continuation. Age comes from active assistant messages rather than the turnIndex that Pi resets. Protect user/task/system/contract/todo messages, latest file reads, recent observations and nontext/error payloads that cannot be summarized reliably. Only text tool observations are eligible. Report byte/token estimates as proxies, not provider token savings.

Compaction uses §6.6, appends contract/todo branch state verbatim after the summary, preserves native recent retention and unions file bookkeeping from previous hook summaries. Offline policy returns cancellation before auth/inference. The inference-ready code path uses the exact allowed physical FAST model and xhigh, includes its usage, and cancels on errors. No unguarded fallback to default paid summarization. A fake deterministic summary is only a test adapter, never benchmark evidence. Per-model reserve/retention overrides are documented configuration rather than invented universal winning defaults.

Routing registers `apex/auto`, returns previous/failed physical selection on continuation/retry, and keeps phase state on the active branch. With MAIN=FAST it remains the same allowed Muse model at xhigh. Progressive lower thinking is not activated because the user explicitly selected xhigh; its policy can be ablated only after a changed configuration is authorized. Lazy tools use Pi's native `deferred`/`codemode` exposure and native tool_search/codemode implementations where source permits. No unsupported placeholder tools or free-form eval-time scripts.

Cache discipline is observable: stable Apex prompt sections/loadout per session, append-only metadata, no volatile prefix content, measured cache usage where known, and a deterministic stability gate. Pi itself includes cwd/project context, so identical full prefixes across different task workspaces cannot be promised without dropping useful native context. Provider cache hits and thinking/cache interactions stay unmeasured until real evaluation. Output discipline adds a short stable named section, with no nonexistent tools; routine output caps apply only through the verified provider request seam and remain opt-in.

## Verification and evidence

Test all flags, native wrappers, failure atomicity, masking persistence/branch projection, coherent shaping, compaction cancellation and state preservation, router stickiness and lazy exposure. Add a bounded offline Phase 1 micro gate; network/auth/inference must not occur. Run npm run check, npm test and npm run micro; collect a fresh independent review. Record flag-by-flag ablation rows with model outcomes unknown and no default-on feature. Local correctness cannot establish the ≤60% dollars/solved target or nonregression in pass rate. Preserve Phase 0 evidence and original raw traces.

## Execution rulings

- The supplied build brief's autonomous agreement and current instruction authorize implementation; generic skills' extra design handoffs do not require another permission question.
- Use the existing clean isolated workspace on branch `apex-phase1`; no remote push or main-branch merge. Disjoint implementation workers may run in parallel as required by the active collaboration policy.
- Finish the implementable local Phase 1 work and state explicitly that benchmark promotion/targets are pending. Do not enable unmeasured features to make the phase appear complete.
