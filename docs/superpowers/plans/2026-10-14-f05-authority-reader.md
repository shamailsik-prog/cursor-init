# F05 Promoted-only Authority Reader: Implementation Plan (PR 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The draft gate (`gateDraft`, and the fresh re-run inside `approveDraft`) answers from the firm's promoted Annex A corpus instead of `EMPTY_AUTHORITY_STORE`. A verified authority reads VERIFIED, an overruled one OVERRULED, and a pleaded statute text is compared with the text in force. Any doubt about the corpus (unreachable, stale, wrong role, missing view, pending review, inconsistent data) fails closed to UNVERIFIED / TEMPORAL_UNAVAILABLE, never OK.

**Architecture:**
- `postgres/ddl/004_authority_read_views.sql` adds four `security_barrier` views over Annex A. Each shows a row only when the row and every parent are promoted, published (a finished `corpus_publication`) and carry complete provenance, and every judgment involved is public with a bench. SELECT goes to `corpus_reader` only.
- 004 re-defines `corpus_contract_relations()` with the four views, so PR 2b's provisioning keeps them with the superuser. It applies at init and on rotation through `apply-annex-a.sh`.
- `functions/src/d4/corpusAuthorityStore.ts` is a `pg` adapter implementing the existing `AuthorityStore` port. It reads only the four views and `corpus_metadata`, as a role that inherits `corpus_reader` and nothing more.
- `functions/src/d4/authority.ts` gains `AuthorityUnavailableError` and store selection from the environment. `gate.ts` turns that error, and only that error, into UNVERIFIED / TEMPORAL_UNAVAILABLE.
- The user-flow e2e drives the real HTTP router (Auth and Firestore emulators) against real Postgres. The corpus is seeded through PR 2's publication CLI.

