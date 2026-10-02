"""Consumer-visible offline denial, lifecycle and spending invariants."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from evolve.loop import (MODEL, execution_plan, read_json, reconcile, reserve, run_iterations, write_json)
from evolve.micro import run_evolution_micro


class EvolutionLoopTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = self.root / 'config.json'
        self.ledger = self.root / 'spend.json'
        self.policy = {'execution_policy': 'paid-enabled', 'paid_runs_enabled': True, 'budget_cap_usd': 1,
                       'main_model': MODEL, 'fast_model': MODEL, 'allowed_models': [MODEL], 'thinking_level': 'xhigh'}
        write_json(self.config, self.policy)
        write_json(self.ledger, {'schema_version': 1, 'budget_cap_usd': 1, 'confirmed_spend_usd': 0,
                                'reserved_usd': 0, 'reservations': []})

    def test_real_cli_git_raw_feedback_and_decision_lifecycle(self):
        evidence = run_evolution_micro()
        self.assertEqual(evidence['status'], 'PASS', evidence.get('failure'))
        self.assertTrue(evidence['checks']['synthetic_never_promoted'])
        self.assertTrue(evidence['checks']['offline_denial_before_allocation'])

    def test_offline_denies_before_missing_campaign_ledger_or_settings_access(self):
        write_json(self.config, {'execution_policy': 'offline-only', 'paid_runs_enabled': False})
        absent = self.root / 'absent'
        result = run_iterations(absent, config=self.config, evolution_config=absent,
                                ledger=absent, estimate_usd=0.1)
        self.assertEqual(result['status'], 'blocked')
        self.assertFalse(absent.exists())
        self.assertEqual(execution_plan(absent, config=self.config, evolution_config=absent,
                                       ledger=absent, estimate_usd=0.1), result)

    def test_reservations_count_unknown_bills_and_reject_duplicate_or_over_budget_work(self):
        reserve(self.ledger, self.policy, 'iteration-one', 0.6)
        stored = self.ledger.read_bytes()
        with self.assertRaisesRegex(ValueError, 'exceeds'):
            reserve(self.ledger, self.policy, 'iteration-two', 0.5)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            reserve(self.ledger, self.policy, 'iteration-one', 0.1)
        self.assertEqual(self.ledger.read_bytes(), stored)
        self.assertEqual(read_json(self.ledger)['reserved_usd'], 0.6)

    def test_corrupt_reservation_sum_or_billed_total_cannot_authorize_work(self):
        value = read_json(self.ledger)
        value['reserved_usd'] = 0.1
        write_json(self.ledger, value)
        with self.assertRaisesRegex(ValueError, 'reservation sum'):
            reserve(self.ledger, self.policy, 'iteration-one', 0.1)
        value['reserved_usd'] = 0
        value['confirmed_spend_usd'] = 0.1
        write_json(self.ledger, value)
        with self.assertRaisesRegex(ValueError, 'billed total'):
            reserve(self.ledger, self.policy, 'iteration-one', 0.1)

    def receipts(self, amounts):
        entries = []
        for stage, amount in zip(('proposer', 'dev', 'heldout', 'container'), amounts):
            evidence = self.root / (stage + '-receipt.json')
            write_json(evidence, {'synthetic': True, 'stage': stage, 'amount_usd': amount})
            entries.append({'stage': stage, 'amount_usd': amount, 'evidence_file': str(evidence),
                            'sha256': hashlib.sha256(evidence.read_bytes()).hexdigest()})
        path = self.root / 'receipt.json'
        write_json(path, {'run_id': 'iteration-one', 'reviewed': True, 'billed_cost_usd': sum(amounts), 'receipts': entries})
        return path

    def test_reconciliation_uses_all_actual_bills_and_reports_cap_breach_honestly(self):
        reserve(self.ledger, self.policy, 'iteration-one', 0.8)
        receipt = self.receipts([0.1, 0.5, 0.3, 0.2])
        # Decimal authority: encode the declared sum rather than binary float addition artifacts.
        payload = read_json(receipt)
        payload['billed_cost_usd'] = 1.1
        write_json(receipt, payload)
        result = reconcile(self.ledger, self.config, receipt)
        self.assertTrue(result['over_cap'])
        self.assertEqual(result['remaining_usd'], -0.1)
        value = read_json(self.ledger)
        self.assertEqual(value['confirmed_spend_usd'], 1.1)
        self.assertEqual(value['reserved_usd'], 0)
        with self.assertRaisesRegex(ValueError, 'active unique'):
            reconcile(self.ledger, self.config, receipt)
        with self.assertRaisesRegex(ValueError, 'exceeds'):
            reserve(self.ledger, self.policy, 'iteration-two', 0.01)

    def test_partial_tampered_and_duplicate_receipts_retain_reservation(self):
        reserve(self.ledger, self.policy, 'iteration-one', 0.8)
        receipt = self.receipts([0.1, 0.1, 0.1, 0.1])
        original = read_json(receipt)
        ledger_before = self.ledger.read_bytes()
        for invalid in (dict(original, receipts=original['receipts'][:-1]),
                        dict(original, receipts=[*original['receipts'], original['receipts'][0]]),
                        dict(original, billed_cost_usd=0.3), dict(original, reviewed=False)):
            write_json(receipt, invalid)
            with self.assertRaises((ValueError, OSError)):
                reconcile(self.ledger, self.config, receipt)
            self.assertEqual(self.ledger.read_bytes(), ledger_before)
        write_json(receipt, original)
        Path(original['receipts'][0]['evidence_file']).write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            reconcile(self.ledger, self.config, receipt)
        self.assertEqual(self.ledger.read_bytes(), ledger_before)

    def test_lock_never_steals_an_inflight_spending_owner(self):
        (self.root / '.spend.lock').write_text('existing owner')
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(ValueError, 'locked'):
            reserve(self.ledger, self.policy, 'iteration-one', 0.1)
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual((self.root / '.spend.lock').read_text(), 'existing owner')

    def test_offline_reservation_does_not_write_ledger(self):
        self.policy.update(execution_policy='offline-only', paid_runs_enabled=False)
        before = self.ledger.read_bytes()
        with self.assertRaisesRegex(ValueError, 'offline-only'):
            reserve(self.ledger, self.policy, 'iteration-one', 0.1)
        self.assertEqual(self.ledger.read_bytes(), before)
