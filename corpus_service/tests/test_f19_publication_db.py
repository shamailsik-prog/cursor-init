"""Audit F19 end to end against real Postgres 16 + pgvector: publication into the Annex A contract.

Everything runs through the application's own code (``scraper.publication``) and the shipped DDL
(postgres/ddl/001_corpus_contract.sql + 003_corpus_publication.sql, applied by the admin as the
postgres init script does). Publishing runs as generated login roles that reach ``corpus_writer`` by
SET ROLE only, as PR 2b provisions the runtime role; reading runs as a ``corpus_reader`` member
through the promoted-only ``v_*`` views.

The expected values come from the spec (docs/superpowers/specs/2026-10-14-f05-f19-f20-authority-
corpus-design.md §5) and the plan's decisions, not from the code under test. Every citation is
synthetic (2099) and every statute is "Test Act 2099"; no real authority is named.

Needs CORPUS_TEST_DATABASE_URL (see conftest.py); every test gets a fresh database.
"""

import asyncio
import json
import re
from pathlib import Path

import pytest

PROVENANCE = {
    "source_name": "f19-curated-test",
    "source_url": "https://f19.example.invalid/judgment",
    "raw_storage_key": None,
    "fetched_at": "2099-01-02T03:04:05Z",
    "content_hash": "a" * 64,
    "extraction_method": "manual",
    "extractor_version": "f19-test-1",
}
ANNEX_A_TABLES = (
    "source_provenance", "court", "judge", "instrument", "statute", "statute_section", "statute_section_version",
    "judgment", "citation", "treatment", "corpus_publication", "corpus_publication_item", "corpus_publication_grant",
    "corpus_metadata",
)
COUNT_KEYS = ("items", "promoted", "quarantined", "updated", "unchanged", "rejected")


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
def run(coro):
    return asyncio.run(coro)


def sqlstate(exc):
    for candidate in (getattr(exc, "orig", None), getattr(getattr(exc, "orig", None), "__cause__", None), exc):
        code = getattr(candidate, "sqlstate", None) or getattr(candidate, "pgcode", None)
        if code:
            return code
    return None


def counts(**nonzero):
    return {key: nonzero.get(key, 0) for key in COUNT_KEYS}


def parts(reporter, page, court=None, series=None, note=None):
    return {"parts": {"reporter": reporter, "year": "2099", "page": str(page), "court": court, "series": series, "note": note}}


def judgment_item(item_key="j1", *, citations=None, bench="D.B.", trust=("trusted", 0.9), provenance=None, **fields):
    item = {
        "kind": "judgment",
        "item_key": item_key,
        "trust": {"level": trust[0], "confidence": trust[1]},
        "provenance": dict(PROVENANCE if provenance is None else provenance),
        "citations": citations if citations is not None else [parts("PLD", 12, court="Karachi")],
        "case_title": f"F19 {item_key} v. Test 2099",
        "bench_type": bench,
        "full_text": f"synthetic F19 fixture text {item_key}",
    }
    item.update(fields)
    return item


def batch_doc(batch_key, *items, source_kind="curated"):
    return {"format": "corpus-publication-batch/1", "batch_key": batch_key, "source_kind": source_kind, "items": list(items)}


def parse(doc):
    from scraper.publication.batch import parse_batch_json

    return parse_batch_json(json.dumps(doc).encode("utf-8"))


async def _publish(batch, actor):
    from scraper import database
    from scraper.publication.annex_a import publish_batch

    async with database.engine.begin() as conn:
        return await publish_batch(conn, batch, actor)


def publish(doc, actor="f19-test-actor"):
    return run(_publish(parse(doc), actor))


async def _publish_then_whoami(batch, actor):
    """publish_batch, then the role the caller's transaction is left with (D14: restored)."""
    from sqlalchemy import text

    from scraper import database
    from scraper.publication.annex_a import publish_batch

    async with database.engine.begin() as conn:
        result = await publish_batch(conn, batch, actor)
        who = (await conn.execute(text("SELECT current_user, session_user, current_setting('role')"))).one()
        return result, tuple(who)


async def _fetch_as(db, url, sql, params):
    from sqlalchemy import text

    engine = db.engine_for(url)
    try:
        async with engine.connect() as conn:
            return (await conn.execute(text(sql), params)).all()
    finally:
        await engine.dispose()


def admin_fetch(db, sql, **params):
    return run(_fetch_as(db, db.url, sql, params))


def fetch_as(db, user, password, sql, **params):
    return run(_fetch_as(db, db.url_as(user, password), sql, params))


def refused_as(db, user, password, sql, **params):
    try:
        fetch_as(db, user, password, sql, **params)
    except Exception as exc:  # noqa: BLE001 - classified by SQLSTATE
        return sqlstate(exc)
    return "SUCCEEDED"


def snapshot(db):
    return {table: admin_fetch(db, f"SELECT * FROM {table} ORDER BY 1") for table in ANNEX_A_TABLES}


def prepare(db):
    """Annex A as postgres init applies it (superuser), then the app's own migrate step."""
    db.apply_annex_a()
    proc = db.migrate()
    assert proc.returncode == 0, f"scraper.migrate failed:\n{proc.stdout}\n{proc.stderr[-4000:]}"


def literals(condef):
    return tuple(re.findall(r"'([^']*)'", condef))


# ---------------------------------------------------------------------------------------------
# the vocabulary and the inventory match the DDL
# ---------------------------------------------------------------------------------------------
def test_f19_vocabulary_matches_the_ddl_checks(corpus_db):
    from scraper.publication import vocabulary as v

    corpus_db.apply_annex_a()

    def check_on(table, column, name=None):
        rows = admin_fetch(
            corpus_db,
            "SELECT c.conname, pg_get_constraintdef(c.oid) FROM pg_constraint c "
            "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) "
            "WHERE c.conrelid = CAST(:t AS regclass) AND c.contype = 'c' AND a.attname = :col",
            t=f"public.{table}", col=column,
        )
        if name is not None:
            rows = [r for r in rows if r[0] == name]
        assert len(rows) == 1, (table, column, rows)
        return literals(rows[0][1])

    assert check_on("judgment", "bench_type") == v.BENCH_TYPES
    assert check_on("treatment", "treatment") == v.TREATMENT_KINDS
    assert check_on("treatment", "treating_bench_type", "treatment_treating_bench_type_check") == v.BENCH_TYPES
    assert check_on("statute", "jurisdiction", "statute_jurisdiction_annex_a_check") == v.JURISDICTIONS
    assert check_on("source_provenance", "extraction_method") == v.EXTRACTION_METHODS


def test_f19_contract_inventory_lists_every_annex_a_relation(corpus_db):
    corpus_db.apply_annex_a()  # a fresh database with only 001 + 003 (no migrate)
    relations = {
        r[0] for r in admin_fetch(
            corpus_db,
            "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')",
        )
    }
    inventory = [r[0] for r in admin_fetch(corpus_db, "SELECT CAST(r AS text) FROM corpus_contract_relations() AS r")]
    assert len(inventory) == 29 and len(set(inventory)) == 29
    assert relations == set(inventory)


