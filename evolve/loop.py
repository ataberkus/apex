"""Trusted evaluator controller. Candidate code only executes in containers."""
from contextlib import contextmanager
from decimal import Decimal
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from uuid import uuid4

from evals.analysis.metrics import summarize_runs
from evals.analysis.normalize import normalize_attempt
from evals.analysis.trace_store import ingest_trace
from evals.guard import validate_budget
from evals.harbor.datasets import load_dataset_manifest
from evals.harbor.plan import prepare_plan
from .comparison import compare_variants, update_leaderboard
from .integrity import apply_proposal
from .sources import build_rules, export_feedback, export_history

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'openrouter/meta/muse-spark-1.3-contributor'
HARBOR_COMMIT = '99218a4611e3bd76e49ce3b5f977e8c8134ad3ac'
RUNTIME = ('bin', 'lib', 'extensions', 'prompts', 'skills', 'templates', 'package.json', 'package-lock.json')
MAX_JSON = 32 * 1024 * 1024


def regular(path, *, directory=False):
    path = Path(path).absolute()
    for component in (path, *path.parents):
        if component.is_symlink() or (component.exists() and getattr(component.lstat(), 'st_file_attributes', 0) & 0x400):
            raise ValueError('filesystem links are forbidden')
    if directory:
        if not path.is_dir():
            raise ValueError('directory is missing')
    elif not path.is_file() or path.stat().st_nlink != 1:
        raise ValueError('regular file is required')
    return path


def read_json(path):
    path = regular(path)
    if path.stat().st_size > MAX_JSON:
        raise ValueError('JSON input exceeds size limit')
    def finite(value):
        raise ValueError('nonfinite JSON is forbidden')
    return json.loads(path.read_text(encoding='utf8'), parse_constant=finite)


def write_json(path, value):
    path = Path(path)
    regular(path.parent, directory=True)
    if path.exists():
        regular(path)
    temporary = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf8') as stream:
            stream.write(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def locked(directory, name='campaign'):
    directory = regular(directory, directory=True)
    path = directory / ('.' + name + '.lock')
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ValueError('operation is locked; inspect interrupted owner before clearing') from None
    try:
        os.write(descriptor, str(os.getpid()).encode('ascii'))
        yield
    finally:
        os.close(descriptor)
        path.unlink()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,49}', value):
        raise ValueError('safe campaign identifier required')
    return value


def settings(path):
    value = read_json(path)
    if not isinstance(value, dict) or value.get('schema_version') != 1:
        raise ValueError('invalid evolution settings')
    for name, upper in (('max_iterations', 1000), ('bootstrap_samples', 100000)):
        if type(value.get(name)) is not int or not 1 <= value[name] <= upper:
            raise ValueError('invalid evolution limits')
    return value


def records_file(path):
    value = read_json(path)
    if not isinstance(value, list) or not value or any(not isinstance(row, dict) or any(key in row for key in ('type', 'message', 'messages')) for row in value):
        raise ValueError('normalized measurement array required')
    return value


def frozen(path):
    manifest = read_json(path)
    if not isinstance(manifest, dict):
        raise ValueError('invalid dataset manifest')
    selected = {split: load_dataset_manifest(path, manifest.get('dataset'), split) for split in ('dev', 'heldout', 'full')}
    return manifest, selected


def check_baseline(records, selection, commit):
    if not isinstance(commit, str) or not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('full baseline commit required')
    if any(row.get('harness_commit') != commit or row.get('split') not in ('dev', 'heldout') for row in records):
        raise ValueError('baseline commit or split mismatch')
    for row in records:
        models = row.get('models')
        if not isinstance(models, list) or len(models) != 1 or not isinstance(models[0], dict) or models[0].get('provider') != 'openrouter' or models[0].get('requested_model', models[0].get('model')) != MODEL.split('/', 1)[1]:
            raise ValueError('baseline must use the selected physical model')
    attempts = set()
    for split in ('dev', 'heldout'):
        subset = [row for row in records if row['split'] == split]
        if {row.get('task_id') for row in subset} != set(selection[split]['task_names']):
            raise ValueError('complete frozen baseline split required')
        summarize_runs(subset)
        for task in selection[split]['task_names']:
            rows = [row for row in subset if row['task_id'] == task]
            if sorted(row.get('attempt', 0) for row in rows) != list(range(1, len(rows) + 1)):
                raise ValueError('baseline attempt identities must be complete')
            attempts.add(len(rows))
    if len(attempts) != 1:
        raise ValueError('baseline repetition policy must be uniform')
    return attempts.pop()


