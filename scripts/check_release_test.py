import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("check-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseGate(unittest.TestCase):
    def test_numeric_order_and_first_release(self):
        release.validate("v1.10.0", [{"tag_name": "v1.9.0"}], "1.9.0")
        release.validate("v0.1.0", [])

    def test_refuse_old_or_already_published_release(self):
        for tag in ["v1.0.0", "v2.0.0"]:
            with self.assertRaises(ValueError):
                release.validate(tag, [{"tag_name": "v2.0.0"}])

    def test_partial_publish_is_retryable_but_cannot_downgrade(self):
        release.validate("v2.0.0", [{"tag_name": "v1.0.0"}], "2.0.0")
        with self.assertRaises(ValueError):
            release.validate("v1.1.0", [{"tag_name": "v1.0.0"}], "2.0.0")

    def test_unknown_image_version_and_unsupported_tags_fail_closed(self):
        for tag in ["v1.0.0-beta", "v01.0.0", "v4294967296.0.0"]:
            with self.assertRaises(ValueError):
                release.validate(tag, [])
        with self.assertRaises(ValueError):
            release.validate("v1.0.0", [], "<no value>")


if __name__ == "__main__":
    unittest.main()
