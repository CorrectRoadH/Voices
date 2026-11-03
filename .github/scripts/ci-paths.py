"""Keep PR checks present while skipping jobs for documentation-only changes."""

import subprocess
import sys


def requires_ci(path):
    if path.startswith("docs/api/") or path == "docs/release-package.txt":
        return True
    return not (
        path.startswith(("docs/", "memory/", "README"))
        or path.endswith(".md")
    )


def changed_paths(base, head):
    # Disabling rename detection includes both names of code moved into docs.
    result = subprocess.run(
        ["git", "diff", "--no-renames", "--name-only", "-z", f"{base}...{head}"],
        check=True, capture_output=True,
    )
    return [path.decode() for path in result.stdout.split(b"\0") if path]


if __name__ == "__main__":
    paths = changed_paths(*sys.argv[1:])
    # An empty/unexpected diff is conservative; never skip an unknown change.
    required = not paths or any(map(requires_ci, paths))
    print(f"required={str(required).lower()}")
