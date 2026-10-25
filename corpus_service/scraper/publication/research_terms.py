"""Rebuild the published research term index (FA-D5-003-R1-001).

Tokenisation matches services/d5-1/research.ts ``termsOf`` / ``termsOfDocument``: NFKD fold, lowercase,
Unicode letters and numbers, the same stop-word set, and the same lone-letter rule.
"""
from __future__ import annotations

import re
import unicodedata

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

_STOP_WORDS = frozenset(
    "a an and are as at be by for in is of on or the to v vs versus was with".split()
)
_TERM_RE = re.compile(r"[\w\d]+", re.UNICODE)


def research_terms_of(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKD", text)
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    folded = folded.lower()
    out: list[str] = []
    seen: set[str] = set()
    for match in _TERM_RE.finditer(folded):
        term = match.group(0)
        if term in _STOP_WORDS:
            continue
        if len(term) < 2 and not term.isdigit():
            continue
        if term in seen:
            continue
        seen.add(term)
        out.append(term)
    return out


def terms_for_judgment(title: str, citations: list[str]) -> list[str]:
    blob = f"{title} {' '.join(citations)}"
    return research_terms_of(blob)


async def refresh_research_terms(conn: AsyncConnection) -> None:
    """Replace corpus_research_term and corpus_research_term_df from the current visible research corpus."""
    rows = (
        await conn.execute(
            text(
                """
                SELECT j.judgment_id, j.case_title,
                       coalesce(array_agg(c.citation_text ORDER BY c.citation_text COLLATE "C")
                                FILTER (WHERE c.citation_text IS NOT NULL), '{}'::text[]) AS citations
                  FROM public.v_research_judgment j
                  LEFT JOIN public.v_authority_citation c ON c.judgment_id = j.judgment_id
                 GROUP BY j.judgment_id, j.case_title
                """
            )
        )
    ).all()
    await conn.execute(text("TRUNCATE public.corpus_research_term, public.corpus_research_term_df"))
    df: dict[str, int] = {}
    batch: list[dict[str, object]] = []
    for judgment_id, title, citations in rows:
        terms = terms_for_judgment(title or "", list(citations or []))
        for term in terms:
            batch.append({"judgment_id": judgment_id, "term": term})
            df[term] = df.get(term, 0) + 1
    if batch:
        await conn.execute(
            text("INSERT INTO public.corpus_research_term (judgment_id, term) VALUES (:judgment_id, :term)"),
            batch,
        )
    if df:
        await conn.execute(
            text("INSERT INTO public.corpus_research_term_df (term, doc_freq) VALUES (:term, :doc_freq)"),
            [{"term": t, "doc_freq": n} for t, n in sorted(df.items())],
        )
    count = len(rows)
    await conn.execute(
        text(
            """
            INSERT INTO public.corpus_metadata (key, value, updated_at) VALUES
              ('research_judgment_count', :count, pg_catalog.now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
            """
        ),
        {"count": str(count)},
    )