# ---------------------------------------------------------------------------------------------
# judgments, citations, provenance and the audit
# ---------------------------------------------------------------------------------------------
def test_f19_publish_batch_judgments_citations_and_audit(corpus_db):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    doc = batch_doc("curated/f19-t5-audit", judgment_item("j1", citations=[parts("PLD", 12, court="Karachi")], bench="D.B."))
    with corpus_db.app_engine_as(writer, writer_pw):
        result, who = run(_publish_then_whoami(parse(doc), "f19-test-actor"))
    # The caller's transaction keeps its own role afterwards (SET LOCAL ROLE restored, D14).
    assert who == (writer, writer, "none")

    assert result.already is False and result.batch_key == "curated/f19-t5-audit"
    assert re.fullmatch(r"[0-9a-f]{64}", result.input_sha256)
    assert result.counts == counts(items=1, promoted=2)
    primary = result.primary("j1")
    assert (primary.entity_type, primary.decision, primary.review_status) == ("judgment", "promoted", "promoted")

    judgments = admin_fetch(corpus_db, "SELECT id, review_status, bench_type, publication_id, source_id, classification FROM judgment")
    assert len(judgments) == 1
    jid, status, bench, pub_id, source_id, classification = judgments[0]
    assert (jid, status, bench, pub_id) == (primary.entity_id, "promoted", "division", result.publication_id)
    assert classification == "public"  # D13: never set by the ETL

    citations = admin_fetch(corpus_db, "SELECT citation_text, judgment_id, review_status, reporter, year, volume_or_court, page, source_id, publication_id FROM citation")
    assert citations == [("PLD 2099 Sindh 12", jid, "promoted", "PLD", 2099, "Sindh", 12, source_id, result.publication_id)]

    provenance = admin_fetch(
        corpus_db,
        "SELECT id, source_name, source_url, raw_storage_key, fetched_at, content_hash, extraction_method, "
        "extractor_version, publication_id FROM source_provenance",
    )
    assert len(provenance) == 1
    assert provenance[0][0] == source_id
    assert provenance[0][1:4] == ("f19-curated-test", "https://f19.example.invalid/judgment", None)
    assert provenance[0][4].isoformat() == "2099-01-02T03:04:05+00:00"
    assert provenance[0][5:] == ("a" * 64, "manual", "f19-test-1", result.publication_id)

    pubs = admin_fetch(
        corpus_db,
        "SELECT id, seq, source_kind, actor_id, publisher_session_user, finished_at, item_count, promoted_count, "
        "quarantined_count, updated_count, unchanged_count, rejected_count FROM corpus_publication",
    )
    assert len(pubs) == 1
    pid, seq, kind, actor, publisher, finished, *stored_counts = pubs[0]
    assert (pid, seq, kind, actor, publisher) == (result.publication_id, result.seq, "curated", "f19-test-actor", writer)
    assert finished is not None and stored_counts == [1, 2, 0, 0, 0, 0]
    items = admin_fetch(
        corpus_db,
        "SELECT item_key, entity_type, entity_id, decision, reason, prev_sha256 FROM corpus_publication_item ORDER BY id",
    )
    assert [(i[0], i[1], i[3], i[4], i[5]) for i in items] == [
        ("j1", "judgment", "promoted", None, None), ("j1", "citation", "promoted", None, None)]
    assert items[0][2] == jid
    meta = dict(admin_fetch(corpus_db, "SELECT key, value FROM corpus_metadata"))
    assert meta["publication_contract"] == "1" and meta["publication_seq"] == str(seq)
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z", meta["last_refresh"])
    assert admin_fetch(corpus_db, "SELECT count(*) FROM corpus_publication_grant") == [(0,)]

    reader, reader_pw = corpus_db.reader_role()
    seen = fetch_as(
        corpus_db, reader, reader_pw,
        "SELECT j.id, j.bench_type, c.citation_text FROM v_judgment j JOIN v_citation c ON c.judgment_id = j.id",
    )
    assert seen == [(jid, "division", "PLD 2099 Sindh 12")]
    for table in ("judgment", "citation", "corpus_publication", "corpus_publication_item", "corpus_publication_grant"):
        assert refused_as(corpus_db, reader, reader_pw, f"SELECT 1 FROM {table}") == "42501", table


def test_f19_publish_batch_is_idempotent_and_refuses_a_reused_key(corpus_db):
    from scraper.publication.annex_a import PublicationError

    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    doc = batch_doc(
        "curated/f19-t5-idem",
        judgment_item("j1", citations=[parts("PLD", 1, court="SC"), {"text": "2099 SCMR 1"}]),
        judgment_item("j2", citations=[{"text": "PLD 2099 Atlantis 1"}]),
    )
    with corpus_db.app_engine_as(writer, writer_pw):
        first = publish(doc)
        before = snapshot(corpus_db)
        again = publish(doc)
        assert again.already is True
        assert (again.publication_id, again.seq, again.counts) == (first.publication_id, first.seq, first.counts)
        assert [(o.item_key, o.entity_type, o.entity_id, o.decision, o.reason, o.review_status) for o in again.outcomes] == [
            (o.item_key, o.entity_type, o.entity_id, o.decision, o.reason, o.review_status) for o in first.outcomes]
        assert snapshot(corpus_db) == before  # nothing written, last_refresh untouched (D30)

        changed = json.loads(json.dumps(doc))
        changed["items"][0]["full_text"] = "changed synthetic F19 text"
        with pytest.raises(PublicationError) as refused:
            publish(changed)
        assert refused.value.code == "batch_key_reused"
        assert snapshot(corpus_db) == before


def test_f19_citation_conflict_is_rejected(corpus_db):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    with corpus_db.app_engine_as(writer, writer_pw):
        published = publish(batch_doc(
            "curated/f19-t5-conflict-1",
            judgment_item("j1", citations=[{"text": "2099 SCMR 1"}]),
            judgment_item("j2", citations=[{"text": "2099 SCMR 2"}]),
        ))
        before = admin_fetch(corpus_db, "SELECT * FROM judgment ORDER BY id"), admin_fetch(corpus_db, "SELECT * FROM citation ORDER BY id")
        result = publish(batch_doc(
            "curated/f19-t5-conflict-2",
            judgment_item("both", citations=[{"text": "2099 SCMR 1"}, {"text": "2099 SCMR 2"}], full_text="merged?"),
        ))
    assert published.counts == counts(items=2, promoted=4)
    outcome = result.primary("both")
    assert (outcome.decision, outcome.reason, outcome.entity_id) == ("rejected", "citation_conflict", None)
    assert result.counts == counts(items=1, rejected=1)
    after = admin_fetch(corpus_db, "SELECT * FROM judgment ORDER BY id"), admin_fetch(corpus_db, "SELECT * FROM citation ORDER BY id")
    assert after == before


def test_f19_republishing_a_changed_judgment_records_the_previous_hash(corpus_db):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    item = judgment_item("j", citations=[{"text": "2099 SCMR 7"}])
    with corpus_db.app_engine_as(writer, writer_pw):
        k1 = publish(batch_doc("curated/f19-t5-k1", item))
        changed = {**item, "full_text": "amended synthetic F19 text",
                   "provenance": {**PROVENANCE, "content_hash": "b" * 64, "fetched_at": "2099-02-02T00:00:00Z"}}
        k2 = publish(batch_doc("curated/f19-t5-k2", changed))
        state_k2 = admin_fetch(corpus_db, "SELECT id, source_id, publication_id, updated_at, review_status FROM judgment")
        # identical content (a re-fetch: only fetched_at differs) -> unchanged
        k3 = publish(batch_doc("curated/f19-t5-k3", {**changed, "provenance": {**changed["provenance"], "fetched_at": "2099-03-03T00:00:00Z"}}))
        state_k3 = admin_fetch(corpus_db, "SELECT id, source_id, publication_id, updated_at, review_status FROM judgment")
        k4 = publish(batch_doc("curated/f19-t5-k4", {**changed, "trust": {"level": "review", "confidence": 0.9}}))
        state_k4 = admin_fetch(corpus_db, "SELECT id, source_id, publication_id, updated_at, review_status FROM judgment")

    j1, j2, j3, j4 = (r.primary("j") for r in (k1, k2, k3, k4))
    assert j1.decision == "promoted"
    assert (j2.decision, j2.prev_sha256, j2.entity_id) == ("updated", j1.content_sha256, j1.entity_id)
    assert j2.content_sha256 != j1.content_sha256
    assert len(state_k2) == 1
    jid, source_k2, pub_k2, updated_k2, status_k2 = state_k2[0]
    assert (pub_k2, status_k2) == (k2.publication_id, "promoted")
    provenance = admin_fetch(corpus_db, "SELECT id, content_hash, publication_id FROM source_provenance ORDER BY created_at, id")
    assert len(provenance) == 2  # the old provenance row remains
    assert {p[2] for p in provenance} == {k1.publication_id, k2.publication_id}
    assert source_k2 == next(p[0] for p in provenance if p[2] == k2.publication_id)

    assert (j3.decision, j3.prev_sha256, j3.content_sha256) == ("unchanged", j2.content_sha256, j2.content_sha256)
    assert state_k3 == state_k2  # no write: same source, publication and updated_at
    assert admin_fetch(corpus_db, "SELECT count(*) FROM source_provenance") == [(2,)]

    assert (j4.decision, j4.reason, j4.entity_id, j4.review_status) == ("rejected", "promoted_row_protected", jid, "promoted")
    assert state_k4 == state_k2
    assert k4.counts == counts(items=1, rejected=1)