def _hide_nondev(corpus, selection):
    # Dev evidence can itself contain cross-split text. Do not export such a corpus.
    prohibited = set(selection['full']['task_names']) - set(selection['dev']['task_names'])
    patterns = [re.compile(r'(?<![\w.-])' + re.escape(term.casefold()) + r'(?![\w.-])') for term in prohibited]
    for path in corpus.rglob('*'):
        if path.is_dir():
            regular(path, directory=True)
            continue
        regular(path)
        data = path.read_bytes()
        if len(data) > MAX_JSON:
            raise ValueError('corpus entry exceeds size limit')
        text = data.decode('utf8').casefold()
        if any(pattern.search(text) for pattern in patterns):
            raise ValueError('corpus contains non-dev task references')


def prepare_campaign(destination, *, campaign_id, history, baseline_commit, records, trace_root,
                     manifest, evolution_config, integrity_terms=None, context_flags='', core_flags='',
                     feature_flags='', synthetic=False):
    identifier(campaign_id)
    limits = settings(evolution_config)
    measurements = records_file(records)
    if any(row.get('synthetic') is True for row in measurements) and not synthetic:
        raise ValueError('synthetic measurement provenance cannot be removed')
    metadata, selection = frozen(manifest)
    attempts = check_baseline(measurements, selection, baseline_commit)
    terms = read_json(integrity_terms) if integrity_terms else {'expected_outputs': [], 'reviewed': False}
    if not isinstance(terms, dict) or type(terms.get('reviewed')) is not bool or not isinstance(terms.get('expected_outputs'), list):
        raise ValueError('reviewed expected-output literal inventory required')
    from evals.context_flags import validate_context_flags
    from evals.core_flags import validate_core_flags
    from evals.feature_flags import validate_feature_flags
    validate_context_flags(context_flags)
    validate_core_flags(core_flags)
    validate_feature_flags(feature_flags)
    destination = Path(destination).absolute()
    regular(destination.parent, directory=True)
    if destination.exists():
        raise ValueError('campaign destination already exists')
    with tempfile.TemporaryDirectory(prefix='.evolve-prepare-', dir=destination.parent) as temporary:
        staged = Path(temporary) / 'campaign'
        staged.mkdir(mode=0o700)
        corpus = staged / 'corpus'
        corpus.mkdir(mode=0o700)
        history_summary = export_history(history, corpus, commits=[baseline_commit])
        if baseline_commit not in history_summary['commits']:
            raise ValueError('baseline is absent from prior history')
        feedback = export_feedback(trace_root, measurements, corpus, selection['dev']['task_names'], history_summary['commits'])
        write_json(corpus / 'request.json', {'schema_version': 1, 'baseline_commit': baseline_commit, 'one_change': True})
        _hide_nondev(corpus, selection)
        rules = build_rules(manifest, trace_root, terms['expected_outputs'])
        write_json(staged / 'rules.json', rules)
        write_json(staged / 'baseline.json', measurements)
        write_json(staged / 'all-records.json', measurements)
        (staged / 'iterations').mkdir(mode=0o700)
        write_json(staged / 'campaign.json', {
            'schema_version': 1, 'campaign_id': campaign_id, 'baseline_commit': baseline_commit,
            'dataset_manifest': str(Path(manifest).absolute()), 'dataset': metadata['dataset'],
            'manifest_sha256': selection['dev']['manifest_sha256'], 'registry_sha256': selection['dev']['registry_sha256'],
            'trace_root': str(Path(trace_root).absolute()), 'history_commits': history_summary['commits'],
            'limits': limits, 'expected_outputs_reviewed': terms['reviewed'], 'synthetic': bool(synthetic),
            'protocol': {'attempts': attempts, 'model': MODEL, 'thinking': 'xhigh', 'context_flags': context_flags,
                         'core_flags': core_flags, 'feature_flags': feature_flags}, 'iterations': []})
        os.rename(staged, destination)
    return {'status': 'prepared', 'campaign_id': campaign_id, 'prior_versions': len(history_summary['commits']),
            'dev_attempts': feedback['dev_attempts'], 'synthetic': bool(synthetic), 'provider_calls': 0}


