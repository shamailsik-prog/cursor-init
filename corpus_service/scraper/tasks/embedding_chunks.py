"""Audit F45: deterministic, versioned embedding chunks with stable content hashes and body offsets.

Each master record (case_law_master / statutes_master) is split into paragraph-aware body chunks.
Chunk 0 includes title and label prefix; later chunks are body-only. Every chunk gets its own F27
operation identity; the queue row completes with a manifest operation id over all chunk content hashes.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

# Spec version for chunk boundaries and metadata (bump when splitting rules change).
CHUNK_SPEC_VERSION = "f45-chunk-v1"
# F27 operation array version (includes chunk index and content hash).
OPERATION_VERSION = "f45-embedding-op-v1"
# Maximum UTF-8 code units of body text per chunk (title/label sit outside this on chunk 0 only).
BODY_CHARS_PER_CHUNK = 2000

_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n+")


@dataclass(frozen=True)
class EmbeddingChunk:
    chunk_index: int
    embed_text: str
    content_hash: str
    char_start: int
    char_end: int
    paragraph_start: int
    paragraph_end: int
    language: str


def normalize_body(body: Optional[str]) -> str:
    if not body:
        return ""
    return unicodedata.normalize("NFC", body)


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _paragraph_spans(body: str) -> List[Tuple[int, int, int]]:
    """(paragraph_index, char_start, char_end) for each non-empty paragraph in ``body``."""
    spans: List[Tuple[int, int, int]] = []
    if not body:
        return spans
    index = 0
    for match in _PARAGRAPH_SPLIT.finditer(body):
        start, end = match.span()
        if start > index:
            piece = body[index:start]
            if piece.strip():
                spans.append((len(spans), index, start))
        index = end
    if index < len(body):
        piece = body[index:]
        if piece.strip():
            spans.append((len(spans), index, len(body)))
    if not spans and body.strip():
        spans.append((0, 0, len(body)))
    return spans


def _pack_paragraphs(
    body: str,
    spans: Sequence[Tuple[int, int, int]],
    *,
    max_chars: int,
) -> List[Tuple[int, int, int, int]]:
    """Ranges as (char_start, char_end, paragraph_start, paragraph_end) covering ``body``."""
    if not body.strip():
        return [(0, 0, 0, 0)] if not spans else []
    packed: List[Tuple[int, int, int, int]] = []
    if not spans:
        for start in range(0, len(body), max_chars):
            end = min(start + max_chars, len(body))
            packed.append((start, end, 0, 0))
        return packed or [(0, 0, 0, 0)]

    start_pi = spans[0][0]
    range_start = spans[0][1]
    range_end = spans[0][2]
    last_pi = spans[0][0]

    for para_index, p_start, p_end in spans[1:]:
        candidate_end = p_end
        if candidate_end - range_start > max_chars and range_end > range_start:
            packed.append((range_start, range_end, start_pi, last_pi))
            range_start = p_start
            range_end = p_end
            start_pi = para_index
            last_pi = para_index
        else:
            range_end = candidate_end
            last_pi = para_index
    if range_end > range_start:
        packed.append((range_start, range_end, start_pi, last_pi))
    split: List[Tuple[int, int, int, int]] = []
    for char_start, char_end, p_start, p_end in packed:
        cursor = char_start
        while cursor < char_end:
            end = min(cursor + max_chars, char_end)
            split.append((cursor, end, p_start, p_end))
            cursor = end
    return split


def build_embedding_chunks(
    title: Optional[str],
    label: Optional[str],
    body: Optional[str],
    *,
    language: str = "en",
) -> List[EmbeddingChunk]:
    """Deterministic chunks for one master row. Empty body yields no chunks."""
    normalized = normalize_body(body)
    if not normalized.strip():
        return []
    spans = _paragraph_spans(normalized)
    ranges = _pack_paragraphs(normalized, spans, max_chars=BODY_CHARS_PER_CHUNK)
    prefix = f"{title or ''} {label or ''}".strip()
    chunks: List[EmbeddingChunk] = []
    for index, (char_start, char_end, p_start, p_end) in enumerate(ranges):
        slice_text = normalized[char_start:char_end]
        if index == 0 and prefix:
            embed = f"{prefix} {slice_text}".strip()
        else:
            embed = slice_text
        chunks.append(
            EmbeddingChunk(
                chunk_index=index,
                embed_text=embed,
                content_hash=content_hash(embed),
                char_start=char_start,
                char_end=char_end,
                paragraph_start=p_start,
                paragraph_end=p_end,
                language=language or "en",
            )
        )
    return chunks


def chunk_operation_id(
    table_name: str,
    record_id,
    model: str,
    dimensions: int,
    chunk: EmbeddingChunk,
) -> str:
    """F27 R4 extended: one stable id per chunk embedding request."""
    material = [
        OPERATION_VERSION,
        table_name,
        str(record_id),
        model,
        int(dimensions),
        chunk.chunk_index,
        CHUNK_SPEC_VERSION,
        chunk.content_hash,
    ]
    return hashlib.sha256(json.dumps(material, separators=(",", ":")).encode("ascii")).hexdigest()


def manifest_operation_id(
    table_name: str,
    record_id,
    model: str,
    dimensions: int,
    chunks: Sequence[EmbeddingChunk],
) -> str:
    """The queue row's completion identity when every chunk in ``chunks`` is embedded."""
    hashes = [c.content_hash for c in chunks]
    material = [
        CHUNK_SPEC_VERSION,
        "manifest",
        table_name,
        str(record_id),
        model,
        int(dimensions),
        hashes,
    ]
    return hashlib.sha256(json.dumps(material, separators=(",", ":")).encode("ascii")).hexdigest()


def first_incomplete_chunk(
    chunks: Sequence[EmbeddingChunk],
    stored: Sequence[Tuple[int, str]],
) -> Optional[EmbeddingChunk]:
    """First chunk whose ``content_hash`` is missing from ``stored`` (chunk_index, content_hash)."""
    done = {index: h for index, h in stored}
    for chunk in chunks:
        if done.get(chunk.chunk_index) != chunk.content_hash:
            return chunk
    return None