def _install_fault_trigger(db):
    db.admin(
        """CREATE OR REPLACE FUNCTION f19_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.case_title = 'F19 fault 2099' THEN
               RAISE EXCEPTION 'f19 marker %', NEW.case_title USING ERRCODE = '23514';
             END IF;
             RETURN NEW;
           END $$""",
        "CREATE TRIGGER f19_test_fault BEFORE INSERT OR UPDATE ON judgment FOR EACH ROW EXECUTE FUNCTION f19_test_fault()",
    )


def _remove_fault_trigger(db):
    db.admin("DROP TRIGGER f19_test_fault ON judgment", "DROP FUNCTION f19_test_fault()")


def test_f19_failure_mid_batch_rolls_back_the_whole_publication(corpus_db):
    from sqlalchemy.exc import IntegrityError

    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    _install_fault_trigger(corpus_db)
    doc = batch_doc(
        "curated/f19-t5-fault",
        judgment_item("i1", citations=[{"text": "2099 SCMR 31"}]),
        judgment_item("i2", citations=[{"text": "2099 SCMR 32"}]),
        judgment_item("i3", citations=[{"text": "2099 SCMR 33"}], case_title="F19 fault 2099"),
        judgment_item("i4", citations=[{"text": "2099 SCMR 34"}]),
    )
    empty = snapshot(corpus_db)
    with corpus_db.app_engine_as(writer, writer_pw):
        with pytest.raises(IntegrityError) as failed:
            publish(doc)
        assert sqlstate(failed.value) == "23514"
        assert snapshot(corpus_db) == empty  # no publication row, no items, no contract rows, no grant
        _remove_fault_trigger(corpus_db)
        result = publish(doc)  # the batch_key was not consumed
    assert result.already is False and result.counts == counts(items=4, promoted=8)


def test_f19_publication_refuses_superuser_and_non_writer_sessions(corpus_db):
    from scraper import database
    from scraper.publication.annex_a import PublicationError, publish_batch

    prepare(corpus_db)
    batch = parse(batch_doc("curated/f19-t5-refuse", judgment_item("j1")))

    # The fixture's own engine is the admin (a superuser): refused before any write (D2).
    with pytest.raises(PublicationError) as superuser:
        run(_publish(batch, "f19-test-actor"))
    assert superuser.value.code == "superuser_session"

    nobody, nobody_pw = corpus_db.create_role("f19_none")
    with corpus_db.app_engine_as(nobody, nobody_pw):
        with pytest.raises(PublicationError) as not_writer:
            run(_publish(batch, "f19-test-actor"))
    assert not_writer.value.code == "not_corpus_writer"

    writer, writer_pw = corpus_db.writer_role()
    with corpus_db.app_engine_as(writer, writer_pw):
        async def _outside():
            async with database.engine.connect() as conn:
                return await publish_batch(conn, batch, "f19-test-actor")

        with pytest.raises(PublicationError) as outside:
            run(_outside())
    assert outside.value.code == "transaction_required"
    assert admin_fetch(corpus_db, "SELECT count(*) FROM corpus_publication") == [(0,)]
    assert admin_fetch(corpus_db, "SELECT count(*) FROM judgment") == [(0,)]


def test_f19_writer_cannot_bypass_the_publication(corpus_db):
    from sqlalchemy import text

    from scraper import database

    prepare(corpus_db)
    app, app_pw = corpus_db.runtime_role()

    async def attempt(*statements, set_role=True):
        try:
            async with database.engine.begin() as conn:
                if set_role:
                    await conn.execute(text("SET LOCAL ROLE corpus_writer"))
                for sql in statements:
                    await conn.execute(text(sql))
        except Exception as exc:  # noqa: BLE001 - classified by SQLSTATE
            return sqlstate(exc)
        return "SUCCEEDED"

    provenance = (
        "INSERT INTO source_provenance (id, source_name, source_url, fetched_at, content_hash, extraction_method) "
        "VALUES ('00000000-0000-4000-8000-0000000f1901', 'f19', 'https://f19.example.invalid/x', now(), 'h', 'manual')"
    )
    promoted = (
        "INSERT INTO judgment (case_title, bench_type, source_id, review_status) "
        "VALUES ('F19 bypass 2099', 'division', '00000000-0000-4000-8000-0000000f1901', 'promoted')"
    )
    with corpus_db.app_engine_as(app, app_pw):
        # Without SET ROLE the runtime role holds no Annex A privilege at all (INHERIT FALSE).
        assert run(attempt("SELECT 1 FROM judgment", set_role=False)) == "42501"
        assert run(attempt(provenance, set_role=False)) == "42501"
        # As corpus_writer, outside a publication, promotion is refused by the guard.
        assert run(attempt(provenance, promoted)) == "SKP02"
        assert run(attempt("INSERT INTO corpus_publication_grant (xid, publication_id) "
                           "VALUES (txid_current(), gen_random_uuid())")) == "42501"
        assert run(attempt("UPDATE corpus_publication SET actor_id = 'x'")) == "42501"
        assert run(attempt("DELETE FROM judgment")) == "42501"
        # The runtime role still has its own tables.
        assert run(attempt("SELECT count(*) FROM scraper_staging", set_role=False)) == "SUCCEEDED"
    assert admin_fetch(corpus_db, "SELECT count(*) FROM judgment") == [(0,)]


# ---------------------------------------------------------------------------------------------
# treatments (B-7) and statute section histories (B-5)
# ---------------------------------------------------------------------------------------------
def treatment_item(item_key, *, treating="PLD 2099 SC 1", treated="2099 SCMR 2", kind="Overruled", confidence=0.9,
                   bench="larger", anchor=None, trust=("trusted", 0.9), provenance=None):
    ref = lambda r: r if isinstance(r, dict) else {"citation": r}  # noqa: E731
    return {
        "kind": "treatment", "item_key": item_key,
        "trust": {"level": trust[0], "confidence": trust[1]},
        "provenance": dict(PROVENANCE if provenance is None else provenance),
        "treating": ref(treating), "treated": ref(treated), "treatment": kind,
        "passage_anchor": anchor, "treating_bench_type": bench, "confidence": confidence,
    }


def version(no, start, end, text=None, confidence=0.9, title=None):
    return {"version_no": no, "effective_from": start, "effective_to": end, "title": title,
            "text": text or f"Test Act 2099 section text v{no}", "version_confidence": confidence}


