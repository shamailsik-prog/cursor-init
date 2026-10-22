"""Audit F20 re-audit round 1 (PR #48): harvesters, end to end against real Postgres.

The real dispatcher (`_run_async`) runs the real harvesters; only the network is replaced: the fetch
boundary's client factory (`scraper.net.fetch_policy.fetcher_for`, audit F25; before F25 this
replaced httpx.AsyncClient, which no connector builds any more), each court module's listing
discovery, PDF text extraction (audit F26: the sandbox's ``pdf_sandbox.parse``) and the politeness
sleeps.

* MEDIUM-1: every staging row a harvester writes carries the scraper_sources row it came from
  (source_id plus parsing_metadata source_id / source_name), so promotion never resolves it by a
  family label - even after that source is deleted (source_id is ON DELETE SET NULL).
* MEDIUM-2: PakistanCode and NationalAssembly write statutes_master directly, bypassing promotion;
  FINAL_CORPUS_SERVICE_PROMPT_2.md :897 ("Review source -> always quarantine") means only a
  trusted source may run them.

Needs CORPUS_TEST_DATABASE_URL (see conftest.py).
"""

import asyncio
import logging

import pytest

from test_f20_trust_policy_db import _promote, assert_migrated, execute, fetch, run

PDF = b"%PDF-1.4 synthetic F20 fixture, not a real judgment"
NASIR_REPORTERS = {
    "https://www.nasirlawsite.com/case/scmr.htm",
    "https://www.nasirlawsite.com/case/pld.htm",
    "https://www.nasirlawsite.com/case/clc.htm",
    "https://www.nasirlawsite.com/case/ylr.htm",
    "https://www.nasirlawsite.com/case/mld.htm",
}

# Every source name the dispatcher routes to a staging harvester -> its module.
STAGING_ROUTES = {
    "NasirLawSite": "nasirlawsite",
    "SindhHighCourt": "shc",
    "SindhHighCourtPublic": "shc",
    "SupremeCourt": "supremecourt",
    "SupremeCourtPublic": "supremecourt",
    "LahoreHighCourt": "lahorehighcourt",
    "PeshawarHighCourt": "peshawarhighcourt",
    "PeshawarHighCourtPublic": "peshawarhighcourt",
    "BalochistanHighCourt": "balochistanhighcourt",
    "BalochistanHighCourtPublic": "balochistanhighcourt",
    "IslamabadHighCourt": "islamabadhighcourt",
    "IslamabadHighCourtPublic": "islamabadhighcourt",
}
COURT_MODULES = sorted(set(STAGING_ROUTES.values()) - {"nasirlawsite"})


class _Resp:
    def __init__(self, body: bytes, status: int = 200, url: str = ""):
        self.status_code = status
        self.content = body
        self.text = body.decode("latin-1")
        self.headers = {}
        self.url = url


class FakeFetcher:
    """Stands in for the fetch boundary's client (``fetch_policy.fetcher_for(name)``). Each listing
    links one synthetic document; every PDF is a stub. Nothing leaves the process. ``allows`` is
    the source's real registered policy."""

    def __init__(self, name, *args, **kwargs):
        from scraper.net import fetch_policy

        self.policy = fetch_policy.policy_for(name)

    def allows(self, url):
        return self.policy.allows(url)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, *args, **kwargs):
        url = str(url)
        if url.lower().endswith(".pdf"):
            return _Resp(PDF, url=url)
        if "pakistancode.gov.pk" in url:
            if url.endswith("/federal"):
                return _Resp(b"<html></html>", url=url)
            return _Resp(b"<html><h1>Test Act 2099</h1><div class='section'>1. Short title. This Act may be "
                         b"called the Test Act 2099 (synthetic F20 fixture).</div></html>", url=url)
        if "na.gov.pk" in url:
            return _Resp(b"<html><a href='/uploads/test-act-2099.pdf'>Test Act 2099</a></html>", url=url)
        if url in NASIR_REPORTERS:
            return _Resp(b"<html><title>F20 fixture</title><a href='f20-fixture-case.htm'>case</a></html>", url=url)
        return _Resp(b"<html><body>Synthetic F20 fixture judgment text.</body></html>", url=url)


