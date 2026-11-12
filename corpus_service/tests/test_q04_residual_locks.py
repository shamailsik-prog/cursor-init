"""Q03-NUMBERLESS-ID is OPEN-BY-DESIGN.

Characterisation only. ``preamble-`` and ``explanation-`` are in
``_NEVER_PAIR_PREFIXES``, so ``pairing_base`` returns None and a text change
retires the old key and inserts a new row. A later identity slice has to edit
these locks deliberately.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from test_f20_trust_policy_db import execute, fetch, run

ACT = "Q04 Synthetic Numberless Act"
SHORT = "q04num"
SOURCE_NAME = "PakistanCode"
T1 = "2026-11-01T00:00:00+00:00"
T2 = "2026-11-02T00:00:00+00:00"

TEXT_SECTION = "1. Q04 synthetic numberless section. This labelled test text is not statute wording."
TEXT_PREAMBLE = "Q04 synthetic preamble. This labelled test text is not statute wording."
TEXT_PREAMBLE_NEW = "Q04 synthetic preamble amended. This labelled test text is not statute wording."
TEXT_EXPLANATION = "Q04 synthetic explanation. This labelled test text is not statute wording."
TEXT_EXPLANATION_NEW = "Q04 synthetic explanation amended. This labelled test text is not statute wording."

VECTOR = "[" + ",".join(["0.1"] + ["0"] * 1535) + "]"
CHUNK_HASH = "cd" * 32


def _token(text: str) -> str:
    from scraper.parsers.pakistancode_keys import content_token

    return content_token(text)


def test_q04_numberless_apply_harvest_retires_and_inserts():
    """Q03-NUMBERLESS-ID is OPEN-BY-DESIGN: a changed preamble and explanation are not reused."""
    from scraper.parsers.pakistancode_keys import KeyedDiv, PublishedSection, apply_harvest

    old_preamble = f"preamble-{_token(TEXT_PREAMBLE)}"
    new_preamble = f"preamble-{_token(TEXT_PREAMBLE_NEW)}"
    old_explanation = f"explanation-{_token(TEXT_EXPLANATION)}"
    new_explanation = f"explanation-{_token(TEXT_EXPLANATION_NEW)}"
    stored_preamble = PublishedSection(
        key=old_preamble, text=TEXT_PREAMBLE, kind="preamble", lookup_number=None, versions=[TEXT_PREAMBLE],
    )
    stored_explanation = PublishedSection(
        key=old_explanation, text=TEXT_EXPLANATION, kind="explanation", lookup_number=None,
        versions=[TEXT_EXPLANATION],
    )
    stored_section = PublishedSection(
        key="1", text=TEXT_SECTION, kind="section", lookup_number="1", versions=[TEXT_SECTION],
    )
    store = {"1": stored_section, old_preamble: stored_preamble, old_explanation: stored_explanation}
    apply_harvest(store, [
        KeyedDiv(key="1", text=TEXT_SECTION, title=None, kind="section", lookup_number="1", schedule_label=None),
        KeyedDiv(
            key=new_preamble, text=TEXT_PREAMBLE_NEW, title=None, kind="preamble",
            lookup_number=None, schedule_label=None,
        ),
        KeyedDiv(
            key=new_explanation, text=TEXT_EXPLANATION_NEW, title=None, kind="explanation",
            lookup_number=None, schedule_label=None,
        ),
    ])
    assert store[old_preamble] is stored_preamble and stored_preamble.retired is True
    assert store[old_explanation] is stored_explanation and stored_explanation.retired is True
    assert store[new_preamble] is not stored_preamble
    assert store[new_explanation] is not stored_explanation
    assert store[new_preamble].text == TEXT_PREAMBLE_NEW and store[new_preamble].retired is False
    assert store[new_explanation].text == TEXT_EXPLANATION_NEW and store[new_explanation].retired is False
    assert store["1"] is stored_section and stored_section.retired is False


def _source_id():
    return uuid.UUID(str(run(fetch(
        "SELECT id FROM scraper_sources WHERE source_name = 'PakistanCode'"
    ))[0][0]))


def _wipe():
    run(execute(
        "DELETE FROM record_embedding_chunks WHERE record_id IN "
        "(SELECT id FROM statutes_master WHERE short_name = :s)",
        "DELETE FROM embedding_queue WHERE record_id IN "
        "(SELECT id FROM statutes_master WHERE short_name = :s)",
        "DELETE FROM embedding_attempts WHERE record_id IN "
        "(SELECT id FROM statutes_master WHERE short_name = :s)",
        "DELETE FROM statutes_staging WHERE extracted_short_name = :s",
        "DELETE FROM statutes_master WHERE short_name = :s",
        params={"s": SHORT},
    ))


def _staging(source_id, section, text, harvest_at, act_keys, kind):
    from scraper.models import StatutesStaging

    return StatutesStaging(
        source_id=source_id,
        source_site=SOURCE_NAME,
        source_url="https://q04.example.invalid/numberless",
        extracted_act_name=ACT,
        extracted_short_name=SHORT,
        extracted_section_number=section,
        extracted_section_title="Q04 synthetic",
        extracted_section_text=text,
        raw_text=text,
        confidence_score=0.9,
        created_at=datetime(2026, 11, 1, tzinfo=timezone.utc),
        parsing_metadata={
            "act_keys": list(act_keys),
            "harvest_at": harvest_at,
            "keying": "q04",
            "source_name": SOURCE_NAME,
            "section_kind": kind,
        },
    )


def _publish(rows):
    from scraper.database import SessionLocal
    from scraper.publication.retrieval import publish_statute

    source = type("Src", (), {"source_name": SOURCE_NAME})()

    async def _go():
        async with SessionLocal() as db:
            async with db.begin():
                for row in rows:
                    db.add(row)
                await db.flush()
                for row in rows:
                    await publish_statute(db, row, source)
                return {row.extracted_section_number: row.id for row in rows}

    return run(_go())


def _plant(record_id):
    async def _go():
        from sqlalchemy import text

        from scraper.database import SessionLocal

        async with SessionLocal() as db:
            async with db.begin():
                await db.execute(
                    text("UPDATE statutes_master SET embedding = CAST(:vec AS vector) WHERE id = :id"),
                    {"vec": VECTOR, "id": record_id},
                )
                await db.execute(
                    text(
                        "INSERT INTO record_embedding_chunks ("
                        "table_name, record_id, chunk_index, chunk_spec_version, content_hash, "
                        "char_start, char_end, paragraph_start, paragraph_end, "
                        "embedding_model, embedding_dimensions, embedding) "
                        "VALUES ('statutes_master', :id, 0, 'q04', :content_hash, "
                        "0, 1, 0, 0, 'text-embedding-3-small', 1536, CAST(:vec AS vector))"
                    ),
                    {"id": record_id, "content_hash": CHUNK_HASH, "vec": VECTOR},
                )
                await db.execute(
                    text(
                        "INSERT INTO embedding_queue (record_id, table_name, status) "
                        "VALUES (:id, 'statutes_master', 'completed')"
                    ),
                    {"id": record_id},
                )

    run(_go())


def test_q04_numberless_publish_withdraws_and_inserts(corpus_db):
    """Q03-NUMBERLESS-ID is OPEN-BY-DESIGN: a preamble amendment is retire-and-insert, with no successor."""
    migrated = corpus_db.migrate()
    assert migrated.returncode == 0, migrated.stderr
    source_id = _source_id()
    _wipe()
    old_preamble = f"preamble-{_token(TEXT_PREAMBLE)}"
    new_preamble = f"preamble-{_token(TEXT_PREAMBLE_NEW)}"
    h1_keys = ["1", old_preamble]
    _publish([
        _staging(source_id, "1", TEXT_SECTION, T1, h1_keys, "section"),
        _staging(source_id, old_preamble, TEXT_PREAMBLE, T1, h1_keys, "preamble"),
    ])
    stored = {row[1]: row for row in run(fetch(
        "SELECT id, section_number, is_repealed FROM statutes_master WHERE short_name = :s",
        s=SHORT,
    ))}
    preamble_id = stored[old_preamble][0]
    _plant(preamble_id)
    h2_keys = ["1", new_preamble]
    staged = _publish([
        _staging(source_id, "1", TEXT_SECTION, T2, h2_keys, "section"),
        _staging(source_id, new_preamble, TEXT_PREAMBLE_NEW, T2, h2_keys, "preamble"),
    ])
    rows = run(fetch(
        "SELECT id, section_number, section_text, is_repealed, embedding IS NULL "
        "FROM statutes_master WHERE short_name = :s",
        s=SHORT,
    ))
    by_key = {row[1]: row for row in rows}
    assert by_key[old_preamble][0] == preamble_id
    assert by_key[old_preamble][3] is True
    assert by_key[old_preamble][4] is True
    assert by_key[new_preamble][0] != preamble_id
    assert by_key[new_preamble][2] == TEXT_PREAMBLE_NEW
    assert by_key[new_preamble][3] is False
    chunks = run(fetch(
        "SELECT count(*) FROM record_embedding_chunks WHERE record_id = :id",
        id=preamble_id,
    ))
    assert chunks[0][0] == 0
    for staging_id in staged.values():
        meta = run(fetch(
            "SELECT parsing_metadata FROM statutes_staging WHERE id = :id",
            id=staging_id,
        ))[0][0] or {}
        assert "identity_successor_of" not in meta