def state_of(campaign):
    state = read_json(Path(campaign) / 'campaign.json')
    if not isinstance(state, dict) or state.get('schema_version') != 1 or not isinstance(state.get('iterations'), list):
        raise ValueError('invalid campaign state')
    identifier(state.get('campaign_id'))
    _, selection = frozen(state['dataset_manifest'])
    if selection['dev']['manifest_sha256'] != state['manifest_sha256'] or selection['dev']['registry_sha256'] != state['registry_sha256']:
        raise ValueError('frozen dataset changed since campaign preparation')
    return state, selection


def import_proposal(campaign, proposal_path):
    campaign = regular(campaign, directory=True)
    with locked(campaign):
        state, selection = state_of(campaign)
        if len(state['iterations']) >= state['limits']['max_iterations']:
            raise ValueError('iteration limit reached')
        if any(item['status'] in ('preparing', 'proposed', 'evaluating', 'evaluation_failed') for item in state['iterations']):
            raise ValueError('outstanding or failed evaluation must be resolved in a reviewed campaign')
        proposal = read_json(proposal_path)
        number = len(state['iterations']) + 1
        variant_id = f"{state['campaign_id']}-iteration-{number:03d}"
        directory = campaign / 'iterations' / f'{number:03d}'
        directory.mkdir(mode=0o700)
        entry = {'variant_id': variant_id, 'number': number, 'status': 'preparing', 'baseline_commit': state['baseline_commit']}
        state['iterations'].append(entry)
        write_json(campaign / 'campaign.json', state)
        try:
            base = campaign / 'corpus' / 'versions' / state['baseline_commit']
            candidate = apply_proposal(base, directory / 'candidate', proposal, read_json(campaign / 'rules.json'))
            write_json(directory / 'proposal.json', proposal)
            write_json(directory / 'candidate.json', candidate)
            version = campaign / 'corpus' / 'versions' / candidate['harness_commit']
            if not version.exists():
                _copy_runtime(directory / 'candidate', version)
                history = read_json(campaign / 'corpus' / 'history.json')
                history['commits'].append(candidate['harness_commit'])
                history['files'] += sum(path.is_file() for path in version.rglob('*'))
                write_json(campaign / 'corpus' / 'history.json', history)
            state['history_commits'] = list(dict.fromkeys([*state['history_commits'], candidate['harness_commit']]))
            _hide_nondev(campaign / 'corpus', selection)
            entry.update(status='proposed', harness_commit=candidate['harness_commit'], patch_sha256=candidate['patch_sha256'])
        except (OSError, ValueError, subprocess.SubprocessError):
            entry['status'] = 'integrity_rejected'
            write_json(campaign / 'campaign.json', state)
            raise
        write_json(campaign / 'campaign.json', state)
        return entry


def _copy_runtime(source, destination):
    destination.mkdir(mode=0o700)
    for name in RUNTIME:
        path = source / name
        if not path.exists():
            continue
        if path.is_dir():
            shutil.copytree(path, destination / name)
        else:
            shutil.copy2(regular(path), destination / name)


