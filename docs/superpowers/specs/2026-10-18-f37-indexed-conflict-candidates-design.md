# F37: indexed conflict candidates (screen reads bounded by the candidates)

Date: 2026-10-18. Base: `origin/main` @ 7364b2b. Branch: `claude/remediate-f37`. Status: approved by the remediation builder under the owner's standing autonomy instruction (brainstorming self-approved and recorded here). The orchestrator's design intent is kept as numbered rulings; where the code forced a refinement, the ruling says what changed and why.

Audit sources:
- `docs/audit/2026-10-13-forensic-audit.md` F37 (HIGH): "Conflict checks materialize the entire firm registry" (`functions/src/d1/conflict/engine.ts:113`, `functions/src/d1/matter/ops.ts:245`).
- `docs/audit/2026-10-14-forensic-audit-v2.md` row F37: OPEN, `engine.ts:113-118 loadRegistry reads every firm client/matter/party/link`.
- `docs/audit/REMEDIATION.md`: closed means a merged PR with an end-to-end test of a real user flow, RED before and GREEN after; ticked only after an independent re-audit. This document claims neither.

Scope (lane): `functions/src/d1/conflict/*`, `functions/src/d1/matter/ops.ts`, the projection writers in `functions/src/d1/*` (`client/ops.ts`, `registryVersion.ts`), `firestore.indexes.json`, `firestore.rules` (one server-only block), and their tests. Lane extension (ruling 10): the P2 job registration points (`functions/src/p2/registry.ts`, `p2/scheduled.ts`, `p2/functions.ts`, `functions/src/index.ts`, the P2 README) and the expectation lists in tests that enumerate job types and exports. Not touched: `app/api/**`, the platform session and persistence files owned by #44/#47, `corpus_service/**`, `.gitleaks.toml`, and `functions/src/d1/entity/autoConfirmJob.ts` (F38's file; it reaches the projection only through `bumpRegistryVersion`, whose signature stays compatible).

## 1. Root cause, traced from the code (main @ 7364b2b)

`loadRegistry(firmId, now)` (`engine.ts:113-118`) runs six reads in parallel: the firm doc, then **every** `clients`, `matters`, opposing `matter_parties`, `entity_links` and `transliteration_map` row of the firm. It builds one `Candidate` per (client, matter) and per opposing party, and `runEngine` screens every subject against every candidate.

Two callers:
- `runConflictCheckOp` (`conflict/ops.ts:115`), once per check;
- `openMatterOp` (`matter/ops.ts:245`), once per re-screen round. A round whose registry version moved is redone (up to 10 rounds), so concurrent registry writes multiply full scans.

Measured on main (RED 1 in the plan ledger): N clients, each with one live matter and one opposing party, through the real routes on the emulator:

| N clients (registry rows) | runConflictCheck reads | openMatter reads |
| --- | --- | --- |
| 500 (1,500) | 1,514 | 1,519 |
| 2,000 (6,000) | 6,014 | 6,019 |

Reads are 3N + ~19: linear in the registry.

## 2. What the screen actually needs (the recall argument)

`screen()` (`match.ts`) produces a hit for (subject, candidate) only if one of these holds (`match.ts:177-189`):

1. **same entity**: the subject is a registered client (`clientId`) and its entity id equals the candidate's `entityId`;
2. **an equal key**: some of `cnic`, `ntn`, `secp`, `phone` is non-empty on the subject and equal on the candidate (this includes the "different CNICs, equal phone" review case, which forces score 1);
3. **a name score of at least 0.80**: `bestRatio(subjectForms, candidateForms) >= 0.80`, or, for a subject that went through the lossy script fallback, the same on consonant skeletons.

A candidate that satisfies none of the three is skipped (`if (score < NAME_THRESHOLD) continue`). Hits are computed per (subject, candidate) independently: no hit depends on another candidate. So a registry restricted to every candidate that satisfies (1), (2) or (3) for some subject yields exactly the hits of the full registry, provided each retained candidate is built from the same rows (its matters, its links, the firm map, the L17.2 flag) and in the same order.

