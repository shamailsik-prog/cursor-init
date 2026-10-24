"""Write the research term index (audit FA-D5-003-R1-001; spec R20, R21).

postgres/ddl/006_research_terms.sql stores each title's and each citation's research terms, pre-folded, and each
judgment's size (its distinct-term count over its title and its promoted citations), and marks a row pending whenever
what they depend on is written (a trigger, whoever writes). ``index_research_terms`` folds pending rows with
``research_terms.research_term_set`` (the application's fold, pinned by the golden), replaces their term rows, writes the
size of every judgment it touched, and clears their marks, all in the caller's transaction. A text the fold cannot
reproduce exactly (a code point outside its DOMAIN) keeps its mark: the application folds that judgment itself at query
time, so research stays exact.

Two callers, both as ``corpus_writer`` inside the caller's transaction:

* ``publish_batch`` indexes the judgments it wrote and their citations, in the publication's own transaction;
* ``python -m scraper.publication.cli index-terms`` indexes every pending row (the backlog 006's first application
  marks, and rows a superuser or a bulk load wrote), in batches.

Every statement uses bound parameters; nothing logs a title or a citation.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from scraper.publication.research_terms import research_term_set

logger = logging.getLogger(__name__)

#: 006's CHECK on a term; a longer term (a 501-character "word") is left to the application's fold.
MAX_TERM_CHARS = 500
BATCH = 2000


@dataclass(frozen=True)
class IndexSummary:
    """How many titles and citations were indexed, how many could not be folded here, and how many marks remain."""

    titles: int
    citations: int
    unindexable: int
    pending_titles: int
    pending_citations: int

    def as_dict(self) -> Dict[str, int]:
        return {
            "titles": self.titles,
            "citations": self.citations,
            "unindexable": self.unindexable,
            "pending_titles": self.pending_titles,
            "pending_citations": self.pending_citations,
        }


async def research_index_present(conn: AsyncConnection) -> bool:
    """Whether 006 is applied (a database without it has no index to keep, and its first application marks every row)."""
    return bool((await conn.execute(text("SELECT pg_catalog.to_regclass('public.research_title_pending') IS NOT NULL"))).scalar())


def _terms(value: Optional[str]) -> Optional[List[str]]:
    terms = research_term_set(value)
    if terms is None or any(len(t) > MAX_TERM_CHARS for t in terms):
        return None
    return sorted(terms)


async def _index_titles(conn: AsyncConnection, rows: Sequence[Tuple[uuid.UUID, Optional[str]]]) -> Tuple[List[uuid.UUID], int]:
    done: List[uuid.UUID] = []
    term_ids: List[uuid.UUID] = []
    term_values: List[str] = []
    skipped = 0
    for judgment_id, title in rows:
        terms = _terms(title)
        if terms is None:
            skipped += 1
            continue
        done.append(judgment_id)
        term_ids.extend([judgment_id] * len(terms))
        term_values.extend(terms)
    if done:
        params: Dict[str, Any] = {"ids": done}
        await conn.execute(text("DELETE FROM public.research_title_term WHERE judgment_id = ANY(:ids)"), params)
        if term_values:
            await conn.execute(
                text("INSERT INTO public.research_title_term (judgment_id, term) "
                     "SELECT * FROM unnest(CAST(:ids AS uuid[]), CAST(:terms AS text[]))"),
                {"ids": term_ids, "terms": term_values},
            )
        await conn.execute(text("DELETE FROM public.research_title_pending WHERE judgment_id = ANY(:ids)"), params)
    return done, skipped


async def _index_citations(conn: AsyncConnection, texts: Sequence[str]) -> Tuple[List[str], int]:
    done: List[str] = []
    term_keys: List[str] = []
    term_values: List[str] = []
    skipped = 0
    for citation_text in texts:
        terms = _terms(citation_text)
        if terms is None:
            skipped += 1
            continue
        done.append(citation_text)
        term_keys.extend([citation_text] * len(terms))
        term_values.extend(terms)
    if done:
        params: Dict[str, Any] = {"texts": done}
        await conn.execute(text("DELETE FROM public.research_citation_term WHERE citation_text = ANY(:texts)"), params)
        if term_values:
            await conn.execute(
                text("INSERT INTO public.research_citation_term (citation_text, term) "
                     "SELECT * FROM unnest(CAST(:keys AS text[]), CAST(:terms AS text[]))"),
                {"keys": term_keys, "terms": term_values},
            )
        await conn.execute(text("DELETE FROM public.research_citation_pending WHERE citation_text = ANY(:texts)"), params)
    return done, skipped


async def _judgments_of(conn: AsyncConnection, texts: Sequence[str]) -> List[uuid.UUID]:
    if not texts:
        return []
    return [r[0] for r in (await conn.execute(text(
        "SELECT DISTINCT judgment_id FROM public.citation WHERE citation_text = ANY(:texts) AND judgment_id IS NOT NULL"
    ), {"texts": list(texts)})).all()]


async def _write_sizes(conn: AsyncConnection, judgment_ids: Iterable[uuid.UUID]) -> None:
    """Each judgment's size: its distinct terms over its title and its promoted citations, from the rows just written.
    Written after every term of the run, so a judgment whose title and citation both changed is counted once, whole."""
    ids = sorted(set(judgment_ids), key=str)
    for start in range(0, len(ids), BATCH):
        params: Dict[str, Any] = {"ids": ids[start:start + BATCH]}
        await conn.execute(text("DELETE FROM public.research_size WHERE judgment_id = ANY(:ids)"), params)
        await conn.execute(text(
            "INSERT INTO public.research_size (judgment_id, size) "
            "SELECT j.id, (SELECT count(*) FROM ("
            "  SELECT t.term FROM public.research_title_term t WHERE t.judgment_id = j.id "
            "  UNION "
            "  SELECT ct.term FROM public.citation c "
            "    JOIN public.research_citation_term ct ON ct.citation_text = c.citation_text "
            "   WHERE c.judgment_id = j.id AND c.review_status = 'promoted') x) "
            "FROM public.judgment j WHERE j.id = ANY(:ids)"
        ), params)


async def _remaining(conn: AsyncConnection) -> Tuple[int, int]:
    row = (await conn.execute(text(
        "SELECT (SELECT count(*) FROM public.research_title_pending), (SELECT count(*) FROM public.research_citation_pending)"
    ))).one()
    return int(row[0]), int(row[1])


async def index_research_terms(conn: AsyncConnection, judgment_ids: Optional[Iterable[uuid.UUID]] = None) -> IndexSummary:
    """Index pending rows: those of ``judgment_ids`` (their titles and their citations) when given, else every pending
    row. Runs on the caller's connection and transaction, as ``corpus_writer``."""
    titles = citations = unindexable = 0
    touched: List[uuid.UUID] = []
    if judgment_ids is not None:
        ids = sorted(set(judgment_ids), key=str)
        if ids:
            rows = (await conn.execute(text(
                "SELECT p.judgment_id, j.case_title FROM public.research_title_pending p "
                "JOIN public.judgment j ON j.id = p.judgment_id WHERE p.judgment_id = ANY(:ids)"
            ), {"ids": ids})).all()
            done, skipped = await _index_titles(conn, [(r[0], r[1]) for r in rows])
            titles, unindexable = titles + len(done), unindexable + skipped
            touched.extend(done)
            texts = [r[0] for r in (await conn.execute(text(
                "SELECT p.citation_text FROM public.research_citation_pending p "
                "JOIN public.citation c ON c.citation_text = p.citation_text WHERE c.judgment_id = ANY(:ids)"
            ), {"ids": ids})).all()]
            done_texts, skipped = await _index_citations(conn, texts)
            citations, unindexable = citations + len(done_texts), unindexable + skipped
            touched.extend(await _judgments_of(conn, done_texts))
    else:
        # Keyset pages, so a row left pending (unfoldable here) is passed once, never re-read forever.
        after_id: Optional[uuid.UUID] = None
        while True:
            rows = (await conn.execute(text(
                "SELECT p.judgment_id, j.case_title FROM public.research_title_pending p "
                "JOIN public.judgment j ON j.id = p.judgment_id "
                "WHERE CAST(:after AS uuid) IS NULL OR p.judgment_id > CAST(:after AS uuid) "
                "ORDER BY p.judgment_id LIMIT :n"
            ), {"after": after_id, "n": BATCH})).all()
            if not rows:
                break
            done, skipped = await _index_titles(conn, [(r[0], r[1]) for r in rows])
            titles, unindexable = titles + len(done), unindexable + skipped
            touched.extend(done)
            after_id = rows[-1][0]
        after_text: Optional[str] = None
        while True:
            texts = [r[0] for r in (await conn.execute(text(
                "SELECT citation_text FROM public.research_citation_pending "
                "WHERE CAST(:after AS text) IS NULL OR citation_text COLLATE \"C\" > CAST(:after AS text) COLLATE \"C\" "
                "ORDER BY citation_text COLLATE \"C\" LIMIT :n"
            ), {"after": after_text, "n": BATCH})).all()]
            if not texts:
                break
            done_texts, skipped = await _index_citations(conn, texts)
            citations, unindexable = citations + len(done_texts), unindexable + skipped
            touched.extend(await _judgments_of(conn, done_texts))
            after_text = texts[-1]
    await _write_sizes(conn, touched)
    pending_titles, pending_citations = await _remaining(conn)
    logger.info("research_index.indexed titles=%d citations=%d unindexable=%d pending_titles=%d pending_citations=%d",
                titles, citations, unindexable, pending_titles, pending_citations)
    return IndexSummary(titles, citations, unindexable, pending_titles, pending_citations)
