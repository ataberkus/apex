"""Offline Pi accounting and task-cluster statistics, using only the stdlib.

Pi's input excludes cache reads/writes. Reasoning is a subset of output. This
module counts final messages and auxiliary usage, never streamed snapshots.
Session files account for all stored branches, not only the active context.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime
import json
import math
from pathlib import Path
import random
from statistics import fmean
from uuid import UUID


_COMPONENTS = {"input": "input", "cache_read": "cacheRead", "cache_write": "cacheWrite", "output": "output"}


def _number(value, label, *, integer=False):
    try:
        valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError(f"{label} must be a finite nonnegative number")
    if integer and (not isinstance(value, int)):
        raise ValueError(f"{label} must be an integer")
    return value


def _usage(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label}: missing or invalid usage")
    for field in (*_COMPONENTS.values(), "totalTokens"):
        _number(value.get(field), f"{label}.usage.{field}", integer=True)
    for field, containing in (("reasoning", "output"), ("cacheWrite1h", "cacheWrite")):
        if field in value:
            _number(value[field], f"{label}.usage.{field}", integer=True)
            if value[field] > value[containing]:
                raise ValueError(f"{label}.usage.{field} exceeds {containing}")
    cost = value.get("cost")
    if not isinstance(cost, dict):
        raise ValueError(f"{label}: missing or invalid usage.cost")
    for field in (*_COMPONENTS.values(), "total"):
        _number(cost.get(field), f"{label}.usage.cost.{field}")
    return value


def _registry(prices):
    if prices is None:
        return {}
    if isinstance(prices, (str, Path)):
        try:
            prices = json.loads(Path(prices).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise ValueError(f"invalid price registry: {exc}") from exc
    if not isinstance(prices, dict) or type(prices.get("schema_version")) is not int or prices.get("schema_version") != 1 or prices.get("currency") != "USD" or prices.get("unit") != "per_million_tokens":
        raise ValueError("price registry must use schema_version=1, USD, per_million_tokens")
    if not isinstance(prices.get("models"), list):
        raise ValueError("price registry.models must be a list")
    result = {}
    for model in prices["models"]:
        if not isinstance(model, dict) or any(not isinstance(model.get(field), str) or not model[field].strip() for field in ("provider", "model")):
            raise ValueError("price registry model requires provider and model")
        key = (model["provider"], model["model"])
        if key in result:
            raise ValueError(f"duplicate price registry model: {key}")
        for component in (*_COMPONENTS, "cache_write_1h"):
            if component == "cache_write_1h" and component not in model:
                continue
            if component not in model:
                raise ValueError(f"price registry is missing {component} for {key}")
            if model[component] is not None:
                _number(model[component], f"price registry {key}.{component}")
        for field in ("source_url", "retrieved_at"):
            if field not in model or (model[field] is not None and (not isinstance(model[field], str) or not model[field].strip())):
                raise ValueError(f"price registry requires valid {field} for {key}")
            if any(model.get(c) is not None for c in (*_COMPONENTS, "cache_write_1h")) and not model[field]:
                raise ValueError(f"populated prices require {field} provenance for {key}")
        scope = model.get("pricing_scope", {})
        if not isinstance(scope, dict):
            raise ValueError(f"pricing_scope must be an object for {key}")
        if "max_prompt_tokens" in scope:
            _number(scope["max_prompt_tokens"], f"pricing_scope {key}.max_prompt_tokens", integer=True)
        if "cache_storage_usd_per_million_tokens_hour" in scope:
            _number(scope["cache_storage_usd_per_million_tokens_hour"], f"pricing_scope {key}.cache_storage_usd_per_million_tokens_hour")
        for field in ("availability", "cache_storage_kind", "service_tier", "region"):
            if field in scope and (not isinstance(scope[field], str) or not scope[field].strip()):
                raise ValueError(f"pricing_scope {key}.{field} must be a nonempty string")
        result[key] = model
    return result


def _fingerprint(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value / 1000
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.timestamp() if parsed.tzinfo else None
        except ValueError:
            return None
    return None


def analyze_pi_trace(path, prices=None):
    """Normalize raw ``pi --mode json`` or persisted session JSONL.

    Rates are explicit per-million USD catalog token prices, never a full invoice;
    per-request prompt bounds include input and both cache categories. Pi's own
    catalog cost is separately observed. Zero-filled usage, omitted summaries, and hidden summary
    retries invalidate complete spend. Unattributed auxiliary usage is unpriced.
    Exact overlap without ids is reconciled by occurrence across formats; equal
    timestamps or repeated identical final events within one format stay distinct.
    """
    registry = _registry(prices)
    rows = []
    try:
        # Pi JSONL uses LF framing; Unicode separators inside strings are data.
        for line_number, line in enumerate(Path(path).read_text(encoding="utf-8").split("\n"), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"nonfinite JSON constant {value}")))
            except (json.JSONDecodeError, ValueError) as exc:
                raise ValueError(f"invalid JSON at line {line_number}: {exc}") from exc
            if not isinstance(row, dict) or not isinstance(row.get("type"), str):
                raise ValueError(f"line {line_number}: expected Pi event/session object with type")
            rows.append(row)
    except UnicodeError as exc:
        raise ValueError(f"invalid trace encoding: {exc}") from exc
    if not rows:
        raise ValueError("empty Pi trace")

    messages = defaultdict(list)
    auxiliary = defaultdict(list)
    tools = {}
    compactions = defaultdict(list)
    branch_summaries = defaultdict(list)
    entry_payloads = {}
    timestamps = []
    warnings = []
    observed_formats = set()
    session_id = "unidentified"
    open_assistants = 0
    incomplete = False
    missing_auxiliary = False
    has_summary_retries = False

    def add_tool(call_id, name, is_error=None):
        if not isinstance(call_id, str) or not call_id:
            raise ValueError("tool call requires toolCallId/id")
        existing = tools.setdefault((session_id, call_id), {"name": name, "is_error": None})
        if is_error is not None:
            if not isinstance(is_error, bool):
                raise ValueError("tool isError must be boolean")
            if existing["is_error"] is not None and existing["is_error"] != is_error:
                raise ValueError(f"conflicting tool result for {call_id}")
            existing["is_error"] = is_error

    def add_message(message, family, entry_id=None):
        nonlocal missing_auxiliary
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            raise ValueError("final event is missing a valid message")
        role = message["role"]
        if role == "assistant":
            _usage(message.get("usage"), "assistant")
            if message.get("stopReason") not in ("pending", "stop", "length", "toolUse", "error", "aborted", "deferred"):
                raise ValueError("assistant requires valid stopReason")
            if message.get("stopReason") == "pending":
                raise ValueError("incomplete assistant final message")
            for field in ("provider", "model"):
                if not isinstance(message.get(field), str) or not message[field]:
                    raise ValueError(f"assistant requires {field}")
            for field in ("responseId", "responseModel"):
                if field in message and (not isinstance(message[field], str) or not message[field]):
                    raise ValueError(f"assistant {field} must be a nonempty string")
            if not isinstance(message.get("content"), list):
                raise ValueError("assistant content must be a list")
            messages[family].append((session_id, entry_id, message))
            for content in message.get("content", []):
                if isinstance(content, dict) and content.get("type") == "toolCall":
                    add_tool(content.get("id"), content.get("name"))
        elif role == "toolResult":
            add_tool(message.get("toolCallId"), message.get("toolName"), message.get("isError"))
            meta=(message.get("details") or {}).get("apexAux") if isinstance(message.get("details"),dict) else None
            provider=model=None
            if meta is not None:
                if not isinstance(meta,dict) or meta.get("version")!=1 or not isinstance(meta.get("attempted"),bool) or not isinstance(meta.get("complete"),bool):
                    raise ValueError("invalid Apex auxiliary tool accounting metadata")
                if meta['attempted']:
                    for field in ('provider','model'):
                        if not isinstance(meta.get(field),str) or not meta[field]:raise ValueError('Apex auxiliary metadata requires '+field)
                    provider,model=meta['provider'],meta['model']
                    if not meta['complete'] or 'usage' not in message:
                        missing_auxiliary=True
                        warnings.append('Apex auxiliary tool usage is partial or unavailable; full spend is incomplete')
            if "usage" in message:
                _usage(message["usage"], "toolResult")
                # Plain and aggregate/nested ToolResult usage stays unattributed.
                # Only Apex's explicit helper marker identifies its physical model.
                auxiliary[family].append((session_id, entry_id, "tool", message, provider, model))
        elif "usage" in message:
            _usage(message["usage"], role)
        timestamp = _timestamp(message.get("timestamp"))
        if timestamp is not None:
            timestamps.append(timestamp)

    def add_entry(entry):
        nonlocal missing_auxiliary
        if not isinstance(entry, dict) or not isinstance(entry.get("type"), str):
            raise ValueError("entry_appended is missing a valid entry")
        entry_id = entry.get("id")
        if entry_id is not None:
            if not isinstance(entry_id, str) or not entry_id:
                raise ValueError("session entry id must be a nonempty string")
            key = (session_id, entry_id)
            fingerprint = _fingerprint(entry)
            if key in entry_payloads:
                if entry_payloads[key] != fingerprint:
                    raise ValueError(f"conflicting session entry id {entry_id}")
                return
            entry_payloads[key] = fingerprint
        kind = entry["type"]
        if kind == "message":
            add_message(entry.get("message"), "session", entry_id)
        elif kind in ("compaction", "branch_summary"):
            semantic = {key: entry[key] for key in ("summary", "firstKeptEntryId", "fromId", "tokensBefore", "usage") if key in entry}
            target = compactions if kind == "compaction" else branch_summaries
            target["session"].append((session_id, entry_id, semantic))
            if "usage" in entry:
                _usage(entry["usage"], kind)
                auxiliary["session"].append((session_id, entry_id, kind, semantic, None, None))
            else:
                missing_auxiliary = True
        elif kind == "usage":
            _usage(entry.get("usage"), "usage entry")
            for field in ("provider", "model", "kind"):
                if not isinstance(entry.get(field), str) or not entry[field]:
                    raise ValueError(f"usage entry requires {field}")
            auxiliary["session"].append((session_id, entry_id, "usage:" + entry["kind"], entry, entry["provider"], entry["model"]))
        elif kind == "custom" and entry.get("customType") == "apex-helper-usage":
            # Dedicated one-per-request entries are billable. Workflow state
            # snapshots may repeat the same Usage, and are deliberately ignored.
            data = entry.get("data")
            if not isinstance(data,dict) or data.get("version") != 1:
                raise ValueError("invalid Apex helper usage entry")
            for field in ("requestId","kind","provider","model"):
                if not isinstance(data.get(field),str) or not data[field]:
                    raise ValueError(f"Apex helper usage requires {field}")
            if data.get("complete") is not True:
                missing_auxiliary = True
                warnings.append("Apex helper usage is partial or unavailable; full spend is incomplete")
            if "usage" in data:
                _usage(data["usage"],"Apex helper")
                auxiliary["session"].append((session_id,entry_id,"usage:apex-"+data["kind"],data,data["provider"],data["model"]))
            else:
                missing_auxiliary = True
        elif "usage" in entry:
            _usage(entry["usage"], kind)
            warnings.append(f"usage on unsupported entry type {kind} is not included")
            missing_auxiliary = True
        timestamp = _timestamp(entry.get("timestamp"))
        if timestamp is not None:
            timestamps.append(timestamp)

    for row in rows:
        kind = row["type"]
        if kind == "session":
            session_id = row.get("id", "unidentified")
            if not isinstance(session_id, str) or not session_id:
                raise ValueError("session id must be a nonempty string")
        timestamp = _timestamp(row.get("timestamp"))
        if timestamp is not None:
            timestamps.append(timestamp)
        if kind == "message_end":
            observed_formats.add("json_events")
            message = row.get("message")
            add_message(message, "final", row.get("entryId"))
            if message.get("role") == "assistant" and open_assistants:
                open_assistants -= 1
        elif kind == "message_start":
            observed_formats.add("json_events")
            message = row.get("message")
            if not isinstance(message, dict):
                raise ValueError("message_start missing message")
            if message.get("role") == "assistant":
                _usage(message.get("usage"), "message_start")
                open_assistants += 1
        elif kind == "message_update":
            observed_formats.add("json_events")
            if "usage" in row:
                _usage(row["usage"], "message_update")
            elif isinstance(row.get("message"), dict):
                _usage(row["message"].get("usage"), "message_update")
            else:
                raise ValueError("message_update missing usage")
        elif kind in ("turn_end", "agent_end"):
            observed_formats.add("json_events")
            snapshots = [row.get("message")] if kind == "turn_end" else row.get("messages")
            if not isinstance(snapshots, list):
                raise ValueError(f"{kind} missing messages")
            for message in snapshots:
                # Validate replayed usage but do not bill snapshots over finals.
                add_message(message, "turn" if kind == "turn_end" else "agent")
            if kind == "turn_end":
                for message in row.get("toolResults", []):
                    add_message(message, "turn_tools")
        elif kind == "entry_appended":
            observed_formats.add("json_events")
            add_entry(row.get("entry"))
        elif kind == "compaction_end":
            observed_formats.add("json_events")
            result = row.get("result")
            if result is not None:
                if not isinstance(result, dict):
                    raise ValueError("compaction_end.result must be an object")
                semantic = {key: result[key] for key in ("summary", "firstKeptEntryId", "tokensBefore", "usage") if key in result}
                compactions["event"].append((session_id, None, semantic))
                if "usage" in result:
                    _usage(result["usage"], "compaction_end")
                    auxiliary["event"].append((session_id, None, "compaction", semantic, None, None))
                else:
                    missing_auxiliary = True
            elif not row.get("aborted", False):
                incomplete = True
        elif kind.startswith("tool_execution_"):
            observed_formats.add("json_events")
            add_tool(row.get("toolCallId"), row.get("toolName"), row.get("isError") if kind == "tool_execution_end" else None)
        elif kind.startswith("summarization_retry_"):
            observed_formats.add("json_events")
            has_summary_retries = True
        elif kind in ("message", "usage", "compaction", "branch_summary", "model_change", "thinking_level_change", "custom", "custom_message", "session_info", "context_edit", "label"):
            observed_formats.add("session")
            add_entry(row)
        elif "usage" in row:
            _usage(row["usage"], kind)
            warnings.append(f"usage on unsupported event type {kind} is not included")
            missing_auxiliary = True
    if open_assistants:
        raise ValueError("incomplete assistant stream: missing final message_end")

    def reconcile(families, semantic, identity):
        """Use stable ids first, then maximum exact occurrences across families."""
        identified = {}
        unidentified = defaultdict(dict)
        for family, values in families.items():
            occurrences = Counter()
            for value in values:
                key = identity(value)
                signature = semantic(value)
                if key is not None:
                    if key in identified and identified[key][0] != signature:
                        raise ValueError(f"conflicting final usage identity {key}")
                    identified.setdefault(key, (signature, value, family))
                else:
                    occurrences[signature] += 1
                    unidentified[signature].setdefault(family, []).append(value)
        results = [value for _, value, _ in identified.values()]
        known_signatures = Counter(signature for signature, _, _ in identified.values())
        for signature, counts in unidentified.items():
            # A known response-id message can overlap an id-less wrapper.
            family, values = max(counts.items(), key=lambda pair: len(pair[1]))
            amount = max(0, len(values) - known_signatures[signature])
            results.extend(values[:amount])
        return results

    def message_identity(value):
        scope, entry_id, message = value
        if message.get("responseId"):
            return (scope, "response", message["provider"], message.get("api"), message["responseId"])
        # Entry id can appear only in one representation; overlap is reconciled
        # by exact message occurrence rather than treating it as an extra call.
        return None

    finals = reconcile(messages, lambda value: _fingerprint([value[0], value[2]]), message_identity)
    extras = reconcile(auxiliary,
                       lambda value: _fingerprint([value[0], value[2], value[3], value[4], value[5]]),
                       lambda value: (value[0], "tool", value[3].get("toolCallId")) if value[2] == "tool" else None)
    compaction_rows = reconcile(compactions, lambda value: _fingerprint([value[0], value[2]]), lambda value: None)
    branch_rows = reconcile(branch_summaries, lambda value: _fingerprint([value[0], value[2]]), lambda value: None)
    observations = [("assistant", message["usage"], message["provider"], message.get("responseModel", message["model"]), message) for _, _, message in finals]
    observations.extend((category, record["usage"], provider, model, record) for _, _, category, record, provider, model in extras)
    totals = {component: 0 for component in _COMPONENTS}
    totals["thinking_tokens"] = 0
    totals["total"] = 0
    reasoning_complete = bool(observations)
    usage_complete = bool(observations) and not (incomplete or missing_auxiliary or has_summary_retries)
    observed_registry = 0.0
    pi_cost = 0.0
    missing_rates = []
    pricing_scope_issues = []
    applied_scopes = {}
    categories = defaultdict(lambda: {"records": 0, "tokens": 0})
    context_observations = []
    for category, value, provider, model, record in observations:
        tokens = sum(value[field] for field in _COMPONENTS.values())
        if tokens == 0:
            usage_complete = False
            warnings.append("zero-filled Usage is ambiguous: Pi also uses zero when provider usage is absent")
        if category == "assistant" and record.get("stopReason") in ("error", "aborted"):
            usage_complete = False
            warnings.append("failed/aborted assistant usage may be incomplete")
        if tokens != value["totalTokens"]:
            warnings.append("provider totalTokens differs from components; normalized total sums nonoverlapping components")
        for component, field in _COMPONENTS.items():
            totals[component] += value[field]
        totals["total"] += tokens
        if "reasoning" in value:
            totals["thinking_tokens"] += value["reasoning"]
        else:
            reasoning_complete = False
        pi_cost += value["cost"]["total"]
        rates = registry.get((provider, model), {})
        scope = rates.get("pricing_scope", {})
        prompt_tokens = value["input"] + value["cacheRead"] + value["cacheWrite"]
        scoped_maximum = scope.get("max_prompt_tokens")
        scope_matches = scoped_maximum is None or prompt_tokens <= scoped_maximum
        if scope:
            applied_scopes[(provider, model)] = {"provider": provider, "model": model, "scope": scope}
        if not scope_matches:
            pricing_scope_issues.append({"provider": provider, "model": model, "category": category,
                                         "reason": "prompt_out_of_scope", "prompt_tokens": prompt_tokens,
                                         "max_prompt_tokens": scoped_maximum})
            warnings.append("request prompt exceeds the registry rate scope; whole-request token cost is unknown")
        if scope.get("availability"):
            pricing_scope_issues.append({"provider": provider, "model": model, "reason": "restricted_availability",
                                         "availability": scope["availability"], "account_eligibility": "unknown"})
            warnings.append("model access is restricted; account eligibility is unknown and no model selection is implied")
        if "cache_storage_usd_per_million_tokens_hour" in scope and value["cacheRead"] + value["cacheWrite"] > 0:
            pricing_scope_issues.append({"provider": provider, "model": model, "reason": "cache_storage_not_observed",
                                         "cache_storage_kind": scope.get("cache_storage_kind"),
                                         "published_usd_per_million_tokens_hour": scope["cache_storage_usd_per_million_tokens_hour"]})
            warnings.append("cache usage cannot distinguish implicit from explicit caching; storage token-hours and full billed cost are unavailable")
        missing = []
        billed_components = {component: value[field] for component, field in _COMPONENTS.items()}
        long_write = value.get("cacheWrite1h", 0)
        billed_components["cache_write"] -= long_write
        billed_components["cache_write_1h"] = long_write
        for component, count in billed_components.items():
            if count == 0:
                continue
            rate = rates.get(component) if scope_matches else None
            if rate is None:
                missing.append(component)
            else:
                observed_registry += count * rate / 1_000_000
        if missing:
            missing_rates.append({"provider": provider, "model": model, "category": category, "components": missing,
                                  "reason": "prompt_out_of_scope" if not scope_matches else "rate_unavailable"})
        categories[category]["records"] += 1
        categories[category]["tokens"] += tokens
        if category == "assistant" and tokens:
            context_observations.append(value["totalTokens"] or tokens)
    if not reasoning_complete:
        totals["thinking_tokens"] = None
    if not observations:
        totals = {component: None for component in totals}
        pi_cost = None
    if missing_auxiliary:
        warnings.append("summary/compaction usage omitted; full run token usage and spend are incomplete")
    if has_summary_retries:
        warnings.append("summary retries expose no usage for discarded calls; full run accounting is incomplete")
    if any(value["is_error"] is None for value in tools.values()):
        incomplete = True
        warnings.append("some tool calls have no observed final result")
    span = max(timestamps) - min(timestamps) if len(timestamps) >= 2 else None
    peak = max(context_observations) if context_observations else None
    format_name = next(iter(observed_formats)) if len(observed_formats) == 1 else "mixed" if observed_formats else "unknown"
    availability = {
        "tokens": {"status": "observed" if observations else "unavailable", "complete": usage_complete, "detail": "reported nonoverlapping components across all stored history; reasoning subset is not added again"},
        "thinking_tokens": {"status": "observed" if reasoning_complete else "unavailable", "detail": "only available when every usage record reports reasoning"},
        "wall_seconds": {"status": "estimate" if span is not None else "unavailable", "detail": "timestamp span includes idle time and is not process runtime"},
        "peak_context_tokens": {"status": "estimate" if peak is not None else "unavailable", "detail": "maximum assistant usage.totalTokens includes output; omits growth between responses and is not exact peak context"},
        "turns": {"status": "observed" if finals else "unavailable", "detail": "one finalized assistant response per Pi turn; auxiliary calls are separate"},
        "tool_calls": {"status": "observed" if tools else "unavailable", "detail": "unique reported tool call ids, including observed nested calls; undisclosed nested calls are unavailable"},
        "tool_errors": {"status": "observed" if tools and not incomplete else "unavailable", "detail": "only explicit isError booleans; missing results remain unknown"},
        "compactions": {"status": "observed" if compaction_rows else "unavailable", "detail": "successful reported compaction entries/results"},
        "category_attribution": {"status": "partial", "detail": "record-source categories only; exact thinking/tool-output/reread/system-prompt attribution is unavailable"},
        "capture_completeness": {"status": "unverified", "detail": "valid JSONL cannot prove that the capture contains every billable request"},
        "billing_total": {"status": "unavailable", "detail": "registry and Pi costs cover catalog token usage only; storage, tool and container charges and account adjustments are not measured"},
    }
    return {
        "schema_version": 1, "trace_format": format_name, "tokens": totals,
        "models": [dict(zip(("provider", "requested_model", "model"), key)) for key in sorted({
            (message["provider"], message["model"], message.get("responseModel", message["model"]))
            for _, _, message in finals})],
        "usage_complete": usage_complete,
        "cost": {"registry_usd": observed_registry if observations and usage_complete and not missing_rates else None,
                 "observed_registry_usd": observed_registry if observations and not missing_rates else None,
                 "known_registry_subtotal_usd": observed_registry if observations else None,
                 "observed_pi_usd": pi_cost, "currency": "USD", "missing_rates": missing_rates,
                 "complete": usage_complete and not missing_rates, "billing_scope": "token_usage_only",
                 "billed_total_usd": None, "full_billing_complete": False,
                 "pricing_scope_issues": pricing_scope_issues,
                 "applied_pricing_scopes": [applied_scopes[key] for key in sorted(applied_scopes)]},
        "counts": {"assistant_calls": len(finals), "auxiliary_usage_records": len(extras),
                   "turns": len(finals) if finals else None, "tool_calls": len(tools) if tools else None,
                   "tool_errors": sum(value["is_error"] is True for value in tools.values()) if tools and not incomplete else None,
                   "compactions": len(compaction_rows) if compaction_rows else None,
                   "branch_summaries": len(branch_rows) if branch_rows else None},
        "usage_categories": dict(categories), "peak_context_tokens": peak, "wall_seconds": span,
        "availability": availability, "warnings": sorted(set(warnings)),
    }


def _numeric_summary(values, label, incomplete_count=0):
    known = [_number(value, label) for value in values if value is not None]
    complete = len(known) == len(values) and incomplete_count == 0
    return {"total": sum(known) if complete else None, "mean": fmean(known) if known and complete else None,
            "known_total": sum(known), "known_mean": fmean(known) if known else None,
            "known_count": len(known), "missing_count": len(values) - len(known),
            "incomplete_count": incomplete_count}


def _percentile(values, proportion):
    position = (len(values) - 1) * proportion
    left = math.floor(position)
    right = math.ceil(position)
    return values[left] + (values[right] - values[left]) * (position - left)


def _record_identities(record):
    """Known attempt identities; labels and trace hashes are not identities."""
    identities = []
    run_id = record.get("run_id")
    attempt = record.get("attempt")
    if run_id is not None and (not isinstance(run_id, str) or not run_id.strip()):
        raise ValueError("run_id must be a nonempty string when supplied")
    if attempt is not None and (type(attempt) is not int or attempt < 1):
        raise ValueError("attempt must be a positive integer when supplied")
    if run_id is not None and attempt is not None:
        identities.append(("run_task_attempt", run_id, record["task_id"], attempt))
    trial_id = record.get("trial_id")
    if trial_id is not None:
        try:
            if not isinstance(trial_id, str):
                raise ValueError
            identities.append(("trial_id", str(UUID(trial_id))))
        except ValueError:
            raise ValueError("trial_id must be a Harbor trial UUID when supplied") from None
    result_hash = record.get("result_sha256")
    if result_hash is not None:
        if not isinstance(result_hash, str) or len(result_hash) != 64 or any(character not in "0123456789abcdefABCDEF" for character in result_hash):
            raise ValueError("result_sha256 must be a 64-character hex SHA256 when supplied")
        identities.append(("result_sha256", result_hash.lower()))
    return identities


def summarize_runs(records, seed=0, bootstrap_samples=5000):
    """Equal-task mean of attempt pass fractions; resample whole task clusters.

    Primary costs sum all attempts and divide by successful trials. A secondary
    any-attempt statistic uses unique tasks solved in at least one attempt and
    depends on the repetition policy. Records need verified Boolean outcomes.
    Repeated known attempt/trial/result identities are errors, not deduplicated.
    """
    records = list(records)
    if not records:
        raise ValueError("at least one normalized run record is required")
    if isinstance(bootstrap_samples, bool) or not isinstance(bootstrap_samples, int) or bootstrap_samples < 1:
        raise ValueError("bootstrap_samples must be a positive integer")
    groups = defaultdict(list)
    configurations = set()
    seen_identities = set()
    unknown_identity_records = 0
    association_counts = {"caller_supplied": 0, "unverified": 0, "verified": 0, "unknown": 0, "missing": 0}
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("task_id"), str) or not record["task_id"].strip():
            raise ValueError("run record requires nonempty task_id")
        if not isinstance(record.get("passed"), bool):
            raise ValueError("run record passed must be a verified boolean")
        identities = _record_identities(record)
        if not identities:
            unknown_identity_records += 1
        for identity in identities:
            if identity in seen_identities:
                raise ValueError(f"duplicate normalized record: repeated {identity[0]} identity")
            seen_identities.add(identity)
        association = record.get("trace_result_association")
        if "trace_result_association" not in record:
            association_status = "missing"
        elif not isinstance(association, dict):
            association_status = "unknown"
        elif association.get("status") == "caller_supplied":
            association_status = "caller_supplied"
        elif association.get("trial_binding_verified") is False or association.get("status") == "unverified":
            association_status = "unverified"
        elif association.get("status") == "verified" and association.get("trial_binding_verified") is True:
            association_status = "verified"
        else:
            association_status = "unknown"
        association_counts[association_status] += 1
        if "configuration_id" in record:
            if not isinstance(record["configuration_id"], str) or not record["configuration_id"].strip():
                raise ValueError("configuration_id must be a nonempty string")
        configurations.add(record.get("configuration_id"))
        groups[record["task_id"]].append(record)
    if len(configurations) > 1:
        raise ValueError("summarize each configuration separately")
    task_ids = sorted(groups)
    task_rates = [sum(record["passed"] for record in groups[task]) / len(groups[task]) for task in task_ids]
    mean = fmean(task_rates)
    if len(task_ids) > 1:
        generator = random.Random(seed)
        samples = sorted(fmean(generator.choices(task_rates, k=len(task_ids))) for _ in range(bootstrap_samples))
        interval = [_percentile(samples, 0.025), _percentile(samples, 0.975)]
    else:
        interval = None
    costs = []
    wall = []
    token_components = set()
    incomplete_tokens = 0
    incomplete_costs = 0
    for record in records:
        cost = record.get("cost")
        if cost is not None and not isinstance(cost, dict):
            raise ValueError("run cost must be normalized object")
        costs.append(cost.get("registry_usd") if cost else None)
        if cost and cost.get("complete") is False:
            incomplete_costs += 1
        wall.append(record.get("wall_seconds"))
        tokens = record.get("tokens")
        if tokens is not None and not isinstance(tokens, dict):
            raise ValueError("run tokens must be normalized object")
        token_components.update(tokens or {})
        if record.get("usage_complete") is False or (record.get("availability") or {}).get("tokens", {}).get("complete") is False:
            incomplete_tokens += 1
    cost_summary = _numeric_summary(costs, "registry_usd", incomplete_costs)
    solved = sum(any(record["passed"] for record in groups[task]) for task in task_ids)
    successful_trials = sum(record["passed"] for record in records)
    warnings = []
    if association_counts["caller_supplied"] or association_counts["unverified"]:
        warnings.append("some trace/result associations are caller-supplied or unverified; trial binding is not verified")
    if association_counts["missing"] or association_counts["unknown"]:
        warnings.append("trace/result association provenance is missing or unknown for some records; trial binding cannot be established")
    if unknown_identity_records:
        warnings.append("some records lack an attempt/trial/result identity; duplicate provenance is unknown")
    if len(task_ids) < 3:
        warnings.append("fewer than 3 independent tasks; collect at least 3 for a useful cluster estimate")
    if interval is None:
        warnings.append("cluster confidence interval unavailable with fewer than 2 tasks")
    if cost_summary["missing_count"] or incomplete_costs:
        warnings.append("some run costs are unknown; complete cost and cost per solved task are unknown")
    if incomplete_tokens:
        warnings.append("some token usage is incomplete; token subtotals are observed lower bounds")
    return {
        "schema_version": 1, "tasks": len(task_ids), "attempts": len(records), "solved_tasks": solved,
        "successful_trials": successful_trials,
        "trace_result_association": {"status_counts": association_counts},
        "pass_rate": {"mean": mean, "ci95": interval, "method": "task_cluster_percentile_bootstrap",
                      "estimand": "equal-task mean of within-task attempt pass fractions", "seed": seed,
                      "bootstrap_samples": bootstrap_samples},
        "cost": {"total_usd": cost_summary["total"], "known_total_usd": cost_summary["known_total"],
                 "missing_runs": cost_summary["missing_count"], "incomplete_runs": incomplete_costs,
                 "billing_scope": "token_usage_only", "billed_total_usd": None, "full_billing_complete": False,
                 "per_solved_task_usd": cost_summary["total"] / successful_trials if successful_trials and cost_summary["total"] is not None else None,
                 "per_successful_trial_usd": cost_summary["total"] / successful_trials if successful_trials and cost_summary["total"] is not None else None,
                 "solved_definition": "successful recorded task trials; includes spend of all attempts without selecting best attempt",
                 "any_attempt_per_solved_task_usd": cost_summary["total"] / solved if solved and cost_summary["total"] is not None else None,
                 "any_attempt_definition": "secondary descriptive best-of-N count of unique tasks passed in any attempt"},
        "tokens": {component: _numeric_summary([(record.get("tokens") or {}).get(component) for record in records], component, incomplete_tokens)
                   for component in sorted(token_components)},
        "wall_seconds": _numeric_summary(wall, "wall_seconds"),
        "warnings": warnings,
    }
