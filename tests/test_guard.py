import unittest
from evals.guard import validate_budget


class BudgetTests(unittest.TestCase):
    def test_zero_cap_rejects_paid_estimate(self):
        with self.assertRaisesRegex(ValueError, 'budget'):
            validate_budget({'budget_cap_usd': 0, 'paid_runs_enabled': False}, 0.01)

    def test_cap_accounts_for_spent_and_reserved_runs(self):
        config = {'budget_cap_usd': 20, 'paid_runs_enabled': True}
        self.assertEqual(validate_budget(config, 2, spent_usd=10, reserved_usd=8), 0)
        with self.assertRaisesRegex(ValueError, 'budget'):
            validate_budget(config, 2.01, spent_usd=10, reserved_usd=8)

    def test_missing_invalid_and_negative_values_fail_closed(self):
        for value in [None, -1, float('nan'), float('inf'), True, '20']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_budget({'budget_cap_usd': value, 'paid_runs_enabled': True}, 1)
        for value in [0, -1, float('nan'), float('inf'), True, None]:
            with self.subTest(estimate=value), self.assertRaises(ValueError):
                validate_budget({'budget_cap_usd': 20, 'paid_runs_enabled': True}, value)

    def test_positive_cap_does_not_enable_runs_implicitly(self):
        with self.assertRaisesRegex(ValueError, 'enabled'):
            validate_budget({'budget_cap_usd': 20, 'paid_runs_enabled': False}, 1)

    def test_offline_policy_overrides_enabled_flag_and_unused_budget(self):
        with self.assertRaisesRegex(ValueError, 'offline'):
            validate_budget({'budget_cap_usd': 1, 'paid_runs_enabled': True,
                             'execution_policy': 'offline-only'}, 0.01)
