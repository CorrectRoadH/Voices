"""Summarize downloaded gh run/job JSON without exposing job logs or secrets.

Usage: python3 scripts/ci-timings.py RUNS_JSON JOBS_DIRECTORY OUTPUT_CSV
Each JOBS_DIRECTORY/<run id>.json is the paginated Actions jobs API response.
Queue is job creation to runner start, not time spent waiting for needs.
Setup includes runner/container/tool/dependency setup, cleanup and step gaps.
Execution is the sum of test, validation, build and publish steps below.
Skipped/unstarted jobs have empty timings; failures/cancellations stay labelled.
"""

import collections
import csv
from datetime import datetime
import json
from pathlib import Path
import re
import statistics
import sys


WORK = re.compile(
    r"e2e 真实应用浏览器验收|Real application browser acceptance|"
    r"(?:Run )?(?:vp run (?:check|test)|vp -C \S+ run (?:check|test|build|deploy)|"
    r"pnpm .*?(?:test|build|check)|sh scripts/test\.sh)|"
    r"Check workflow syntax|Verify generated API types|"
    r"docker/build-push-action|Run test .*docker run|"
    r"Build and package|Prevent latest version regression|"
    r"Require a stable version tag|Resolve release tag|"
    r"Verify and checksum release assets|Generate release notes|Publish release"
)


def seconds(start, end):
    return max(0, (datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds())


def rows(runs, directory):
    for run in runs:
        for job in json.loads((directory / f'{run["databaseId"]}.json').read_text())["jobs"]:
            row = dict(run_id=run["databaseId"], workflow=run["workflowName"],
                       event=run["event"], branch=run["headBranch"],
                       job_id=job["id"], job=job["name"], conclusion=job["conclusion"],
                       queue_s="", setup_s="", execution_s="", elapsed_s="",
                       url=job["html_url"])
            if job["conclusion"] != "skipped" and job["started_at"] and job["completed_at"]:
                elapsed = seconds(job["started_at"], job["completed_at"])
                execution = sum(
                    seconds(step["started_at"], step["completed_at"])
                    for step in job["steps"]
                    if step["started_at"] and step["completed_at"]
                    and step["conclusion"] != "skipped"
                    and not step["name"].startswith("Post ") and WORK.search(step["name"])
                )
                row.update(queue_s=seconds(job["created_at"], job["started_at"]),
                           setup_s=max(0, elapsed - execution), execution_s=execution,
                           elapsed_s=elapsed)
            yield row


if __name__ == "__main__":
    runs_file, jobs_dir, output = map(Path, sys.argv[1:])
    data = list(rows(json.loads(runs_file.read_text()), jobs_dir))
    with output.open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(data[0]))
        writer.writeheader()
        writer.writerows(data)
    groups = collections.defaultdict(list)
    for row in data:
        if row["elapsed_s"] != "":
            groups[(row["workflow"], row["job"], row["conclusion"])].append(row)
    print(f"{len(data)} jobs written to {output}; medians below (seconds)")
    for key, values in sorted(groups.items()):
        print(*key, f"n={len(values)}", *(
            f"{field}={statistics.median(v[field] for v in values):.1f}"
            for field in ("queue_s", "setup_s", "execution_s")
        ), sep=" | ")