def history_item(item_key, *versions, section="5", statute="Test Act 2099", jurisdiction="Federal", status=None,
                 history="amendment_history", trust=("trusted", 0.9), provenance=None):
    return {
        "kind": "statute_section_history", "item_key": item_key,
        "trust": {"level": trust[0], "confidence": trust[1]},
        "provenance": dict(PROVENANCE if provenance is None else provenance),
        "statute": {"name": statute, "short_name": "TA 2099", "year_enacted": 2099, "jurisdiction": jurisdiction,
                    "status": status},
        "section": {"section_number": section, "chapter": "II", "current_title": f"Test section {section}"},
        "history": history,
        "versions": list(versions),
    }


def _two_judgments():
    return publish(batch_doc(
        "curated/f19-t6-judgments",
        judgment_item("j1", citations=[parts("PLD", 1, court="SC")], bench="larger"),
        judgment_item("j2", citations=[{"text": "2099 SCMR 2"}], bench="division"),
    ))


def test_f19_treatments_follow_the_b7_rules(corpus_db):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    with corpus_db.app_engine_as(writer, writer_pw):
        judgments = _two_judgments()
        result = publish(batch_doc(
            "curated/f19-t6-treatments",
            treatment_item("t-ok"),
            treatment_item("t-low", kind="followed", confidence=0.6),
            treatment_item("t-kind", kind="reversed", anchor="para 3"),
            treatment_item("t-unresolved", treated="2099 SCMR 999", anchor="para 4"),
            treatment_item("t-panel", bench="panel", anchor="para 5"),
            treatment_item("t-no-bench", kind="distinguished", bench=None),
            treatment_item("t-review", kind="applied", trust=("review", 0.99)),
            treatment_item("t-no-provenance", kind="doubted", provenance={}),
        ))
    j1 = judgments.primary("j1").entity_id
    j2 = judgments.primary("j2").entity_id
    keys = ("t-ok", "t-low", "t-kind", "t-unresolved", "t-panel", "t-no-bench", "t-review", "t-no-provenance")
    got = {key: (result.primary(key).decision, result.primary(key).reason) for key in keys}
    assert got == {
        "t-ok": ("promoted", None),
        "t-low": ("quarantined", "treatment_uncertain"),
        "t-kind": ("rejected", "invalid_treatment_kind"),
        "t-unresolved": ("rejected", "unresolvable_judgment"),
        "t-panel": ("rejected", "invalid_bench"),
        "t-no-bench": ("quarantined", "missing_bench"),
        "t-review": ("quarantined", "review_source"),
        "t-no-provenance": ("rejected", "provenance_incomplete"),
    }
    assert result.counts == counts(items=8, promoted=1, quarantined=3, rejected=4)
    stored = admin_fetch(
        corpus_db,
        "SELECT treating_judgment_id, treated_judgment_id, treatment, treating_bench_type, confidence, review_status "
        "FROM treatment ORDER BY review_status, treatment",
    )
    assert stored == [
        (j1, j2, "overruled", "larger", 0.9, "promoted"),
        (j1, j2, "applied", "larger", 0.9, "quarantined"),
        (j1, j2, "distinguished", None, 0.9, "quarantined"),
        (j1, j2, "followed", "larger", 0.6, "quarantined"),
    ]
    reader, reader_pw = corpus_db.reader_role()
    seen = fetch_as(corpus_db, reader, reader_pw, "SELECT treated_judgment_id, treatment, treating_bench_type FROM v_treatment")
    assert seen == [(j2, "overruled", "larger")]


def test_f19_treatment_refs_by_item_key_resolve_inside_the_batch(corpus_db):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    with corpus_db.app_engine_as(writer, writer_pw):
        result = publish(batch_doc(
            "curated/f19-t6-item-refs",
            treatment_item("t", treating={"item_key": "a"}, treated={"item_key": "b"}),
            judgment_item("a", citations=[{"text": "2099 SCMR 61"}], bench="full"),
            judgment_item("b", citations=[{"text": "2099 SCMR 62"}], bench="single"),
            judgment_item("bad", citations=[{"text": "2099 SCMR 63"}], bench="panel"),
            treatment_item("t-bad", treating={"item_key": "a"}, treated={"item_key": "bad"}),
        ))
    t = result.primary("t")
    assert (t.decision, t.review_status) == ("promoted", "promoted")
    assert admin_fetch(corpus_db, "SELECT treating_judgment_id, treated_judgment_id FROM treatment") == [
        (result.primary("a").entity_id, result.primary("b").entity_id)]
    assert (result.primary("t-bad").decision, result.primary("t-bad").reason) == ("rejected", "unresolvable_judgment")


def test_f19_statute_histories_follow_the_b5_rules(corpus_db):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    with corpus_db.app_engine_as(writer, writer_pw):
        result = publish(batch_doc(
            "curated/f19-t6-histories",
            history_item("h-ok", version(1, "2099-01-01", "2099-07-01"), version(2, "2099-07-01", None), section="5"),
            history_item("h-overlap", version(1, "2099-01-01", "2099-08-01"), version(2, "2099-07-01", None), section="6"),
            history_item("h-missing", version(1, None, "2099-07-01"), version(2, "2099-07-01", None), section="7"),
            history_item("h-order", version(1, "2099-07-01", None), version(2, "2099-01-01", "2099-07-01"), section="8"),
            history_item("h-open-early", version(1, "2099-01-01", None), version(2, "2099-07-01", None), section="9"),
            history_item("h-pk", version(1, "2099-01-01", None), section="10", jurisdiction="PK"),
            history_item("h-cto", version(1, "2099-01-01", None, confidence=None), section="11", history="current_text_only"),
            history_item("h-cto-bad", version(1, "2099-01-01", None, confidence=0.9), section="12", history="current_text_only"),
            history_item("h-status", version(1, "2099-01-01", None), section="13", status="in force"),
            history_item("h-repealed", version(1, "2099-01-01", None), section="14", statute="Test Repealed Act 2099",
                         status="Repealed"),
        ))
    keys = ("h-ok", "h-overlap", "h-missing", "h-order", "h-open-early", "h-pk", "h-cto", "h-cto-bad", "h-status",
            "h-repealed")
    got = {key: (result.primary(key).decision, result.primary(key).reason) for key in keys}
    assert got == {
        "h-ok": ("promoted", None),
        "h-overlap": ("rejected", "history_overlap"),
        "h-missing": ("rejected", "history_missing_effective_from"),
        "h-order": ("rejected", "history_out_of_order"),
        "h-open-early": ("rejected", "history_out_of_order"),
        "h-pk": ("rejected", "invalid_jurisdiction"),
        "h-cto": ("promoted", None),
        "h-cto-bad": ("rejected", "invalid_history"),
        "h-status": ("rejected", "invalid_statute_status"),
        "h-repealed": ("promoted", None),
    }
    statutes = admin_fetch(corpus_db, "SELECT name, jurisdiction, status, review_status FROM statute ORDER BY name")
    assert statutes == [("Test Act 2099", "Federal", "in_force", "promoted"),
                        ("Test Repealed Act 2099", "Federal", "repealed", "promoted")]
    versions = admin_fetch(
        corpus_db,
        "SELECT s.section_number, v.version_no, v.effective_from::text, v.effective_to::text, v.version_confidence, "
        "v.review_status FROM statute_section_version v JOIN statute_section s ON s.id = v.section_id "
        "ORDER BY s.section_number, v.version_no",
    )
    assert versions == [
        ("11", 1, "2099-01-01", None, 0.5, "promoted"),  # current text only: B-5's 0.5, which the reader ignores
        ("14", 1, "2099-01-01", None, 0.9, "promoted"),
        ("5", 1, "2099-01-01", "2099-07-01", 0.9, "promoted"),
        ("5", 2, "2099-07-01", None, 0.9, "promoted"),
    ]
    reader, reader_pw = corpus_db.reader_role()
    seen = fetch_as(
        corpus_db, reader, reader_pw,
        "SELECT v.version_no FROM v_statute_section_version v JOIN v_statute_section s ON s.id = v.section_id "
        "JOIN v_statute st ON st.id = s.statute_id WHERE s.section_number = '5' ORDER BY 1",
    )
    assert seen == [(1,), (2,)]
    # The audit has the statute, the section and each version of the published item.
    h_ok = [o.entity_type for o in result.outcomes if o.item_key == "h-ok"]
    assert h_ok == ["statute", "statute_section", "statute_section_version", "statute_section_version"]


