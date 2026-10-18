# F05 + F19 + F20: Promoted-only authority corpus

Date: 2026-10-14. Base: `origin/main` @ 3cf07c4. Status: approved by the remediation builder under the owner's standing autonomy instruction. Each ruling below records its reason.

Audit sources:
- `docs/audit/2026-10-13-forensic-audit.md`: F05 (:227), F19 (:465), F20 (:482), F21–F24 and F27.
- `docs/audit/2026-10-14-forensic-audit-v2.md`: :78, :92, :93, :179.

Rules: `docs/audit/REMEDIATION.md`. This is a fix only, with no new features. Each PR needs an end-to-end test of a real flow that fails before and passes after. A finding is ticked only after an independent re-audit passes.

## 1. Problem

The correction is one dependency chain, so F05, F19 and F20 are fixed together:

- **F05: the gate has no authority to check against.** `functions/src/d4/authority.ts:101-103` returns `EMPTY_AUTHORITY_STORE` outside tests. Every citation in a draft is UNVERIFIED, every temporal check is `TEMPORAL_UNAVAILABLE`, and a partner can only override.
- **F19: the harvester writes the wrong schema.** It writes `case_law_master` / `statutes_master` with flat text and a boolean promotion flag (`corpus_service/scraper/models.py:197`, `:307`). The application contract (Annex A, `postgres/ddl/001_corpus_contract.sql`) expects judgment, citation, treatment, source_provenance and statute section versions. Nothing maps one onto the other.
- **F20: the trust vocabulary fails open.**
  - The DB CHECK allows `trusted | semi_trusted | untrusted | quarantined`, with default `trusted` (`models.py:128,167`).
  - Promotion treats a missing source as trusted (`tasks/promotion.py:20-23`).
  - It tests for `blocked` and `review` (`:24,:26`), which are not in that vocabulary.
  - The dispatcher also tests for `blocked` (`dispatcher.py:27`).
- **F22, fixed on the same lines.** A citation-free record crashes promotion with `UnboundLocalError` (`promotion.py:15,21`).

## 2. Canonical design, taken from the architecture spec

Source: `docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt`.

- **The corpus is firm-owned Postgres 16.**
  - The application holds only a read-only connection: L17.10 #56 (:7243), L17.12 #65 (:7317), L18 §5.4 (:8322).
  - The external corpus service writes to Annex A directly: #68 (:7327).
  - Reads go through promoted-only `v_*` views as `corpus_reader`. Writes are made by `corpus_writer` (:8265-8269).
- **Annex B rules.**
  - B-3 (:7664): Annex A replaces the master tables.
  - B-5 (:7696): one version per amendment; current-text-only gets a 0.5 version.
  - B-7 (:7714): a treatment below 0.7 is quarantined.
  - B-10 (:7744): every judgment carries a bench.
- **Corpus service spec** (`corpus_service/FINAL_CORPUS_SERVICE_PROMPT_2.md`):
  - `trust_level` is `trusted | review | blocked`, default `review` (:252-253).
  - Promotion: trusted with confidence ≥ 0.5 is promoted; review is always quarantined; blocked is never harvested (:894-898).
  - Contract `review_status` defaults to quarantined (:225-232).
- **Errata.** O-59 (`docs/architecture/ERRATUM_SET_2_PROPOSED.md:158`): a production `AuthorityStore` over the Annex A read views, plus a parity test.

**Rejected alternatives:**
- A TypeScript ETL in the app repo, because it would make the app a corpus writer (L18 §5.4, E-25).
- A published snapshot, because B-3 says nothing is exported into the application.
- The corpus_service HTTP API, because it inherits F24/F47, adds API surface, and conflicts with L19 #6.

## 3. Rulings

