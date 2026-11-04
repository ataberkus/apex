"""Offline paired final-validation metadata; never launches Harbor or reads credentials."""
import argparse
import json
from pathlib import Path

from evals.harbor.plan import prepare_plan

MODELS = ('openrouter/meta/muse-spark-1.3-contributor', 'openai-codex/gpt-6.1-sol')
AGENTS = ('stock-pi', 'apex')
SPLITS = ('dev', 'heldout', 'full')


def prepare_matrix(policy, matrix, apex_package=None):
    if (matrix.get('models') != list(MODELS) or matrix.get('agents') != list(AGENTS)
            or matrix.get('splits') != list(SPLITS) or type(matrix.get('attempts')) is not int
            or matrix['attempts'] != 5 or matrix.get('thinking_level') != 'xhigh'
            or matrix.get('default_on_ablations') != [] or matrix.get('metadata_only') is not True):
        raise ValueError('final validation requires the exact two-model paired xhigh matrix, all three splits, five attempts and zero default-on ablations')
    blockers = list(matrix['readiness_blockers'])
    if matrix.get('reviewed_budget') is not True:
        blockers.append('A reviewed final-validation budget is required')
    plans = []
    for model_index, model in enumerate(MODELS):
        for split in SPLITS:
            for agent in AGENTS:
                config = {**policy, 'main_model': model, 'thinking_level': 'xhigh',
                          'dataset_manifest': matrix['dataset_manifest'],
                          'readiness_blockers': list(blockers)}
                # Offline Sol planning authorization does not change the live model restriction.
                if agent == 'apex' and matrix.get('apex_source_commit') is None:
                    config['readiness_blockers'].append('Real Apex harness/package source commit is unknown; record the actual revision before launch')
                run_id = f'final-m{model_index + 1}-{split}-{agent}'
                plan = prepare_plan(config, run_id, matrix.get('estimated_token_cost_usd'),
                                    matrix.get('harness_commit'), agent=agent,
                                    dataset=matrix['dataset'], attempts=5, split=split,
                                    apex_package=apex_package)
                plan['run_id'] = run_id
                plan['harbor_commit'] = matrix.get('harbor_commit')
                plan['apex_source_commit'] = matrix.get('apex_source_commit') if agent == 'apex' else None
                plan['normalized_records_path'] = f'runs/final-validation/{run_id}.normalized.json'
                plan['report_argv'] = ['python', '-m', 'evals.analysis.report', plan['normalized_records_path']]
                plans.append(plan)
    return {'schema_version': 1, 'status': 'blocked' if any(p['blockers'] for p in plans) else 'ready_for_review',
            'metadata_only': True, 'executed': False, 'plans': plans,
            'default_on_ablation_count': 0, 'baseline_status': 'absent',
            'acceptance_blockers': ['No real stock Pi baseline or paired Apex normalized results are supplied; benchmark acceptance is blocked'],
            'report_contract': {'group_by': ['main_model', 'split', 'configuration'],
                                'required_attempts_per_task': 5,
                                'metrics': ['task-cluster pass-rate CI95', 'observed token subsets and completeness',
                                            'wall_seconds', 'token cost per successful trial'],
                                'cost_scope': 'Unknown costs stay null; token-only costs exclude container and account-specific charges',
                                'provenance': 'Require real normalized records with verified trial/result binding; no synthetic benchmark evidence',
                                'split_overlap': 'Full includes dev and heldout; do not pool split reports or select best attempts'}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('evals/config.json'))
    parser.add_argument('--matrix', type=Path, default=Path('evals/final-validation.json'))
    parser.add_argument('--apex-package', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    result = prepare_matrix(json.loads(args.config.read_text(encoding='utf8')),
                            json.loads(args.matrix.read_text(encoding='utf8')), args.apex_package)
    rendered = json.dumps(result, indent=2, allow_nan=False) + '\n'
    if args.output:
        args.output.write_text(rendered, encoding='utf8')
    print(rendered, end='')
    return 2 if result['status'] == 'blocked' else 0


if __name__ == '__main__':
    raise SystemExit(main())
