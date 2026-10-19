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
