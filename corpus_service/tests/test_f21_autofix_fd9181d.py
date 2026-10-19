"""PR #90 (F21): red/green tests for the three behaviours the Bugbot Autofix commit fd9181d changed
without tests (Monitor, 2026-10-19). Spec: docs/superpowers/specs/2026-10-18-f21-corpus-lifecycle-design.md.

1. NationalAssembly statute identity (nationalassembly.py): the act name is the PDF link's text and the
   section key is a content hash, so two acts whose paragraphs share a 20-character prefix are not
   attached to one statutes_master row at publication (R8's no-short-name natural key).
2. Normalisation dedup (normalise.py ``_PAST_NORMALISATION``): a dead-lettered record is not the
   original of a later copy. dead_letter is a refusal for a reason that is not the content (R2), and
   can be reached before normalisation, so a fresh copy is normalised and decided again.
3. Claim order (corpus_pipeline.py ``_claim_oldest``): a tick claims the oldest row in its state across
   case and statute staging (R4 "claims the oldest row"), and a row locked elsewhere is skipped, not a
   stall, even when it is the oldest (R4 "one stuck row cannot stall a tick").

Same harness as test_f21_corpus_lifecycle_e2e.py: real beat entries, real PG16, synthetic edges only.
"""
import asyncio
import threading

import pytest

from test_f21_corpus_lifecycle_e2e import (
    F21Fetcher, NA_INDEX, _Resp, _stage_statutes, _stage_trusted_cases, admin_exec, admin_fetch, count,
    fire, harvest, install_offline_sources, prepare, tick,
)

# ---------------------------------------------------------------------------------------------
# 1. NationalAssembly statute identity
# ---------------------------------------------------------------------------------------------
NA_PDFS = {
    "https://na.gov.pk/uploads/f21-alpha-act-2099.pdf": ("F21 Alpha Act 2099", b"%PDF-1.4 F21-ALPHA synthetic"),
    "https://na.gov.pk/uploads/f21-beta-ordinance-2099.pdf": ("F21 Beta Ordinance 2099", b"%PDF-1.4 F21-BETA synthetic"),
}
SHARED_PREFIX = "THE GAZETTE OF PAKISTAN, EXTRAORDINARY, synthetic F21 fixture. "  # > 20 characters
NA_TEXTS = {
    b"F21-ALPHA": SHARED_PREFIX + "Alpha: the first section of the synthetic Alpha Act, for this fixture only.",
    b"F21-BETA": SHARED_PREFIX + "Beta: the first section of the synthetic Beta Ordinance, for this fixture only.",
}


class TwoActsFetcher(F21Fetcher):
    async def get(self, url, *args, **kwargs):
        url = str(url)
        if url == NA_INDEX:
            links = "".join(f"<a href='{u[len('https://na.gov.pk'):]}'>{name}</a>" for u, (name, _b) in NA_PDFS.items())
            return _Resp(f"<html>{links}</html>".encode(), url=url)
        if url in NA_PDFS:
            return _Resp(NA_PDFS[url][1], url=url, content_type="application/pdf")
        return await super().get(url, *args, **kwargs)


def _two_acts(monkeypatch):
    from pathlib import Path

    from scraper.net import fetch_policy
    from scraper.parsers import pdf_sandbox

    install_offline_sources(monkeypatch)
    monkeypatch.setattr(fetch_policy, "fetcher_for", lambda name, *a, **kw: TwoActsFetcher(name))

    def _parse(path, sha256, size, **kw):
        body = Path(path).read_bytes()
        text = next(t for marker, t in NA_TEXTS.items() if marker in body)
        return pdf_sandbox.ParseResult(text=text, pages=1, ocr_applied=False)

    monkeypatch.setattr(pdf_sandbox, "parse", _parse)