**Tech Stack:**
- TypeScript (Cloud Functions, Node 22), vitest, Firebase Auth and Firestore emulators.
- `pg` 8 (the root already pins `pg ^8.16.3` and `@types/pg ^8.15.5`).
- Postgres 16 + pgvector (`pgvector/pgvector:pg16`).
- Python 3.12 for the seeding CLI (`corpus_service/requirements-test.txt`).
- Bash (compose e2e) and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-f05-f19-f20-authority-corpus-design.md` (commit `3bbe464`): §3 rulings 2–8, 12 and 13, §6 (PR 3), §7 and §8. Audit: `docs/audit/2026-10-13-forensic-audit.md` F05 (:227), §10 row "Which documents were retrieved?" and §11 row "P0 legal/AI evaluation"; `docs/audit/2026-10-14-forensic-audit-v2.md` :78. Predecessor plan: `docs/superpowers/plans/2026-10-14-f19-publication-etl.md`, "Notes for PR 3".

**Base:** branch `claude/remediate-f05-reader` from PR 2b's head `c6561f9`, which carries #49 at `a87c01e`. Before opening the PR, merge whatever #49 and #50 have landed.

---

## Global Constraints

- **Rulings (spec §3), verbatim in effect:**
  - Ruling 2: a superuser-seeded row is invisible to the reader.
  - Ruling 3: a pending (quarantined) `overruled` gives UNVERIFIED.
  - Ruling 4: `MIN_VERSION_CONFIDENCE` must be strictly greater than 0.5.
  - Ruling 5: `SIKANDER_CORPUS_MAX_STALENESS_HOURS` is required, with no default.
  - Ruling 6: `PK` is not mapped and gives `no_history`.
  - Ruling 7: `sectionId` is `statute_section.id` (a UUID).
  - Ruling 8: only `public` judgments are shown.
  - Ruling 12: no "authority reachable" marker is stored.
  - Ruling 13: Functions reads as `corpus_reader`.
- **The port does not change.** `AuthorityStore`, `CitationFinding`, `TemporalFinding` and `GateEvaluation` keep their shapes (spec §8, strict `toEqual` gate tests).
- **Closed sets:**
  - Bench: `single | division | full | larger`.
  - Treatment kinds: `followed | applied | distinguished | doubted | overruled | per_incuriam | referred` (001 CHECK).
  - Annex A jurisdictions: `Federal | Sindh | Punjab | KP | Balochistan | ICT | GB | AJK`.
- **Gate jurisdiction codes** are R11 upper-case codes (`/^[A-Z0-9_.:-]{1,50}$/`, `gateOps.ts:81`).
- **Citation keys** are TypeScript `normaliseCitation` (`services/d4-2/citations.ts:1266`). The D24 golden is `tests/fixtures/corpus/citation-canonical-golden.json`.
- **The reader** touches only `v_authority_citation`, `v_authority_treatment`, `v_authority_section_version`, `v_authority_pending_adverse` and `corpus_metadata` (`publication_contract`, `last_refresh`; format F19 D30: `YYYY-MM-DDTHH:MI:SS.ffffffZ`, UTC).
- **No secrets in logs:** never a URL, a password or raw driver text. Only the event name and a reason token.
- **No real authority:** fixtures use only 2099 citations and "Test Act 2099" (P4-13).
- **Fix only:**
  - no new route;
  - no stored marker;
  - no Next.js gate (O-67);
  - no secret binding, corpus host or network path (spec §7).
- **Closing rule (REMEDIATION.md rule 2):** a merged PR with an end-to-end test of a real user flow that fails before and passes after.

## Decisions where the spec is silent or ambiguous

| # | Decision | Reason |
|---|---|---|
| D1 | **The visible-row predicate.** A row is visible only when all of these hold: `review_status = 'promoted'`; its `publication_id` joins a `corpus_publication` with `finished_at IS NOT NULL`; and its `source_id` inner-joins a `source_provenance` row that is complete. "Complete" is the predicate of `corpus_provenance_complete()`, inlined. A judgment is visible only if, in addition, its `classification` joins `classification_rank` with `rank = 0`, and `bench_type IS NOT NULL`. A view shows a row only when the row and every parent it reports are visible: a citation's judgment; a treatment's treating and treated judgments; a version's section and that section's statute. Reported parent fields (bench, jurisdiction) come from the parent row itself. | Ruling 2 plus requirements 3 and 4. "No publication provenance" means both no finished publication and no complete source row. The DEFINER function is inlined because calling it from a view would need EXECUTE for `corpus_reader` (F19 notes). Comparing ranks, not labels, follows the spirit of G-0 [9]. An unknown label fails the join and so fails closed. |
| D2 | **What counts as pending adverse.** `v_authority_pending_adverse(treated_judgment_id)` lists a treated judgment for every `overruled` treatment that is not `rejected` and does not appear in `v_authority_treatment`. That covers a quarantined one (ruling 3), and also a promoted one hidden by D1 (its treating judgment quarantined, non-public or bench-less, incomplete provenance, no finished publication, or a NULL `treating_bench_type`). | Requirement 3's inner joins would otherwise turn a hidden overruling into a VERIFIED citation, for example an overruling by a judgment whose classification was later raised. Hiding must never pass as good law. Only the treated id is exposed. |
| D3 | **Jurisdiction mapping.** An R11 code maps to the Annex A value whose upper-case form equals it, and nothing else: `FEDERAL→Federal, SINDH→Sindh, PUNJAB→Punjab, KP→KP, BALOCHISTAN→Balochistan, ICT→ICT, GB→GB, AJK→AJK`. `PK`, `SD`, `KPK`, `ISLAMABAD` and anything else give `no_history`. | Read literally, the spec's "outside the 8 Annex A values" would make every check `no_history`, because R11 forbids lower case. Equality of the upper-case form adds no alias. Ruling 6 stands. |
| D4 | **Version usable.** `versionUsable(c) = typeof c === "number" && c > 0.5 && c <= 1`. NaN, null, ±Infinity and anything above 1 are unusable, which gives `no_history`. | Ruling 4 and requirement 7, in the NaN-safe form of 003's D4 (`NOT (x >= 0.7 AND x <= 1.0)`). Postgres sorts NaN above every number, so a bare `> 0.5` would let NaN through. |
| D5 | **Corpus data that breaks the contract** throws `AuthorityUnavailableError('inconsistent')`. This covers a bench or kind outside the closed sets, overlapping or reversed version ranges, two covering versions, and a non-UUID judgment id passed to `listTreatments`. It is not a 500. Programming errors (our own `TypeError`s) still propagate as a 500. | Spec §6 says these "throw" without naming the class. Treating them as unavailable keeps the result recorded and fail-closed (never OK, override possible with a reason), and the log names the reason. |
| D6 | **Driver errors are wrapped.** Every error raised by the `pg` client (network, TLS, server SQLSTATE) becomes `AuthorityUnavailableError(classifyPgError(err))`. SQLSTATE `42501`→`permission`; `28P01`/`28000`→`auth`; `57014`→`timeout`; `42P01`/`42703`/`3D000`→`schema_missing`; class `08`, `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`→`unreachable`; a connect or query timeout→`timeout`; a TLS failure→`tls`; anything else→`error`. | Spec §6 failures list, made total. The gate catches only this class (spec), so a database fault can never surface as OK or as an unclassified 500. |
| D7 | **Role and session check**, part of the cached state check. The session must have `pg_has_role('corpus_reader','USAGE')`, must not be a superuser, must not be a member of `corpus_writer` or `corpus_declassify`, and `transaction_read_only` must be `on`. Otherwise it throws `wrong_role`. | Ruling 13 and L17.10 #56 (read-only connection), enforced rather than assumed: a misconfigured URL holding writer or superuser rights fails closed. |
| D8 | **Configuration (`readCorpusReaderConfig`).** `SIKANDER_CORPUS_READER_URL` must be `postgres://` or `postgresql://` with a user, password, host and database. `SIKANDER_CORPUS_MAX_STALENESS_HOURS` must be an integer from 1 to 8760. In production, the URL must carry `sslmode=verify-full` and `SIKANDER_CORPUS_READER_CA` must be a PEM certificate. Outside production, plaintext is allowed only to `127.0.0.1`, `::1` or `localhost`; any other host needs the same TLS. The pool config is built field by field (`host, port, user, password, database, ssl: { ca, rejectUnauthorized: true }`). The URL's own `sslmode` is never handed to `pg`. | Spec §6, store selection. The range is a sanity bound (the spec gives no limit). Explicit fields avoid node-pg's `sslmode` reinterpretations. |
| D9 | **Pool and timing constants:** `POOL_MAX = 3`, `CONNECT_TIMEOUT_MS = 3000`, `STATEMENT_TIMEOUT_MS = 5000` (server-side `statement_timeout`, plus a client `query_timeout` of `STATEMENT_TIMEOUT_MS + 1000`), `IDLE_TIMEOUT_MS = 10000`, `allowExitOnIdle: true`, `application_name = 'sikander-d4-authority'`, `options = '-c default_transaction_read_only=on'`, `STATE_TTL_MS = 30000`, `BREAKER_OPEN_MS = 30000`. | Spec §6 ("2–3 connections, 2–3 s connect timeout, about 30 s"). The breaker keeps a gate with many citations inside the 120 s function timeout. |
| D10 | **Dates travel as text.** SQL selects `effective_from::text` and `effective_to::text`, and the store compares `YYYY-MM-DD` strings, as `InMemoryAuthorityStore` does. The adapter never creates a JS `Date` from a DATE column. | node-pg parses DATE as local midnight, so a host time zone would shift `effective_from` by a day. |
| D11 | **One statement for treatments.** `listTreatments` reads the pending check and the treatments in one statement (`UNION ALL`), so both come from one snapshot. | A publication committing between two reads cannot produce a mixed answer. |
| D12 | **004 defines no routine.** Every predicate is inlined. `corpus_contract_routines()` is unchanged, still 12 routines, and a test asserts that. | Requirement 1 holds without enlarging the routine inventory. A future routine in 004 must extend it. |
| D13 | **004 owns the complete relation list (33).** The apply order is always 001 → 003 → 004: `apply-annex-a.sh`, the CI loops, `ddlFiles()` and the conftest list. Re-applying 003 alone after 004 would shrink the list to 29, so nothing applies 003 without 004 after it. D20 makes provisioning refuse that state. | Requirement 1 says 004 must `CREATE OR REPLACE` the function. That makes the order load-bearing. |
| D14 | **The Pg suites run only when `F05_AUTHORITY_SUITE=1`.** This covers `*.pg.test.ts` and `f05-*.e2e.emu.test.ts`: `functions/vitest.config.ts` excludes them otherwise. With the flag set, the shared harness throws when `SIKANDER_POSTGRES_URL` is unset, so the run fails rather than skips. `npm run test:f05-authority` sets the flag. | Spec §6 CI says the job must not pass vacuously. Excluding on a missing URL alone would let a misconfigured job pass, so the flag decides inclusion and the URL is then mandatory. The regular functions job (no Postgres) stays green. |
| D15 | **Test databases and roles.** Each Pg test file creates its own database (`f05_<suite>_<hex>`) as the `SIKANDER_POSTGRES_URL` superuser and applies the existing files of `ANNEX_A_DDL = [001, 003, 004]` in order. It creates two login roles with random passwords: a writer (`GRANT corpus_writer … WITH INHERIT FALSE, SET TRUE`, as PR 2b) and a reader (`IN ROLE corpus_reader`). It seeds through `python -m scraper.publication.cli publish` as the writer, with `DATABASE_URL=postgresql+asyncpg://…`, `REDIS_URL=""`, cwd `corpus_service`, and Python from `SIKANDER_CORPUS_PYTHON` (default `python3`). It drops its database (`WITH (FORCE)`) and roles afterwards. | F19 note "seed the F05 fixture through the CLI as a corpus_writer member". One database per file keeps files independent. |
| D16 | **Logging, given audit §10 and ruling 12.** The store logs `d4.authority_unavailable {reason}` once each time the breaker opens, and selection logs `d4.authority_not_configured {reason}` once per process per reason. Nothing is added to gate results. | Audit §10 asks which sources answered. Ruling 12 forbids new stored data. Logs carry a reason token only (spec). |
| D17 | **Parity runs on its own fixture**, `tests/fixtures/corpus/parity-batch.f05.json`, whose every item promotes. Both stores are built from it: Pg through the CLI, and in-memory from the same JSON, using the Pg ids read back as the superuser. | O-59 compares answers. The in-memory store has no quarantine or confidence, so only an all-promoted fixture can be compared exactly. |
| D18 | **Cheap refusals without a database call.** `findJudgment(x)` with `normaliseCitation(x) !== x` returns null. `getSectionAsAt` with a non-UUID section id, an `asAtDate` that is not `YYYY-MM-DD`, or an unmapped code returns `no_history`. | Spec §6 rules. The lookup is exact equality on the canonical key, so a non-canonical input never matches a different key (requirement 6). |
| D19 | **A `last_refresh` that is malformed or missing** is `contract_missing`. One more than 5 minutes in the future (`FUTURE_SKEW_MS`) is `stale`. | A corrupt or forged freshness value must not keep the store open forever. |
| D20 | **Provisioning guard against a shrunken inventory** (coordinator amendment to D13). `provision-roles.sh`'s pre-check refuses, before changing anything, in two cases: (a) a relation in schema `public` is named `v_authority_%` but is not in `corpus_contract_relations()`; (b) a view or materialized view in `public` has a rewrite rule that depends (`pg_rewrite` → `pg_depend`) on an inventory relation, but is not in the inventory itself. Message: `an Annex A view is missing from corpus_contract_relations(): <names> (re-apply 004 with 15-apply-annex-a.sh)`. A compose e2e case applies 004, re-applies 003 alone, and re-runs provisioning. Provisioning must refuse, the views must stay superuser-owned, and re-applying the chain must recover. | Re-applying 003 after 004 would otherwise hand the reader views to the migration role on the next provisioning run, and that role could redefine them. The `pg_depend` query catches any such view, not only those whose name matches. |

