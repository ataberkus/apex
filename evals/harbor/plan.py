"""Prepare a reviewable command only. There is deliberately no execute option."""
import argparse
import json
from pathlib import Path
import re

from evals.guard import validate_budget
from evals.harbor.datasets import load_dataset_manifest
from evals.context_flags import validate_context_flags
from evals.core_flags import validate_core_flags,selected_core_flags,validate_time_budget,format_time_budget
from evals.feature_flags import validate_feature_flags


def prepare_plan(config, run_id, estimate_usd, harness_commit, agent='stock-pi', dataset='terminal-bench@2.0', attempts=1, apex_package=None, spent_usd=0, reserved_usd=0, dataset_manifest=None, split='dev', context_flags='', core_flags='',time_budget_sec=None, feature_flags=''):
    if not isinstance(run_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', run_id):
        raise ValueError('run ID must be a safe path component')
    if harness_commit is not None and (not isinstance(harness_commit, str) or not re.fullmatch(r'[0-9a-f]{40}', harness_commit)):
        raise ValueError('harness commit must be a full git SHA')
    if type(attempts) is not int or attempts < 1:
        raise ValueError('attempts must be a positive integer')
    if agent not in {'stock-pi', 'apex'}:
        raise ValueError('agent must be stock-pi or apex')
    if not isinstance(dataset, str) or not dataset.strip() or dataset.startswith('-'):
        raise ValueError('dataset reference is required')
    if split not in {'dev', 'heldout', 'full'}:
        raise ValueError('split must be dev, heldout, or full')
    blockers = []
    if harness_commit is None:
        blockers.append('real harness commit is unknown; a full verified git SHA is required')
    readiness = config.get('readiness_blockers', [])
    if not isinstance(readiness, list) or any(not isinstance(item, str) or not item.strip() for item in readiness):
        raise ValueError('readiness_blockers must be a list of nonempty strings')
    blockers.extend(readiness)
    if config.get('execution_policy') == 'offline-only' and config.get('paid_runs_enabled') is not True:
        blockers.append('paid runs are not enabled in the configuration')
    if estimate_usd is None:
        blockers.append('whole-run model/provider cost is unknown; a reviewed positive estimate is required')
    try:
        validate_context_flags(context_flags)
    except ValueError as exc:
        blockers.append(str(exc))
    if context_flags and agent != 'apex':
        blockers.append('Context flags require the Apex agent; stock Pi is the control')
    core=()
    deadline=None
    try:
        core=selected_core_flags(core_flags)
        deadline=validate_time_budget(time_budget_sec)
    except ValueError as exc:blockers.append(str(exc))
    if core_flags and agent!='apex':blockers.append('Core flags require the Apex agent; stock Pi is the control')
    if deadline is not None and 'time' not in core:blockers.append('time_budget_sec requires the time core feature')
    if 'max' in core:blockers.append('Max is a separate configuration blocked by the offline-only policy')
    try:
        validate_feature_flags(feature_flags)
    except ValueError as exc:
        blockers.append(str(exc))
    if feature_flags and agent != 'apex':
        blockers.append('Feature flags require the Apex agent; stock Pi is the control')
    remaining = None
    try:
        remaining = validate_budget(config, estimate_usd, spent_usd, reserved_usd)
    except ValueError as exc:
        blockers.append(str(exc))
    model = config.get('main_model')
    if model == 'openai-codex/gpt-6.1-sol':
        blockers.append('pinned Harbor Pi does not forward openai-codex OAuth credentials and PROVIDERS has no openai-codex entry; host login is not container credential provisioning')
        if agent == 'apex':
            blockers.append('Apex redirects PI_CODING_AGENT_DIR to its logs config directory; private OAuth provisioning and credential exclusion from logs/artifacts are not implemented')
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.:/+-]*', model):
        blockers.append('exact MAIN model must be configured as provider/model')
    allowed = config.get('allowed_models')
    if allowed is not None and (not isinstance(allowed, list) or not allowed
                                or any(not isinstance(item, str) for item in allowed)
                                or model not in allowed):
        blockers.append('MAIN model is not allowed by the explicit model restriction')
    thinking = config.get('thinking_level')
    if thinking is not None and (not isinstance(thinking, str) or thinking not in {'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}):
        blockers.append('thinking level must match the pinned Harbor Pi options')
    if context_flags and (model != 'openrouter/meta/muse-spark-1.3-contributor' or thinking != 'xhigh'):
        blockers.append('Phase 1 context flags require the selected Muse model at xhigh')
    if core_flags and (model!='openrouter/meta/muse-spark-1.3-contributor' or thinking!='xhigh'):
        blockers.append('Phase 2 core flags require the selected Muse model at xhigh')
    if feature_flags and (model != 'openrouter/meta/muse-spark-1.3-contributor' or thinking != 'xhigh'):
        blockers.append('Phase 3 feature flags require the selected Muse model at xhigh')
    environment = config.get('container_environment')
    if not isinstance(environment, str) or not re.fullmatch(r'[a-z][a-z0-9-]*', environment):
        blockers.append('container environment must be configured')
    frozen = None
    manifest_path = dataset_manifest or config.get('dataset_manifest')
    if not manifest_path:
        blockers.append('a frozen dataset manifest is required')
    else:
        try:
            frozen = load_dataset_manifest(manifest_path, dataset, split)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            blockers.append(f'dataset manifest is invalid: {exc}')
    if agent == 'apex':
        if apex_package is None or not Path(apex_package).is_file() or Path(apex_package).suffix != '.tgz':
            blockers.append('existing local Apex .tgz package is required')
        elif not Path(apex_package).is_absolute():
            blockers.append('Apex package path must be absolute')
    argv = None
    if not blockers:
        argv = ['harbor', 'run', '--dataset', dataset, '--agent', 'pi' if agent == 'stock-pi' else 'evals.harbor.apex:ApexAgent',
                '--model', model, '--n-attempts', str(attempts), '--env', environment,
                '--job-name', run_id, '--jobs-dir', 'runs/harbor', '--agent-kwarg', 'version=1.3.0']
        if thinking is not None:
            argv.extend(['--agent-kwarg', f'thinking={thinking}'])
        argv.extend(['--registry-path', str(frozen['registry_path'])])
        if split != 'full':
            for task in frozen['task_names']:
                argv.extend(['--include-task-name', task])
        if agent == 'apex':
            argv.extend(['--agent-kwarg', f'apex_package={Path(apex_package)}'])
            if context_flags:
                argv.extend(['--agent-kwarg', f'context_flags={context_flags}'])
            if core_flags:argv.extend(['--agent-kwarg',f'core_flags={core_flags}'])
            if deadline is not None:argv.extend(['--agent-kwarg',f'time_budget_sec={format_time_budget(deadline)}'])
            if feature_flags:
                argv.extend(['--agent-kwarg', f'feature_flags={feature_flags}'])
    return {'schema_version': 1, 'status': 'blocked' if blockers else 'ready_for_review',
            'blockers': blockers, 'configuration': agent + (f':{context_flags}' if context_flags else '') +
            ((';' if context_flags else ':')+f'core={core_flags}' if core_flags else '') +
            ((';' if context_flags or core_flags else ':') + f'features={feature_flags}' if feature_flags else ''),
            'core_flags':core_flags,'time_budget_sec':deadline,
            'feature_flags': feature_flags, 'eval_mode': bool(feature_flags),
            'context_flags': context_flags, 'dataset': dataset, 'attempts': attempts,
            'split': split, 'task_count': len(frozen['task_names']) if frozen else None,
            'planned_trials': len(frozen['task_names']) * attempts if frozen else None,
            'dataset_manifest_sha256': frozen['manifest_sha256'] if frozen else None,
            'dataset_registry_sha256': frozen['registry_sha256'] if frozen else None,
            'dataset_source_commit': frozen['source_commit'] if frozen else None,
            'image_digests_status': frozen['image_digests_status'] if frozen else 'unresolved',
            'harness_commit': harness_commit, 'main_model': model, 'thinking_level': thinking, 'estimated_token_cost_usd': estimate_usd,
            'remaining_after_estimate_usd': remaining, 'harbor_argv': argv,
            'executed': False, 'notes': ['Estimate is for the whole run including every attempt; include container charges separately.',
                                       'Use source-pinned Harbor commit 99218a4611e3bd76e49ce3b5f977e8c8134ad3ac; plain harbor resolves through PATH.',
                                       'No execution or reservation is performed. Recheck actual spend and concurrent reservations before launch.',
                                       'Revalidate the frozen manifest and registry hashes before launching; this plan is not an executor.',
                                       'Git task definitions are pinned; container image digests remain unresolved.',
                                       'Harbor retains original task timeouts and resources. This plan never changes them.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('evals/config.json'))
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--estimate-usd', type=float, required=True)
    parser.add_argument('--harness-commit', required=True)
    parser.add_argument('--agent', choices=['stock-pi', 'apex'], default='stock-pi')
    parser.add_argument('--dataset', default='terminal-bench@2.0')
    parser.add_argument('--attempts', type=int, default=1)
    parser.add_argument('--dataset-manifest', type=Path)
    parser.add_argument('--split', choices=['dev', 'heldout', 'full'], default='dev')
    parser.add_argument('--apex-package', type=Path)
    parser.add_argument('--context-flags', default='', help='Opt-in Apex ablation flags; empty keeps the control behavior')
    parser.add_argument('--spent-usd', type=float, default=0)
    parser.add_argument('--reserved-usd', type=float, default=0)
    parser.add_argument('--core-flags',default='')
    parser.add_argument('--time-budget-sec',type=float)
    parser.add_argument('--feature-flags', default='', help='Opt-in Phase 3 daily-driver flags; Apex variants explicitly disable learnings in eval mode')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    plan = prepare_plan(json.loads(args.config.read_text()), args.run_id, args.estimate_usd, args.harness_commit,
                        args.agent, args.dataset, args.attempts, args.apex_package, args.spent_usd, args.reserved_usd,
                        args.dataset_manifest, args.split, args.context_flags,args.core_flags,args.time_budget_sec,args.feature_flags)
    rendered = json.dumps(plan, indent=2, allow_nan=False) + '\n'
    if args.output:
        args.output.write_text(rendered, encoding='utf8')
    print(rendered, end='')
    return 2 if plan['status'] == 'blocked' else 0


if __name__ == '__main__':
    raise SystemExit(main())