def test_autofix_1_two_na_acts_with_a_shared_prefix_publish_two_statutes(corpus_db, monkeypatch):
    prepare(corpus_db)
    _two_acts(monkeypatch)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        assert harvest("scrape-na") == {"scrape-na": "SUCCESS"}
        for _ in range(3):
            tick()
    staged = admin_fetch(corpus_db, "SELECT extracted_act_name, extracted_section_number FROM statutes_staging "
                                    "ORDER BY extracted_act_name")
    assert [a for a, _s in staged] == ["F21 Alpha Act 2099", "F21 Beta Ordinance 2099"], staged
    sections = [s for _a, s in staged]
    assert len(set(sections)) == 2 and all(len(s) == 32 and int(s, 16) >= 0 for s in sections), sections
    assert not any(s.startswith(SHARED_PREFIX[:20]) for s in sections), "a text prefix is not a section key"
    masters = admin_fetch(corpus_db, "SELECT statute_name FROM statutes_master WHERE source_site = 'NationalAssembly' "
                                     "ORDER BY statute_name")
    assert masters == [("F21 Alpha Act 2099",), ("F21 Beta Ordinance 2099",)], masters


# ---------------------------------------------------------------------------------------------
# 2. a dead-lettered record is not the original of a later copy
# ---------------------------------------------------------------------------------------------
def test_autofix_2_a_copy_of_a_dead_lettered_record_is_normalised_and_published(corpus_db, monkeypatch):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    (dead,) = _stage_statutes(corpus_db, 1)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        fire("normalise-corpus")
        fire("promote-corpus")
        admin_exec(corpus_db, "UPDATE scraper_sources SET trust_level = 'review' WHERE source_name = 'PakistanCode'")
        fire("publish-corpus")
        assert admin_fetch(corpus_db, "SELECT lifecycle_state FROM statutes_staging") == [("dead_letter",)]
        admin_exec(corpus_db, "UPDATE scraper_sources SET trust_level = 'trusted' WHERE source_name = 'PakistanCode'")
        # The same document harvested again: same source, URL, act, section and text.
        admin_exec(corpus_db,
                   "INSERT INTO statutes_staging (source_id, source_site, source_url, raw_text, extracted_act_name, "
                   "extracted_short_name, extracted_section_number, extracted_section_text, confidence_score, parsing_metadata) "
                   "SELECT source_id, source_site, source_url, raw_text, extracted_act_name, extracted_short_name, "
                   "extracted_section_number, extracted_section_text, confidence_score, parsing_metadata "
                   "FROM statutes_staging WHERE id = :d", d=dead)
        fire("normalise-corpus")
        copy_state = admin_fetch(corpus_db, "SELECT lifecycle_state, state_reason FROM statutes_staging WHERE id <> :d", d=dead)
        assert copy_state == [("normalised", None)], f"the copy was kept from review by a dead letter: {copy_state}"
        fire("promote-corpus")
        fire("publish-corpus")
    assert count(corpus_db, "statutes_master") == 1


# ---------------------------------------------------------------------------------------------
# 3. claim order across case and statute staging
# ---------------------------------------------------------------------------------------------
def _one_per_tick(monkeypatch):
    from scraper.tasks import corpus_pipeline, lifecycle

    monkeypatch.setitem(corpus_pipeline.LIMITS, lifecycle.JOB_TYPE_NORMALISE, 1)


def test_autofix_3a_the_oldest_record_is_claimed_first_whichever_table_it_is_in(corpus_db, monkeypatch):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    _stage_trusted_cases(corpus_db, 3)
    (statute,) = _stage_statutes(corpus_db, 1)
    admin_exec(corpus_db, "UPDATE statutes_staging SET created_at = now() - interval '1 hour' WHERE id = :i", i=statute)
    _one_per_tick(monkeypatch)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        result = fire("normalise-corpus")
    assert result.state == "SUCCESS" and result.result["claimed"] == 1, result.result
    assert admin_fetch(corpus_db, "SELECT lifecycle_state FROM statutes_staging") == [("normalised",)], \
        "newer case rows were claimed before the older statute"
    assert count(corpus_db, "scraper_staging", "lifecycle_state = 'parsed'") == 3