def test_f19_republishing_a_statute_history_shifts_boundaries_without_overlap(corpus_db):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    with corpus_db.app_engine_as(writer, writer_pw):
        publish(batch_doc("curated/f19-t6-shift-1",
                          history_item("h", version(1, "2099-01-01", "2099-07-01"), version(2, "2099-07-01", None))))
        shifted = publish(batch_doc("curated/f19-t6-shift-2",
                                    history_item("h", version(1, "2099-01-01", "2099-08-01"), version(2, "2099-08-01", None))))
        assert [(o.entity_type, o.decision, o.review_status) for o in shifted.outcomes] == [
            ("statute", "unchanged", "promoted"), ("statute_section", "unchanged", "promoted"),
            ("statute_section_version", "updated", "promoted"), ("statute_section_version", "updated", "promoted")]
        assert admin_fetch(
            corpus_db,
            "SELECT version_no, effective_from::text, effective_to::text, review_status FROM statute_section_version ORDER BY 1",
        ) == [(1, "2099-01-01", "2099-08-01", "promoted"), (2, "2099-08-01", None, "promoted")]

        # A second section whose promoted v3 is seeded through a publication (a writer, not a superuser).
        publish(batch_doc("curated/f19-t6-shift-3", history_item(
            "s2", version(1, "2099-01-01", "2099-07-01"), version(2, "2099-07-01", "2099-09-01"),
            version(3, "2099-09-01", None), section="6")))
        before = snapshot(corpus_db)
        # Naming only v1 and v2, with v2 left open, overlaps the unnamed v3: the guard (SKP06) refuses it.
        refused = publish(batch_doc("curated/f19-t6-shift-4", history_item(
            "s2", version(1, "2099-01-01", "2099-07-01"), version(2, "2099-07-01", None), section="6")))
    outcome = refused.primary("s2")
    assert (outcome.decision, outcome.reason) == ("rejected", "history_overlap")
    assert refused.counts == counts(items=1, rejected=1)
    after = snapshot(corpus_db)
    for table in ANNEX_A_TABLES:
        if table not in ("corpus_publication", "corpus_publication_item", "corpus_metadata"):
            assert after[table] == before[table], table
    assert admin_fetch(
        corpus_db,
        "SELECT v.version_no, v.effective_to::text, v.review_status FROM statute_section_version v "
        "JOIN statute_section s ON s.id = v.section_id WHERE s.section_number = '6' ORDER BY 1",
    ) == [(1, "2099-07-01", "promoted"), (2, "2099-09-01", "promoted"), (3, None, "promoted")]


# ---------------------------------------------------------------------------------------------
# the CLI for curated batches
# ---------------------------------------------------------------------------------------------
def curated_section5_batch(batch_key="curated/f19-t7-section5"):
    """One curated batch covering every row of the spec §5 outcome table (synthetic 2099 data)."""
    return batch_doc(
        batch_key,
        # judgments
        judgment_item("j-larger", citations=[parts("PLD", 71, court="SC")], bench="Larger Bench"),
        judgment_item("j-division", citations=[{"text": "2099 SCMR 72"}, parts("PLD", 72, court="Karachi")], bench="DB"),
        judgment_item("j-no-provenance", citations=[{"text": "2099 SCMR 73"}], provenance={**PROVENANCE, "content_hash": None}),
        judgment_item("j-invalid-bench", citations=[{"text": "2099 SCMR 74"}], bench="Full Court"),
        judgment_item("j-review", citations=[{"text": "2099 SCMR 75"}], trust=("review", 0.95)),
        judgment_item("j-no-bench", citations=[{"text": "2099 SCMR 76"}], bench=None),
        judgment_item("j-not-canonical", citations=[{"text": "PLD 2099 Atlantis 1"}]),
        # treatments
        treatment_item("t-overruled", treating={"item_key": "j-larger"}, treated={"item_key": "j-division"}, kind="Overruled"),
        treatment_item("t-invalid-kind", treating={"item_key": "j-larger"}, treated={"item_key": "j-division"}, kind="reversed"),
        treatment_item("t-unresolvable", treating={"item_key": "j-larger"}, treated="2099 SCMR 998"),
        treatment_item("t-uncertain", treating={"item_key": "j-larger"}, treated={"item_key": "j-division"},
                       kind="doubted", confidence=0.6),
        # statute section histories
        history_item("h-amended", version(1, "2099-01-01", "2099-06-01"), version(2, "2099-06-01", None), section="21"),
        history_item("h-current-text-only", version(1, "2099-01-01", None, confidence=None), section="22",
                     history="current_text_only"),
        history_item("h-missing-from", version(1, None, None), section="23"),
        history_item("h-overlap", version(1, "2099-01-01", "2099-09-01"), version(2, "2099-06-01", None), section="24"),
        history_item("h-out-of-order", version(1, "2099-06-01", "2099-03-01"), section="25"),
        history_item("h-jurisdiction", version(1, "2099-01-01", None), section="26", jurisdiction="Islamabad"),
    )


SECTION5_EXPECTED = {
    "j-larger": ("promoted", None),
    "j-division": ("promoted", None),
    "j-no-provenance": ("rejected", "provenance_incomplete"),
    "j-invalid-bench": ("rejected", "invalid_bench"),
    "j-review": ("quarantined", "review_source"),
    "j-no-bench": ("quarantined", "missing_bench"),
    "j-not-canonical": ("quarantined", "citation_not_canonical"),
    "t-overruled": ("promoted", None),
    "t-invalid-kind": ("rejected", "invalid_treatment_kind"),
    "t-unresolvable": ("rejected", "unresolvable_judgment"),
    "t-uncertain": ("quarantined", "treatment_uncertain"),
    "h-amended": ("promoted", None),
    "h-current-text-only": ("promoted", None),
    "h-missing-from": ("rejected", "history_missing_effective_from"),
    "h-overlap": ("rejected", "history_overlap"),
    "h-out-of-order": ("rejected", "history_out_of_order"),
    "h-jurisdiction": ("rejected", "invalid_jurisdiction"),
}


def write_batch(tmp_path, doc, name="batch.json"):
    path = tmp_path / name
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    return str(path)


def cli_publish(corpus_db, path, user, password, actor="f19-curator-2099"):
    return corpus_db.run_cli("publish", "--batch", path, "--actor", actor, user=user, password=password)