def install_offline_harvesters(monkeypatch):
    from scraper.net import fetch_policy
    from scraper.parsers import pdf_sandbox

    monkeypatch.setattr(fetch_policy, "fetcher_for", lambda name, *a, **kw: FakeFetcher(name))
    # Audit F26: every PDF goes through scraper.tasks.pdf_intake (fetch, checks, raw store) to the
    # sandbox's parse(); the stub replaces only the parse. One synthetic text serves every harvester:
    # the courts stage it, National Assembly splits it into sections of more than 100 characters.
    monkeypatch.setattr(
        pdf_sandbox, "parse",
        lambda path, sha256, size, **kw: pdf_sandbox.ParseResult(
            text=("Section one of the synthetic Test Act 2099. " * 4) + "\n\n" + ("Section two. " * 12),
            pages=1, ocr_applied=False,
        ),
    )
    real_sleep = asyncio.sleep

    async def _no_wait(delay=0, result=None):
        return await real_sleep(0, result)

    monkeypatch.setattr(asyncio, "sleep", _no_wait)
    for module in COURT_MODULES:
        mod = __import__(f"scraper.tasks.{module}", fromlist=["_discover_pdf_urls"])
        url = f"https://f20.example.invalid/{module}/judgment-1.pdf"
        provenance = (
            {"listing_url": f"https://f20.example.invalid/{module}/list", "feed_url": None, "discovery_method": "f20-fixture"}
            if module == "islamabadhighcourt" else f"https://f20.example.invalid/{module}/list"
        )

        async def _discover(*args, _url=url, _prov=provenance, **kwargs):
            return [_url], {_url: _prov}

        monkeypatch.setattr(mod, "_discover_pdf_urls", _discover)


def _source_ids():
    return {name: sid for sid, name in run(fetch("SELECT id, source_name FROM scraper_sources"))}


def test_f_every_staging_harvester_stamps_the_source_it_ran_for(corpus_db, monkeypatch):
    """MEDIUM-1(b): all 7 staging harvesters, through all 12 source names routed to them."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    install_offline_harvesters(monkeypatch)
    from scraper.tasks.dispatcher import _run_async

    ids = _source_ids()
    problems = {}
    for name in STAGING_ROUTES:
        run(execute("DELETE FROM scraper_staging"))
        run(_run_async(name))
        rows = run(fetch("SELECT source_id, parsing_metadata, source_site FROM scraper_staging"))
        if not rows:
            problems[name] = "no staging row written"
            continue
        for source_id, metadata, site in rows:
            metadata = metadata or {}
            got = (source_id, metadata.get("source_id"), metadata.get("source_name"))
            want = (ids[name], str(ids[name]), name)
            if got != want:
                problems[name] = {"got": got, "want": want, "source_site": site}
    assert not problems, problems


def test_f_a_harvested_record_of_a_deleted_source_is_unknown_even_if_the_name_returns_as_trusted(corpus_db, monkeypatch):
    """MEDIUM-1 end to end: NasirLawSite (review) harvests; the source is deleted (source_id -> NULL)
    and a trusted source is created under the same name. The stamped source_id still identifies the
    deleted source, so nothing is promoted."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    install_offline_harvesters(monkeypatch)
    from scraper.tasks.dispatcher import _run_async

    run(_run_async("NasirLawSite"))
    staged = run(fetch("SELECT count(*) FROM scraper_staging"))[0][0]
    assert staged >= 1
    run(execute(
        "UPDATE scraper_staging SET normalised = true, confidence_score = 0.9, "
        "extracted_citation = 'F20 FIXTURE ' || id::text",
        "DELETE FROM scraper_sources WHERE source_name = 'NasirLawSite'",
        "INSERT INTO scraper_sources (source_name, source_url, trust_level) "
        "VALUES ('NasirLawSite', 'https://f20.example.invalid/impostor', 'trusted')",
    ))
    assert run(fetch("SELECT count(*) FROM scraper_staging WHERE source_id IS NULL"))[0][0] == staged

    result = _promote()

    assert run(fetch("SELECT count(*) FROM case_law_master"))[0][0] == 0
    reasons = run(fetch("SELECT quarantine_reason, count(*) FROM scraper_staging GROUP BY 1"))
    assert reasons == [("unknown_source", staged)], reasons
    assert result == {"promoted": 0, "attached": 0, "quarantined": staged, "failed": 0}