## Review Focus

The inputs most likely to bite a partner using the gate. Each line names the test that pins it in the owning task.

1. **An overruling the reader cannot show.** Its treating judgment was quarantined, made confidential, or lost its bench after publication. The citation must read UNVERIFIED, never VERIFIED. Pinned by PG-DDL-28 (Task 2) and e2e case F05-d "restricted overruling" (Task 1).
2. **The host time zone shifts statute dates.** A check at an amendment boundary under `TZ=Asia/Karachi` and `TZ=America/Los_Angeles` gives the same text as UTC. Pinned by `d4.corpus-authority.pg.test.ts` "dates do not move with the process time zone" (Task 6).
3. **An outage while gating a long draft.** Twenty-five citations against a server that accepts TCP and never answers must give a result within 10 s (breaker). Pinned by `d4.corpus-authority.pg.test.ts` "a hung server costs one connect timeout" (Task 7).
4. **A citation typed in another spelling** ("PLD 2099 Karachi 12" when the corpus key is "PLD 2099 Sindh 12"). The gate's normalisation finds it, and the store itself never matches a non-canonical or near-miss key. Pinned by the golden-driven test in Task 6 and e2e case F05-a.
5. **A wrong or skewed `last_refresh`** (garbage, missing, or in the future) must fail closed. Pinned by the state-check tests in Task 7.

---

## File structure

| File | Responsibility |
|---|---|
| Create `postgres/ddl/004_authority_read_views.sql` | The four views (D1, D2), grants, and the 33-relation `corpus_contract_relations()` (D13) |
| Modify `tests/postgres.ddl.integration.test.ts` | PG-DDL-26..32 for 004 |
| Modify `corpus_service/tests/conftest.py` | `ANNEX_A_DDL` gains 004 |
| Modify `corpus_service/tests/test_f19_publication_db.py` | Inventory 29 → 33; routines stay 12 |
| Modify `corpus_service/docker/postgres/apply-annex-a.sh` | File list gains 004 |
| Modify `corpus_service/tests/e2e/probe.py`, `lib.sh`, `store_security_e2e.sh` | The inventory copy and counts (33); a view-ownership check independent of the function; reader reads through `v_authority_citation` |
| Modify `functions/src/d4/authority.ts` | `AuthorityUnavailableError`, reasons, `activeAuthorityStore()` selection, the reset seam |
| Create `functions/src/d4/corpusReaderConfig.ts` | `readCorpusReaderConfig` (D8) |
| Create `functions/src/d4/corpusAuthorityStore.ts` | `PgAuthorityStore` and its pure helpers (D3–D7, D9–D11, D18, D19) |
| Modify `functions/src/d4/gate.ts` | Catch `AuthorityUnavailableError` only |
| Modify `functions/package.json`, `package-lock.json`, `build.mjs`, `vitest.config.ts` | `pg`/`@types/pg`; `pg-native` external; suite gating (D14); `test:f05-authority` |
| Create `functions/test/corpusPg.ts` | Shared Pg harness (D15) |
| Create `functions/test/f05-authority-corpus.e2e.emu.test.ts` | The user-flow e2e |
| Create `functions/test/d4.corpus-authority.pg.test.ts` | Adapter branches |
| Create `functions/test/d4.authority-parity.pg.test.ts` | O-59 parity |
| Create `functions/test/d4.corpus-config.test.ts` | Config parsing (no database) |
| Modify `functions/test/d4.gate.test.ts`, `d4.boot.test.ts` | Unavailable handling; store selection |
| Create `tests/fixtures/corpus/curated-batch.f05.json`, `parity-batch.f05.json` | Synthetic 2099 corpus |
| Modify `.github/workflows/gate-g0.yml`, `ci_gates/gate_g4_phase4a.sh`, root `package.json` | CI job; named lists; alias |
| Modify `functions/src/d4/README.md`, `corpus_service/README.md`, `docs/architecture/README.md` | Docs |

---

### Task 1: The user-flow e2e, its fixture and the Postgres harness (RED on the base)

**The flow** (audit F05: "partners must override without an integrated authority lookup"):
1. A member creates a draft that cites reported judgments and pleads a statute section.
2. The member gates it: `POST /api/d4/intelligence/gateDraft` → `gateDraftOp`, `runGate(…, activeAuthorityStore())` at `gateOps.ts:633`.
3. The matter partner approves it: `POST /api/d4/drafting/approveDraft` → a fresh `runGate` at `gateOps.ts:872`, which gives `409 gate_blocked` unless the result passes.

On the base every citation is UNVERIFIED, so the partner can only override.

**Files:**
- Create: `functions/test/corpusPg.ts`, `functions/test/f05-authority-corpus.e2e.emu.test.ts`, `tests/fixtures/corpus/curated-batch.f05.json`
- Modify: `functions/vitest.config.ts`, `functions/package.json` (script `test:f05-authority`), root `package.json` (alias `test:f05-authority` → `npm --prefix functions run test:f05-authority`)

