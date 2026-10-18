# FA-D5-001, FA-D5-002, FA-D2WA-001: research search that reads the query (design)

**Findings** (`docs/audit/2026-10-14-forensic-audit-v2.md:132-133`, score rows 11 and 19):
- **FA-D5-001 (HIGH).** `services/d5-1/research.ts:4-25`: a query-less, unranked, unbounded "search". `searchCorpus(store, queryModel)` takes no query text or vector and returns every embedding row's `entityId` for the model, with no ranking and no limit.
- **FA-D5-002 (LOW).** `services/d5-1/research.ts:28-30`. At the audited commit 0f72cd8, and still at 04d388f, those lines are `changeEmbeddingModel`, which sets `corpus_metadata.embedding_model` to any string at once. It asks for no confirmation and has no re-embed guard: with embeddings on the corpus, one call makes every search refuse, under the old model and the new.
- **FA-D2WA-001 (HIGH).** `services/d2-1/whatsapp.ts:50-53`. After the P5 check, `/research <query>` always returns the constant `research: []` and ignores the query.

**Rule for closure** (`docs/audit/REMEDIATION.md`): a merged PR with an end-to-end test of a real user flow that fails on main and passes after, then an independent re-audit.

## 1. What main does (observed at 04d388f)

A throwaway probe on main, recorded in the evidence log and never committed, used 60 synthetic judgments: 3 about bail under s. 497 CrPC and 57 about khula, each with a 1536-d vector. It showed:
- `searchCorpus(store, "text-embedding-3-small")` returns all 60 entity ids in insertion order, with no score. There is no way to pass a query.
- WhatsApp `/research bail 497 CrPC` returns `{"ok":true,"research":[]}`.
- `changeEmbeddingModel(store, "text-embedding-3-large")`, with the 60 embeddings present and no confirmation, switches the live model. From then on every search refuses, under either model.

**Callers.**
- The only route is `app/api/d2/court-ops/route.ts:224`, `action: "whatsapp_command"`. It calls `handleWhatsApp`.
  - A thrown `PublicError` becomes a 400 carrying its message (`:337-339`).
  - `!result.ok` becomes a 403.
- `searchCorpus`, `changeEmbeddingModel` and `reembedCorpus` have no route caller. Only `tests/gate_g1.test.ts` (G1-10) and `tests/spine.hardening.test.ts` call them.
- No UI reads `result.research`.
- `functions/src` imports neither module.

## 2. Rulings

