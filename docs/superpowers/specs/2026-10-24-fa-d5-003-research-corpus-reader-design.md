# FA-D5-003 (closes FA-D2WA-001) and FA-DATA-003: research reads the published Annex A corpus (design)

Date: 2026-10-24. Base: `origin/main` @ 133a346. Branch: `claude/remediate-fa-d5-003`. Status: approved by the builder under the
owner's standing autonomy instruction; every ruling records its reason.

## 1. Findings

- **FA-D5-003 [MEDIUM]** (issue #30): "The Next runtime has no corpus loader. `store.judgments`, `store.embeddings` and
  `store.treatments` are empty in production, so D5 research and WhatsApp `/research` answer an empty list (as the Next
  citation gate does; the F05 Postgres reader serves only the Functions draft gate). Fix: a runtime corpus reader over the
  promoted Annex A corpus, with FA-DATA-003 classification filtering. Closing it also closes FA-D2WA-001."
- **FA-D2WA-001 [HIGH]**: WhatsApp returns constant `research: []`. #69 (e847848) made the reply a function of the query and
  the corpus, but the item stayed open under the F01 precedent: "a finding about a user-visible result closes when that
  result is right in production, not only in a seeded test."
- **FA-DATA-003 [MEDIUM]** (`docs/audit/2026-10-14-forensic-audit-v2.md:131`): "unfiltered provenance and embeddings granted
  to corpus_reader" (001 `:166` `v_source_provenance AS SELECT * FROM source_provenance`, and `:169`'s grant of that view and
  of the `corpus_embeddings` base table). F05 plan D21 and the F05/F19/F20 spec, ruling 13 amendment, left it open on purpose.

## 2. What main does (observed at 133a346)

