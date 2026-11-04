"""Report normalized metrics only; this command never opens raw trajectories."""

import argparse
import json
from pathlib import Path
import sys

from .metrics import summarize_runs


def render_markdown(summary):
    rate = summary["pass_rate"]
    interval = rate["ci95"]
    ci = "unknown" if interval is None else f"{interval[0]:.1%}–{interval[1]:.1%}"
    cost = summary["cost"]
    price = lambda value: "unknown" if value is None else f"${value:.6f}"
    lines = ["# Offline normalized metrics report", "",
             f"{summary['tasks']} task clusters; {summary['attempts']} recorded attempts.", "",
             f"Mean pass rate: {rate['mean']:.1%}; 95% cluster bootstrap interval: {ci}.",
             "Tasks receive equal weight; repeated attempts stay inside their task clusters.", "",
             f"Total registry token cost: {price(cost['total_usd'])}.",
             f"Token cost per successful task trial: {price(cost['per_successful_trial_usd'])}.",
             "Costs exclude container, tool, explicit cache-storage, regional and account-specific charges.",
             "All attempt costs contribute; successful trials are counted without selecting a best attempt.", "",
             "Synthetic records, if present, are accounting checks and are not benchmark scores.",
             "Reports consume normalized measurements and contain no raw held-out trajectories.", ""]
    if summary["warnings"]:
        lines.extend(["## Measurement limitations", ""])
        lines.extend(f"- {warning}" for warning in summary["warnings"])
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("records", type=Path, help="normalized metrics JSON array, or object with runs array")
    parser.add_argument("--output", type=Path, help="JSON output file (stdout by default)")
    parser.add_argument("--markdown", type=Path, help="optional Markdown report output")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--bootstrap-samples", type=int, default=5000)
    args = parser.parse_args(argv)
    try:
        records = json.loads(args.records.read_text(encoding="utf-8"))
        if isinstance(records, dict):
            records = records.get("runs")
        if not isinstance(records, list):
            raise ValueError("input must contain a normalized run array")
        if any(not isinstance(record, dict) or "type" in record or "message" in record or "messages" in record for record in records):
            raise ValueError("raw trajectories are not accepted; supply normalized metrics")
        summary = summarize_runs(records, seed=args.seed, bootstrap_samples=args.bootstrap_samples)
        rendered = json.dumps(summary, indent=2, sort_keys=True, allow_nan=False) + "\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
        if args.markdown:
            args.markdown.write_text(render_markdown(summary), encoding="utf-8")
    except (OSError, ValueError, TypeError) as exc:
        parser.exit(2, f"report: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
