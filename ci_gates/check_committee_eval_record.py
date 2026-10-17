#!/usr/bin/env python3
"""Audit F17 (spec docs/superpowers/specs/2026-10-17-f17-grounded-committee-output-design.md, ruling 5): no change of
the committee-brain model, task routing, system-policy version, grounding rules or evaluation set without a matching
evaluation record.

Reads, from the repository (or --root):
- functions/src/p1/costTable.ts  `TASK_MODEL` (each task's model: `functions:<task>`)
- platform/p1/constants.ts       `COMMITTEE_BRAIN_GATEWAY_MODEL` (the Next legacy path: `next:committee-brain`)
- platform/p1/systemPolicy.ts    `SYSTEM_POLICY_VERSION`
- functions/src/p1/grounding.ts  `GROUNDING_RULES_VERSION`
- docs/evals/committee-brain-eval-set.json (its version, item count and SHA-256)

and fails unless docs/evals/committee-brain-eval-record.json names exactly those, with a passing deterministic grading
and result, a date, and `live` as a boolean: a live run that did not happen is `live: false` with a note starting
"NOT RUN"; one that did is `live: true` with `liveRun.passed` equal to the set's item count, `liveRun.failed == 0`
(integers only: never a bool, a float or a string; review round, Codex P2 on PR #63) and a `liveRun.date`. The
deterministic counts are held to the same rule. State-based, not diff-based: any change without a
matching record fails, whatever the diff. It fails closed when it cannot read any of the values.

Usage: python3 ci_gates/check_committee_eval_record.py [--root DIR]
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import re
import sys
from pathlib import Path

COST_TABLE = "functions/src/p1/costTable.ts"
CONSTANTS = "platform/p1/constants.ts"
SYSTEM_POLICY = "platform/p1/systemPolicy.ts"
GROUNDING = "functions/src/p1/grounding.ts"
EVAL_SET = "docs/evals/committee-brain-eval-set.json"
RECORD = "docs/evals/committee-brain-eval-record.json"
RECORD_FORMAT = "committee-brain-eval-record/1"
RUN_HINT = (
    "re-run the evaluation (the deterministic grading in functions/test/f17-eval-set.test.ts, and the live run "
    "`npm --prefix functions run eval:committee-live` where a key is available) and update " + RECORD
)

TASK_MODEL_RE = re.compile(r"export const TASK_MODEL\b[^=]*=\s*Object\.freeze\(\s*\{(?P<body>[^{}]*)\}\s*\)")
ENTRY_RE = re.compile(r'\s*(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*"(?P<value>[^"\\]+)"\s*,?')
STRING_CONST = r'export const {name}\s*(?::\s*string\s*)?=\s*"(?P<value>[^"\\]+)"\s*(?:$|\n|;)'


class Unreadable(Exception):
    pass


def read(root: Path, rel: str) -> str:
    try:
        return (root / rel).read_text(encoding="utf-8")
    except OSError as err:
        raise Unreadable(f"cannot read {rel}: {err.strerror}") from err


def string_const(root: Path, rel: str, name: str) -> str:
    m = re.search(STRING_CONST.format(name=re.escape(name)), read(root, rel))
    if m is None:
        raise Unreadable(f"cannot read {name} in {rel} as a string literal; the gate must be updated with it")
    return m.group("value")


def task_routing(root: Path) -> dict[str, str]:
    m = TASK_MODEL_RE.search(read(root, COST_TABLE))
    if m is None:
        raise Unreadable(f"cannot read TASK_MODEL in {COST_TABLE} as a frozen object literal; the gate must be updated with it")
    body = m.group("body")
    routing: dict[str, str] = {}
    pos = 0
    while pos < len(body):
        e = ENTRY_RE.match(body, pos)
        if e is None:
            if body[pos:].strip() == "":
                break
            raise Unreadable(f"cannot read TASK_MODEL in {COST_TABLE}: an entry is not `task: \"model\"`")
        routing[e.group("key")] = e.group("value")
        pos = e.end()
    if not routing:
        raise Unreadable(f"cannot read TASK_MODEL in {COST_TABLE}: no entry")
    return routing


def is_count(value: object) -> bool:
    """A non-negative integer: never a bool (Python counts True as 1), a float or a string (review round, Codex P2)."""
    return type(value) is int and value >= 0


def is_full_run(run: object, items: int) -> bool:
    """A run of every item of the set with none failed: `passed == items` and `failed == 0`, both integers."""
    return isinstance(run, dict) and is_count(run.get("passed")) and is_count(run.get("failed")) and run.get("passed") == items and run.get("failed") == 0


def is_date(value: object) -> bool:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def check(root: Path) -> list[str]:
    problems: list[str] = []
    routing = {f"functions:{task}": model for task, model in task_routing(root).items()}
    routing["next:committee-brain"] = string_const(root, CONSTANTS, "COMMITTEE_BRAIN_GATEWAY_MODEL")
    policy_version = string_const(root, SYSTEM_POLICY, "SYSTEM_POLICY_VERSION")
    rules = string_const(root, GROUNDING, "GROUNDING_RULES_VERSION")
    set_text = read(root, EVAL_SET)
    try:
        eval_set = json.loads(set_text)
        set_version = eval_set["version"]
        set_items = len(eval_set["items"])
    except (ValueError, KeyError, TypeError) as err:
        raise Unreadable(f"cannot read {EVAL_SET}: {type(err).__name__}") from err
    set_sha = hashlib.sha256(set_text.encode("utf-8")).hexdigest()

    try:
        record = json.loads(read(root, RECORD))
    except ValueError as err:
        raise Unreadable(f"cannot read {RECORD}: not JSON") from err
    if not isinstance(record, dict):
        raise Unreadable(f"cannot read {RECORD}: not an object")

    if record.get("format") != RECORD_FORMAT:
        problems.append(f"record format is {record.get('format')!r}, expected {RECORD_FORMAT!r}")

    expected_set = {"path": EVAL_SET, "version": set_version, "sha256": set_sha, "items": set_items}
    recorded_set = record.get("evalSet")
    if not isinstance(recorded_set, dict):
        problems.append("record names no evalSet")
    else:
        for key, value in expected_set.items():
            if recorded_set.get(key) != value:
                problems.append(f"evaluation set {key} is {value!r} but the record names {recorded_set.get(key)!r}")

    recorded_routing = record.get("routing")
    if not isinstance(recorded_routing, dict):
        problems.append("record names no routing")
    else:
        for route in sorted(set(routing) | set(recorded_routing)):
            if routing.get(route) != recorded_routing.get(route):
                problems.append(f"routing {route} is {routing.get(route)!r} in code but the record names {recorded_routing.get(route)!r}")
    if record.get("modelId") != routing.get("functions:committee"):
        problems.append(f"committee model id functions:committee is {routing.get('functions:committee')!r} but the record's modelId is {record.get('modelId')!r}")

    expected_policy = {"policyId": "committee-brain", "version": policy_version}
    if record.get("policy") != expected_policy:
        problems.append(f"committee policy is {expected_policy!r} but the record names {record.get('policy')!r}")
    if record.get("groundingRules") != rules:
        problems.append(f"grounding rules are {rules!r} but the record names {record.get('groundingRules')!r}")

    if not is_date(record.get("date")):
        problems.append(f"record date {record.get('date')!r} is not a YYYY-MM-DD date")

    graded = record.get("graded")
    deterministic = graded.get("deterministic") if isinstance(graded, dict) else None
    if not is_full_run(deterministic, set_items):
        problems.append(f"deterministic grading must pass every one of the {set_items} items, in integers (record: {deterministic!r})")

    if record.get("result") != "pass":
        problems.append(f"record result is {record.get('result')!r}, expected 'pass'")

    live = record.get("live")
    if not isinstance(live, bool):
        problems.append(f"record live is {live!r}: it must be true or false")
    elif live is False:
        note = record.get("liveNote")
        if not (isinstance(note, str) and note.startswith("NOT RUN")):
            problems.append("record live is false but its liveNote does not start with 'NOT RUN': a live run that did not happen must say so")
    else:
        run = record.get("liveRun")
        if not (is_full_run(run, set_items) and is_date(run.get("date"))):
            problems.append(
                f"record live is true but liveRun is not a passing run of every one of the {set_items} items with a date "
                f"(passed == {set_items}, failed == 0, integers; liveRun: {run!r})"
            )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()
    root = Path(args.root)
    try:
        problems = check(root)
    except Unreadable as err:
        print(f"FAIL: committee-brain eval record gate: {err}")
        return 1
    if problems:
        print("FAIL: committee-brain eval record gate: the evaluation record does not match the code (audit F17).")
        for p in problems:
            print(f" - {p}")
        print(f"To fix: {RUN_HINT}.")
        return 1
    print(f"PASS: committee-brain eval record matches the routing, the policy, the grounding rules and the evaluation set ({RECORD}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
