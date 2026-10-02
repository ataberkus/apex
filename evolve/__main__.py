"""Guarded harness evolution; all commands except run are inference-free."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from .loop import (ROOT, decide, execution_plan, import_proposal, prepare_campaign,
                   reconcile, run_iterations)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('prepare', help='export prior harnesses and exact dev-only raw feedback')
    prepare.add_argument('--campaign', type=Path, required=True)
    prepare.add_argument('--campaign-id', required=True)
    prepare.add_argument('--history', type=Path, required=True, help='Git repository or full-history .bundle')
    prepare.add_argument('--baseline-commit', required=True)
    prepare.add_argument('--records', type=Path, required=True, help='complete normalized baseline dev+heldout array')
    prepare.add_argument('--trace-root', type=Path, default=ROOT / 'runs')
    prepare.add_argument('--dataset-manifest', type=Path, default=ROOT / 'evals/datasets/terminal-bench-2.0/manifest.json')
    prepare.add_argument('--evolution-config', type=Path, default=ROOT / 'evolve/config.json')
    prepare.add_argument('--integrity-terms', type=Path, help='trusted JSON: expected_outputs literal list and reviewed boolean; never mounted for proposer')
    prepare.add_argument('--context-flags', default='')
    prepare.add_argument('--core-flags', default='')
    prepare.add_argument('--feature-flags', default='')
    prepare.add_argument('--synthetic', action='store_true', help='label mechanical fixtures; prohibit real execution/promotion')
    proposal = commands.add_parser('import', help='validate one external proposal and commit an isolated candidate')
    proposal.add_argument('--campaign', type=Path, required=True)
    proposal.add_argument('--proposal', type=Path, required=True)
    decision = commands.add_parser('decide', help='gate a guarded candidate on complete normalized dev+heldout measurements')
    decision.add_argument('--campaign', type=Path, required=True)
    decision.add_argument('--records', type=Path, required=True)
    decision.add_argument('--leaderboard', type=Path, help='trusted evaluator destination; default campaign directory')
    for name in ('plan', 'run'):
        command = commands.add_parser(name, help='execution preflight only' if name == 'plan' else 'authorized proposer→micro→dev→heldout loop')
        command.add_argument('--campaign', type=Path, required=True)
        command.add_argument('--config', type=Path, default=ROOT / 'evals/config.json')
        command.add_argument('--evolution-config', type=Path, default=ROOT / 'evolve/config.json')
        command.add_argument('--ledger', type=Path, default=ROOT / 'evals/spend.json')
        command.add_argument('--estimate-usd', type=float, required=True, help='whole iteration including proposer, every trial and container costs')
        command.add_argument('--iterations', type=int, default=1)
        if name == 'run':
            command.add_argument('--leaderboard', type=Path, default=ROOT / 'evolve')
    billing = commands.add_parser('reconcile', help='record explicit actual provider/container billing; no network')
    billing.add_argument('--ledger', type=Path, default=ROOT / 'evals/spend.json')
    billing.add_argument('--config', type=Path, default=ROOT / 'evals/config.json')
    billing.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'prepare':
            result = prepare_campaign(args.campaign, campaign_id=args.campaign_id, history=args.history,
                                      baseline_commit=args.baseline_commit, records=args.records, trace_root=args.trace_root,
                                      manifest=args.dataset_manifest, evolution_config=args.evolution_config,
                                      integrity_terms=args.integrity_terms, context_flags=args.context_flags,
                                      core_flags=args.core_flags, feature_flags=args.feature_flags, synthetic=args.synthetic)
        elif args.command == 'import':
            result = import_proposal(args.campaign, args.proposal)
        elif args.command == 'decide':
            result = decide(args.campaign, args.records, leaderboard=args.leaderboard)
        elif args.command in ('plan', 'run'):
            options = dict(config=args.config, evolution_config=args.evolution_config, ledger=args.ledger,
                           estimate_usd=args.estimate_usd, iterations=args.iterations)
            result = execution_plan(args.campaign, **options) if args.command == 'plan' else run_iterations(args.campaign, **options, leaderboard=args.leaderboard)
        else:
            result = reconcile(args.ledger, args.config, args.receipt)
        print(json.dumps(result, indent=2, allow_nan=False))
        return 2 if result.get('status') == 'blocked' else 0
    except (ValueError, OSError, TypeError, KeyError, RecursionError, OverflowError, subprocess.SubprocessError) as exc:
        # OS/parse errors can include private paths/data. Never echo their payloads.
        message = str(exc) if type(exc) is ValueError and not isinstance(exc, json.JSONDecodeError) else 'invalid or unavailable input; no partial result accepted'
        print(json.dumps({'status': 'refused', 'reason': message, 'executed': False}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