| # | Decision | Ruling | Reason |
|---|---|---|---|
| 1 | Sequencing | F20, then F19, then F05, inside REMEDIATION order item 4 | F05's own audit entry names F19 as a dependency, and F19 names F20. Without them the F05 fix cannot be proven. |
| 2 | Superuser and the publication guard | Superuser sessions are exempt from the guard trigger. The reader views still exclude any row without complete provenance. | A superuser can drop triggers anyway. The exemption keeps PG-DDL-1..10 and the FA-DATA-001 probe untouched while that finding awaits re-audit. The views close the gap for the reader. |
| 3 | A quarantined (pending) `overruled` treatment | The reader answers UNVERIFIED, never VERIFIED | Fail closed: an unreviewed overruling must not leave a citation reading as good law. |
| 4 | `MIN_VERSION_CONFIDENCE` | Must be strictly greater than 0.5 | The B-5 fallback (current text only, 0.5) is not a history. It cannot prove which text was in force on a past date. |
| 5 | `SIKANDER_CORPUS_MAX_STALENESS_HOURS` | Required, with no default | Freshness is part of F05's correction. Leaving it unset counts as misconfiguration, and the empty store stays in place. |
| 6 | Jurisdiction code `PK` | Not mapped, so `no_history` | Ambiguous. Fails closed. Revisit with the R11 code list. |
| 7 | `sectionId` | `statute_section.id` (UUID) | Annex A's stable identity of a section across versions. |
| 8 | Classification in authority views | Only `public` judgments | The gate is an application read. Restricted judgments must not surface through it. |
| 9 | Bench needed to promote | Yes. A judgment with no bench goes into Annex A as quarantined (`missing_bench`). | B-10. The overruling verdict depends on bench. |
| 10 | Embedding queue against `case_law_master` | Removed from promotion | Promotion no longer writes that table. Embeddings for Annex A belong to F27. |
| 11 | Compose wiring (apply 001+003 at init; grant `corpus_writer` to the runtime role) | A separate PR 2b, right after PR 2. F19 is not ticked until 2b merges. | It touches the F30 compose policy constants, so it needs its own focused review. |
| 12 | An "authority reachable" marker on gate results | Not built | New stored data, which the fix-first freeze treats as a feature. |
| 13 | Reader role | `corpus_reader` | It is the spec role. A new role would need an erratum. |

**Amendment to ruling 13 (#51 fix round 1, D-3; plan D21):** the draft gate's reader is a member of `corpus_authority_reader` only. 004 creates that role, and it can read just the four `v_authority_*` views and `corpus_metadata`. `corpus_reader` keeps 001's grants (FA-DATA-003 stays its own finding).

## 4. PR 1: F20 (with F22), corpus_service only

- **New `scraper/trust.py`.**
  - `TrustLevel = trusted | review | blocked` and `TRUST_LEVELS`.
  - `publication_decision(trust_raw, confidence)`:
    - `trusted` with confidence ≥ 0.5 → promote;
    - `review` → quarantine, reason `review_source`;
    - `trusted` below 0.5 → quarantine, reason `low_confidence`;
    - `blocked`, unknown, None, or a missing or deleted source → quarantine, reason `blocked_source` or `unknown_source`.
  - `may_harvest(trust_raw)` is False for `blocked` and for anything unknown.
- **Model.** `models.py` builds its CHECK from `TRUST_LEVELS`, and the default becomes `review`.
- **Migration.** An idempotent upgrade in `migrate.py`. It runs only as `MIGRATE_DB_USER`, because the runtime role is DML-only (F30). Steps:
  1. Drop the old CHECK.
  2. Map every value outside the set to `review`: `semi_trusted`, `untrusted` and `quarantined` all become `review`.
  3. Add the new CHECK.
  4. Set the default to `review`.
- **Seeds.** `database.py`: `semi_trusted` becomes `review`.
- **`promotion.py`.**
  - Resolve the source by FK `source_id`, then by `parsing_metadata.source_name`, then by `source_site`.
  - Use the module-level `select`, which fixes F22.
  - A citation-free record is quarantined as `citation_missing`, with a durable reason.
  - A bad record is isolated, so the rest of the batch still runs.
  - **PR 1 still writes `case_law_master` for promoted rows.** Moving to Annex A is PR 2. PR 1 only fixes the trust decision.
- **Dispatcher.** `dispatcher.py` uses `may_harvest`.
- **End-to-end test.** `corpus_service/tests/test_f20_trust_policy_db.py`, against real Postgres, using the app's own models, migrate path and real `promote_staging_records`:
  - a) The DB rejects `semi_trusted`, `untrusted`, `quarantined` and `''`, and the default is `review`.
  - b) A legacy table is upgraded and its values are mapped.
  - c) Staged rows come out as follows. Trusted at 0.5 is promoted. Trusted at 0.49 is quarantined as `low_confidence`. Review is quarantined as `review_source`. Blocked, deleted and unknown sources are quarantined and nothing is promoted. A renamed source is resolved through its FK.
  - d) A citation-free trusted row is quarantined, not crashed (F22).
  - e) The dispatcher skips `blocked` and unknown sources.
  - **On main:** (a) accepts `semi_trusted`, (c) promotes those rows, and (d) raises `UnboundLocalError`.
