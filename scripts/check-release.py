"""Reject version regressions before publishing an image. No network or mutations."""
import json
import re
import sys


def version(value):
    match = re.fullmatch(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value)
    if not match:
        raise ValueError("expected a stable three-part version")
    parts = tuple(map(int, match.groups()))
    if max(parts) > 4294967295:
        raise ValueError("version component exceeds update protocol limit")
    return parts


def validate(tag, releases, image_version=None):
    candidate = version(tag)
    for release in releases:
        if release.get("draft") or release.get("prerelease"):
            continue
        try:
            published = version(release["tag_name"])
        except ValueError:
            continue
        if published >= candidate:
            raise ValueError("tag must be newer than every published stable release")
    if image_version is not None and version(image_version) > candidate:
        raise ValueError("tag would downgrade the latest image")


if __name__ == "__main__":
    try:
        with open(sys.argv[2], encoding="utf-8") as source:
            releases = json.load(source)
        validate(sys.argv[1], releases, sys.argv[3] if len(sys.argv) > 3 else None)
    except (ValueError, KeyError, TypeError) as error:
        sys.exit(str(error))