def decide(campaign, candidate_records, *, leaderboard=None):
    campaign = regular(campaign, directory=True)
    with locked(campaign):
        state, selection = state_of(campaign)
        if not state['iterations'] or state['iterations'][-1]['status'] != 'proposed':
            raise ValueError('a guarded outstanding proposal is required')
        entry = state['iterations'][-1]
        directory = campaign / 'iterations' / f"{entry['number']:03d}"
        records = records_file(candidate_records)
        baseline = records_file(campaign / 'baseline.json')
        decision = compare_variants(baseline, records, expected_tasks={key: selection[key]['task_names'] for key in ('dev', 'heldout')},
                                    baseline_commit=entry['baseline_commit'], candidate_commit=entry['harness_commit'],
                                    bootstrap_samples=state['limits']['bootstrap_samples'])
        all_records = records_file(campaign / 'all-records.json') + records
        # Stage feedback first: missing or contaminated raw dev evidence cannot promote a candidate.
        with tempfile.TemporaryDirectory(prefix='.feedback-', dir=campaign) as temporary:
            corpus = Path(temporary) / 'corpus'
            shutil.copytree(campaign / 'corpus', corpus)
            if not (corpus / 'versions' / entry['harness_commit']).exists():
                _copy_runtime(directory / 'candidate', corpus / 'versions' / entry['harness_commit'])
            commits = list(dict.fromkeys([*state['history_commits'], entry['harness_commit']]))
            # export_feedback owns exclusive trace destinations; rebuild only its output tree.
            shutil.rmtree(corpus / 'traces', ignore_errors=True)
            (corpus / 'dev-records.json').unlink(missing_ok=True)
            (corpus / 'scores.json').unlink(missing_ok=True)
            export_feedback(state['trace_root'], all_records, corpus, selection['dev']['task_names'], commits)
            _hide_nondev(corpus, selection)
            decision['synthetic'] = state['synthetic']
            write_json(directory / 'decision.json', decision)
            update_leaderboard(leaderboard or campaign, entry['variant_id'], decision, harness_commit=entry['harness_commit'],
                               baseline_commit=entry['baseline_commit'], proposal_sha256=entry['patch_sha256'], synthetic=state['synthetic'])
            backup = campaign / ('.corpus-' + uuid4().hex)
            os.rename(campaign / 'corpus', backup)
            try:
                os.rename(corpus, campaign / 'corpus')
            except OSError:
                os.rename(backup, campaign / 'corpus')
                raise
            shutil.rmtree(backup)
        write_json(directory / 'records.json', records)
        write_json(campaign / 'all-records.json', all_records)
        state['history_commits'] = commits
        entry['status'] = decision['status']
        if decision['status'] == 'accepted' and not state['synthetic']:
            state['baseline_commit'] = entry['harness_commit']
            write_json(campaign / 'baseline.json', records)
            write_json(campaign / 'corpus' / 'request.json', {'schema_version': 1, 'baseline_commit': entry['harness_commit'], 'one_change': True})
        write_json(campaign / 'campaign.json', state)
        return decision


def environment():
    names = ('PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT')
    value = {key: os.environ[key] for key in names if key in os.environ}
    value.update(PYTHONDONTWRITEBYTECODE='1', PYTHONNOUSERSITE='1', PYTHONIOENCODING='utf8', PI_OFFLINE='1',
                 npm_config_offline='true', npm_config_audit='false', npm_config_fund='false', npm_config_update_notifier='false')
    return value


def _run(argv, *, cwd, env=None, timeout=120, log=None, secrets=()):
    """Bound output during execution; never echo arbitrary child failures."""
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()
    with subprocess.Popen(argv, cwd=cwd, env=env or environment(), stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False) as child:
        def collect(pipe, buffer):
            while chunk := pipe.read(4096):
                if len(buffer) + len(chunk) > 16 * 1024 * 1024:
                    overflow.set()
                    child.kill()
                    break
                buffer.extend(chunk)
        readers = [threading.Thread(target=collect, args=(pipe, buffer), daemon=True) for pipe, buffer in zip((child.stdout, child.stderr), buffers)]
        for reader in readers:
            reader.start()
        timed_out = False
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            child.kill()
            child.wait(timeout=5)
        for reader in readers:
            reader.join(timeout=5)
        if any(reader.is_alive() for reader in readers):
            raise ValueError('child output stream did not close')
    text = b'\n'.join(buffers).decode('utf8', errors='replace')
    for secret in secrets:
        if secret:
            text = text.replace(secret, '<redacted-api-key>')
    if log:
        Path(log).write_text(text, encoding='utf8')
    if timed_out or overflow.is_set() or child.returncode != 0:
        raise ValueError('child failed, exceeded output bound or timed out; retained evidence has details')
    return buffers[0].decode('utf8')


def _ledger(path, config):
    ledger = read_json(path)
    if not isinstance(ledger, dict) or ledger.get('budget_cap_usd') != config.get('budget_cap_usd') or not isinstance(ledger.get('reservations'), list):
        raise ValueError('spend ledger disagrees with current cap')
    def amount(value):
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError('invalid spend ledger amount')
        return Decimal(str(value))
    if any(not isinstance(item, dict) or item.get('status') not in ('reserved', 'reconciled') for item in ledger['reservations']):
        raise ValueError('invalid spend ledger reservation status')
    active = [item for item in ledger['reservations'] if item.get('status') == 'reserved']
    if len({item.get('run_id') for item in ledger['reservations']}) != len(ledger['reservations']):
        raise ValueError('duplicate spending reservation')
    if sum((amount(item.get('reserved_usd')) for item in active), Decimal(0)) != amount(ledger.get('reserved_usd')):
        raise ValueError('spend ledger reservation sum mismatch')
    reconciled = sum((amount(item.get('billed_cost_usd')) for item in ledger['reservations'] if item['status'] == 'reconciled'), Decimal(0))
    if reconciled != amount(ledger.get('confirmed_spend_usd')):
        raise ValueError('spend ledger billed total mismatch')
    return ledger


