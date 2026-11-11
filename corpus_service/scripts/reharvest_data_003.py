"""Plan DATA-003-REHARVEST and, only with --apply, re-key an export.

The default is a dry run. It writes a report and does not write a backup.
``--apply`` requires ``--expect-count`` and the exact id list. It re-keys those
rows inside a transaction on the export, then writes the backup JSONL, the
rollback SQL, and the apply SQL. It does not delete rows.

This process does not open a database. A ``--dsn`` argument or a postgres URL
is refused.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scraper.reharvest.data_003 import (  # noqa: E402
    MemoryStore,
    ReharvestRefusal,
    apply_transaction,
    build_report,
)

_LIVE_MARKERS = ("--dsn", "postgres://", "postgresql://", "postgresql+")


def _refuse_live(argv: list) -> None:
    joined = " ".join(argv).lower()
    if any(marker in joined for marker in _LIVE_MARKERS):
        raise SystemExit(
            "refusing database execution: DATA-003-REHARVEST does not run against a live database"
        )


def _load(path: Path) -> list:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit("input JSON must be a list of row objects")
    return data


def _write_json(path: Path, body: dict) -> None:
    path.write_text(json.dumps(body, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    _refuse_live(argv)
    parser = argparse.ArgumentParser(description="DATA-003-REHARVEST section re-key (no database).")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true", help="Write the report only. This is the default.")
    parser.add_argument("--apply", action="store_true", help="Re-key the export inside a transaction.")
    parser.add_argument("--expect-count", type=int, default=None)
    parser.add_argument("--ids", default=None, help="Comma-separated ids. Must be exactly the planned re-key set.")
    parser.add_argument("--backup", type=Path, default=None, help="Backup JSONL, written only after commit.")
    parser.add_argument("--rollback", type=Path, default=None, help="Rollback SQL, written only after commit.")
    parser.add_argument("--apply-sql", type=Path, default=None, help="Transactional apply SQL, written only after commit.")
    parser.add_argument("--rows-out", type=Path, default=None, help="Post-image JSON, written only after commit.")
    args = parser.parse_args(argv)
    if args.apply and args.dry_run:
        raise SystemExit("pass either --dry-run or --apply")
    apply_flags = [args.expect_count is not None, bool(args.ids), args.backup, args.rollback, args.apply_sql]
    if args.apply:
        if args.expect_count is None or not args.ids:
            raise SystemExit("apply requires --expect-count and --ids")
        if args.backup is None or args.rollback is None or args.apply_sql is None:
            raise SystemExit("apply requires --backup, --rollback and --apply-sql")
    elif any(apply_flags):
        raise SystemExit("expect-count, ids, backup, rollback and apply-sql require --apply")
    rows = _load(args.input)
    before = args.input.read_bytes()
    if not args.apply:
        _write_json(args.output, build_report(rows, dry_run=True, applied=False))
        if args.input.read_bytes() != before:
            raise SystemExit("dry-run changed the input")
        return 0
    store = MemoryStore(rows)
    try:
        result = apply_transaction(
            store, rows, expect_count=args.expect_count, ids=args.ids.split(","),
        )
    except ReharvestRefusal as exc:
        _write_json(args.output, build_report(rows, dry_run=False, applied=False, refusal=str(exc)))
        if args.input.read_bytes() != before:
            raise SystemExit("a refused apply changed the input")
        return 2
    if args.input.read_bytes() != before:
        raise SystemExit("apply changed the input")
    args.backup.write_text(result["backup_jsonl"], encoding="utf-8")
    args.rollback.write_text(result["rollback_sql"], encoding="utf-8")
    args.apply_sql.write_text(result["apply_sql"], encoding="utf-8")
    if args.rows_out is not None:
        args.rows_out.write_text(
            json.dumps(list(store.rows.values()), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    report = build_report(rows, dry_run=False, applied=True)
    report["applied_ids"] = result["ids"]
    _write_json(args.output, report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