def test_autofix_3b_an_oldest_row_locked_elsewhere_does_not_stall_the_other_table(corpus_db, monkeypatch):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    (case,) = _stage_trusted_cases(corpus_db, 1)
    admin_exec(corpus_db, "UPDATE scraper_staging SET created_at = now() - interval '1 hour' WHERE id = :i", i=case)
    (statute,) = _stage_statutes(corpus_db, 1)
    held, release = threading.Event(), threading.Event()

    async def holder():
        from sqlalchemy import text

        engine = corpus_db.engine_for(corpus_db.url)
        try:
            async with engine.begin() as conn:
                await conn.execute(text("SELECT 1 FROM scraper_staging WHERE id = :i FOR UPDATE"), {"i": case})
                held.set()
                while not release.is_set():
                    await asyncio.sleep(0.05)
        finally:
            await engine.dispose()

    blocker = threading.Thread(target=lambda: asyncio.run(holder()))
    blocker.start()
    assert held.wait(30)
    try:
        with corpus_db.app_engine_as(*corpus_db.runtime_role()):
            result = fire("normalise-corpus")
    finally:
        release.set()
        blocker.join(30)
    assert result.state == "SUCCESS", repr(result.result)
    assert admin_fetch(corpus_db, "SELECT lifecycle_state FROM statutes_staging") == [("normalised",)], \
        "the locked oldest case row stalled the statute behind it"
    assert admin_fetch(corpus_db, "SELECT lifecycle_state FROM scraper_staging") == [("parsed",)]


# ---------------------------------------------------------------------------------------------
# Re-audit of PR #90 (REAUDIT_PR90.md): FA-F21-001, FA-F21-002, FA-F21-003
# ---------------------------------------------------------------------------------------------
def _hold_row_lock(corpus_db, table, rid):
    held, release = threading.Event(), threading.Event()

    async def holder():
        from sqlalchemy import text

        engine = corpus_db.engine_for(corpus_db.url)
        try:
            async with engine.begin() as conn:
                await conn.execute(text(f"SELECT 1 FROM {table} WHERE id = :i FOR UPDATE"), {"i": rid})
                held.set()
                while not release.is_set():
                    await asyncio.sleep(0.05)
        finally:
            await engine.dispose()

    blocker = threading.Thread(target=lambda: asyncio.run(holder()))
    blocker.start()
    assert held.wait(30)
    return release, blocker


def test_fa_f21_001_a_locked_oldest_row_does_not_let_a_newer_row_jump_the_other_tables_older_one(corpus_db, monkeypatch):
    """case1 (oldest, locked elsewhere) < statute < case2: the oldest CLAIMABLE row is the statute (R4)."""
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    case1, case2 = _stage_trusted_cases(corpus_db, 2)
    (statute,) = _stage_statutes(corpus_db, 1)
    for table, rid, age in (("scraper_staging", case1, 3600), ("statutes_staging", statute, 1800), ("scraper_staging", case2, 60)):
        admin_exec(corpus_db, f"UPDATE {table} SET created_at = now() - make_interval(secs => :s) WHERE id = :i",
                   s=float(age), i=rid)
    _one_per_tick(monkeypatch)
    release, blocker = _hold_row_lock(corpus_db, "scraper_staging", case1)
    try:
        with corpus_db.app_engine_as(*corpus_db.runtime_role()):
            result = fire("normalise-corpus")
    finally:
        release.set()
        blocker.join(30)
    assert result.state == "SUCCESS" and result.result["claimed"] == 1, result.result
    cases = dict(admin_fetch(corpus_db, "SELECT id, lifecycle_state FROM scraper_staging"))
    assert admin_fetch(corpus_db, "SELECT lifecycle_state FROM statutes_staging") == [("normalised",)], \
        f"newer case2 was claimed ahead of the older statute: {cases}"
    assert cases == {case1: "parsed", case2: "parsed"}


class SpacedActFetcher(F21Fetcher):
    async def get(self, url, *args, **kwargs):
        url = str(url)
        if url == NA_INDEX:
            return _Resp(b"<html><a href='/uploads/f21-test-act-2099.pdf'>  F21  Spaced\n   Test Act\t2099 </a></html>", url=url)
        return await super().get(url, *args, **kwargs)


def test_fa_f21_002_the_na_act_name_is_whitespace_normalised(corpus_db, monkeypatch):
    """The listing's internal newlines, tabs and double spaces are not part of the act's identity."""
    from scraper.net import fetch_policy

    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    monkeypatch.setattr(fetch_policy, "fetcher_for", lambda name, *a, **kw: SpacedActFetcher(name))
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        assert harvest("scrape-na") == {"scrape-na": "SUCCESS"}
        for _ in range(3):
            tick()
    assert {a for (a,) in admin_fetch(corpus_db, "SELECT extracted_act_name FROM statutes_staging")} == {"F21 Spaced Test Act 2099"}
    assert {a for (a,) in admin_fetch(corpus_db, "SELECT statute_name FROM statutes_master")} == {"F21 Spaced Test Act 2099"}


