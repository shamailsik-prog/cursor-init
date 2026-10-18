"""Audit F25 end to end: a hostile Nasir reporter page cannot make the harvester reach an internal
service, and the harvest of the real source still works.

The flow is the production one: the Celery task the beat schedule fires
(``dispatcher.run_source_job("NasirLawSite")``) -> the dispatcher's trust gate -> the real
``scrape_nasirlawsite`` -> ``scraper_staging`` rows in a fresh real Postgres database (the
``corpus_db`` fixture, CORPUS_TEST_DATABASE_URL). Only the network endpoints are local:

* the "source": an HTTPS server on ``localhost`` (a throwaway CA generated for this run) serving two
  reporter pages, each linking legitimate case pages on the same origin;
* the "internal service": a plain-HTTP server on 127.0.0.1 standing in for a cloud metadata endpoint
  or an internal admin service. It answers with a canary and records every connection and request.

The scmr reporter page also links the internal service by 127.0.0.1 at a metadata-style path, by
``localhost`` on its port, by the decimal literal 2130706433, over https on its port, a userinfo URL
on the source origin, and a source page that 302-redirects to the internal service.

Because both servers are on loopback, the fixed tree needs a test-only boundary: a ``PolicyFetcher``
whose policy allowlists ONLY ``localhost:<source port>``, with the loopback hook for that one origin
and the test CA, substituted for ``fetch_policy.fetcher_for``. Those hooks are explicit constructor
arguments that production code never passes and that are refused outside ENVIRONMENT=development
(spec R11). On a pre-F25 tree (the RED run against main) there is no ``scraper.net.fetch_policy``:
nothing to configure, and the harvest runs exactly as main ships it; main's httpx client trusts the
test CA through SSL_CERT_FILE, which the fixed client ignores (trust_env=False).

Synthetic fixtures only. Needs CORPUS_TEST_DATABASE_URL (see conftest.py).
"""

import asyncio
import logging
import secrets

from f25_servers import RecordingServer, client_tls_context, make_test_pki, serving, server_tls_context
from test_f20_trust_policy_db import assert_migrated, fetch, run

try:  # the F25 boundary; absent on a pre-F25 tree (see the module docstring)
    from scraper.net import fetch_policy
except ImportError:  # pragma: no cover - only on the RED run against a pre-F25 tree
    # ImportError, not only ModuleNotFoundError: a leftover scraper/net/ directory (say, only a
    # __pycache__) is a namespace package, and "cannot import name 'fetch_policy'" is an ImportError.
    fetch_policy = None

CASE_TEXT = "Synthetic F25 fixture judgment {n}. 2099 SCMR {n}01. Not a real judgment."


def _page(body: str):
    return 200, {"Content-Type": "text/html; charset=utf-8"}, body.encode("utf-8")


def _install_test_boundary(monkeypatch, source_port, pki):
    """Fixed tree only: the production factory is replaced by a fetcher that allowlists exactly the
    source origin (https://localhost:<source port>). Everything else, including the internal service
    on the same loopback interface, stays outside the allowlist."""
    if fetch_policy is None:
        return
    policy = fetch_policy.FetchPolicy(
        name="NasirLawSite", hosts=frozenset({"localhost"}), ports=frozenset({source_port})
    )
    tls = client_tls_context(pki)

    def _factory(name, **kwargs):
        assert name == "NasirLawSite", name
        return fetch_policy.PolicyFetcher(
            policy,
            headers=kwargs.get("headers"),
            _test_ssl_context=tls,
            _test_loopback_origins={("localhost", source_port)},
        )

    monkeypatch.setattr(fetch_policy, "fetcher_for", _factory)


