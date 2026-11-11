"""DATA-003-REHARVEST against Postgres.

The apply guard is a DO block. ``CASE ... ELSE 1/0`` is constant-folded and
raises when the row matches, so these tests run the generated SQL. The CLI is
not involved and nothing here opens the application's live database. The
``corpus_db`` fixture supplies the CI service database.
"""

from __future__ import annotations

import asyncio

import asyncpg
from sqlalchemy.engine import make_url

from scraper.reharvest.data_003 import (
    RekeyAction,
    _statements,
    count_sql,
    guard_apply,
    plan_rows,
    render_apply_sql,
    render_rollback_sql,
    render_rowcount_guard,
    select_act_sql,
    text_md5,
)

TEXT = (
    "12-A. Inserted rates. The inserted rates in this section apply to "
    "instruments presented after the amendment."
)
ROW_ID = "00000000-0000-4000-8000-0000000000a1"
MISSING_ID = "00000000-0000-4000-8000-0000000000ff"


def _pg_url(corpus_db) -> str:
    return make_url(corpus_db.url).set(drivername="postgresql").render_as_string(hide_password=False)


def _create(corpus_db) -> None:
    corpus_db.admin(
        """CREATE TABLE statutes_master (
            id uuid PRIMARY KEY,
            short_name text,
            statute_name text,
            section_number varchar(100),
            section_title text,
            section_text text,
            created_at timestamptz NOT NULL DEFAULT now()
        )""",
        """CREATE TABLE statutes_staging (
            id uuid PRIMARY KEY,
            extracted_short_name text,
            extracted_act_name text,
            extracted_section_number varchar(200),
            extracted_section_title text,
            extracted_section_text text,
            raw_text text,
            parsing_metadata jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
        )""",
    )


def _insert(corpus_db) -> None:
    digest_text = TEXT.replace("'", "''")
    corpus_db.admin(
        "INSERT INTO statutes_master (id, short_name, statute_name, section_number, section_title, section_text) VALUES "
        f"('{ROW_ID}', 'ord-act', 'ord-act', '12', '', '{digest_text}'),"
        f"('00000000-0000-4000-8000-0000000000a2', 'page-act', 'page-act', '12', '', '{digest_text}'),"
        f"('00000000-0000-4000-8000-0000000000a3', 'keys-act', 'keys-act', '12', '', '{digest_text}'),"
        f"('00000000-0000-4000-8000-0000000000a4', 'bare-act', 'bare-act', '12', '', '{digest_text}'),"
        f"('00000000-0000-4000-8000-0000000000a5', 'split-act', 'split-act', '12', '', '{digest_text}')",
        "INSERT INTO statutes_staging (id, extracted_short_name, extracted_act_name, extracted_section_number, "
        "extracted_section_text, parsing_metadata, created_at) VALUES "
        f"('00000000-0000-4000-8000-0000000000b1', 'ord-act', 'ord-act', '12', '{digest_text}', "
        "'{\"source_ordinal\": \"3\", \"page_offset\": \"9\", \"act_keys\": [\"11\", \"12\"]}'::jsonb, "
        "'2020-01-01T00:00:00Z'),"
        f"('00000000-0000-4000-8000-0000000000b2', 'page-act', 'page-act', '12', '{digest_text}', "
        "'{\"page_offset\": \"7\"}'::jsonb, '1999-01-01T00:00:00Z'),"
        f"('00000000-0000-4000-8000-0000000000b3', 'keys-act', 'keys-act', '12', '{digest_text}', "
        "'{\"act_keys\": [\"11\", \"12\"]}'::jsonb, '2024-01-01T00:00:00Z'),"
        f"('00000000-0000-4000-8000-0000000000b4', 'split-act', 'split-act', '12', '{digest_text}', "
        "'{\"source_ordinal\": \"1\"}'::jsonb, '1999-01-01T00:00:00Z'),"
        f"('00000000-0000-4000-8000-0000000000b5', 'split-act', 'split-act', '12', '{digest_text}', "
        "'{\"source_ordinal\": \"4\"}'::jsonb, '2024-06-01T00:00:00Z')",
        "INSERT INTO statutes_master (id, short_name, statute_name, section_number, section_text, created_at) VALUES "
        "('00000000-0000-4000-8000-0000000000c1', 'dup', 'dup', '12', 'same body', '1999-01-01T00:00:00Z'),"
        "('00000000-0000-4000-8000-0000000000c2', 'dup', 'dup', '12', 'same body', '2024-01-01T00:00:00Z')",
    )


async def _fetch(conn, sql):
    return await conn.fetch(sql)


async def _execute_script(conn, script: str) -> bool:
    try:
        await conn.execute(script)
    except asyncpg.PostgresError as exc:
        if "expected 1 row" not in str(exc):
            raise
        return False
    return True


def _script(*statements: str) -> str:
    lines = ["BEGIN;"]
    lines.extend(statement if statement.endswith(";") else statement + ";" for statement in statements)
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


