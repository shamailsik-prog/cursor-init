"""Audit F21: the corpus lifecycle's completion boundary: the per-source report and stalled-row alerts.

Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md (R11).

``lifecycle_report`` returns, per source (the resolved source's name, else the record's label), per
table and per state, the count and, for every non-terminal state, the oldest ``state_changed_at``; for
``embedded`` records also the count by their ``embedding_queue`` row's status (``outbox``), so the
hand-off to F27 is visible. ``stalled_alerts`` turns every group of records waiting longer than its
threshold into an alert, logged at ERROR on F28's corpus alert line
(``F28 source alert: <source> stalled: <n> <table> rows in <state> for more than <h> h (oldest since <iso>)``):
6 hours in a machine state, 7 days in ``quarantined`` (a human review backlog). The reconcile tick
(scraper.tasks.corpus_pipeline, beat ``reconcile-corpus``) runs the repairs, then this, and keeps both in
its scraper_jobs summary. An operator prints the report with ``python -m scraper.tasks.reconcile report``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from datetime import timedelta
from typing import Any, Dict, List, Tuple

from sqlalchemy import text

from scraper import database
from scraper.publication import retrieval
from scraper.tasks import lifecycle

logger = logging.getLogger(__name__)

STALL_AFTER_MACHINE = timedelta(hours=6)
STALL_AFTER_REVIEW = timedelta(days=7)
_MASTER = {lifecycle.CASE_TABLE: retrieval.CASE_MASTER, lifecycle.STATUTE_TABLE: retrieval.STATUTE_MASTER}
_SOURCE = "coalesce(s.source_name, st.source_site, '(unknown)')"


def threshold(state: str) -> timedelta:
    return STALL_AFTER_REVIEW if state == lifecycle.QUARANTINED else STALL_AFTER_MACHINE


def _hours(delta: timedelta) -> int:
    return int(delta.total_seconds() // 3600)


def _groups_sql(table: str) -> str:
    stalled = (
        f"(st.lifecycle_state = '{lifecycle.QUARANTINED}' AND st.state_changed_at < now() - CAST(:review AS interval)) "
        f"OR (st.lifecycle_state <> '{lifecycle.QUARANTINED}' AND st.state_changed_at < now() - CAST(:machine AS interval))"
    )
    return (
        f"SELECT {_SOURCE} AS source, st.lifecycle_state AS state, count(*) AS n, min(st.state_changed_at) AS oldest, "
        f"count(*) FILTER (WHERE {stalled}) AS stalled, min(st.state_changed_at) FILTER (WHERE {stalled}) AS stalled_oldest "
        f"FROM {table} st LEFT JOIN scraper_sources s ON s.id = st.source_id GROUP BY 1, 2"
    )


def _outbox_sql(table: str) -> str:
    return (
        f"SELECT {_SOURCE} AS source, coalesce(e.status, '(missing)') AS status, count(*) AS n "
        f"FROM {table} st LEFT JOIN scraper_sources s ON s.id = st.source_id "
        f"LEFT JOIN embedding_queue e ON e.table_name = :master AND e.record_id = st.published_id "
        f"WHERE st.lifecycle_state = '{lifecycle.EMBEDDED}' GROUP BY 1, 2"
    )


async def lifecycle_report(db: Any) -> Tuple[Dict[str, Any], List[Tuple[str, str]]]:
    """(the report, the stalled-row alerts as (source, "stalled: ...")). Read-only."""
    report: Dict[str, Any] = {}
    alerts: List[Tuple[str, str]] = []
    params = {"machine": STALL_AFTER_MACHINE, "review": STALL_AFTER_REVIEW}
    for table in lifecycle.RECORD_TABLES:
        for row in (await db.execute(text(_groups_sql(table)), params)).all():
            terminal = row.state in lifecycle.TERMINAL_STATES
            report.setdefault(row.source, {}).setdefault(table, {})[row.state] = {
                "count": int(row.n),
                "oldest": None if terminal else row.oldest.isoformat(),
            }
            if not terminal and row.stalled:
                alerts.append((row.source, (
                    f"stalled: {int(row.stalled)} {table} rows in {row.state} for more than "
                    f"{_hours(threshold(row.state))} h (oldest since {row.stalled_oldest.isoformat()})"
                )))
        for row in (await db.execute(text(_outbox_sql(table)), {"master": _MASTER[table]})).all():
            entry = report.setdefault(row.source, {}).setdefault(table, {}).setdefault(lifecycle.EMBEDDED, {"count": 0, "oldest": None})
            entry.setdefault("outbox", {})[row.status] = int(row.n)
    return report, sorted(alerts)


def alert_lines(alerts: List[Tuple[str, str]]) -> List[str]:
    """The alerts as a summary keeps them: "<source> <alert>", the text after F28's marker."""
    return [f"{source} {alert}" for source, alert in alerts]


def log_alerts(alerts: List[Tuple[str, str]]) -> None:
    for source, alert in alerts:
        logger.error("F28 source alert: %s %s", source, alert)


async def _print_report() -> int:
    try:
        async with database.SessionLocal() as db:
            report, alerts = await lifecycle_report(db)
    finally:
        await database.engine.dispose()
    print(json.dumps({"report": report, "alerts": alert_lines(alerts)}, indent=2, sort_keys=True))
    return 0


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args != ["report"]:
        print("usage: python -m scraper.tasks.reconcile report", file=sys.stderr)
        return 2
    return asyncio.run(_print_report())


if __name__ == "__main__":
    sys.exit(main())
