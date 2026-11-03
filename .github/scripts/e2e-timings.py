"""Export only numeric E2E timing metrics; never copy prompts or model metadata."""

import json
import math
from pathlib import Path
import sys

# Fixed output labels: arbitrary report titles, paths and provider names stay private.
REPORTS = (
    "workbench", "accounts", "insights", "administration", "account-filters",
    "settings", "updates", "onboarding/main", "onboarding/revision", "onboarding/skip",
    "interaction", "recovery", "calls", "references", "navigation", "search", "loading",
    "language", "models", "oidc",
)


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else 0


def summarize(root):
    rows = []
    for report in REPORTS:
        path = root / report / "report.json"
        if (not path.is_file() or path.is_symlink()
                or any(parent.is_symlink() for parent in path.parents if parent != root.parent)
                or not path.resolve().is_relative_to(root.resolve())):
            continue
        run = json.loads(path.read_text())["run"]
        for result in run.get("results", []):
            for attempt in result.get("attempts", []):
                steps = attempt.get("steps", [])
                agents = [step for step in steps if step.get("api") == "agent.act"]
                model_events = [event for step in agents for event in step.get("events", [])
                                if event.get("kind") == "model"]
                status = attempt.get("status")
                rows.append({
                    "scenario": report,
                    "status": status if status in ("passed", "failed", "timedOut", "skipped") else "unknown",
                    "attempt": number(attempt.get("index")),
                    "duration_ms": number(attempt.get("durationMs")),
                    "agent_actions": len(agents),
                    "agent_ms": sum(number(step.get("durationMs")) for step in agents),
                    "model_calls": sum(number(step.get("metrics", {}).get("modelCalls")) for step in agents),
                    "model_ms": sum(number(event.get("durationMs")) for event in model_events),
                    "input_tokens": sum(number(step.get("model", {}).get("inputTokens")) for step in agents),
                    "cached_input_tokens": sum(number(step.get("model", {}).get("cacheReadTokens")) for step in agents),
                    "output_tokens": sum(number(step.get("model", {}).get("outputTokens")) for step in agents),
                })
    return {"schema": 1, "attempts": rows}


if __name__ == "__main__":
    print(json.dumps(summarize(Path(sys.argv[1])), indent=2, allow_nan=False))