Conditions (1) and (2) are equalities on stored fields: they are deterministic-key queries. Condition (3) is not.

### Why condition (3) cannot be served by token, phonetic or q-gram keys

`tokenSetRatio` is rapidfuzz's `token_set_ratio`. When the two token sets share no token it is the indel similarity of the sorted, joined strings: `2·LCS(a,b)/(|a|+|b|) >= 0.80`. That admits:
- typos with no shared token: `rehmn` / `rehman` (0.909), `qalbanni` / `qalbani` (0.933);
- concatenation: `abdulrehman` / `abdul rehman` (0.957), where no token pair is similar;
- up to a third of one side's characters inserted: `ab` / `axb` (0.80), `abcdef` / `abxcdxefx` (0.80).

Any key every such pair must share is weak:
- **name tokens and phonetic keys** miss the first two classes outright (no shared token; skeletons differ under consonant typos: `rmn` / `rmb`);
- **bigrams** are the longest q-gram the LCS bound guarantees (an insertion breaks q-1 q-grams; at a 1/3 insertion rate no trigram survives), and the guaranteed bigram overlap is about |a|/3. A sound prefix filter must therefore index about two thirds of every name's bigrams, and common bigrams (`an`, `ha`, `ma`, `al`) then retrieve most of a Pakistani-name registry: reads stay linear;
- **deletion neighbourhoods** (SymSpell) are selective but need about |a|/3 deletions per side: C(15,5)+… ≈ 4,900 keys for a 15-character name, C(30,10) ≈ 3·10⁷ for 30.

So no deterministic key both preserves recall at 0.80 and stays selective. Ruling 3 takes the remaining sound option.

## 3. Design rulings

### Ruling 1: three deterministic tiers on the source collections, all firm-scoped

`loadScreeningRegistry(firmId, subjects, subjectEntityIds, now)` (`conflict/candidates.ts`) retrieves:

| Tier | Clients | Opposing `matter_parties` |
| --- | --- | --- |
| entity (cond. 1) | `firmId ==`, `entityId in` the client subjects' entities | `firmId ==`, `role == "opposing"`, `entityId in` … |
| key (cond. 2) | `firmId ==`, `cnic / ntn / secpNumber / primaryMobile in` the subjects' values | `firmId ==`, `role == "opposing"`, `keys.cnic / keys.ntn / keys.secp / keys.phone in` … |
| name (cond. 3) | `firmId ==`, `canonicalName in` the matched names | `firmId ==`, `role == "opposing"`, `name in` the matched names |

then, for the retrieved rows only: every matter of each retrieved client (`firmId ==`, `clientId in`), each retrieved party's matter (`getAll`, kept only when it is the firm's), and every `entity_links` row touching a retrieved candidate's entity (`firmId ==`, `leftId in` / `rightId in`). `in` lists are chunked at 30.

The rows go through `buildRegistry` (`engine.ts`), the exact body of the old `loadRegistry` after its reads, factored out and shared. Rows are sorted by document id before building, which is the order the old full queries returned, so candidates, links and therefore hits come out in the same order. `runEngine`, `tailor`, `screen` and `summarise` are unchanged.

Why these tiers suffice for links: `tailor` uses only links that touch a candidate's entity (its unresolved links; the links between it and the subject's entity), so links touching the retrieved candidates' entities are all it can read.

### Ruling 2: the name tier evaluates the engine's own rule over every indexed name

`nameScore(subjectForms, candidateForms, fallback)` is extracted from `screen()` into `match.ts`, and `screen()` now calls it. The candidate loader computes, for every distinct name in the firm's name index, `nameForms(name, firmMap)` and keeps the names whose `nameScore` against some subject is at least `NAME_THRESHOLD`. Same function, same forms, same firm map: the matched-name set is exactly the set of names that can produce condition (3). The name tier then fetches the rows carrying those exact names.

