"""Rebuild the published research term index (FA-D5-003-R1-001).

Tokenisation matches services/d5-1/research.ts ``termsOf`` / ``termsOfDocument``: ``normaliseDraftText`` fold,
lowercase, Unicode letters and numbers, the same stop-word set, and the same lone-letter rule.
"""
from __future__ import annotations

import json
import unicodedata

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from scraper.publication.research_text_fold import normalise_research_draft_text

_STOP_WORDS = frozenset(
    "a an and are as at be by for in is of on or the to v vs versus was with".split()
)


def _is_token_char(ch: str) -> bool:
    if not ch:
        return False
    cat = unicodedata.category(ch)
    return cat.startswith("L") or cat == "Nd" or ch.isascii() and ch.isalnum()


def research_terms_of(text: str) -> list[str]:
    folded = normalise_research_draft_text(text).lower()
    out: list[str] = []
    seen: set[str] = set()
    i = 0
    while i < len(folded):
        if not _is_token_char(folded[i]):
            i += 1
            continue
        j = i + 1
        while j < len(folded) and _is_token_char(folded[j]):
            j += 1
        term = folded[i:j]
        i = j
        if term in _STOP_WORDS:
            continue
        if len(term) < 2 and not (len(term) == 1 and term.isdigit()):
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
    df: dict[str, int] = {}
    postings: list[dict[str, str]] = []
    for judgment_id, title, citations in rows:
        terms = terms_for_judgment(title or "", list(citations or []))
        for term in terms:
            postings.append({"judgment_id": str(judgment_id), "term": term})
            df[term] = df.get(term, 0) + 1
    count = len(rows)
    df_payload = [{"term": t, "doc_freq": n} for t, n in sorted(df.items())]
    await conn.execute(
        text(
            "SELECT public.corpus_research_term_apply(:count, CAST(:postings AS jsonb), CAST(:df AS jsonb))"
        ),
        {"count": count, "postings": json.dumps(postings), "df": json.dumps(df_payload)},
    )
