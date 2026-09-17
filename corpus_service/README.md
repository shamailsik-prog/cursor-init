# Corpus Service (separate harvest tree)

Standalone Pakistani legal corpus harvester. It is **not** part of the SIKANDER AI
application runtime (Layer 17 N1 / L17.12 / Gate G-0 scraper-guard).

Governing build prompt: `FINAL_CORPUS_SERVICE_PROMPT_2.md` (supersedes withdrawn
`FINAL_SCRAPER_PROMPT_1`).

## Source policy (FINAL_2)

1. Public government portals — polite HTTP / Playwright, robots.txt respected.
2. Open non-governmental sites — full provenance, `review` trust until verified.
3. Subscription databases (e.g. PakistanLawSite) — **licensed API** or **import
   folder only**. Login-form scraping is disabled (`ALLOW_LOGIN_SCRAPING=false`,
   non-overridable in production).
4. No legal rules of decision live here — corpus storage only.

## Quick start (no Docker)

```bash
cd corpus_service
python3 -m pip install --user httpx beautifulsoup4 lxml
python3 bootstrap_harvest.py
```

Writes PDFs/HTML + provenance JSONL under `live/` (gitignored).

Public bootstrap sources:

- Pakistan Code (`pakistancode.gov.pk`) — federal statutes
- Nasir Law Site (`nasirlawsite.com`) — open pages, trust=`review`
- National Assembly acts index — PDFs when linked

## Full stack (when Docker is available)

```bash
cp .env.example .env   # fill secrets; leave ALLOW_LOGIN_SCRAPING=false
docker compose up -d --build
```

Dashboard / API come from the FastAPI app in `scraper/`.
Celery beat includes Lahore High Court public judgment harvesting
(`LahoreHighCourt`) alongside the existing SHC/Supreme Court jobs.

## App-repo boundary

- `corpus_service/` is skipped by `ci_gates/check_fetch_allowlist.py`.
- Playwright remains banned under `services/`, `platform/`, `core/`, etc.
- Application DB remains read-only against the Annex A corpus contract.