def test_f19_cli_publishes_a_curated_batch_and_the_reader_sees_it(corpus_db, tmp_path):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    proc = cli_publish(corpus_db, write_batch(tmp_path, curated_section5_batch()), writer, writer_pw)
    assert proc.returncode == 0, proc.stderr[-4000:]
    out = json.loads(proc.stdout)
    assert set(out) == {"publication_id", "batch_key", "already", "seq", "counts", "items"}
    assert out["already"] is False and out["batch_key"] == "curated/f19-t7-section5"
    for item in out["items"]:
        assert set(item) == {"item_key", "entity_type", "entity_id", "decision", "reason", "review_status"}
    primary = {}
    for item in out["items"]:
        if item["entity_type"] in ("judgment", "treatment", "statute_section") or item["decision"] == "rejected":
            primary.setdefault(item["item_key"], (item["decision"], item["reason"]))
    assert primary == SECTION5_EXPECTED
    # stdout carries identifiers and decisions only: no titles, texts or URLs
    assert "F19 j-larger" not in proc.stdout and "example.invalid" not in proc.stdout and "Test Act" not in proc.stdout

    audit = admin_fetch(
        corpus_db,
        "SELECT item_count, promoted_count, quarantined_count, updated_count, unchanged_count, rejected_count, "
        "actor_id, publisher_session_user, source_kind FROM corpus_publication",
    )
    assert audit == [(*[out["counts"][k] for k in COUNT_KEYS], "f19-curator-2099", writer, "curated")]
    decisions = admin_fetch(corpus_db, "SELECT decision, count(*) FROM corpus_publication_item GROUP BY 1")
    assert dict(decisions) == {k: n for k, n in out["counts"].items() if k != "items" and n}

    reader, reader_pw = corpus_db.reader_role()
    seen = lambda sql: sorted(fetch_as(corpus_db, reader, reader_pw, sql))  # noqa: E731
    assert seen("SELECT c.citation_text, j.bench_type FROM v_citation c JOIN v_judgment j ON j.id = c.judgment_id") == [
        ("2099 SCMR 72", "division"), ("PLD 2099 SC 71", "larger"), ("PLD 2099 Sindh 72", "division")]
    assert seen("SELECT treatment, treating_bench_type FROM v_treatment") == [("overruled", "larger")]
    assert seen(
        "SELECT s.section_number, v.version_no, v.version_confidence FROM v_statute_section_version v "
        "JOIN v_statute_section s ON s.id = v.section_id"
    ) == [("21", 1, 0.9), ("21", 2, 0.9), ("22", 1, 0.5)]
    # Quarantined rows exist in the contract, out of the reader's sight.
    assert admin_fetch(corpus_db, "SELECT count(*) FROM judgment WHERE review_status = 'quarantined'") == [(3,)]


def test_f19_cli_rerun_is_a_no_op_and_a_reused_key_is_refused(corpus_db, tmp_path):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    doc = curated_section5_batch("curated/f19-t7-rerun")
    path = write_batch(tmp_path, doc)
    first = cli_publish(corpus_db, path, writer, writer_pw)
    assert first.returncode == 0, first.stderr[-4000:]
    before = snapshot(corpus_db)

    again = cli_publish(corpus_db, path, writer, writer_pw)
    assert again.returncode == 0, again.stderr[-4000:]
    out1, out2 = json.loads(first.stdout), json.loads(again.stdout)
    assert out2["already"] is True
    assert {k: out2[k] for k in ("publication_id", "seq", "counts", "items")} == {
        k: out1[k] for k in ("publication_id", "seq", "counts", "items")}
    assert snapshot(corpus_db) == before

    edited = json.loads(json.dumps(doc))
    edited["items"][0]["full_text"] = "edited synthetic F19 text"
    reused = cli_publish(corpus_db, write_batch(tmp_path, edited, "edited.json"), writer, writer_pw)
    assert reused.returncode == 3
    assert "batch_key_reused" in reused.stderr and reused.stdout == ""
    assert "edited synthetic" not in reused.stderr
    assert snapshot(corpus_db) == before


def test_f19_cli_failure_leaves_no_trace_and_the_key_unconsumed(corpus_db, tmp_path):
    prepare(corpus_db)
    writer, writer_pw = corpus_db.writer_role()
    _install_fault_trigger(corpus_db)
    doc = batch_doc(
        "curated/f19-t7-fault",
        judgment_item("i1", citations=[{"text": "2099 SCMR 81"}]),
        judgment_item("i2", citations=[{"text": "2099 SCMR 82"}], case_title="F19 fault 2099"),
    )
    path = write_batch(tmp_path, doc)
    empty = snapshot(corpus_db)
    failed = cli_publish(corpus_db, path, writer, writer_pw)
    assert failed.returncode == 1
    assert "publication.failed error=IntegrityError" in failed.stderr
    assert "F19 fault 2099" not in failed.stderr and "f19 marker" not in failed.stderr and "SCMR" not in failed.stderr
    assert snapshot(corpus_db) == empty
    _remove_fault_trigger(corpus_db)
    retried = cli_publish(corpus_db, path, writer, writer_pw)
    assert retried.returncode == 0, retried.stderr[-4000:]
    assert json.loads(retried.stdout)["counts"] == counts(items=2, promoted=4)


def test_f19_cli_refuses_a_superuser_url_and_bad_input(corpus_db, tmp_path):
    prepare(corpus_db)
    path = write_batch(tmp_path, batch_doc("curated/f19-t7-admin", judgment_item("j1")))
    admin_user = corpus_db._admin.username
    superuser = corpus_db.run_cli("publish", "--batch", path, "--actor", "f19-curator-2099",
                                  user=admin_user, password=corpus_db.password)
    assert superuser.returncode == 4
    assert "superuser_session" in superuser.stderr

    nobody, nobody_pw = corpus_db.create_role("f19_none")
    not_writer = cli_publish(corpus_db, path, nobody, nobody_pw)
    assert not_writer.returncode == 4 and "not_corpus_writer" in not_writer.stderr

    writer, writer_pw = corpus_db.writer_role()
    broken = write_batch(tmp_path, {**batch_doc("curated/f19-t7-bad", judgment_item("j1")), "extra": "f19-secret-2099"}, "bad.json")
    structural = cli_publish(corpus_db, broken, writer, writer_pw)
    assert structural.returncode == 2 and "BatchError" in structural.stderr
    assert "f19-secret-2099" not in structural.stderr
    usage = corpus_db.run_cli("publish", "--batch", path, user=writer, password=writer_pw)  # no --actor
    assert usage.returncode == 2
    assert admin_fetch(corpus_db, "SELECT count(*) FROM corpus_publication") == [(0,)]


# ---------------------------------------------------------------------------------------------
# migrate and the ORM never touch Annex A; the staging bench column
# ---------------------------------------------------------------------------------------------
INVENTORY = {
    "classification_rank", "source_provenance", "court", "judge", "instrument", "statute", "statute_section",
    "statute_section_version", "judgment", "judgment_version", "citation", "treatment", "corpus_metadata",
    "corpus_embeddings", "judgment_classification_declassify_audit", "judgment_declassify_grant",
    "v_judgment", "v_citation", "v_treatment", "v_statute", "v_statute_section", "v_statute_section_version",
    "v_instrument", "v_court", "v_judge", "v_source_provenance",
    "corpus_publication", "corpus_publication_item", "corpus_publication_grant",
}


def _owner_role(db):
    """A NOCREATEROLE, NOSUPERUSER schema owner, as F30 provisions MIGRATE_DB_USER."""
    owner, owner_pw = db.create_role("f19_mig")
    db.admin(
        f'GRANT CONNECT, CREATE ON DATABASE "{db.name}" TO "{owner}"',
        f'GRANT USAGE, CREATE ON SCHEMA public TO "{owner}"',
    )
    return owner, owner_pw


def test_f19_orm_has_no_annex_a_table_and_migrate_never_applies_annex_a(corpus_db):
    from scraper import database
    from scraper import models  # noqa: F401 - registers the tables on Base.metadata

    assert set(database.Base.metadata.tables) & INVENTORY == set()

    # migrate alone never creates Annex A.
    proc = corpus_db.migrate()
    assert proc.returncode == 0, proc.stderr[-4000:]
    assert admin_fetch(corpus_db, "SELECT to_regclass('public.judgment') IS NULL") == [(True,)]

    # The NOCREATEROLE owner cannot apply 001 (CREATE ROLE / CREATE EXTENSION): a superuser must.
    owner, owner_pw = _owner_role(corpus_db)
    ddl = (Path(__file__).resolve().parents[2] / "postgres" / "ddl" / "001_corpus_contract.sql").read_text(encoding="utf-8")

    async def _apply_as_owner():
        import asyncpg
        from sqlalchemy.engine import make_url

        url = make_url(corpus_db.url_as(owner, owner_pw)).set(drivername="postgresql").render_as_string(hide_password=False)
        conn = await asyncpg.connect(url)
        try:
            await conn.execute(ddl)
        except Exception as exc:  # noqa: BLE001 - classified by SQLSTATE
            return getattr(exc, "sqlstate", None)
        finally:
            await conn.close()
        return "SUCCEEDED"

    assert run(_apply_as_owner()) == "42501"
    assert admin_fetch(corpus_db, "SELECT to_regclass('public.judgment') IS NULL") == [(True,)]