def test_f_direct_publishers_write_master_rows_only_for_a_trusted_source(corpus_db, monkeypatch, caplog):
    """MEDIUM-2: statutes reach statutes_master only for a trusted source. A review or unknown source
    publishes nothing; a trusted one does.

    Changed by audit F21 (spec R12): PakistanCode and NationalAssembly no longer write statutes_master
    themselves; they stage statutes, and the corpus lifecycle (normalise, the review gate, publish)
    publishes them. The harvest itself must write no master row for any trust value; what reaches
    statutes_master after the lifecycle has run is what this test pinned before, unchanged."""
    assert_migrated(corpus_db.migrate(), corpus_db)
    install_offline_harvesters(monkeypatch)
    from scraper.tasks.corpus_pipeline import run_tick
    from scraper.tasks.dispatcher import _run_async

    def rows_written(name, trust):
        run(execute(
            "DELETE FROM statutes_master",
            "DELETE FROM quarantine_queue",
            "DELETE FROM statutes_staging",
            "UPDATE scraper_sources SET trust_level = :t WHERE source_name = :n",
            params={"t": trust, "n": name},
        ))
        with caplog.at_level(logging.INFO):
            run(_run_async(name))
        harvested = run(fetch("SELECT count(*) FROM statutes_master"))[0][0]
        assert harvested == 0, f"{name} ({trust}) wrote statutes_master during the harvest"
        for consumer in ("normalise", "promote", "publish"):
            run(run_tick(consumer))
        return run(fetch("SELECT count(*) FROM statutes_master WHERE source_site = :n", n=name))[0][0]

    got = {}
    for name in ("PakistanCode", "NationalAssembly"):
        got[(name, "review")] = rows_written(name, "review")
        got[(name, "blocked")] = rows_written(name, "blocked")
        got[(name, "trusted")] = rows_written(name, "trusted")
    # Unknown values need the CHECK gone (a drifted or un-migrated database).
    run(execute("ALTER TABLE scraper_sources DROP CONSTRAINT ck_trust_level_values"))
    for name in ("PakistanCode", "NationalAssembly"):
        got[(name, "TRUSTED")] = rows_written(name, "TRUSTED")
        got[(name, "semi_trusted")] = rows_written(name, "semi_trusted")

    published = {key: count > 0 for key, count in got.items()}
    assert published == {
        ("PakistanCode", "review"): False, ("PakistanCode", "blocked"): False, ("PakistanCode", "trusted"): True,
        ("NationalAssembly", "review"): False, ("NationalAssembly", "blocked"): False, ("NationalAssembly", "trusted"): True,
        ("PakistanCode", "TRUSTED"): False, ("PakistanCode", "semi_trusted"): False,
        ("NationalAssembly", "TRUSTED"): False, ("NationalAssembly", "semi_trusted"): False,
    }, got
    # Audit F21: blocked and unknown sources are not harvested at all (F20's may_harvest); a review
    # source's statutes are harvested and held at the review gate (was: the direct route skipped them).
    skips = [r.getMessage() for r in caplog.records if "is not harvestable, skip" in r.getMessage()]
    assert any(m.startswith("PakistanCode ") for m in skips) and any(m.startswith("NationalAssembly ") for m in skips), skips
