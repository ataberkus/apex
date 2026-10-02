import unittest
from evals.analysis.failures import suggest_failure


class FailureTests(unittest.TestCase):
    def test_unknown_failure_is_not_given_false_certainty(self):
        result = suggest_failure([{'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Finished.'}]}}])
        self.assertEqual(result['label'], 'other')
        self.assertEqual(result['status'], 'provisional')

    def test_observed_tool_timeout_has_bounded_evidence(self):
        events = [{'type': 'message', 'message': {'role': 'toolResult', 'isError': True, 'content': [{'type': 'text', 'text': 'Command timed out after 60 seconds' + 'x' * 1000}]}}]
        result = suggest_failure(events)
        self.assertEqual(result['label'], 'timeout')
        self.assertLessEqual(len(result['evidence']), 300)
