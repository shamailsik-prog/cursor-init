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

## Trust levels (audit F20)

`scraper_sources.trust_level` is exactly one of `trusted`, `review` or `blocked`, default `review`
(FINAL_2 :252-253). The vocabulary and every decision below live in `scraper/trust.py`; the
database CHECK and default are built from it. Matching is exact, and anything else fails closed.

| Source trust | `staging` routes (dispatcher) | `direct` routes: PakistanCode, NationalAssembly (dispatcher) | Staged record at promotion |
|---|---|---|---|
| `trusted` | run | run (they write `statutes_master` themselves) | promoted if confidence >= 0.5 (or attached, if its citation is already published), else quarantined `low_confidence` |
| `review` | run | skipped (FINAL_2 :897: a review source's output is always quarantined, and these write no staging row) | quarantined `review_source` |
| `blocked` | skipped | skipped | quarantined `blocked_source` |
| any other value, or a missing, deleted or renamed source | skipped | skipped | quarantined `unknown_source` |

**Dispatcher routes.** Every entry in `scraper/tasks/dispatcher.py` `ROUTES` declares its kind:
`staging` (writes `scraper_staging` only; promotion decides later) or `direct` (writes a master table
itself). Every `direct` route runs only for a `trusted` source. A route with no kind, or any other
kind, is refused and logged. `tests/test_trust_policy.py` scans all of `scraper/` with Python's AST
(import aliases resolved) for any reference to `CaseLawMaster` / `StatutesMaster` and any write SQL
naming `case_law_master` / `statutes_master` (schema-qualified or not); every module it finds must be
a `direct` route module or on the reviewed allowlist in that test: promotion, the F23 quarantine
router, embeddings and cross_reference write; main (`/health`), search and export only read.

Every staging row a harvester writes carries its source: `source_id` plus
`parsing_metadata.source_id` and `parsing_metadata.source_name` (`scraper/source_identity.py`).
`source_id` is `ON DELETE SET NULL`; the stamped id still names the source after a delete. The six
court harvesters (SHC, SC, LHC, PHC, BHC, IHC) also write their rows already quarantined
(`quarantine_reason` `review source`), so promotion never selects them; NasirLawSite rows wait for
normalisation, which nothing schedules yet (audit F21).

Promotion (`scraper/tasks/promotion.py`) decides each normalised record in this order:

1. **Source.** Only the most specific identifier present is used: `source_id`, else
   `parsing_metadata.source_id`, else `parsing_metadata.source_name`, else `source_site`. If that
   identifier no longer resolves (deleted, renamed, malformed) the source is unknown; it never falls
   through to a less specific label such as a court family's shared `source_site`.
2. **Citation.** None or blank: quarantined `citation_missing`.
3. **Trust.** The table above: `review_source`, `blocked_source`, `unknown_source` or `low_confidence`.
4. **Duplicate.** FINAL_2 DEDUPLICATION ("attach ... to the existing judgment row and skip the
   rest"): a promotable record whose citation is already in `case_law_master` is *attached*. Its
   `promoted_to_id` points at the existing row and it is closed (`promoted`, `promoted_at`); no
   second master row, no embedding, no review-queue row. `case_law_master` has one citation per row
   and no column for a judgment's other citations, so the link is the attachment. The check runs
   under a per-citation advisory lock, so concurrent runs cannot both publish one citation.
5. Otherwise promoted: a `case_law_master` row, an `embedding_queue` row, and `promoted`,
   `promoted_at`, `promoted_to_id` on the staging row.

Each record is re-read `FOR UPDATE` and decided in its own transaction. A record whose promotion
raises is rolled back and counted as failed. Only a failure confirmed to be about the record itself,
a database error with SQLSTATE class 22 (data exception) or 23 (integrity constraint violation),
quarantines it `promotion_error:<ExceptionClass>` (class name only, never the message) so it is not
retried forever; if even that write fails, the failure is logged and the record stays pending. Every
other failure leaves the record pending for the next run:
- a transient database error (connection lost, or SQLSTATE class 08, 40, 53 or 57, or 55P03);
- a systemic or unknown one: permission (42501), schema drift (42P01, 42703), an internal error
  (XX000), a generic RAISE (P0001), any other SQLSTATE, or a Python exception with none. These may be
  a deployment or schema fault that would hit every record, so the backlog must survive it. They are
  logged at error level with the id, class and SQLSTATE and `systemic=true`, never row data.

After three consecutive systemic failures with the same SQLSTATE (or exception class)
(`SYSTEMIC_FAILURE_LIMIT`), the run stops early and leaves the rest pending; any other outcome in
between resets the count. Otherwise the rest of the batch always continues. Every quarantine reason is
written to the staging row's `quarantine_reason` and to a `quarantine_queue` row. The run returns
`{"promoted", "attached", "quarantined", "failed"}`, plus `"aborted": "systemic:<SQLSTATE or class>"`
when it stopped early. A record that raised counts as failed whether it was left pending or
quarantined `promotion_error`. A record that always raises a systemic or unknown error stays pending
and is retried on every run; there is no retry cap yet (F28).

Seeds: PakistanLawSite, PakistanCode and NationalAssembly are `trusted`; every other source is
`review`.

**Upgrading an existing database.** `python -m scraper.migrate` (the `migrate` service, as
`MIGRATE_DB_USER`) replaces the pre-F20 CHECK (`trusted|semi_trusted|untrusted|quarantined`, default
`trusted`), maps `semi_trusted`, `untrusted`, `quarantined` and any other value to `review`, and sets
the default to `review`, all before it seeds. It is idempotent: when `ck_trust_level_values` is
validated and identical to PostgreSQL's own rendering of the F20 CHECK, and the default is exactly
`review`, it changes nothing. Any other same-named CHECK (NOT VALID, or a different body such as
`... OR trust_level IS NOT NULL`) or any other default (`'trusted'`, none) is replaced. The
comparison builds the expected CHECK on a throwaway table in `scraper_sources`' own schema (`public`)
inside a savepoint that is always rolled back, so the migration role needs CREATE on that schema,
which it has, and no TEMP. Because of that probe, running `python -m scraper.migrate` as the
DML-only runtime role exits 1 even on a current database: only the `migrate` service runs it. The
API's startup `init_db()` never runs any of this: it is DDL, and the runtime role is DML-only. A row
the old default made `trusted` stays `trusted`, so review the `trusted` sources after upgrading.

**Tests.** `tests/test_f20_trust_policy_db.py` and `tests/test_f20_harvesters_db.py` run against a
real Postgres 16 + pgvector named by `CORPUS_TEST_DATABASE_URL` (a `postgresql+asyncpg://` URL for a
role that can create databases, roles and extensions, such as a throwaway `pgvector/pgvector:pg16`
container's superuser). Each test creates and drops its own database. Without the URL, those tests
skip locally and the run fails under CI.

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
cp .env.example .env   # fill the store and app secrets (non-secret settings live in app.env)
python3 ../ci_gates/check_compose_policy.py docker-compose.yml   # needs PyYAML + docker compose
docker compose up -d --build
```

### Data-store security (audit F30)

**Secrets and who gets them.** `.env` holds the store credentials (`POSTGRES_USER/PASSWORD`,
`APP_DB_USER/PASSWORD`, `MIGRATE_DB_USER/PASSWORD`, `REDIS_APP_USER/PASSWORD`) and the app
secrets (`ENCRYPTION_KEY`, `ADMIN_API_KEY`, `SECRET_KEY`, optional `OPENAI_API_KEY`); see
`.env.example`. Compose reads `.env` **only** to fill the `${VAR}` references in
`docker-compose.yml`; no service uses it as an `env_file`, and `.dockerignore` keeps it out of the
image. Each container gets only what it uses:

| Container | Store credentials it receives |
|---|---|
| `api`, `worker-embed`, `celery-beat` | runtime role (`APP_DB_*`) inside `DATABASE_URL`, Redis ACL user inside `REDIS_URL` |
| `migrate` (one-shot) | migration role (`MIGRATE_DB_*`) inside `DATABASE_URL`; no Redis |
| `worker-a`, `worker-b` (idle seats) | none (and no data-network access) |
| `postgres` | `POSTGRES_USER`, `APP_DB_USER`, `MIGRATE_DB_USER`; the three passwords as files under `/run/secrets` |
| `redis` | its ACL rules (on the command line) and its password as a `/run/secrets` file |
| `secrets-preflight` (one-shot, no network) | the four store passwords as files, to check them |

Non-secret app settings (`ENVIRONMENT=production`, log level, CORS, scraper tuning) live in the
committed `app.env`, which must never hold a credential. Compose refuses to start unless every
credential is set, and the `secrets-preflight` one-shot refuses to let the stores start unless
each store password is at least 16 URL-safe characters (`openssl rand -hex 24`), not a known
default, and all four differ.

- **No exposure.** Postgres and Redis publish no host ports and sit on an internal-only
  network; the API binds to `127.0.0.1` (put a TLS reverse proxy in front).
- **TLS only.** The one-shot `certs` service issues a private CA and server certificates
  (`DNS:postgres`, `DNS:redis`) into the `tls-*` volumes on first start and keeps them while
  valid; the CA key is discarded after signing. Postgres runs `ssl=on` with
  `docker/postgres/pg_hba.conf` (TLS + SCRAM only, `hostnossl` rejected); Redis runs with
  `--port 0 --tls-port 6379`. Every client verifies the server certificate and hostname:
  `DATABASE_URL` carries `sslmode=verify-full&sslrootcert=/run/tls-ca/ca.crt` and the app's
  asyncpg context trusts **only** that CA; Celery's broker and result backend use `rediss://`
  with `REDIS_TLS_CA_FILE`, which redis-py loads **in addition to** the system trust store (a
  public CA cannot issue a certificate for the single-label name `redis`, but see the residual
  notes in the F30 report). In production/staging the service refuses a `DATABASE_URL` without
  `verify-full`, a non-`rediss://` `REDIS_URL`, a weak or reused Redis password, and any
  `ssl_*` URL parameter that would weaken Redis verification.
- **Least privilege.** The bootstrap superuser is used only by the image's init and by
  `scripts/rotate_postgres_password.sh`, over the container's local socket; it cannot log in over
  the network. The one-shot `migrate` service creates the schema as `MIGRATE_DB_USER` (schema
  owner); api, worker-embed and beat run as `APP_DB_USER`, which has SELECT/INSERT/UPDATE/DELETE
  only (no DDL, no CREATE on the database or schema, no extension, role, system or large-object
  changes). Redis's `default` user is disabled; the app's ACL user has no `@admin`/`@dangerous`
  commands, cannot flush scripts/functions, and cannot switch databases.
- **Policy before every deployment.** `python3 ../ci_gates/check_compose_policy.py
  docker-compose.yml` checks the deployment as `docker compose config` resolves it, **merged with
  any `docker-compose.override.yml` next to it** (compose loads that file automatically), with all
  profiles enabled. It refuses `include:`/`extends:`, unknown services, store images given by
  variable or built from the repository (a store is recognised by its image, its Dockerfile's
  `FROM`, or its service name), Postgres server options outside a fixed allowlist (exactly the
  ones this file sets) or passed through `PGOPTIONS`/`POSTGRES_INITDB_ARGS`, `pg_hba.conf` lines
  that accept a TCP login other than `hostssl` + `scram-sha-256` or for anyone but the
  `+corpus_clients` group, Redis ACL users that are enabled without exactly one required password
  (`nopass`, a second password, a password removed again) or that no app connects as, app images
  whose build ignore file lets `.env` in (read the way Docker reads it: the last matching line
  wins, `!` re-includes), and app containers that can reach a store credential, secret or volume
  they do not use, publish a port other than the api's loopback bind, or get host access
  (`privileged`, `cap_add`, devices, host or shared namespaces, binds from outside the
  repository). Network-isolated one-shots are checked too: one that holds a store credential
  (`secrets-preflight`) or a store's files (`certs`) taints all of its storage, and the taint
  passes to every other one-shot that shares any of that storage, hop after hop; no app may mount
  tainted storage (the CA volume, read-only, is the one exception). A one-shot that holds a store
  credential, directly or through that chain, may not mount the CA volume at all, so only a
  one-shot without one (`certs`) writes what apps read there. Only a known store image with no
  network is such a one-shot; a repository build or unknown image is checked as an app or refused.
  It is a guard over this compose file, not a proof of safety: it does not vet, for example, the
  Redis TLS protocol options, the host's `.env` (`COMPOSE_FILE`), or what the repository's own
  scripts and images do. Its findings name the rule, service, key or variable and never print a
  value from the files (a value it must point at shows as `<redacted>`, a required variable as
  `${VAR}`), so its output is safe in CI logs; a file it cannot read or parse is a
  `compose-config` finding naming the file, error class and line, never a traceback. CI runs it
  on the repository; run it on the deployment host too, after adding an override.
- **Your own certificates.** Bind the three TLS volumes to host directories holding
  `ca.crt`, `postgres/server.{crt,key}` and `redis/server.{crt,key}` (server certs must name
  `postgres` / `redis` and chain to `ca.crt`), and set `TLS_CERTS_MODE=external`; the `certs`
  service then only validates them and fixes key ownership (uid 999, mode 0600), and fails
  instead of generating anything. Example `docker-compose.override.yml` (re-run the policy
  afterwards; it checks the merged result):

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
  stop the stack, set the values in `.env` (keep `POSTGRES_USER` as the existing role name),
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
