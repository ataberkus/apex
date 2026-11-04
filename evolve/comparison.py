"""Offline, equal-task variant decisions and a trusted aggregate leaderboard."""

from collections import defaultdict
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import random
import re
import stat
from statistics import fmean
import tempfile

from evals.analysis.metrics import _record_identities, summarize_runs


_METHOD = "paired_task_cluster_with_independent_within_task_attempt_percentile_bootstrap"
_TOKEN_FIELDS = {"input", "output", "cache_read", "cache_write", "thinking_tokens", "total"}
_RAW_FIELDS = {"content", "message", "messages", "toolResults", "tool_results", "arguments",
               "trace", "raw_trace", "trajectory", "verifier_result", "rewards", "reward"}
_DIMENSIONS = ("protocol", "model", "provider", "thinking_level", "thinking", "dataset",
               "dataset_manifest_sha256", "dataset_registry_sha256", "dataset_source_commit",
               "container_environment", "environment", "context_flags", "core_flags", "feature_flags",
               "time_budget_sec", "eval_mode", "synthetic")
_LIMIT = 8 * 1024 * 1024


def _fail(message):
    raise ValueError(message)


def _sha(value, length, label):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{%d}" % length, value):
        _fail("invalid " + label)
    return value


def _canonical(value):
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, OverflowError, RecursionError):
        _fail("invalid normalized metadata")