**Interfaces:**
- Produces, in `functions/test/corpusPg.ts`:
  - `ANNEX_A_DDL: readonly string[]` (`["001_corpus_contract.sql", "003_corpus_publication.sql", "004_authority_read_views.sql"]`; files that do not exist yet are skipped, so the base applies 001+003).
  - `createCorpusDb(suite: string): Promise<CorpusDb>`, where `CorpusDb = { name: string; admin: pg.Client; readerUrl: string; writerUser: string; writerPassword: string; readerUser: string; readerPassword: string; publish(batchPath: string, actor?: string): Promise<PublishSummary>; drop(): Promise<void> }`.
  - `PublishSummary` is the CLI's stdout JSON (`publication_id, batch_key, already, seq, counts, items[]`). `publish` rejects on a non-zero exit, with stderr redacted of every generated password.
  - `requirePgSuite(): string` returns `SIKANDER_POSTGRES_URL`, or throws when `F05_AUTHORITY_SUITE=1` and the URL is unset (D14).
  - `withCorpusReaderEnv(db: CorpusDb, hours = 24): () => void` sets `SIKANDER_CORPUS_READER_URL`, `SIKANDER_CORPUS_MAX_STALENESS_HOURS` and unsets `SIKANDER_CORPUS_READER_CA`. It returns a restore function.
  - `resetAuthorityStore(): Promise<void>` calls `authority.resetCorpusAuthorityStoreForTests` when the module exports it (Task 8), and otherwise does nothing. This lets the file load and run on the base for the RED run.
- Consumes: the firm, matter and member helpers pattern of `functions/test/f06-not-assessed.e2e.emu.test.ts` (copy `newFirm`, `send`, `create`, `gate`, `approve`, `report`, `completeChecklist`, `expectErr`).

**Fixture `curated-batch.f05.json`** (`corpus-publication-batch/1`, `source_kind: "curated"`; every provenance complete unless stated; trust `trusted` 0.95 unless stated):

| item_key | Content | Expected in Annex A |
|---|---|---|
| `j-verified` | "2099 SCMR 101" and parts `PLD 2099 Karachi 12` (keyed `PLD 2099 Sindh 12`), bench "DB" | promoted |
| `j-overruled` | "2099 SCMR 202", "DB" | promoted |
| `j-larger` | parts `PLD 2099 SC 303`, "Larger Bench" | promoted |
| `j-cap` | "2099 SCMR 404", "DB" | promoted |
| `j-pending` | "2099 SCMR 505", "DB" | promoted |
| `j-review` | "2099 SCMR 606", trust `review` | quarantined `review_source` |
| `j-noprov` | "2099 SCMR 707", `content_hash: null` | rejected `provenance_incomplete` |
| `j-restricted` | "2099 SCMR 808", "Larger Bench" | promoted (case d raises it to `confidential`) |
| `j-verified-2` | "2099 SCMR 110", "DB" | promoted |
| `t-overruled` | `j-larger` overrules `j-overruled`, bench "larger", 0.9 | promoted |
| `t-cap` | `j-larger` "Overruled" `j-cap`, "larger", 0.9 | promoted (kind normalised) |
| `t-pending` | `j-larger` overrules `j-pending`, "larger", 0.6 | quarantined `treatment_uncertain` |
| `t-restricted` | `j-restricted` overrules `j-verified-2`, "larger", 0.9 | promoted |
| `h-amended` | statute "Test Act 2099", `Federal`, section "5", `amendment_history`: v1 2099-01-01→2099-07-01 "Section 5 as enacted: thirty days." (0.9); v2 2099-07-01→open "Section 5 as amended: sixty days." (0.9) | promoted |
| `h-current` | statute "Test Act 2099", section "6", `current_text_only`: v1 2099-01-01→open "Section 6 current text." | promoted at 0.5 |

`t-restricted` makes `j-verified-2` overruled by a judgment that case d later makes confidential. That is Review Focus 1: before the raise, 2099 SCMR 110 reads OVERRULED. After it, the overruling is hidden, so the citation must read UNVERIFIED (D2), not VERIFIED.

A second file, `curated-batch.f05-late.json`, holds `t-late`: `j-larger` overrules `j-verified`, "larger", 0.9 (case f).

- [ ] **Step 1: Write the harness and the gating config.**
  - `vitest.config.ts`: `exclude` gains `test/**/*.pg.test.ts` and `test/f05-*.e2e.emu.test.ts` unless `process.env.F05_AUTHORITY_SUITE === "1"`.
  - `test:f05-authority` (functions):
    ```
    cd .. && F05_AUTHORITY_SUITE=1 npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions exec -- vitest run test/f05-authority-corpus.e2e.emu.test.ts test/d4.corpus-authority.pg.test.ts test/d4.authority-parity.pg.test.ts"
    ```
- [ ] **Step 2: Write the e2e test.** Use `setAuthorityStoreForTests(null)` in `beforeEach` (the production selection path) and `withCorpusReaderEnv(db)` in `beforeAll`.
  - Every draft is the forum type `constitutional_petition_199`. Every approval passes `reviewChecklist: completeChecklist(await checklistOf(...))`, so only the gate decides.
  - The section ids come from `SELECT ss.id FROM statute_section ss JOIN statute s ON s.id = ss.statute_id WHERE s.name = 'Test Act 2099' AND ss.section_number = $1`, run as the superuser.

  Cases, with their assertions:
  - `F05-a verified citations and a pleaded temporal check give OK, and the partner approves with no override`:
    - gate `status: "OK"`, citations `[{ ref: "2099 SCMR 101", judgmentId: <uuid of j-verified>, status: "VERIFIED" }]`;
    - temporal `[{ sectionId: S5, asAtDate: "2099-08-01", jurisdiction: "FEDERAL", usedText: V2, status: "OK", inForceText: V2 }]`;
    - scope `{ citations: 1, temporalChecks: 1, assessed: true }`;
    - approve succeeds, `overrideDoc(draftId)` is undefined, and the draft is locked.
    - The body also cites `PLD 2099 Kar. 12`, the golden's spelling of the same judgment's `PLD 2099 Sindh 12`. It still gives one finding for `j-verified`, because the gate normalises and dedups by judgment id (Review Focus 4).
  - `F05-b a division bench overruled by a larger bench gives OVERRULED, and approval is 409 gate_blocked`: cite 2099 SCMR 202; expect status OVERRULED; approve → `expectErr(_, 409, "gate_blocked")`.
  - `F05-c a later text pleaded for an earlier date gives TEMPORAL_MISMATCH with the text in force then`: plead V2 for 2099-03-01; expect `status: "TEMPORAL_MISMATCH"` and `inForceText: V1`.
  - `F05-d each unproven authority stays UNVERIFIED or TEMPORAL_UNAVAILABLE` (`it.each`):
    - jurisdiction `SINDH` on S5;
    - jurisdiction `PK` on S5;
    - section 6 (the 0.5 version);
    - 2099 SCMR 606 (quarantined);
    - 2099 SCMR 707 (rejected provenance);
    - 2099 SCMR 919, seeded by the superuser directly: provenance, judgment (promoted, public, division) and citation, with no `publication_id`;
    - 2099 SCMR 505 (pending overruling);
    - after `UPDATE judgment SET classification = 'confidential'` on `j-restricted`'s judgment, as the superuser: 2099 SCMR 808 itself (ruling 8), and 2099 SCMR 110, whose overruling is now hidden (D2);
    - 2099 SCMR 999 (a fabricated citation, not in the corpus).

    Each gives the expected per-finding status and an overall status that is not OK, and approval answers 409 `gate_blocked`.
  - `F05-e a capitalised "Overruled" in the batch still yields OVERRULED`: cite 2099 SCMR 404; expect status OVERRULED.
  - `F05-f an overruling published after an OK gate makes approval 409 gate_blocked`:
    - gate a draft citing 2099 SCMR 101 → OK;
    - publish `curated-batch.f05-late.json`;
    - `await resetAuthorityStore()` (the state cache);
    - approve → 409 `gate_blocked`, and `report` shows status OVERRULED.
  - `F05-g a draft with no citation and no check is NOT_ASSESSED`: scope `{ citations: 0, temporalChecks: 0, assessed: false }`.
  - `F05-u each unavailable corpus gives UNVERIFIED or TEMPORAL_UNAVAILABLE, never OK, and approval is 409` (`it.each`; each case sets its env or state, calls `resetAuthorityStore()`, and restores after):
    - u1, closed port: a URL to 127.0.0.1 on a port bound and closed by the test;
    - u2, a lock causing a statement timeout: another superuser session holds `LOCK TABLE public.citation IN ACCESS EXCLUSIVE MODE`, and the gate answers in under 20 s;
    - u3, a revoked grant: `REVOKE SELECT ON v_authority_citation FROM corpus_reader`, re-granted after;
    - u4, a stale `last_refresh`: set to `2000-01-01T00:00:00.000000Z`;
    - u5, a missing contract: delete the `publication_contract` key;
    - u6, an unset environment;
    - u7, a missing view: `ALTER VIEW v_authority_citation RENAME TO v_authority_citation_gone`, renamed back after;
    - u8, the wrong role: the writer's URL used as the reader URL.
