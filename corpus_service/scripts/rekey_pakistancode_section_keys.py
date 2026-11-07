"""Dry-run planner for PakistanCode text-prefix section keys (FA-F21-017).

Reads a JSON list of statute rows and writes a plan. ``--apply`` writes the rekeyed
rows to another JSON file. This process never opens a database. A ``--dsn`` argument
or a postgres URL is refused so the planner cannot be pointed at live data.

The plan is idempotent: applying it, then planning the result, yields no ``rekey``
actions. Conflicts and bare section numbers are reported and left unchanged.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scraper.parsers.pakistancode_keys import apply_legacy_rekey, plan_legacy_rekey  # noqa: E402

_LIVE_MARKERS = ("--dsn", "postgres://", "postgresql://", "postgresql+")


def _refuse_live(argv: list) -> None:
    joined = " ".join(argv).lower()
    if any(marker in joined for marker in _LIVE_MARKERS):
        raise SystemExit(
            "refusing database execution: FA-F21-017 rekey is file-based and must not run against a live database"
        )


def _load(path: Path) -> list:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit("input JSON must be a list of row objects")
    return data


def main(argv: list | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    _refuse_live(argv)
    parser = argparse.ArgumentParser(description="Plan PakistanCode section-key rekey (no database).")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Write the plan only (this is the default).")
    mode.add_argument("--apply", action="store_true", help="Write rekeyed rows to --output. Does not connect anywhere.")
    args = parser.parse_args(argv)
    rows = _load(args.input)
    plan = plan_legacy_rekey(rows)
    body = {
        "dry_run": not args.apply,
        "actions": [action.__dict__ for action in plan],
    }
    if args.apply:
        body["rows"] = apply_legacy_rekey(rows, plan)
    args.output.write_text(json.dumps(body, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
