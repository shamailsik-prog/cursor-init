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
router, embeddings and cross_reference write; main (`/health`) and `scraper/public_corpus.py` (the
published-only reads behind search and export, audit F24) only read.

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
4. **Publication (audit F19).** A promotable record is published into the Annex A contract as one
   audited publication, under a per-citation advisory lock keyed by the canonical citation (so
   concurrent runs never publish one citation at once, and "PLD 2099 Karachi 12" and
   "PLD 2099 Sindh 12" take the same lock). The publication decides an already published citation,
   following FINAL_2 DEDUPLICATION ("attach ... to the existing judgment row and skip the rest") in
   Annex A terms:
   - identical content (`unchanged`) is *attached*: `promoted_to_id` points at the existing Annex A
     judgment and the record is closed (`promoted`, `promoted_at`), with nothing rewritten and no
     review-queue row; it counts as `attached`;
   - changed trusted content is `updated` onto the same judgment and counts as `promoted`;
   - a re-scrape that would be quarantined (no bench, for example) never touches the published
     authority (`promoted_row_protected`), the only re-stage that goes to review.
   A new record is promoted (`promoted`, `promoted_at`, `promoted_to_id` = the Annex A judgment) only
   if Annex A promoted it; otherwise it is quarantined with the publication's reason (see
   "Publication into Annex A" below). Nothing is written to `case_law_master` or `embedding_queue`.