async def _rollback_quiet(conn) -> None:
    try:
        await conn.execute("ROLLBACK")
    except asyncpg.PostgresError:
        pass


async def _key(conn, row_id: str) -> str:
    return await conn.fetchval("SELECT section_number FROM statutes_master WHERE id = $1", row_id)


async def _run(url: str) -> None:
    conn = await asyncpg.connect(url)
    try:
        stored = await conn.fetchval("SELECT md5(convert_to(section_text, 'UTF8')) FROM statutes_master WHERE id = $1", ROW_ID)
        assert stored == text_md5(TEXT)
        master_sql, staging_sql = _statements(select_act_sql())
        exported = {row["short_name"]: row for row in await conn.fetch(master_sql)}
        assert exported["ord-act"]["ordinal"] == 3
        assert exported["page-act"]["ordinal"] == 7
        assert exported["keys-act"]["ordinal"] == 2
        assert exported["bare-act"]["ordinal"] is None
        assert exported["split-act"]["ordinal"] is None
        assert "dup" not in exported
        staged = {row["short_name"]: row["ordinal"] for row in await conn.fetch(staging_sql)}
        assert staged["ord-act"] == 3
        stale = {row["act"]: row["stale_12"] for row in await conn.fetch(_statements(count_sql())[2])}
        assert stale["ord-act"] == 1
        assert stale["bare-act"] == 1
        assert "dup" not in stale
        bare = dict(exported["bare-act"])
        bare["ordinal"] = None
        refused = plan_rows([bare])[0]
        assert refused.apply_allowed is False
        assert refused.refusal == "no trustworthy source ordinal"
        live = dict(exported["ord-act"])
        _plans, actions, siblings = guard_apply([live], [live], expect_count=1, ids=[ROW_ID])
        assert actions[0].old_key == "12" and actions[0].new_key == "12A"
        before = await conn.fetchrow(
            "SELECT section_number, section_text FROM statutes_master WHERE id = $1", ROW_ID,
        )
        assert await _execute_script(conn, render_apply_sql(actions, siblings)) is True
        assert await _key(conn, ROW_ID) == "12A"
        assert await conn.fetchval("SELECT section_text FROM statutes_master WHERE id = $1", ROW_ID) == TEXT
        assert await _execute_script(conn, render_rollback_sql(actions, siblings)) is True
        restored = await conn.fetchrow(
            "SELECT section_number, section_text FROM statutes_master WHERE id = $1", ROW_ID,
        )
        assert restored["section_number"] == before["section_number"] == "12"
        assert restored["section_text"] == before["section_text"] == TEXT

        digest = text_md5(TEXT)
        good = render_rowcount_guard(
            "UPDATE statutes_master SET section_number = '12A' "
            f"WHERE id = '{ROW_ID}' AND section_number = '12' "
            f"AND md5(convert_to(section_text, 'UTF8')) = '{digest}'"
        )
        missing = render_rowcount_guard(
            "UPDATE statutes_master SET section_number = '12A' "
            f"WHERE id = '{MISSING_ID}' AND section_number = '12' "
            f"AND md5(convert_to(section_text, 'UTF8')) = '{digest}'"
        )
        wrong_md5 = render_rowcount_guard(
            "UPDATE statutes_master SET section_number = '12A' "
            f"WHERE id = '{ROW_ID}' AND section_number = '12' "
            "AND md5(convert_to(section_text, 'UTF8')) = '00000000000000000000000000000000'"
        )
        two = render_rowcount_guard(
            "UPDATE statutes_master SET section_number = '12A' "
            "WHERE section_number = '12' AND section_text = 'same body' "
            f"AND md5(convert_to(section_text, 'UTF8')) = '{text_md5('same body')}'"
        )
        for bad in (missing, wrong_md5, two):
            assert await _execute_script(conn, _script(good, bad)) is False
            await _rollback_quiet(conn)
            assert await _key(conn, ROW_ID) == "12"
            assert await _key(conn, "00000000-0000-4000-8000-0000000000c1") == "12"
            assert await _key(conn, "00000000-0000-4000-8000-0000000000c2") == "12"
        alone = await _execute_script(conn, _script(good))
        assert alone is True
        assert await _key(conn, ROW_ID) == "12A"
    finally:
        await conn.close()


def test_postgres_apply_commits_one_row_and_aborts_the_transaction(corpus_db):
    _create(corpus_db)
    _insert(corpus_db)
    asyncio.run(_run(_pg_url(corpus_db)))


def test_a_rekey_action_round_trips_through_the_same_guard():
    """The production apply statement is the DO block, including a metadata write."""
    action = RekeyAction(
        id=ROW_ID, table="statutes_staging", act="ord-act", old_key="12", new_key="12A",
        text_md5=text_md5(TEXT), section_text=TEXT, act_keys=("12A",), prior_act_keys=("12",),
    )
    sql = render_apply_sql([action])
    assert "GET DIAGNOSTICS n = ROW_COUNT" in sql
    assert "1/0" not in sql
    assert sql.count("DO $data003$") == 2