**Where the production request is answered (#106, d00c258, F02).** `POST /api/d2/court-ops` is served by the Next process:

1. `app/api/d2/court-ops/route.ts` `POST` → `withSession` → `withF02Authority(F02_COURT_OPS, "POST", handlePost)`.
2. On production Firestore (`mustDispatchF02()`: firestore mode, a configured database, no test-injected handle, not already in
   the authority frame) a bearer request goes to `dispatchF02`, which loads `functions/src/http/f02RouterBoundary` **in the
   Next process** and runs the Functions router over `F02_NEXT_AUTHORITY_ROUTES` only: bearer and `X-Firm-Id` binding, the
   F02 matter and classification gate, the rate limit and the `rerun` idempotency fence.
3. The router's operation calls `invokeF02Core`, which runs the Next core `handlePost` (registered by the route module) in the
   same process, inside the authority frame. The response carries `x-authority-path: functions`.
4. `handlePost` → `handleWhatsApp(store, actorId, text)` → `searchCorpus(store, { text })` over `getRuntimeStore()`.

The deployed Functions `api` mounts the same nine routes but has no Next core: a direct call answers
`503 authority_core_unconfigured` (`platform/authority/f02Registry.ts`). There is no `/api/d5` route; `searchCorpus` is reached
only through WhatsApp `/research` (`tests/g2/paths.ts:511`). **So the research answer is computed by the Next core, in the
Next process, and that is where the reader belongs.** Nothing in Functions changes.

**What the Next core reads.** Nothing loads `store.judgments`, `store.embeddings` or `store.treatments` outside tests, so a
production `/research <query>` answers `{ ok: true, research: [] }` whatever Annex A holds. A missing or unreachable corpus is
indistinguishable from "nothing matched".

**FA-DATA-003.** 001 grants `corpus_reader` SELECT on `v_source_provenance` (every provenance row, unfiltered) and on the
`corpus_embeddings` base table (every vector, of every judgment and section, under any classification or review state). A
`corpus_reader` login on main reads both.

## 3. Rulings

| # | Decision | Ruling | Reason |
|---|---|---|---|
| R1 | Side | The reader runs in the Next process, called from the court-ops core through the research seam (`services/d5-1`). No Functions change. | §2: the production answer is computed by the Next core after the in-process Functions authority router. A Functions-side reader would never be called. |
| R2 | Role | A sibling role, `corpus_research_reader` (005): NOLOGIN, NOINHERIT, no attribute, no membership, USAGE on `public`, SELECT on `v_research_judgment`, `v_research_embedding` (005), `v_authority_citation`, `v_authority_treatment`, `v_authority_pending_adverse` (004) and `corpus_metadata`. `corpus_authority_reader` is not extended. | F05 D21: "the gate needs only the four authority views, so its credential should reach nothing else". Research needs titles and vectors the gate never reads. The two readers run in different runtimes (Next on Vercel, the gate in Cloud Functions) with different secrets, so one leaked credential reaches one surface. The F05 allowlist already refuses a login holding any other role, so each reader refuses the other's login by construction (tested). *Steelman for extending:* one role and one secret. *Answer:* the deploy targets need separate secrets anyway, and widening the gate's credential is exactly what D21 refused. |
| R3 | Views | 005 adds two `security_barrier` views with 004's judgment visibility rule copied verbatim: `promoted`, a bench, classification rank 0 (public), a finished publication, complete provenance. `v_research_judgment(judgment_id, case_title, bench_type)`; `v_research_embedding(judgment_id, model, embedding)` for `entity_type = 'judgment'`, the embedding's own `classification_rank = 0`, and a visible judgment. Citations and treatments reuse 004's views. No provenance column, no text. | The same rule as the gate (spec ruling 8, plan D1): one definition of "published". 004's citation and treatment views already apply it to every parent. No routine (plan D12): a helper function would need EXECUTE for the reader and change the routine inventory. The embedding's own rank is also required, so a vector recorded under a restricted rank stays hidden even after its judgment is declassified (fail closed until re-embedded). |
| R4 | Inventory | `corpus_contract_relations()` is re-defined in 005 with the two views (35 relations). Provisioning refuses to run without 005's role, grants it USAGE on `public`, and its name guard covers `v_research_%`. `apply-annex-a.sh` applies 001 → 003 → 004 → 005 in its one transaction. | Provisioning (F05 D20) refuses an Annex A view the inventory does not list, and its ownership move would otherwise hand the view to the migration role, which could redefine it. One transaction keeps 001's re-grant and 005's revoke atomic on every re-apply. |
| R5 | FA-DATA-003 | 005 revokes SELECT on `v_source_provenance` and `corpus_embeddings` from `corpus_reader`. `corpus_reader` keeps the nine promoted-only `v_*` views and `corpus_metadata`. No filtered replacement is granted to it. | The finding names exactly these two grants. G-0 (architecture L18 §10: "corpus_reader can SELECT views and cannot SELECT base tables or INSERT") stays true for the promoted-only views; `corpus_embeddings` is a base table, so 001's grant contradicted G-0 itself, and `v_source_provenance` has no filter at all. Nothing in the app reads either through `corpus_reader`; research has its own role. A revoke is narrower than redefining `v_source_provenance`, which superuser tooling may read. |
| R6 | Search semantics | Unchanged. The Postgres path loads the visible corpus and ranks it with the same function as the in-memory path (`rankResearchCorpus`): IDF keyword coverage, cosine, the 0.6/0.4 blend, 6-decimal rounding, R4a, the tie-breaks, k bounds 1..50 (default 10), scores in (0, 1]. `searchCorpus(store, query)` keeps its signature and behaviour. A judgment with several visible citations: keyword terms cover the title and every citation, R4a matches any of them, and the reply shows the cited one when R4a matched, else the first in text order. | The brief requires #69's ranking unchanged. One ranking function for both sources means they cannot drift. For a one-citation judgment (every in-memory row) the multi-citation rule is the #69 rule. *Steelman for SQL-side search* (HNSW `<=>`, trigram): it scales. *Answer:* HNSW is approximate and a top-k cut would drop judgments the blend promotes; IDF needs whole-corpus document frequencies; the NFKD and digit folding is not reproducible in SQL. Scale is a recorded follow-up, bounded meanwhile by R8's caps. |
| R7 | Treatments | Postgres verdicts come from `v_authority_treatment` (`overruled` rows) and `v_authority_pending_adverse`, through the shared Module 33 rule `verdictFromTreatments`, with F05's `PENDING_OVERRULING` for a pending or hidden overruling. The in-memory path keeps `verifyCitations`. | The same facts and rule as the F05 gate (`PgAuthorityStore.listTreatments`, P4-2): a hidden overruling never reads as good law, and never hides a qualifying one. Only `overruled` counts in the rule, so other kinds are not loaded. |
| R8 | Lock (G1-10) and model guard | The lock applies to what research can read: `corpus_metadata.embedding_dim` and the distinct `(model, vector_dims)` pairs of `v_research_embedding`. The in-app switch (`changeEmbeddingModel`, FA-D5-002) is unchanged and in-memory only. | A corpus-wide re-embed changes visible vectors too, so a mid-migration corpus is still refused. Vectors of hidden judgments and of sections are outside the research role (R5), so they cannot be in its lock. Annex A's live model is changed by the corpus side. |
| R9 | Bounds | Fixed statements with `$n` parameters only. One `REPEATABLE READ READ ONLY` transaction per load (one snapshot). Session `default_transaction_read_only=on`, `statement_timeout` 5000 ms, driver `query_timeout` 6000 ms, connect timeout 3000 ms, pool of 3. Row caps, read as `LIMIT cap + 1`: 20,000 judgments (citations aggregated per judgment), 20,000 treatment rows, 5,000 vectors (loaded only for a query with an embedding). Over a cap the load fails as `row_cap`; a result is never truncated. | The brief: a statement timeout, a row cap and parameterised SQL. Truncation would turn a large corpus into wrong answers that look right. |
| R10 | Failure | A typed `CorpusUnavailableError(reason)`. The route answers `503 { error: "research corpus unavailable", code: "corpus_unavailable" }` (through the F02 router: `503 { error: { code: "corpus_unavailable" } }`). The reason is logged as `d5.research_corpus_unavailable {reason}`, at most once per reason per 30 s, and never returned. The idempotency claim is not completed, so the same key may retry. A query the search refuses stays a 400; `[]` means only that nothing matched. | The brief: an empty list must mean nothing matched. Reason tokens only, never driver text, a host or a credential (F05 D6, D16). |
| R11 | Allowlist | The research login must inherit `corpus_research_reader`; be a member of it and, for CONNECT only, `corpus_clients`, and of nothing else (transitively, SET-only and implicit memberships included); no role in its closure may hold SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS; it may hold no write privilege in `public`; it may SELECT nothing in `public` but the six relations of R2; the session must be read-only. Checked on every load, inside the load's transaction. Otherwise `wrong_role`. | F05 D7's shape (an allowlist, not a denylist: #51 fix round 2). No TTL cache, so a grant change applies to the next request. |
| R12 | Freshness | `corpus_metadata.publication_contract` must be `'1'` and `last_refresh` a well-formed UTC stamp no older than `SIKANDER_CORPUS_MAX_STALENESS_HOURS` (required) and at most 5 minutes ahead; else `contract_missing` or `stale`. | F05 D19/D30: treatment verdicts from a stale corpus could read VERIFIED when they are not. |
| R13 | Selection and configuration | `SIKANDER_RESEARCH_CORPUS` selects the source: `postgres` (also when unset) or `memory`. `memory` is honoured only when `NODE_ENV` is `development` or `test` and no hosted-runtime marker (`K_SERVICE`, `VERCEL`, `VERCEL_ENV`, `FUNCTION_TARGET`, `FIREBASE_CONFIG`, `GAE_SERVICE`) is set; otherwise `misconfigured`. Postgres reads `SIKANDER_CORPUS_RESEARCH_READER_URL` (the DSN secret), `SIKANDER_CORPUS_RESEARCH_READER_CA` and `SIKANDER_CORPUS_MAX_STALENESS_HOURS` through F05's `readCorpusReaderConfig` (production must use `sslmode=verify-full` with a CA; plaintext only to loopback outside production). No URL: `not_configured`. `infra/deploy-manifest.json` `next.corpusResearch` names the env vars, the role and the source, and the F32 contract checks that the manifest carries names only and that the code, 005 and provisioning use them. | The brief: production fails closed without a DSN, and the in-memory store is used only when explicitly selected. The same URL policy as F05, by reuse rather than a copy. |
| R14 | Seam | `handleWhatsApp` becomes async and reads research through a `ResearchSource`, by default the active selection (R13). The P5 `research` check still runs first, before the query or the corpus is read. The court-ops route maps `CorpusUnavailableError` to R10's 503. | One code path for both sources; a denied caller still learns nothing and costs no corpus read. |
| R15 | Tests that used the in-memory corpus through the route | The #69 e2e and G-2 now select `SIKANDER_RESEARCH_CORPUS=memory` explicitly. `gate_g1` G1-2 and `spine.hardening` await `handleWhatsApp`. The inventory counts in PG-DDL and the corpus_service suites move from 33 to 35. No other expectation changes. | R13 removes the implicit in-memory default; the suites' assertions are unchanged. |
| R16 | `pg` at runtime | `pg` moves from root `devDependencies` to `dependencies`: the Next runtime now imports it (lazily, only when the Postgres source is selected). The lockfile was regenerated by npm itself (`npm install --package-lock-only --ignore-scripts`, which writes no `node_modules`), and its diff is only the `"dev": true` flags of `pg` and its 13-package subtree. The F39 lockfile guard passes. | A runtime import of a devDependency is a classification error. The common brief forbids hand-editing lockfiles and installing into the shared `node_modules`; neither happened. |
| R18 | The F18 boundary | Outside `functions/`, the Next runtime may import only the pure Functions modules on `FUNCTIONS_PURE_MODULES` (G-0 [19], FA-F18-010). `functions/src/d4/corpusReaderConfig` (imports `node:crypto` only) and `functions/src/d4/authorityPending` (one frozen fact, type imports only) join that list, and the closure test (`tests/f18-functions-pure-closure.test.ts`) proves neither reaches a paid P1 path. The F05 store (`corpusAuthorityStore`: `firebase-functions`, `pg`) does not: its driver-error classification and `last_refresh` parser are restated in the research adapter, and a parity test holds them equal to F05's over every code and stamp they know. | One URL/TLS policy and one pending-overruling fact, by reuse; the two restated functions are pinned to F05's by a test, so they cannot drift silently. *Steelman for moving them out of `functions/`:* one copy. *Answer:* it rewrites merged F05 modules for a Next feature; the allowlist is the gate's own mechanism for pure modules. |
| R17 | Production status | In-repo: the reader, the role, the grants, the selection, the manifest entry, and an end-to-end test through the production route (Firestore and Auth emulators, F02 dispatch) against real Postgres seeded by the F19 publication CLI. NOT DEMONSTRATED live: provisioning a `corpus_research_reader` login on the firm's corpus database, setting the Vercel secrets, and a production `/research` call. | Under the F01 precedent FA-D2WA-001 closes only when production answers correctly; that step is the owner's deploy. |

## 4. Design

**Migration `postgres/ddl/005_research_reader.sql`** (additive, idempotent; 001-004 untouched; applied after 004):
1. FA-DATA-003: `REVOKE ALL ON v_source_provenance, corpus_embeddings FROM corpus_reader`.
2. `corpus_research_reader` (R2), USAGE on `public`.
3. `v_research_judgment`, `v_research_embedding` (R3), `security_barrier`.
4. Grants (R2): revoke the two views from PUBLIC and every other corpus role; revoke all six from the research role; grant
   SELECT on the six to it.
5. `corpus_contract_relations()` with 35 relations (R4).

**Search core `services/d5-1/research.ts`.** `prepareResearchQuery` (object, k, text), `parseResearchEmbedding(liveModel, …)`,
`rankResearchCorpus(corpus, prepared, unitQuery)` over a `ResearchCorpus` (documents, the live model and dimension, the stored
vector pairs, the vectors when needed, and a verdict lookup). `searchCorpus(store, query)` composes them over the runtime store.
`searchResearch(source, query)` composes them over any `ResearchSource`.

**Source seam `services/d5-1/researchCorpus.ts`.** `ResearchSource.load(plan)`; `CorpusUnavailableError`;
`memoryResearchSource(store)`; `activeResearchSource(store, env)` (R13); the throttled reason log (R10).

**Postgres adapter `platform/corpus/pgResearchCorpus.ts`.** Per load: one pooled client, `BEGIN ISOLATION LEVEL REPEATABLE
READ READ ONLY`, the role check (R11), the metadata check (R12), the plan callback (validates a query vector against the live
model), judgments with their visible citations (`array_agg`), overrulings and pending overrulings, the vector pairs, and the
vectors when the plan asks; `COMMIT`. Every driver error maps to a reason (F05's classification), every contract breach to
`inconsistent`.

**Route `app/api/d2/court-ops/route.ts`.** `await handleWhatsApp(...)`; `CorpusUnavailableError` → R10's 503.

**Config.** `infra/deploy-manifest.json` `next.corpusResearch`; `ci_gates/check_deploy_contract.py` `_check_next_corpus_research`.

## 5. Tests

- **E2E** `tests/fa-d5-003.research-corpus.e2e.firestore.test.ts` (Auth and Firestore emulators, real Postgres 16 + pgvector,
  corpus published by `python -m scraper.publication.cli publish` as a `corpus_writer` member, research login a member of
  `corpus_research_reader` only). Through `POST /api/d2/court-ops` with real ID tokens, F02 dispatch asserted by
  `x-authority-path: functions`:
  - published authorities come back for `/research bail 497 CrPC`, ranked, capped at 10, with treatments (OVERRULED by a
    larger bench; UNVERIFIED for a pending overruling; VERIFIED otherwise);
  - R4a: a cited authority ranks first, by any of its citations;
  - quarantined, rejected, superuser-written (unpublished), unfinished-publication, privileged and bench-less judgments never
    appear, whatever the query names;
  - no DSN, an unreachable database, a wrong-role login, a stale corpus → 503 `corpus_unavailable`, never `[]`;
  - a visible vector under another model → 400 `search refuses: embedding_model mismatch`;
  - a query that matches nothing → 200 `[]`.
  RED on main: every published-authority assertion sees `[]`, every `corpus_unavailable` case sees 200 `[]`.
- **Postgres** `tests/fa-d5-003.corpus-grants.pg.test.ts`: the `corpus_reader` grant snapshot (FA-DATA-003; RED on main:
  `corpus_reader` reads `v_source_provenance` and `corpus_embeddings`); `corpus_reader` still reads the nine promoted-only
  views; the `corpus_research_reader` grant and attribute snapshot; the visibility matrix of both research views; the inventory;
  the reader's allowlist against hostile login shapes; the row cap and the statement timeout.
- **Unit** `tests/fa-d5-003.research-source.test.ts`: selection (R13), the 503 mapping, the reason log, the multi-citation
  rule (R6) and the Postgres verdict rule (R7) on a hand-built corpus.
- **Regression**: the #69 FA-D5 suites, G-1, G-2, the court-ops suites, PG-DDL, the F05 reader suites, the F19 suites, G-0.

## 6. Residuals and follow-ups

1. **Live production (R17)** is NOT DEMONSTRATED: provision the login, set `SIKANDER_CORPUS_RESEARCH_READER_URL`,
   `SIKANDER_CORPUS_RESEARCH_READER_CA` and `SIKANDER_CORPUS_MAX_STALENESS_HOURS` on Vercel, call `/research`.
2. **Scale (R6, R9).** Over 20,000 visible judgments research answers `corpus_unavailable` (`row_cap`). Follow-up: a
   server-side candidate prefilter with whole-corpus document frequencies, and pgvector for the semantic leg once a P1
   embedding operation exists (#69 residual 1).
3. **`corpus_reader`'s nine views still filter on `review_status` only** (no publication, provenance or classification
   filter). No runtime path reads through `corpus_reader`. Tightening them changes the architecture's G-0 contract and the
   PG-DDL suites that seed them as the superuser: follow-up.
4. **The Next citation gate** (`verifyCitations` over the runtime store) is still empty in production; FA-D5-003's text
   mentions it in parentheses. It is a D4 surface, outside this lane: follow-up.
5. **`ops/backup` test seeds** list 001/003/004 only (F33's lane); they seed rows for link checks and do not need 005.
6. **No load cache.** Every `/research` loads the visible corpus in one snapshot. A cache keyed by `last_refresh` is a
   follow-up if load time matters.

## 7. Re-audit R1 follow-up (FA-D5-003-R1-001 to R1-005)

Date: 2026-10-24. Base: `origin/main` @ 0d9af65 (contains #124, 17285d3). Branch: `claude/remediate-fa-d5-003-fu`. The
independent re-audit returned FAIL 6.5/10 with one HIGH (R1-001) and four LOWs (R1-002 to R1-005). These rulings extend
§3; where one replaces an earlier ruling it says so. Approved by the builder under the owner's standing autonomy
instruction; every ruling records its reason. Measured values are in §7.4.

### 7.1 Findings

- **R1-001 [HIGH]**: every `/research` loaded the whole visible corpus with no cache and answered a permanent 503
  `row_cap` above 20,000 judgments or 20,000 treatment rows, for every firm. At the caps the treatment statement alone took
  2,654 ms against the 5,000 ms `statement_timeout`; a text load took 2.6 s and a load with vectors 3.6 s and 156 MB of
  heap. The architecture's corpus is 195,000+ judgments (E-14, architecture line 6868) and L17.12 #66 says full ingestion.
- **R1-002 [LOW]**: a corpus-lock refusal (a visible vector under another model) was a `PublicError`, a 400 the
  idempotency layer stores, so a retry with the same key replayed the refusal after the corpus was fixed.
- **R1-003 [LOW]**: the allowlist looked only at schema `public` (a SELECT grant in another schema passed) and ignored
  ADMIN OPTION (a login holding `corpus_research_reader` WITH ADMIN OPTION passed). F05 D7 had the same shape.
- **R1-004 [LOW]**: seven mutants survived the builder's suites (X08-X11, X13-X15 in the audit's table).
- **R1-005 [LOW]**: no erratum recorded 005's departures from L18 §5.1, §5.4 and §3.1 / E-23.

### 7.2 Rulings

| # | Decision | Ruling | Reason |
|---|---|---|---|
| R19 | What a search reads (replaces R6's "loads the visible corpus" and R9's corpus-wide judgment and treatment caps) | Each request ranks a **candidate set S** that provably contains every judgment of the whole-corpus top k, with **whole-corpus IDF statistics**: N = `count(*)` of `v_research_judgment` and each query term's document frequency, both read in the request's snapshot. S is ranked by the same function as the in-memory path (`rankResearchCorpus`, which now takes optional `stats`). The answer equals `rankResearchCorpus` over the whole visible corpus, in every mode, or the request fails; it is never an approximation and never truncated. | The brief's design, made exact. A superset of the true top k, ranked with exact scores and whole-corpus statistics, yields exactly the true top k; extra candidates cost time, never correctness. |
| R20 | The term index (006) | `postgres/ddl/006_research_terms.sql`, additive and idempotent: `research_title_term(judgment_id, term)` and `research_citation_term(citation_text, term)` (pre-folded terms, one table per kind of source row, foreign keys ON DELETE CASCADE); `research_size(judgment_id, size)`, each indexed judgment's distinct-term count over its title and its **promoted** citations (R37); `research_title_pending(judgment_id)` and `research_citation_pending(citation_text)`; and one SECURITY DEFINER trigger function `research_terms_mark_pending()` fired AFTER INSERT OR UPDATE OF `case_title` on `judgment`, and AFTER INSERT, DELETE or UPDATE OF `citation_text`, `judgment_id` or `review_status` on `citation` (a new or changed text marks the citation; any of them marks its old and new judgment). Every application marks each judgment without a stored size (on the first, every judgment); the first marks every citation. Two `security_barrier` views for the research role only: `v_research_term(judgment_id, term, size)` (a visible judgment's title terms and the terms of its visible citations, each row with the judgment's size) and `v_research_pending(judgment_id)` (visible judgments whose title or a visible citation is not indexed). The visibility rule is 004's and 005's **copied verbatim** into each branch, not referenced through `v_research_judgment` and `v_authority_citation` (a test holds every copy equal to 004's text), so the planner drives a query from the term rows it matches. `corpus_writer` may SELECT, INSERT and DELETE the term and size rows and SELECT and DELETE the pending rows. Indexes on `citation(judgment_id)` and `citation(source_id)`. The inventory grows to 42 relations and 13 routines. | Terms are stored per source row, not per judgment, because a judgment's document depends on which of its citations are visible, and that changes without any text changing (a later publication, a provenance edit, declassify). Keyed this way a term row is a pure function of a text and never goes stale; visibility is the views' job, as everywhere else. A row whose terms or size could be stale (a superuser, a bulk load, rows that predate 006, a moved, deleted or quarantined citation) is pending by construction, because the trigger fires for every writer: research never trusts a missing index. Referencing the 004/005 views made the planner evaluate every visible judgment and citation first (measured: 941 ms for one broad term at 25,000 judgments); the copied rule lets it start from the index. *Steelman for an anti-join instead of a trigger:* no routine. *Answer:* measured at 25,000 judgments an index-completeness anti-join costs 103 ms per request (about 800 ms at 195,000); the trigger costs nothing per request. |
| R21 | Who writes the terms | The F19 publication (`publish_batch`) indexes the judgments and citations it wrote, in its own transaction, and clears their pending marks. `python -m scraper.publication.cli index-terms` indexes the backlog (rows marked by 006's first application or written outside a publication), in batches, as `corpus_writer`. A text the Python fold cannot reproduce exactly (R22) stays pending. | The brief: the F19 publication path writes it. One transaction keeps a publication and its index atomic. The CLI is the operator's step after applying 006 to an existing corpus (release runbook). |
| R22 | Fold parity between TypeScript and Python | `corpus_service/scraper/publication/research_terms.py` restates `services/d5-1/researchTerms.ts` (the search's own `termsOf`: the citation gate's fold, NFKD, marks and ignorables dropped, every Nd digit to ASCII, markup stripped, hyphenation joined; lowercased; `[\p{L}\p{N}]+` runs; stop words; a lone letter dropped, a lone digit kept; lengths counted in UTF-16 units). It folds only texts whose every code point (input, NFKD output and decoded character reference) lies in a declared **domain** (Latin, Greek, Cyrillic, Arabic and Urdu, Devanagari digits, punctuation, symbols, compatibility forms, mathematical alphanumerics, ignorables and tags), 7,155 code points in 136 ranges, each assigned in both Python's Unicode (15.0) and Node's (17.0) and closed under NFKD and lower-casing; U+0295 (and U+02E4, which decomposes to it) is left out because its `Cased` property differs between the two versions, which changes the final-sigma context; any other text returns None and stays pending, so TypeScript folds it at query time. `tests/fixtures/corpus/research-terms-golden.json` is generated by the TypeScript function only (`npm run corpus:research-terms-golden`; Python never writes it) and pins Python to it two ways: explicit cases (markup, entities, comments, hyphenation, final sigma, digits of several scripts, ligatures, ignorables, surrogates, out-of-domain text) and an exhaustive sweep, one SHA-256 per 256-code-point block over every domain code point in several contexts. | D24's mechanism (a TypeScript-generated golden, Python checked against it), made exhaustive over the domain because the property needed here is equality: a Python term set that differs from TypeScript's would change a document frequency or drop a candidate. Node 22 ships Unicode 17 and the corpus service's Python 3.12 Unicode 15, so equality is only claimable where both agree; outside the domain the row is pending and exactness is kept by folding in TypeScript. |
| R23 | A document's terms | A judgment's terms are the union of its title's terms and each visible citation's terms, each text folded on its own (was: one fold of `title + " " + citations.join(" ")`). Both sources use it. | It is what a per-row index can store. The two definitions differ only when markup or a hyphenated line break crosses from one text into the next (an unterminated `<!--` in a title erased its citations' terms); folding each text alone is also the better reading. Every fixture and every #69 test is unchanged by it. |
| R24 | Keyword candidates | (a) Pending visible judgments (bounded) are loaded whole and folded in TypeScript. (b) R4a: a cited key whose numbers are all query terms is answered by the groups in (c); any other key (a one-digit page, say) asks the index for the indexed judgments holding all its numbers (bounded). Each candidate is loaded and checked by `normaliseCitation` in TypeScript; the cited ones are scored in TypeScript. (c) **One statement** groups the indexed judgments that hold at least one query term (all but the pending and the cited of (b)) by **signature** (the set of query terms they hold, with or without a vector of the live model in blend mode) and returns each group's count and its first k members ordered by (size, id), the ranking's tie-break; a group holding every number of a cited key lists all its members (those are the R4a candidates). Document frequencies are the counts' sums plus the TypeScript-scored judgments' own terms. (d) TypeScript scores each signature exactly as `rankResearchCorpus` would; whole groups fill the k slots in score order and the members of the score that overflows are taken in tie-break order from the groups' lists; only those k are loaded. (e) Every loaded indexed judgment's TypeScript terms are checked against its SQL signature and size, and every group's list against its count: a difference is `inconsistent` (503), never a silently different answer. | Keyword relevance depends only on which query terms a judgment holds, so a query is ranked by groups, not rows: `/research bail` over thousands of bail judgments loads 10. The tie-breaks (cited, fewer distinct terms, id) are reproduced in SQL exactly because the size is the index's. One statement reads the matched rows once and needs no second protocol step; an earlier shape (counts, then a second statement for the k slots' members) read them twice, and measured within noise of this one on the loaded host (§7.4), so the simpler protocol was kept. The check in (e) catches a fold or index drift wherever it reaches an answer. |
| R25 | Vector and blend candidates | Exact, using pgvector's cosine only to bound. One statement computes `embedding <=> q` for every visible vector (the HNSW index is bypassed: a MATERIALIZED scan, never an index ORDER BY), with each judgment's keyword score from its signature, and keeps the vectors whose **upper bound** (cosine + ε) can reach the k-th best **lower bound** (cosine − ε, or an exact no-vector score) less 10⁻⁶; those are loaded with their vectors and scored in TypeScript. ε = 5·10⁻⁴: pgvector 0.6 accumulates the dot product and both norms in float32, so for 1,536 dimensions \|cos_pg − cos\| ≤ 2γ₁₅₃₆/(1−γ₁₅₃₆) + 5·10⁻⁷ ≈ 1.84·10⁻⁴ (γₙ = nu/(1−nu), u = 2⁻²⁴, any summation order, with or without FMA), so ε is 2.7 times the bound. A stored zero vector (NaN distance) counts as cosine 0, as in TypeScript. In blend mode the judgments without a vector are ranked exactly by signature as in R24. | The spec promised exact parity (R6), and this keeps it: a judgment outside S has an upper bound below the lower bound of k judgments inside S, so its rounded score is strictly lower. An approximate ANN (HNSW) cannot give that proof. The scan is linear in visible vectors; no route supplies a query vector yet (P1 has no embedding operation, #69 R3), so its cost is recorded, not hidden (§7.5). |
| R26 | Treatments (replaces R7's loading of every overruling and R9's treatment cap) | After ranking, inside the same REPEATABLE READ transaction, the overrulings and pending overrulings of the top k only (`treated_judgment_id = ANY($1::uuid[])`, k ≤ 50), through the same Module 33 rule. No treatment cap. | The brief. The 2.6 s statement read every overruling in the corpus to answer for ten judgments. |
| R27 | Per-query bounds (replaces R9's corpus-wide caps) | Pending judgments loaded whole ≤ 2,000 (over: `unindexed`, a new reason token); R4a candidates ≤ 2,000, signature groups ≤ 4,096 (every query of up to 11 terms, with and without a vector; a longer query only when more combinations occur in the corpus) and semantic candidates ≤ 1,000 (over: `row_cap`). Each is read as `LIMIT cap + 1`. Over a bound the request answers 503 `corpus_unavailable`; nothing is truncated. A broad term needs no bound: its matches are counted and listed k at a time in SQL, never transferred. | A bound per query: one over-broad query fails for itself only. The pending bound is the one that can fail every query, and only while the index is behind (after applying 006 to a corpus, until `index-terms` runs); its own reason token says so in the log. |
| R28 | Cache (the brief's item 3) | No corpus statistic is cached. N, the document frequencies and the lock's model set are read in each request's snapshot. | The brief keys the cache on `(config.key, last_refresh)`, but `last_refresh` moves only when a publication finishes (003 D30), while `declassify()` and a classification raise change what research may read without a publication. A cached N or df would rank against a corpus that is no longer the one being read (a mutant that caches N by that key is killed by a declassify test, §7.3). After R19-R25 nothing is loaded whole: N is a `count(*)` (12 ms at 25,000), the rest is per query. The per-document fold memo stays (keyed by the text itself). |
| R29 | The corpus lock without reading every vector (R8) | The model set is `SELECT DISTINCT model FROM v_research_embedding` (no vector is read); the dimension is the view column's declared type (`vector(1536)`: pgvector enforces it on every write); only an unconstrained column falls back to the per-row `vector_dims` scan. The lock's meaning is unchanged. | The audit measured the old shapes scan at 245 ms for 20,000 vectors, on every request, keyword ones included. |
| R30 | R1-002: whose error a lock refusal is | In `searchResearch`, a loaded corpus whose `embedding_dim` is not 1536 or whose readable vectors are not all 1536-d under the live model is `CorpusUnavailableError("inconsistent")`: 503, logged, never stored, so the same key retries. The 400 stays for the caller's own vector (`parseResearchEmbedding`: wrong model, wrong length, not finite, zero). The in-memory `searchCorpus` (G-1 test 10) still throws its "search refuses" PublicError. | The corpus's state is not the caller's error; a stored 400 replayed it after the fix. L18 §10 test 10 ("D5-1 refuses to search") holds: a 503 refuses. |
| R31 | R1-003: allowlist scope, in both readers | `writes` and `reads_more` look at every namespace except `pg_catalog`, `information_schema`, `pg_toast*` and other sessions' temp schemas (`pg_is_other_temp_schema`); the readable list matches `c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)`. Any membership held WITH ADMIN OPTION, by the login or a role it is a member of, is refused. The same change in F05 D7 (`functions/src/d4/corpusAuthorityStore.ts`). | The audit's two passing shapes. The two readers keep one rule. |
| R32 | R1-004 | Tests for the seven surviving mutants: BYPASSRLS; SELECT on `v_source_provenance` and on `v_authority_section_version`; sequence USAGE; `last_refresh` 60 minutes ahead (`stale`); `publication_contract = '2'` (`contract_missing`); a judgment with no visible citation (`citation: null`); a `followed` treatment by a larger bench reads VERIFIED. | The audit's cases. |
| R33 | R1-005 | E-52 in `docs/architecture/ERRATUM_SET_2_PROPOSED.md`: 005 withdraws L18 §5.1's literal grant of `v_source_provenance` and `corpus_embeddings` to `corpus_reader`; research reads as `corpus_research_reader`, not `corpus_reader` (§5.4); the transitional corpus DSN in the Next runtime against E-23 and §3.1, retired when D5-1 moves to Functions (delete the Vercel secret then). | The audit's text. |
| R34 | Seam | `ResearchLoadPlan` returns the prepared query and the unit vector with `{ vectors }`; `ResearchCorpus` gains optional `stats` (whole-corpus N and df when `documents` is a candidate set) and `verdicts` may answer a Promise. The Postgres source ranks inside its snapshot, reads the top k's treatments, commits, and returns S with those verdicts; `searchResearch` ranks S with the same function (deterministic, so the same top k). The memory source is unchanged. | The two-phase shape the brief asks for, without a transaction outliving `load`: a caller that never asks for verdicts cannot leak a connection. |
| R35 | Latency budget (revised after the first GREEN run; the original row asked for route median ≤ 400 ms and max ≤ 1,000 ms) | **Reader**: one keyword search through `PgResearchCorpus` at 25,000+ visible judgments, median ≤ 300 ms and max ≤ 1,000 ms (asserted by the scale e2e, against the same Postgres). **Route**: median ≤ 1,000 ms and max ≤ 3,000 ms per `/research` through `POST /api/d2/court-ops` (asserted), with the route's floor (a query that matches nothing) recorded beside it. The statement-level costs are in §7.4. | The finding is the reader's; the route's own work (ID token verification and the Firestore idempotency and audit writes, on the emulators) is not, and on this shared host (load average 9 to 11 on 4 cores during the runs) it alone measured 254 to 488 ms for a query that touches almost nothing in Postgres, so the original route budget tested the host: it failed once on the median (486 ms) and once on the max (1,015 ms) with the reader well inside its own budget. The reader budget leaves 5x headroom under the 5 s statement timeout; the route bound still catches a return of whole-corpus loading. Both runs and their numbers are in the evidence log. |
| R36 | Production status | In-repo: 006, the indexer, the reader, the e2e at 25,000+ through the production route. NOT DEMONSTRATED live: applying 006 and running `index-terms` on the firm's corpus, a production `/research`, and a run at 195,000 judgments on production hardware. | As R17. |
| R37 | The tie-break size (with R20, R24) | A judgment's size is the count of its distinct terms over its title and its visible citations (R23). The index stores it over the title and the **promoted** citations, written with the terms by the same transaction. `v_research_term` carries it: the stored value when every promoted citation of the judgment is visible, else (a promoted citation with no finished publication, no provenance or incomplete provenance, found through indexed lookups of those few rows) the count of the judgment's title terms and visible citations' terms, computed in the view. Every change of a citation's text, judgment or status, and every new or deleted citation, marks its judgments pending (R20), so a stored size is never trusted stale. | Computing sizes from the term rows for a group of 25,000 tied judgments cost 360 ms per query at 25,000 judgments (linear in the corpus); a stored size makes it a lookup. Quarantined citations are routine (a non-canonical citation text is stored quarantined), so the stored value counts promoted citations and the view only computes for the rare promoted-but-invisible case. A test plants both invisible shapes on the smallest bail judgments, whose places depend on their sizes. |
| R38 | Planner settings | The reader's sessions run with `jit = off` (a startup option beside `default_transaction_read_only = on`). | Measured: JIT compilation added about 170 ms to a 60 ms statement on every broad query; a search is a handful of short statements. |

### 7.3 Tests (R1)

- **Scale e2e** `tests/fa-d5-003.scale.e2e.firestore.test.ts`: 25,000+ visible judgments (SQL seed as the superuser, then
  the F19 `index-terms` CLI), through `POST /api/d2/court-ops` with emulator ID tokens and F02 dispatch; each answer equals
  `rankResearchCorpus` over the whole visible corpus (loaded as the superuser) for a broad term, the flagship query, R4a,
  `k = 50` and a miss; the latency budget (R35, reader and route). RED on main: 503 `row_cap`.
- **Parity** `tests/fa-d5-003.parity.pg.test.ts`: on 25,000+ judgments with dense vectors, keyword, vector and blend
  queries through `PgResearchCorpus` equal `rankResearchCorpus` over the whole corpus; after a `declassify()` that changes
  N without a publication; after promoted citations that research cannot see are added to the 20 smallest bail judgments
  (R37); after a citation is deleted, moved and quarantined behind the index's back; and with a cited authority that 60
  judgments outscore on keywords, through both R4a candidate paths (R24b). RED on main: `row_cap`.
- **R1-002** in the FA-D5-003 e2e: a planted vector is 503; deleted, the same key is 200 with `reused: false`; at the seam,
  the memory source and the route answer the same way.
- **R1-003 and R1-004** in `tests/fa-d5-003.corpus-grants.pg.test.ts` and the F05 suite (both shapes for both readers).
- **Views** in `tests/fa-d5-003.corpus-grants.pg.test.ts`: 006's copies of the visibility rule equal 004's text; the views'
  columns, options and grants; the bounds (R27) and the timeout.
- **Fold parity** `tests/research-terms.golden.test.ts` (TypeScript, check mode) and
  `corpus_service/tests/test_research_terms.py` (Python against the golden).
- **Index** `corpus_service/tests/test_research_index_db.py`: a publication writes the terms and sizes of what it publishes
  and clears its marks; `index-terms` indexes the backlog; an out-of-domain text stays pending; a retitled judgment and a
  citation's insert, quarantine, move and delete mark the right judgments; re-applying 006 marks only judgments without a
  size. `corpus_service/tests/test_f19_publication_db.py`: the inventory (42) and routines (13).

### 7.4 Measured values

From the runs in the evidence log (`evidence-fa-d5-003-fu.txt`), on a shared 4-core host whose load average was 8 to 11
throughout (other agents' suites), Postgres 16 + pgvector 0.6 local, Node 22. Every number is from one run unless stated.

- **Corpus.** 25,016 visible judgments (25,000 bulk + the fixture), 37,517 visible citations, 12,500 overrulings and 3,572
  pending overrulings (20,000+ treatment rows), 2,000 vectors (parity) or 200 (scale e2e). `index-terms` indexed 25,000
  titles and 37,500 citations with nothing left pending.
- **RED (main).** Every parity query fails `row_cap` (172/172 keyword, 40/40 vector, 40/40 blend); the scale e2e's answers
  and latency fail (503).
- **Parity (GREEN).** 0 diffs: 172 keyword, 40 vector, 40 blend, 4 + 4 around a `declassify()`, 5 after hidden citations,
  4 after citation writes, 4 with the R4a authority outside the keyword top k (written after mutant M14 survived parity
  alone); `k = 50` equal. In-process per search: keyword median 180 ms, max 471 ms; vector 67 / 113 ms;
  blend 150 / 304 ms.
- **Scale e2e (GREEN), 39 searches per path.** Reader: median 165 ms, p90 462 ms, max 515 ms. Route: median 444 ms, p90
  687 ms, max 855 ms; the route's floor (a query that matches nothing) 277 ms. Two earlier runs against the original R35
  (route-only budget): median 376 / max 1,015 ms (failed the max) and median 486 / max 892 ms (failed the median).
- **Per statement** (scratch profile, 25,016 judgments): role check 2-3 ms, metadata 0.5-0.8 ms, lock 4-6 ms, `count(*)`
  8-13 ms, pending 2-5 ms, documents 3-5 ms, treatments of the top k 3-7 ms, pending overrulings 2-3 ms. The groups
  statement is the one that grows with the query: 18-40 ms for `bail`, 39-65 ms for `bail 497 crpc`, 130-175 ms for
  `section` (held by all 25,009 bulk judgments), 160-320 ms for `2099` (in all 37,517 citations), 260-300 ms for `PLD 2099
  SC 104321` (87,522 matched term rows). The R4a index statement (measured when it served every key; now only a key with a
  number outside the query terms uses it): 56-65 ms.
- **Earlier designs, measured and replaced.** Views referencing 004/005: one broad term 941 ms. Sizes counted from the
  term rows: 360 ms for a 25,000-judgment tie group. A separate size view joined to the group: 114-289 ms (whole view
  computed). JIT: about 170 ms per broad statement (R38).
- **Vectors (scratch database, 25,016 judgments).** The semantic scan alone: 20-51 ms over 2,000 vectors, 259-423 ms over
  25,016 (about 10-17 µs a vector). A vector search through the reader: 63-97 ms at 2,000 vectors, 265-302 ms at 25,016
  (the semantic statement 208-246 ms); a blend search at 25,016 vectors: 346-510 ms. At 195,000 vectors the scan alone
  would be roughly 2-3.3 s on this host, inside the 5 s timeout but not inside R35's reader budget (residual 3).
- **Extrapolation to 195,000 (not run).** The groups statement reads every term row of the query's terms with the
  visibility join, so its cost is linear in those rows: on this host about 3-9 µs a matched term row. A term every
  judgment holds would cost roughly 0.6-1.8 s at 195,000; a query of selective terms reads far fewer rows. NOT
  DEMONSTRATED (R36).

### 7.5 Residuals

1. **Live production** (R36) is NOT DEMONSTRATED: 006 and `index-terms` on the firm's corpus, a production `/research`,
   195,000 judgments, production hardware.
2. **Cost grows with the matched rows.** Keyword cost is linear in the query terms' term rows (§7.4); a query made only
   of terms most judgments hold is the slowest shape. Nothing is approximated or truncated to bound it; the 5 s statement
   timeout is the hard stop (503 `timeout`). A per-term document-frequency table maintained with the index would make
   the statistics O(terms), but visibility changes without any write to the index (R28), so it is not done here.
3. **The semantic scan is linear** in visible vectors (R25): 259-423 ms at 25,016 vectors here, so roughly 2-3.3 s at
   195,000 (§7.4), inside the 5 s timeout but over R35's reader budget. No route supplies a query vector yet (P1 has no
   embedding operation, #69 R3); before one does, an indexed bound (HNSW candidates plus a proof step) is the follow-up.
4. **The pending bound** (R27) fails every query while more than 2,000 visible judgments wait for `index-terms` (after 006
   is first applied, until the runbook step runs).
5. **Out-of-domain text** (R22) is folded at query time; a corpus of mostly out-of-domain titles would reach the pending
   bound. None is expected in a Pakistani corpus (English and Urdu); the domain can grow with the golden.
6. **The latency numbers are from a loaded shared host** (load average 8 to 11 on 4 cores); CI and production will differ
   in both directions. R35 budgets the reader and only bounds the route.
7. **The compose-stack e2e** (`corpus_service/tests/e2e/store_security_e2e.sh`, `probe.py`, `lib.sh`), edited for 006's
   counts and grants, runs in CI's `corpus-compose-policy` job; it was syntax-checked here, not run (it builds the
   compose stack).
8. The semantic error margin ε (R25) survives mutation to 0 on this test data (the 10⁻⁶ slack absorbs the error that
   occurs); it is kept from the analysis, not from a failing test.
9. Residual 6 of §6 (no load cache) is superseded by R28.