- [ ] **Step 3: Run it on the base.**
  - Run: `F05_AUTHORITY_SUITE=1 SIKANDER_POSTGRES_URL=… npm run test:f05-authority`
  - Expected: F05-a, b, c, e and f FAIL on their gate assertions (the empty store gives UNVERIFIED / TEMPORAL_UNAVAILABLE where OK, OVERRULED or TEMPORAL_MISMATCH is expected). F05-d, g and u* PASS as regression guards.
  - Save the output as `f05-red.log`.
- [ ] **Step 4: Commit**: `test(F05): user-flow e2e for the corpus-backed gate (red on the empty store)`.

### Task 2: `004_authority_read_views.sql`

**Files:** Create `postgres/ddl/004_authority_read_views.sql`; modify `tests/postgres.ddl.integration.test.ts`.

**Interfaces (produces), exact columns:**
- `v_authority_citation(citation_text text, judgment_id uuid, bench_type text)`
- `v_authority_treatment(treated_judgment_id uuid, treatment text, treating_bench_type text, treating_judgment_bench text)`
- `v_authority_section_version(section_id uuid, jurisdiction text, version_no int, effective_from date, effective_to date, text text, version_confidence double precision)`
- `v_authority_pending_adverse(treated_judgment_id uuid)`, DISTINCT.

All four are `WITH (security_barrier = true)`, `REVOKE ALL … FROM PUBLIC` and `GRANT SELECT … TO corpus_reader`. `corpus_contract_relations()` is re-created with 003's 29 names plus the four (D13). No routine is added (D12). The file is idempotent (`CREATE OR REPLACE VIEW`), with the 003-style header comment.

- [ ] **Step 1: Write PG-DDL-26..32** (reader `roleClient("corpus_reader","reader")`; rows built with the existing `publishAs` helpers; superuser-forced states through the admin client):
  - `PG-DDL-26 004: four security_barrier views, SELECT for corpus_reader only, no provenance column, and corpus_contract_relations() lists them (33) while corpus_contract_routines() still lists 12`. Check `pg_class.reloptions`, `has_table_privilege` for corpus_reader / corpus_writer / PUBLIC, and the column names against the Interfaces list.
  - `PG-DDL-27 004: a published citation is visible with its judgment's bench; under a quarantined, bench-less or non-public judgment it is not (requirement 3, ruling 8)`. Superuser updates on the parent only; assert the child row is still `promoted` while the view is empty. Also assert that `bench_type` follows a superuser change of the parent's bench (`division`→`larger`).
  - `PG-DDL-28 004: a treatment is visible only with both judgments visible; an overruled one hidden by either parent or held quarantined is pending adverse, a rejected one is not (D2, ruling 3)`. Cover: the treating parent quarantined, made confidential, or bench-less; the treated parent likewise; the treatment quarantined; the treatment `rejected`; a `followed` treatment hidden (not pending).
  - `PG-DDL-29 004: a section version is visible only under a visible section and statute, with the statute's jurisdiction; version_confidence 0.5 is shown as stored`.
  - `PG-DDL-30 004: superuser-seeded promoted rows with no publication are invisible in every v_authority view, with or without complete provenance, while 001's v_judgment shows them (ruling 2, requirement 4)`.
  - `PG-DDL-31 004: a row whose publication is unfinished, or whose provenance lacks content_hash, source_name or both source_url and raw_storage_key, is invisible`. Build the unfinished publication with the superuser: insert a `corpus_publication` with `finished_at` NULL and point a row at it.
  - `PG-DDL-32 004: the DDL chain re-applies cleanly twice and the inventory is 33 after each full pass (D13)`.
- [ ] **Step 2: Run them.**
  - Run: `SIKANDER_POSTGRES_URL=… npm run test:postgres-ddl -- -t "PG-DDL-2[6-9]|PG-DDL-3[0-2]"`
  - Expected: FAIL, `relation "v_authority_citation" does not exist`.
- [ ] **Step 3: Write 004** with the D1 predicate on every row and parent, and the D2 pending set.
- [ ] **Step 4: Run the full suite.**
  - Run: `npm run test:postgres-ddl && npm run probe:fa-data-001`
  - Expected: PG-DDL-1..32 and the probe regression PASS; the probe prints PASSED.
- [ ] **Step 5: Commit**: `feat(F05): 004 promoted-only authority read views for corpus_reader`.

### Task 3: 004 everywhere Annex A is applied (requirement 2)

**Files:**
- `corpus_service/docker/postgres/apply-annex-a.sh`: the file list and header.
- `corpus_service/tests/conftest.py`: `ANNEX_A_DDL`.
- `corpus_service/tests/test_f19_publication_db.py`: the inventory test.
- `corpus_service/tests/e2e/probe.py`: `ANNEX_A_RELATIONS` gains the four views.
- `corpus_service/tests/e2e/lib.sh`, `store_security_e2e.sh`.
- `.github/workflows/gate-g0.yml`: the corpus-service DDL loop gains 004.
- `corpus_service/README.md`: "Who applies the DDL" and the Annex A bullet name 004 and rotation.

- [ ] **Step 1: Write the failing checks.**
  - `test_f19_contract_inventory_lists_every_annex_a_relation` expects 33 (`relkind IN ('r','v')`).
  - `lib.sh annex_a_checks` expects `^33$`, and gains a check independent of the function: every `public` relation named `v_authority_%` is owned by the bootstrap superuser, and neither application role, `corpus_clients` nor PUBLIC holds a privilege on it.
  - `annex_a_reader_checks` adds: `corpus_reader` reads both probe judgments through `v_authority_citation` (`select count(*) from public.v_authority_citation where citation_text in ('2099 SCMR $page', '2099 SCMR $((page + 1))')` → `^2$`).
- [ ] **Step 2: Run them.**
  - Run: `python -m pytest corpus_service/tests/test_f19_publication_db.py -k inventory`, then `store_security_e2e.sh` and `upgrade_e2e.sh` on the private network-namespaced dockerd.
  - Expected: FAIL (29 ≠ 33; the views are missing in compose).
