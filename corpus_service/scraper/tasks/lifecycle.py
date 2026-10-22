"""Audit F21: the corpus record lifecycle, its legal moves and its one guarded writer.

Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md (rulings R1-R3, R5).

Every harvested record (a ``scraper_staging`` case row or a ``statutes_staging`` statute row) carries
``lifecycle_state``. A row enters at ``parsed`` (R2: discovery, download and parse happen inside one
item step of a harvest run; their failures are F28's per-item outcomes) and moves only along
``LEGAL_MOVES``:

    discovered -> downloaded -> parsed -> normalised -> quarantined | approved -> published -> embedded

with ``failed`` (the record's own content is unusable), ``duplicate`` (an earlier record of the same
source, URL and content exists), ``rejected`` (an F23 reviewer rejected it) and ``dead_letter`` (a
consumer refused it for good, or it can never move) as terminal states with a reason.

``move`` is the only code that assigns ``lifecycle_state`` (a static test pins this): it refuses an
illegal move before anything is written, and writes the state, ``state_changed_at``, ``state_reason``
and one ``corpus_lifecycle_transitions`` row in the caller's transaction, so the state and its log
commit or roll back together. The database CHECKs (scraper/models.py, migration 005) are built from
the same tables here.

This module imports no model at import time: scraper/models.py imports the vocabulary from it.
"""

from __future__ import annotations

import contextlib
import contextvars
import uuid
from typing import Any, Dict, Final, FrozenSet, Iterator, Mapping, Optional, Tuple

CASE_TABLE: Final = "scraper_staging"
STATUTE_TABLE: Final = "statutes_staging"
RECORD_TABLES: Final[Tuple[str, ...]] = (CASE_TABLE, STATUTE_TABLE)

DISCOVERED: Final = "discovered"
DOWNLOADED: Final = "downloaded"
PARSED: Final = "parsed"
NORMALISED: Final = "normalised"
QUARANTINED: Final = "quarantined"
APPROVED: Final = "approved"
PUBLISHED: Final = "published"
EMBEDDED: Final = "embedded"
REJECTED: Final = "rejected"
DUPLICATE: Final = "duplicate"
FAILED: Final = "failed"
DEAD_LETTER: Final = "dead_letter"

LEGAL_MOVES: Final[Mapping[str, FrozenSet[str]]] = {
    DISCOVERED: frozenset({DOWNLOADED, FAILED, DUPLICATE, DEAD_LETTER}),
    DOWNLOADED: frozenset({PARSED, FAILED, DUPLICATE, DEAD_LETTER}),
    PARSED: frozenset({NORMALISED, FAILED, DUPLICATE, DEAD_LETTER}),
    NORMALISED: frozenset({QUARANTINED, APPROVED, DEAD_LETTER}),
    QUARANTINED: frozenset({APPROVED, REJECTED, DEAD_LETTER}),
    APPROVED: frozenset({PUBLISHED, DEAD_LETTER}),
    PUBLISHED: frozenset({EMBEDDED, DEAD_LETTER}),
    EMBEDDED: frozenset(),
    REJECTED: frozenset(),
    DUPLICATE: frozenset(),
    FAILED: frozenset(),
    DEAD_LETTER: frozenset(),
}
STATES: Final[Tuple[str, ...]] = tuple(LEGAL_MOVES)
ENTRY_STATE: Final = PARSED
TERMINAL_STATES: Final[FrozenSet[str]] = frozenset(s for s, out in LEGAL_MOVES.items() if not out)
NON_TERMINAL_STATES: Final[Tuple[str, ...]] = tuple(s for s in STATES if s not in TERMINAL_STATES)
# A terminal state other than embedded says why (R3; a CHECK on each staging table).
REASON_REQUIRED: Final[FrozenSet[str]] = frozenset({FAILED, DUPLICATE, REJECTED, DEAD_LETTER})
MAX_REASON_CHARS: Final = 200

# scraper_jobs.job_type of a consumer tick (R5); the job-type CHECK lists them after the existing ones.
JOB_TYPE_NORMALISE: Final = "normalise"
JOB_TYPE_PROMOTE: Final = "promote"
JOB_TYPE_PUBLISH: Final = "publish"
JOB_TYPE_RECONCILE: Final = "reconcile"
LIFECYCLE_JOB_TYPES: Final[Tuple[str, ...]] = (JOB_TYPE_NORMALISE, JOB_TYPE_PROMOTE, JOB_TYPE_PUBLISH, JOB_TYPE_RECONCILE)
LEGACY_JOB_TYPES: Final[Tuple[str, ...]] = (
    "full_scrape", "incremental", "retry_failed", "embed", "cross_ref", "cause_list", "bench",
)
LIFECYCLE_SITE: Final = "corpus_lifecycle"  # scraper_jobs.source_site of a consumer tick


