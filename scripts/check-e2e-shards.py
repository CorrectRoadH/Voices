"""Reject missing or duplicated E2E scenarios in the CI matrix."""

import collections
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
command = json.loads((root / "package.json").read_text())["scripts"]["test:e2e"]
default_filter = re.search(r"-run '([^']+)'", command).group(1)
filters = re.findall(
    r"e2e_filter: '([^']+)'", (root / ".github/workflows/ci.yml").read_text()
)


def names(pattern):
    if not re.fullmatch(r"\^\(Test\w+(\|Test\w+)*\)\$", pattern):
        raise SystemExit(f"Unsupported E2E filter: {pattern}")
    return pattern[2:-2].split("|")


expected = collections.Counter(names(default_filter))
actual = collections.Counter(name for pattern in filters for name in names(pattern))
if actual != expected:
    raise SystemExit(f"E2E shard mismatch: missing={expected - actual}, extra={actual - expected}")
print(f"E2E shards cover all {sum(expected.values())} scenarios exactly once")
