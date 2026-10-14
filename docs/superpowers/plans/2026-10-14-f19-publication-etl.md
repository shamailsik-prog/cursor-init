# F19 Publication ETL into Annex A: Implementation Plan (PR 2 of 3, plus PR 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Promotion and curated batches write the Annex A contract (`judgment`, `citation`, `treatment`, `statute`, `statute_section`, `statute_section_version`, `source_provenance`). They stop writing `case_law_master`.
- A row becomes `promoted` only inside an audited, idempotent corpus publication. It also needs complete provenance, a bench, and the B-5 and B-7 rules.
- A `corpus_reader` connection sees published authority through the existing `v_*` views. Nothing else reaches them.

**Architecture:**
- `postgres/ddl/003_corpus_publication.sql` is additive and idempotent, and 001/002 are not touched. It adds:
  - the `quarantined` default;
  - the append-only audit tables;
  - a transaction-scoped publication grant (the `judgment_declassify_grant` pattern);
  - the `enforce_promoted_via_publication` guard trigger;
  - the SECURITY DEFINER `corpus_publication_begin` / `corpus_publication_finish`;
  - the new CHECKs and the treatment natural key.
- `corpus_service/scraper/publication/` is the only code that writes Annex A. It uses SQLAlchemy `text()`. Annex A is **not** added to the ORM, so `create_all` cannot race the DDL.
- `promote_staging_records` keeps PR 1's decision, reasons and per-record SAVEPOINT isolation. Each promoted staging record becomes one publication. The `case_law_master` write and the embedding enqueue are removed (ruling 10).
- Citation keys are the TypeScript ones. A golden fixture, generated from `normaliseCitation`, pins the Python key builder to them.
- PR 2b, a separate PR, wires compose: 001+003 applied at init, `corpus_writer` granted to the runtime role, and F30 provisioning made aware of Annex A.

**Tech Stack:**
- Python 3.12, SQLAlchemy 2.1 async with asyncpg, pydantic 2.13 (already pinned in `requirements-test.txt`), pytest.
- Postgres 16 with pgvector (`pgvector/pgvector:pg16`).
- TypeScript, vitest, node-pg.
- GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-f05-f19-f20-authority-corpus-design.md`: §3 rulings 2, 4, 9, 10, 11 and 13, and §5.

**Base:**
- PR 2 branches as `claude/remediate-f19-publication` from `claude/remediate-f20-trust` @ `24b96ec`.
- PR 2b branches as `claude/remediate-f19-compose` on top of PR 2.

---

## Global Constraints

- **Contract tables:** the 9 tables with `review_status`: `court`, `judge`, `instrument`, `statute`, `statute_section`, `statute_section_version`, `judgment`, `citation`, `treatment`. Every guard, default and `publication_id` rule applies to exactly these. `source_provenance` also gets `publication_id`, but no guard, because it has no `review_status`.
- **Closed sets.** These are defined once in `scraper/publication/vocabulary.py`, and a DB test checks them against the DDL CHECKs.
  - Bench: `single | division | full | larger`.
  - Treatment kinds: `followed | applied | distinguished | doubted | overruled | per_incuriam | referred`. Input is lowercased and trimmed, and nothing else.
  - Jurisdictions (Annex A A.4): `Federal | Sindh | Punjab | KP | Balochistan | ICT | GB | AJK`. `PK` is not mapped (ruling 6).
  - Court canonicals: as in `services/d4-2/citations.ts:58-73`. Karachi → `Sindh`; Balochistan and Quetta → `Quetta`.
- **Thresholds:**
  - Trust promotion is `scraper.trust.publication_decision`: trusted with confidence ≥ 0.5. It is unchanged.
  - Treatment confidence must be ≥ 0.7 (B-7).
  - A current-text-only version is stored at `version_confidence` 0.5 (B-5). The reader ignores it (ruling 4, PR 3).
- **Who runs which DDL:**
  - Annex A DDL (001, 003) runs only as a superuser: the DDL harness admin, the pytest fixture admin, the CI `psql` step, and in PR 2b the postgres init script and rotation.
  - `python -m scraper.migrate` (MIGRATE_DB_USER, NOCREATEROLE) never touches Annex A. It only adds `scraper_staging.extracted_bench_type`.
- **Who writes Annex A:** only `publish_batch`.
  - It runs under `SET LOCAL ROLE corpus_writer`.
  - It refuses superuser sessions.
  - Nothing in corpus_service writes `case_law_master` from promotion any more.
- **No real authority.**
  - Every citation, title and statute in fixtures and tests uses the year 2099 or "Test Act 2099" (P4-13).
  - The golden fixture enforces this in both test languages.
- **Fix only:**
  - No HTTP routes, no scheduling (F21), no reader (PR 3).
  - No embeddings for Annex A (F27).
  - No change to `citation_extractor.py`. Its Karachi/Quetta defect is absorbed at publication (D26).
- **Never** skip, xfail or weaken an existing test.
  - PR 1's `test_c` and `test_d` assert the `case_law_master` write that spec §5 removes.
  - Task 8 rewrites those assertions one for one onto Annex A and keeps every trust and isolation assertion. The mapping is listed in that task.
  - PG-DDL-1..10, `docs/audit/probes/probe_fa_data_001.mjs` and `tests/probe-fa-data-001.regression.test.ts` stay byte-identical.
- **Commits** end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DtzafHsrLji6x2SM4jCSWT
  ```

## Decisions where the spec is silent