def execution_plan(campaign, *, config, evolution_config, ledger, estimate_usd, iterations=1):
    policy = read_json(config)
    # Fail before even inspecting campaign paths, secrets or invoking tools.
    if policy.get('execution_policy') != 'paid-enabled' or policy.get('paid_runs_enabled') is not True:
        return {'status': 'blocked', 'blockers': ['offline-only policy blocks proposer and benchmark execution'], 'executed': False}
    blockers = []
    limits = settings(evolution_config)
    if type(iterations) is not int or iterations < 1:
        raise ValueError('positive iteration count required')
    if type(estimate_usd) not in (int, float) or not math.isfinite(estimate_usd) or estimate_usd < 0.03:
        raise ValueError('whole iteration estimate must cover at least the $0.03 bounded proposer')
    spent = _ledger(ledger, policy)
    try:
        validate_budget(policy, estimate_usd * iterations, spent['confirmed_spend_usd'], spent['reserved_usd'])
    except ValueError as exc:
        blockers.append(str(exc))
    if policy.get('main_model') != MODEL or policy.get('fast_model') != MODEL or policy.get('thinking_level') != 'xhigh' or policy.get('allowed_models') != [MODEL]:
        blockers.append('physical model policy must remain Muse at xhigh')
    state, _ = state_of(campaign)
    if state['synthetic']:
        blockers.append('synthetic baselines cannot start real evolution')
    if not state['expected_outputs_reviewed']:
        blockers.append('trusted expected-output literal inventory must be reviewed')
    if len(state['iterations']) + iterations > min(limits['max_iterations'], state['limits']['max_iterations']):
        blockers.append('iteration limit would be exceeded')
    if state['iterations'] and state['iterations'][-1]['status'] in ('preparing', 'proposed', 'evaluating', 'evaluation_failed'):
        blockers.append('an iteration is outstanding or a failed evaluation requires review')
    if not isinstance(limits.get('image'), str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:-]*@sha256:[0-9a-f]{64}', limits['image']):
        blockers.append('existing digest-pinned verification/proposer image is required')
    if policy.get('container_environment') != 'docker':
        blockers.append('explicit local Docker container environment is required')
    if sys.version_info < (3, 12):
        blockers.append('pinned Harbor requires Python 3.12+')
    try:
        distribution = importlib.metadata.distribution('harbor')
        direct = json.loads(distribution.read_text('direct_url.json') or '{}')
        if distribution.version != '0.23.0' or direct.get('vcs_info', {}).get('commit_id') != HARBOR_COMMIT:
            blockers.append('installed Harbor source pin differs')
    except (importlib.metadata.PackageNotFoundError, ValueError):
        blockers.append('source-pinned Harbor is not installed')
    for command in ('docker', 'node', 'git'):
        if not shutil.which(command):
            blockers.append('required local executable unavailable: ' + command)
    return {'status': 'blocked' if blockers else 'ready', 'blockers': blockers, 'executed': False,
            'iterations': iterations, 'whole_iteration_estimate_usd': estimate_usd,
            'max_iterations': min(limits['max_iterations'], state['limits']['max_iterations'])}


def reserve(ledger_path, config, run_id, estimate_usd):
    ledger_path = regular(ledger_path)
    with locked(ledger_path.parent, 'spend'):
        ledger = _ledger(ledger_path, config)
        validate_budget(config, estimate_usd, ledger['confirmed_spend_usd'], ledger['reserved_usd'])
        if any(item['run_id'] == run_id for item in ledger['reservations']):
            raise ValueError('reservation identity already exists')
        ledger['reservations'].append({'run_id': run_id, 'model': MODEL, 'reserved_usd': estimate_usd, 'status': 'reserved',
                                       'purpose': 'Apex evolution proposer, dev and held-out evaluation; unknown billing retains reservation'})
        ledger['reserved_usd'] = float(Decimal(str(ledger['reserved_usd'])) + Decimal(str(estimate_usd)))
        write_json(ledger_path, ledger)
        return ledger