- [ ] **Step 3: Apply 004 everywhere.**
  - Append `004_authority_read_views.sql` to `apply-annex-a.sh` and to `ANNEX_A_DDL`.
  - Add the CI loop entry.
  - Document in the README that an existing volume gets 004 through `scripts/rotate_postgres_password.sh`.
- [ ] **Step 4: Add the D20 guard.**
  - Write the failing compose e2e case first: `re-applying 003 alone after 004: provisioning refuses, the views stay the superuser's, and 15-apply-annex-a.sh recovers`.
  - Implement the pre-check in `provision-roles.sh`.
- [ ] **Step 5: Run the requirement-1 mutants.** Apply a scratch copy of 004 without the `corpus_contract_relations()` re-definition, then run `store_security_e2e.sh` twice:
  - With the D20 guard: provisioning refuses at init, so the stack does not start.
  - With the guard also removed: the new view-ownership check FAILS, because provisioning moved the views to the migration role and granted the app DML.
  - Restore both files and save the output as `f05-req1-mutant.log`.
- [ ] **Step 6: Run everything GREEN.** Corpus pytest with the DB, both compose e2e (including the D20 case), the compose policy tests, and the shipped check: all PASS.
- [ ] **Step 7: Commit**: `fix(F05): apply 004 at init and on rotation; provisioning refuses an Annex A view missing from the inventory`.

### Task 4: `AuthorityUnavailableError` and the gate's handling

**Files:** Modify `functions/src/d4/authority.ts`, `functions/src/d4/gate.ts`, `functions/test/d4.gate.test.ts`.

**Interfaces (produces):**
- `export type AuthorityUnavailableReason = "unreachable" | "timeout" | "auth" | "tls" | "permission" | "schema_missing" | "contract_missing" | "stale" | "wrong_role" | "pending_review" | "inconsistent" | "circuit_open" | "error"`
- `export class AuthorityUnavailableError extends Error { readonly reason: AuthorityUnavailableReason }`: `name` is `"AuthorityUnavailableError"`, and `message` is `` `authority_unavailable:${reason}` `` (no driver text).

- [ ] **Step 1: Write the tests** with stub stores:
  - `runGate: a store that throws AuthorityUnavailableError on findJudgment gives UNVERIFIED with judgmentId null`;
  - `… on listTreatments gives UNVERIFIED with the found judgmentId`;
  - `… on getSectionAsAt gives TEMPORAL_UNAVAILABLE with inForceText null`;
  - `runGate: any other error from the store rejects (it is not swallowed)`, which expects `rejects.toThrow(TypeError)`;
  - `runGate: unavailable lookups never give OK, and a run with nothing to check stays NOT_ASSESSED`.
  - Assert the finding shapes with `toEqual`, unchanged.
- [ ] **Step 2: Run them.**
  - Run: `cd functions && npx vitest run test/d4.gate.test.ts`
  - Expected: FAIL (the import does not exist).
- [ ] **Step 3: Implement.**
  - In `checkCitations`, catch `AuthorityUnavailableError` around `findJudgment` and `listTreatments`, and only that class.
  - In `checkTemporal`, do the same around `getSectionAsAt`.
  - Dedup keys are unchanged.
- [ ] **Step 4: Verify.** The same file PASSES, and the existing gate tests still PASS.
- [ ] **Step 5: Commit**: `fix(F05): the gate reads an unavailable authority as UNVERIFIED / TEMPORAL_UNAVAILABLE`.

### Task 5: `readCorpusReaderConfig` (D8)

**Files:** Create `functions/src/d4/corpusReaderConfig.ts`, `functions/test/d4.corpus-config.test.ts`.

**Interfaces (produces):**
- `export type CorpusReaderConfig = { host: string; port: number; database: string; user: string; password: string; ca: string | null; maxStalenessHours: number; key: string }`. `key` is the sha256 hex of the canonical JSON of the other fields. It is the memo key and is never logged.
- `export type CorpusReaderConfigResult = { ok: true; config: CorpusReaderConfig } | { ok: false; reason: "missing" | "invalid_url" | "invalid_staleness" | "tls_required" | "invalid_ca" }`
- `export function readCorpusReaderConfig(env: Record<string, string | undefined>, production: boolean = process.env.NODE_ENV === "production"): CorpusReaderConfigResult`

- [ ] **Step 1: Write the table-driven tests.**
  - Unset URL → `missing`.
  - Hours unset, `0`, `-1`, `1.5`, `8761` or `abc` → `invalid_staleness`. `1` and `8760` → ok.
  - A URL with no password, no database, or an `http://` scheme → `invalid_url`.
  - Production with plaintext → `tls_required`. Production with `sslmode=verify-full` but no CA → `tls_required`. Production with a CA that has no `-----BEGIN CERTIFICATE-----` → `invalid_ca`.
  - Non-production plaintext to `127.0.0.1` / `localhost` / `[::1]` → ok with `ca: null`. Non-production plaintext to `10.0.0.5` → `tls_required`.
  - Two equal configs have the same `key`; a different password gives a different `key`.
  - `JSON.stringify(result)` for an error never contains the password.
- [ ] **Step 2: Run them.**
  - Run: `npx vitest run test/d4.corpus-config.test.ts`
  - Expected: FAIL (the module does not exist).
- [ ] **Step 3: Implement** with `new URL()` and explicit fields.
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit**: `feat(F05): corpus reader configuration, required staleness and TLS rules`.

### Task 6: `PgAuthorityStore` lookups

**Files:**
- Create `functions/src/d4/corpusAuthorityStore.ts`, `functions/test/d4.corpus-authority.pg.test.ts` (lookup half).
- Modify `functions/package.json` / `package-lock.json` (`pg ^8.16.3`, `@types/pg ^8.15.5`) and `functions/build.mjs` (`"pg-native"` in `external` for all three builds).

**Interfaces (produces):**
- `export const MIN_VERSION_CONFIDENCE = 0.5`, `POOL_MAX`, `CONNECT_TIMEOUT_MS`, `STATEMENT_TIMEOUT_MS`, `IDLE_TIMEOUT_MS`, `STATE_TTL_MS`, `BREAKER_OPEN_MS`, `FUTURE_SKEW_MS`, `PUBLICATION_CONTRACT = "1"` (D9, D19).
- `export function annexJurisdiction(code: string): "Federal" | "Sindh" | "Punjab" | "KP" | "Balochistan" | "ICT" | "GB" | "AJK" | null` (D3).
- `export function versionUsable(confidence: number | null): boolean` (D4).
- `export type SectionVersionRow = { versionNo: number; effectiveFrom: string; effectiveTo: string | null; text: string; versionConfidence: number | null }`
- `export function coveringVersion(rows: readonly SectionVersionRow[], asAtDate: string): SectionVersionRow | null`. It throws `AuthorityUnavailableError('inconsistent')` on a reversed range, an overlap, an open range that is not last, or a `versionNo` out of order (D5).
- `export class PgAuthorityStore implements AuthorityStore { constructor(config: CorpusReaderConfig, deps?: { now?: () => number }); end(): Promise<void> }`

