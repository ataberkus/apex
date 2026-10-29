"""Adapter boundary checks with no container, provider, or benchmark calls."""

import importlib
import json
import shlex
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest.mock import patch

from harbor.agents.installed.pi import Pi
from harbor.agents.model_connection import ResolvedModelConnection
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext


class FakeEnvironment:
    default_user = None

    def __init__(self):
        self.events = []
        self.uploaded_text = {}
        self.return_code = 0

    async def exec(self, **kwargs):
        self.events.append(("exec", kwargs))
        return ExecResult(return_code=self.return_code, stdout="", stderr="")

    async def upload_file(self, source_path, target_path):
        self.events.append(("upload", str(source_path), target_path))
        self.uploaded_text[target_path] = Path(source_path).read_bytes()


class HarborAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        try:
            module = importlib.import_module("evals.harbor.apex")
        except ModuleNotFoundError:
            module = None
        self.assertIsNotNone(module, "The source-compatible Apex adapter is missing")
        self.adapter_class = module.ApexAgent
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.package = self.directory / "apex ; local.tgz"
        self.package.write_bytes(b"synthetic package: never passed to a real package manager")
        self.environment = FakeEnvironment()

    def agent(self, **kwargs):
        values = {
            "logs_dir": self.directory / "logs",
            "environment_logs_dir": PurePosixPath("/logs/agent"),
            "model_name": "openai/synthetic-model",
            "apex_package": str(self.package),
        }
        values.update(kwargs)
        return self.adapter_class(**values)

    async def test_install_pins_pi_then_uploads_and_installs_local_apex(self):
        agent = self.agent()
        await agent.install(self.environment)
        commands = [event[1]["command"] for event in self.environment.events if event[0] == "exec"]
        self.assertTrue(any("@earendil-works/pi-coding-agent@1.4.0" in item for item in commands))
        upload_position = next(i for i, item in enumerate(self.environment.events) if item[0] == "upload")
        self.assertEqual(self.environment.events[upload_position][1:], (str(self.package), "/installed-agent/apex.tgz"))
        apex_commands = [item for item in commands if "bun add --global --exact --ignore-scripts" in item]
        self.assertEqual(len(apex_commands), 1)
        self.assertIn("bash -s bun-v1.4.3", " ".join(commands))
        self.assertIn("@earendil-works/pi-coding-agent@1.4.0 /installed-agent/apex.tgz", apex_commands[0])
        self.assertNotIn(str(self.package), apex_commands[0])
        self.assertTrue(any(item.endswith("apex --version") for item in commands))

    async def test_run_uses_headless_apex_and_retains_parent_session_provider_flags(self):
        agent = self.agent(thinking="high", extra_env={"OPENAI_API_KEY": "synthetic-test-only"})
        instruction = "Document literal pi --print --mode json text without invoking it."
        await agent.run(instruction, self.environment, AgentContext())
        run_calls = [event[1] for event in self.environment.events if event[0] == "exec" and "apex --profile" in event[1]["command"]]
        self.assertEqual(len(run_calls), 1)
        call = run_calls[0]
        self.assertIn("apex --profile headless --print --mode json --session-dir /logs/agent/pi/sessions", call["command"])
        self.assertIn("--provider openai --model synthetic-model", call["command"])
        self.assertIn("--thinking high", call["command"])
        self.assertIn(shlex.quote(instruction), call["command"])
        self.assertIn("stdbuf -oL tee /logs/agent/pi.txt", call["command"])
        self.assertEqual(call["env"]["OPENAI_API_KEY"], "synthetic-test-only")
        self.assertEqual(call["env"]["PI_CODING_AGENT_DIR"], "/logs/agent/apex/config")
        self.assertIsNone(call["timeout_sec"])

    async def test_ordinary_commands_and_explicit_timeout_pass_through(self):
        agent = self.agent()
        await agent.exec_as_agent(self.environment, "pi --version", env={"EXAMPLE": "ok"}, cwd="/work", timeout_sec=17)
        call = self.environment.events[-1][1]
        self.assertEqual(call["command"], "set -o pipefail; pi --version")
        self.assertEqual(call["env"], {"EXAMPLE": "ok"})
        self.assertEqual(call["cwd"], "/work")
        self.assertEqual(call["timeout_sec"], 17)

    async def test_custom_endpoint_preserves_parent_models_config_reference(self):
        agent = self.agent(model_api="openai-completions", extra_env={"OPENAI_API_KEY": "synthetic-test-only", "OPENAI_BASE_URL": "http://example.invalid/v1"})
        await agent.run("synthetic", self.environment, AgentContext())
        config = json.loads(self.environment.uploaded_text["/tmp/harbor-pi-agent/models.json"])
        provider = config["providers"]["harbor-endpoint"]
        self.assertEqual(provider["baseUrl"], "http://example.invalid/v1")
        self.assertEqual(provider["apiKey"], "$OPENAI_API_KEY")
        self.assertEqual(provider["models"], [{"id": "synthetic-model"}])
        call = next(event[1] for event in self.environment.events if event[0] == "exec" and "apex --profile" in event[1]["command"])
        self.assertIn("PI_CODING_AGENT_DIR=/tmp/harbor-pi-agent apex --profile", call["command"])
        self.assertIn("--provider harbor-endpoint", call["command"])

    async def test_changed_parent_run_contract_fails_before_any_execution(self):
        async def changed_parent(self, instruction, environment, context):
            await self.exec_as_agent(environment, "pi --mode json --print 'synthetic'")

        with patch.object(Pi, "run", changed_parent):
            with self.assertRaisesRegex(RuntimeError, "Pi.*contract"):
                await self.agent().run("synthetic", self.environment, AgentContext())
        self.assertEqual(self.environment.events, [])

    async def test_json_run_shape_without_exact_invocation_fails_closed(self):
        for command in ("pi --mode json --print 'synthetic'", "pi --print --mode text 'synthetic'"):
            with self.subTest(command=command):
                with self.assertRaisesRegex(RuntimeError, "Pi.*contract"):
                    await self.agent().exec_as_agent(self.environment, command)
        self.assertEqual(self.environment.events, [])

    async def test_missing_and_relative_packages_fail_before_environment_access(self):
        for path in ("relative.tgz", str(self.directory / "missing.tgz")):
            with self.subTest(path=path):
                with self.assertRaises((ValueError, FileNotFoundError)):
                    agent = self.agent(apex_package=path)
                    await agent.install(self.environment)
        self.assertEqual(self.environment.events, [])

    async def test_multiple_pi_invocations_are_rejected_before_second_dispatch(self):
        agent = self.agent()
        with self.assertRaisesRegex(RuntimeError, "Pi.*contract"):
            await agent.exec_as_agent(
                self.environment,
                "pi --print --mode json first && pi --print --mode json second",
            )
        self.assertEqual(self.environment.events, [])
        await agent.exec_as_agent(self.environment, "pi --print --mode json first")
        with self.assertRaisesRegex(RuntimeError, "Pi.*contract"):
            await agent.exec_as_agent(self.environment, "pi --print --mode json second")
        self.assertEqual(len(self.environment.events), 1)

    async def test_quoted_prefix_is_preserved_and_actual_executable_is_rewritten(self):
        await self.agent().exec_as_agent(
            self.environment,
            "echo 'pi --print --mode json '; pi --print --mode json 'real'",
        )
        command = self.environment.events[-1][1]["command"]
        self.assertEqual(
            command,
            "set -o pipefail; echo 'pi --print --mode json '; "
            "apex --profile headless --print --mode json 'real'",
        )

    def test_incompatible_explicit_pi_version_is_rejected_before_install(self):
        for version in ("latest", "0.85.1", "0.99.2", "1.3.0"):
            with self.subTest(version=version):
                with self.assertRaisesRegex(ValueError, "1.4.0"):
                    self.agent(version=version)
        self.assertEqual(self.environment.events, [])

    def test_unsafe_model_names_are_rejected_before_parent_initialization(self):
        unsafe_names = (
            "openai/example;printf${IFS}unexpected",
            "openai/example whitespace",
            "openai/example'quote",
            'openai/example"quote',
            "openai/example$dollar",
            "openai/example`backtick`",
            "openai/example\nnewline",
            "openai;unexpected/example",
            "openai/-option",
        )
        for model_name in unsafe_names:
            with self.subTest(model_name=model_name):
                with patch.object(Pi, "__init__", return_value=None) as parent_init:
                    with self.assertRaisesRegex(ValueError, "model_name"):
                        self.agent(model_name=model_name)
                    parent_init.assert_not_called()
        self.assertEqual(self.environment.events, [])

    async def test_nested_safe_model_ids_remain_supported(self):
        for model_name in (
            "openrouter/anthropic/claude-sonnet-4-5:beta",
            "ollama/qwen3:latest+local",
            "example-provider.v1/model_v2.0",
        ):
            with self.subTest(model_name=model_name):
                await self.agent(model_name=model_name).run(
                    "synthetic", self.environment, AgentContext()
                )
                command = self.environment.events[-1][1]["command"]
                self.assertIn("--model " + model_name.split("/", 1)[1], command)

    async def test_unsafe_effective_provider_is_rejected_before_run_dispatch(self):
        agent = self.agent()
        access = ResolvedModelConnection(provider="openai;printf${IFS}unexpected")
        with patch.object(Pi, "model_connection", property(lambda self: access)):
            with self.assertRaisesRegex(ValueError, "provider"):
                await agent.run("synthetic", self.environment, AgentContext())
        self.assertEqual(self.environment.events, [])

    async def test_parent_nonzero_error_is_preserved(self):
        self.environment.return_code = 7
        with self.assertRaises(RuntimeError):
            await self.agent().exec_as_agent(self.environment, "false")

    async def test_phase1_flags_are_opt_in_and_quoted_before_pi_arguments(self):
        agent = self.agent(context_flags="read,shape", model_name="openrouter/meta/muse-spark-1.3-contributor", thinking="xhigh")
        await agent.run("synthetic", self.environment, AgentContext())
        commands=[event[1]["command"] for event in self.environment.events if event[0]=="exec"]
        run=next(command for command in commands if "apex --profile" in command)
        self.assertIn("apex --profile headless --apex-context read,shape --print --mode json",run)
        self.assertIn("--thinking xhigh",run)

    async def test_phase2_flags_and_explicit_deadline_are_forwarded_without_changing_timeout(self):
        agent=self.agent(core_flags="snapshot,todo,verify,time",time_budget_sec=123.5,
                         model_name="openrouter/meta/muse-spark-1.3-contributor",thinking="xhigh")
        await agent.run("literal --time-budget 999",self.environment,AgentContext())
        call=next(event[1] for event in self.environment.events if event[0]=="exec" and "apex --profile" in event[1]["command"])
        self.assertIn("--apex-core snapshot,todo,verify,time --time-budget 123.5 --print",call["command"])
        self.assertIsNone(call["timeout_sec"])
        self.assertIn(shlex.quote("literal --time-budget 999"),call["command"])

    async def test_small_deadline_uses_launcher_compatible_decimal_text(self):
        agent=self.agent(core_flags="time",time_budget_sec=0.000001,
                         model_name="openrouter/meta/muse-spark-1.3-contributor",thinking="xhigh")
        await agent.run("task",self.environment,AgentContext())
        call=next(event[1] for event in self.environment.events if event[0]=="exec" and "apex --profile" in event[1]["command"])
        self.assertIn("--time-budget 0.000001 --print",call["command"])
        self.assertIsNone(call["timeout_sec"])

    def test_phase2_invalid_flags_deadlines_and_max_fail_before_container_access(self):
        for values in ({"core_flags":"todo;bad"},{"core_flags":"todo,todo"},
                       {"core_flags":"todo","thinking":"low"},{"core_flags":"time","time_budget_sec":0},
                       {"core_flags":"todo","time_budget_sec":10},{"core_flags":"max"},
                       {"core_flags":"time","time_budget_sec":True}):
            with self.subTest(values=values):
                with self.assertRaises(ValueError):self.agent(**values)
        self.assertEqual(self.environment.events,[])

    def test_phase1_invalid_flags_model_or_thinking_fail_before_container_access(self):
        for values in ({"context_flags":"bad"},{"context_flags":"read,read"},
                       {"context_flags":"read;bad"},{"context_flags":"all,shape"},
                       {"context_flags":"read","thinking":"high"}):
            with self.subTest(values=values):
                with self.assertRaises(ValueError): self.agent(**values)
        self.assertEqual(self.environment.events,[])

    def test_native_session_retains_parent_atif_conversion(self):
        agent = self.agent()
        session_dir = agent.logs_dir / "pi" / "sessions"
        session_dir.mkdir(parents=True)
        native = session_dir / "synthetic.jsonl"
        records = [
            {"type": "session", "version": 3, "id": "synthetic", "timestamp": "2026-10-01T00:00:00Z", "cwd": "/work"},
            {"type": "message", "id": "u1", "parentId": None, "timestamp": "2026-10-01T00:00:01Z", "message": {"role": "user", "content": "synthetic", "timestamp": 0}},
            {"type": "message", "id": "a1", "parentId": "u1", "timestamp": "2026-10-01T00:00:02Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}], "api": "openai-completions", "provider": "openai", "model": "synthetic-model", "usage": {"input": 10, "output": 4, "cacheRead": 2, "cacheWrite": 3, "totalTokens": 19, "cost": {"total": 0.01}}, "stopReason": "stop", "timestamp": 0}},
        ]
        text = "".join(json.dumps(record) + "\n" for record in records)
        native.write_text(text)
        context = AgentContext()
        agent.populate_context_post_run(context)
        trajectory = json.loads((agent.logs_dir / "trajectory.json").read_text())
        self.assertEqual(trajectory["agent"]["name"], "apex")
        self.assertEqual(trajectory["steps"][1]["message"], "done")
        self.assertEqual(context.n_input_tokens, 15)
        self.assertEqual(context.n_output_tokens, 4)
        self.assertEqual(native.read_text(), text)


if __name__ == "__main__":
    unittest.main()