# Which states make a record the original of a later copy (normalise._PAST_NORMALISATION), written
# out from the spec: states past normalisation, including a reviewer's content decision (rejected);
# not a refusal for a non-content reason (dead_letter), a failed or duplicate record, or one that
# has not been normalised (discovered, downloaded). `parsed` is left out: the tick would normalise
# that original itself first.
ORIGINAL_STATES = {
    "normalised": True, "quarantined": True, "approved": True, "published": True, "embedded": True, "rejected": True,
    "discovered": False, "downloaded": False, "failed": False, "duplicate": False, "dead_letter": False,
}


def test_fa_f21_003_the_matrix_covers_every_lifecycle_state():
    from scraper.tasks import lifecycle

    assert set(ORIGINAL_STATES) | {"parsed"} == set(lifecycle.STATES)


@pytest.mark.parametrize("state", sorted(ORIGINAL_STATES))
def test_fa_f21_003_dedup_original_state_matrix(corpus_db, monkeypatch, state):
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    (orig,) = _stage_statutes(corpus_db, 1)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        fire("normalise-corpus")  # the original gets its act and URL hashes
        admin_exec(corpus_db, "UPDATE statutes_staging SET lifecycle_state = :s, state_reason = 'f21-matrix' WHERE id = :d",
                   s=state, d=orig)
        admin_exec(corpus_db,
                   "INSERT INTO statutes_staging (source_id, source_site, source_url, raw_text, extracted_act_name, "
                   "extracted_short_name, extracted_section_number, extracted_section_text, confidence_score, parsing_metadata) "
                   "SELECT source_id, source_site, source_url, raw_text, extracted_act_name, extracted_short_name, "
                   "extracted_section_number, extracted_section_text, confidence_score, parsing_metadata "
                   "FROM statutes_staging WHERE id = :d", d=orig)
        fire("normalise-corpus")
    copy = admin_fetch(corpus_db, "SELECT lifecycle_state, state_reason FROM statutes_staging WHERE id <> :d", d=orig)
    expected = [("duplicate", f"duplicate_of:{orig}")] if ORIGINAL_STATES[state] else [("normalised", None)]
    assert copy == expected, f"original in {state!r}: copy ended {copy}"


# ---------------------------------------------------------------------------------------------
# Bugbot Autofix commits 15216f0, 8323de9, c3bee9d (Monitor, 2026-10-19)
# ---------------------------------------------------------------------------------------------
class _RecordSpecificError(Exception):
    """A database error about the record itself (SQLSTATE class 23), as promotion classifies it."""

    sqlstate = "23514"


def _fail_once_while_another_session_queues_for_the_row(monkeypatch, module_name, func_name, table):
    """The step for the first claimed row raises a record-specific error after another session has
    queued a FOR UPDATE on that row; when the claim's transaction rolls back that session holds the
    row, so the error settlement finds it locked elsewhere."""
    import importlib
    import time

    module = importlib.import_module(module_name)
    real = getattr(module, func_name)
    state = {"held": threading.Event(), "release": threading.Event(), "row": None, "thread": None}

    async def holder(rid):
        from sqlalchemy import text

        engine = holder.db.engine_for(holder.db.url)
        try:
            async with engine.begin() as conn:
                await conn.execute(text(f"SELECT 1 FROM {table} WHERE id = :i FOR UPDATE"), {"i": rid})
                state["held"].set()
                deadline = time.monotonic() + 90
                while not state["release"].is_set() and time.monotonic() < deadline:
                    await asyncio.sleep(0.05)
        finally:
            await engine.dispose()

    async def failing_step(db, row, *, job_id=None):
        if state["row"] is None:
            state["row"] = row.id
            state["thread"] = threading.Thread(target=lambda: asyncio.run(holder(row.id)))
            state["thread"].start()
            # wait until the other session's FOR UPDATE is queued behind this claim
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                waiting = await asyncio.to_thread(
                    admin_fetch, holder.db, "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'")
                if waiting[0][0]:
                    break
                await asyncio.sleep(0.05)
            raise _RecordSpecificError("synthetic F21 record-specific fault")
        return await real(db, row, job_id=job_id)

    monkeypatch.setattr(module, func_name, failing_step)
    return state, holder


