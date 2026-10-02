"""Unpaid micro gate: real Pi tool contracts plus accounting/integrity tests."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    node = shutil.which('node')
    if not node:
        raise SystemExit('node is required')
    env = dict(os.environ)
    env['PATH'] = str(Path('.tools/bin').resolve()) + os.pathsep + env.get('PATH', '')
    env['PI_CODING_AGENT_DIR'] = str(Path('.cache/pi-micro').resolve())
    env['PI_OFFLINE'] = '1'
    result = subprocess.run([node, 'scripts/micro-tools.mjs'], capture_output=True, text=True, check=True, env=env)
    tools = json.loads(result.stdout)
    process_result = subprocess.run([node, 'scripts/micro-process.mjs'], capture_output=True,
                                    text=True, timeout=15, env=env)
    processes = json.loads(process_result.stdout)
    Path('validation/process-micro.json').write_text(json.dumps(processes, indent=2) + '\n', encoding='utf8')
    if process_result.returncode != 0 or processes.get('status') not in ('PASS', 'SKIP'):
        raise SystemExit('offline native process contract failed; see validation/process-micro.json')
    session_result = subprocess.run([node, 'scripts/micro-session.mjs'], capture_output=True,
                                    text=True, timeout=25, env=env)
    sessions = json.loads(session_result.stdout)
    Path('validation/session-micro.json').write_text(json.dumps(sessions, indent=2) + '\n', encoding='utf8')
    if session_result.returncode != 0 or sessions.get('status') not in ('PASS', 'SKIP'):
        raise SystemExit('offline native session contract failed; see validation/session-micro.json')
    pipeline_result = subprocess.run([sys.executable, '-m', 'evals.micro.pipeline'], capture_output=True,
                                     text=True, timeout=30, env=env)
    pipeline = json.loads(pipeline_result.stdout)
    Path('validation/pipeline-micro.json').write_text(json.dumps(pipeline, indent=2) + '\n', encoding='utf8')
    if pipeline_result.returncode != 0 or pipeline.get('status') != 'PASS':
        raise SystemExit('offline evaluation pipeline failed; see validation/pipeline-micro.json')
    phase1_result = subprocess.run([node, 'scripts/micro-phase1.mjs'], capture_output=True,
                                  text=True, timeout=25, env=env)
    phase1 = json.loads(phase1_result.stdout)
    Path('validation/phase1-micro.json').write_text(json.dumps(phase1, indent=2) + '\n', encoding='utf8')
    if phase1_result.returncode != 0 or phase1.get('status') != 'PASS':
        raise SystemExit('offline Phase 1 contract failed; see validation/phase1-micro.json')
    # Offline fixture watchdog only: reserve all three primary child deadlines
    # and up to eight bounded owned-cleanup children. Evaluator timeouts do not change.
    phase2_result=subprocess.run([node,'scripts/micro-phase2.mjs'],capture_output=True,text=True,timeout=330,env=env)
    phase2=json.loads(phase2_result.stdout)
    Path('validation/phase2-micro.json').write_text(json.dumps(phase2,indent=2)+'\n',encoding='utf8')
    unexercised = [processes.get('reason', 'Native owned-process proof requires Linux')] if processes.get('status') == 'SKIP' else []
    unix_background_unavailable = (
        os.name == 'nt' and phase2.get('failure') == 'native_background_requires_unix'
        and phase2.get('background', {}).get('status') == 'SKIP'
        and phase2_result.returncode == 1 and phase2.get('status') == 'FAIL'
        and all(phase2.get('checks', {}).get(key) is True for key in (
            'native_tools_executed', 'native_gate_two_continuations',
            'native_verification_after_mutation', 'environment_sanitized', 'no_extension_errors'))
        and phase2.get('checks', {}).get('native_bg_survives_agent_exit') is False
        and phase2.get('checks', {}).get('native_bg_owned_cleanup') is False
        and phase2.get('cleanup', {}).get('fixture_removed') is True
        and phase2.get('cleanup', {}).get('owned_processes_removed') is True
        and all(value is True for key, value in phase2.get('checks', {}).items()
                if key not in {'native_bg_survives_agent_exit', 'native_bg_owned_cleanup'})
        and phase2.get('resource_discovery_attempts') == 0
        and phase2.get('attempted_calls') == {'network': 0, 'auth': 0, 'inference': 0, 'credentials': 0})
    if unix_background_unavailable:
        unexercised.append(phase2['background']['reason'])
    elif phase2_result.returncode != 0 or phase2.get('status') != 'PASS':
        raise SystemExit('offline Phase 2 contract failed; see validation/phase2-micro.json')
    phase3_result=subprocess.run([node,'scripts/micro-phase3.mjs'],capture_output=True,text=True,timeout=330,env=env)
    phase3=json.loads(phase3_result.stdout)
    Path('validation/phase3-micro.json').write_text(json.dumps(phase3,indent=2)+'\n',encoding='utf8')
    if phase3_result.returncode!=0 or phase3.get('status')!='PASS':raise SystemExit('offline Phase 3 contract failed; see validation/phase3-micro.json')
    evolution_result = subprocess.run([sys.executable, '-B', '-m', 'evolve.micro'], capture_output=True,
                                      text=True, timeout=180, env=env)
    evolution = json.loads(evolution_result.stdout)
    Path('validation/phase4-micro.json').write_text(json.dumps(evolution, indent=2) + '\n', encoding='utf8')
    if evolution_result.returncode != 0 or evolution.get('status') != 'PASS':
        raise SystemExit('offline evolution contract failed; see validation/phase4-micro.json')
    cases = ['test_metrics.py', 'test_guard.py', 'test_trace_store.py', 'test_plan.py', 'test_normalize.py', 'test_failures.py', 'test_datasets.py']
    for case in cases:
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', case], check=True)
    report = {'schema_version': 1, 'kind': 'offline_micro_only', 'provider_calls': 0,
              'status': 'BLOCKED' if unexercised else 'PASS', 'unexercised': unexercised,
              'benchmark_runs': 0, 'tool_contracts': tools, 'process_contract': processes,
              'session_contract': sessions, 'pipeline_contract': pipeline, 'phase1_contract': phase1,'phase2_contract':phase2,'phase3_contract':phase3,'phase4_contract':evolution,
              'model_dependent': {key: 'pending: no benchmark-grade per-model measurements in this offline pipeline' for key in (
                  'tool_call_correctness_per_model', 'todo_compliance', 'verify_before_finish',
                  'compaction_survival', 'background_service_survival_after_agent_exit', 'skill_routing_accuracy')}}
    Path('validation/offline-micro.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
    print(json.dumps(report, indent=2))
    if unexercised:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