- **CI.** The `corpus-service` job gains a `pgvector/pgvector:pg16` service and `CORPUS_TEST_DATABASE_URL`. `conftest.py` fails under CI when that URL is unset, so the test cannot be skipped.

## 5. PR 2: F19, the publication ETL into Annex A (plus PR 2b, compose wiring)

**`postgres/ddl/003_corpus_publication.sql`** is additive and idempotent; 001 and 002 are not edited.

- **Defaults.** Every contract table's `review_status` default becomes `'quarantined'`.
- **Audit tables.**
  - `corpus_publication`: `seq`, `id`, `batch_key` UNIQUE, `input_sha256`, `source_kind`, `actor_id`, `publisher_session_user`, counts, `created_at`.
  - `corpus_publication_item`: `publication_id`, `item_key`, `entity_type`, `entity_id`, `decision`, `reason`, `content_sha256`, `prev_sha256`.
  - Both are append-only: UPDATE and DELETE are revoked from all roles.
- **Publication link.** Each contract table gets a nullable `publication_id`. `corpus_publication_grant(xid PK, publication_id)` has REVOKE ALL, following the `judgment_declassify_grant` pattern.
- **New constraints.**
  - `treatment.treating_bench_type` must be one of the bench set.
  - `statute.jurisdiction` must be one of the 8 Annex A values (added NOT VALID, then VALIDATE).
  - `treatment` gets a natural unique key: (treating, treated, kind, coalesce(passage_anchor, '')).
- **Guard trigger `enforce_promoted_via_publication`.**
  - It runs BEFORE INSERT/UPDATE on every contract table.
  - It fires when a row becomes promoted, or when an authority column changes on a promoted row. Classification-only updates are ignored, so `declassify()` is unaffected.
  - The transaction must hold a grant row for its `txid_current()` that matches `NEW.publication_id`.
  - Promoted rows also need:
    - complete provenance: `source_name`, `fetched_at`, `content_hash`, `extraction_method`, and either `source_url` or `raw_storage_key`;
    - a bench on the judgment;
    - treatment confidence ≥ 0.7, with both judgments present;
    - for statute versions, `effective_from` NOT NULL, `effective_to` after `effective_from`, and no overlap with another promoted version of the same section.
  - Overlap is checked procedurally. Publications are serialised by an advisory lock, so the check cannot race.
  - Superuser sessions are exempt (ruling 2).
- **Functions** (SECURITY DEFINER, safe `search_path`; EXECUTE for `corpus_writer` only):
  - `corpus_publication_begin(batch_key, input_sha256, source_kind, actor)`:
    - takes the advisory lock;
    - the same key with the same hash returns `already = true` and writes nothing;
    - the same key with a different hash raises `batch_key_reused`.
  - `corpus_publication_finish(id, counts)`:
    - writes the counts;
    - deletes the grant;
    - upserts `corpus_metadata` keys `last_refresh`, `publication_seq` and `publication_contract = '1'`.
- **Grants.** `corpus_writer` gets INSERT and UPDATE on the contract tables, plus SELECT where it needs it.

**Python ETL**, `corpus_service/scraper/publication/`, uses SQLAlchemy `text()` against Annex A. Annex A is not added to the ORM, so `create_all` cannot race the DDL.

- **`vocabulary.py`** holds the closed sets:
  - bench aliases → `single | division | full | larger`;
  - 7 treatment kinds, lowercased and trimmed;
  - 8 jurisdictions;
  - court aliases mirroring TypeScript: Karachi → Sindh; Balochistan and Quetta → Quetta.
- **`citations.py`** builds the TypeScript canonical key from parts, or validates a given key. A key that is not canonical is quarantined as `citation_not_canonical`.
- **`batch.py`** defines the versioned format `corpus-publication-batch/1` and validates it.
- **`annex_a.py`** has `publish_batch()`:
  - one transaction: begin, upserts on natural keys, the per-item audit, finish;
  - a judgment is resolved through its citations, and `citation_conflict` is rejected;
  - unchanged rows are recorded as `unchanged`; changed rows as `updated`, with the previous hash.
- **`from_staging.py`** maps a staging row to a batch item. It uses a new nullable `ScraperStaging.extracted_bench_type`. A row with no bench is quarantined as `missing_bench`.
- **`promote_staging_records`** still has no schedule (scheduling is F21). It applies the PR 1 decision and publishes through `publish_batch`. In the same transaction it sets staging `promoted` and `promoted_to_id`, writes quarantine entries with their reasons, and stops writing `case_law_master` and the embedding enqueue (ruling 10).
- **`cli.py`**: `python -m scraper.publication.cli publish --batch FILE --actor ID`, for curated batches (treatments and statute histories).