def _run_tick_while_held(corpus_db, entry, state, timeout=20):
    out = {}
    worker = threading.Thread(target=lambda: out.setdefault("r", fire(entry)))
    worker.start()
    worker.join(timeout)
    waited = worker.is_alive()
    state["release"].set()
    worker.join(120)
    if state["thread"] is not None:
        state["thread"].join(30)
    return out.get("r"), waited


def test_bugbot_15216f0_dead_letter_settlement_skips_a_row_locked_elsewhere(corpus_db, monkeypatch, caplog):
    """corpus_pipeline._dead_letter_after_error: a row another session holds is left for the next
    tick, not waited on (R4: one stuck row cannot stall a tick)."""
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    _stage_statutes(corpus_db, 2)
    state, holder = _fail_once_while_another_session_queues_for_the_row(
        monkeypatch, "scraper.tasks.normalise", "normalise", "statutes_staging")
    holder.db = corpus_db
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        result, waited = _run_tick_while_held(corpus_db, "normalise-corpus", state)
    assert state["held"].is_set(), "the other session never held the row"
    assert not waited, "the dead-letter settlement waited on a row locked elsewhere"
    assert result.state == "SUCCESS" and result.result["failed"] == 1, result.result
    states = dict(admin_fetch(corpus_db, "SELECT id, lifecycle_state FROM statutes_staging"))
    assert states.pop(state["row"]) == "parsed", "a row locked elsewhere was settled"
    assert list(states.values()) == ["normalised"]
    skipped = [r for r in caplog.records if r.name == "scraper.tasks.corpus_pipeline" and r.getMessage().startswith("lifecycle.dead_letter_skipped")]
    assert len(skipped) == 1 and str(state["row"]) in skipped[0].getMessage() and skipped[0].levelname == "WARNING", \
        [r.getMessage() for r in caplog.records]


def test_bugbot_15216f0_quarantine_settlement_skips_a_row_locked_elsewhere(corpus_db, monkeypatch, caplog):
    """promotion._quarantine_after_error (the gate's settlement): the same rule."""
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    _stage_statutes(corpus_db, 2)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        fire("normalise-corpus")
    state, holder = _fail_once_while_another_session_queues_for_the_row(
        monkeypatch, "scraper.tasks.promotion", "gate", "statutes_staging")
    holder.db = corpus_db
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        result, waited = _run_tick_while_held(corpus_db, "promote-corpus", state)
    assert state["held"].is_set(), "the other session never held the row"
    assert not waited, "the quarantine settlement waited on a row locked elsewhere"
    assert result.state == "SUCCESS" and result.result["failed"] == 1, result.result
    rows = dict((i, (s, q)) for i, s, q in admin_fetch(corpus_db, "SELECT id, lifecycle_state, quarantined FROM statutes_staging"))
    assert rows.pop(state["row"]) == ("normalised", False), "a row locked elsewhere was settled"
    assert list(rows.values()) == [("approved", False)]
    skipped = [r for r in caplog.records if r.name == "scraper.tasks.promotion" and r.getMessage().startswith("promotion.error_quarantine_skipped")]
    assert len(skipped) == 1 and str(state["row"]) in skipped[0].getMessage() and skipped[0].levelname == "WARNING", \
        [r.getMessage() for r in caplog.records]


def _pc_sections(corpus_db, slug):
    return sorted(admin_fetch(corpus_db, "SELECT extracted_section_number, extracted_section_title FROM statutes_staging "
                                         "WHERE source_url LIKE :u", u=f"%/{slug}"))


def test_bugbot_8323de9_pakistancode_stages_parsed_section_numbers(corpus_db, monkeypatch):
    """PakistanCode div sections are staged under their parsed number and title, not the first 20
    characters of their text (which is not a section number and merges sections sharing a prefix)."""
    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        assert harvest("scrape-pakistancode") == {"scrape-pakistancode": "SUCCESS"}
    got = _pc_sections(corpus_db, "ppc1860")
    assert [n for n, _t in got] == ["1", "2"], got
    assert all(t and t.startswith(("Short title", "Definitions")) for _n, t in got), got


