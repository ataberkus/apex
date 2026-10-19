"""Apex installed agent for the source-pinned Harbor Pi adapter.

Import with ``--agent evals.harbor.apex:ApexAgent``. The evaluator owns budget
and timeout policy; this adapter only installs a local package and substitutes
the executable in Harbor's existing Pi JSON invocation.
"""

import inspect
import re
import shlex
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, field_validator
from evals.context_flags import validate_context_flags as _validate_context_flags
from evals.core_flags import validate_core_flags,selected_core_flags,validate_time_budget,format_time_budget
from evals.feature_flags import validate_feature_flags, selected_feature_flags

from harbor.agents.installed.pi import Pi, PiOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


PINNED_PI_VERSION = "1.3.0"
_PI_RUN_FRAGMENT = "pi --print --mode json "
_APEX_RUN_FRAGMENT = "apex --profile headless --print --mode json "
_REMOTE_PACKAGE = "/installed-agent/apex.tgz"
_PROVIDER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")
_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/+-]*")


class ApexOptions(PiOptions):
    version: Literal["1.3.0"] | None = Field(default=PINNED_PI_VERSION)
    apex_package: str = Field(
        description="Absolute host path to the local Apex .tgz package."
    )
    context_flags: str = Field(default="", description="Optional Phase 1 comma-separated ablation flags; defaults off.")
    core_flags: str = Field(default="",description="Optional Phase 2 ablation flags; defaults off. Max is a separate configuration.")
    feature_flags: str = Field(default="", description="Optional Phase 3 daily-driver ablation flags; defaults off. Explicit variants run in eval mode.")
    time_budget_sec: float | None = Field(default=None,description="Explicit effective evaluator deadline for time notes, without changing any benchmark timeout.")

    @field_validator("feature_flags", mode="before")
    @classmethod
    def validate_features(cls, value):
        return validate_feature_flags(value)

    @field_validator("core_flags")
    @classmethod
    def validate_core_flags(cls,value):return validate_core_flags(value)

    @field_validator("time_budget_sec",mode="before")
    @classmethod
    def validate_deadline(cls,value):return validate_time_budget(value)

    @field_validator("context_flags")
    @classmethod
    def validate_context_flags(cls, value: str) -> str:
        return _validate_context_flags(value)

    @field_validator("apex_package")
    @classmethod
    def validate_package(cls, value: str) -> str:
        path = Path(value)
        if not path.is_absolute():
            raise ValueError("apex_package must be an absolute path")
        if path.suffix != ".tgz" or not path.is_file():
            raise ValueError("apex_package must identify an existing .tgz file")
        return str(path)


def _unquoted_invocations(command: str) -> list[int]:
    positions = []
    quote = None
    escaped = False
    for index, character in enumerate(command):
        if escaped:
            escaped = False
            continue
        if character == "\\" and quote != "'":
            escaped = True
            continue
        if quote is not None:
            if character == quote:
                quote = None
            continue
        if character in {"'", '"'}:
            quote = character
            continue
        if command.startswith(_PI_RUN_FRAGMENT, index) and (
            index == 0 or command[index - 1].isspace() or command[index - 1] in ";&|()"
        ):
            positions.append(index)
    return positions


def _validate_model_name(value: Any) -> str:
    if not isinstance(value, str) or "/" not in value:
        raise ValueError("model_name must contain a safe provider/model identifier")
    provider, model_id = value.split("/", 1)
    if _PROVIDER_NAME.fullmatch(provider) is None or _MODEL_ID.fullmatch(model_id) is None:
        raise ValueError("model_name must contain a safe provider/model identifier")
    return provider