**Rejected or quarantined, by case:**

| Case | Outcome |
| --- | --- |
| Missing or incomplete provenance | Rejected |
| Invalid bench | Rejected |
| Invalid treatment kind | Rejected |
| Unresolvable judgment | Rejected |
| History missing `effective_from`, overlapping, or out of order | Rejected |
| Invalid jurisdiction | Rejected |
| Batch key reused with different content | Rejected |
| Treatment confidence below 0.7 | Quarantined |
| Source not trusted | Quarantined |
| No bench | Quarantined |
| Citation not canonical | Quarantined |
| Current text only | Stored at 0.5; the reader ignores it (ruling 4) |

**Citation parity.** `tests/fixtures/corpus/citation-canonical-golden.json` is checked by a TypeScript test (equal to `normaliseCitation`) and by a pytest (the Python builder reproduces it).

**End-to-end test.** `corpus_service/tests/test_f19_publication_db.py`, plus `tests/postgres.ddl.integration.test.ts` cases PG-DDL-11 onward. Through promotion and the CLI:
- a `corpus_reader` connection sees the judgment and its canonical citation through the views;
- the provenance row exists;
- `corpus_publication` and its items are written;
- staging `promoted_to_id` is linked;
- missing provenance is rejected with a reason;
- Karachi is normalised to Sindh;
- re-running the same batch is a no-op, and a reused key is refused;
- treatment and history rules behave as in the table;
- `corpus_writer` and `app_writer` cannot promote outside a publication;
- `declassify()` still works;
- PG-DDL-1..10 and the probe are unchanged.

**On PR 1's main:** promotion writes `case_law_master`, so the views stay empty.

**PR 2b (compose wiring)** applies 001 and 003 at init as superuser, grants `corpus_writer` to `APP_DB_USER` in `provision-roles.sh`, and extends the store and upgrade e2e. 001 needs CREATE ROLE and CREATE EXTENSION, which the NOCREATEROLE migration owner cannot do.

## 6. PR 3: F05, the promoted-only reader

**`postgres/ddl/004_authority_read_views.sql`**
- Four `security_barrier` views, SELECT granted to `corpus_reader`:
  - `v_authority_citation(citation_text, judgment_id, bench_type)`;
  - `v_authority_treatment(treated_judgment_id, treatment, treating_bench_type, treating_judgment_bench)`;
  - `v_authority_section_version(section_id, jurisdiction, version_no, effective_from, effective_to, text, version_confidence)`;
  - `v_authority_pending_adverse(treated_judgment_id)`.
- Each view requires the row and its parents to be promoted, `public` classification (ruling 8), and complete provenance through an inner join.
- No provenance columns are exposed.

**`functions/src/d4/corpusAuthorityStore.ts`**
- **Connection.** A `pg` Pool:
  - 2–3 connections, `allowExitOnIdle`, a 2–3 s connect timeout;
  - `statement_timeout` set, `default_transaction_read_only = on`, and an `application_name`;
  - TLS verify-full in production; plaintext only to loopback, and only outside production.
- **Corpus state.** Checked before answering and cached for about 30 s. It needs `publication_contract = '1'` and a `last_refresh` within the staleness window. Otherwise it throws `AuthorityUnavailableError('contract_missing' | 'stale')`.
- **Citation lookup.** The input must be canonical (`normaliseCitation(x) === x`), otherwise the answer is null. An inconsistent bench throws.
- **Treatment lookup.**
  - The judgment id must be a UUID.
  - Treatment kinds and benches must be in their closed sets; anything else throws.
  - A pending adverse treatment throws `('pending_review')` (ruling 3).
  - It never returns `[]` on failure.
- **Section lookup.**
  - A non-UUID section id, or a jurisdiction outside the 8 Annex A values, returns `no_history`. `PK` returns `no_history` (ruling 6).
  - The version history must be consistent; otherwise it throws.
  - Exactly one version must cover the date (from inclusive, to exclusive).
  - A version with confidence ≤ 0.5 returns `no_history` (ruling 4).
- **Failures.**
  - Connection refused, timeout, `42501`, `28P01` and `57014` all throw `AuthorityUnavailableError(...)`.
  - A circuit breaker of about 30 s keeps the gate inside the 120 s function timeout.
  - It logs `d4.authority_unavailable` with the reason only: no URL and no raw error text.

