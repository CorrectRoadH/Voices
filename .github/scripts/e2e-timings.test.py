import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("timings", Path(__file__).with_name("e2e-timings.py"))
timings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(timings)


class TimingPrivacyTest(unittest.TestCase):
    def test_exports_metrics_without_report_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "workbench").mkdir()
            secret = "private-provider-and-prompt"
            report = {"run": {"provider": secret, "results": [{"title": secret, "attempts": [{
                "status": "passed", "index": 0, "durationMs": 2000,
                "steps": [{"api": "agent.act", "label": secret, "durationMs": 1900,
                           "metrics": {"modelCalls": 2},
                           "model": {"provider": secret, "inputTokens": 100, "cacheReadTokens": 80, "outputTokens": 10},
                           "events": [{"kind": "model", "durationMs": 1800, "name": secret}]}],
            }]}]}}
            (root / "workbench/report.json").write_text(json.dumps(report))
            result = timings.summarize(root)
            self.assertNotIn(secret, json.dumps(result))
            row = result["attempts"][0]
            self.assertEqual((row["model_calls"], row["model_ms"], row["agent_ms"]), (2, 1800, 1900))
            self.assertEqual(row["cached_input_tokens"], 80)
            self.assertEqual(timings.number(secret), 0)
            self.assertEqual(timings.number(float("nan")), 0)
            self.assertEqual(timings.number(True), 0)
            (root / "settings").symlink_to(root / "workbench", target_is_directory=True)
            self.assertEqual(len(timings.summarize(root)["attempts"]), 1)


if __name__ == "__main__":
    unittest.main()