class ArticleActFetcher(F21Fetcher):
    async def get(self, url, *args, **kwargs):
        url = str(url)
        if url.endswith("/english/statues/details/ppc1860"):
            page = ("<html><h1>F21 Article Act 2099</h1>"
                    "<div class='section'>Article 5 Rights. Every person has synthetic fixture rights.</div>"
                    "<div class='section'>Article 6 Duties. Every person has synthetic fixture duties.</div></html>")
            return _Resp(page.encode(), url=url)
        return await super().get(url, *args, **kwargs)


def test_bugbot_c3bee9d_pakistancode_falls_back_when_div_sections_have_no_number(corpus_db, monkeypatch):
    """When no div section yields a number (an Article-numbered act), the full-text parser is used."""
    from scraper.net import fetch_policy

    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    monkeypatch.setattr(fetch_policy, "fetcher_for", lambda name, *a, **kw: ArticleActFetcher(name))
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        assert harvest("scrape-pakistancode") == {"scrape-pakistancode": "SUCCESS"}
    got = _pc_sections(corpus_db, "ppc1860")
    assert [n for n, _t in got] == ["Article 5", "Article 6"], got


# ---------------------------------------------------------------------------------------------
# Re-audit round 2 (REAUDIT_PR90_R2.md): FA-F21-006, FA-F21-007, the 15216f0 settlement skip log
# ---------------------------------------------------------------------------------------------
def _pc_page_fetcher(divs, act="F21 Mixed Act 2099"):
    class _PageFetcher(F21Fetcher):
        async def get(self, url, *args, **kwargs):
            url = str(url)
            if url.endswith("/english/statues/details/ppc1860"):
                body = "".join(f"<div class='section'>{d}</div>" for d in divs)
                return _Resp(f"<html><h1>{act}</h1>{body}</html>".encode(), url=url)
            return await super().get(url, *args, **kwargs)
    return _PageFetcher


def _harvest_page(corpus_db, monkeypatch, divs, publish=True):
    from scraper.net import fetch_policy

    prepare(corpus_db)
    install_offline_sources(monkeypatch)
    fetcher = _pc_page_fetcher(divs)
    monkeypatch.setattr(fetch_policy, "fetcher_for", lambda name, *a, **kw: fetcher(name))
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        assert harvest("scrape-pakistancode") == {"scrape-pakistancode": "SUCCESS"}
        if publish:
            for _ in range(3):
                tick()


def _pc_master(corpus_db):
    return dict(admin_fetch(corpus_db, "SELECT section_number, section_text FROM statutes_master WHERE short_name = 'ppc1860'"))


MIXED_DIVS = [
    "Preamble. WHEREAS it is expedient to provide for a synthetic F21 fixture act;",
    "1. Short title. This Act may be called the F21 Mixed Act 2099 (synthetic).",
    "2. Definitions. In this Act words are synthetic fixture text.",
    "Explanation. A synthetic explanation of section 2 for this fixture only.",
    "Sched.",  # 20 characters or fewer: nothing to stage, and the skip is logged
    "THE SCHEDULE (see section 2) synthetic offences table of the fixture",
    "1. Item one of the schedule, a synthetic offence entry of the fixture.",
]


def _sha8(text):
    import hashlib

    return hashlib.sha256(" ".join(text.split()).encode("utf-8")).hexdigest()[:8]