def reconcile(ledger_path, config_path, receipt_path):
    receipt = read_json(receipt_path)
    billed = receipt.get('billed_cost_usd') if isinstance(receipt, dict) else None
    if type(billed) not in (int, float) or not math.isfinite(billed) or billed < 0 or receipt.get('reviewed') is not True or not isinstance(receipt.get('receipts'), list) or not receipt['receipts']:
        raise ValueError('reviewed explicit provider/container billing receipts required')
    total, stages, identities = Decimal(0), set(), set()
    for item in receipt['receipts']:
        if not isinstance(item, dict) or item.get('stage') not in ('proposer', 'dev', 'heldout', 'container'):
            raise ValueError('invalid billing receipt stage')
        amount = item.get('amount_usd')
        if type(amount) not in (int, float) or not math.isfinite(amount) or amount < 0:
            raise ValueError('invalid billing receipt amount')
        evidence = regular(item.get('evidence_file', ''))
        if evidence.stat().st_size > MAX_JSON or hashlib.sha256(evidence.read_bytes()).hexdigest() != item.get('sha256'):
            raise ValueError('billing receipt evidence hash mismatch')
        if item['sha256'] in identities:
            raise ValueError('duplicate billing receipt evidence')
        identities.add(item['sha256'])
        total += Decimal(str(amount))
        stages.add(item['stage'])
    if stages != {'proposer', 'dev', 'heldout', 'container'} or total != Decimal(str(billed)):
        raise ValueError('billing receipts must cover all stages and match the actual total')
    config = read_json(config_path)
    ledger_path = regular(ledger_path)
    with locked(ledger_path.parent, 'spend'):
        ledger = _ledger(ledger_path, config)
        matches = [item for item in ledger['reservations'] if item['run_id'] == receipt.get('run_id')]
        if len(matches) != 1 or matches[0]['status'] != 'reserved':
            raise ValueError('active unique reservation required')
        item = matches[0]
        ledger['reserved_usd'] = float(Decimal(str(ledger['reserved_usd'])) - Decimal(str(item['reserved_usd'])))
        ledger['confirmed_spend_usd'] = float(Decimal(str(ledger['confirmed_spend_usd'])) + Decimal(str(billed)))
        ledger['remaining_usd'] = float(Decimal(str(config['budget_cap_usd'])) - Decimal(str(ledger['confirmed_spend_usd'])) - Decimal(str(ledger['reserved_usd'])))
        item.update(status='reconciled', billed_cost_usd=billed, receipt_file=str(Path(receipt_path).absolute()))
        write_json(ledger_path, ledger)
        return {'status': 'reconciled', 'remaining_usd': ledger['remaining_usd'], 'over_cap': ledger['remaining_usd'] < 0}


def _docker_prefix(configuration):
    endpoint = 'npipe:////./pipe/docker_engine' if os.name == 'nt' else 'unix:///var/run/docker.sock'
    return ['docker', '--config', str(configuration), '--host', endpoint]


def _mount(source, target, writable=False):
    source = Path(source).absolute()
    if ',' in str(source):
        raise ValueError('Docker mount paths cannot contain commas')
    return ['--mount', f'type=bind,src={source},dst={target}' + ('' if writable else ',readonly')]


def _container(prefix, image, mounts, argv, *, log, env=None, credential=False, offline=True, writable_root=False):
    name = 'apex-evolve-' + uuid4().hex
    command = [*prefix, 'run', '--rm', '--pull', 'never', '--name', name, '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '2g', '--cpus', '2',
               '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m', '--env', 'PI_OFFLINE=1', '--env', 'HOME=/tmp',
               '--workdir', '/opt/apex']
    if not writable_root:
        command += ['--read-only']
    if offline:
        command += ['--network', 'none']
    if credential:
        command += ['--env', 'OPENROUTER_API_KEY']
    command += mounts + [image, *argv]
    try:
        return _run(command, cwd=ROOT, env=env, timeout=330, log=log, secrets=(env.get('OPENROUTER_API_KEY', ''),) if env else ())
    finally:
        # A killed Docker CLI does not imply its workload stopped. Only our random owned name is removed.
        subprocess.run([*prefix, 'rm', '--force', name], env=environment(), stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)