| # | Decision | Reason |
|---|---|---|
| D1 | "Superuser" means `session_user` has `rolsuper`. The guard and audit trigger functions are SECURITY DEFINER (the FA-DATA-001 pattern) and test `session_user`. A superuser who runs `SET ROLE` is still exempt. | Inside a DEFINER function, `current_user` is the owner (a superuser), so testing `current_user` would exempt everyone. Ruling 2 accepts the exemption because a superuser can drop triggers anyway. |
| D2 | `corpus_publication_begin`, `corpus_publication_finish` and `publish_batch` **refuse** superuser sessions (`publication_superuser_refused`, SKP07). | The guard does not check a superuser, so a superuser "publication" would write audit rows that claim checks which never ran. |
| D3 | Custom SQLSTATE class `SK`: SKP01–SKP11 (table in Task 4). The message is a stable token. DETAIL never carries row values. | Callers branch on the code. Logs must not leak row data (PR 1 rule). |
| D4 | Authority columns are every column except `classification` and `updated_at`, compared as `to_jsonb(row) - ARRAY['classification','updated_at']`. | It implements "classification-only updates are ignored" so that `declassify()`, which sets `classification` and `updated_at`, passes. It fails closed for columns added later. |
| D5 | A demotion (OLD promoted, then any authority change) also needs an open publication grant. Content checks run only when NEW is promoted. | Every change to what the reader sees is audited. |
| D6 | The audit tables are append-only by REVOKE **and** by triggers on UPDATE/DELETE/TRUNCATE, which also bind a superuser. The single exception is `finish()` setting the counts and `finished_at` once, while the publication's grant is open. | `finish` must write the counts (spec), and a REVOKE alone does not stop the owner or TRUNCATE. |
| D7 | One publication per promoted staging record. `batch_key = "staging/<staging uuid>"`, `source_kind = 'staging'`. | It keeps PR 1's commit-per-record isolation exactly. A failure rolls back its own `corpus_publication` row, so no orphan audit is left. The advisory lock is held per record, not per run. |
| D8 | Only staging rows that the PR 1 decision promotes are published. Rows quarantined for trust or `citation_missing` stay in `quarantine_queue` only, as in PR 1. | Untrusted harvest text never enters the contract tables, and cannot collide with or overwrite trusted rows. PR 1's outcome table is unchanged. |
| D9 | An item whose decision is quarantine never modifies an existing **promoted** row. It is `rejected` with `promoted_row_protected`, and `entity_id` is set to the protected row. | It fails closed: a review-trust or bench-less re-scrape cannot demote or rewrite a published authority. |
| D10 | The content hash per entity covers the authority fields, the provenance identity (`source_name`, `source_url`, `raw_storage_key`, `content_hash`, `extraction_method`, `extractor_version`) and the **target `review_status`**. It excludes `fetched_at` and `classification`. | A re-fetch of identical content is `unchanged`. A change of trust or bench is `updated`. |
| D11 | Judgment resolution looks up `citation.citation_text = ANY(keys)` across all review statuses. 0 hits → new judgment; 1 → that judgment; more than 1 → `rejected citation_conflict`. Publication never deletes a citation. | Spec rule. Deleting citations would be a review workflow (F23), so it stays out. |
| D12 | ETL does not write `court` or `judge` rows. `judgment.court_id` and `judge_ids` stay NULL. The court lives in the citation key. | Naming courts for the AJ&K and GB reporter sections would invent facts. The F05 reader needs only the citation key and the bench. |
| D13 | ETL never sets or updates `judgment.classification`. The default is `public` (Annex A A.1). | Classification is FA-DATA-001's domain. |
| D14 | `publish_batch` runs on the caller's connection and transaction. Its sequence is: pre-check that the session is not a superuser and is a member of `corpus_writer` → `SET LOCAL ROLE corpus_writer` → restore the previous `role` setting before returning. PR 2b grants `corpus_writer` to APP_DB_USER `WITH INHERIT FALSE, SET TRUE`. | Annex A writes carry exactly `corpus_writer`'s privileges. Staging updates in the same transaction keep the runtime role's. Ordinary API connections cannot write Annex A at all. |
| D15 | Items are processed by kind: judgments, then statute histories, then treatments, in file order within each kind. Each item runs in its own SQL `SAVEPOINT corpus_pub_item`. A guard error (SKP03–SKP06) rolls back the item and records it `rejected`. Any other error aborts the whole publication. | Item atomicity, plus all-or-nothing batches on real faults. |
| D16 | A structural error rejects the whole batch (`BatchError`) before any write. Structural means: shape, types, unknown keys, duplicate `item_key`, more than 500 items, or a bad `batch_key`. Semantic problems become item outcomes. | This is the boundary the spec's §5 table implies. 500 is the spec's §8 cap. |
| D17 | Staging provenance comes from the row: `source_name` = the resolved source; `source_url`; `raw_storage_key` = `raw_pdf_path`; `fetched_at` = `parsing_metadata.fetched_at` if it is valid ISO-8601, else `created_at`; `content_hash` = `content_hash`, else sha256(`raw_text`). `extraction_method` comes from `parsing_metadata.extraction_method` if it is in the 001 set, else `ocr` (if `ocr_applied`), else `pdf` (if `raw_pdf_path`), else `html` (if `raw_html`), else none, which means `provenance_incomplete`. | The model defines `content_hash` as "sha256 of raw_text", so computing it is the same definition. The method is never guessed from a URL. |
| D18 | A treatment with no `treating_bench_type` is quarantined `missing_bench`. Confidence below 0.7 is quarantined `treatment_uncertain`, the B-7 reason. | Consistent with ruling 9, and B-7 names the reason. |
| D19 | `statute.status` is closed: `in_force | repealed | lapsed`, default `in_force`. Anything else is rejected `invalid_statute_status`. | Annex A A.4 enumerates it. Free text would repeat F20's fail-open pattern. |
| D20 | A jurisdiction matches the 8 values case-insensitively after trimming, with no aliases (`KPK`, `Islamabad` and `PK` are refused). | Ruling 6's reasoning: ambiguity fails closed. |
| D21 | Bench aliases are matched on squashed input (lowercase, with whitespace, dots and hyphens removed): `single, singlebench, sb, division, divisionbench, db, full, fullbench, fb, larger, largerbench, lb`. Blank is `missing_bench`. Any other value is `invalid_bench`. `"Full Court"` and `"single judge"` are invalid. | It is a closed set. "Full Court" is ambiguous. |
| D22 | `finish()` recomputes the counts from `corpus_publication_item` and raises `publication_counts_mismatch` (SKP10) if the caller's counts differ. | The audit and the summary cannot disagree. |
| D23 | When a statute history changes the range of an existing promoted version, the item first demotes this section's promoted versions that appear in the item, then upserts versions in `version_no` order. Existing promoted versions not named in the item stay, and an overlap with them is rejected by the guard (SKP06 → `history_overlap`). | It avoids transient self-overlap while keeping the overlap check procedural (spec), serialised by the advisory lock. |
| D24 | The Python citation parser is a strict ASCII subset of TypeScript. The parity property is one-sided: `canonical_key(raw)` is `None` or equals `normaliseCitation(raw)`. It is never a different key. | Drift costs recall, never correctness (spec §8). A parser that drops a sub-series could collapse two authorities onto one key. |
| D25 | 003 defines `corpus_contract_relations()`, the inventory of Annex A tables and views. PR 2b's `provision-roles.sh` excludes those relations from the F30 ownership move and the blanket DML grant. PR 3's 004 must extend it. | Without it, F30 provisioning would hand `corpus_publication_grant` and `judgment_declassify_grant` to the runtime role, and Annex A ownership to the migration role (Review Focus 5). |
| D26 | `citation_extractor.py` is unchanged. `from_staging` re-parses `extracted_citation` through `citations.parse_parts` and rebuilds the TS key, so Karachi → Sindh at publication. | The publication is the single gate into Annex A. Changing the extractor would widen the PR. |
| D27 | In tests, the pytest fixture applies 001+003 to each per-test database. CI also applies 001+003 twice with `psql` to the service database before pytest. That step creates the cluster-global roles once and proves idempotency with the same tool PR 2b's init uses. | Per-test databases are what `corpus_db` gives. Concurrent `CREATE ROLE` races are avoided because the roles already exist. |
| D28 | `test:postgres-ddl` gains `--no-file-parallelism`. | The regression test temporarily installs a vulnerable trigger, and the new PG-DDL-19 re-applies 001, which would restore it mid-test. The two files must not interleave. The probe files themselves are unchanged. |
| D29 | `corpus_publication` adds `finished_at`, and the count columns are `item_count, promoted_count, quarantined_count, updated_count, unchanged_count, rejected_count`. | `begin()` needs the unfinished/finished state. |
| D30 | `corpus_metadata.last_refresh` is `to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, the transaction start. An `already=true` re-run does not touch it. | Transaction start errs toward stale, which fails closed for PR 3. A no-op is not a refresh. |

## Review Focus

These are the inputs most likely to hurt a real operator. Each one has an owning test in the task that owns the code.

1. **Two different authorities under one key, or one item's citations pointing at two judgments.**
   - A Python parser that drops a sub-series (`2099 PLC(CS) 14` vs `2099 PLC 14`), or misreads a court, would publish judgment A under B's canonical key. The gate would then VERIFY B against A's bench and treatments.
   - An item whose citations belong to two existing judgments must not merge them.
   - *Owning tests:*
     - Task 2: `test_python_key_is_none_or_equal_to_typescript` over the sub-series and court golden cases.
     - Task 5: `test_f19_citation_conflict_is_rejected`.
2. **Re-publishing changed content.**
   - A changed judgment must record `updated` with `prev_sha256`, keep the old provenance row, and point `publication_id` at the new publication.
   - Identical content must be `unchanged`, with no write and no new provenance.
   - A review-trust or bench-less re-scrape must not demote a promoted row (D9).
   - A statute history that shifts a boundary must not trip on its own old ranges (D23), but must be rejected against an unnamed overlapping version.
   - *Owning tests:*
     - Task 5: `test_f19_republishing_a_changed_judgment_records_the_previous_hash`.
     - Task 6: `test_f19_republishing_a_statute_history_shifts_boundaries_without_overlap`.
     - Task 8: `test_f19_promotion_outcomes_follow_the_section5_table`, for the re-scrape case.
3. **Superuser seeds and superuser publishers.**
   - A superuser insert bypasses the guard (ruling 2). It must still be impossible to *publish* as a superuser, because that would be audit that lies.
   - In PR 2 the 001 `v_judgment` still shows a superuser-seeded promoted row with no provenance. PR 3's 004 views close that gap. Nothing reads `v_*` until PR 3.
   - *Owning tests:*
     - Task 4: PG-DDL-18.
     - Task 5: `test_f19_publication_refuses_superuser_and_non_writer_sessions`.
4. **A failure partway through a batch, mid-transaction.**
   - A non-guard database error on item 3 of 4 must leave no `corpus_publication` row, no items, no contract rows and no grant row, and the `batch_key` must not be consumed.
   - In promotion, one failing record must not roll back the others (PR 1's F22 property, now on Annex A).
   - *Owning tests:*
     - Task 5: `test_f19_failure_mid_batch_rolls_back_the_whole_publication`.
     - Task 7: `test_f19_cli_failure_leaves_no_trace_and_the_key_unconsumed`.
     - Task 8: the migrated `test_d_citation_free_record_is_quarantined_and_the_batch_continues`.
5. **Provisioning hands Annex A to the wrong role.**
   - The NOCREATEROLE migration owner cannot apply 001 (it needs CREATE ROLE and CREATE EXTENSION). The migrate step therefore must never try, and init must apply it as a superuser.
   - F30's `provision-roles.sh` would move every public relation to MIGRATE_DB_USER, and grant APP_DB_USER DML on `ALL TABLES`. That includes `corpus_publication_grant` and `judgment_declassify_grant`, which would let the runtime role forge a grant row and bypass both guards.
   - *Owning tests:*
     - Task 5: `test_f19_contract_inventory_lists_every_annex_a_relation`.
     - Task 8: `test_f19_orm_has_no_annex_a_table_and_migrate_never_applies_annex_a`.
     - PR 2b Task B1: the probe checks "runtime role has no direct privilege on any Annex A relation" and "migration role owns no Annex A relation".

---

## File map

| File | PR | Change |
|---|---|---|
| `postgres/ddl/003_corpus_publication.sql` | 2 | create |
| `tests/postgres.ddl.integration.test.ts` | 2 | `beforeAll` applies every `postgres/ddl/*.sql` in order; PG-DDL-11..20 appended. PG-DDL-1..10 bodies unchanged. |
| `package.json` | 2 | `test:postgres-ddl` gets `--no-file-parallelism`; new `corpus:citation-golden` |
| `tests/fixtures/corpus/citation-canonical-golden.json` | 2 | create |
| `tests/citations.canonical-golden.test.ts` | 2 | create (checker, and generator in update mode) |
| `corpus_service/scraper/publication/__init__.py`, `vocabulary.py`, `citations.py`, `batch.py`, `annex_a.py`, `from_staging.py`, `cli.py` | 2 | create |
| `corpus_service/scraper/models.py` | 2 | `ScraperStaging.extracted_bench_type` |
| `corpus_service/scraper/database.py`, `migrate.py` | 2 | `upgrade_staging_bench_type` |
| `corpus_service/scraper/tasks/promotion.py` | 2 | publish through `publish_batch` |
| `corpus_service/tests/conftest.py` | 2 | Annex A and role helpers |
| `corpus_service/tests/test_publication_vocabulary.py`, `test_publication_citations.py`, `test_publication_batch.py`, `test_f19_publication_db.py` | 2 | create |
| `corpus_service/tests/test_f20_trust_policy_db.py` | 2 | `test_c` and `test_d` moved onto Annex A (Task 8 mapping) |
| `.github/workflows/gate-g0.yml` | 2 | DDL steps in `corpus-service` and `postgres-ddl` |
| `corpus_service/README.md`, `corpus_service/requirements-test.txt` (comment), `docs/architecture/README.md` | 2 | docs and verified counts |
| `corpus_service/docker/postgres/apply-annex-a.sh`, `docker-compose.yml`, `provision-roles.sh`, `scripts/rotate_postgres_password.sh`, `tests/e2e/{probe.py,store_security_e2e.sh,upgrade_e2e.sh}`, `.github/workflows/corpus-compose-policy.yml` | 2b | see PR 2b |

---

### Task 1: The closed vocabularies

**Files:**
- Create: `corpus_service/scraper/publication/__init__.py` (empty docstring module) and `corpus_service/scraper/publication/vocabulary.py`.
- Test: `corpus_service/tests/test_publication_vocabulary.py`. These are pure tests with no database.

**Interfaces** (produces):

```python
BENCH_TYPES: Final[Tuple[str, ...]] = ("single", "division", "full", "larger")
BENCH_ALIASES: Final[Mapping[str, str]]          # squashed alias -> bench (D21; 12 keys)
TREATMENT_KINDS: Final[Tuple[str, ...]] = ("followed", "applied", "distinguished", "doubted",
                                           "overruled", "per_incuriam", "referred")
TREATMENT_MIN_CONFIDENCE: Final = 0.7
JURISDICTIONS: Final[Tuple[str, ...]] = ("Federal", "Sindh", "Punjab", "KP", "Balochistan", "ICT", "GB", "AJK")
STATUTE_STATUSES: Final[Tuple[str, ...]] = ("in_force", "repealed", "lapsed")
EXTRACTION_METHODS: Final[Tuple[str, ...]] = ("html", "pdf", "ocr", "manual", "api", "export")  # 001 CHECK
CURRENT_TEXT_ONLY_CONFIDENCE: Final = 0.5
COURT_CANONICALS: Final[Tuple[str, ...]] = ("SC", "FSC", "Lahore", "Sindh", "Peshawar", "Quetta",
                                            "Islamabad", "AJ&K", "GB", "Civil", "Criminal", "Tax", "Revenue")
COURT_ALIASES: Final[Mapping[str, str]]          # squashed alias -> canonical (table below)

def squash(raw: str) -> str                      # lowercase; drop whitespace, '.', '-'
def bench_is_missing(raw: object) -> bool        # None, non-str, or blank
def canonical_bench(raw: object) -> Optional[str]
def canonical_treatment(raw: object) -> Optional[str]   # raw.strip().lower() in TREATMENT_KINDS
def canonical_jurisdiction(raw: object) -> Optional[str]
def canonical_statute_status(raw: object) -> Optional[str]  # None -> "in_force"
def canonical_court(raw: object) -> Optional[str]

# Publication reasons (durable strings; quarantine_queue.reason and corpus_publication_item.reason)
REJECT_REASONS: Final[Tuple[str, ...]] = (
    "provenance_incomplete", "invalid_bench", "invalid_treatment_kind", "unresolvable_judgment",
    "history_missing_effective_from", "history_overlap", "history_out_of_order", "invalid_history",
    "invalid_jurisdiction", "invalid_statute_status", "citation_conflict", "citation_missing",
    "promoted_row_protected")
QUARANTINE_REASONS: Final[Tuple[str, ...]] = (
    "missing_bench", "citation_not_canonical", "treatment_uncertain",
    *scraper.trust.QUARANTINE_REASONS[:4])  # review_source, low_confidence, blocked_source, unknown_source
QUARANTINE_PRECEDENCE: Final[Tuple[str, ...]]  # trust reason, then citation_not_canonical, then missing_bench, then treatment_uncertain
```

**`COURT_ALIASES`** (squashed key → canonical). It mirrors the literal alternatives in `citations.ts:58-73`:

| Canonical | Keys |
|---|---|
| SC | `sc`, `supremecourt`, `supremecourtofpakistan` |
| FSC | `fsc`, `federalshariatcourt` |
| Lahore | `lahore`, `lahorehighcourt`, `lah`, `lhc` |
| Sindh | `sindh`, `sindhhighcourt`, `karachi`, `kar`, `shc` |
| Peshawar | `peshawar`, `peshawarhighcourt`, `pesh`, `phc` |
| Quetta | `balochistan`, `balochistanhighcourt`, `quetta`, `bal`, `bhc` |
| Islamabad | `islamabad`, `islamabadhighcourt`, `isl`, `ihc` |
| AJ&K | `aj&k`, `ajk`, `azadjammuandkashmir`, `azadjammu&kashmir`, `azadj&k` |
| GB | `gb`, `gilgitbaltistan` |
| Civil / Criminal / Tax / Revenue | `civil` / `criminal`, `crl` / `tax` / `revenue` |

- [ ] **Step 1:** Write the tests.
  - Each of the 12 bench keys maps correctly; `"Division  Bench"`, `"D.B."` and `"db"` → `division`.
  - `None`, `""` and `"  "` → missing.
  - `"panel"`, `"Full Court"` and `"single judge"` → `None` with `bench_is_missing` False.
  - All 7 kinds; `" Overruled "` → `overruled`; `"per incuriam"`, `"reversed"` and `"OVERRULED!"` → `None`.
  - The 8 jurisdictions and their lowercase forms map; `"PK"`, `"Pakistan"`, `"KPK"`, `"Islamabad"` and `""` → `None`.
  - Every court key above maps; `"Karachi"`, `"Kar."` and `"S.H.C."` → `Sindh`; `"Quetta"` and `"Balochistan High Court"` → `Quetta`; `"Atlantis"` → `None`.
  - Status: `None` → `in_force`; `"Repealed"` → `repealed`; `"in force"` → `None`.
  - The reason tuples are disjoint, and they do not overlap `scraper.trust.REASON_CITATION_MISSING` except where listed.
- [ ] **Step 2:** `python -m pytest corpus_service/tests/test_publication_vocabulary.py -q`. Expected: FAIL (`ModuleNotFoundError: scraper.publication`).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(F19): closed publication vocabularies (bench, treatment, jurisdiction, court aliases)`.

### Task 2: Citation parity: golden fixture, TypeScript checker and Python key builder

**Files:**
- Create: `tests/fixtures/corpus/citation-canonical-golden.json`.
- Create: `tests/citations.canonical-golden.test.ts`. This is the checker; with `UPDATE_CITATION_GOLDEN=1` it is also the generator.
- Modify: `package.json`. Add `"corpus:citation-golden": "UPDATE_CITATION_GOLDEN=1 vitest run tests/citations.canonical-golden.test.ts"`.
- Create: `corpus_service/scraper/publication/citations.py`.
- Test: `corpus_service/tests/test_publication_citations.py`.

**How the golden is generated and kept in sync:**
- The JSON holds hand-written `id`, `raw`, `parts` and `python` fields, and a generated `canonical` field.
- `npm run corpus:citation-golden` runs the TS test in update mode. It rewrites only `canonical` (`normaliseCitation(raw)`, or `null`) with `JSON.stringify(doc, null, 2) + "\n"`.
- In normal mode (CI `npm run test:unit`), the TS test fails if any `canonical` differs from `normaliseCitation(raw)`. Any change to `citations.ts` that moves a key therefore forces a regeneration.
- The pytest in the `corpus-service` job then re-checks Python against the regenerated file.
- Python never writes the file. `tsx` is not a dependency, which is why vitest is the generator.

**Fixture format:**

```json
{ "format": "citation-canonical-golden/1",
  "generatedBy": "npm run corpus:citation-golden",
  "note": "Synthetic 2099 citations only; no real authority.",
  "cases": [ { "id": "pld-karachi", "raw": "PLD 2099 Karachi 12",
               "parts": {"reporter": "PLD", "year": "2099", "court": "Karachi", "series": null, "page": "12", "note": null},
               "python": "match", "canonical": "<generated>" } ] }
```

**Input set:**
- The "expected" column is by reading `citations.ts`. It is UNVERIFIED until the generator runs, and the generator is authoritative.
- Where TS returns `null`, `python` must be `none`.

| id | raw | parts | expected canonical | python |
|---|---|---|---|---|
| pld-sc | `PLD 2099 SC 1` | PLD/2099/SC/1 | `PLD 2099 SC 1` | match |
| pld-supreme-court | `PLD 2099 Supreme Court 1` | court "Supreme Court" | `PLD 2099 SC 1` | match |
| pld-karachi | `PLD 2099 Karachi 12` | court "Karachi" | `PLD 2099 Sindh 12` | match |
| pld-kar-dot | `PLD 2099 Kar. 12` | court "Kar." | `PLD 2099 Sindh 12` | match |
| pld-quetta | `PLD 2099 Quetta 7` | | `PLD 2099 Quetta 7` | match |
| pld-balochistan | `PLD 2099 Balochistan 7` (the Python extractor's Quetta output) | | `PLD 2099 Quetta 7` | match |
| pld-lah | `PLD 2099 Lah. 3` | | `PLD 2099 Lahore 3` | match |
| pld-peshawar, pld-islamabad, pld-gb, pld-ajk | `PLD 2099 Peshawar 4`, `PLD 2099 Islamabad 5`, `PLD 2099 GB 9`, `PLD 2099 AJ&K 8` | | same | match |
| pld-fsc-long | `PLD 2099 Federal Shariat Court 6` | | `PLD 2099 FSC 6` | match |
| pld-series | `PLD 2099 SC (AJ&K) 10` | series "AJ&K" | `PLD 2099 SC(AJ&K) 10` | match |
| pld-lower | `pld 2099 sc 26` | | `PLD 2099 SC 26` | match |
| scmr | `2099 SCMR 11` | | `2099 SCMR 11` | match |
| scmr-dotted | `2099 S.C.M.R. 11` | | `2099 SCMR 11` | match |
| clc-court-dropped | `2099 CLC (Karachi) 12` | series "Karachi" | `2099 CLC 12` | match |
| clc-extractor-shape | `2099 CLC (Sindh) 12` (the extractor's output shape) | series "Sindh" | `2099 CLC 12` | match |
| ylr-court-dropped | `2099 YLR (Quetta) 13` | | `2099 YLR 13` | match |
| plc-series-lead | `2099 PLC (C.S.) 14` | series "C.S." | `2099 PLC(CS) 14` | match |
| plc-series-trail | `2099 PLC 14 (C.S.)` | note "C.S." | `2099 PLC(CS) 14` | match |
| plc-plain | `2099 PLC 14` | | `2099 PLC 14` (a different key from the two above: Review Focus 1) | match |
| pcrlj, pcrlj-dotted | `2099 PCrLJ 15`, `2099 P.Cr.L.J. 15` | | `2099 PCrLJ 15` | match |
| plj-reporter-first, plj-year-first | `PLJ 2099 SC 16`, `2099 PLJ SC 16` | | `PLJ 2099 SC 16` | match |
| nlr-section | `NLR 2099 Civil 24` | | `NLR 2099 Civil 24` | match |
| ptd, ptcl, cld, mld, gblr, scr, klr-year | `2099 PTD 17` … `2099 KLR 23` | | same | match |
| trailing-punct | `2099 SCMR 27.` | null | `2099 SCMR 27` | none |
| spaced-abbrev | `2099 S C M R 28` | null | `2099 SCMR 28` | none |
| two-cites | `2099 SCMR 1 and 2099 SCMR 2` | null | null | none |
| unknown-court | `PLD 2099 Atlantis 1` | null | null | none |
| no-page | `2099 SCMR` | null | null | none |
| ambiguous-page | `PLD 2099 SC 12 3` | null | null | none |
| glued | `2099SCMR12` | null | null | none |
| case-ref | `C.P. No. 12 of 2099` | null | null | none |
| pinpoint-residue | `2099 SCMR 12, 15` | null | null | none |
| empty | `""` | null | null | none |

**Python interfaces:**

```python
@dataclass(frozen=True)
class CitationParts:
    reporter: str                 # canonical spelling, e.g. "PLD", "SCMR", "PCrLJ"
    year: str                     # "(19|20)\d\d"
    page: str                     # digits, kept as text (TS keeps leading zeros)
    court: Optional[str] = None   # alias or canonical (PLD; PLJ/NLR/KLR court-first)
    series: Optional[str] = None  # bracket before the page
    note: Optional[str] = None    # bracket after the page

class CitationError(ValueError): ...           # .reason: str
REPORTER_FIRST: Final = ("PLD", "PLJ", "NLR", "KLR")
YEAR_FIRST: Final = ("SCMR","SCR","PCrLJ","PTCL","PTD","GBLR","CLC","CLD","YLR","MLD","PLC","PLJ","NLR","KLR")
CONTINUOUS: Final = frozenset({"SCMR","SCR","CLC","YLR","MLD","PCrLJ","PTD","PTCL","CLD","GBLR"})
SECTIONED: Final = frozenset({"PLJ","NLR","KLR"})
NOTES: Final = frozenset({"SUPRA","IBID","SIC","EMPHASISSUPPLIED","EMPHASISADDED"})

def build_canonical(parts: CitationParts) -> str        # raises CitationError
def parse_parts(text: str) -> Optional[CitationParts]   # strict, ASCII only, whole string = one citation
def canonical_key(text: str) -> Optional[str]           # build(parse(text)), None on any failure
def is_canonical(text: str) -> bool                     # canonical_key(text) == text
```

**`build_canonical` mirrors `strictHits`/`keyed()` in `citations.ts:~205-330`:**
- PLD, or a SECTIONED reporter with a court, is reporter-first. The head is `f"{reporter} {year} {canonical_court(court)}"`, followed by `keyed(head, page, paren(series), paren(note))`.
- Any other YEAR_FIRST reporter must have no court.
  - If it is CONTINUOUS: `leading = paren(series)` only when `canonical_court(series)` is None, and the note is dropped.
  - Otherwise: `keyed(f"{year} {reporter}", page, paren(series), paren(note))`.
- `paren(x)` is `canonical_court(x) or re.sub(r"[.\s]", "", x).upper()`.
- `keyed` drops a trailing value that is in NOTES. If both leading and trailing are set and differ, the result is `f"{head}({lead}) {page} ({tail})"`.

**`parse_parts` accepts only these shapes:**
- The input is whitespace-collapsed and trimmed. Any non-ASCII input returns None.
- Reporter-first: `^(PLD|PLJ|NLR|KLR) ((?:19|20)\d\d) (court words, 1-5 tokens)(?: ?\(([^()]{1,30})\))? (\d+)(?: \(([^()]{1,30})\))?$`.
- Year-first: the year-first analogue, where the optional court is allowed only for SECTIONED.
- A reporter token matches case-insensitively after removing dots.

- [ ] **Step 1:** Write `tests/citations.canonical-golden.test.ts`. In check mode it asserts:
  - (a) Every non-empty `raw` contains `2099` and no other `(19|20)\d\d`.
  - (b) `id`s are unique.
  - (c) `normaliseCitation(raw) === canonical` for every case.
  - (d) For a non-null `canonical`, `normaliseCitation(canonical) === canonical`. PR 3's reader relies on this fixed point.
  - (e) `python === "none"` whenever `canonical === null`.
  - (f) Coverage: every `COURT_CANONICALS` value appears in some canonical; a Karachi and a Quetta/Balochistan alias case exist; and leading and trailing sub-series cases exist.

  In update mode it rewrites `canonical`, then runs the same assertions.
- [ ] **Step 2:** Write `test_publication_citations.py`:
  - `test_golden_is_synthetic_2099_only`.
  - `test_builder_reproduces_typescript`: for every case with `parts`, `build_canonical(CitationParts(**parts)) == canonical`.
  - `test_python_key_is_none_or_equal_to_typescript`: for every case, `canonical_key(raw) in (None, canonical)`. `python == "match"` requires equality and `"none"` requires None.
  - `test_canonical_is_canonical`: `is_canonical(canonical)` for every non-null case.
  - `test_builder_refuses`: PLD without a court, a court on SCMR, an unknown reporter, an unknown court, page `"12A"` and year `"1899"` each raise `CitationError`.

  The golden path is `Path(__file__).resolve().parents[2] / "tests/fixtures/corpus/citation-canonical-golden.json"`.
- [ ] **Step 3:** Run red. `npx vitest run tests/citations.canonical-golden.test.ts` fails with ENOENT (no fixture). The pytest fails with `ModuleNotFoundError`.
- [ ] **Step 4:** Write the fixture inputs, then run `npm run corpus:citation-golden`, then implement `citations.py`.
- [ ] **Step 5:** Run green: `npx vitest run tests/citations.canonical-golden.test.ts` and `python -m pytest corpus_service/tests/test_publication_citations.py -q`. If a case marked `match` comes back None in Python, tighten the expectation to `none` only if TS also accepts a wider spelling. **Never** loosen the one-sided property.
- [ ] **Step 6:** `npm run corpus:citation-golden && git diff --exit-code tests/fixtures/corpus/citation-canonical-golden.json`. Expected: no diff.
- [ ] **Step 7:** Commit: `test(F19): citation canonical golden shared by TypeScript and Python; Python key builder`.

### Task 3: The batch format `corpus-publication-batch/1`

**Files:**
- Create: `corpus_service/scraper/publication/batch.py`.
- Test: `corpus_service/tests/test_publication_batch.py`. These are pure tests.

**Interfaces:**

```python
BATCH_FORMAT: Final = "corpus-publication-batch/1"
MAX_BATCH_ITEMS: Final = 500
MAX_BATCH_BYTES: Final = 32 * 1024 * 1024
BATCH_KEY_RE: Final = r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$"
ITEM_KEY_RE: Final = r"^[A-Za-z0-9._:-]{1,100}$"
class BatchError(ValueError): ...      # message names the field path, never a value
# pydantic v2 models, ConfigDict(extra="forbid", frozen=True); validated with model_validate_json
class Trust, Provenance, CitationInput, JudgmentRef, JudgmentItem, TreatmentItem,
      StatuteSpec, SectionSpec, VersionSpec, StatuteSectionHistoryItem, PublicationBatch
Item = Annotated[Union[JudgmentItem, TreatmentItem, StatuteSectionHistoryItem], Field(discriminator="kind")]
def parse_batch_json(raw: bytes) -> PublicationBatch      # BatchError on any structural problem
def load_batch(path: Path) -> PublicationBatch            # size cap, then parse_batch_json
def canonical_json(value: object) -> bytes                # sort_keys, (",",":"), ensure_ascii=False, allow_nan=False
def batch_sha256(batch: PublicationBatch) -> str          # sha256(canonical_json(batch.model_dump(mode="json")))
def entity_sha256(entity_type: str, fields: Mapping[str, object]) -> str  # sha256(canonical_json({"entity":..,"v":1,**fields}))
```

**JSON Schema.** This is normative, and `batch.py` implements it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "corpus-publication-batch/1",
  "type": "object", "additionalProperties": false,
  "required": ["format", "batch_key", "source_kind", "items"],
  "properties": {
    "format": {"const": "corpus-publication-batch/1"},
    "batch_key": {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$"},
    "source_kind": {"enum": ["curated", "staging"]},
    "items": {"type": "array", "minItems": 1, "maxItems": 500, "items": {"$ref": "#/$defs/item"}}
  },
  "$defs": {
    "nstr": {"type": ["string", "null"]},
    "trust": {"type": "object", "additionalProperties": false, "required": ["level", "confidence"],
      "properties": {"level": {"type": ["string", "null"]}, "confidence": {"type": ["number", "null"]}}},
    "provenance": {"type": "object", "additionalProperties": false,
      "properties": {"source_name": {"$ref": "#/$defs/nstr"}, "source_url": {"$ref": "#/$defs/nstr"},
        "raw_storage_key": {"$ref": "#/$defs/nstr"}, "fetched_at": {"type": ["string", "null"], "format": "date-time"},
        "content_hash": {"$ref": "#/$defs/nstr"}, "extraction_method": {"$ref": "#/$defs/nstr"},
        "extractor_version": {"$ref": "#/$defs/nstr"}}},
    "parts": {"type": "object", "additionalProperties": false, "required": ["reporter", "year", "page"],
      "properties": {"reporter": {"type": "string"}, "year": {"type": "string", "pattern": "^(19|20)[0-9]{2}$"},
        "page": {"type": "string", "pattern": "^[0-9]{1,6}$"}, "court": {"$ref": "#/$defs/nstr"},
        "series": {"type": ["string", "null"], "maxLength": 30}, "note": {"type": ["string", "null"], "maxLength": 30}}},
    "citation": {"oneOf": [
      {"type": "object", "additionalProperties": false, "required": ["text"], "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 200}}},
      {"type": "object", "additionalProperties": false, "required": ["parts"], "properties": {"parts": {"$ref": "#/$defs/parts"}}}]},
    "judgment_ref": {"oneOf": [
      {"type": "object", "additionalProperties": false, "required": ["item_key"], "properties": {"item_key": {"type": "string"}}},
      {"type": "object", "additionalProperties": false, "required": ["citation"], "properties": {"citation": {"type": "string", "maxLength": 200}}}]},
    "item": {"oneOf": [{"$ref": "#/$defs/judgment"}, {"$ref": "#/$defs/treatment"}, {"$ref": "#/$defs/statute_section_history"}]},
    "judgment": {"type": "object", "additionalProperties": false,
      "required": ["kind", "item_key", "trust", "provenance", "citations"],
      "properties": {"kind": {"const": "judgment"}, "item_key": {"type": "string", "pattern": "^[A-Za-z0-9._:-]{1,100}$"},
        "trust": {"$ref": "#/$defs/trust"}, "provenance": {"$ref": "#/$defs/provenance"},
        "citations": {"type": "array", "maxItems": 10, "items": {"$ref": "#/$defs/citation"}},
        "case_title": {"$ref": "#/$defs/nstr"}, "bench_type": {"$ref": "#/$defs/nstr"},
        "bench_size": {"type": ["integer", "null"], "minimum": 1, "maximum": 99},
        "decision_date": {"type": ["string", "null"], "format": "date"},
        "full_text": {"$ref": "#/$defs/nstr"}, "headnotes": {"$ref": "#/$defs/nstr"}, "summary": {"$ref": "#/$defs/nstr"}}},
    "treatment": {"type": "object", "additionalProperties": false,
      "required": ["kind", "item_key", "trust", "provenance", "treating", "treated", "treatment", "confidence"],
      "properties": {"kind": {"const": "treatment"}, "item_key": {"type": "string", "pattern": "^[A-Za-z0-9._:-]{1,100}$"},
        "trust": {"$ref": "#/$defs/trust"}, "provenance": {"$ref": "#/$defs/provenance"},
        "treating": {"$ref": "#/$defs/judgment_ref"}, "treated": {"$ref": "#/$defs/judgment_ref"},
        "treatment": {"type": "string", "maxLength": 50}, "passage_anchor": {"type": ["string", "null"], "maxLength": 200},
        "treating_bench_type": {"$ref": "#/$defs/nstr"}, "confidence": {"type": "number", "minimum": 0, "maximum": 1}}},
    "statute_section_history": {"type": "object", "additionalProperties": false,
      "required": ["kind", "item_key", "trust", "provenance", "statute", "section", "history", "versions"],
      "properties": {"kind": {"const": "statute_section_history"}, "item_key": {"type": "string", "pattern": "^[A-Za-z0-9._:-]{1,100}$"},
        "trust": {"$ref": "#/$defs/trust"}, "provenance": {"$ref": "#/$defs/provenance"},
        "statute": {"type": "object", "additionalProperties": false, "required": ["name", "jurisdiction"],
          "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 500}, "short_name": {"$ref": "#/$defs/nstr"},
            "year_enacted": {"type": ["integer", "null"]}, "jurisdiction": {"type": "string"}, "status": {"$ref": "#/$defs/nstr"}}},
        "section": {"type": "object", "additionalProperties": false, "required": ["section_number"],
          "properties": {"section_number": {"type": "string", "minLength": 1, "maxLength": 50},
            "chapter": {"$ref": "#/$defs/nstr"}, "current_title": {"$ref": "#/$defs/nstr"}}},
        "history": {"enum": ["amendment_history", "current_text_only"]},
        "versions": {"type": "array", "minItems": 1, "maxItems": 200, "items": {"type": "object", "additionalProperties": false,
          "required": ["version_no", "effective_from", "effective_to", "text"],
          "properties": {"version_no": {"type": "integer", "minimum": 1}, "effective_from": {"type": ["string", "null"], "format": "date"},
            "effective_to": {"type": ["string", "null"], "format": "date"}, "title": {"$ref": "#/$defs/nstr"},
            "text": {"type": "string"}, "version_confidence": {"type": ["number", "null"], "minimum": 0, "maximum": 1}}}}}}
  }
}
```

**Extra structural rules** (`BatchError`):
- `item_key` must be unique.
- A `judgment_ref.item_key` must name a **judgment** item in the same batch.
- The file must be at most `MAX_BATCH_BYTES`.

Everything else is semantic and decided by `publish_batch`: vocabularies, provenance completeness, canonical citations, trust, history rules.

- [ ] **Step 1:** Write the tests:
  - Minimal judgment, treatment and history batches parse.
  - Unknown keys at each level, a wrong `format`, a duplicate `item_key`, 501 items, `batch_key` values `"/x"` and `"a b"`, a citation with both `text` and `parts`, and a ref to a missing or non-judgment `item_key` each raise `BatchError`. The message must not contain the offending value.
  - `batch_sha256` is stable under key reorder and whitespace in the source JSON, and changes when any value changes.
  - **The semantic boundary:** treatment `"reversed"`, jurisdiction `"PK"`, all-null provenance, and `effective_from: null` all *parse* successfully.
- [ ] **Step 2:** Run red (module missing).
- [ ] **Step 3:** Implement with pydantic v2 discriminated unions.
- [ ] **Step 4:** Run green.
- [ ] **Step 5:** Commit: `feat(F19): corpus-publication-batch/1 format and validation`.

### Task 4: `003_corpus_publication.sql` and PG-DDL-11..20

**Files:**
- Create: `postgres/ddl/003_corpus_publication.sql`.
- Modify: `tests/postgres.ddl.integration.test.ts`:
  - imports and `node:crypto` `randomUUID`;
  - `beforeAll` file loading;
  - new helpers below the existing ones;
  - `it(...)` blocks PG-DDL-11..20 appended at the end of the existing `describe`.
- Modify: `package.json`: `"test:postgres-ddl": "vitest run --no-file-parallelism tests/postgres.ddl.integration.test.ts tests/probe-fa-data-001.regression.test.ts"` (D28).

**Error codes** (D3). Each message is exactly the token.

| SQLSTATE | Message | Raised by |
|---|---|---|
| SKP01 | `batch_key_reused` | `begin`: same key, different `input_sha256` |
| SKP02 | `publication_required` | guard or item guard: no grant row for `(txid_current(), NEW.publication_id)` |
| SKP03 | `provenance_incomplete` | guard |
| SKP04 | `bench_required` | guard: promoted judgment with a NULL or blank `bench_type` |
| SKP05 | `treatment_confidence` / `treatment_judgment_missing` | guard |
| SKP06 | `version_effective_from_required` / `version_range_invalid` / `version_overlap` | guard |
| SKP07 | `publication_superuser_refused` | `begin`, `finish` |
| SKP08 | `publication_already_open` / `publication_unfinished` / `publication_not_open` | `begin`, `finish` |
| SKP09 | `publication_invalid_argument` | `begin` |
| SKP10 | `publication_counts_mismatch` | `finish` |
| SKP11 | `corpus_audit_append_only` | audit triggers |

**003, in order.** Every statement is idempotent. `CREATE OR REPLACE TRIGGER` (PG ≥ 14) avoids a window with no guard.

1. **Defaults.** For each of the 9 contract tables: `ALTER TABLE <t> ALTER COLUMN review_status SET DEFAULT 'quarantined';`.
2. **Audit tables:**
   ```sql
   CREATE TABLE IF NOT EXISTS corpus_publication (
     seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     batch_key TEXT NOT NULL UNIQUE CHECK (batch_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
     input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
     source_kind TEXT NOT NULL CHECK (source_kind IN ('staging','curated')),
     actor_id TEXT NOT NULL CHECK (btrim(actor_id) <> '' AND length(actor_id) <= 200),
     publisher_session_user TEXT NOT NULL,
     item_count INT, promoted_count INT, quarantined_count INT, updated_count INT, unchanged_count INT, rejected_count INT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ,
     CONSTRAINT corpus_publication_counts_on_finish CHECK ((finished_at IS NULL) = (item_count IS NULL)));
   CREATE TABLE IF NOT EXISTS corpus_publication_item (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     publication_id UUID NOT NULL REFERENCES corpus_publication(id),
     item_key TEXT NOT NULL CHECK (item_key ~ '^[A-Za-z0-9._:-]{1,100}$'),
     entity_type TEXT NOT NULL CHECK (entity_type IN ('judgment','citation','treatment','statute','statute_section','statute_section_version')),
     entity_id UUID,
     decision TEXT NOT NULL CHECK (decision IN ('promoted','quarantined','updated','unchanged','rejected')),
     reason TEXT,
     content_sha256 TEXT CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
     prev_sha256 TEXT CHECK (prev_sha256 ~ '^[0-9a-f]{64}$'),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     CHECK (decision = 'rejected' OR entity_id IS NOT NULL),
     CHECK (decision NOT IN ('quarantined','rejected') OR reason IS NOT NULL),
     CHECK (decision = 'rejected' OR content_sha256 IS NOT NULL),
     CHECK (decision <> 'unchanged' OR prev_sha256 = content_sha256));
   CREATE INDEX IF NOT EXISTS corpus_publication_item_publication ON corpus_publication_item (publication_id);
   CREATE INDEX IF NOT EXISTS corpus_publication_item_entity ON corpus_publication_item (entity_type, entity_id, id DESC);
   CREATE TABLE IF NOT EXISTS corpus_publication_grant (
     xid BIGINT PRIMARY KEY, publication_id UUID NOT NULL REFERENCES corpus_publication(id));
   REVOKE ALL ON corpus_publication_grant FROM PUBLIC;
   ```
   Add `COMMENT ON COLUMN corpus_publication.actor_id IS 'Application-asserted actor identifier; not verified by the database.'` (the FA-DATA-001 wording).
3. **Publication link.** For the 9 contract tables and `source_provenance`: `ALTER TABLE <t> ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);`.
4. **Constraints.** Each is added in a DO block only if missing (looked up in `pg_constraint` by `conname` and `conrelid`), added `NOT VALID`, then `VALIDATE`d. VALIDATE on a valid constraint is a no-op.
   - `treatment_treating_bench_type_check`: `CHECK (treating_bench_type IN ('single','division','full','larger'))`. NULL is allowed (D18).
   - `statute_jurisdiction_annex_a_check`: `CHECK (jurisdiction IS NOT NULL AND jurisdiction IN ('Federal','Sindh','Punjab','KP','Balochistan','ICT','GB','AJK'))`.
   - `CREATE UNIQUE INDEX IF NOT EXISTS treatment_natural_key ON treatment (treating_judgment_id, treated_judgment_id, treatment, (coalesce(passage_anchor, '')));`
5. **Helpers.** Each has `SET search_path = pg_catalog, public, pg_temp` and `REVOKE ALL ... FROM PUBLIC`.
   - `corpus_session_is_superuser() RETURNS boolean LANGUAGE sql STABLE`: `SELECT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user), false)`.
   - `corpus_provenance_complete(p_source_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER`. A row exists with non-blank `source_name`, non-null `fetched_at`, non-blank `content_hash`, non-null `extraction_method`, and a non-blank `source_url` or `raw_storage_key`.
   - `corpus_contract_relations() RETURNS SETOF regclass LANGUAGE sql STABLE`. It returns `to_regclass('public.'||name)`, filtered to non-null, for the 29 names:
     - the 16 tables from 001: `classification_rank, source_provenance, court, judge, instrument, statute, statute_section, statute_section_version, judgment, judgment_version, citation, treatment, corpus_metadata, corpus_embeddings, judgment_classification_declassify_audit, judgment_declassify_grant`;
     - the 10 `v_*` views from 001;
     - `corpus_publication, corpus_publication_item, corpus_publication_grant`.
6. **The guard.** `enforce_promoted_via_publication() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`. Its logic:
   - `IF corpus_session_is_superuser() THEN RETURN NEW` (ruling 2, D1).
   - Fires when:
     - `TG_OP='INSERT' AND NEW.review_status='promoted'`, **or**
     - an UPDATE where `(NEW.review_status='promoted' AND OLD.review_status IS DISTINCT FROM 'promoted')`, **or**
     - an UPDATE where `(OLD.review_status='promoted' AND (to_jsonb(NEW) - c_ignored) IS DISTINCT FROM (to_jsonb(OLD) - c_ignored))`, with `c_ignored = ARRAY['classification','updated_at']` (D4, D5).

     Otherwise it returns NEW.
   - Requires an open grant: `EXISTS (SELECT 1 FROM corpus_publication_grant g WHERE g.xid = txid_current() AND g.publication_id = NEW.publication_id)`. Otherwise it raises SKP02 with `DETAIL = format('table %s', TG_TABLE_NAME)`.
   - If `NEW.review_status <> 'promoted'` it returns NEW: a demotion inside a publication gets no content checks.
   - `corpus_provenance_complete(NEW.source_id)`, else SKP03.
   - Table-specific checks read `v_new := to_jsonb(NEW)`, so the one function serves all 9 tables:
     - `judgment`: a blank `bench_type` raises SKP04.
     - `treatment`: confidence NULL or < 0.7 raises SKP05 `treatment_confidence`; a missing treating or treated `judgment` row raises SKP05 `treatment_judgment_missing`.
     - `statute_section_version`:
       - `effective_from` NULL raises SKP06 `version_effective_from_required`;
       - `effective_to <= effective_from` raises `version_range_invalid`;
       - any other promoted version of the same `section_id` (with `id <> NEW.id`) where `daterange(from, to, '[)') && daterange(NEW.from, NEW.to, '[)')` raises `version_overlap`. An existing version with a NULL `effective_from` therefore overlaps everything, which fails closed.

   **Columns compared per table** (all except `classification` and `updated_at`):

   | Table | Authority columns |
   |---|---|
   | court | id, full_name, abbreviation, jurisdiction, city, level, source_id, confidence, review_status, created_at, publication_id |
   | judge | id, name, court_ids, active_from, active_to, source_id, confidence, review_status, created_at, publication_id |
   | instrument | id, type, number, date, title, gazette_ref, text, jurisdiction, source_id, confidence, review_status, created_at, publication_id |
   | statute | id, name, short_name, year_enacted, jurisdiction, status, source_id, confidence, review_status, created_at, publication_id |
   | statute_section | id, statute_id, section_number, chapter, current_title, source_id, confidence, review_status, created_at, publication_id |
   | statute_section_version | id, section_id, version_no, effective_from, effective_to, title, text, amending_instrument_id, version_confidence, source_id, confidence, review_status, created_at, publication_id |
   | judgment | id, case_title, court_id, bench_size, bench_type, judge_ids, decision_date, full_text, headnotes, summary, statutes_cited, citations_cited, is_landmark, citation_count, source_id, confidence, review_status, created_at, publication_id (classification ignored) |
   | citation | id, judgment_id, citation_text, reporter, year, volume_or_court, page, source_id, confidence, review_status, created_at, publication_id |
   | treatment | id, treating_judgment_id, treated_judgment_id, treatment, passage_anchor, treating_bench_type, source_id, confidence, review_status, created_at, publication_id |

   Triggers: `CREATE OR REPLACE TRIGGER <table>_publication_guard BEFORE INSERT OR UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();` for each of the 9 tables. On `judgment`, BEFORE triggers fire alphabetically, so `judgment_monotonic` runs first and FA-DATA-001's messages are unchanged.

   Note: B-7 says `citation_count` and `is_landmark` are "recomputed nightly". Any future nightly job must therefore publish, or extend `c_ignored` by erratum. It is recorded, not built.
7. **Audit enforcement:**
   - `corpus_publication_append_only()` (DEFINER, plpgsql). It allows exactly one case, using nested IFs and never touching OLD outside `TG_OP='UPDATE'`. The case is an UPDATE of `corpus_publication` where all of these hold:
     - `OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL`;
     - nothing else differs outside the count columns and `finished_at`;
     - an open grant for `OLD.id` exists.

     Every other UPDATE, DELETE or TRUNCATE raises SKP11. The triggers are:
     - `corpus_publication_append_only` BEFORE UPDATE OR DELETE FOR EACH ROW;
     - `corpus_publication_no_truncate` BEFORE TRUNCATE FOR EACH STATEMENT;
     - the same pair on `corpus_publication_item`.
   - `corpus_publication_item_guard()` (DEFINER) BEFORE INSERT on `corpus_publication_item`. A superuser is exempt. Otherwise it needs an open grant for `NEW.publication_id`, else SKP02.
8. **Functions** (DEFINER, safe `search_path`):
   ```sql
   corpus_publication_begin(p_batch_key text, p_input_sha256 text, p_source_kind text, p_actor_id text)
     RETURNS TABLE (publication_id uuid, already boolean)
   corpus_publication_finish(p_publication_id uuid, p_counts jsonb) RETURNS bigint
   ```
   - **`begin`.** The body starts with `#variable_conflict use_column` and every column reference is qualified, because the OUT name `publication_id` collides with a column. Steps:
     1. A superuser session raises SKP07.
     2. Validate the arguments (patterns as in the table CHECKs; `source_kind` must be `staging` or `curated`; `actor_id` 1–200 chars), else SKP09.
     3. `PERFORM pg_advisory_xact_lock(hashtextextended('sikander.corpus_publication', 0))`.
     4. If a grant row already exists for `txid_current()`, raise SKP08 `publication_already_open`.
     5. Look up `batch_key`:
        - same hash and finished → `RETURN QUERY SELECT id, true`, writing nothing;
        - same hash and unfinished → SKP08 `publication_unfinished`;
        - different hash → SKP01 `batch_key_reused`, with DETAIL `'this batch_key was published with different content'`.
     6. Otherwise INSERT `corpus_publication` (`publisher_session_user = session_user`), INSERT the grant `(txid_current(), id)`, and return `(id, false)`.
   - **`finish`.** Steps:
     1. A superuser session raises SKP07.
     2. No grant row for `(txid_current(), p_publication_id)` raises SKP08 `publication_not_open`.
     3. Compute `jsonb_build_object('items', count(DISTINCT item_key), 'promoted', …, 'quarantined', …, 'updated', …, 'unchanged', …, 'rejected', …)` from the items. If it is `IS DISTINCT FROM p_counts`, raise SKP10.
     4. UPDATE the counts and `finished_at = clock_timestamp()`, returning `seq`.
     5. DELETE the grant.
     6. Upsert `corpus_metadata` (`ON CONFLICT (key) DO UPDATE`) with `last_refresh` (D30), `publication_seq` = `seq::text`, and `publication_contract = '1'`.
     7. Return `seq`.
9. **Grants:**
   ```sql
   REVOKE ALL ON corpus_publication, corpus_publication_item FROM PUBLIC;
   REVOKE ALL ON corpus_publication_grant FROM corpus_reader, corpus_writer, corpus_declassify;
   REVOKE ALL ON corpus_publication, corpus_publication_item FROM corpus_reader, corpus_declassify;
   GRANT SELECT ON corpus_publication TO corpus_writer;
   GRANT SELECT, INSERT ON corpus_publication_item TO corpus_writer;
   REVOKE UPDATE, DELETE, TRUNCATE ON corpus_publication, corpus_publication_item FROM corpus_writer;
   GRANT SELECT, INSERT, UPDATE ON court, judge, instrument, statute, statute_section, statute_section_version,
     judgment, citation, treatment TO corpus_writer;
   GRANT SELECT, INSERT ON source_provenance TO corpus_writer;
   REVOKE ALL ON FUNCTION corpus_publication_begin(text,text,text,text), corpus_publication_finish(uuid,jsonb),
     enforce_promoted_via_publication(), corpus_publication_append_only(), corpus_publication_item_guard(),
     corpus_provenance_complete(uuid), corpus_session_is_superuser(), corpus_contract_relations() FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION corpus_publication_begin(text,text,text,text), corpus_publication_finish(uuid,jsonb) TO corpus_writer;
   ```
   Then, mirroring 001's DO block: if `app_writer` exists, REVOKE ALL on the three audit tables and both functions from `app_writer`.

   There is no DELETE on any contract table, and no TRUNCATE. `corpus_metadata` is written only through `finish`.

   Gate G-0 [9] forbids comparing classification as text in `.sql`. 003 never compares `classification`.

**Harness changes** (PG-DDL-1..10 bodies are untouched):
- `beforeAll` lists the `.sql` files in `postgres/ddl` with `readdirSync`, sorted. It throws unless the first three are exactly `001_corpus_contract.sql, 002_platform.sql, 003_corpus_publication.sql`. It then applies each file with `admin.query`, so PR 3's 004 is picked up automatically.
- The role setup is unchanged; `corpus_writer` already gets the password `writer` there.
- New helpers:
  - `expectSqlState(p, code, re?)`;
  - `publishAs(client, batchKey, sha, body)`, which runs BEGIN, `begin()`, `body(pid)`, `finish()`, COMMIT, and ROLLBACK on error;
  - `insertProvenance(client, overrides)`.
- New rows use `randomUUID()`, and batch keys are `pgddl-<n>-<uuid>`, because audit rows cannot be deleted (D6).

| Case | Name | Assertions |
|---|---|---|
| PG-DDL-11 | `003: corpus_writer and app_writer cannot promote outside a publication` | As `corpus_writer`: INSERT a promoted judgment (bench, complete provenance) with no publication → SKP02 `publication_required`. INSERT a quarantined one → succeeds, and an UPDATE of it to promoted → SKP02. Insert into `corpus_publication_grant` with `(txid_current(), <any id>)` → 42501. With `begin()` open for A, a row carrying publication B's id → SKP02. As `app_writer`: UPDATE `case_title` of an admin-seeded promoted judgment → SKP02; INSERT promoted → SKP02; `SELECT corpus_publication_begin(...)` → 42501; INSERT into the grant table → 42501. |
| PG-DDL-12 | `003: a promoted row needs complete provenance, a bench, a valid treatment and a valid version history` | Inside one `publishAs(corpus_writer)`, each failure in its own SAVEPOINT: `source_id` NULL → SKP03; provenance without `content_hash` → SKP03; with neither `source_url` nor `raw_storage_key` → SKP03; `raw_storage_key` only → OK; judgment `bench_type` NULL → SKP04; treatment confidence 0.69 → SKP05 `treatment_confidence`, 0.7 → OK; `treated_judgment_id` NULL → SKP05 `treatment_judgment_missing`; `treating_bench_type 'panel'` → 23514; statute `jurisdiction 'PK'` → 23514; a duplicate treatment natural key, with NULL vs `''` anchor → 23505; version `effective_from` NULL → SKP06; `effective_to = effective_from` → SKP06 `version_range_invalid`; overlapping a promoted version → SKP06 `version_overlap`; adjacent `[2099-01-01,2099-07-01)` and `[2099-07-01,NULL)` → OK. |
| PG-DDL-13 | `003: review_status defaults to quarantined on every contract table` | For each of the 9 tables, `information_schema.columns.column_default` matches `'quarantined'`. A judgment inserted by `corpus_writer` without `review_status` reads back `quarantined`, and `corpus_reader` does not see it in `v_judgment`. |
| PG-DDL-14 | `003: declassify() still downgrades a published judgment; only classification and updated_at bypass the guard` | `corpus_writer` publishes a promoted judgment with `classification 'privileged'`. `corpus_declassify` `declassify(id,'public','partner-1','reason')` succeeds; the classification is `public`, the audit row exists, and `publication_id` is unchanged. `app_writer` raising classification `public→internal` succeeds; `updated_at = now()` only succeeds; `citation_count = 1` → SKP02; `classification` plus `case_title` together → SKP02. `judgment_monotonic.tgenabled = 'O'`. |
| PG-DDL-15 | `003: corpus_publication_begin is idempotent per (batch_key, input_sha256)` | Tx1: `begin(k, h1)` → `(id1, false)`, then `finish(id1, zeros-with-items-0)` → seq s1. Tx2: `begin(k, h1)` → `(id1, true)`, no grant row for tx2, one `corpus_publication` row for k. `corpus_metadata.publication_contract = '1'`, `publication_seq = s1`, `last_refresh` matches the ISO pattern. A second `begin` in one transaction → SKP08. `finish` with wrong counts → SKP10. No grant rows remain. |
| PG-DDL-16 | `003: a reused batch key with different content is refused (batch_key_reused)` | `begin(k, h2)` → code SKP01, message `batch_key_reused`. Afterwards there is still one row for k, and its hash is h1. |
| PG-DDL-17 | `003: publication audit tables are append-only` | As `corpus_writer`: UPDATE or DELETE on `corpus_publication` and `corpus_publication_item` → 42501; INSERT into `corpus_publication` → 42501; INSERT into an item of a finished publication → SKP02. As admin: UPDATE `corpus_publication.batch_key` → SKP11; DELETE an item → SKP11; `TRUNCATE corpus_publication_item` → SKP11. Through the `aclexplode` pattern of PG-DDL-8, PUBLIC has no EXECUTE on `begin`/`finish`, and only `corpus_writer` does. |
| PG-DDL-18 | `003: superuser sessions are exempt from the guard (ruling 2) but cannot publish` | Admin INSERTs a promoted judgment with no provenance and no publication → succeeds, and `publication_id` is NULL. Admin `begin(...)` → SKP07. Admin `SET ROLE corpus_writer; begin(...)` → SKP07, because `session_user` is still the superuser. **Note:** reader views excluding this row are PR 3's 004 (`v_authority_*`); the 001 `v_judgment` still shows it in PR 2. |
| PG-DDL-19 | `003: the DDL chain re-applies cleanly (001, 002, 003, then again)` | Re-run every file → no error. Exactly 9 `*_publication_guard` triggers, all `tgenabled 'O'`. Each new CHECK exists once and is `convalidated`. `corpus_contract_relations()` is unchanged in count (29). `v_judgment` is still readable by `corpus_reader`. |
| PG-DDL-20 | `003: corpus_reader sees a published judgment and citation through v_judgment and v_citation, and nothing of the audit` | After `publishAs`, the reader's `v_judgment JOIN v_citation` returns the row. `corpus_publication`, `corpus_publication_item` and `corpus_publication_grant` → 42501. |

- [ ] **Step 1:** Write PG-DDL-11..20 and the `beforeAll` change. Then run against a private `pgvector/pgvector:pg16` (your own dockerd, private socket, unique names): `SIKANDER_POSTGRES_URL=postgres://postgres:postgres@<host>:<port>/sikander_ci npm run test:postgres-ddl`.

  Expected: FAIL. The file-list assertion throws (no 003), so every test fails.

  To prove the behavioural red, run once with the file-list guard temporarily relaxed, without committing that. The expected failures:
  - PG-DDL-11: the promoted insert *succeeds*.
  - PG-DDL-13: the default is `'promoted'`.
  - PG-DDL-15–17 and 20: `42883 function corpus_publication_begin does not exist`.

  Save the output as `f19-ddl-red.log`.
- [ ] **Step 2:** Implement 003.
- [ ] **Step 3:** Run the harness. Expected: **22 passed** (PG-DDL-1..20 plus the 2 probe-regression tests).
- [ ] **Step 4:** Run `npm run probe:fa-data-001` against the same database. Expected: `Probe FA-DATA-001: PASSED`.
- [ ] **Step 5:** Apply 001, 002 and 003 twice by hand with `psql -v ON_ERROR_STOP=1`. Expected: no errors.
- [ ] **Step 6:** `git diff origin/claude/remediate-f20-trust -- postgres/ddl/001_corpus_contract.sql postgres/ddl/002_platform.sql docs/audit/probes tests/probe-fa-data-001.regression.test.ts`. Expected: empty.
- [ ] **Step 7:** Commit: `fix(F19): 003_corpus_publication.sql - publication guard, append-only audit, quarantined default; PG-DDL-11..20`.

### Task 5: `publish_batch`: judgments, citations, audit and idempotency

**Files:**
- Create: `corpus_service/scraper/publication/annex_a.py`.
- Modify: `corpus_service/tests/conftest.py`.
- Create: `corpus_service/tests/test_f19_publication_db.py`.

**Conftest additions:**

```python
REPO_ROOT = PROJECT_ROOT.parent
ANNEX_A_DDL = ("001_corpus_contract.sql", "003_corpus_publication.sql")
ORM_TABLES = ("courts", "scraper_sources", "case_law_master", "statutes_master", "scraper_staging",
              "statutes_staging", "scraper_jobs", "quarantine_queue", "embedding_queue")
class CorpusTestDatabase:
    def apply_annex_a(self, files: Sequence[str] = ANNEX_A_DDL) -> None
        # admin, this DB, asyncpg.connect(plain postgresql:// URL) + conn.execute(sql) per file
        # (simple-query protocol: multi-statement, DO blocks, $$ bodies; one implicit tx per file)
    def runtime_role(self) -> Tuple[str, str]
        # create_role("f19_app"); DML on ORM_TABLES and their sequences (NOT "ALL TABLES": mirrors PR 2b);
        # GRANT corpus_writer TO role WITH INHERIT FALSE, SET TRUE
    def writer_role(self) -> Tuple[str, str]   # create_role("f19_pub") + GRANT corpus_writer ... INHERIT FALSE, SET TRUE
    def reader_role(self) -> Tuple[str, str]   # create_role("f19_rdr") + GRANT corpus_reader TO role
    @contextlib.contextmanager
    def app_engine_as(self, user: str, password: str) -> Iterator[None]   # rebinds database.engine/SessionLocal
    def run_cli(self, *args: str, user: str, password: str) -> subprocess.CompletedProcess  # like migrate(), redacted
```

The roles are cluster-global and are dropped by the existing teardown. `WITH INHERIT FALSE, SET TRUE` needs PG16, which matches the fixture image.

**`annex_a.py` interfaces:**

```python
class PublicationError(Exception):
    code: str   # "transaction_required" | "superuser_session" | "not_corpus_writer" | "batch_key_reused" | "publication_state"
@dataclass(frozen=True)
class ItemOutcome:
    item_key: str
    entity_type: str                    # judgment|citation|treatment|statute|statute_section|statute_section_version
    entity_id: Optional[uuid.UUID]
    decision: str                       # promoted|quarantined|updated|unchanged|rejected
    reason: Optional[str]
    content_sha256: Optional[str]
    prev_sha256: Optional[str]
    review_status: Optional[str]        # the entity's review_status after this publication
@dataclass(frozen=True)
class PublicationResult:
    publication_id: uuid.UUID
    batch_key: str
    input_sha256: str
    already: bool
    seq: int
    counts: Mapping[str, int]           # items, promoted, quarantined, updated, unchanged, rejected
    outcomes: Tuple[ItemOutcome, ...]
    def primary(self, item_key: str) -> ItemOutcome   # judgment / treatment / statute_section row of the item
GUARD_REASONS: Final[Mapping[str, str]] = {
    "provenance_incomplete": "provenance_incomplete", "bench_required": "missing_bench",
    "treatment_confidence": "treatment_uncertain", "treatment_judgment_missing": "unresolvable_judgment",
    "version_effective_from_required": "history_missing_effective_from",
    "version_range_invalid": "history_out_of_order", "version_overlap": "history_overlap"}
async def publish_batch(conn: AsyncConnection, batch: PublicationBatch, actor_id: str) -> PublicationResult
```

**Algorithm.** Every statement uses `text()` with bound parameters, schema-qualified `public.`, and `CAST(:x AS jsonb)`, never `::`.
1. If `not conn.in_transaction()`, raise `PublicationError("transaction_required")`.
2. `SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user`. If true, raise `"superuser_session"` (D2).
3. `SELECT pg_has_role(session_user, 'corpus_writer', 'MEMBER')`. If false, raise `"not_corpus_writer"`.
4. `prev = current_setting('role')`, then `SET LOCAL ROLE corpus_writer` (D14).
5. `begin(batch_key, batch_sha256(batch), source_kind, actor_id)`. SKP01 becomes `PublicationError("batch_key_reused")`; the caller must roll back. If `already`, rebuild the outcomes from `corpus_publication_item` and the current entity statuses, restore the role, and return.
6. Process items by kind (D15). For each item: `SAVEPOINT corpus_pub_item`, then plan, then write. Audit rows are inserted inside the savepoint. On a `DBAPIError` whose SQLSTATE is in SKP03–SKP06: `ROLLBACK TO SAVEPOINT`, record `rejected` with `GUARD_REASONS[token]`, then `RELEASE`. Any other error is re-raised.
7. **Judgment item:**
   - (a) Provenance is incomplete (Global rule, same predicate as SQL) → `rejected provenance_incomplete`. There are no citations → `rejected citation_missing`. A non-blank bench that is not in the set → `rejected invalid_bench`.
   - (b) Keys are the canonical keys (from `parts` via `build_canonical`, or `text` if `is_canonical`), plus the raw non-canonical texts. Resolve them as in D11; more than one judgment → `rejected citation_conflict`.
   - (c) The target is `promoted` only if `publication_decision(trust).promote`, the bench is present, and at least one canonical key exists. Otherwise it is `quarantined` with the first reason in `QUARANTINE_PRECEDENCE`.
   - (d) If the resolved judgment is promoted and the target is quarantined → `rejected promoted_row_protected` (D9).
   - (e) The hash is `entity_sha256("judgment", …)` (D10). `prev` is the latest audit hash for `('judgment', id)`. If they are equal → `unchanged`, with the previous reason carried over. Otherwise INSERT `source_provenance` (with `publication_id`), then INSERT or UPDATE `judgment`, setting `source_id`, `publication_id`, `review_status`, `confidence = trust.confidence` and `updated_at = now()`, but never `classification`.
   - (f) Citations: canonical keys are promoted if and only if the judgment target is promoted; non-canonical texts are `quarantined citation_not_canonical`. `reporter`, `year`, `volume_or_court` (court or series) and `page` come from the parts. Insert new citations, or compare hashes on existing ones. `source_id` is the judgment's current provenance.
8. `finish(pid, counts)`, where `counts` is the `Counter` of audit decisions plus `items`.
9. Read the final `review_status` for each outcome entity, restore the role with `set_config('role', prev, true)`, and return.

**Tests** (each uses `corpus_db`, `migrate()`, `apply_annex_a()`, and a writer role through `app_engine_as`):
- `test_f19_vocabulary_matches_the_ddl_checks`. The literals in `pg_get_constraintdef` for `judgment.bench_type` (001), `treatment` (001), `treatment_treating_bench_type_check` and `statute_jurisdiction_annex_a_check` equal `BENCH_TYPES`, `TREATMENT_KINDS` and `JURISDICTIONS`. `source_provenance.extraction_method` equals `EXTRACTION_METHODS`.
- `test_f19_contract_inventory_lists_every_annex_a_relation`. On a fresh database with only 001+003 (no migrate), every `pg_class` in `public` with relkind `r` or `v` equals the set from `corpus_contract_relations()`, with 29 members.
- `test_f19_publish_batch_judgments_citations_and_audit`. Publish a judgment item with `parts` `{PLD, 2099, Karachi, 12}`, bench `"D.B."`, trust `("trusted", 0.9)` and complete provenance. Then:
  - the judgment is promoted, `bench_type='division'`, and `publication_id` is the publication's id;
  - `citation_text = 'PLD 2099 Sindh 12'` is promoted;
  - a `source_provenance` row carries the given fields;
  - `corpus_publication` has `source_kind 'curated'`, `publisher_session_user` = the writer role, and `finished_at` set, with counts `{items:1, promoted:2, …0}`;
  - two items exist;
  - `corpus_metadata` has `publication_contract`, `publication_seq` and `last_refresh`;
  - no grant rows remain;
  - a reader role sees the row through `v_judgment JOIN v_citation`, and gets 42501 on the base table and the audit tables.
- `test_f19_publish_batch_is_idempotent_and_refuses_a_reused_key`. The same batch twice gives `already=True`, an identical snapshot of every Annex A and audit table, and an unchanged `last_refresh`. A changed `full_text` under the same key raises `PublicationError("batch_key_reused")`, and the transaction rolls back with nothing changed.
- `test_f19_citation_conflict_is_rejected`. With J1 at `2099 SCMR 1` and J2 at `2099 SCMR 2` published, an item citing both is `rejected citation_conflict`, and J1, J2 and the citations are unchanged.
- `test_f19_republishing_a_changed_judgment_records_the_previous_hash`:
  - k1 publishes J.
  - k2 with a changed `full_text` gives `updated` with `prev_sha256 = k1's hash`. A new provenance row is written and the old one remains; `judgment.source_id` is the new row, and `publication_id` is k2's.
  - k3, identical to k2, gives `unchanged`: `updated_at` is unchanged and no new provenance row is written.
  - k4, the same content with trust `review`, gives `rejected promoted_row_protected`, and J stays promoted and unchanged.
- `test_f19_failure_mid_batch_rolls_back_the_whole_publication`. Admin installs a test trigger on `judgment` that raises `23514` for `case_title = 'F19 fault 2099'`. Item 3 of 4 carries that title, and `publish_batch` raises an `IntegrityError` (via SQLAlchemy). After rollback:
  - no `corpus_publication` row exists for the key;
  - Annex A has no rows from items 1–2;
  - no grant rows exist.

  After dropping the trigger, the same key publishes successfully.
- `test_f19_publication_refuses_superuser_and_non_writer_sessions`. On the admin engine, `PublicationError("superuser_session")` is raised before any write. On a role with no membership, `"not_corpus_writer"` is raised. Outside a transaction, `"transaction_required"` is raised.
- `test_f19_writer_cannot_bypass_the_publication`. The runtime role, through the app engine, runs `SET LOCAL ROLE corpus_writer` then INSERTs a promoted judgment → SKP02. An INSERT into `corpus_publication_grant` → 42501. An UPDATE of `corpus_publication` → 42501.

Steps:
- [ ] **Step 1:** Write the conftest helpers and the tests above.
- [ ] **Step 2:** Run red. `python -m pytest corpus_service/tests/test_f19_publication_db.py -q` with the URL. Expected: `ImportError: scraper.publication.annex_a`. The two inventory and vocabulary tests pass already, because 003 is present.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run green. Then run the full corpus pytest (the F20 tests are still unchanged and must pass).
- [ ] **Step 5:** Commit: `fix(F19): publish_batch writes Annex A only through an audited corpus publication`.

### Task 6: `publish_batch`: treatments and statute histories

**Files:**
- Modify: `annex_a.py`.
- Extend: `test_f19_publication_db.py`.

**Treatment item:**
- Resolve `treating` and `treated`:
  - an `item_key` resolves to that judgment item's entity, unless the item was rejected;
  - a `citation` is resolved as an exact `citation_text` lookup of a canonical key.

  A missing judgment → `rejected unresolvable_judgment`.
- A kind that is not canonical → `rejected invalid_treatment_kind`.
- `treating_bench_type`: blank → `quarantined missing_bench`; invalid → `rejected invalid_bench`.
- Confidence below 0.7 → `quarantined treatment_uncertain`. A non-promoting trust → `quarantined <trust reason>`.
- The natural key gives the existing row. If it is promoted and the target is quarantined → `rejected promoted_row_protected`. Otherwise compare hashes, then insert or update.

**Statute history item:**
- Jurisdiction → else `rejected invalid_jurisdiction`. Status → else `rejected invalid_statute_status`.
- History rules, checked in this order:
  1. any `effective_from` is null → `history_missing_effective_from`;
  2. `effective_to <= effective_from`, or `effective_from` not strictly increasing by `version_no`, or an open end on a version other than the last → `history_out_of_order`;
  3. overlap within the item → `history_overlap`;
  4. for `current_text_only`: anything other than exactly one version with `effective_to` null and `version_confidence` absent or equal to 0.5 → `invalid_history`. It is stored at 0.5.
- Upsert the statute on `(name, jurisdiction)`, the section on `(statute_id, section_number)`, and versions on `(section_id, version_no)`, using the D23 ordering.
- Audit rows are written for the statute, the section and each version.

**Tests:**
- `test_f19_treatments_follow_the_b7_rules`. With judgments J1 (`PLD 2099 SC 1`, larger) and J2 (`2099 SCMR 2`, division) published:
  - `"Overruled"` at 0.9 with a larger treating bench → promoted `treatment='overruled'`;
  - 0.6 → `quarantined treatment_uncertain`;
  - `"reversed"` → `rejected invalid_treatment_kind`;
  - treated `2099 SCMR 999` → `rejected unresolvable_judgment`;
  - treating bench `"panel"` → `rejected invalid_bench`;
  - no treating bench → `quarantined missing_bench`;
  - trust `review` → `quarantined review_source`.

  The reader's `v_treatment` shows only the promoted row.
- `test_f19_statute_histories_follow_the_b5_rules`. Using "Test Act 2099":
  - `Federal`, with versions `[2099-01-01,2099-07-01)` and `[2099-07-01,null)` → promoted, and the reader's `v_statute_section_version` has 2 rows;
  - an overlap → `history_overlap`;
  - a missing `effective_from` → `history_missing_effective_from`;
  - out of order → `history_out_of_order`;
  - `"PK"` → `invalid_jurisdiction`;
  - `current_text_only` → promoted with `version_confidence = 0.5`;
  - `current_text_only` with 0.9 → `invalid_history`;
  - `status "in force"` → `invalid_statute_status`.
- `test_f19_republishing_a_statute_history_shifts_boundaries_without_overlap`:
  - Published `[Jan,Jul)` and `[Jul,null)`. Republishing `[Jan,Aug)` and `[Aug,null)` gives both versions `updated` and both promoted, with no guard error.
  - Separately, admin seeds a promoted v3 `[2099-09-01,null)` on the same section **through a publication** (a writer role, not a superuser). Then a history naming only v1 and v2 with `[Jul,null)` → the guard raises SKP06, and the item is `rejected history_overlap` with nothing changed.

Steps:
- [ ] **Step 1:** Write the tests.
- [ ] **Step 2:** Run red. Expected: these items are rejected as an unknown kind, or `NotImplementedError` from the Task 5 dispatcher stub.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run green.
- [ ] **Step 5:** Commit: `fix(F19): treatments and statute section histories publish under the B-5 and B-7 rules`.

### Task 7: The CLI for curated batches

**Files:**
- Create: `corpus_service/scraper/publication/cli.py`.
- Extend: `test_f19_publication_db.py`.

**Interfaces:**

```python
def main(argv: Optional[Sequence[str]] = None) -> int
async def run_publish(batch_path: Path, actor_id: str) -> PublicationResult
# python -m scraper.publication.cli publish --batch FILE --actor ID
```

- **Connection.** It uses `scraper.database.engine`, that is, `DATABASE_URL`, the same way `scraper.migrate` does. It runs `async with engine.begin() as conn: publish_batch(...)` and disposes of the engine at the end. The URL's role must be `corpus_writer` or a member of it.
- **Output.** stdout gets one JSON object: `{"publication_id","batch_key","already","seq","counts","items":[{"item_key","entity_type","entity_id","decision","reason","review_status"}]}`. It never contains text, titles or URLs.
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | success (including `already`) |
  | 2 | usage error, or `BatchError` |
  | 3 | `batch_key_reused` |
  | 4 | `superuser_session` or `not_corpus_writer` |
  | 1 | anything else |

  stderr gets `publication.failed error=<ExceptionClass>`, and never row data.

**Tests:**
- `test_f19_cli_publishes_a_curated_batch_and_the_reader_sees_it`. The batch is built in the test as a dict, written to `tmp_path`, and covers every row of the spec §5 table with 2099 data:
  - missing provenance → rejected;
  - an invalid bench → rejected;
  - an invalid treatment kind → rejected;
  - an unresolvable judgment → rejected;
  - three bad histories → rejected;
  - an invalid jurisdiction → rejected;
  - treatment confidence 0.6 → quarantined;
  - trust `review` → quarantined;
  - no bench → quarantined;
  - a non-canonical `{"text": "PLD 2099 Atlantis 1"}` → quarantined;
  - current text only → 0.5;
  - a `"Overruled"` treatment.

  It runs through `run_cli(..., user=<writer role>)`. Expected: exit 0, and stdout counts equal the audit counts. The reader sees exactly the promoted judgments, citations, the treatment and the versions.
- `test_f19_cli_rerun_is_a_no_op_and_a_reused_key_is_refused`. A second run gives exit 0 with `"already": true`, and the Annex A and audit snapshot is identical. Editing one `full_text` under the same key gives exit 3, `batch_key_reused` in stderr, and an identical snapshot.
- `test_f19_cli_failure_leaves_no_trace_and_the_key_unconsumed`. The fault trigger is the one from Task 5. Expected: exit 1, stderr names only the exception class, and there is no audit row, Annex A row or grant. The re-run after removing the trigger gives exit 0.
- `test_f19_cli_refuses_a_superuser_url`. Running with the admin URL gives exit 4.

Steps:
- [ ] **Step 1:** Write the tests.
- [ ] **Step 2:** Run red (`No module named scraper.publication.cli`, exit 1).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run green.
- [ ] **Step 5:** Commit: `fix(F19): publication CLI for curated batches (treatments, statute histories)`.

### Task 8: Staging bench column, `from_staging`, and promotion through `publish_batch`

**Files:**
- Modify: `corpus_service/scraper/models.py`. Add `ScraperStaging.extracted_bench_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)` after `extracted_reporter`, plus a comment: raw text, aliases mapped at publication.
- Modify: `corpus_service/scraper/database.py`. Add `async def upgrade_staging_bench_type(conn: AsyncConnection) -> None`. It is idempotent: if `information_schema.columns` already has the column, it logs `staging bench column already present` and runs no DDL. Otherwise it runs `ALTER TABLE scraper_staging ADD COLUMN extracted_bench_type VARCHAR(100)`.
- Modify: `corpus_service/scraper/migrate.py`. The order becomes `create_schema` → `upgrade_trust_vocabulary` → `upgrade_staging_bench_type` → `seed_data`, with the upgrades in one `engine.begin()`. Update the docstring.
- Create: `corpus_service/scraper/publication/from_staging.py`.
- Modify: `corpus_service/scraper/tasks/promotion.py`.
- Modify: `corpus_service/tests/test_f20_trust_policy_db.py` (`test_c`, `test_d`).
- Extend: `test_f19_publication_db.py`.

**`from_staging.py`:**

```python
STAGING_ACTOR_ID: Final = "corpus_service:promote_staging_records"
STAGING_ITEM_KEY: Final = "judgment"
def staging_batch_key(staging_id: uuid.UUID) -> str              # "staging/<uuid>"
def staging_provenance(st: ScraperStaging, source: ScraperSource) -> Provenance   # D17
def staging_batch(st: ScraperStaging, source: ScraperSource) -> PublicationBatch
    # one judgment item: trust (source.trust_level, st.confidence_score); case_title=extracted_title;
    # bench_type=extracted_bench_type; full_text=raw_text; bench_size/decision_date None (D12);
    # citations=[{"parts": parse_parts(extracted_citation)}] or [{"text": extracted_citation.strip()}]
@dataclass(frozen=True)
class StagingOutcome:
    promoted: bool
    judgment_id: Optional[uuid.UUID]
    reason: Optional[str]
    details: Mapping[str, object]   # {"annex_a": {"publication_id", "decision", "judgment_id"}}
def staging_outcome(result: PublicationResult) -> StagingOutcome
    # promoted iff primary.review_status == "promoted" (decision promoted|updated|unchanged)
```

**`promotion.py`.** It keeps PR 1's selection, `_resolve_source`, `citation_missing`-first, `publication_decision`, `_quarantine`, the per-record `begin_nested` and commit, the failure log, and the return keys `{"promoted","quarantined","failed"}`. The changes:
- Remove the `CaseLawMaster` duplicate check and write, and the `EmbeddingQueue` enqueue, together with their imports (ruling 10).
- For a promote decision: `await db.flush()`, then `conn = await db.connection()`, then `result = await publish_batch(conn, staging_batch(st, src), STAGING_ACTOR_ID)`, then `outcome = staging_outcome(result)`.
  - If promoted: `st.promoted=True`, `promoted_at=func.now()`, `promoted_to_id=outcome.judgment_id` (the **Annex A `judgment.id`**).
  - Otherwise: `_quarantine(db, st, src, outcome.reason, resolved_by, extra_details=outcome.details)`.
- A `PublicationError` or database error propagates to PR 1's per-record handler: the record is counted as failed and left pending.
- Update the module docstring.

**F20 test migration.** Nothing is removed; every assertion is mapped.

| PR 1 assertion | Replacement |
|---|---|
| `test_c` staged citations `"2099 F20 n"` | `"2099 SCMR n"`, which is canonical. `_stage` defaults gain `extracted_bench_type="single"` and `raw_html="<p>synthetic F20 fixture</p>"`. The trust outcome table is unchanged. |
| `test_c` runs `_promote()` as the admin | Runs inside `corpus_db.app_engine_as(*corpus_db.runtime_role())` after `apply_annex_a()`, as in production after PR 2b. A superuser is refused (D2). |
| `{row[1] for row in master} == promoted_citations`, `len(master) == 4` | The set of promoted `citation_text` values joined to promoted `judgment` rows equals `{"2099 SCMR 1","2099 SCMR 7","2099 SCMR 9","2099 SCMR 10"}`, and there are 4 judgments. |
| `promoted_to_id` set == master ids | `promoted_to_id` set == those Annex A judgment ids |
| embedding rows == master ids, table `case_law_master` | `embedding_queue` has 0 rows **and** `case_law_master` has 0 rows (ruling 10) |
| quarantine reasons, `result == {4, 6, 0}`, second pass no-op | Unchanged, plus the second pass leaves every Annex A and audit table identical. |
| `test_d` `db_error` row via `extracted_year=1800` (`ck_case_law_year_sane`) | The row has `extracted_title="F22 fault 2099"`. Admin installs a trigger on `judgment` that raises `RAISE EXCEPTION 'f22 marker %', NEW.case_title USING ERRCODE='23514'`. |
| log has `IntegrityError`; no `ck_case_law_year_sane` and no `1800` | Log has `IntegrityError`; no `f22 marker` and no `F22 fault 2099` |
| citations `"2099 F20 21/22/23"` | `"2099 SCMR 21/22/23"`. `{row[1] for row in master}` becomes the promoted Annex A citations `{"2099 SCMR 21","2099 SCMR 23"}`. |

`test_a`, `test_b` and `test_e` are unchanged.

**New tests:**
- `test_f19_orm_has_no_annex_a_table_and_migrate_never_applies_annex_a`:
  - `set(Base.metadata.tables) & {29 inventory names} == set()`.
  - On a fresh database, `migrate()` leaves `to_regclass('public.judgment') IS NULL`.
  - As a NOCREATEROLE owner role, applying 001 fails with `42501`. This documents why 001 is applied by a superuser.
  - With Annex A applied first by admin, `migrate()` as that owner succeeds, and every inventory relation is still owned by the admin role.
- `test_f19_migrate_adds_extracted_bench_type_once`. Build the legacy schema (`create_all`, then `ALTER TABLE scraper_staging DROP COLUMN extracted_bench_type`), then run migrate as the schema owner. The column now exists. A second run logs `already present`, and the column's `attnum` is unchanged.
- `test_f19_promotion_publishes_into_annex_a_and_the_reader_sees_it`. A trusted source; staging with `extracted_citation="PLD 2099 Karachi 12"` (the extractor's shape), `extracted_bench_type="Division Bench"`, `raw_html` and `source_url`. Promotion runs as the runtime role. Expected:
  - the result is `{"promoted":1,"quarantined":0,"failed":0}`;
  - `promoted_to_id` is the Annex A judgment id;
  - the citation is `PLD 2099 Sindh 12`;
  - provenance has `extraction_method='html'` and `content_hash=sha256(raw_text)`;
  - `corpus_publication.batch_key = 'staging/<id>'`, with `source_kind='staging'`, `actor_id=STAGING_ACTOR_ID` and `publisher_session_user` = the runtime role;
  - `case_law_master` and `embedding_queue` are empty;
  - the reader sees it through `v_judgment JOIN v_citation`.
- `test_f19_promotion_outcomes_follow_the_section5_table`:

  | Staged row | Annex A | Staging and `quarantine_queue` |
  |---|---|---|
  | no bench | judgment and citation `quarantined missing_bench` | quarantined `missing_bench`; details carry `annex_a.judgment_id` |
  | bench `"panel"` | nothing; item `rejected invalid_bench` | quarantined `invalid_bench` |
  | `extracted_citation="PLD 2099 Atlantis 1"` | judgment and citation `quarantined citation_not_canonical` | quarantined `citation_not_canonical` |
  | `raw_text` None, no html/pdf/ocr, no hash | nothing; `rejected provenance_incomplete` | quarantined `provenance_incomplete` |
  | review source; trusted at 0.49 | **nothing** (D8) | `review_source`; `low_confidence` |
  | re-stage of an already promoted citation, with no bench | J unchanged; item `rejected promoted_row_protected` | quarantined `promoted_row_protected` |
  | re-stage identical to a promoted judgment (same bench, text, provenance) | `unchanged` | promoted, `promoted_to_id` = existing J |

  None of the non-promoted rows appear in `v_judgment`.

Steps:
- [ ] **Step 1:** Write the new tests and the F20 migration.
- [ ] **Step 2:** Run red against **PR 1's** `promotion.py`. In a scratch copy, check out `corpus_service/scraper/tasks/promotion.py` from `24b96ec`, keeping everything else from this branch. Expected:
  - `test_f19_promotion_publishes_…`: the reader sees **0** rows, `case_law_master` has 1 row, `embedding_queue` has 1, and `promoted_to_id` is not an Annex A id.
  - `test_f19_promotion_outcomes_…`: the no-bench row is *promoted* into `case_law_master`.
  - Migrated `test_c` and `test_d`: the Annex A sets are empty.

  Save the output as `f19-red.log`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run green: the full `python -m pytest corpus_service/tests -q` with the URL. Save the output as `f19-green.log`.
- [ ] **Step 5:** Commit: `fix(F19): promotion publishes into Annex A; staging bench column; drop case_law_master write and embedding enqueue`. The body states the F20 assertion mapping.

### Task 9: CI wiring and docs

**Files:**
- Modify: `.github/workflows/gate-g0.yml`.
  - **`postgres-ddl`.** Before "Annex A + platform DDL tests", add:
    ```yaml
    - name: Every postgres/ddl/*.sql applies in order as the superuser, twice (idempotent)
      run: |
        set -euo pipefail
        for pass in 1 2; do
          for f in $(LC_ALL=C ls postgres/ddl/*.sql | sort); do
            docker exec -i "${{ job.services.postgres.id }}" \
              psql -v ON_ERROR_STOP=1 --no-psqlrc -q -U postgres -d sikander_ci < "$f"
          done
        done
    ```
    The existing test and probe steps are unchanged. The harness re-applies the files a third time.
  - **`corpus-service`.** Before the pytest step, add the same loop over `postgres/ddl/001_corpus_contract.sql postgres/ddl/003_corpus_publication.sql`, against `-d corpus_ci` (D27). The pytest step is unchanged. Keep `timeout-minutes: 10` unless the local run exceeds 6 minutes; in that case use 15 and say so in the commit.
- Modify: `corpus_service/README.md`. Add a "Publication into Annex A (audit F19)" section after "Trust levels":
  - the flow;
  - the §5 table;
  - the batch format;
  - the CLI and its exit codes;
  - that `case_law_master` is no longer written by promotion;
  - that Annex A DDL is applied by a superuser, never by migrate;
  - that a harvested row without a bench stays quarantined until a bench is supplied (ruling 9);
  - how to run the tests.
- Modify: `corpus_service/requirements-test.txt` (the comment's verified count) and `docs/architecture/README.md` (the corpus-service row: count, and that the DB tests now need Annex A, applied by the fixture).

Steps:
- [ ] **Step 1:** Run the workflow steps locally against the private Postgres with the same commands. Expected: no output, exit 0, on both passes.
- [ ] **Step 2:** Commit: `ci(F19): apply Annex A DDL in the corpus-service and postgres-ddl jobs; docs`.

### Task 10: Verification and PR

- [ ] Run each command and record its output:

  | Command | Expected |
  |---|---|
  | `CORPUS_TEST_DATABASE_URL=… python -m pytest corpus_service/tests -q` | `<85 + new> passed, 0 skipped`. Record the exact number in the requirements comment and the PR. |
  | `CI=1 python -m pytest corpus_service/tests -q`, with no URL | exit 1, `CORPUS_TEST_DATABASE_URL required in CI` (unchanged) |
  | `SIKANDER_POSTGRES_URL=… npm run test:postgres-ddl` | `Test Files 2 passed`, `Tests 22 passed` |
  | `SIKANDER_POSTGRES_URL=… npm run probe:fa-data-001` | `Probe FA-DATA-001: PASSED (bypass blocked; declassify() present)` |
  | `npx vitest run tests/citations.canonical-golden.test.ts`; `npm run corpus:citation-golden && git diff --exit-code tests/fixtures/corpus/` | pass; no diff |
  | `npm run test:unit` | all pass, including the new golden test |
  | `npm run typecheck && npm run typecheck:tests && npm run lint` | clean |
  | `npm run gate:g0` | PASS. Check [9] classification-guard and [11] master-write-guard. |
  | `python3 ci_gates/test_check_compose_policy.py -v` | unchanged pass (PR 2 touches no compose file) |
  | `git diff origin/claude/remediate-f20-trust -- postgres/ddl/001_corpus_contract.sql postgres/ddl/002_platform.sql docs/audit/probes tests/probe-fa-data-001.regression.test.ts` | empty |
  | `git diff origin/claude/remediate-f20-trust -- tests/postgres.ddl.integration.test.ts` | only imports, `beforeAll` file loading, new helpers, and appended PG-DDL-11..20 |
  | gitleaks on the branch | no findings |

- [ ] Push and open a **draft** PR titled `fix(F19): publication ETL into the Annex A contract`. The body includes:
  - the finding → change → e2e mapping;
  - the `f19-ddl-red.log`, `f19-red.log` and `f19-green.log` evidence;
  - the F20 assertion migration table;
  - the flags table: `backend_real` true, `frontend_real` false, `transport_stub` true;
  - "F19 is not ticked until PR 2b merges (ruling 11)";
  - "Not a COMPLETE / product-done claim.";
  - a note that GitHub Actions is billing-blocked, if it still is.
- [ ] Do not merge. An independent re-audit comes first.

---

## Why each new test fails on PR 1's head (`24b96ec`)

| Test | Failure on 24b96ec |
|---|---|
| PG-DDL-11, PG-DDL-12 | There is no 003, so no guard. `corpus_writer`/`app_writer` promoted INSERTs and UPDATEs **succeed**. `'panel'` and `'PK'` are accepted. |
| PG-DDL-13 | `column_default` is `'promoted'` (001) |
| PG-DDL-14 | `corpus_publication_begin` does not exist (42883) when publishing. The `declassify()` half would pass, so this is a regression guard that 003 keeps FA-DATA-001 working. |
| PG-DDL-15, 16, 17, 20 | `begin`/`finish` and the audit tables do not exist (42883 / 42P01) |
| PG-DDL-18 | The superuser insert passes, as the exemption expects. The `begin()` refusal fails (42883). |
| PG-DDL-19 | The harness file-list assertion fails, because 003 is missing |
| `citations.canonical-golden.test.ts` | ENOENT: no fixture |
| `test_publication_vocabulary/citations/batch.py` | `ModuleNotFoundError: scraper.publication` |
| `test_f19_*` (publish, CLI) | `ModuleNotFoundError` |
| `test_f19_promotion_*`, migrated F20 `test_c`/`test_d` (run with PR 1's `promotion.py`) | Promotion writes `case_law_master` and enqueues an embedding. Annex A is empty, the reader's `v_judgment` returns 0 rows, and `promoted_to_id` points into `case_law_master`. The no-bench row is promoted (no `missing_bench`). |
| `test_f19_migrate_adds_extracted_bench_type_once`, `…orm_has_no_annex_a…` | The column does not exist, and the `ScraperStaging` attribute is missing |

---

## PR 2b: compose wiring (separate PR, ruling 11)

**Goal:** the shipped compose stack carries Annex A from first boot, and the runtime role can publish. F30's least-privilege guarantees still hold for every Annex A relation.

**Rule:** F19 is ticked only after 2b merges and the re-audit passes.

### What changes

1. **New `corpus_service/docker/postgres/apply-annex-a.sh`** (bash, idempotent):
   - It runs `psql -v ON_ERROR_STOP=1 --no-psqlrc --single-transaction -U "$POSTGRES_USER" -d "${POSTGRES_DB:-legal_scraper}" -f /etc/postgresql/corpus/ddl/001_corpus_contract.sql -f /etc/postgresql/corpus/ddl/003_corpus_publication.sql` over the local socket (peer, `container_admin`).
   - The file list is explicit: 002 is the application's platform database, not the corpus. PR 3 appends 004.
2. **`docker-compose.yml`, `postgres.volumes`.** Two lines are added *after* the existing ones, and the anchored pg_hba line stays byte-identical:
   ```yaml
   - ../postgres/ddl:/etc/postgresql/corpus/ddl:ro
   - ./docker/postgres/apply-annex-a.sh:/docker-entrypoint-initdb.d/15-apply-annex-a.sh:ro
   ```
   On a fresh volume the init order is `10-init.sql` → `15-apply-annex-a.sh` → `20-provision-roles.sh`.
3. **`provision-roles.sh`:**
   - (a) Fail unless `to_regprocedure('public.corpus_contract_relations()') IS NOT NULL`, with the message `Annex A is not applied: run 15-apply-annex-a.sh first`.
   - (b) The membership-strip query also excludes `(g.rolname = 'corpus_writer' AND u.rolname = :'app_user')`, so a rerun does not revoke it.
   - (c) Add `GRANT corpus_writer TO :"app_user" WITH INHERIT FALSE, SET TRUE;` (D14). The spec says "grant corpus_writer to APP_DB_USER", and INHERIT FALSE narrows it.
   - (d) The ownership DO loop gains `AND c.oid NOT IN (SELECT public.corpus_contract_relations())`.
   - (e) Replace `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user` and `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES …` with DO loops over `public` relations, relkind `r`/`p` and `S` respectively, that are **not** in `corpus_contract_relations()` and, for sequences, are not owned by one. The preceding `REVOKE ALL ON ALL TABLES/SEQUENCES … FROM app_user` lines stay; they also clear any direct Annex A grant left by an older run. The `ALTER DEFAULT PRIVILEGES FOR ROLE mig_user` lines stay, because Annex A is created by the superuser, not by mig.
   - (f) The `CREATE ROLE corpus_clients NOLOGIN` line stays byte-identical. The header comment documents Annex A ownership (the superuser) and `corpus_writer` membership.
4. **`scripts/rotate_postgres_password.sh`.** Before running provision-roles, it now runs `docker compose exec -T -u postgres postgres /docker-entrypoint-initdb.d/15-apply-annex-a.sh`, which brings an existing volume onto Annex A. The header steps are updated.
5. **`.github/workflows/corpus-compose-policy.yml`.** `paths:` gains `postgres/ddl/**`, so DDL changes re-run the compose e2e.
6. **`corpus_service/README.md`, "Data-store security".** Document Annex A at init, `corpus_writer` membership, and why migrate cannot apply 001 (NOCREATEROLE, CREATE EXTENSION).

### F30 pinned constants and tests

| Item | Moves? | Why |
|---|---|---|
| `HBA_CLIENT_GROUP = "+corpus_clients"` and `test_hba_client_group_is_the_one_the_shipped_files_use` | No | `pg_hba.conf` is unchanged. `corpus_writer` and `corpus_reader` never log in over TCP; the runtime role reaches `corpus_writer` by `SET ROLE`. The `CREATE ROLE corpus_clients NOLOGIN` string stays. |
| `PG_ALLOWED` and `test_pg_option_allowlist_is_exactly_the_shipped_options` | No | There are no new `-c` options |
| `fixtures/shipped_attacks.py` | No | Its only postgres-volume anchor is the pg_hba line, which is unchanged. **UNVERIFIED:** whether `docker compose config` on the attack harness's copied `corpus_service/` (where `../postgres/ddl` does not exist) still resolves. If it does not, `apply_attack` must also copy `postgres/ddl` beside the tree. That is a harness change, recorded in the PR. |
| Policy rules (`app-store-volume`, `app-host-access`, helper taint) | No | The new binds belong to the postgres store, and no app or helper mounts them. Only app binds are checked against the project directory (`check_compose_policy.py:1288`). |
| `probe.py` `db-migrate` "owns the application tables ≥ 9" | No | It still holds |
| `store_security_e2e.sh`, `upgrade_e2e.sh`, `probe.py` | Gain checks | Below |

### Tasks

**Task B1: e2e checks first (red)**
- `probe.py db-runtime` gains these checks:
  - the runtime role is a member of `corpus_writer` with `inherit_option = false` and `set_option = true` (`pg_auth_members`, PG16);
  - `has_table_privilege(current_user, rel, 'INSERT,UPDATE,DELETE,SELECT')` is false for every `corpus_contract_relations()` entry;
  - after `SET ROLE corpus_writer`, INSERT into `corpus_publication_grant` and into `judgment_declassify_grant` → 42501;
  - UPDATE `corpus_publication` → 42501;
  - a promoted judgment outside a publication → SKP02;
  - `publish_batch` of a synthetic batch through the app's own engine (TLS, random `batch_key`) → promoted, and the role is restored afterwards.
- `db-migrate` gains these checks:
  - the migration role owns no inventory relation;
  - `ALTER TABLE judgment DISABLE TRIGGER judgment_publication_guard` → 42501;
  - `CREATE OR REPLACE FUNCTION corpus_publication_begin…` → 42501.
- `store_security_e2e.sh` gains: `as_superuser_local` finds 9 `*_publication_guard` triggers, all `O`, and `corpus_metadata.schema_version = 'L17-AnnexA-1.0'`.
- `upgrade_e2e.sh` gains these checks after rotate:
  - Annex A is present on the upgraded legacy volume;
  - `keep` and `legacy_items` still moved to mig, and are readable and insertable by app (existing checks);
  - Annex A is owned by the bootstrap role;
  - after the idempotent re-run, the app is still a `corpus_writer` member.
- Run `bash corpus_service/tests/e2e/store_security_e2e.sh` on PR 2's head. Expected: FAIL, because `to_regclass('judgment')` is NULL and the runtime role is not a member.
- Commit: `test(F19): compose e2e asserts Annex A at init and corpus_writer least privilege`.

**Task B2: init and rotation apply Annex A (still red on privileges)**
- Add `apply-annex-a.sh`, the compose mounts and the rotate step.
- Rerun. Expected: Annex A is present, but these fail:
  - "runtime role has no direct privilege on any Annex A relation" (blanket `ALL TABLES` grant);
  - "migration role owns no Annex A relation" (ownership loop);
  - the membership check.

  This demonstrates Review Focus 5. Save the output as `f19-2b-red.log`.
- Commit: `fix(F19): apply Annex A DDL (001, 003) at postgres init and on rotation`.

**Task B3: provisioning is aware of Annex A (green)**
- Apply the `provision-roles.sh` changes (a)–(f).
- Run both e2e scripts. Expected: all PASS, and the re-run is idempotent.
- Commit: `fix(F19): provision-roles excludes Annex A from F30 ownership and DML grants; grant corpus_writer to the runtime role`.

**Task B4: policy, workflow and verification**
- Run `python3 ci_gates/test_check_compose_policy.py -v` (expected: unchanged pass) and `python3 ci_gates/check_compose_policy.py corpus_service/docker-compose.yml` (expected: PASS).
- Run the fixtures loop from `corpus-compose-policy.yml`: every fixture is rejected for its declared rules.
- Update the workflow `paths` and the README.
- Open a draft PR `fix(F19): compose wiring for the Annex A publication (PR 2b)`, with the same body rules as PR 2.
- Commit: `docs(F19): compose Annex A wiring; policy workflow watches postgres/ddl`.

---

## Notes for PR 3 (recorded, not built here)

- 004 must `CREATE OR REPLACE` `corpus_contract_relations()` to add the four `v_authority_*` views. Otherwise PR 2b's provisioning would move them to the migration role, which could redefine them.
- The view predicate for complete provenance should be inlined as a join on `source_provenance`, mirroring `corpus_provenance_complete()`. Calling the DEFINER function from a view would need EXECUTE for `corpus_reader`.
- Seed the F05 fixture through `python -m scraper.publication.cli publish` as a `corpus_writer` member. The format is `corpus-publication-batch/1`.
- Read `publication_contract = '1'` and `last_refresh`, whose format is fixed by D30.
- The superuser-row exclusion test (ruling 2, reader half) belongs to 004's PG-DDL cases.
- `apply-annex-a.sh` appends `004_authority_read_views.sql`.

## Out of scope (recorded)

- Courts, judges and instruments directory, and `amending_instrument_id` (D12).
- Extracting a bench from CORAM, and judge counts (B-10 extraction).
- Promoting `statutes_staging`.
- `routers/quarantine.py` approvals still writing `case_law_master` (F23).
- Search, export and the dashboard reading `case_law_master` (F24).
- Annex A embeddings (F27).
- A harvester recording `extraction_method` (D17).
- Nightly derived-statistics updates (§6 note).
- Vendoring the golden fixture if `corpus_service` leaves the repository (E-25).

## UNVERIFIED

1. An identity-column INSERT into `corpus_publication_item` needs no sequence privilege for `corpus_writer`. PG-DDL-15 and 17 show it; if not, grant USAGE on `pg_get_serial_sequence(...)`.
2. SQLAlchemy's asyncpg dialect maps a trigger-raised `23514` to `IntegrityError`. The migrated `test_d` relies on this.
3. Explicit `SAVEPOINT corpus_pub_item` statements behave correctly inside a Session-managed `begin_nested()` transaction. Tasks 5 and 8 exercise this.
4. The expected canonical keys in the golden input table, which come from reading `citations.ts`. The generator is authoritative.
5. pydantic 2.13 strict JSON-mode date parsing for `effective_from` and `decision_date`.
6. `docker exec` with `${{ job.services.postgres.id }}` on hosted runners. GitHub Actions is billing-blocked, so CI has not run any of this.
7. `docker compose config` with an absent `../postgres/ddl` in the policy attack copies (PR 2b). **Verified in PR 2b:** on a copy of `corpus_service/` alone, `docker compose config` exits 0 and resolves the bind to the missing path (it does not check bind sources), and the policy passes the copy; `test_check_compose_policy.py` passes unchanged, so `apply_attack` needs no change.
8. That `GRANT … WITH INHERIT FALSE, SET TRUE` and the PG16 `pg_auth_members.inherit_option`/`set_option` columns behave as described on `pgvector/pgvector:pg16`. **Verified in PR 2b** (compose e2e, server major 16): the membership reads `inherit=false set=true admin=false`; the runtime role has none of `corpus_writer`'s rights until `SET ROLE`; re-granting `WITH ADMIN FALSE, INHERIT FALSE, SET TRUE` resets a membership widened to `INHERIT TRUE, ADMIN TRUE`.

### PR 2b decisions beyond the plan (recorded)
- `GRANT USAGE ON SCHEMA public TO corpus_writer, corpus_reader` in `provision-roles.sh`. F30 revokes the schema from `PUBLIC`, so without it `SET ROLE corpus_writer` reaches nothing in `public` and `corpus_reader` is refused every `v_*` view. Neither role can log in. `corpus_declassify` gets nothing: no compose service declassifies.
- `provision-roles.sh` ends with a fail-closed post-check in its transaction: exact memberships, every Annex A relation and function owned by a superuser, no table, column or sequence privilege on Annex A for either application role.
- The DML grant loop covers the relation kinds `GRANT … ON ALL TABLES` covered (`r`, `p`, `v`, `m`, `f`), not only `r`/`p`, so nothing outside Annex A changes for the runtime role.
- No automatic re-apply on a plain restart: the image runs `/docker-entrypoint-initdb.d` only on an empty volume; `scripts/rotate_postgres_password.sh` is the re-apply path (idempotent).

### Critical Files for Implementation
- /home/user/cursor-init/postgres/ddl/003_corpus_publication.sql (new; read 001 at `git show origin/claude/remediate-f20-trust:postgres/ddl/001_corpus_contract.sql`)
- /home/user/cursor-init/corpus_service/scraper/publication/annex_a.py (new)
- /home/user/cursor-init/corpus_service/scraper/tasks/promotion.py
- /home/user/cursor-init/tests/postgres.ddl.integration.test.ts
- /home/user/cursor-init/corpus_service/tests/conftest.py
- /home/user/cursor-init/corpus_service/docker/postgres/provision-roles.sh (PR 2b)