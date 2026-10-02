"""Offline structural checks; never imports provider clients or runs benchmarks."""
import ast
import importlib.metadata
import json
from pathlib import Path

from evals.analysis.metrics import _registry
from evals.harbor.datasets import load_dataset_manifest
from evals.context_flags import FEATURES
from evals.core_flags import FEATURES as CORE_FEATURES
from evals.feature_flags import FEATURES as DAILY_FEATURES


root = Path.cwd()
for directory in ('evals', 'evolve', 'scripts', 'tests'):
    for source in (root / directory).rglob('*.py'):
        ast.parse(source.read_text(encoding='utf8'), filename=str(source))
for source in [root / 'package.json', root / 'package-lock.json', *root.joinpath('evals').glob('*.json'), root / 'evolve/config.json']:
    json.loads(source.read_text(encoding='utf8'))
_registry(root / 'evals/pricing.json')
ablations = json.loads((root / 'evals/phase1-ablations.json').read_text(encoding='utf8'))
if tuple(row['flag'] for row in ablations['features']) != FEATURES:
    raise RuntimeError('Python feature validation and ablation registry disagree')
core=json.loads((root/'evals/phase2-ablations.json').read_text(encoding='utf8'))
if tuple(row['flag'] for row in core['features'])!=CORE_FEATURES:raise RuntimeError('Python Phase 2 validation and ablation registry disagree')
daily = json.loads((root / 'evals/phase3-ablations.json').read_text(encoding='utf8'))
if tuple(row['flag'] for row in daily['features']) != DAILY_FEATURES:
    raise RuntimeError('Python Phase 3 validation and ablation registry disagree')
config = json.loads((root / 'evals/config.json').read_text(encoding='utf8'))
if config.get('dataset_manifest'):
    path = root / config['dataset_manifest']
    selected = json.loads(path.read_text(encoding='utf8'))
    load_dataset_manifest(path, selected['dataset'], 'dev')
pins = json.loads((root / 'evals/versions.json').read_text(encoding='utf8'))
distribution = importlib.metadata.distribution('harbor')
direct = json.loads(distribution.read_text('direct_url.json') or '{}')
if direct.get('vcs_info', {}).get('commit_id') != pins['harbor']['commit']:
    raise RuntimeError('Harbor must be installed from the exact commit in evals/versions.json, not the same-numbered PyPI release')
print('Python syntax and pinned Harbor checks passed.')