def collect_job(job, *, run_id, split, commit, configuration_id, attempts, expected_tasks, trace_root, prices, secrets=()):
    """Read per-trial final results and native sessions, never verifier files."""
    job = regular(job, directory=True)
    records = []
    counts = {task: 0 for task in expected_tasks}
    for directory in sorted(job.iterdir()):
        if not directory.is_dir():
            continue
        regular(directory, directory=True)
        outcome = read_json(directory / 'result.json')
        task = outcome.get('task_name')
        if task not in counts:
            raise ValueError('unexpected task in Harbor trial outputs')
        counts[task] += 1
        sessions = sorted((directory / 'agent' / 'pi' / 'sessions').glob('*.jsonl'))
        if len(sessions) != 1:
            raise ValueError('exactly one native Pi session per trial required')
        raw = regular(sessions[0]).read_bytes()
        if any(secret and secret.encode('utf8') in raw for secret in secrets):
            raise ValueError('native evidence contains a credential; retained privately, never exported')
        ingested = ingest_trace(trace_root, run_id, task, counts[task], sessions[0], commit, split)
        normalized = normalize_attempt(ingested, directory / 'result.json', configuration_id, prices)
        records.append(normalized)
    if any(count != attempts for count in counts.values()):
        raise ValueError('incomplete or extra Harbor trial outcomes')
    return records