def test_fa_f21_006_numberless_divs_are_staged_under_stable_keys_and_published(corpus_db, monkeypatch, caplog):
    """A Preamble, an Explanation and a Schedule are legal text: each is staged under a key derived from
    its heading word and its own text (FA-F21-008), published, and a div that is still skipped is logged
    with the count."""
    import logging

    with caplog.at_level(logging.INFO, logger="scraper.tasks.pakistancode"):
        _harvest_page(corpus_db, monkeypatch, MIXED_DIVS)
    preamble, one, _two, explanation, _short, schedule, item = MIXED_DIVS
    keys = {"preamble": f"preamble-{_sha8(preamble)}", "explanation": f"explanation-{_sha8(explanation)}",
            "schedule": f"schedule-{_sha8(schedule)}", "one": f"1-{_sha8(one)}", "item": f"1-{_sha8(item)}"}
    staged = sorted(n for n, _t in _pc_sections(corpus_db, "ppc1860"))
    assert staged == sorted([*keys.values(), "2"]), staged
    master = _pc_master(corpus_db)
    assert master[keys["preamble"]].startswith("Preamble. WHEREAS"), master
    assert master[keys["explanation"]].startswith("Explanation. A synthetic"), master
    assert master[keys["schedule"]].startswith("THE SCHEDULE"), master
    assert len(master) == 6, master
    text = caplog.text
    assert "pakistancode.div_skipped" in text and "slug=ppc1860" in text and "position=4" in text, text
    assert "pakistancode.staged slug=ppc1860 numbered=3 numberless=3 skipped=1" in text, text


def test_fa_f21_006_numberless_keys_are_stable_across_harvests(corpus_db, monkeypatch):
    """The same page harvested again gives the same keys (so the copy is a duplicate, not new rows)."""
    _harvest_page(corpus_db, monkeypatch, MIXED_DIVS, publish=False)
    first = sorted(n for n, _t in _pc_sections(corpus_db, "ppc1860"))
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        assert harvest("scrape-pakistancode") == {"scrape-pakistancode": "SUCCESS"}
    assert sorted(n for n, _t in _pc_sections(corpus_db, "ppc1860")) == sorted(first * 2)


DUP_DIVS = ["1. Short title. This Act may be called the F21 Mixed Act 2099 (synthetic).",
            "2. Definitions. In this Act words are synthetic fixture text.",
            "1. Item one of the schedule, a synthetic offence entry of the fixture."]


def test_fa_f21_007_a_repeated_section_number_publishes_two_masters_with_their_own_text(corpus_db, monkeypatch):
    """Two divs numbered 1 in one act get distinct keys, so both texts are published as separate
    statutes_master rows. EVERY occurrence of a repeated number is keyed by its own text (FA-F21-008);
    a number that appears once stays plain."""
    _harvest_page(corpus_db, monkeypatch, DUP_DIVS)
    master = _pc_master(corpus_db)
    first, second = f"1-{_sha8(DUP_DIVS[0])}", f"1-{_sha8(DUP_DIVS[2])}"
    assert sorted(master) == sorted([first, second, "2"]), master
    assert master[first].startswith("1. Short title") and master[second].startswith("1. Item one"), master
    assert dict(admin_fetch(corpus_db, "SELECT lifecycle_state, count(*) FROM statutes_staging "
                                       "WHERE source_url LIKE '%/ppc1860' GROUP BY 1")) == {"embedded": 3}


# FA-F21-008/009: keys are anchored on content, never on position or on a preceding heading.
PROBE_P = "Preamble. Whereas it is expedient to provide synthetic text."
PROBE_X1 = "Explanation. The first explanation of the synthetic fixture."
PROBE_X2 = "Explanation. The second explanation of the synthetic fixture."
PROBE_XN = "Explanation. A NEWLY INSERTED explanation of the fixture text."
PROBE_SCH = "THE FIRST SCHEDULE of synthetic offences in this fixture act"


def _probe_s(n, w):
    return f"{n}. {w} synthetic auditor section text body here."


PROBE_BASE = [PROBE_P, _probe_s(1, "Short"), PROBE_X1, _probe_s(2, "Defs"), PROBE_X2, PROBE_SCH,
              _probe_s(1, "Item"), _probe_s(2, "Item")]
PROBE_CHANGES = {
    "inserted explanation": [PROBE_P, PROBE_XN, *PROBE_BASE[1:]],
    "inserted schedule": [*PROBE_BASE[:5], "SCHEDULE NEW synthetic inserted schedule heading",
                          _probe_s(1, "NewItem"), *PROBE_BASE[5:]],
    "reordered divs": [PROBE_BASE[i] for i in (0, 3, 1, 4, 2, 5, 7, 6)],
}


def _key_map(divs):
    import re

    from bs4 import BeautifulSoup

    from scraper.tasks.pakistancode import _keyed_sections

    soup = BeautifulSoup("".join(f"<div class='section'>{d}</div>" for d in divs), "html.parser")
    return {text: key for key, text, _title, _n in _keyed_sections("ppc1860", soup.find_all("div", class_=re.compile("section")))}