class ApexAgent(Pi):
    capabilities = Pi.capabilities.model_copy(update={"mcp_servers": False})
    options_model = ApexOptions
    options: ApexOptions

    def __init__(self, *args, version: str | None = PINNED_PI_VERSION, **kwargs):
        _validate_model_name(kwargs.get("model_name"))
        flags = _validate_context_flags(kwargs.get("context_flags", ""))
        core = selected_core_flags(kwargs.get("core_flags",""))
        features = selected_feature_flags(kwargs.get("feature_flags", ""))
        deadline = validate_time_budget(kwargs.get("time_budget_sec"))
        if deadline is not None and 'time' not in core:raise ValueError("time_budget_sec requires the time core flag")
        if 'max' in core:raise ValueError("Max is a separate configuration blocked by the offline-only policy")
        if flags or core or features:
            if kwargs.get("model_name") != "openrouter/meta/muse-spark-1.3-contributor":
                raise ValueError("Apex experiment flags require the selected Muse model")
            thinking = kwargs.get("thinking", kwargs.get("reasoning_effort", "xhigh"))
            if thinking != "xhigh":
                raise ValueError("Apex experiment flags require xhigh")
            if "thinking" not in kwargs and "reasoning_effort" not in kwargs:
                kwargs["thinking"] = "xhigh"
        if version not in (None, PINNED_PI_VERSION):
            raise ValueError(f"Apex requires Pi {PINNED_PI_VERSION}")
        if not Pi.capabilities.atif:
            raise RuntimeError("Apex requires the source-pinned Harbor Pi ATIF contract")
        super().__init__(*args, version=version or PINNED_PI_VERSION, **kwargs)
        self._apex_invocations = 0

    @staticmethod
    def name() -> str:
        return "apex"

    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        await environment.upload_file(Path(self.options.apex_package), _REMOTE_PACKAGE)
        await self.exec_as_root(environment, command=f"chmod a+r {_REMOTE_PACKAGE}")
        await self.exec_as_agent(
            environment,
            command=(
                ". ~/.nvm/nvm.sh; "
                "npm install -g --ignore-scripts --legacy-peer-deps "
                f"{_REMOTE_PACKAGE} && apex --version"
            ),
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        requested_provider = _validate_model_name(self.model_name)
        provider = self.model_connection.provider or requested_provider
        if not isinstance(provider, str) or _PROVIDER_NAME.fullmatch(provider) is None:
            raise ValueError("Effective provider must be a safe provider identifier")
        if (self.options.context_flags or self.options.core_flags or self.options.feature_flags) and provider != "openrouter":
            raise ValueError("Apex experiment effective provider must remain openrouter")

        # Refuse a changed parent before a stale adapter can invoke stock Pi.
        try:
            source = inspect.getsource(inspect.unwrap(Pi.run))
        except (OSError, TypeError) as exc:
            raise RuntimeError("Cannot verify the Harbor Pi run contract") from exc
        if _PI_RUN_FRAGMENT not in source:
            raise RuntimeError("Harbor Pi run contract changed; review the Apex adapter")

        self._apex_invocations = 0
        config_dir = self.environment_logs_dir / "apex" / "config"
        quoted_config_dir = shlex.quote(str(config_dir))
        await super().exec_as_agent(
            environment,
            command=f"mkdir -p {quoted_config_dir} && chmod 700 {quoted_config_dir}",
        )
        await super().run(instruction, environment, context)
        if self._apex_invocations != 1:
            raise RuntimeError("Harbor Pi run contract did not produce one Apex invocation")

    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:
        tokens = shlex.split(command)
        run_shape = any(token in {"--print", "--mode"} for token in tokens)
        if run_shape:
            pi_positions = [
                index
                for index, token in enumerate(tokens)
                if token == "pi"
                and tokens[index + 1 : index + 2] in (["--print"], ["--mode"])
            ]
            pi_position = pi_positions[0] if len(pi_positions) == 1 else None
            raw_positions = _unquoted_invocations(command)
            if (
                pi_position is None
                or self._apex_invocations != 0
                or tokens[pi_position + 1 : pi_position + 4]
                != ["--print", "--mode", "json"]
                or len(raw_positions) != 1
            ):
                raise RuntimeError("Harbor Pi run contract changed; refusing an unmatched JSON run")
            start = raw_positions[0]
            replacement = _APEX_RUN_FRAGMENT
            if self.options.context_flags:
                replacement = "apex --profile headless --apex-context " + shlex.quote(self.options.context_flags) + " --print --mode json "
            if self.options.core_flags:
                replacement=replacement.removesuffix("--print --mode json ")+"--apex-core "+shlex.quote(self.options.core_flags)+" "
                if self.options.time_budget_sec is not None:replacement+="--time-budget "+shlex.quote(format_time_budget(self.options.time_budget_sec))+" "
                replacement+="--print --mode json "
            if self.options.feature_flags:
                replacement = (replacement.removesuffix("--print --mode json ")
                               + "--apex-features " + shlex.quote(self.options.feature_flags)
                               + " --apex-eval --print --mode json ")
            command = (
                command[:start]
                + replacement
                + command[start + len(_PI_RUN_FRAGMENT) :]
            )
            env = dict(env or {})
            env["PI_CODING_AGENT_DIR"] = str(self.environment_logs_dir / "apex" / "config")
            self._apex_invocations += 1
        return await super().exec_as_agent(
            environment, command=command, env=env, cwd=cwd, timeout_sec=timeout_sec
        )
