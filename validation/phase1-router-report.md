# Phase 1 router and lazy tool report

Owned files: `extensions/apex-router/index.mjs`, `extensions/apex-context/lazy.mjs`, `tests/context-router.test.mjs`, `tests/context-lazy.test.mjs`. No shared files, Pi core, dependencies, commits, credentials, benchmark tasks or verifier files were changed/read.

## Implemented contract

`createApexRouter({main,fast,thinkingLevel='xhigh'})` validates both identities as exactly `openrouter/meta/muse-spark-1.3-contributor`, accepting the full string or a native provider/id reference. All lower/off thinking is rejected. The returned native definition is provider `apex`, id `auto`, with only selectable `xhigh`. Its default export registers the definition at extension load, before model selection; the launcher must load this separate extension only for the explicit route flag.

Each route uses only `ctx.modelRegistry.find('openrouter','meta/muse-spark-1.3-contributor')`, verifies a physical model and exact xhigh mapping, and returns that canonical catalog object. Continuations validate and preserve the previous pair; retries prefer the failed pair, then previous. Unauthorized sticky references fail closed. MAIN and FAST remain identical, so no model-price reduction is claimed.

Phase derives from successful assistant entries on the active persisted branch, excluding errors/aborts: fewer than ten means planning, then execution. The latest valid `apex-routing` custom entry with `data:{phase:'planning'|'execution'|'verification'}` overrides this count rule. Returned state is `{version:1,phase,assistantMessages}`; an unchanged state returns the same object, avoiding redundant native state entries. Branch navigation recomputes state from the current branch. Direct summary requests always use Muse/xhigh and return no state. There is no model classifier or automatic parsing of benchmark/task names.

`registerLazyTools(pi)` runs native `createCodemodeExtension({models:false})` and `createToolSearchExtension()` factories, returning frozen `['codemode','tool_search']`. Both definitions stay inactive until coordinator activation at session_start. No MCP servers are registered. Rare-tool exposure is chosen by those tools' own definitions; native codemode/deferred behavior and tool_search perform discovery. No unsupported external capability is advertised.

## Verification

- RED: the initial `node --test tests/context-router.test.mjs tests/context-lazy.test.mjs` failed all ten cases because the feature exports were absent.
- GREEN: the same focused command passed 10/10 after implementation. One fixture initially used nonexistent MCP registry `getAll()`; it was corrected to pinned native `list()` before the passing run.
- Both production modules passed `node --check`.
- Router fixtures use native in-memory SessionManager, native extension loader/runtime and ExtensionRunner; the catalog is a strict read-only fixture whose other property accesses throw. Lazy fixtures load actual native factories into ExtensionRunner and execute native BM25 tool_search/loadout preparation, without AgentSession, ModelRuntime, auth or provider initialization. These synthetic mechanics do not measure model performance.

Whole-suite verification is not established by this worker. `npm test` was attempted during parallel workers' RED stage; Task5 cases passed, while unfinished components produced failures. The initial shell call was `exec_command({cmd:'npm test',workdir:'/workspace/scratch/06581feb7ad4',yield_time_ms:1000,max_output_tokens:5000})`, which returned running session `16925`. The rejected follow-up was `write_stdin({session_id:16925,chars:'',yield_time_ms:1000,max_output_tokens:1800})`.

Automatic approval review returned:

> The test command is task-related, but the requested phase explicitly forbids network access and this invocation contacted the public npm registry.
> Do not bypass this rejection through a workaround or indirect execution. Continue with a safer alternative, or carry out checks to prove that the action is authorized or low risk before trying again. Complete unaffected work without asking for confirmation. Report anything that remains blocked, clarify why it was blocked by auto-review, inform the user of the risk and ask for approval.

The visible command output did **not** include an identified registry URL or fetch trace. It included npm's `Unknown env config "http-proxy"` warning, the normal local test-script banner, and test results. Registry access is the review's stated finding, not independently proven by the captured stdout. No retry or indirect suite execution was made by this worker. Root will handle integrated verification with a materially safer offline setup and pinned local native helpers.

The observed unfinished-component failures were:

| Test file | Failed test names |
|---|---|
| context-compaction | offline compaction cancels before touching registry/auth or injected completion; invalid policy model/thinking/enable flag cancels without registry access; compaction retains exact native cutoff, state JSON and reported summary usage; compaction passes exact physical model, API reasoning option and split prefix to injected completion; compaction unions previous hook file lists and removes modified paths from read-only lists; compaction chooses active branch state rather than abandoned branch state; compaction cancels on malformed preparation, unsupported model, abort or incomplete output; compaction cancels instead of paraphrasing unsupported branch state |
| context-masking | masking batches older assistant turns despite reset turnIndex and composes prior drafts; masking protects latest reads by canonical path and all task/contract/todo state; masking persists native context edits and reopening retains stubs with original history; masking uses active branch and does not repeat pending or persisted edits; masking skips errors, images, custom structured fields, and observations without recovery logs; masking batches only when eligible observation region crosses the proxy threshold; masking prefers native full logs over shaped observed logs |
| context-patch | single-file unified patch uses exact context and compact coherent result; multiple hunks have strict old/new positions and preserve BOM/CRLF; no-newline markers faithfully change final newline status; invalid counts, context, new offsets, overlaps and unsupported formats never write; later hunk failure is atomic, missing files are rejected and runtime cwd wins; patch and native edit siblings share queue including symlinks; aborted calls do not write |
| context-shaping | short unchanged text is inert and creates no directory; module import is inert in a fresh process; ANSI cleanup, carriage-return progress and repeated lines retain exact raw spill; caps include newlines, omission markers and log reference while retaining head and tail; Unicode long lines keep both ends without replacement characters or excess bytes; test failure context and assertion diff in the middle survive bounded selection; compiler diagnostics and package-manager failures survive the middle of output; git diff keeps a hunk and changed lines with bounded head/tail; native Bash structured output remains coherent with shaped content and status fields; native full-output pointer is preserved and spill contains only hook-visible text; unknown custom structured schemas preserve the result without a spill; nontext payloads survive exactly while the neighboring text is shaped; malicious IDs cannot escape and simultaneous spills are exclusive and restrictive; symlinked output directories are rejected without writing outside .apex; newline-heavy output and very small valid caps remain bounded; invalid caps fail before any filesystem mutation |
| context-tools | feature selection is inert and conventional tools stay directly active with lazy; bounded read retains native schema/range notices and runtime cwd wins; dedup needs unchanged range and exact unmasked original observation in native active context; dedup never makes a pointer for missing/empty context or a fresh tool factory; outline reports line numbers and explicitly labels approximate fallback; images retain native payload; binary and huge lines produce bounded honest results; conventional edit aliases use native multi-edit and preserve BOM/CRLF/untouched whitespace; native edit whitespace matching, ambiguity and overlap fail atomically with bounded candidates; wrapper and native sibling edits serialize against realpath aliases; search uses native caps with grouped grep and unknown overflow totals |

## Source limitations and integration checks

- Native tool declarations are first-registration-wins by extension order. Explicitly loading the context extension ahead of the built-in codemode lets its late registration win after refresh. Root integration must inspect the actually selected codemode definition for disabled `models.*` globals; a builtin definition winning instead would retain native default `models:true`.
- Deferred exposure reduces model-visible declarations; it does not make tool execution a permission boundary. Enabled native MCP servers connect at session_start regardless of deferred exposure, so this module deliberately registers none.
- Native Pi persists system/tool deltas, but adapters may fold them into the initial provider prefix. Provider cache hits and Muse thinking/cache interactions remain unmeasured.
- Progressive lower thinking is deliberately unavailable under the current xhigh authorization. Provider calls, paid benchmarking, dollars per solved task and pass-rate changes were not measured.

Files are frozen for root integration/review; no commit was made by this worker.

## Root integration resolution

The root used a materially safer offline setup: sanitized environment without provider credentials, PI_OFFLINE=1, existing local fd/rg on PATH, npm offline with audit/fund/update checks disabled and a loopback registry endpoint. The direct npm test run passed 151 Node and 121 Python tests, zero skips; validation/phase1-unit.log contains the evidence. Integrated npm run micro also passed, including actual selected models:false codemode and 16 native Phase 1 checks. No rejected operation remains necessary; no inference or external account call was made.