**Changes to `gate.ts`.** `checkCitations` / `checkTemporal` catch only `AuthorityUnavailableError`. The citation becomes UNVERIFIED, or the temporal check becomes `TEMPORAL_UNAVAILABLE` with `inForceText` null. Any other error propagates as a 500 and nothing is stored. The result is never OK. A draft with nothing to check stays NOT_ASSESSED (F06). An approval re-run during an outage gives 409 `gate_blocked`.

**Store selection (`activeAuthorityStore`).**
- In order:
  1. The test store, if one is set.
  2. Otherwise `readCorpusReaderConfig(process.env)` reads `SIKANDER_CORPUS_READER_URL`, `SIKANDER_CORPUS_READER_CA` (PEM) and `SIKANDER_CORPUS_MAX_STALENESS_HOURS`.
  3. If the config is missing or invalid, the empty store is used and `d4.authority_not_configured` is logged once.
  4. Otherwise a memoised Pg store, keyed by config.
- In production, a URL without verify-full and a CA counts as misconfigured.

**End-to-end test.** `functions/test/f05-authority-corpus.e2e.emu.test.ts`, run through the HTTP router with the Auth and Firestore emulators and real Postgres:
- **Seeding.** DDL 001–004 is applied, then `tests/fixtures/corpus/curated-batch.f05.json` is seeded through the PR 2 ETL CLI as `corpus_writer`. The fixture uses only 2099 citations and "Test Act 2099" (P4-13). No real authority is invented.
- **Cases:**
  - a) Verified citations plus a pleaded temporal check give OK, and the partner approves with no override.
  - b) A division bench overruled by a larger bench gives OVERRULED and 409.
  - c) A later text pleaded for an earlier date gives `TEMPORAL_MISMATCH` with `inForceText`.
  - d) Each of these gives UNVERIFIED or `TEMPORAL_UNAVAILABLE`: wrong jurisdiction, a 0.5 version, a quarantined judgment, a rejected-provenance item, a superuser row with no provenance, a pending overruling.
  - e) A capitalised "Overruled" in the batch still yields OVERRULED.
  - f) An overruling published after an OK gate makes the approval 409.
  - g) No citations gives NOT_ASSESSED.
- **Unavailable cases.** Each must give UNVERIFIED or `TEMPORAL_UNAVAILABLE`, never OK:
  - a closed port;
  - a lock causing a statement timeout (with a bounded time);
  - a revoked grant;
  - a stale `last_refresh`;
  - a missing contract;
  - an unset environment.
- **Results on PR 2's main:** cases a, b, c, e and f fail (empty store). The unavailable cases are regression guards.

**Also in PR 3.**
- `d4.authority-parity.pg.test.ts`: in-memory store vs Pg store on the same fixture (O-59).
- `d4.corpus-authority.pg.test.ts`: adapter branches.
- `d4.gate.test.ts`: the unavailable-error handling.
- `d4.boot.test.ts`: store selection.

**CI.** A new job, "Authority corpus e2e (F05)", running pgvector, Java and the emulators, Python with `corpus_service/requirements-test.txt`, and `npm run test:f05-authority`. `functions/vitest.config.ts` excludes the Pg files unless `SIKANDER_POSTGRES_URL` is set, so the job cannot pass vacuously. The `gate_g4_phase4a.sh` named list is updated.

## 7. Out of scope here (recorded)

- **Other findings.**
  - F21 / F28: scheduling and job outcomes.
  - F23 / F47: the quarantine route and the shared admin key.
  - F24: public search.
  - F27 / F45: embeddings.
  - FA-DATA-002 / 003.
  - The Next transitional gate (O-67).
- **Outside the repo.**
  - Curated corpus content, which needs qualified legal reviewers. Nothing is to be invented.
  - The corpus host and its separate project (E-25, O-16).
  - The network path from Functions (asia-south1) to the database.
  - CA, PKI and secret binding.
  - Backups (F33).

## 8. Risks

- **Python/TypeScript citation drift.** Covered by the golden fixture. The drift costs recall only, because a non-canonical row never matches and so fails closed.
- **Bundling `pg-native` in esbuild.** UNVERIFIED.
- **Connection-pool scale-out vs `max_connections`.**
- **Trigger cost.** Batches are capped at about 500 items.
- **Strict `toEqual` gate tests.** These pin the result shape, so `CitationFinding` is kept unchanged.
