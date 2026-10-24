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
| R16 | `pg` at runtime | `pg` is already a root dependency (devDependencies); the Next runtime now imports it, lazily, only when the Postgres source is selected. It moves to `dependencies` only if the lockfile can be regenerated by npm without unrelated churn; otherwise it stays and this is recorded. | The common brief forbids hand-editing lockfiles. Next's build installs and traces devDependencies, so the runtime resolves it either way. |
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