@pytest.mark.parametrize("change", sorted(PROBE_CHANGES))
def test_fa_f21_008_keyprobe_a_page_change_never_changes_another_divs_key(change):
    """The auditor's keyprobe (logs/pr90r3/keyprobe.py) as assertions: every div of the base page keeps
    its key when a div is inserted or the divs are reordered; keys are unique on each page."""
    base, changed = _key_map(PROBE_BASE), _key_map(PROBE_CHANGES[change])
    moved = {text[:30]: (key, changed.get(text)) for text, key in base.items() if changed.get(text) != key}
    assert not moved, moved
    assert len(set(changed.values())) == len(changed), changed


def test_fa_f21_009_a_numberless_body_sentence_never_renames_later_sections():
    """A "Table of ..." or "The form of ..." sentence, or a PART heading, does not re-key real sections."""
    keys = _key_map([_probe_s(1, "Short"), "Table of synthetic rates referred to in section one.",
                     _probe_s(2, "Defs"), "The form of the oath shall be as follows in this act.",
                     "PART II synthetic other part heading", _probe_s(3, "Third")])
    assert sorted(k for k in keys.values() if k[0].isdigit()) == ["1", "2", "3"], keys


@pytest.mark.parametrize("change", sorted(PROBE_CHANGES))
def test_fa_f21_008_reharvest_publishes_every_new_text_once_and_nothing_twice(corpus_db, monkeypatch, change):
    """Publish the base page, re-harvest it changed: no text is published twice and every text on
    the changed page is published."""
    divs = list(PROBE_BASE)
    _harvest_page(corpus_db, monkeypatch, divs)
    divs[:] = PROBE_CHANGES[change]
    with corpus_db.app_engine_as(*corpus_db.runtime_role()):
        assert harvest("scrape-pakistancode") == {"scrape-pakistancode": "SUCCESS"}
        for _ in range(3):
            tick()
    texts = [t for (t,) in admin_fetch(corpus_db, "SELECT section_text FROM statutes_master WHERE short_name = 'ppc1860'")]
    twice = sorted(t[:30] for t in set(texts) if texts.count(t) > 1)
    assert not twice, f"published twice: {twice}"
    missing = sorted(d[:30] for d in divs if d not in texts)
    assert not missing, f"never published: {missing}"


def test_fa_f21_010_a_short_schedule_heading_is_staged():
    """"THE FIRST SCHEDULE" (18 characters) is a heading: it is checked before the short-div skip."""
    keys = _key_map([_probe_s(1, "Short"), "THE FIRST SCHEDULE", _probe_s(2, "Item")])
    assert keys["THE FIRST SCHEDULE"] == f"schedule-{_sha8('THE FIRST SCHEDULE')}", keys


def test_fa_f21_011_the_short_div_boundary_is_20_characters(caplog):
    """A non-heading numberless div of exactly 20 characters is skipped (and logged); 21 is staged."""
    import logging

    twenty, twenty_one = "Lorem ipsum dolor si", "Lorem ipsum dolor sit"
    assert (len(twenty), len(twenty_one)) == (20, 21)
    with caplog.at_level(logging.WARNING, logger="scraper.tasks.pakistancode"):
        keys = _key_map([_probe_s(1, "Short"), twenty, twenty_one])
    assert twenty not in keys and keys[twenty_one] == f"lorem-{_sha8(twenty_one)}", keys
    assert "reason=too_short chars=20" in caplog.text, caplog.text


def test_fa_f21_011_skipped_divs_do_not_count_toward_the_50_div_cap(caplog):
    """Short divs that are skipped leave room for 50 staged divs; the 51st staged div is over the cap."""
    import logging

    divs = ["x" * 5] * 7 + [_probe_s(i, f"Sec{i}") for i in range(1, 52)]
    with caplog.at_level(logging.WARNING, logger="scraper.tasks.pakistancode"):
        keys = _key_map(divs)
    assert sorted(keys.values(), key=int) == [str(i) for i in range(1, 51)], keys
    assert caplog.text.count("reason=over_cap") == 1 and caplog.text.count("reason=too_short") == 7, caplog.text
