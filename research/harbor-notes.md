# Harbor and Pi audit for Phase 0

Audit date: 2026-10-01 UTC. This is a source/API-contract audit for a Windows-local evaluation harness. No benchmark trial, model request, cloud sandbox, benchmark solution, task package, or verifier/test file was used. Public repository/framework source and dataset metadata were inspected. Installation/CLI evidence is supplied by the parent workflow below.

## Source pins and status

| Component | Verified source | Consequence |
|---|---|---|
| Harbor `main` | `99218a4611e3bd76e49ce3b5f977e8c8134ad3ac`, committed 2026-09-30; source package version `0.23.0`; Python `>=3.12` | All contracts below describe this commit; an installed release must be checked separately. |
| Built-in Pi introduction | PR [#1272](https://github.com/harbor-framework/harbor/pull/1272), merged 2026-04-08; merge `f017649ab2f9df92e906525e84b18316a54c88ac`; original head `7a7d03fa08c6a703cbe23984c25736dec26dc43b` | Historical provenance, not a current adapter specification. |
| External `pi-terminal-bench` | `0074c915dc7d8ceeba5f61b19e7b9aa078564fa3`, committed 2025-12-01 | Legacy `ExecInput` adapter; incompatible with current Harbor API. |
| Current Pi source pin | v1.4.0 tag `4a080252f06caf63a525d7873c5d94d3c23887e0` (published 2026-10-21); package `1.4.0` | Source compatibility needs a Pi pin; package `latest` is not reproducible. The previous pin was the v1.3.0 tag `71023aec1546d6d677a65669c5665c0927ce0dd0`. The original 2026-10-01 audit used `8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d`, an unreleased commit 17 commits after the `0.99.2` tag `005af57d88ee23b33778f343a9595b32e67ff788`, with package `0.99.2` installed. |

**Release/source discrepancy:** the installed PyPI Harbor `0.23.0` wheel differs materially from current `main` despite the same version label. Its constructor/install/setup contracts and upload fix match, but its Pi adapter declares only `resume=True` and has no ATIF converter, MCP, or max_turns option. It still writes sessions to `/logs/agent/pi/sessions` and filtered output to `pi.txt`. Postrun accounting handles assistant message_end only: input=input+cacheRead, with cacheWrite omitted. The parent workflow selected exact current-main source for implementation.

Wheel evidence: `.tools/uv/harbor/lib/python3.12/site-packages/`; metadata version `0.23.0`, Python `>=3.12`.

| Wheel file | SHA256 |
|---|---|
| `harbor/agents/installed/pi.py` | `09bd67c9bad21ed5faf76382153c0b8527166a94c18fe4663f07a328a39bcbbc` |
| `harbor/agents/installed/base.py` | `4ad4d5891db891645dcdb044566cb150502fb7d2ee5fdaef80eabd652d6bf6a9` |
| `harbor/environments/docker/docker_unix.py` | `56f1655b29ad222c315b2ea3c6d4172d6fdcd4a3788697eb9d3f80d1264b3152` |

Sources: [Harbor metadata](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/pyproject.toml), [Harbor commit](https://github.com/harbor-framework/harbor/commit/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac), [external adapter commit](https://github.com/badlogic/pi-terminal-bench/commit/0074c915dc7d8ceeba5f61b19e7b9aa078564fa3), [Pi package metadata](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/package.json).

## Installed-agent contracts

Exact current signatures needed by a custom installed agent:

```python
BaseInstalledAgent.__init__(
    self, logs_dir: Path, prompt_template_path: Path | str | None = None,
    version: str | None = None, extra_env: dict[str, str] | None = None,
    *, config: Path | str | dict[str, Any] | None = None, **kwargs)
async def install(self, environment: BaseEnvironment) -> None: ...
async def setup(self, environment: BaseEnvironment) -> None: ...
async def run(self, instruction: str, environment: BaseEnvironment,
              context: AgentContext) -> None: ...
def populate_context_post_run(self, context: AgentContext) -> None: ...
def convert_trajectory(self, logs_dir: Path) -> Trajectory | None: ...
@property
def remote_session_logs_dir(self) -> PurePosixPath | None: ...
```

`install` and inherited `run` are abstract. `setup` creates `/installed-agent`, creates host `logs_dir/setup`, calls `install`, then best-effort detects version when unspecified. Execution helpers `exec_as_root`/`exec_as_agent` accept environment, command, optional env/cwd/timeout_sec and return execution results. They add `set -o pipefail`, log with credential redaction, and raise classified nonzero-exit errors. `environment.exec` uses the orchestrator's default agent user unless an explicit user is supplied. Constructor kwargs include model_name/logger/skills_dir/mcp_servers via BaseAgent. A declared `options_model` validates kwargs; otherwise leftovers are ignored.

`convert_trajectory` and `remote_session_logs_dir` default to no-op/None. They are hooks for live transcript synchronization, distinct from postrun context population. Custom wrappers should explicitly implement the appropriate hooks, preserve raw JSONL, and populate context from partial output on timeout.

Sources: [installed base](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/agents/installed/base.py), [agent base](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/agents/base.py), [live synchronization](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/trial/sync_trajectory.py).

## Stock Pi adapter behavior

Current-main stock `Pi` declares ATIF, resume, skills, and MCP capabilities. Package selection is `@mariozechner/pi-coding-agent` below `0.74.0`, otherwise `@earendil-works/pi-coding-agent`; unpinned install uses `@latest`. MCP pins Pi `0.85.1` by default and requires `>=0.84.1,<0.86.0`. Pi max_turns needs `>=0.35.0` and is implemented by an aborting extension. Thinking aliases reasoning_effort and accepts off/minimal/low/medium/high/xhigh/max.

Run requires `provider/model`; provider/model are separated for the CLI. Output is `pi.txt`; native sessions are `pi/sessions/*.jsonl`. Command shape:

```sh
. ~/.nvm/nvm.sh; mkdir -p <session-dir> && \
pi --print --mode json --session-dir <session-dir> \
  [--continue] --provider <provider> --model <model> \
  [--extension <path>] [--thinking <level>] <quoted-instruction> \
  2>&1 </dev/null | grep -v '"type":"message_update"' | stdbuf -oL tee <pi.txt>
```

Postrun selects newest session by mtime/name, follows the active id/parentId branch, writes ATIF-v1.7 `trajectory.json`, and backfills tokens/cost. Tool results attach by call ID; reasoning is separate. Resume marks prior context copied and excludes its usage. Fallback parses message_end. It does not override live converter hooks. ATIF is not a lossless native-session copy.

Source: [current built-in Pi](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/agents/installed/pi.py).

Install dependency details: shared nvm `v0.40.2`, Node major `22`, global npm install with `--ignore-scripts`; Node binaries need a glibc distro, not musl/Alpine. Node major alone does not pin the patch version. Source: [shared Node installer](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/agents/installed/node_install.py).

Credentials: selected provider connection resolves keys and explicit base URL from agent env before ambient host env; only selected provider vars pass through. Anthropic additionally forwards ANTHROPIC_OAUTH_TOKEN. Relevant maps include ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY/GOOGLE_API_KEY, GROQ_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY. Custom endpoints require explicit base URL, `model_api` argument, and a key env reference; the adapter creates isolated models.json and provider `harbor-endpoint`. Credentials are references in config, not embedded literal values. No key/provider request was tested. Source: [connection resolver](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/agents/model_connection.py).

Current-Pi compatibility caveat, from the separate Pi source audit and rechecked against the published `1.3.0` package and the `1.4.0` source: JSON message_update events are deltas; message_end is authoritative, and agent_settled denotes final quiescence (1.3.0 adds `aborted` to it; Harbor does not read it). Native v3 sessions persist system/context-edit/standalone-usage events in addition to messages. The Harbor converter above skips those extra entry types. Standalone cache_warm usage is additional work, so its tokens/cost are omitted by that converter when warming is enabled. Preserve native logs and pin cache-warming settings; do not rely on ATIF alone for complete spend/context accounting. `--offline` is not a provider-call prohibition. Sources: [Pi JSON docs](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/json.md), [session manager](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts), [cache warmer](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/cache-warmer.ts).

Pi `1.3.0` re-audit of the Harbor `99218a4` Pi contract (2026-10-19; packed `0.99.2` and `1.3.0` npm tarballs compared, `pi --version`/`--help` from 1.3.0, no model call). Install: package name resolves to `@earendil-works/pi-coding-agent` for versions >=0.74.0, no install scripts in either version, `engines.node` remains `>=22.19.0`, satisfied by nvm's latest Node 22; 1.3.0 ships without npm-shrinkwrap, so transitive dependencies resolve at install time (internal `@earendil-works/*` dependencies are exact-pinned). CLI: `--print`, `--mode json`, `--session-dir`, `--continue`, `--provider`, `--model`, `--extension`, and `--thinking` (`off`…`max`) parse unchanged; 1.3.0 newly rejects `--provider` without `--model`, which Harbor never emits. `PI_CODING_AGENT_DIR` still selects the config directory. Session files are still written directly in `--session-dir` as `<timestamp>_<id>.jsonl`; `session-manager.js` is byte-identical between the two packages (`CURRENT_SESSION_VERSION = 3`). The JSON event serializer is identical, and print-mode JSON exit status is unchanged (the new length-stop exit 1 applies to text mode only). pi-ai `Usage`, assistant, and toolResult message fields Harbor reads are unchanged. The max_turns extension remains valid against the 1.3.0 `before_agent_start` union because `systemPrompt` is on the shared event base and `systemPrompt` is still an accepted result field. Harbor's MCP bridge still accepts only Pi `>=0.84.1,<0.86.0`, so Harbor MCP is unusable with both the old and new pin; Apex disables it.

Pi `1.4.0` re-audit of the same contract (2026-10-29; `v1.3.0`→`v1.4.0` source diff, no model call). `engines.node` stays `>=22.19.0`, there are still no install scripts or npm-shrinkwrap, and internal `@earendil-works/*` dependencies are exact-pinned `1.4.0`. `src/cli/args.ts`, `src/modes/print-mode.ts`, `session-manager.ts`, `docs/json.md` and `extensions/types.ts` are byte-identical to `1.3.0`, so the flags Harbor emits, session file placement, JSON events, print-mode exit status and the max_turns extension contract are unchanged. Provider attribution headers moved into pi-ai's client identity, which changes request headers but nothing Harbor reads. Harbor MCP remains unusable with this pin.

## Legacy external adapter and /tests upload issue

The external adapter imports `ExecInput`, defines `_install_agent_template_path` and `create_run_agent_commands`, forwards a fixed provider-key list, and writes `session.jsonl`/`pi-output.jsonl`. Its template installs legacy `@mariozechner/pi-coding-agent@latest` unless version supplied. Current Harbor removed `ExecInput` and instead requires `install`; use it only as historical reference. Source: [legacy adapter](https://github.com/badlogic/pi-terminal-bench/blob/0074c915dc7d8ceeba5f61b19e7b9aa078564fa3/src/pi_terminal_bench/pi_agent.py), [template](https://github.com/badlogic/pi-terminal-bench/blob/0074c915dc7d8ceeba5f61b19e7b9aa078564fa3/src/pi_terminal_bench/install-pi.sh.j2).

Its README documents docker cp nesting when `/tests` already exists and proposes copying source contents with `/.`. Current Harbor's `DockerEnvironment.upload_dir` delegates to its platform helper; the Unix helper already calls compose cp with `f"{source_dir}/."` and has a tar fallback. No manual patch is needed for this source. Direct installed-wheel inspection confirms the same fix; Docker runtime behavior is untested here. Do not use the README's string-replacement patch against an unfamiliar version. Sources: [external README](https://github.com/badlogic/pi-terminal-bench/blob/0074c915dc7d8ceeba5f61b19e7b9aa078564fa3/README.md), [current Unix upload helper](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/environments/docker/docker_unix.py), [Docker delegate](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/environments/docker/docker.py).

## CLI: source-confirmed switches

| Purpose | Current switches |
|---|---|
| Job/config/results | `harbor run` aliases `harbor job start`; `-c/--config` repeatable; `--print-config`; `--job-name`; `-o/--jobs-dir` |
| Agent/model/options | `-a/--agent pi` or `module.path:Class`; `-m/--model`; `--ak/--agent-kwarg key=value`; `--ae/--agent-env KEY=VALUE`; `--effort` |
| Old import spelling | `--agent-import-path` still accepted but deprecated and hidden |
| Dataset/filter | `-d/--dataset name@version` or `org/name@ref`; `-i/--include-task-name` repeatable glob; `-x/--exclude-task-name`; `-l/--n-tasks` after filters |
| Attempts/concurrency/retries | `-k/--n-attempts`; `-n/--n-concurrent`; `--n-concurrent-agents`; `-r/--max-retries`; `--retry-include`; `--retry-exclude` |
| Timing | `--timeout-multiplier`, `--agent-timeout-multiplier`, `--verifier-timeout-multiplier`, `--agent-setup-timeout-multiplier`, `--environment-build-timeout-multiplier` |
| Metadata validation | `--dry-run` validates config/preflight/metadata without task download or trial; `--print-config` and dry-run are mutually exclusive |
| Dataset inventory | `harbor datasets list` prints hub link; `harbor datasets list --legacy` requests table; `--repo`, `--registry-path`, `--registry-url` available |

The external README's `--task-ids` and `--k` examples are not current switches. Source confirms `-k`, not `--k`. Include/exclude names belong only in evaluator split manifests; runtime agent behavior must not branch on benchmark IDs. Source: [job CLI](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/cli/jobs.py), [dataset CLI](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/cli/datasets.py).

## Timeouts and recovery

Agent, verifier, installation, and environment-build deadlines are separate. The phase timeout is `min(base_seconds, max_seconds or infinity) * effective_multiplier`; phase multiplier overrides the global multiplier. Agent override falls back to task timeout; a missing agent base yields no execution deadline. Installation default is 360 seconds before multiplier. Absolute overrides/caps are config fields, not dedicated CLI flags.

Trial wraps execution in asyncio.wait_for and raises AgentTimeoutError on deadline. For single-step trials, AgentTimeoutError and nonzero-agent-exit exceptions are recorded; logs/context are synchronized in finally, and verification proceeds. Setup/build failure recovers available outputs and finalizes result. Docker subprocess cleanup terminates its local command, waits five seconds, then kills if necessary; trial environment cleanup is additionally shielded. This source audit does not prove all in-container descendants terminate instantly on timeout. Sources: [trial core](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/trial/trial.py), [single step](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/trial/single_step.py), [trial config](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/models/trial/config.py).

## Dataset availability, metadata only

Executed CLI evidence is now captured in `validation/harbor-run-help.txt`, `validation/harbor-datasets.txt`, and `validation/harbor-datasets-legacy.txt`. The legacy table confirms `terminal-bench@2.0` (89), `terminal-bench-sample@2.0` (10), `swebench-verified@1.0` (500), `swebench_multilingual@1.0` (300), `swebenchpro@1.0` (731), and `swesmith@1.0` (100). It does **not** list `terminal-bench@2.1`. The modern Hub namespace below establishes 2.1 availability separately; use the verified namespace, not an invented legacy alias.

| Dataset family | Public Harbor Hub reference | Count observed | Pin status |
|---|---|---:|---|
| Terminal-Bench 2.0 | `terminal-bench/terminal-bench-2` | 89 | Hub page showed revision 1/latest; source README also uses legacy `terminal-bench@2.0`. |
| Terminal-Bench 2.1 | `terminal-bench/terminal-bench-2-1` | 89 | Presence verified; current immutable revision/digest not resolved. Do not assume legacy alias `terminal-bench@2.1`. |
| SWE-bench Verified | `swe-bench/swe-bench-verified` | 500 | Page showed revision 2/latest; immutable content digest unresolved. |
| SWE-smith | `swe-bench/swe-smith` | 100 | Inventory only; not equivalent to Verified. |
| SWE-bench Pro | `scale-ai/swe-bench-pro` | 731 | Public inventory; distinct benchmark. |

Terminal-Bench 2.1 is now available, so treating it as unavailable would be stale. SWE-bench Lite/full availability in Harbor was not established by the metadata inventory; multilingual is confirmed in the legacy CLI table; the original SWE-bench family supports those variants, but that does not establish Harbor registry identifiers. No task/verifier packages were downloaded to verify counts. Hub data can change; pin metadata snapshot and resolved revision/digest before real runs.

Sources: [Terminal-Bench inventory](https://hub.harborframework.com/datasets/terminal-bench), [2.0 Hub page](https://hub.harborframework.com/datasets/terminal-bench/terminal-bench-2/latest?leaderboard=2-0&tab=leaderboard), [SWE inventory](https://hub.harborframework.com/datasets/swe-bench), [Verified page](https://hub.harborframework.com/datasets/swe-bench/swe-bench-verified/latest), [general registry](https://hub.harborframework.com/datasets), [official SWE variants](https://www.swebench.com/SWE-bench/faq/).

Registry note: current repository `registry.json` is empty. Default client resolves modern Harbor registry metadata; list_datasets asks only name/version/description/task count. A repo or legacy JSON registry is a separate route. Source: [registry factory](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/registry/client/factory.py), [metadata client](https://github.com/harbor-framework/harbor/blob/99218a4611e3bd76e49ce3b5f977e8c8134ad3ac/src/harbor/registry/client/harbor/harbor.py).

## Windows local route

Verified: Harbor's default local sandbox is Docker, installed separately. Docker Desktop on Windows includes Engine/CLI/Compose, supports Linux containers through its WSL2 engine, and exposes Docker inside a WSL2 distro after integration is enabled. Docker recommends Linux filesystem paths for bind mounts. Harbor task OS defaults to linux; task Windows support is separate from native Windows-host support. Harbor installation docs provide no host support matrix.

Recommended route, explicitly an inference: use a WSL2 Linux distro to run Harbor, Docker Desktop's WSL2 engine in Linux-container mode, and Linux project/cache/results paths. This aligns the Python host and shell tooling with the Linux tasks. No Windows host or Docker daemon was available for runtime verification here.

Docker's current Windows prerequisites include WSL >=2.1.5, supported serviced Windows client, SLAT-capable 64-bit CPU, 8 GB RAM, enabled virtualization, and LanmanServer enabled/Automatic; Docker Desktop does not support Windows Server. Confirm exact current OS servicing support before setup.

Sources: [Harbor install](https://docs.harborframework.com/getting-started/installation), [local runtimes](https://docs.harborframework.com/core-concepts/sandboxes/pre-integrated-sandboxes), [task OS](https://docs.harborframework.com/core-concepts/tasks/environment), [Docker WSL](https://docs.docker.com/desktop/features/wsl/), [WSL bind mounts](https://docs.docker.com/desktop/features/wsl/best-practices/), [Docker Windows requirements](https://docs.docker.com/desktop/setup/install/windows-install/), [Compose installation](https://docs.docker.com/compose/install/).

## Reproducibility requirements and remaining checks

Before paid or model-backed execution: pin Harbor version/commit, custom adapter commit, Pi exact npm version/tarball integrity, Node exact version, task package revision/content digest, container image digest/architecture, dataset metadata snapshot, evaluator-only split manifest, attempts/concurrency, timeout configuration, model/provider/settings, cache-warming/compaction behavior, and retry policy. Retain native session JSONL, filtered CLI log, ATIF, resolved config, result/exception files, and environment/setup versions. Keep credential values out of retained config and logs.

Verified parent runtime evidence: PyPI `0.23.0` installed, discrepancy discovered, then exact git-source commit `99218a4611e3bd76e49ce3b5f977e8c8134ad3ac` installed successfully; current run help and both dataset-list modes captured above. Installed upload_dir source confirmed contents-copy fix. Initial dataset-list import failed because the environment proxy configuration needed optional socksio; parent added `socksio==1.0.0` and metadata listing succeeded. Proxy/credential values were not retained in this note. Blocked/not performed: Docker execution, native Windows execution, model/provider/auth call, actual dataset package pin resolution, benchmark success/trajectory runtime interoperability.

## Implemented adapter and synthetic checks

`evals.harbor.apex:ApexAgent` subclasses exact-source Pi. It fixes Pi to `1.4.0` (originally `0.99.2`, then `1.3.0`) and rejects incompatible explicit versions, marks MCP unsupported for Phase 0, requires an absolute existing `apex_package` .tgz, uploads that local package, installs with npm `--ignore-scripts --legacy-peer-deps`, and substitutes `apex --profile headless` in the existing JSON command. It reuses provider/model/session/ATIF behavior and passes timeout policy through. Runtime config defaults to `/logs/agent/apex/config`; parent inline custom-endpoint config remains authoritative. A parent-contract guard rejects stale invocation shapes before dispatch; executable replacement skips quoted prompt/preface literals and rejects duplicate invocations. No benchmark-ID-dependent behavior was introduced.

TDD evidence: nine adapter tests failed for the missing implementation, then all nine passed; added stale-mode, duplicate-dispatch, quoted-preface, and explicit-version regressions failed before their fixes, and the final twelve scoped tests passed in source-pinned Harbor Python using an inert environment fake. Tests exercise installation/upload, the real parent run builder, custom endpoint configuration, preserved ordinary-command timeout arguments, stale-contract rejection, invalid package paths, nonzero exit propagation, and native-session ATIF output. Full-suite checks include other concurrently developed evaluator components; the parent owns the final combined test result. These checks establish Python/command-boundary behavior, not a real container/npm/provider run.