def test_f19_migrate_as_owner_succeeds_after_annex_a_and_leaves_it_with_the_superuser(corpus_db):
    corpus_db.apply_annex_a()
    corpus_db.admin('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')  # as the compose init.sql does
    owner, owner_pw = _owner_role(corpus_db)
    proc = corpus_db.migrate(corpus_db.url_as(owner, owner_pw))
    assert proc.returncode == 0, proc.stderr[-4000:]
    admin_user = corpus_db._admin.username
    owners = admin_fetch(
        corpus_db,
        "SELECT c.relname, pg_get_userbyid(c.relowner) FROM pg_class c "
        "WHERE c.oid IN (SELECT r FROM corpus_contract_relations() AS r)",
    )
    assert len(owners) == 29
    assert {row[1] for row in owners} == {admin_user}
    app_tables = admin_fetch(corpus_db, "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'scraper_staging'")
    assert app_tables == [(owner,)]


def test_f19_migrate_adds_extracted_bench_type_once(corpus_db):
    from sqlalchemy import text

    from scraper import database
    from scraper import models  # noqa: F401

    corpus_db.admin(
        "CREATE EXTENSION IF NOT EXISTS vector", "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
    )

    async def _legacy():
        async with database.engine.begin() as conn:
            await conn.run_sync(database.Base.metadata.create_all)
            await conn.execute(text("ALTER TABLE scraper_staging DROP COLUMN extracted_bench_type"))

    run(_legacy())
    column = "SELECT attnum FROM pg_attribute WHERE attrelid = 'scraper_staging'::regclass AND attname = 'extracted_bench_type' AND NOT attisdropped"
    assert admin_fetch(corpus_db, column) == []
    first = corpus_db.migrate()
    assert first.returncode == 0, first.stderr[-4000:]
    attnum = admin_fetch(corpus_db, column)
    assert len(attnum) == 1
    assert "staging bench column added" in first.stderr
    second = corpus_db.migrate()
    assert second.returncode == 0, second.stderr[-4000:]
    assert "staging bench column already present" in second.stderr
    assert admin_fetch(corpus_db, column) == attnum


# ---------------------------------------------------------------------------------------------
# promotion publishes into Annex A (the spec §5 staging path)
# ---------------------------------------------------------------------------------------------
async def _make_sources(specs):
    from scraper.database import SessionLocal
    from scraper.models import ScraperSource

    async with SessionLocal() as db:
        objs = {key: ScraperSource(source_name=name, source_url=f"https://f19.example.invalid/{key}", trust_level=trust)
                for key, (name, trust) in specs.items()}
        db.add_all(objs.values())
        await db.commit()
        return {key: obj.id for key, obj in objs.items()}


async def _stage(rows):
    from scraper.database import SessionLocal
    from scraper.models import ScraperStaging

    async with SessionLocal() as db:
        objs = {}
        for key, fields in rows.items():
            objs[key] = ScraperStaging(**{
                "source_url": f"https://f19.example.invalid/judgment/{key}",
                "extracted_title": f"F19 Staged {key} v. Test 2099",
                "extracted_year": 2099,
                "raw_text": f"synthetic F19 staged text {key}",
                "raw_html": "<p>synthetic F19 staged page</p>",
                "extracted_bench_type": "Division Bench",
                "confidence_score": 0.9,
                "normalised": True,
                **fields,
            })
        db.add_all(objs.values())
        await db.commit()
        return {key: obj.id for key, obj in objs.items()}


def _promote_as_runtime_role(db):
    from scraper.tasks.promotion import promote_staging_records

    app, app_pw = db.runtime_role()
    with db.app_engine_as(app, app_pw):
        return run(promote_staging_records()), app


def _staging_state(db):
    rows = admin_fetch(db, "SELECT id, promoted, quarantined, quarantine_reason, promoted_to_id FROM scraper_staging")
    queue = admin_fetch(db, "SELECT staging_id, reason, details FROM quarantine_queue")
    return {r[0]: r[1:] for r in rows}, {q[0]: (q[1], q[2]) for q in queue}


def test_f19_promotion_publishes_into_annex_a_and_the_reader_sees_it(corpus_db):
    import hashlib

    from scraper.publication.from_staging import STAGING_ACTOR_ID

    prepare(corpus_db)
    src = run(_make_sources({"trusted": ("f19-trusted", "trusted")}))
    ids = run(_stage({"karachi": dict(source_id=src["trusted"], source_site="f19-trusted",
                                      extracted_citation="PLD 2099 Karachi 12", extracted_bench_type="Division Bench")}))
    sid = ids["karachi"]

    result, app = _promote_as_runtime_role(corpus_db)
    assert result == {"promoted": 1, "quarantined": 0, "failed": 0}

    staging, queue = _staging_state(corpus_db)
    promoted, quarantined, reason, promoted_to = staging[sid]
    assert (promoted, quarantined, reason) == (True, False, None) and queue == {}
    judgments = admin_fetch(corpus_db, "SELECT id, bench_type, review_status, source_id, publication_id FROM judgment")
    assert len(judgments) == 1
    jid, bench, status, source_id, pub_id = judgments[0]
    assert (promoted_to, bench, status) == (jid, "division", "promoted")
    assert admin_fetch(corpus_db, "SELECT citation_text, review_status FROM citation") == [("PLD 2099 Sindh 12", "promoted")]
    provenance = admin_fetch(
        corpus_db, "SELECT id, source_name, source_url, extraction_method, content_hash FROM source_provenance")
    assert provenance == [(source_id, "f19-trusted", "https://f19.example.invalid/judgment/karachi", "html",
                           hashlib.sha256(b"synthetic F19 staged text karachi").hexdigest())]
    assert admin_fetch(
        corpus_db, "SELECT id, batch_key, source_kind, actor_id, publisher_session_user FROM corpus_publication"
    ) == [(pub_id, f"staging/{sid}", "staging", STAGING_ACTOR_ID, app)]
    # Ruling 10: nothing goes to case_law_master or the embedding queue any more.
    assert admin_fetch(corpus_db, "SELECT count(*) FROM case_law_master") == [(0,)]
    assert admin_fetch(corpus_db, "SELECT count(*) FROM embedding_queue") == [(0,)]

    reader, reader_pw = corpus_db.reader_role()
    seen = fetch_as(corpus_db, reader, reader_pw,
                    "SELECT j.id, j.bench_type, c.citation_text FROM v_judgment j JOIN v_citation c ON c.judgment_id = j.id")
    assert seen == [(jid, "division", "PLD 2099 Sindh 12")]


