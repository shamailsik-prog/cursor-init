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


_VISIBLE_JUDGMENT = """
  j.review_status = 'promoted'
  AND j.bench_type IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = j.classification AND cr.rank = 0)
  AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = j.publication_id AND pub.finished_at IS NOT NULL)
  AND EXISTS (SELECT 1 FROM public.source_provenance p
               WHERE p.id = j.source_id
                 AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                 AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                 AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
"""

_VISIBLE_CITATION = """
  c.review_status = 'promoted'
  AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = c.publication_id AND pub.finished_at IS NOT NULL)
  AND EXISTS (SELECT 1 FROM public.source_provenance p
               WHERE p.id = c.source_id
                 AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                 AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                 AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
"""


async def refresh_research_terms(conn: AsyncConnection) -> None:
    """Replace corpus_research_term and corpus_research_term_df from the current visible research corpus."""
    rows = (
        await conn.execute(
            text(
                f"""
                SELECT j.id AS judgment_id, j.case_title,
                       coalesce(array_agg(c.citation_text ORDER BY c.citation_text COLLATE "C")
                                FILTER (WHERE c.citation_text IS NOT NULL), '{{}}'::text[]) AS citations
                  FROM public.judgment j
                  LEFT JOIN public.citation c ON c.judgment_id = j.id AND {_VISIBLE_CITATION}
                 WHERE {_VISIBLE_JUDGMENT}
                 GROUP BY j.id, j.case_title
                """
            )
        )
    ).all()
    await conn.execute(text("SELECT public.corpus_research_term_clear()"))
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