Each ruling records the decision and the reason (owner's standing instruction).

**R1. Research search is D5-1 case-law search (Module 18 `search`) over the in-app corpus read model.**
- The read model is `store.judgments`, `store.embeddings` and `store.treatments`. It is the same model the Next-side citation gate (`verifyCitations`) reads.
- The candidates are judgments. An embedding row whose entity is not a judgment is not a hit: there is no authority to show and none for the gate to verify.

*Reason:*
- The finding names this function.
- No other TypeScript search exists. The Functions `AuthorityStore` port has lookups only (`findJudgment`, `listTreatments`, `getSectionAsAt`). The corpus_service `/search` router is F24's, and is off limits to this change.
- `searchStatutes` is a separate spec function. It is not part of this finding.

**R2. `searchCorpus(store, query)` takes a validated query and returns the top k hits with scores.**
- The query is `{ text?: string; embedding?: { model: string; vector: number[] }; k?: number }`. It needs `text`, `embedding`, or both.
- The result is `{ items, k, mode }`. `mode` is `"keyword"`, `"semantic"` or `"blended"`.
- Each item is `{ entityId, title, citation, benchType, score, treatment }`.

*Reason:* this is the first of the brief's two shapes. It makes the existing embeddings and their model lock mean something, rather than deleting them.

**R3. No query embedding is computed in this flow, so WhatsApp research runs the keyword leg.**
- `grep -ril embed platform/p1 functions/src/p1` finds nothing. The P1 gateway has no embedding operation.
- Adding one is a new P1 capability: an embedding call with budget, kill switch, F16 roles and Opik tracing. The fix-first freeze rules it out.
- So `/research <query>` searches by text.
- `searchCorpus` still accepts a caller-supplied query vector for the semantic leg. It ranks by cosine over the stored 1536-d vectors, and the vector is checked for model and dimension. No in-app caller supplies one today (residual 2).

*Reason:* the brief allows the text path when the embedding path cannot go through P1, provided the reason is written down. This is that record.

**R4. Ranking.**
- **Folding.** Text is folded with the citation folder's `normaliseDraftText`:
  - NFKD, with marks dropped;
  - every Unicode decimal digit mapped to ASCII, so Urdu (Extended Arabic-Indic) and fullwidth digits match ASCII ones, the F15 lesson;
  - markup stripped.
  The result is then lowercased and split into `\p{L}\p{N}` runs.
- **What is dropped.** Single-letter tokens (the "s" of "s. 302") and a short English stop list (a, an, and, are, as, at, be, by, for, in, is, of, on, or, the, to, v, vs, versus, was, with) are dropped. Numbers of any length are kept.
- **Keyword score.** This is the IDF-weighted share of the query's distinct terms that occur in the judgment's title or citation:
  - `idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))`, the BM25 idf;
  - the score is in [0, 1];
  - a term absent from the corpus still counts in the denominator.
- **Semantic score.** `max(0, cosine(query, stored))`. A stored zero vector scores 0.
- **Blended.** When the query has both legs, the score is `0.6 * semantic + 0.4 * keyword` (Module 18: "60% semantic and 40% keyword"). Otherwise it is the one leg.
- **Hits.** Only a score above 0 is a hit. Hits are ordered by score (descending), then by fewer distinct document tokens (the more specific authority), then by `entityId`, so the order is deterministic. Scores are reported to 6 decimals.

*Reason:*
- The score is bounded, so the 60/40 blend is well defined without per-query renormalisation.
- IDF stops a common word ("state", "petition") from outranking the distinctive term.
- An exact citation query ("2099 SCMR 101") covers every one of its terms in that judgment's citation, so it scores 1.

**R5. Bounds. A bad value is refused with a `PublicError` (a clean 400 at any route), never clamped.**
- `k`: a safe integer from 1 to 50 (`RESEARCH_MAX_K`). The default is 10 (`RESEARCH_DEFAULT_K`). A non-number, 0, a negative, a fraction, NaN, or 10^9 is refused.
- `text`: a string of at most 500 characters (`RESEARCH_QUERY_MAX_CHARS`), counted in Unicode code points after trimming and collapsing whitespace, and before folding, so an over-long input is refused before any folding work. It must leave at least one search term after R4. An empty text, or one that is only punctuation or stop words, is refused as "no search terms".
- `embedding.vector`: an array of exactly 1536 finite numbers, the dimension the corpus metadata declares, with a non-zero norm.
- `embedding.model`: it must equal the live `corpus_metadata.embedding_model`.
- A query that is not an object, or that has neither leg, is refused.

*Reason:* the brief's hostile inputs (an empty query, an over-long query, k=0, k=10^9, a wrong model, a wrong dimension) get clean 4xx. Clamping k=10^9 to 50 would hide a caller bug. Truncating a long query would silently change the question.

The refusal messages are fixed strings that never echo the query, so nothing the caller sent is reflected in an error.

**R6. The corpus integrity lock (G1-10) is kept and covers both legs.** Search refuses when any of these holds:
- `corpus_metadata.embedding_dim` is not 1536;
- any stored row is under a model other than the live one (`embedding_model mismatch`);
- any stored row is not 1536 long (`embedding_dim mismatch`, which was `embedding_model mismatch` on main; tests match `/refuses/`).

The semantic leg also refuses a stored vector with a non-finite element.

*Reason:* G1-10 says that when the model changes while embeddings exist, D5-1 refuses to search. A corpus caught mid-migration is not trustworthy for the keyword leg either. The finiteness check runs only when vectors are actually scored, so a text query does not pay for it.

**R7. Permission stays where the spec puts it: D2-1 checks P5 `research` before it reads the query or the corpus** (L19.10: "/research <text> → D2-1 WhatsApp: P5.checkPermission then D5-1"; R-1).
- A denied caller gets 403 whatever its query, valid or hostile, so validation reveals nothing to a caller who may not search.
- `searchCorpus` is the corpus read itself, with no actor, as `verifyCitations` is. The not-yet-built `/api/d5/research` web route must make its own `research` check (follow-up 3).

**R8. Results carry treatment.** Each hit's `treatment` is the Module 33 verdict (VERIFIED, UNVERIFIED or OVERRULED) from `verifyCitations` over the same store.

*Reason:* Module 18 lists "overrule/treatment awareness surfaced with results" among the search's features. A research tool that returns an overruled authority with no flag is wrong, not merely incomplete. The verdict reuses the gate's one rule, so it cannot drift from the gate.

**R9. The WhatsApp reply is a numbered list** (L18 §8: "returns a numbered list"):
- `research: [{ n, entityId, title, citation, treatment, score }]`, with `n` from 1 to k.
- `k` is the default 10, the /matters page size.
- The query is the text after the verb, taken through the grammar table. The `/research` row's pattern now captures the argument, and `whatsAppCommandArgument(text)` returns it, so the handler holds no command literal (G-2 surface guard).
- Grammar acceptance is unchanged: `.+` became `([\s\S]+)`. A multi-line query is searched whole, not cut at the first newline.
- `open N` stays in G-2's `NOT_BUILT`.

**R10. Cross-firm isolation.**
- The search reads only judgments, embeddings and treatments. These rows carry no firm, and the read model holds published law.
- It never reads matters, documents, clients or users.
- So a firm-B caller who types a firm-A matter title gets corpus hits only, and the leak check (every firm-A identifier in the store) finds none.
- Identity and firm spoofs are refused by `withSession`, as for every command (`FIRM_MISMATCH`, `IDENTITY_MISMATCH`).

**R11. F15 masking and F17 grounding do not apply here, and the record says why.**
- F15 masks text sent to an AI provider through P1. This flow makes no provider call and sends nothing to an external corpus. The query stays in-process, and the results are corpus rows.
- F17 grounds generated text against the authority store. This flow generates nothing: every hit is a row that exists in the corpus.
- When the query goes out (L19.5 extraction through P1, or a remote corpus), it must be masked by P1 first (L19.0.1 ruling 5). That belongs to the follow-up that adds the query embedding (follow-up 1).

**R12. FA-D5-002: the model switch is guarded.** `changeEmbeddingModel(store, nextModel, { confirmed })`:
- refuses unless `confirmed === true` (confirmation);
- refuses a model id that is not 1 to 100 characters of `[A-Za-z0-9._:/-]`, or that equals the live model;
- refuses when the switch would leave any stored vector under a model other than `nextModel` (the re-embed guard). The live model can never move away from the vectors, so search never goes dark because of an in-app call. A corpus whose vectors are all already under `nextModel` (re-embedded by the corpus side) may switch, and that switch restores search.

It returns `{ previous, model }`. Refusals are `PublicError` messages starting `embedding model change refuses:`.

*Reason:* the finding is the absence of confirmation and of a re-embed guard. The guard reuses R6's rule, so "may switch" and "may search" cannot drift apart.

- `reembedCorpus` is unchanged. Its confirmed branch still relabels rows rather than recomputing them (residual 4, and already recorded in `CORRECTION_LOG.md:224`).
- G1-10 now simulates the out-of-band change the spec describes. `corpus_metadata` lives in the corpus database (Annex A) and changes there, so the test sets the metadata directly, and also asserts that the in-app switch refuses.

**R13. No authorisation is added to `changeEmbeddingModel`.**
- It has no route caller (grep), so no user can reach it.
- Adding a P5 action means changing the shared decision table (`platform/p5/permissionDecision.ts`, evaluated by both runtimes) for a function nobody calls.
- The operator route that eventually calls it must check a partner-only action (follow-up 3).

*Reason:* the fix-first freeze; the finding names confirmation and the re-embed guard, not authorisation.

## 3. Consumer impact of the changed signatures

| Symbol | Main | After | Consumers |
|---|---|---|---|
| `searchCorpus` | `(store, queryModel: string) → { items: { entityId }[] }` | `(store, query: ResearchQuery) → { items: ResearchHit[]; k; mode }` | G1-10 and `spine.hardening` (updated); D2-1 handler (new caller). No route or UI. |
| `changeEmbeddingModel` | `(store, nextModel)`, returns nothing | `(store, nextModel, { confirmed }) → { previous, model }`, throws `PublicError` on refusal | G1-10 (updated). No route. |
| `WhatsAppResult.research` | `string[]`, always `[]` | `WhatsAppResearchItem[]` | Court-ops route (passes it through as JSON). No UI reads it. |
| `/research` grammar row | `/^\/research\s+.+/i` | `/^\/research\s+([\s\S]+)/i` | Same acceptance (the `d2-1.whatsapp-commands` table tests are unchanged). |
| New exports | — | `whatsAppCommandArgument`, `RESEARCH_DEFAULT_K`, `RESEARCH_MAX_K`, `RESEARCH_QUERY_MAX_CHARS`, `EMBEDDING_DIM`, `ResearchQuery`, `ResearchHit` | — |

The court-ops route file is not edited: `app/api/**` is off limits, and it needs no change. `/research` now answers 400 where the query or the corpus is refused (R5, R6). Before, the route never reached search.

## 4. Tests

**E2E, the real user path: `tests/fa-d5.research-search.e2e.test.ts`.**
- The test sends `POST /api/d2/court-ops` `{ action: "whatsapp_command", command }` through the real route handler.
- `withSession` runs in Firebase mode. Bearer tokens go through a mocked `verifyIdToken`, the G-2 harness, so P5 `checkPermission` sees the real users of two firms.
- The corpus is synthetic: 2099 citations, with more relevant judgments than k.

What the file proves:
- **(a) RED on main.** `/research bail 497 CrPC` returns `research: []` although the corpus holds matching judgments. Main's "search" ignores the query: probe in the evidence log.
- **(b) After the fix:**
  - the hits are relevant (every one contains a query term, and no khula judgment appears);
  - they are ranked (scores non-increasing, the judgment matching all terms first);
  - they are capped at 10 (13 relevant judgments exist);
  - each carries its treatment;
  - an exact citation query ranks that judgment first;
  - an Urdu-digit query finds the ASCII citation;
  - a `permission_check allow:research` audit row is written for the request.
- **(c) Denied roles.** A client and an intern of either firm, and the accounts role, get 403, with a valid query and with a hostile one.
- **(d) Cross-firm.**
  - A firm-B partner who types firm A's unique matter title term gets 200 with corpus hits only. No firm-A identifier from the store appears, beyond what the caller itself sent.
  - Hit objects have exactly the corpus fields.
  - An `X-Firm-Id` of firm A is refused with `FIRM_MISMATCH`, and a body `actorId` of partner_a with `IDENTITY_MISMATCH`.
- **(e) Hostile inputs through the route.**
  - `/research` alone, and `/research` plus spaces, fail the grammar: 400.
  - `/research ...;;` and `/research the of v` have no search terms: 400.
  - A 501-character query is over the limit: 400.
  - A corpus whose metadata model changed while embeddings exist (wrong model): 400 `embedding_model mismatch`.
  - A corpus row 3 long (wrong dimension): 400 `embedding_dim mismatch`.
  - No 5xx anywhere.
- **FA-D5-002 through the user path.** An unconfirmed in-app model switch, attempted while embeddings exist, is refused, and `/research` keeps answering 200 with the same hits. On main the switch succeeds silently.

**Service: `tests/fa-d5.research-search.test.ts`.**
- **k:** absent → 10; 1 and 50 accepted; 0, -1, 2.5, NaN, Infinity, 51, 10^9 and "10" refused.
- **Text:** empty, whitespace, stop words only, 501 characters, and a non-string, all refused.
- **Embedding:** a wrong model, dimensions 3, 1535 and 1537, NaN or Infinity entries, a zero vector, and a non-array, all refused. A non-object query, or one with neither leg, refused.
- **Cosine ranking:** k nearest, in order.
- **60/40 blend:** a judgment strong on both legs outranks one strong on only one.
- **Determinism:** ties are broken by specificity, then id.
- **Treatment:** OVERRULED surfaced.
- Every refusal is a `PublicError` that does not echo the query.

**FA-D5-002 unit, in the same file.** An unconfirmed switch is refused. A confirmed switch with old-model vectors present is refused, the model is unchanged, and search still works. Invalid and unchanged model ids are refused. A confirmed switch on an empty corpus succeeds. A confirmed switch after the corpus side re-embedded the vectors succeeds and restores search.

**Changed expectations** (listed in the PR):
- `tests/gate_g1.test.ts` G1-10:
  - the out-of-band change is simulated by setting `corpus_metadata` directly, and the test also asserts the in-app switch now refuses;
  - the seed is a judgment with a non-zero vector, because search ranks judgments and a zero vector scores 0;
  - the final search passes a vector query and asserts the one hit.
- `tests/spine.hardening.test.ts`: the 3-float row test calls the new signature. It still expects `/refuses/`.
- `tests/g2/paths.ts`: the `/research` path note, and the `NOT_BUILT` D5-1 note, describe the routed search. These are notes only; no attack changes.

## 5. Residuals and follow-ups

1. **No query embedding in the real flow (R3).**
   - WhatsApp research is keyword-ranked.
   - **Follow-up:** add a P1 embedding operation (budget reservation, kill switch, F16 roles, Opik, the masking of L19.0.1 ruling 5) and pass its vector as `embedding`. The blend then applies unchanged.
2. **The semantic leg has no in-app producer.** It is exercised by service tests only, until follow-up 1.
3. **No D5 web route and no operator route.**
   - `/api/d5/research/*` is still `NOT_BUILT`. It must check P5 `research` itself (R7).
   - An operator route for `changeEmbeddingModel` needs a partner-only P5 action (R13).
   - Both are under `app/api/**`, which is off limits here; they wait on PRs #44 and #47.
4. **`reembedCorpus` relabels instead of recomputing.** This is pre-existing and disclosed in `CORRECTION_LOG.md:224`. A real re-embed needs follow-up 1.
5. **The Next runtime's corpus read model is empty in production.** Nothing loads `store.judgments` or `store.embeddings` outside tests: no D3-3 connector into the Next runtime. The Next citation gate has the same F05 shape.
   - So production `/research` answers an empty list until the corpus is wired, but now as a function of the query and the corpus, which the E2E proves.
   - **Follow-up:** route D5-1 search to the promoted Annex A corpus. Postgres would use `ORDER BY embedding <=> $1 LIMIT k` over the HNSW index, plus a keyword leg, reading only the promoted views, which closes FA-DATA-003's unfiltered `corpus_embeddings` grant for this reader.
6. **No row classification in the in-memory model.** `Judgment` has no classification, while Annex A judgments and embeddings carry `classification_rank`. The loader in follow-up 5 must carry it, and search must filter by it.
7. **Linear scan.** Search is O(corpus × terms), plus O(corpus × 1536) for the semantic leg, per query, over the in-memory model. That is acceptable at test scale; production scale belongs to the Postgres HNSW path in follow-up 5.
8. **FA-D2WA-002 (only 3 of 8 commands) stays open.** `open N` and the other commands are not added.