def test_f19_promotion_outcomes_follow_the_section5_table(corpus_db):
    prepare(corpus_db)
    src = run(_make_sources({"trusted": ("f19-trusted", "trusted"), "review": ("f19-review", "review")}))
    trusted = dict(source_id=src["trusted"], source_site="f19-trusted")
    ids = run(_stage({
        "no_bench": dict(**trusted, extracted_citation="2099 SCMR 41", extracted_bench_type=None),
        "panel": dict(**trusted, extracted_citation="2099 SCMR 42", extracted_bench_type="panel"),
        "atlantis": dict(**trusted, extracted_citation="PLD 2099 Atlantis 1"),
        "no_provenance": dict(**trusted, extracted_citation="2099 SCMR 44", raw_text=None, raw_html=None),
        "review": dict(source_id=src["review"], source_site="f19-review", extracted_citation="2099 SCMR 45"),
        "low_confidence": dict(**trusted, extracted_citation="2099 SCMR 46", confidence_score=0.49),
        "original": dict(**trusted, extracted_citation="2099 SCMR 50", extracted_bench_type="single",
                         source_url="https://f19.example.invalid/judgment/original", raw_text="synthetic F19 original"),
    }))
    first, _app = _promote_as_runtime_role(corpus_db)
    assert first == {"promoted": 1, "quarantined": 6, "failed": 0}
    original = admin_fetch(corpus_db, "SELECT j.id, j.updated_at, j.source_id FROM judgment j JOIN citation c "
                                      "ON c.judgment_id = j.id WHERE c.citation_text = '2099 SCMR 50'")
    assert len(original) == 1
    original_id = original[0][0]

    # Re-stagings of the published authority: one with no bench, one identical.
    again = run(_stage({
        "restage_no_bench": dict(**trusted, extracted_citation="2099 SCMR 50", extracted_bench_type=None,
                                 source_url="https://f19.example.invalid/judgment/original", raw_text="synthetic F19 original"),
        "restage_identical": dict(**trusted, extracted_citation="2099 SCMR 50", extracted_bench_type="single",
                                  source_url="https://f19.example.invalid/judgment/original", raw_text="synthetic F19 original",
                                  extracted_title="F19 Staged original v. Test 2099"),
    }))
    second, _app = _promote_as_runtime_role(corpus_db)
    assert second == {"promoted": 1, "quarantined": 1, "failed": 0}
    ids.update(again)

    staging, queue = _staging_state(corpus_db)
    outcome = {key: (staging[sid][0], staging[sid][1], staging[sid][2]) for key, sid in ids.items()}
    assert outcome == {
        "no_bench": (False, True, "missing_bench"),
        "panel": (False, True, "invalid_bench"),
        "atlantis": (False, True, "citation_not_canonical"),
        "no_provenance": (False, True, "provenance_incomplete"),
        "review": (False, True, "review_source"),
        "low_confidence": (False, True, "low_confidence"),
        "original": (True, False, None),
        "restage_no_bench": (False, True, "promoted_row_protected"),
        "restage_identical": (True, False, None),
    }
    assert staging[ids["original"]][3] == original_id
    assert staging[ids["restage_identical"]][3] == original_id  # promoted_to_id = the existing judgment
    assert {key: queue[sid][0] for key, sid in ids.items() if sid in queue} == {
        k: v[2] for k, v in outcome.items() if v[1]}
    no_bench_details = queue[ids["no_bench"]][1]
    annex_a = no_bench_details["annex_a"]
    assert annex_a["decision"] == "quarantined" and annex_a["judgment_id"] is not None

    # Annex A holds the quarantined no-bench and Atlantis judgments, the original, and nothing for
    # the rejected or trust-quarantined rows (D8).
    judgments = admin_fetch(
        corpus_db,
        "SELECT c.citation_text, j.review_status, c.review_status FROM judgment j JOIN citation c "
        "ON c.judgment_id = j.id ORDER BY 1",
    )
    assert judgments == [
        ("2099 SCMR 41", "quarantined", "quarantined"),
        ("2099 SCMR 50", "promoted", "promoted"),
        ("PLD 2099 Atlantis 1", "quarantined", "quarantined"),
    ]
    assert str(annex_a["judgment_id"]) == str(admin_fetch(
        corpus_db, "SELECT judgment_id FROM citation WHERE citation_text = '2099 SCMR 41'")[0][0])
    # The re-stagings left the published judgment exactly as it was.
    assert admin_fetch(corpus_db, "SELECT j.id, j.updated_at, j.source_id FROM judgment j WHERE j.id = :id",
                       id=original_id) == original
    decisions = admin_fetch(
        corpus_db,
        "SELECT p.batch_key, i.entity_type, i.decision, i.reason FROM corpus_publication_item i "
        "JOIN corpus_publication p ON p.id = i.publication_id WHERE i.entity_type = 'judgment' ORDER BY p.seq",
    )
    by_key = {row[0]: (row[2], row[3]) for row in decisions}
    assert by_key[f"staging/{ids['restage_no_bench']}"] == ("rejected", "promoted_row_protected")
    assert by_key[f"staging/{ids['restage_identical']}"] == ("unchanged", None)
    assert by_key[f"staging/{ids['panel']}"] == ("rejected", "invalid_bench")
    assert f"staging/{ids['review']}" not in by_key and f"staging/{ids['low_confidence']}" not in by_key

    reader, reader_pw = corpus_db.reader_role()
    assert fetch_as(corpus_db, reader, reader_pw, "SELECT c.citation_text FROM v_judgment j JOIN v_citation c "
                                                  "ON c.judgment_id = j.id") == [("2099 SCMR 50",)]
    assert admin_fetch(corpus_db, "SELECT count(*) FROM case_law_master") == [(0,)]


def test_f19_guard_rejection_inside_promotion_rolls_back_only_that_item(corpus_db):
    """A guard error (SQLSTATE class SK, SKP03-SKP06) raised while promotion publishes one record is
    handled inside the record's own Session savepoint: the item is rolled back and recorded rejected,
    the record is quarantined with the guard's reason, and the other records are unaffected (plan D15,
    UNVERIFIED item 3)."""
    prepare(corpus_db)
    # Stand-in for a guard refusal the Python pre-checks did not foresee: the same SQLSTATE and token
    # the 003 guard raises for a promoted judgment without a bench.
    corpus_db.admin(
        """CREATE FUNCTION f19_test_guard() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.case_title = 'F19 guard 2099' THEN
               RAISE EXCEPTION USING ERRCODE = 'SKP04', MESSAGE = 'bench_required', DETAIL = 'table judgment';
             END IF;
             RETURN NEW;
           END $$""",
        "CREATE TRIGGER f19_test_guard BEFORE INSERT ON judgment FOR EACH ROW EXECUTE FUNCTION f19_test_guard()",
    )
    src = run(_make_sources({"trusted": ("f19-trusted", "trusted")}))
    trusted = dict(source_id=src["trusted"], source_site="f19-trusted")
    ids = run(_stage({
        "before": dict(**trusted, extracted_citation="2099 SCMR 91"),
        "guarded": dict(**trusted, extracted_citation="2099 SCMR 92", extracted_title="F19 guard 2099"),
        "after": dict(**trusted, extracted_citation="2099 SCMR 93"),
    }))
    result, _app = _promote_as_runtime_role(corpus_db)
    assert result == {"promoted": 2, "quarantined": 1, "failed": 0}
    staging, queue = _staging_state(corpus_db)
    assert staging[ids["guarded"]][:3] == (False, True, "missing_bench")
    assert queue[ids["guarded"]][1]["annex_a"]["decision"] == "rejected"
    assert staging[ids["before"]][0] is True and staging[ids["after"]][0] is True
    assert admin_fetch(corpus_db, "SELECT citation_text FROM citation ORDER BY 1") == [("2099 SCMR 91",), ("2099 SCMR 93",)]
    items = admin_fetch(
        corpus_db,
        "SELECT i.decision, i.reason FROM corpus_publication_item i JOIN corpus_publication p ON p.id = i.publication_id "
        "WHERE p.batch_key = :k",
        k=f"staging/{ids['guarded']}",
    )
    assert items == [("rejected", "missing_bench")]
    assert admin_fetch(corpus_db, "SELECT count(*) FROM source_provenance") == [(2,)]
