import json
import subprocess
import sys
import tempfile
import unittest

from pathlib import Path


SCRIPT = Path(__file__).with_name("claude_action_diagnostic.py")


def diagnose(messages):
    with tempfile.TemporaryDirectory() as directory:
        execution_file = Path(directory) / "execution.json"
        execution_file.write_text(json.dumps(messages))
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(execution_file)],
            capture_output=True,
            text=True,
        )


class ClaudeActionDiagnosticTests(unittest.TestCase):
    def test_classifies_first_call_rate_limit_without_echoing_result_text(self):
        result = diagnose(
            [
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": True,
                    "api_error_status": 429,
                    "duration_ms": 387,
                    "num_turns": 1,
                    "total_cost_usd": 0,
                    "result": "private provider response",
                }
            ]
        )

        self.assertEqual(result.returncode, 0)
        self.assertIn("HTTP 429", result.stdout)
        self.assertIn("usage/rate limit", result.stdout)
        self.assertNotIn("private provider response", result.stdout)

    def test_unclassified_first_call_failure_points_to_account_configuration(self):
        result = diagnose(
            [
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": True,
                    "duration_ms": 387,
                    "num_turns": 1,
                    "total_cost_usd": 0,
                }
            ]
        )

        self.assertEqual(result.returncode, 0)
        self.assertIn("first Claude API request was rejected", result.stdout)
        self.assertIn("credential, credit, or model access", result.stdout)

    def test_missing_result_is_a_non_failing_diagnostic(self):
        result = diagnose([])

        self.assertEqual(result.returncode, 0)
        self.assertIn("no result message", result.stdout)


if __name__ == "__main__":
    unittest.main()