def _reject_raw(value, depth=0):
    if depth > 20:
        _fail("normalized metadata nesting exceeds limit")
    if isinstance(value, dict):
        if _RAW_FIELDS.intersection(value):
            _fail("raw-shaped input is not allowed")
        for child in value.values():
            _reject_raw(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _reject_raw(child, depth + 1)


def _model(record):
    models = record.get("models")
    if not isinstance(models, list) or len(models) != 1 or not isinstance(models[0], dict):
        _fail("exactly one normalized model is required")
    item = models[0]
    provider, model = item.get("provider"), item.get("model")
    if any(not isinstance(value, str) or not value.strip() for value in (provider, model)):
        _fail("invalid normalized model")
    requested = item.get("requested_model", model)
    canonical_muse = (provider, requested, model) == ("openrouter", "meta/muse-spark-1.3-contributor",
                                                   "meta/muse-spark-1.3-contributor-20260902")
    if requested != model and not canonical_muse:
        _fail("requested and observed models disagree")
    names = (requested, model, provider + "/" + requested, provider + "/" + model)
    declared = record.get("declared_agent")
    if declared is not None:
        if not isinstance(declared, dict):
            _fail("invalid declared agent")
        if declared.get("model_name") is not None and declared["model_name"] not in names:
            _fail("declared and observed models disagree")
    info = record.get("agent_info")
    if info is not None:
        if not isinstance(info, dict):
            _fail("invalid agent metadata")
        model_info = info.get("model_info")
        if model_info is not None:
            if not isinstance(model_info, dict) or model_info.get("name") not in names:
                _fail("agent and observed models disagree")
            if model_info.get("provider") is not None and model_info["provider"] != provider:
                _fail("agent and observed providers disagree")
    if record.get("model") is not None and record["model"] not in names:
        _fail("declared and observed models disagree")
    if record.get("provider") is not None and record["provider"] != provider:
        _fail("declared and observed providers disagree")
    # Agent adapter identity is a protocol dimension, not a harness commit.
    return (provider, requested, model, _canonical({key: declared.get(key) for key in ("name", "import_path")})
            if declared is not None else None,
            _canonical({key: info.get(key) for key in ("name", "version")}) if info is not None else None)


def _accounting(record):
    """Give summarize_runs only known accounting fields, never record text/labels."""
    result = {key: record[key] for key in ("task_id", "passed", "configuration_id", "run_id", "attempt",
                                          "trial_id", "result_sha256", "usage_complete", "wall_seconds")
              if key in record}
    tokens = record.get("tokens")
    if tokens is not None:
        if not isinstance(tokens, dict) or set(tokens) - _TOKEN_FIELDS:
            _fail("invalid normalized token components")
        result["tokens"] = tokens
    cost = record.get("cost")
    if cost is not None:
        if not isinstance(cost, dict):
            _fail("invalid normalized cost")
        result["cost"] = {key: cost[key] for key in ("registry_usd", "complete") if key in cost}
    availability = record.get("availability")
    if availability is not None:
        if not isinstance(availability, dict) or not isinstance(availability.get("tokens", {}), dict):
            _fail("invalid normalized availability")
        result["availability"] = {"tokens": {"complete": availability.get("tokens", {}).get("complete")}}
    association = record.get("trace_result_association")
    if association is not None:
        if not isinstance(association, dict):
            _fail("invalid normalized association")
        result["trace_result_association"] = {key: association.get(key) for key in ("status", "trial_binding_verified")}
    return result


def _percentile(values, fraction):
    position = (len(values) - 1) * fraction
    left, right = math.floor(position), math.ceil(position)
    return values[left] + (values[right] - values[left]) * (position - left)


def compare_variants(baseline_records, candidate_records, *, expected_tasks, baseline_commit,
                     candidate_commit, seed=0, bootstrap_samples=5000):
    """Require full frozen splits, then test dev improvement and heldout non-regression.

    Invalid input raises ValueError without exposing task names or record content.
    A valid but inconclusive experiment returns a rejected decision.
    """
    _sha(baseline_commit, 40, "baseline commit")
    _sha(candidate_commit, 40, "candidate commit")
    if baseline_commit == candidate_commit:
        _fail("baseline and candidate commits must differ")
    if type(seed) is not int or type(bootstrap_samples) is not int or not 1 <= bootstrap_samples <= 100000:
        _fail("invalid bootstrap controls")
    if not isinstance(expected_tasks, dict) or set(expected_tasks) != {"dev", "heldout"}:
        _fail("exact frozen dev and heldout memberships are required")
    memberships = {}
    for split, tasks in expected_tasks.items():
        if (not isinstance(tasks, (list, tuple)) or any(not isinstance(task, str) or not task.strip() for task in tasks)
                or len(set(tasks)) != len(tasks) or len(tasks) < 3):
            _fail("each frozen split requires at least three unique task clusters")
        memberships[split] = set(tasks)
    if memberships["dev"] & memberships["heldout"]:
        _fail("frozen split memberships overlap")
    variants, seen, dimension = [], set(), None
    for records, commit in ((baseline_records, baseline_commit), (candidate_records, candidate_commit)):
        try:
            records = list(records)
        except TypeError:
            _fail("normalized record sequence is required")
        if not records or len(records) > 100000 or len(_canonical(records).encode("utf8")) > _LIMIT:
            _fail("normalized record input is empty or exceeds limit")
        grouped, configs = {split: defaultdict(list) for split in memberships}, set()
        for record in records:
            if not isinstance(record, dict) or type(record.get("schema_version")) is not int or record["schema_version"] != 1:
                _fail("unsupported normalized record schema")
            _reject_raw(record)
            split, task = record.get("split"), record.get("task_id")
            if not isinstance(split, str) or split not in memberships or not isinstance(task, str) or task not in memberships[split]:
                _fail("record is outside frozen split membership")
            if record.get("harness_commit") != commit:
                _fail("record harness commit does not match variant")
            if type(record.get("passed")) is not bool:
                _fail("normalized outcome must be boolean")
            if (not isinstance(record.get("run_id"), str) or not record["run_id"].strip()
                    or type(record.get("attempt")) is not int or record["attempt"] < 1):
                _fail("complete run/task/attempt identity is required")
            config = record.get("configuration_id")
            if not isinstance(config, str) or not config.strip():
                _fail("configuration identity is required")
            if record.get("task_checksum") is not None and not isinstance(record["task_checksum"], str):
                _fail("invalid frozen task checksum")
            for field in ("usage_complete", "synthetic"):
                if field in record and type(record[field]) is not bool:
                    _fail("invalid normalized completeness flag")
            configs.add(config)
            try:
                identities = _record_identities(record)
            except ValueError:
                _fail("invalid normalized attempt identity")
            for identity in identities:
                if identity in seen:
                    _fail("duplicate normalized attempt identity across variants")
                seen.add(identity)
            current = (_model(record), _canonical({key: [key in record, record.get(key)] for key in _DIMENSIONS}))
            if dimension is None:
                dimension = current
            elif current != dimension:
                _fail("mixed model or evaluation protocol dimensions")
            grouped[split][task].append(record)
        if len(configs) != 1:
            _fail("each variant must contain exactly one configuration")
        for split, tasks in memberships.items():
            if set(grouped[split]) != tasks:
                _fail("normalized records do not cover complete frozen split")
        variants.append(grouped)
    baseline, candidate = variants
    repetitions = set()
    for split, tasks in memberships.items():
        for task in tasks:
            for variant in variants:
                attempts = sorted(record["attempt"] for record in variant[split][task])
                if attempts != list(range(1, len(attempts) + 1)):
                    _fail("attempts must be complete contiguous repetitions without selection")
                repetitions.add(len(attempts))
                variant[split][task].sort(key=lambda record: record["attempt"])
            checksums = {record.get("task_checksum") for variant in variants for record in variant[split][task]}
            if len(checksums) != 1:
                _fail("frozen task checksums disagree")
    if len(repetitions) != 1:
        _fail("all tasks and variants require the same repetition policy")
    attempts_per_task = repetitions.pop()
    protocol = records[0].get("protocol")
    if protocol is not None:
        if not isinstance(protocol, dict):
            _fail("invalid evaluation protocol")
        if "attempts" in protocol and (type(protocol["attempts"]) is not int or protocol["attempts"] != attempts_per_task):
            _fail("observed attempts do not match declared repetition policy")
    if bootstrap_samples * attempts_per_task * sum(map(len, memberships.values())) > 50000000:
        _fail("bootstrap work exceeds offline limit")
    result = {"schema_version": 1, "status": "rejected", "reasons": [], "method": _METHOD,
              "estimand": "equal-task mean of within-task attempt pass fractions",
              "seed": seed, "bootstrap_samples": bootstrap_samples, "attempts_per_task": attempts_per_task,
              "baseline_commit": baseline_commit, "candidate_commit": candidate_commit}
    if "synthetic" in records[0]:
        result["synthetic"] = records[0]["synthetic"]
    for split in ("dev", "heldout"):
        tasks = sorted(memberships[split])
        pairs = [([record["passed"] for record in baseline[split][task]],
                  [record["passed"] for record in candidate[split][task]]) for task in tasks]
        generator = random.Random(seed + (split == "heldout"))
        samples = []
        for _ in range(bootstrap_samples):
            selected = generator.choices(pairs, k=len(tasks))
            samples.append(fmean(fmean(generator.choices(after, k=attempts_per_task)) -
                                 fmean(generator.choices(before, k=attempts_per_task)) for before, after in selected))
        samples.sort()
        section = {"delta": fmean(fmean(after) - fmean(before) for before, after in pairs),
                   "ci95": [_percentile(samples, 0.025), _percentile(samples, 0.975)]}
        for name, variant in (("baseline", baseline), ("candidate", candidate)):
            safe_records = [_accounting(record) for task in tasks for record in variant[split][task]]
            try:
                section[name] = summarize_runs(safe_records, seed=seed, bootstrap_samples=bootstrap_samples)
            except (ValueError, TypeError, AttributeError, OverflowError):
                _fail("invalid normalized accounting")
        result[split] = section
    if result["dev"]["ci95"][0] <= 0:
        result["reasons"].append("dev improvement is not established at the 95% confidence level")
    if result["heldout"]["ci95"][0] < 0:
        result["reasons"].append("heldout non-regression is not established at the 95% confidence level")
    if not result["reasons"]:
        result["status"] = "accepted"
    return result


def _number(value, *, nullable=False, signed=False):
    if value is None and nullable:
        return None
    try:
        valid = type(value) in (int, float) and math.isfinite(value) and (signed or value >= 0)
    except OverflowError:
        valid = False
    if not valid:
        _fail("invalid aggregate statistic")
    return value


def _aggregate(summary):
    """Persistent rows accept known aggregate fields only, including unknown values."""
    if not isinstance(summary, dict) or type(summary.get("schema_version")) is not int or summary["schema_version"] != 1:
        _fail("invalid aggregate summary")
    selected = {"schema_version": 1}
    for field in ("tasks", "attempts", "solved_tasks", "successful_trials"):
        value = summary.get(field)
        if type(value) is not int or value < 0:
            _fail("invalid aggregate counts")
        selected[field] = value
    cost = summary.get("cost")
    if not isinstance(cost, dict):
        _fail("invalid aggregate cost")
    selected["cost"] = {field: _number(cost.get(field), nullable=field != "known_total_usd") for field in
                        ("total_usd", "known_total_usd", "per_successful_trial_usd", "per_solved_task_usd")}
    selected["cost"].update(billing_scope="token_usage_only", billed_total_usd=None, full_billing_complete=False)
    for field in ("missing_runs", "incomplete_runs"):
        selected["cost"][field] = _number(cost.get(field))
        if type(selected["cost"][field]) is not int:
            _fail("invalid aggregate cost counts")
    if selected["cost"]["missing_runs"] or selected["cost"]["incomplete_runs"]:
        if any(selected["cost"][field] is not None for field in ("total_usd", "per_successful_trial_usd", "per_solved_task_usd")):
            _fail("unknown cost cannot become a complete cost claim")
    def numeric_summary(value):
        if not isinstance(value, dict):
            _fail("invalid aggregate accounting")
        result = {field: _number(value.get(field), nullable=field in {"total", "mean", "known_mean"})
                  for field in ("total", "mean", "known_total", "known_mean", "known_count", "missing_count", "incomplete_count")}
        for field in ("known_count", "missing_count", "incomplete_count"):
            if type(result[field]) is not int:
                _fail("invalid aggregate accounting counts")
        if result["missing_count"] or result["incomplete_count"]:
            if result["total"] is not None or result["mean"] is not None:
                _fail("unknown accounting cannot become complete")
        return result
    tokens = summary.get("tokens")
    if not isinstance(tokens, dict) or set(tokens) - _TOKEN_FIELDS:
        _fail("invalid aggregate tokens")
    selected["tokens"] = {field: numeric_summary(value) for field, value in tokens.items()}
    selected["wall_seconds"] = numeric_summary(summary.get("wall_seconds"))
    return selected


def _decision_section(section):
    if not isinstance(section, dict):
        _fail("invalid comparison section")
    delta = _number(section.get("delta"), signed=True)
    interval = section.get("ci95")
    if not isinstance(interval, list) or len(interval) != 2:
        _fail("invalid comparison confidence interval")
    interval = [_number(value, signed=True) for value in interval]
    if not -1 <= delta <= 1 or not -1 <= interval[0] <= interval[1] <= 1:
        _fail("invalid comparison confidence interval")
    return {"delta": delta, "ci95": interval,
            "baseline": _aggregate(section.get("baseline")), "candidate": _aggregate(section.get("candidate"))}


def _safe_path(path, *, directory=False):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            _fail("leaderboard path must not use symlinks or reparse points")
        if part == path and not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
            _fail("leaderboard path has an invalid file type")
    return path


def _load(path):
    _safe_path(path)
    if not path.exists():
        return {"schema_version": 1, "entries": []}
    if path.stat().st_size > _LIMIT:
        _fail("leaderboard exceeds storage limit")
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                _fail("corrupt leaderboard duplicate keys")
            result[key] = value
        return result
    try:
        value = json.loads(path.read_text(encoding="utf8"), object_pairs_hook=unique_keys,
                           parse_constant=lambda _: _fail("corrupt leaderboard number"))
    except (OSError, UnicodeError, ValueError, RecursionError):
        _fail("corrupt leaderboard JSON")
    if not isinstance(value, dict) or set(value) != {"schema_version", "entries"} or type(value["schema_version"]) is not int or value["schema_version"] != 1 or not isinstance(value["entries"], list):
        _fail("corrupt leaderboard schema")
    ids = set()
    for entry in value["entries"]:
        try:
            if not isinstance(entry, dict) or set(entry) != {"schema_version", "variant_id", "status", "synthetic", "dev", "heldout", "provenance", "created_at"}:
                _fail("corrupt leaderboard entry")
            if type(entry["schema_version"]) is not int or entry["schema_version"] != 1 or entry["status"] not in ("accepted", "rejected") or type(entry["synthetic"]) is not bool:
                _fail("corrupt leaderboard entry")
            _variant_id(entry["variant_id"])
            if entry["variant_id"] in ids:
                _fail("corrupt leaderboard duplicate variant")
            ids.add(entry["variant_id"])
            for split in ("dev", "heldout"):
                if _decision_section(entry[split]) != entry[split]:
                    _fail("corrupt leaderboard aggregate")
            if entry["status"] == "accepted" and (entry["dev"]["ci95"][0] <= 0 or entry["heldout"]["ci95"][0] < 0):
                _fail("corrupt leaderboard acceptance")
            provenance = entry["provenance"]
            if set(provenance) != {"harness_commit", "baseline_commit", "proposal_sha256"}:
                _fail("corrupt leaderboard provenance")
            for field, length in (("harness_commit", 40), ("baseline_commit", 40), ("proposal_sha256", 64)):
                _sha(provenance[field], length, "leaderboard provenance")
            timestamp = datetime.fromisoformat(entry["created_at"])
            if timestamp.tzinfo is None:
                _fail("corrupt leaderboard timestamp")
        except (KeyError, TypeError, ValueError, OverflowError):
            _fail("corrupt leaderboard entry")
    return value


def _variant_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", value):
        _fail("variant ID must be a safe unique component")


def _atomic(path, content):
    _safe_path(path)
    if len(content.encode("utf8")) > _LIMIT:
        _fail("leaderboard exceeds storage limit")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", newline="\n", dir=path.parent,
                                         prefix=".leaderboard-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _markdown(entries):
    lines = ["# Variant leaderboard", "", "Aggregate offline decisions; registry token costs are not billed spend.",
             "Unknown accounting stays unknown. Synthetic rows are not benchmark evidence.", "",
             "| Variant | Evidence | Status | Dev delta [95% CI] | Heldout delta [95% CI] | Registry $ / successful trial (dev; heldout) | Tokens total (dev; heldout) | Wall seconds total (dev; heldout) | Provenance: candidate / baseline / proposal |",
             "|---|---|---|---|---|---|---|---|---|"]
    def show(value):
        return "unknown" if value is None else format(value, ".8g")
    for entry in entries:
        intervals = [show(entry[split]["delta"]) + " [" + ", ".join(map(show, entry[split]["ci95"])) + "]" for split in ("dev", "heldout")]
        candidates = [entry[split]["candidate"] for split in ("dev", "heldout")]
        costs = "; ".join(show(summary["cost"]["per_successful_trial_usd"]) for summary in candidates)
        tokens = "; ".join(show(summary["tokens"].get("total", {}).get("total")) for summary in candidates)
        wall = "; ".join(show(summary["wall_seconds"]["total"]) for summary in candidates)
        provenance = " / ".join(entry["provenance"][field] for field in ("harness_commit", "baseline_commit", "proposal_sha256"))
        lines.append("| " + " | ".join([entry["variant_id"], "SYNTHETIC" if entry["synthetic"] else "measured",
                                         entry["status"], *intervals, costs, tokens, wall, provenance]) + " |")
    return "\n".join(lines) + "\n"


def update_leaderboard(directory, variant_id, decision, *, harness_commit, baseline_commit,
                       proposal_sha256, synthetic=False):
    """Append one unique aggregate row; identical retries repair Markdown, not add rows.

    JSON is authoritative. A crash between replacements can leave Markdown stale;
    retry regenerates it under the same exclusive lock. Stale locks fail closed.
    """
    _variant_id(variant_id)
    provenance = {"harness_commit": _sha(harness_commit, 40, "harness commit"),
                  "baseline_commit": _sha(baseline_commit, 40, "baseline commit"),
                  "proposal_sha256": _sha(proposal_sha256, 64, "proposal SHA256")}
    if type(synthetic) is not bool or not isinstance(decision, dict) or type(decision.get("schema_version")) is not int or decision["schema_version"] != 1 or decision.get("status") not in ("accepted", "rejected"):
        _fail("invalid leaderboard decision")
    if decision.get("synthetic") is True and not synthetic:
        _fail("synthetic decision must retain its synthetic evidence label")
    for field, expected in (("candidate_commit", harness_commit), ("baseline_commit", baseline_commit)):
        if field in decision and decision[field] != expected:
            _fail("decision provenance does not match leaderboard")
    entry = {"schema_version": 1, "variant_id": variant_id, "status": decision["status"], "synthetic": synthetic,
             "dev": _decision_section(decision.get("dev")), "heldout": _decision_section(decision.get("heldout")),
             "provenance": provenance, "created_at": datetime.now(timezone.utc).isoformat()}
    if entry["status"] == "accepted" and (entry["dev"]["ci95"][0] <= 0 or entry["heldout"]["ci95"][0] < 0):
        _fail("accepted decision does not meet confidence gates")
    directory = _safe_path(directory, directory=True)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / ".leaderboard.lock"
    _safe_path(lock)
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        _fail("leaderboard is locked; retry after the owner completes")
    try:
        os.close(descriptor)
        ledger = _load(directory / "leaderboard.json")
        _safe_path(directory / "leaderboard.md")
        existing = next((row for row in ledger["entries"] if row["variant_id"] == variant_id), None)
        if existing is not None:
            if {key: value for key, value in existing.items() if key != "created_at"} != {key: value for key, value in entry.items() if key != "created_at"}:
                _fail("variant ID already has a different persistent decision")
            entry = existing
        else:
            ledger["entries"].append(entry)
            _atomic(directory / "leaderboard.json", json.dumps(ledger, indent=2, allow_nan=False) + "\n")
        _atomic(directory / "leaderboard.md", _markdown(ledger["entries"]))
        return entry
    finally:
        lock.unlink(missing_ok=True)