Recall theorem: if the name index holds the name of every client and opposing party of the firm (ruling 4's invariant), the indexed registry yields the same hits, result, identity basis and classification as the full scan. Proof: section 2 plus rulings 1 and 2. The differential test (ruling 12) checks the implementation of it.

### Ruling 3: the name index is a packed, versioned projection of the firm's distinct names

- **Chunks**: `conflict_name_index/{firmId}_{n}` = `{ firmId, chunk: n, kind: "conflict_name_index", names: string[], classification: "privileged-restricted" }`. Names are appended with `arrayUnion` (deduplicated in the chunk). A chunk is closed at 512 KiB of counted name bytes (UTF-8 length + 1 each; half of Firestore's 1 MiB document limit, and the count is an upper bound because a duplicate adds nothing), so a chunk can never overflow.
- **State**: on the registry counter doc that already versions the screen, `counters/{firmId}_registry.nameIndex = { schema, version, chunk, bytes }`. One read gives the registry version and the index state atomically.
- **Label**: the chunk aggregates names of every classification, so it carries the highest label. It is server-only (ruling 11) and never returned to a caller.
- **Cost**: a screen reads ⌈index bytes / 512 KiB⌉ chunk documents. At ~25 bytes a name that is one read per ~20,000 distinct names: 1 read for both e2e sizes, ~5 for the audit's 100,000-row model. This is the only term that grows with the registry, by one read per ~20,000 distinct names; every other read is a key or a candidate. CPU is one `nameForms` and one `nameScore` per distinct name and subject, the same order as main's per-candidate screen and less than it (names are deduplicated; a client with ten matters is one name, not ten candidates).
- *Steelman against ruling 3.* "This still reads a firm-wide structure on every check; the audit asked for candidate queries." *Answer.* It reads the names alone, packed 20,000 to a read, instead of every client, matter, party and link row (main reads ~3 documents per client). Section 2 shows that a key-only scheme cannot keep recall at 0.80; dropping recall is not acceptable for a conflict screen. If the owner later narrows the name rule (an IDF-weighted or length-aware threshold), a sound q-gram index becomes possible and can replace the chunks behind the same loader (follow-up 1).

### Ruling 4: the index invariant and who maintains it

Invariant (I): when `nameIndex.schema == NAME_INDEX_SCHEMA` and `nameIndex.version == version`, every client `canonicalName` and every opposing `matter_parties.name` of the firm written through `functions/src` is in the chunks.

- `bumpRegistryVersion(tx, firmId, patch?)` (the one choke point every registry writer already calls) now increments `nameIndex.version` together with `version`. A writer that does not maintain the index cannot exist in `functions/src` without breaking the mirror, because only `stageRegistryWrite` adds names, and the version only ever moves with a bump.
- `registerClient` reads the counter doc in its transaction (before its numbering read, since Firestore needs reads first) and stages the client's `canonicalName` with `stageRegistryWrite`.
- `openMatter` stages the opposing subjects' names that its screen did not already find in the index (the version is unchanged inside the transaction, so the index is the one it read).
- A firm whose counter doc does not exist yet has never had a registry write through `functions/src`; its first `registerClient` creates the state with `schema = NAME_INDEX_SCHEMA` (born fresh). Any other first bump (an out-of-band firm) creates `nameIndex.version` without a schema: stale until reconciled.
- Every other registry writer (closeMatter, the entity decisions, un-merge and its jobs, auto-confirm) changes no name; it keeps calling `bumpRegistryVersion`, which keeps the mirror.
- An old function instance during a rolling deploy bumps `version` only: the mirror breaks and the index reads stale (ruling 5), never silently incomplete.
- Test-time guard: the registry write recorder treats a `conflict_name_index` write as a registry write (it must bump), and reports `no_name_index` when a product transaction creates a `clients` or opposing `matter_parties` row without an index-aware bump (one whose `nameIndex` patch carries the chunk pointer, which only `stageRegistryWrite` writes).

### Ruling 5: a missing, stale or unreadable index fails closed, by refusal

The loader refuses (`NameIndexUnavailable`) when the state has no schema (`missing`), another schema (`schema`), `nameIndex.version != version` (`stale`), malformed fields or a malformed or foreign chunk (`corrupt`). `runConflictCheck` and `openMatter` answer **503 `screening_unavailable`**, write no check and open no matter, and enqueue one reconciliation job for the firm (ruling 8; idempotency key per PKT hour, so a burst of refused calls makes one job).

Chosen over a bounded inline full scan because:
- an inline scan puts the O(registry) read back on the request path, which is the failure the finding describes ("concurrent registry mutations force repeated scans"), and a stale index under write load would make every screen pay it;
- a scan bounded by size must pick a cut-off, and above it must refuse anyway, so refusal is needed either way;
- refusal is the codebase's existing fail-closed convention for screening inputs it cannot trust (an unreadable flag reads as the strictest setting; an unreadable label as privileged-restricted).

Cost of the ruling: a firm cannot screen between a deploy and its first reconciliation. Mitigated by the deploy backfill (consumer impact) and the self-enqueued job.

### Ruling 6: the version check at matter opening is unchanged in kind and tied to the index

`openMatter` still re-reads the registry version first in its transaction and redoes the round if it moved (`REGISTRY_MOVED`). The version the round compares is now the one the loader read together with the index state, before any registry row, so the screen, the index it used and the transaction are pinned to one version. A firm-wide version is stricter than validating only the candidate set's keys: any registry write moves it. Candidate-scoped validation would need per-key versions and still could not scope the name tier (any new name may fuzzily match), so it is not adopted; contention stays as on main (`OPEN_SCREEN_ROUNDS`, `registry_contended`).

### Ruling 7: reconciliation is a P2 job, rare and off the request path

`d1.conflict.reindex` (`conflict/reindexJob.ts`) runs `reconcileNameIndex(firmId)`:
1. read the state (version `v0`, mirror `n0`) and the chunks; a damaged index (ruling 13) is reset in one transaction (the firm's chunk documents deleted, `nameIndex` replaced by an unplaced, schema-less state, a bump) and the round starts over on the empty index;
2. scan the firm's client and opposing-party names (paged by document id, `select` of the name field only);
3. append the missing names, each transaction through `stageRegistryWrite` (so it bumps);
4. if the index is not fresh, mark it: in one transaction, require `version - v0 == nameIndex.version - n0` (every write since step 1 maintained the index; otherwise a non-maintaining writer raced the scan and the run starts over, at most 4 rounds, then fails retryably with `reconcile_contended`), then set `nameIndex.schema` and `nameIndex.version = version + 1` with the bump. An index with no name gets an empty chunk 0 when it is marked, so a current index always has its chunks.

A fresh index with nothing missing costs reads only. A run that finds drift (names added out of band) repairs it and its bump makes in-flight openings re-screen. It is idempotent (append-only apart from the reset, state-derived), so the engine's at-least-once delivery and a stale lease holder are harmless; it writes through ordinary transactions, not `runFenced`, because no effect needs exactly-once.

Triggers: daily at 02:35 PKT (`NAME_REINDEX_SPEC`, after auto-confirm at 02:15), on demand when a screen finds the index unavailable (ruling 5), and the deploy backfill through the existing `jobs:backfill` CLI.

### Ruling 8: the transliteration map is still read per check

`transliteration_map` has no writer in `functions/src` and no version. The subject's own forms need it, and caching it in the projection would hide an out-of-band edit until the next reconciliation (a recall change). It is a bounded per-firm dictionary, not registry rows, so it is read per check as before. Residual and follow-up 2.

### Ruling 9: the old full scan stays as the test oracle

`loadRegistry` keeps its reads and its shape (it now calls `buildRegistry`). No production path calls it; it is the oracle of the differential test, and the G-4 gate test `registry discipline: loadRegistry reads exactly the collections in REGISTRY_SCOPE` keeps its meaning. A new test pins the indexed loader's read set.

### Ruling 10: lane extension for the P2 job

Registering a job type and a schedule touches the documented extension points (`p2/registry.ts`, `p2/scheduled.ts`, `p2/functions.ts`, `index.ts`, the P2 README) and the tests that list job types and exports (`p2.engine`, `p2.boot`, `p2.scheduled`, `p5.identity`, and G-2's `NOT_TENANT_ENDPOINTS`). The brief requires the reconciliation on the P2 job engine; these one-line additions are the engine's own procedure for that.

### Ruling 11: rules and indexes

- `firestore.rules`: `match /conflict_name_index/{id} { allow read, write: if false; }`. The catch-all already denied it; the explicit block documents it and puts it in G-2's rules sweep (which derives its collection list from the `match` blocks).
- `firestore.indexes.json`: composite indexes for every new query shape (clients `firmId` + each key field and `canonicalName`; opposing parties `firmId` + `role` + `name`, `entityId` and each `keys.*`; matters `firmId` + `clientId`); `entity_links` (`firmId`, `leftId`/`rightId`) and clients (`firmId`, `entityId`) already exist. `conflict_name_index.names` is exempt from single-field indexing: an array of 20,000 names would otherwise cost 20,000 index entries per write and approach the 40,000-entry document limit.

### Ruling 13: the index is read whole or not at all, and a damaged index is rebuilt (PR #80 review, thread 4306418755)

The first cut defaulted a missing `nameIndex.chunk` or `bytes` to 0 and accepted a missing open chunk when `bytes` read 0. A state with `schema` and a current mirror but no `chunk` then read chunk 0 only, and a conflict held in a later chunk screened CLEAR.

- **State** (`registryStateOf` in `registryVersion.ts`). Every writer of `nameIndex` writes `version` (the bump's mirror increment), and every write that sets `schema` also writes `chunk` and `bytes` (`stageRegistryWrite`). So once the map exists, `version` is required, and `chunk` and `bytes` are required whenever `schema` is set. Without `schema` they come together or not at all: both are absent only on an index never placed (a pre-F37 firm whose non-indexing writers bumped the mirror alone), which has no schema, reads `missing` and is refused anyway. Any other partial or malformed map is `valid: false` and reads `corrupt`. So does a state the placement cannot produce: a pointer at or past the cap, or an open chunk past 0 with no bytes counted (`nameIndexStateCorrupt`).
- **Chunks** (`readIndexedNames`). Every chunk from 0 to `chunk` must exist, carry this firm and its own chunk number, and hold only strings. A closed chunk must hold names, and the open one must hold names exactly when bytes were counted into it. A missing chunk is never read as empty while the index reads current. The one chunk that may be absent is chunk 0 of an index never placed and without a schema, which only the reconciliation reads.
- **A current index always has its chunks.** The reconciliation's mark creates an empty chunk 0 for a firm with no names.
- **Healing.** A damaged index is reset and rebuilt by the reconciliation (ruling 7). The permanent `name_index_corrupt` failure and its operator runbook are gone. The run fails only retryably, so every refusal clears without an operator.
- **Tests.** `functions/test/f37-index-integrity.emu.test.ts`: for a state missing `chunk`, a state missing `bytes`, a missing chunk 0, a missing chunk 0 under a state claiming an empty index, a missing middle chunk, and five malformed chunk bodies, both routes answer 503 and write nothing, and the job, run through the real P2 worker, rebuilds the index so the same calls find the conflict and open the matter. Unit tests pin the strict state parser.

### Ruling 12: tests

- e2e (the real flow): `functions/test/f37-conflict-reads.e2e.emu.test.ts`, registerClient → runConflictCheck → openMatter through the HTTP router with P5 auth, N = 500 and 2,000; reads counted by `functions/test/readCounter.ts`.
- e2e, candidates: the same file adds K = 40 clients the name rule matches (more than one `in` chunk) to firms of N = 500 and 2,000: every candidate hits, the reads K adds are per candidate (client, matter, and the caller's membership read when the hit is disclosed: at most 3K + 3⌈K/30⌉ + 2), and the total is flat in N.
- Differential (recall): `functions/test/f37-conflict-recall.emu.test.ts`, 300 random registries seeded out of band and reconciled, with Roman variants and typos, Urdu-script names (seed table and firm map words), honorifics, shared and differing keys, entities and links in every state, closed and live matters, foreign and unknown matter ids and labels, the L17.2 flag on and off. For each registry and several random subject sets, the indexed screen's `EngineResult` must deep-equal the oracle's. A second part builds registries only through the real writers (no reconciliation) and compares the same way.
- Fail closed: missing, stale (version moved without the mirror), wrong schema and corrupt chunk each answer 503 `screening_unavailable`, enqueue one reindex job, and write nothing; after the job runs the same call succeeds.
- Race: a client whose name fuzzily matches an opposing party (no shared token) registered between the pre-screen and the transaction is caught (`check_stale`).
- Cross-firm: identical names, keys and entity ids in another firm are never read or hit; another firm's chunk cannot be passed off.
- Unit: placement, freshness, the extracted `nameScore` against `screen`.

## 4. Consumer impact

- **API**: `runConflictCheck` and `openMatter` gain 503 `screening_unavailable` (nothing written; retry after the reconciliation). No other response changes; hits, order and classification are as before.
- **Deploy and backfill**: existing firms have no index. After deploy, run `npm --prefix functions run build && npm --prefix functions run jobs:backfill -- d1.conflict.reindex <today> <today>` (PKT day key). It enqueues one reconciliation per firm; until a firm's run completes its screens answer 503 and enqueue the run themselves. New firms need nothing.
- **Data**: new collection `conflict_name_index` (server-only), new `nameIndex` map on `counters/{firmId}_registry`. No existing field changes meaning.
- **Out-of-band writes**: a client or opposing party written outside `functions/src` (seed scripts, console edits) reaches the name tier only after the next reconciliation (daily). Key and entity tiers see it immediately.

## 5. Residual risks

1. Out-of-band registry writes are invisible to the name tier until the daily reconciliation (section 4). The firm-wide counter cannot detect writes that do not bump it.
2. The chunk reads grow by one per ~20,000 distinct names (ruling 3). CPU per check stays O(distinct names × subjects).
3. A common-token subject ("Muhammad Ali") legitimately matches thousands of names under the 0.80 token-set rule (a short remainder scores 0.80 against any name sharing the long token); the candidate reads then grow with those true matches. That is the rule's cost, not the retrieval's.
4. Conservative byte counting can close chunks early (each `registerClient` counts its name even when present); worst case one extra chunk read per 512 KiB of repeated names. No compaction yet.
5. A firm cannot screen between deploy and its first reconciliation (ruling 5).
6. A damaged index (out-of-band edit) refuses screening until the reindex run the refusal enqueued rebuilds it (ruling 13). A name removed from inside a chunk, with the chunk otherwise well formed, cannot be detected without per-name checksums; the daily reconciliation re-adds it (it rescans every name), and until then that name is invisible to the name tier.
7. Test cost: the recall differential runs ~10 minutes on the shared development machine at low load (22 minutes at load ~23); from per-file timing ratios against CI it should add about 6 to 9 minutes to the CI functions job (about 10 minutes today, 30-minute limit). It deletes the ~300 to 390 `firms` docs it creates when it ends, because the P2 scheduled-tick suites are O(firms) in the shared emulator.

## 6. Follow-ups

1. If the name rule is narrowed (IDF or length-aware threshold), replace the chunks with a sound q-gram index behind `loadScreeningRegistry`.
2. A `transliteration_map` writer API that bumps the registry version, so the map can be cached in the projection.
3. Chunk compaction in the reconciliation when counted bytes exceed twice the real size.
4. An alert on repeated `screening_unavailable` for one firm.