SQL (D10, D11), against `public.` views only:
- citation: `SELECT judgment_id::text AS id, bench_type FROM public.v_authority_citation WHERE citation_text = $1`
- treatments, one statement:
  ```sql
  SELECT 'pending' AS k, NULL::text AS kind, NULL::text AS recorded, NULL::text AS treating FROM public.v_authority_pending_adverse WHERE treated_judgment_id = $1
  UNION ALL
  SELECT 'treatment', treatment, treating_bench_type, treating_judgment_bench FROM public.v_authority_treatment WHERE treated_judgment_id = $1
  ```
  Any `pending` row throws `pending_review`. Each treatment row maps to `{ kind, treatingJudgmentBench: treating, recordedTreatingBench: recorded }`. A kind or bench outside the closed sets throws `inconsistent`.
- sections: `SELECT version_no, effective_from::text, effective_to::text, text, version_confidence FROM public.v_authority_section_version WHERE section_id = $1 AND jurisdiction = $2 ORDER BY effective_from, version_no`. Then `coveringVersion`, then `versionUsable`: unusable → `no_history`, otherwise `{ text }`.

- [ ] **Step 1: Write the tests.** Pure helpers run without a database. The Pg tests use `createCorpusDb("adapter")`, seeded from the D24 golden and a small history batch.
  - `annexJurisdiction maps upper-case codes by equality only`: `FEDERAL→Federal`, `KP→KP`, `PK/SD/KPK/ISLAMABAD/Federal/federal → null`.
  - `versionUsable is strictly above 0.5 and NaN-safe`: `0.5→false, 0.5000001→true, 1→true, 1.0000001→false, NaN/null/Infinity/-Infinity→false`.
  - `coveringVersion picks the one version with from <= date < to`: boundary dates (`to` is exclusive), the open last version, and each inconsistency → `inconsistent`.
  - `findJudgment matches the canonical key exactly, for every golden case the Python builder keys`: for each golden case with `python: "match"`, `findJudgment(canonical)` gives the judgment. Where `raw !== canonical`, `findJudgment(raw)` gives null. A near miss (page + 1) gives null.
  - `listTreatments returns lowercase kinds and the treating judgment's own bench`.
  - `listTreatments throws pending_review for a quarantined overruling` (ruling 3).
  - `listTreatments throws inconsistent for a judgment id that is not a UUID, and never returns [] on failure` (D5).
  - `getSectionAsAt: amendment boundaries, unmapped and PK codes, non-UUID ids and the 0.5 version give the expected text or no_history`.
  - `dates do not move with the process time zone`: run the boundary case in child processes with `TZ=Asia/Karachi` and `TZ=America/Los_Angeles`; both give the same text as UTC (Review Focus 2).
- [ ] **Step 2: Run them.**
  - Run: `F05_AUTHORITY_SUITE=1 npm run test:f05-authority`
  - Expected: FAIL (the module does not exist).
- [ ] **Step 3: Implement the lookups, the pool (D9) and the cheap refusals (D18).** Every query goes through the state check (Task 7 hardens it; here it only requires `publication_contract = '1'`).
- [ ] **Step 4: Verify.** The lookup tests PASS; `npm --prefix functions run build` succeeds; `npm --prefix functions run typecheck` shows 0 errors.
- [ ] **Step 5: Commit**: `feat(F05): PgAuthorityStore lookups over the authority views`.

### Task 7: `PgAuthorityStore` failure handling

**Files:** Modify `functions/src/d4/corpusAuthorityStore.ts`, `functions/test/d4.corpus-authority.pg.test.ts` (failure half).

**Interfaces (produces):** `export function classifyPgError(err: unknown): AuthorityUnavailableReason` (D6).

The state check (D7, D19), cached `STATE_TTL_MS`:
```sql
SELECT (SELECT value FROM public.corpus_metadata WHERE key = 'publication_contract') AS contract,
       (SELECT value FROM public.corpus_metadata WHERE key = 'last_refresh') AS last_refresh,
       pg_has_role('corpus_reader', 'USAGE') AS reader,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
       pg_has_role('corpus_writer', 'MEMBER') OR pg_has_role('corpus_declassify', 'MEMBER') AS writer,
       current_setting('transaction_read_only') AS read_only
```

The breaker opens for `BREAKER_OPEN_MS` on any thrown reason except `pending_review` and `inconsistent`. While open, calls throw `circuit_open` without connecting.

- [ ] **Step 1: Write the tests.** Each one expects `rejects.toMatchObject({ name: "AuthorityUnavailableError", reason })`:
  - `contract_missing` (the key deleted, or `last_refresh` missing or garbage);
  - `stale` (old `last_refresh`, and one 10 minutes in the future);
  - `wrong_role` (the writer login, a superuser URL, and a reader whose session is not read-only via `options` override);
  - `permission` (revoked SELECT);
  - `schema_missing` (renamed view);
  - `unreachable` (a closed port);
  - `timeout` (a lock held by another session; the call settles within `STATEMENT_TIMEOUT_MS + 2000`);
  - `auth` (a wrong password);
  - `a hung server costs one connect timeout`: a `net.createServer` that accepts and never writes, and a `runGate` over 25 distinct citations, finish in under 10 s with every finding UNVERIFIED (Review Focus 3);
  - `circuit_open` (a second call within the window does not connect: the hung server sees one connection);
  - `classifyPgError` over a table of SQLSTATEs and Node error codes (D6);
  - `the unavailable log carries the reason only`: spy on `logger.warn`, then assert the payload is exactly `{ reason }` and that no logged string contains the host, the password or the driver message.
- [ ] **Step 2: Run them.** Run: `F05_AUTHORITY_SUITE=1 npm run test:f05-authority`. Expected: FAIL on each new case.
- [ ] **Step 3: Implement** the state check, `classifyPgError`, the breaker and the log.
- [ ] **Step 4: Verify.** PASS.
- [ ] **Step 5: Commit**: `feat(F05): the corpus reader fails closed (state, role, errors, breaker)`.

### Task 8: Store selection

**Files:** Modify `functions/src/d4/authority.ts`, `functions/test/d4.boot.test.ts`.

**Interfaces (produces):**
- `activeAuthorityStore(): AuthorityStore` returns, in order:
  1. the test store;
  2. otherwise, when `readCorpusReaderConfig(process.env)` is ok, the memoised `PgAuthorityStore` for `config.key`;
  3. otherwise `EMPTY_AUTHORITY_STORE`, logging `d4.authority_not_configured {reason}` once per reason.
- `export async function resetCorpusAuthorityStoreForTests(): Promise<void>` ends every memoised pool and clears the memo and the once-log. It throws in production.

- [ ] **Step 1: Write the tests.**
  - Keep `the production authority store is EMPTY_AUTHORITY_STORE: a fresh load of the gate's modules runs on it` (environment unset) unchanged.
  - Add:
    - `with a valid loopback config the active store is a PgAuthorityStore, memoised per config`;
    - `an invalid config falls back to the empty store and logs d4.authority_not_configured once`;
    - `in production a plaintext URL is the empty store`;
    - `a test store wins over the environment`;
    - `resetCorpusAuthorityStoreForTests refuses in production`.