Each record is re-read `FOR UPDATE` and decided in its own transaction. A record whose promotion
raises is rolled back and counted as failed. Only a failure confirmed to be about the record itself,
a database error with SQLSTATE class 22 (data exception) or 23 (integrity constraint violation),
quarantines it `promotion_error:<ExceptionClass>` (class name only, never the message) so it is not
retried forever; if even that write fails, the failure is logged and the record stays pending. A
refusal by the Annex A publication guard that escapes the item (003's SQLSTATE SKP01-SKP13, such as
SKP12 `publication_not_finished` or SKP13 `parent_not_promoted`) is a decision about the record and
is quarantined the same way, except SKP08: a publication-state refusal such as
`publication_isolation_refused` is a deployment or configuration fault and counts as systemic. A
record whose own content fails the batch validation that promotion runs before publishing is
record-specific too (Codex P2 on #49), and is quarantined `batch_invalid:<code>` (the code only):
`too_large` (its batch document is over `MAX_BATCH_BYTES`, 32 MiB), `schema` (it fails the batch
models), `nul_character`, or `citation` (a `CitationError` from the key builder). Every
other failure leaves the record pending for the next run:
- a transient database error (connection lost, or SQLSTATE class 08, 40, 53 or 57, or 55P03);
- a systemic or unknown one: permission (42501; a runtime role that is not a `corpus_writer` member
  with SET fails every publication this way or as a `PublicationError` with no SQLSTATE; the shipped
  compose provisions it, see "Data-store security"),
  schema drift (42P01, 42703), an internal error (XX000), a generic RAISE (P0001), SKP08, any other
  SQLSTATE, or an unknown Python exception with none. These may be
  a deployment or schema fault that would hit every record, so the backlog must survive it. They are
  logged at error level with the id, class and SQLSTATE and `systemic=true`, never row data.

After three consecutive systemic failures with the same SQLSTATE (or exception class)
(`SYSTEMIC_FAILURE_LIMIT`), the run stops early and leaves the rest pending; any other outcome in
between resets the count. Otherwise the rest of the batch always continues. Every quarantine reason is
written to the staging row's `quarantine_reason` and to a `quarantine_queue` row. The run returns
`{"promoted", "attached", "quarantined", "failed"}`, plus `"aborted": "systemic:<SQLSTATE or class>"`
when it stopped early. A record that raised counts as failed whether it was left pending or
quarantined (`promotion_error` or `batch_invalid`). A record that always raises a systemic or unknown error stays pending
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

## Publication into Annex A (audit F19)

Harvested and curated authority reaches the application only through the Annex A corpus contract
(`postgres/ddl/001_corpus_contract.sql`, plus `003_corpus_publication.sql`), which the application
reads through the promoted-only `v_*` views as `corpus_reader`. `scraper/publication/` is the only
code here that writes it, and every write is part of one audited, idempotent **corpus publication**:

1. `corpus_publication_begin(batch_key, sha256, source_kind, actor)` takes an advisory lock, writes
   the audit row and a transaction-scoped grant. The same key with the same content returns
   `already` and writes nothing; the same key with other content is refused (`batch_key_reused`).
   A publication runs at READ COMMITTED (`SKP08 publication_isolation_refused` otherwise), so the
   guard's cross-row checks never read a snapshot older than the lock.
2. Each item is planned and written in its own savepoint, with `publication_id` on every row and one
   `corpus_publication_item` audit row per entity (`promoted`, `quarantined`, `updated` with the
   previous hash, `unchanged`, or `rejected` with a reason).
3. `corpus_publication_finish(id, counts)` checks the counts against the audit and the audit against
   the rows (every row the publication stamped has a `promoted` / `quarantined` / `updated` item, every
   such item names a stamped row, and each row's status agrees with its latest item), removes the grant
   and sets `corpus_metadata` `last_refresh`, `publication_seq` and `publication_contract = '1'`.
4. At `COMMIT`, deferred constraint triggers refuse (`SKP12 publication_not_finished`) a publication
   begun but not finished, and any row written in the transaction that carries an unfinished
   publication. `SET CONSTRAINTS ... IMMEDIATE` runs them before `finish()`, so it cannot publish.

The database enforces it: a trigger refuses any promotion, any change to a promoted row other than
its classification, and any row stamped with a publication id, outside that open publication
(`SKP02`). It refuses a promoted row without complete provenance, a judgment without a bench, a
treatment whose confidence is not in [0.7, 1] (NaN included), or an invalid or overlapping statute
version; a promoted citation, treatment, section or version whose judgment, statute or section is not
promoted, and the demotion of a judgment, statute or section that promoted rows still depend on
(`SKP13`). Every confidence column holds a number in [0, 1] (a CHECK). The audit tables are
append-only. Superuser sessions are exempt from the triggers (spec ruling 2) but cannot publish.
Publishing runs as `corpus_writer` (`SET LOCAL ROLE`); the runtime role reaches it by `SET ROLE` only.

| Case | Outcome |
|---|---|
| Missing or incomplete provenance | rejected `provenance_incomplete` |
| Invalid bench (not single / division / full / larger or an alias) | rejected `invalid_bench` |
| Invalid treatment kind | rejected `invalid_treatment_kind` |
| Unresolvable judgment (treatment) | rejected `unresolvable_judgment` |
| Citations of one item resolving to two judgments | rejected `citation_conflict` |
| History missing `effective_from` / overlapping / out of order | rejected `history_missing_effective_from` / `history_overlap` / `history_out_of_order` |
| Invalid jurisdiction (not one of the eight; `PK` refused) or statute status | rejected `invalid_jurisdiction` / `invalid_statute_status` |
| A quarantine that would demote or rewrite a promoted row | rejected `promoted_row_protected` |
| Batch key reused with different content | the whole batch refused (`batch_key_reused`) |
| Treatment confidence below 0.7 | quarantined `treatment_uncertain` |
| Treatment whose treating or treated judgment is not promoted | quarantined `judgment_not_promoted` |
| Source not trusted (F20) | quarantined with the trust reason |
| No bench | quarantined `missing_bench` |
| Citation not canonical (also a key the normaliser would rewrite again) | quarantined `citation_not_canonical` |
| Current text only | stored at `version_confidence` 0.5, which the reader ignores |

**Promotion.** `promote_staging_records()` applies the F20 decision first. A record it promotes is
published as its own publication (`batch_key = "staging/<id>"`); the staging row is promoted (with
`promoted_to_id` = the Annex A judgment id) only if Annex A promoted it, and otherwise quarantined with
the publication's reason. A re-stage identical to what Annex A already holds (`unchanged`, in any
spelling of the citation) is attached and skipped: closed as promoted, linked to the existing
judgment, no review-queue row, nothing rewritten, counted `attached`; only a conflicting change to a
protected promoted row
(`promoted_row_protected`) goes to review. Trust-quarantined and citation-free records never reach
Annex A.
Promotion no longer writes `case_law_master` and no longer queues embeddings (Annex A embeddings are
audit F27). A harvested row with no bench (`scraper_staging.extracted_bench_type`, which
`python -m scraper.migrate` adds to an older database) is published quarantined `missing_bench`
until a bench is supplied (spec ruling 9). Citations are stored under the gate's canonical keys
(`services/d4-2/citations.ts`): the extractor's "Karachi" becomes "Sindh".

**Curated batches.** Treatments and statute section histories come from curated batches in the
versioned format `corpus-publication-batch/1` (`scraper/publication/batch.py`; the JSON Schema is in
`docs/superpowers/plans/2026-10-14-f19-publication-etl.md`, Task 3):

```bash
DATABASE_URL=postgresql+asyncpg://<corpus_writer member>@<host>/<db> \
  python -m scraper.publication.cli publish --batch batch.json --actor <curator id>
```

stdout is one JSON object (ids, decisions and reasons only). Exit codes: `0` published or already
published, `2` usage error or a structurally invalid batch, `3` batch key reused with different
content, `4` a superuser or a role that is not a `corpus_writer` member, `1` anything else (nothing
is written).

**Who applies the DDL.** Annex A (001, 003, and 004's authority read views for the draft gate,
audit F05) is applied by a superuser, always in that order: in the compose stack by
`docker/postgres/apply-annex-a.sh` at postgres init and by `scripts/rotate_postgres_password.sh` on an
existing volume, which is how a volume created before 004 gets it (see "Data-store security"); in
tests by the fixture's admin. `python -m
scraper.migrate` never applies it: 001 needs `CREATE ROLE` and `CREATE EXTENSION`, which the
`NOCREATEROLE` migration owner cannot do.

**The draft gate's reader login (audit F05).** The Functions draft gate reads Annex A through 004's
authority views as a login that is a member of `corpus_authority_reader` and, for CONNECT,
`corpus_clients`, and of nothing else. The compose stack does not create that login. Create it with
plain SQL as `functions/src/d4/README.md` describes ("Creating the reader login"); the gate refuses a
login that belongs to any other role.

**Tests.** `tests/test_f19_publication_db.py` (and the migrated `test_f20_trust_policy_db.py`) apply
Annex A to each per-test database and publish as generated `corpus_writer` members; the pure tests
are `test_publication_vocabulary.py`, `test_publication_citations.py` (checked against the golden
`tests/fixtures/corpus/citation-canonical-golden.json`, generated from TypeScript by
`npm run corpus:citation-golden`) and `test_publication_batch.py`. Run them with
`CORPUS_TEST_DATABASE_URL=… python -m pytest corpus_service/tests -q` from the repository root.

## Public corpus API (audit F24)

`/search`, `/cases/{id}`, `/statutes` and `/statutes/{id}` (`scraper/routers/search.py`) are
unauthenticated; `/export/cases` (`scraper/routers/export.py`) needs the admin key. Both routers read
`case_law_master` / `statutes_master` only through `scraper/public_corpus.py`, and the AST scan in
`tests/test_trust_policy.py` keeps it that way. Spec:
`docs/superpowers/specs/2026-10-18-f24-bounded-public-corpus-queries-design.md`.

- **Published only, failing closed.** A judgment is served when `is_promoted` is true and its
  `source_site` names a `scraper_sources` row whose `trust_level` is exactly `trusted` or `review`;
  a statute section when its `source_site` names a `trusted` source. Anything else (not promoted, a
  `blocked`, unknown or missing source) is never returned, and a detail request for it is `404`, the
  same as a missing id. Staging and quarantine are never read.
- **Summary DTOs.** Lists return `{"items": [...], "next_cursor": ...}` with summary fields only (no
  text column). Detail routes add the text. No public response carries `embedding`, `search_text`,
  quality fields or provenance (`source_site`, `source_url`, `source_file_path`).
- **Bounds.** `limit` is 1-100 in plain ASCII digits (`/search` default 10, `/statutes` default 20);
  anything else (`0`, `101`, `10.0`, `+10`, ` 10`, `1_0`) is `422`, never clamped. `q` and
  `statute_name` are trimmed, 2-200 characters, contain no control characters and are not only
  `%`, `_`, `\` and whitespace (`422`); `%`, `_` and `\` then match
  literally (`ILIKE ... ESCAPE '\'`). Pages are keyset pages on the primary key; the cursor is
  opaque, and a malformed one is `400`.
- **Timeout, quota and load cap.** Each request runs in one `READ ONLY` transaction with a
  transaction-local `statement_timeout` (`PUBLIC_QUERY_TIMEOUT_MS`, default 3000); a cancelled
  statement is `503` with `Retry-After: 1`. At most `PUBLIC_DB_CONCURRENCY` (8) public reads run at
  once per process; the next is `503` at once, without waiting. A connection that cannot be had
  (pool exhausted, database refused or unreachable) is also `503`, never `500`. Each client gets
  `PUBLIC_RATE_LIMIT_REQUESTS` (60) requests per `PUBLIC_RATE_LIMIT_WINDOW_SECONDS` (60), then `429`
  with `Retry-After`. A client is its network: an IPv6 /64 or an IPv4 address (IPv4-mapped IPv6
  counts as IPv4). The table of clients is bounded (`PUBLIC_RATE_LIMIT_MAX_CLIENTS`); when it is
  full, new clients share one overflow bucket, so rotating addresses never mints fresh quota.
  `/docs`, `/redoc`, `/openapi.json` and `/dashboard` share the same quota (`/health` is F44's route).
- **Export.** `format` is `csv` or `jsonl` (`422` otherwise). Published rows only, in id order, at
  most `EXPORT_MAX_ROWS` (50,000), read in keyset batches of `EXPORT_CHUNK_ROWS` (500). Each batch is
  its own short read-only transaction (`EXPORT_QUERY_TIMEOUT_MS`, 60,000, per batch), so no database
  connection is held while the client downloads. `EXPORT_DEADLINE_SECONDS` (120) bounds the whole
  export, database reads and sends together; past it the transfer is cut without its final chunk.
  `EXPORT_MAX_CONCURRENT` (2) exports run at once; the next is `503`. CSV cells that start with `=`,
  `+`, `-`, `@`, a tab or a carriage return get a leading `'` (formula injection); JSONL is exact.
  `X-Export-Row-Cap` gives the cap and `X-Export-Truncated` says whether more published rows existed
  when the export started.

**Deploy step: the trusted proxy (`FORWARDED_ALLOW_IPS`).** The quota keys on the client address
uvicorn reports. uvicorn replaces the peer address with the X-Forwarded-For client only for a peer
listed in `FORWARDED_ALLOW_IPS`, which it reads from the environment; `app.env` sets it to
`127.0.0.1`, uvicorn's own default. Behind the TLS reverse proxy, set it in `app.env` to the proxy's
address as the `api` container sees it, as an IP or a CIDR. With the compose file's loopback port
binding that is a Docker bridge gateway, not the host's loopback; the warning below names the peer
address the api actually sees. Leaving it at loopback puts every
client in the proxy's one bucket; `*`, or any address other than the proxy, lets whoever connects
from there choose a client's key (and uvicorn trusts any peer listed, loopback included). In
production the api logs a warning at startup while the setting is loopback-only, unset or `*`, and
once per process when X-Forwarded-For arrives from a peer it does not trust.

**Tests.** `tests/test_f24_public_corpus_db.py` and `tests/test_f24_r2_db.py` (the re-audit round)
drive the real app against Postgres (need `CORPUS_TEST_DATABASE_URL`);
`tests/test_f24_public_corpus_bounds.py` and `tests/test_f24_r2_bounds.py` need no database. The
routers may use only `scraper/public_corpus.py`'s public API; `tests/test_trust_policy.py`
(`PublicCorpusReadGuardTests`) enforces it.

## Quarantine review (audit F23)

`POST /quarantine/{id}/promote` and `POST /quarantine/{id}/reject` (`scraper/routers/quarantine.py`,
admin key) decide one `quarantine_queue` record. Spec:
`docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md`.

- **Request.** Body `{"reviewer": "<name>", "reason": "<why>"}` as `application/json`, both required
  (reviewer 1-255 characters, reason 1-2000; no control, format or line/paragraph-separator
  characters; each must contain a visible letter or digit; unknown fields refused), and optionally
  an `Idempotency-Key` header (1-128 characters of `A-Z a-z 0-9 . _ : -`). Anything malformed is
  `422`, and a `422` never echoes the input (type, location and message only, at most ten errors).
- **The key before the body.** The admin key is checked before any of the body is read: a missing
  or wrong key is `401` at once, whatever body the request declares. With the key, a body over
  32 KiB is `413` (refused unread when `Content-Length` says so, or as soon as a streamed body passes
  the cap), and a body that has not arrived 10 s after the read began is `408`. A response sent
  before the body was completely received closes the connection (`Connection: close`). Spec
  rulings 13-18 (re-audit round 2, M1).
- **One transaction, one transition.** The queue row is locked (`FOR UPDATE`) and decided only while
  pending. A second decision, the loser of two concurrent ones, and a row resolved before this change
  are `409 already_resolved` (the body names the existing decision). A request repeating the winning
  decision with the same `Idempotency-Key` and the same reviewer and reason gets the stored result
  again (`"replayed": true`) and writes nothing; the same key with another reviewer or reason is
  `422 idempotency_key_reused` (each decision stores `request_fingerprint`, the SHA-256 of its
  canonical decision, reviewer and reason). A client that may retry should send a key. An unknown id
  is `404`. Contention the transaction loses is answered after rollback, never `500`: SQLSTATE
  40001 or 40P01 is `409 transaction_aborted`, 55P03 or 57014 is `503 database_busy` with
  `Retry-After: 1`; both carry `"retryable": true`.
- **Promote.** Refused with `409`, writing nothing, when the record has no staging row
  (`staging_record_missing`), its staging row is already promoted (`staging_already_promoted`), its
  source, resolved from the staging row by promotion's rule and read now, is `blocked` or unknown
  (`source_not_promotable`; `trusted` and `review` may be promoted by a reviewer, whatever the
  confidence), or its citation is already in `case_law_master` (`citation_already_published`,
  serialised per citation by an advisory lock). Otherwise it writes, in the same transaction, the
  `case_law_master` row (`is_promoted`, `promoted_at`, `source_site` = the verified source) under the
  id `uuid5(NAMESPACE_URL, "corpus-service:case_law_master:quarantine/<id>")`, one pending
  `embedding_queue` row for it (the outbox; `tasks/embeddings.py` consumes it, and its lease and
  outcome are F27 / F28), the staging lineage (`promoted`, `promoted_at`, `promoted_to_id`) and the
  decision. The published row is served by the public API (F24) while its source stays
  `trusted` or `review`.
- **Reject.** Resolves the record `rejected` with a decision; the staging row stays quarantined.
- **Evidence.** Every decision writes one `quarantine_decisions` row: the reviewer as given and
  `reviewer_auth = 'shared_admin_key'` (the shared key names nobody; named identities are F47), the
  reason, the prior and new state of the queue and staging rows, the source and trust read at decision
  time, the publication (key, table, id, outbox row), the `Idempotency-Key` and the time. The queue
  row's `reviewed`, `reviewed_by`, `reviewed_at`, `resolution` (`approved` / `rejected`) and
  `resolution_notes` are filled from the same values. The table is append-only in the database:
  triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` (SQLSTATE 23001) for every role
  (`scraper/quarantine_ledger.py`). They are `ENABLE ALWAYS`, so a session in
  `session_replication_role = replica` cannot skip them. They are created with the table, and
  migration `migrations/002_quarantine_decisions.py`, run by `python -m scraper.migrate`, compares
  the function and both triggers attribute by attribute (a `WHEN` clause, an `UPDATE OF` column
  list, a statement-level, disabled or origin-only trigger, a replaced function body) and drops and
  recreates all three on any difference. Migration `migrations/003_quarantine_decision_fingerprint.py`
  adds `request_fingerprint` and its CHECK to a table created before them.

**Tests.** `tests/test_f23_quarantine_review_db.py` and `tests/test_f23_review_hardening_db.py`
drive the real app against Postgres (need `CORPUS_TEST_DATABASE_URL`), with quarantine rows made by
the real promotion; `tests/test_f23_review_body_guard_e2e.py` starts the API with uvicorn (h11 and
httptools) and probes the body guard over raw sockets; `tests/test_f23_quarantine_review_rules.py`
needs no database.

## Embedding queue (audit F27)

`tasks/embeddings.py` (beat entry `process-embeddings`, every 300 s) embeds `embedding_queue` rows.
Spec: `docs/superpowers/specs/2026-10-18-f27-leased-embedding-claims-design.md`.

- **Claim under a lease.** A batch claims at most 50 due rows (`pending` with no `next_attempt_at`
  or one in the past, by `priority` then age) with `FOR UPDATE SKIP LOCKED`, marking them
  `processing` with its own `lease_owner` token and `lease_expires_at` (3900 s, longer than Celery's
  hard time limit) before it calls the provider. Two batches never hold the same row.
- **Operation identity.** Each request is for an operation: SHA-256 of table, record id, model,
  dimensions and the SHA-256 of the exact text sent. The queue row keeps the operation it is on
  (`operation_id`) and the one whose vector the record holds (`stored_operation_id`).
- **Receipts.** `embedding_attempts` has one row per provider request: `started` (committed before the
  request), `answered` (committed right after, with the token count and the vector held), then
  `stored`, `failed`, `superseded` (the record's text changed while the request was out),
  `abandoned` (its batch died while the request was out) or `interrupted` (time limit). It never
  holds the input text, the key or a provider message. A held vector is stored by a later batch
  without a second request (`reconciled`).
- **Retries.** A failed request sets `next_attempt_at` 300, 600, 1200, 2400 s ahead (then 3600) and,
  at the row's `max_attempts` (default 5), moves it to `dead_letter` (`error_type = max_attempts`).
  A row whose lease expired (a killed worker) goes back to `pending` with one attempt counted if the
  dead batch had started its request; a row the dead batch never reached is not charged. If the
  provider had already answered and the receipt holds the vector for the row's current text, the row
  is not charged and the next claim stores that answer with no new request.
- **A paid answer that cannot be stored.** If storing a held answer fails (the database refuses the
  vector write, or the batch storing it is lost), the row is not charged: the failure is counted on
  the receipt (`store_failures`) and the store is retried after 300 s, then 600 s. At the third
  failure the row goes to `dead_letter` as `store_failed` and the receipt keeps the vector.
- **Dead letters.** `error_type` says why: `unknown_table`, `unsupported_model`, `record_missing`,
  `empty_text`, `malformed_text`, `max_attempts`, `store_failed`. A dead letter is never claimed
  again. To retry one after fixing its cause:
  `UPDATE embedding_queue SET status = 'pending', attempts = 0, next_attempt_at = NULL, error_type = NULL, error_message = NULL WHERE id = '<id>';`
  A requeued row whose answer is still held (`store_failed`, or a `max_attempts` row whose receipt
  reads `answered`) is stored from the receipt with no new request.
  Rows left `failed` by the pre-F27 code are counted with the dead letters and requeued the same way.
- **Alerts** (F28's line, `F28 source alert: embedding_queue <alert>`, also in the batch summary and
  its `scraper_jobs` row): `backlog_stale` when the oldest waiting row was queued more than 24 h ago,
  `dead_letter` when a batch dead-letters rows.
- **Migration.** `migrations/004_embedding_queue_leases.py` (run by `python -m scraper.migrate`)
  adds the lease and operation columns, their CHECKs and the claim, lease and backlog indexes to a
  queue created before F27; `embedding_attempts` comes from `create_all`. Rows left `processing`
  without a lease go back to `pending`; nothing else changes.

**Tests.** `tests/test_f27_embedding_claims_e2e.py` (the beat entry's task in process, real Postgres),
`tests/test_f27_embedding_prefork_e2e.py` (a real prefork worker: two children at once, a child
killed after the provider answered) and `tests/test_f27_embedding_rules.py` (no database).

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
- **Annex A corpus contract (audit F19).** On a fresh volume the image's init runs `10-init.sql`
  (extensions), then `15-apply-annex-a.sh`, which applies `../postgres/ddl/001_corpus_contract.sql`,
  `003_corpus_publication.sql` and `004_authority_read_views.sql` (mounted read-only) in one
  transaction as the bootstrap superuser, then `20-provision-roles.sh`, which refuses to run without Annex A or on PostgreSQL
  older than 16, and refuses (before changing anything) an Annex A view the inventory does not list:
  re-applying 003 alone after 004 would otherwise hand 004's views to the migration role. Annex A stays the superuser's: provisioning leaves every relation that
  `corpus_contract_relations()` lists out of the move to the migration role and out of the runtime
  role's DML grants. On every run it resets any grant on those relations (and the sequences they
  own) to either application role, `corpus_clients` or `PUBLIC`, and any `EXECUTE` on the routines
  `corpus_contract_routines()` lists to those roles (to `PUBLIC` too, except 001's trigger function,
  which keeps PostgreSQL's default). These resets, and those on the database, schema `public` and the
  runtime role's own tables, are `REVOKE … CASCADE`. A grant that one of these roles held `WITH GRANT
  OPTION` and passed on is taken down with it, so the run does not abort. It also resets the
  bootstrap superuser's default privileges, in `public`, globally and in any other schema. No object
  that role creates later goes to either application role or `corpus_clients`, and no table or
  sequence goes to `PUBLIC`. Functions keep PostgreSQL's default `EXECUTE` for `PUBLIC`, which
  extension functions created later need. It then fails closed if either role still owns or holds any of
  it, directly or through `corpus_clients`, `PUBLIC` or an inherited role, or if an Annex A relation
  or routine is not a superuser's. The grants the DDL makes to `corpus_reader`, `corpus_writer`
  and `corpus_declassify` are untouched. The migration role could not apply 001 anyway (it creates
  roles and extensions; that role is `NOCREATEROLE`). The runtime role is a member of
  `corpus_writer` `WITH INHERIT FALSE, SET TRUE`: it holds none of `corpus_writer`'s rights until
  `scraper.publication` switches to it (`SET LOCAL ROLE`) for one audited publication, and even then
  it cannot write the publication grant or the declassify grant, change the audit, or promote a
  row outside a publication. `corpus_writer` and `corpus_reader` get `USAGE` on schema `public`
  (which `PUBLIC` no longer has); neither can log in. `docker/postgres/apply-annex-a.sh` is
  idempotent; `scripts/rotate_postgres_password.sh` re-applies it on an existing volume (the image
  runs `/docker-entrypoint-initdb.d` only on an empty one).
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
  on the old volume, re-hashes the superuser password as SCRAM, applies Annex A (also the way to
  bring a volume created before F19 onto it, or up to date after a DDL change), creates or updates
  the two roles, moves existing application tables to the migration role and grants the runtime
  role DML only, plus its `corpus_writer` membership.

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