def run_iterations(campaign, *, config, evolution_config, ledger, estimate_usd, iterations=1, leaderboard=None):
    plan = execution_plan(campaign, config=config, evolution_config=evolution_config, ledger=ledger, estimate_usd=estimate_usd, iterations=iterations)
    if plan['status'] != 'ready':
        return plan
    campaign = regular(campaign, directory=True)
    with locked(campaign, 'executor'):
        policy = read_json(config)
        limits = settings(evolution_config)
        with tempfile.TemporaryDirectory(prefix='apex-docker-config-') as docker_config:
            prefix = _docker_prefix(docker_config)
            if _run([*prefix, 'info', '--format', '{{.OSType}}'], cwd=ROOT, timeout=10).strip() != 'linux':
                raise ValueError('explicit local Linux Docker engine required')
            _run([*prefix, 'image', 'inspect', limits['image']], cwd=ROOT, timeout=10)
            completed = []
            for _ in range(iterations):
                state, selection = state_of(campaign)
                # Re-read current permission and ledger at every paid iteration.
                policy = read_json(config)
                number = len(state['iterations']) + 1
                run_id = f"{state['campaign_id']}-iteration-{number:03d}"
                reserved = reserve(ledger, policy, run_id, estimate_usd)
                with tempfile.TemporaryDirectory(prefix='.proposer-', dir=campaign) as temporary:
                    work = Path(temporary)
                    authorization = {'config': policy, 'ledger': reserved, 'runId': run_id, 'maxSpendUsd': 0.03}
                    write_json(work / 'authorization.json', authorization)
                    output = work / 'output'
                    output.mkdir(mode=0o700)
                    env = environment()
                    # The sole credential lookup occurs only after reservation and policy gates.
                    key = os.environ.get('OPENROUTER_API_KEY')
                    if not key:
                        raise ValueError('authorized provider credential unavailable')
                    env['OPENROUTER_API_KEY'] = key
                    mounts = _mount(campaign / 'corpus', '/corpus') + _mount(output, '/output', True)
                    mounts += _mount(work / 'authorization.json', '/authorization.json') + _mount(ROOT / 'evolve' / 'proposer.mjs', '/opt/apex/evolve/proposer.mjs')
                    try:
                        _container(prefix, limits['image'], mounts, ['node', 'evolve/proposer.mjs', '/authorization.json', '/corpus', '/output'],
                                   log=campaign / (run_id + '-proposer.log'), env=env, credential=True, offline=False)
                        entry = import_proposal(campaign, output / 'proposal.json')
                        directory = campaign / 'iterations' / f"{entry['number']:03d}"
                    finally:
                        if (output / 'proposer.jsonl').exists():
                            shutil.copyfile(regular(output / 'proposer.jsonl'), campaign / (run_id + '-proposer.jsonl'))
                        env.pop('OPENROUTER_API_KEY', None)
                candidate = directory / 'candidate'
                evidence = directory / 'micro'
                evidence.mkdir(mode=0o700)
                mounts = _mount(evidence, '/opt/apex/validation', True)
                for name in RUNTIME:
                    if name not in ('package.json', 'package-lock.json'):
                        (candidate / name).mkdir(exist_ok=True)
                    if (candidate / name).exists():
                        mounts += _mount(candidate / name, '/opt/apex/' + name)
                # Trusted image owns immutable tests/evaluator. Candidate code never executes on the host.
                try:
                    for script in ('check', 'test', 'micro'):
                        _container(prefix, limits['image'], mounts, ['node', f'scripts/{script}.mjs'], log=directory / f'{script}.log', writable_root=True)
                    package_dir = directory / 'package'
                    package_dir.mkdir(mode=0o700)
                    _container(prefix, limits['image'], mounts + _mount(package_dir, '/package', True),
                               ['npm', 'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', '/package'], log=directory / 'pack.log')
                    packages = list(package_dir.glob('*.tgz'))
                    if len(packages) != 1:
                        raise ValueError('exactly one candidate package required')
                    measurements = []
                    for split in ('dev', 'heldout'):
                        policy = read_json(config)
                        if policy.get('execution_policy') != 'paid-enabled' or policy.get('paid_runs_enabled') is not True or policy.get('main_model') != MODEL or policy.get('fast_model') != MODEL or policy.get('allowed_models') != [MODEL] or policy.get('thinking_level') != 'xhigh':
                            raise ValueError('execution permission or selected physical model changed')
                        current = _ledger(ledger, policy)
                        planned = prepare_plan(policy, run_id + '-' + split, estimate_usd, entry['harness_commit'], agent='apex',
                                               dataset=state['dataset'], attempts=state['protocol']['attempts'], apex_package=str(packages[0].absolute()),
                                               spent_usd=current['confirmed_spend_usd'], reserved_usd=float(Decimal(str(current['reserved_usd'])) - Decimal(str(estimate_usd))),
                                               dataset_manifest=state['dataset_manifest'], split=split, context_flags=state['protocol']['context_flags'],
                                               core_flags=state['protocol']['core_flags'], feature_flags=state['protocol']['feature_flags'])
                        write_json(directory / (split + '-plan.json'), planned)
                        if planned['status'] != 'ready_for_review':
                            raise ValueError('current Harbor plan is blocked')
                        argv = planned['harbor_argv'][1:]
                        jobs = directory / 'jobs'
                        jobs.mkdir(exist_ok=True, mode=0o700)
                        index = argv.index('--jobs-dir') + 1
                        argv[index] = str(jobs)
                        env['DOCKER_HOST'] = prefix[-1]
                        env['DOCKER_CONFIG'] = docker_config
                        env['OPENROUTER_API_KEY'] = key
                        # Invoke the checked distribution through this interpreter, never an arbitrary PATH harbor.
                        _run([sys.executable, '-c', 'from harbor.cli.main import app; app()', *argv], cwd=ROOT, env=env,
                             timeout=86400, log=directory / (split + '-harbor.log'), secrets=(key,))
                        measurements += collect_job(jobs / (run_id + '-' + split), run_id=run_id + '-' + split, split=split,
                                                    commit=entry['harness_commit'], configuration_id=run_id, attempts=state['protocol']['attempts'],
                                                    expected_tasks=selection[split]['task_names'], trace_root=state['trace_root'], prices=ROOT / 'evals/pricing.json', secrets=(key,))
                    write_json(directory / 'measurements.json', measurements)
                    completed.append(decide(campaign, directory / 'measurements.json', leaderboard=leaderboard))
                except (ValueError, OSError, subprocess.SubprocessError):
                    with locked(campaign):
                        failed, _ = state_of(campaign)
                        failed['iterations'][-1]['status'] = 'evaluation_failed'
                        write_json(campaign / 'campaign.json', failed)
                    raise
                finally:
                    env.pop('OPENROUTER_API_KEY', None)
                    key = None
            return {'status': 'completed', 'iterations': completed, 'spend': 'reservations retained until explicit billing reconciliation', 'checkout_promoted': False}