- [ ] **Step 2: Run them.** Run: `npx vitest run test/d4.boot.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** PASS. Run the Task 1 e2e: `F05_AUTHORITY_SUITE=1 npm run test:f05-authority`, expecting every F05 case to PASS (GREEN). Save the output as `f05-green.log`.
- [ ] **Step 5: Commit**: `fix(F05): the gate reads the promoted corpus when the reader is configured`.

### Task 9: O-59 parity

**Files:** Create `functions/test/d4.authority-parity.pg.test.ts`, `tests/fixtures/corpus/parity-batch.f05.json`.

**The fixture** has only promoting items:
- 6 judgments over 3 benches;
- 3 overrulings and 2 non-adverse treatments;
- 2 statutes (Federal, Punjab) with amendment histories at 0.9.

**The test** (D17):
1. Publish the fixture, then read `(citation_text, judgment_id)`, the section ids and the statute jurisdictions as the superuser.
2. Build an `InMemoryAuthorityStore` from the JSON with those ids. Versions use the upper-case code of the statute's jurisdiction.
3. Assert, for each store:
   - for every fixture citation (canonical form and each golden raw form), `findJudgment` is equal;
   - for every found judgment, `listTreatments` is equal as a sorted multiset;
   - for every section, the dates at each boundary −1 day, at `from` and at `to`, crossed with `FEDERAL | PUNJAB | PK`, give an equal `getSectionAsAt`.
- Test name: `O-59 parity: the Pg store and the in-memory store answer every query on the parity fixture alike`.

- [ ] **Step 1: Write the test.** It FAILS only if Tasks 6 and 8 diverge from the in-memory semantics; run it to see it pass, and record that it was written after the adapter.
- [ ] **Step 2: Mutant check.** Make `annexJurisdiction` case-insensitive in a scratch copy, then run the test. Expected: it FAILS on `PK`/lower-case inputs. Restore the file and save the output as `f05-parity-mutant.log`.
- [ ] **Step 3: Commit**: `test(F05): O-59 parity between the Pg and in-memory authority stores`.

### Task 10: CI, named gates, docs and verification

**Files:**
- `.github/workflows/gate-g0.yml`: a new job, `authority-f05`, named "Authority corpus e2e (F05)". It runs `pgvector/pgvector:pg16` (`POSTGRES_PASSWORD: postgres`), Java 21, setup-python `PYTHON_VERSION`, `pip install -r corpus_service/requirements-test.txt`, `npm ci`, the functions install, then `npm run test:f05-authority`, with `SIKANDER_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres` and `SIKANDER_CORPUS_PYTHON=python`.
- `ci_gates/gate_g4_phase4a.sh`: the new d4.boot and d4.gate test names are added to `D4_BOOT_TESTS` / `GATE_UNIT_TESTS`.
- `functions/src/d4/README.md`, `docs/architecture/README.md`: the test-commands row and how the reader is configured.

- [ ] **Step 1: Prove the G-4 gate.**
  - Run: `bash ci_gates/gate_g4_phase4a.sh`. Expected: PASS with the new count.
  - Run: `G4A_FILTER=nomatch bash ci_gates/gate_g4_phase4a.sh`. Expected: FAIL (the existing can-fail proof).
- [ ] **Step 2: Run the full verification.** Every command passes:
  - `npm run test:postgres-ddl`;
  - `npm run probe:fa-data-001`;
  - both gate-g0 DDL loops twice;
  - corpus pytest with the DB;
  - `npm run test:unit`;
  - `npm --prefix functions run typecheck`;
  - `npm --prefix functions run build`;
  - `npm --prefix functions run test:emu`;
  - `F05_AUTHORITY_SUITE=1 npm run test:f05-authority`;
  - `npm run typecheck`, `npm run typecheck:tests`, `npm run lint`;
  - `BASE=<base> npm run gate:g0`;
  - `python3 ci_gates/test_check_compose_policy.py -v`;
  - `store_security_e2e.sh` / `upgrade_e2e.sh`;
  - gitleaks.
- [ ] **Step 3: Commit**: `ci(F05): authority corpus e2e job, named G-4 tests and docs`.
- [ ] **Step 4: Open the PR** (only when instructed): `fix(F05): promoted-only authority reader for the draft gate`, with base #50's branch, the flags table, and the claim gate first.

---

## Why each new test fails on the base (`c6561f9`)

| Test | Failure on the base |
|---|---|
| F05-a, b, c, e, f | `activeAuthorityStore()` ignores the environment and returns `EMPTY_AUTHORITY_STORE`: every citation is UNVERIFIED and every check TEMPORAL_UNAVAILABLE (a: not OK, approve 409; b/e: UNVERIFIED instead of OVERRULED; c: UNAVAILABLE instead of MISMATCH; f: the first gate is not OK) |
| F05-d, g, u1–u8 | Pass (regression guards: the empty store already fails closed) |
| PG-DDL-26..32 | `v_authority_*` do not exist |
| inventory 33, compose `v_authority` checks | 004 absent |
| d4.gate, d4.corpus-config, d4.boot additions, d4.corpus-authority | The error class, config reader, selection and adapter do not exist |

## Spec points ruled on (also for the coordinator)

1. **Audit §10.** The F05 entry has no §10 of its own. Audit §10 is observability: "Which documents were retrieved? … Authorized source/version/chunk IDs". Ruling 12 forbids stored markers, so §10 is met only by logs (D16). §11's "P0 legal/AI evaluation" row is mapped to e2e cases: no citation (g), fabricated (d), stale law (c), conflicting cases (b, e, d pending). "Irrelevant true citation" and "instruction-bearing source" stay with F16/F17.
2. **Jurisdiction codes.** R11 codes are upper case, but Annex A values are mixed case (D3).
3. **"Throws" for inconsistent data** means `AuthorityUnavailableError('inconsistent')` (D5).
4. **Requirement 3 against rulings 3 and 8.** Inner joins would hide an overruling and read VERIFIED. D2 surfaces hidden overrulings as pending.
5. **Requirement 4.** "No publication provenance" is enforced as a finished publication **and** complete provenance (D1). This is stricter than spec §6.
6. **Requirement 1.** It makes the DDL order load-bearing (D13).
7. **Spec §6 CI exclusion wording.** As written, excluding the Pg files when the URL is unset can pass vacuously. D14 gates on a suite flag instead.

## UNVERIFIED (cannot be proven by this plan)

1. The esbuild bundle with `pg-native` external on the real Cloud Functions runtime (spec §8). Only `npm run build` and a local load are checked.
2. TLS verify-full against a real corpus host CA. Tests use loopback plaintext (non-production); production rules are unit-tested only (D8).
3. Pool scale-out against `max_connections` (spec §8). There is no load test.
4. That the in-memory store's semantics equal the Pg store's beyond the parity fixture's query grid.
5. The network path from asia-south1, secret binding for the URL/CA, and a reader login on the compose corpus host. These are out of scope (spec §7). PR 2b gives `corpus_reader` schema USAGE, but no login.
6. The statement-timeout bound on a loaded CI runner (u2: 20 s budget).

## Out of scope (recorded)

- The Next.js transitional gate (O-67).
- Embeddings (F27).
- Scheduling (F21).
- The quarantine route (F23).
- FA-DATA-002/003.
- A stored authority marker (ruling 12).
- Curated real content.
