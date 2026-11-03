"""Exercise path filtering against real Git diffs, including renames."""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("paths", Path(__file__).with_name("ci-paths.py"))
paths = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paths)


class PathsTest(unittest.TestCase):
    def test_build_inputs_are_not_documentation(self):
        for name in ("docs/api/openapi.json", "docs/release-package.txt", ".github/workflows/ci.yml", "web/src/main.tsx", "go.mod"):
            self.assertTrue(paths.requires_ci(name), name)
        for name in ("README.md", "docs/engineering/delivery/README.md", "web/DESIGN.md", "memory/note.md", "AGENTS.md"):
            self.assertFalse(paths.requires_ci(name), name)

    def test_deleted_or_renamed_code_still_runs_ci(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = os.getcwd()
            os.chdir(directory)
            try:
                def git(*args):
                    return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL).decode().strip()
                git("init")
                git("config", "user.email", "ci@example.invalid")
                git("config", "user.name", "CI test")
                Path("code.py").write_text("print('test')\n")
                git("add", ".")
                git("commit", "-m", "base")
                base = git("rev-parse", "HEAD")
                Path("docs").mkdir()
                git("mv", "code.py", "docs/example.md")
                git("commit", "-m", "move")
                changed = paths.changed_paths(base, "HEAD")
                self.assertEqual(set(changed), {"code.py", "docs/example.md"})
                self.assertTrue(any(map(paths.requires_ci, changed)))
                Path("docs/example.md").write_text("docs only\n")
                git("commit", "-am", "docs")
                self.assertFalse(any(map(paths.requires_ci, paths.changed_paths("HEAD^", "HEAD"))))
                with self.assertRaises(subprocess.CalledProcessError):
                    paths.changed_paths("missing-ref", "HEAD")
            finally:
                os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
