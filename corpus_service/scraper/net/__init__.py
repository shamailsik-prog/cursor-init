"""Outbound network access for corpus sources (audit F25).

Every HTTP request a corpus source makes goes through ``scraper.net.fetch_policy``; nothing else
in corpus_service builds an HTTP client (tests/test_f25_fetch_guard.py enforces this).
"""
