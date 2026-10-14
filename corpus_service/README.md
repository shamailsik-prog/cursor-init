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

### Data-store security (audit F30)

`docker-compose.yml` refuses to start unless all eight store credentials are set
(`POSTGRES_USER/PASSWORD`, `APP_DB_USER/PASSWORD`, `MIGRATE_DB_USER/PASSWORD`,
`REDIS_APP_USER/PASSWORD`; see `.env.example`). Use unique, URL-safe values
(`openssl rand -hex 24`).

- **No exposure.** Postgres and Redis publish no host ports and sit on an internal-only
  network; the API binds to `127.0.0.1` (put a TLS reverse proxy in front).
- **TLS only.** The one-shot `certs` service issues a private CA and server certificates
  (`DNS:postgres`, `DNS:redis`) into the `tls-*` volumes on first start and keeps them while
  valid; the CA key is discarded after signing. Postgres runs `ssl=on` with
  `docker/postgres/pg_hba.conf` (TLS + SCRAM only, `hostnossl` rejected); Redis runs with
  `--port 0 --tls-port 6379`. Every client verifies the server certificate and hostname against
  the CA: `DATABASE_URL` carries `sslmode=verify-full&sslrootcert=/run/tls-ca/ca.crt`, Celery's
  broker and result backend use `rediss://` with `REDIS_TLS_CA_FILE`. In production/staging the
  service refuses a `DATABASE_URL` without `verify-full` or a non-`rediss://` `REDIS_URL`.
- **Least privilege.** The bootstrap superuser is used only by the image's init and by
  `scripts/rotate_postgres_password.sh`, over the container's local socket; it cannot log in over
  the network. The one-shot `migrate` service creates the schema as `MIGRATE_DB_USER` (schema
  owner); api, workers and beat run as `APP_DB_USER`, which has SELECT/INSERT/UPDATE/DELETE only
  (no DDL, no CREATE on the database or schema, no extension, role or system changes). Redis's
  `default` user is disabled; the app's ACL user has no `@admin`/`@dangerous` commands.
- **Your own certificates.** Bind the three TLS volumes to host directories holding
  `ca.crt`, `postgres/server.{crt,key}` and `redis/server.{crt,key}` (server certs must name
  `postgres` / `redis` and chain to `ca.crt`), and set `TLS_CERTS_MODE=external`; the `certs`
  service then only validates them and fixes key ownership (uid 999, mode 0600), and fails
  instead of generating anything. Example `docker-compose.override.yml`:

  ```yaml
  volumes:
    tls-ca:       {driver: local, driver_opts: {type: none, o: bind, device: /etc/corpus-tls/ca}}
    tls-postgres: {driver: local, driver_opts: {type: none, o: bind, device: /etc/corpus-tls/postgres}}
    tls-redis:    {driver: local, driver_opts: {type: none, o: bind, device: /etc/corpus-tls/redis}}
  ```
- **Certificate renewal.** Server certificates are re-issued (with a new CA) when within 30 days of
  expiry on the next `docker compose up`; run `docker compose up -d --force-recreate` so every
  container reloads the new CA.
- **Upgrading an existing install** (data volume created before F30, e.g. with `legal/legal`):
  stop the stack, set the eight values in `.env` (keep `POSTGRES_USER` as the existing role name),
  run `./scripts/rotate_postgres_password.sh`, then `docker compose up -d`. The script enables TLS
  on the old volume, re-hashes the superuser password as SCRAM, creates or updates the two roles,
  moves existing application tables to the migration role and grants the runtime role DML only.

Policy: `ci_gates/check_compose_policy.py`. End-to-end proof (also runnable locally with Docker):
`tests/e2e/store_security_e2e.sh` and `tests/e2e/upgrade_e2e.sh`, run by
`.github/workflows/corpus-compose-policy.yml`.

Dashboard / API come from the FastAPI app in `scraper/`.
Celery beat includes Lahore High Court public judgment harvesting
(`LahoreHighCourt`) and a broadened Sindh High Court public stream
(`SindhHighCourtPublic`), plus a Supreme Court public stream
(`SupremeCourtPublic`) and a Peshawar High Court public stream
(`PeshawarHighCourtPublic`), a Balochistan High Court public stream
(`BalochistanHighCourtPublic`), and an Islamabad High Court public stream
(`IslamabadHighCourtPublic`).

Sindh High Court harvesting now discovers judgment/order PDFs from public SHC
listing pages (`sindhhighcourt.gov.pk`), keeps allowlisted domains only, and
stages all extracted text as quarantined/review-first records.

Supreme Court harvesting now uses allowlisted, multi-page discovery on current
public listing endpoints (`latest-judgements`, `judgement-search`,
`online-case-status`, `downloads_judgements`, and sitemap links) and only
stages files that pass a `%PDF` signature check, with review-first quarantine
and listing-page provenance metadata.

Peshawar High Court harvesting now uses allowlisted, multi-page discovery on
official PHC listing pages (`app/site` case-law sections plus
`PHCCMS/reportedJudgments.php`), extracts PDF URLs from anchors and inline
script markup, and stages only `%PDF`-signature documents as quarantined
review-first records with listing-page provenance metadata.

Balochistan High Court harvesting now uses allowlisted, multi-page discovery
across `bhc.gov.pk` judgment listings (including justice/year subpages on
`resources/judgments`) and the official portal judgment host, extracts PDF URLs
from anchors, anchor `data-*` attributes, and inline markup/script URLs, and
stages only `%PDF`-signature documents as quarantined review-first records with
listing-page provenance metadata.

Islamabad High Court harvesting now combines allowlisted, multi-page discovery
across `ihc.gov.pk` and `mis.ihc.gov.pk` listing pages with AJAX-feed discovery
from the public `ihc.asmx/GetLatestJgmntsNew` endpoint, extracts case-law PDF
URLs from anchors, anchor `data-*` attributes, inline markup/script URLs, and
feed payload attachments, and stages only `%PDF`-signature documents as
quarantined review-first records with listing/feed provenance metadata.

## App-repo boundary

- `corpus_service/` is skipped by `ci_gates/check_fetch_allowlist.py`.
- Playwright remains banned under `services/`, `platform/`, `core/`, etc.
- Application DB remains read-only against the Annex A corpus contract.