def job_type_check_sql() -> str:
    return f"job_type IN ({_sql_list(LEGACY_JOB_TYPES + LIFECYCLE_JOB_TYPES)})"


# Who moves a record (the transition's actor).
ACTOR_NORMALISE: Final = "normalise"
ACTOR_GATE: Final = "gate"
ACTOR_PUBLISH: Final = "publish"
ACTOR_REVIEW_SYNC: Final = "review_sync"
ACTOR_RECONCILE: Final = "reconcile"
ACTOR_MIGRATION: Final = "migration_005"


class IllegalTransition(ValueError):
    """A move the lifecycle does not allow (nothing was written)."""


def is_legal(from_state: Optional[str], to_state: str) -> bool:
    return from_state in LEGAL_MOVES and to_state in LEGAL_MOVES[from_state]


def _sql_list(values) -> str:
    return ", ".join(f"'{v}'" for v in values)


def states_check_sql(column: str = "lifecycle_state") -> str:
    return f"{column} IN ({_sql_list(STATES)})"


def reason_check_sql() -> str:
    return f"lifecycle_state NOT IN ({_sql_list(sorted(REASON_REQUIRED))}) OR state_reason IS NOT NULL"


def legal_pairs_sql() -> str:
    """The transition log's CHECK: every logged move is legal; a NULL from_state is migration 005's
    backfill entry (R13)."""
    pairs = sorted(f"{a}>{b}" for a, outs in LEGAL_MOVES.items() for b in outs)
    return (f"{states_check_sql('to_state')} AND (from_state IS NULL OR "
            f"(from_state || '>' || to_state) IN ({_sql_list(pairs)}))")


def table_of(row: Any) -> str:
    table = getattr(row, "__tablename__", None)
    if table not in RECORD_TABLES:
        raise IllegalTransition(f"not a lifecycle record: {type(row).__name__}")
    return table


def move(
    db: Any,
    row: Any,
    to_state: str,
    *,
    actor: str,
    job_id: Optional[uuid.UUID] = None,
    reason: Optional[str] = None,
    details: Optional[Mapping[str, Any]] = None,
) -> None:
    """Move ``row`` to ``to_state`` in the caller's transaction and log the move. Raises
    IllegalTransition, writing nothing, for a move outside LEGAL_MOVES or a terminal-bad state
    without a reason."""
    from sqlalchemy import func

    from scraper.models import CorpusLifecycleTransition

    table = table_of(row)
    from_state = row.lifecycle_state
    if not is_legal(from_state, to_state):
        raise IllegalTransition(f"{table} {from_state} -> {to_state} is not a legal move")
    if to_state in REASON_REQUIRED and not (reason and reason.strip()):
        raise IllegalTransition(f"{table} -> {to_state} needs a reason")
    reason = reason[:MAX_REASON_CHARS] if reason else None
    row.lifecycle_state = to_state
    row.state_changed_at = func.now()
    row.state_reason = reason
    db.add(CorpusLifecycleTransition(
        record_table=table,
        record_id=row.id,
        from_state=from_state,
        to_state=to_state,
        reason=reason,
        actor=actor,
        job_id=job_id,
        details=dict(details) if details else None,
    ))


def move_through(db: Any, row: Any, path, *, actor: str, job_id=None, reason=None,
                 details: Optional[Mapping[str, Any]] = None) -> None:
    """Several moves in order (one transaction); ``reason`` and ``details`` go on the last one."""
    path = list(path)
    for index, state in enumerate(path):
        last = index == len(path) - 1
        move(db, row, state, actor=actor, job_id=job_id, reason=reason if last else None,
             details=details if last else None)


# ---------------------------------------------------------------------------------------------
# The run that staged a record (R5): run_source binds its F28 job id for the harvester.
# ---------------------------------------------------------------------------------------------
_RUN_JOB: contextvars.ContextVar[Optional[uuid.UUID]] = contextvars.ContextVar("f21_run_job", default=None)


def run_job_id() -> Optional[uuid.UUID]:
    """The scraper_jobs id of the harvest run in progress, or None when a harvester runs on its own."""
    return _RUN_JOB.get()


@contextlib.contextmanager
def bind_run_job(job_id: Optional[uuid.UUID]) -> Iterator[None]:
    token = _RUN_JOB.set(job_id)
    try:
        yield
    finally:
        _RUN_JOB.reset(token)


def summary_details(**values: Any) -> Dict[str, Any]:
    """Transition details without None values (JSON-safe strings for ids)."""
    return {k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in values.items() if v is not None}