def test_f25_nasir_harvest_never_reaches_an_internal_service(corpus_db, monkeypatch, tmp_path, caplog):
    assert_migrated(corpus_db.migrate(), corpus_db)
    pki = make_test_pki(tmp_path / "pki")
    canary = "F25-INTERNAL-CANARY-" + secrets.token_hex(8)

    # No proxy may carry the requests anywhere: CI has none, a developer machine may.
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("SSL_CERT_FILE", str(pki["ca"]))  # main's client (trust_env=True) only

    internal = RecordingServer(
        routes={
            path: _page(f'{{"Code": "Success", "Token": "{canary}"}}')
            for path in (
                "/latest/meta-data/iam/security-credentials/case.htm",
                "/case/admin.htm",
                "/case/decimal.htm",
                "/case/after-redirect.htm",
            )
        }
    )
    with serving(internal):
        ip = internal.port
        source = RecordingServer(tls=server_tls_context(pki))
        sp = source.port
        origin = f"https://localhost:{sp}"
        legit = [f"{origin}/case/2099-scmr-1.htm", f"{origin}/case/2099-pld-2.htm"]
        hostile = {
            "metadata path by 127.0.0.1": f"http://127.0.0.1:{ip}/latest/meta-data/iam/security-credentials/case.htm",
            "internal port by localhost": f"http://localhost:{ip}/case/admin.htm",
            "decimal IP literal": f"http://2130706433:{ip}/case/decimal.htm",
            "https on the internal port": f"https://localhost:{ip}/case/tls.htm",
            "userinfo on the source origin": f"https://f25:f25@localhost:{sp}/case/2099-scmr-userinfo.htm",
            "redirect to the internal service": f"{origin}/case/redirect.htm",
        }
        links = "".join(f'<a href="{u}">case</a>' for u in [legit[0], *hostile.values()])
        source.routes.update(
            {
                "/case/scmr.htm": _page(f"<html><title>F25 SCMR</title><body>{links}</body></html>"),
                "/case/pld.htm": _page(f'<html><title>F25 PLD</title><body><a href="{legit[1]}">case</a></body></html>'),
                "/case/2099-scmr-1.htm": _page(f"<html><body>{CASE_TEXT.format(n=1)}</body></html>"),
                "/case/2099-pld-2.htm": _page(f"<html><body>{CASE_TEXT.format(n=2)}</body></html>"),
                "/case/2099-scmr-userinfo.htm": _page("<html><body>F25 userinfo page</body></html>"),
                "/case/redirect.htm": (302, {"Location": f"http://127.0.0.1:{ip}/case/after-redirect.htm"}, b""),
            }
        )
        with serving(source):
            import scraper.tasks.nasirlawsite as nasirlawsite
            from scraper.tasks.dispatcher import run_source_job

            monkeypatch.setattr(nasirlawsite, "REPORTER_URLS", [f"{origin}/case/scmr.htm", f"{origin}/case/pld.htm"])
            _install_test_boundary(monkeypatch, sp, pki)
            real_sleep = asyncio.sleep

            async def _no_wait(delay=0, result=None):
                return await real_sleep(0, result)

            monkeypatch.setattr(asyncio, "sleep", _no_wait)

            with caplog.at_level(logging.INFO):
                run_source_job("NasirLawSite")  # the Celery task, run in-process

    # (a) The internal service was never contacted: no TCP connection, no HTTP request.
    reached = [f"{r['method']} {r['path']}" for r in internal.requests]
    assert internal.connections == 0 and not reached, (
        f"the harvest reached the internal service: {internal.connections} connection(s), requests {reached}"
    )

    rows = run(fetch("SELECT source_url, coalesce(raw_html, ''), coalesce(raw_text, '') FROM scraper_staging"))
    # (b) Nothing internal, userinfo-bearing or redirected was staged.
    assert not [u for u, html, text in rows if canary in html or canary in text], "internal content was staged"
    assert not [u for u, _, _ in rows if f":{ip}" in u or "@" in u or "2130706433" in u or u.endswith("/redirect.htm")], rows
    # (c) The harvest still works: exactly the two legitimate case pages, with their text.
    staged = {u: text for u, _, text in rows}
    assert sorted(staged) == sorted(legit), sorted(staged)
    assert "Synthetic F25 fixture judgment 1" in staged[legit[0]]
    assert "Synthetic F25 fixture judgment 2" in staged[legit[1]]
    paths = [r["path"] for r in source.requests]
    assert "/case/2099-scmr-userinfo.htm" not in paths, paths

    # (d) Every hostile link was refused and logged with its reason (userinfo redacted).
    refusals = [r.getMessage() for r in caplog.records if "F25 fetch boundary refused" in r.getMessage()]
    for label, url in hostile.items():
        shown = url.replace("f25:f25@", "***@")
        assert any(shown in m or (label.startswith("redirect") and f"/case/after-redirect.htm" in m) for m in refusals), (
            f"{label}: no refusal logged for {shown}; refusals: {refusals}"
        )
    assert not [m for m in refusals if "f25:f25" in m], "a credential reached the log"
