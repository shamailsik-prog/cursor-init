# Phase 2b-A Entity Review Queue and confirmMerge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloud Functions routes under `/api/d1/entity/*` that list candidate entity links for human review, confirm a pair (`confirmMerge`, an immutable `merge_events` row, `entity.confirmed`), dispute it (stops the 30-day auto-confirm) or reject it (partner), read an entity and its aliases; the conflict engine honours the decisions; open item O-27 closed.

**Architecture:** Pure link-state logic (`functions/src/d1/entity/linkState.ts`) under unit tests and used by the conflict engine; Firestore-backed operations in the existing `FirmOperation` shape (`functions/src/p5/common.ts`) registered in `functions/src/http/router.ts`; permissions through the shared decision table `platform/p5/permissionDecision.ts`; tightened Firestore rules for `merge_events` and `entity_aliases`; a G-4 phase-close script for 2b-A.

**Tech Stack:** TypeScript, firebase-functions v6 (asia-south1), firebase-admin, Firestore emulator, vitest 3, `@firebase/rules-unit-testing`, pytest (gate checker only).

**Spec:** `docs/superpowers/specs/2026-10-08-phase2b-entity-review-design.md` (rulings P2-23..P2-41). Phase 2a spec and plan for the conventions this plan reuses. Architecture: `docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt` (L17.2 L6921-6964; L18 §7 L8398-8414; events L8193-8194).

## Global Constraints

- Routes: `/api/d1/entity/{function}`, Bearer + `X-Firm-Id`; firm never from the body; every POST carries `Idempotency-Key` (router). Rate kind `general` for all six.
- **Every new route needs, in the same task that adds it: a `viaApi("<name>")` test under `functions/test/` (route coverage counts only `viaApi` calls), a G-2 `PROBES` entry in `functions/test/g2.cross-firm.test.ts`, and its module in that file's `HANDLER_MODULES` (the G-2 suite asserts `ROUTES` names equal `PROBES` keys and that each route's handler is `<name>Op` of a listed module, so a route without both fails G-2).** Task 3 seeds the firm-A entity and link the probes aim at; Task 7 adds them to the unchanged-state snapshot and the positive control.
- List GETs: `limit` default 20, max 100; opaque `cursor` via `functions/src/d1/pagination.ts`; response `{ items, nextCursor }`. `listAliases` is the one exception: `{ items, nextCursor: null }`, at most 200 items (P2-32).
- Exactly one `audit_log` row per call through `CallAudit` (`audit.stage(tx, "allow", "ok")` inside the decision transaction, `audit.committed()` after; `audit.allow()` for reads). Every Firestore write carries `firmId` and `classification`.
- Errors: `{ error: { code } }` via `HttpError(status, code)`; codes exactly as spec §6.
- Constants: `LINK_AUTO_CONFIRM_MS = 30 * 24 * 60 * 60 * 1000` (existing, moves to `linkState.ts` and is re-exported from `engine.ts`); `DETERMINISTIC_KEY_SCORE = 0.99`; `MIN_ENTITY_NOTE = 20` (chars after trim); `MAX_ALIASES = 200`.
- A link or entity that is missing, in another firm, or above the caller's clearance → 404 `not_found` (never 403; P2-34). All six routes → 404 `feature_disabled` when `L17_2_ENABLED` is off for the firm (`l17_2Enabled` in `engine.ts`), checked after the permission check.
- No re-pointing of any reference, no deletion of any entity, client or link (P2-24). No `unmergeEntity`, no P2 jobs, no probabilistic scoring (P2-23).
- No new npm dependencies. No P1 / provider calls. Do not touch the Next.js `app/api/d1/*` routes or `platform/persistence/*`.
- Never relax an existing assertion to get green; Task 1 Step 0 is the only rewrite of existing tests and it keeps every asserted severity (spec P2-41).
- Commit messages end with the two attribution lines the session uses (`Co-Authored-By: …`, `Claude-Session: …`).

### Data shapes (Firestore; all docs carry `firmId`, `classification`)

```ts
// entity_links/{firmId}_{a}_{b}_{key}  (a < b; existing, Phase 2a)  — fields added by 2b-A are set once, never cleared
{ firmId, leftId: a, rightId: b, key: "cnic"|"ntn"|"secp"|"phone",
  state: "candidate" | "confirmed" | "rejected", disputed: boolean, classification, createdAt,
  dispute?:      { by: uid, role: "partner"|"associate", at: Timestamp, note: string },
  confirmation?: { by: uid, role: "partner"|"associate", at: Timestamp, note: string, mergeEventId: string },
  rejection?:    { by: uid, role: "partner", at: Timestamp, note: string } }

// merge_events/{auto id}  (immutable; written only by confirmMerge)
{ firmId, kind: "link_confirmed", leftId: a, rightId: b, pairId: `${a}_${b}`, linkIds: string[] (sorted),
  keys: Array<"cnic"|"ntn"|"secp"|"phone"> (sorted), evidence: { note: string, keyValues: Partial<Record<key, string>> },
  score: 0.99, basis: "deterministic_key", priorState: "candidate" | "auto_confirmed" | "disputed",
  actorId: uid, actorRole: "partner"|"associate", confirmedAt: Timestamp, createdAt: Timestamp,
  snapshot: { left: EntitySnap, right: EntitySnap }, reverted: false, classification }
type EntitySnap = { entityId: string; canonicalName: string; cnic?: string; ntn?: string; secpNumber?: string; phone?: string; classification: string }

// events/{firmId}_{a}_{b}_candidate   { name: "entity.candidate", firmId, payload: { entityIds: [a, b], mergeEventId: null, score: 0.99 },
//                                        classification, occurredAt, idempotencyKey: `${firmId}_${a}_${b}:candidate` }
// events/{mergeEventId}_confirmed     { name: "entity.confirmed", firmId, payload: { entityIds: [a, b], mergeEventId, score: 0.99 },
//                                        classification, occurredAt, idempotencyKey: `${mergeEventId}:confirmed` }
// entity_aliases/{id}  (existing collection, read-only here) { firmId, entityId, kind: string, value: string, classification, sourceDocId? }
```

```ts
type EffectiveLinkState = "candidate" | "auto_confirmed" | "disputed" | "confirmed" | "rejected"
type EntitySummary = { entityId: string; canonicalName: string; clientId: string | null; clientCode: string | null;
                       keys: { cnic?: string; ntn?: string; secp?: string; phone?: string } }
type QueueItem = { pairId: string; linkIds: string[]; keys: string[]; effectiveState: "candidate" | "disputed";
                   createdAt: string; autoConfirmAt: string | null; classification: string;
                   dispute?: { by: string; at: string; note: string }; left: EntitySummary; right: EntitySummary }
type EntityLinkView = { pairId: string; linkIds: string[]; otherEntityId: string; otherCanonicalName: string; keys: string[];
                        effectiveState: EffectiveLinkState; autoConfirmAt: string | null; mergeEventId: string | null }
type EntityView = EntitySummary & { classification: string; createdAt: string; links: EntityLinkView[] }
type Alias = { kind: "name" | "cnic" | "ntn" | "secp" | "phone" | string; value: string;
               source: "entity" | "client" | "alias" | "confirmed_link"; entityId: string }
type DecisionResult = { pairId: string; linkIds: string[]; state: "confirmed" | "rejected" | "candidate"; disputed: boolean;
                        mergeEventId: string | null; classification: string }
```

## Review Focus

1. Two parallel `confirmMerge` calls on the same pair (different `linkId`s of it): exactly one 200 and one 409 `link_not_candidate`; exactly one `merge_events` row and one `entity.confirmed` event. Pinned in Task 4.
2. A link created exactly 30 days ago (to the millisecond) is `auto_confirmed` and absent from the `pending` queue; at 30 days minus 1 ms it is `candidate` and present with `autoConfirmAt` = createdAt + 30 d. Pinned in Task 1 and Task 3.
3. An associate's `confirmMerge` on a disputed pair → 403 `role_not_permitted` and the pair unchanged; a partner's succeeds with `priorState: "disputed"`. Pinned in Task 4.
4. Confirming a pair turns a stored `different_person` resolution on that pair's role-crossing hit into 409 `check_stale` at `openMatter`; disputing or rejecting a pair that was a candidate when the check ran never makes a cleared check stale. A late dispute of a pair aged 30 days or more (auto-confirmed) does: the reopened same-role hit is a fresh review, so `openMatter` answers 409 `check_stale` (final review ruling, minor 2). Pinned in Task 5 and in the final-review fix test.
5. An `internal`-cleared associate never sees, confirms or learns the existence of a pair whose label is `confidential` (queue omits it; getEntity omits the link; decisions → 404 `not_found`). Pinned in Task 3 and Task 4.

---

### Task 1: Link state model, engine reading of rejected links, O-27, and the three stale 2a cases

**Files:**
- Create: `functions/src/d1/entity/linkState.ts`
- Modify: `functions/src/d1/conflict/engine.ts` (`linkConfirmed` delegates to `effectiveLinkState`; `loadRegistry` skips rejected rows when enabled; O-27 label)
- Modify: `functions/test/d1.conflict.emu.test.ts` (Step 0 rewrite of three cases; new O-27 and rejected-link cases)
- Test: `functions/test/d1.linkState.test.ts`

**Interfaces:**
- Produces: `effectiveLinkState(row: DocumentData, nowMs: number, l17_2Enabled: boolean): EffectiveLinkState` — flag off → `"candidate"` for every row; `state "confirmed"` → `confirmed`; `state "rejected"` → `rejected`; `state "candidate"` with `disputed === true` → `disputed`; `state "candidate"`, `disputed === false`, `createdAt` a Timestamp with `createdAt.toMillis() <= nowMs - LINK_AUTO_CONFIRM_MS` → `auto_confirmed`; anything else (missing createdAt, `disputed` not boolean, unknown state) → `candidate`. `isConfirmedState(s)` = `s === "confirmed" || s === "auto_confirmed"`. `autoConfirmAt(row): Date | null` (createdAt + 30 d for an undisputed candidate, else null). `pairIdOf(row): string` = `${leftId}_${rightId}`. `LINK_AUTO_CONFIRM_MS`, `DETERMINISTIC_KEY_SCORE = 0.99`.
- engine.ts: `linkConfirmed(row, nowMs, enabled)` = `isConfirmedState(effectiveLinkState(row, nowMs, enabled))` (signature unchanged). In `loadRegistry`, a row whose effective state is `rejected` is not pushed to `links` (so it is neither relied on nor unresolved). Party candidates: `matterClassification: matter ? maxLabel(matter.classification, p.classification) : maxLabel(p.matterClassification, p.classification)` (O-27). `maxLabel` reads an absent or unknown label as `privileged-restricted`, so a legacy party row without `classification` fails closed (2a writes it on every row).

- [ ] **Step 0: Correct the three 2a cases (spec P2-41).** Run `npm --prefix functions run test:emu -- d1.conflict.emu`. At design time (2026-10-08) the three cases named in spec §8 failed on `main`, and an uncommitted correction to `functions/test/d1.conflict.emu.test.ts` was already in the working tree (it re-asserts the unnamed subject as POSSIBLE_CANDIDATE_REVIEW and FLAG after a `same_person` resolution). If that correction has landed and the file passes, keep it and add the linked-path cases (a)-(c) below as new tests; otherwise rewrite each so the subject is client A named by `clientId` and the candidate is an opposing `matter_parties` row on a seeded matter carrying `entityId: B` and the relevant keys (as the existing "adverse_history" case seeds): (a) link aged 31 d → FLAG `adverse_history`, `identityBasis: "confirmed_identity"`, `reliedOnLinkIds` = the CNIC link id; aged 2 d → POSSIBLE_CANDIDATE_REVIEW; (b) aged 31 d with `disputed: true` → POSSIBLE_CANDIDATE_REVIEW, then `state: "confirmed"` aged 1 d → FLAG; (c) phone link 31 d, CNIC link 2 d: party keys `{ phone }` → FLAG with `reliedOnLinkIds: [phoneLinkId]`, party keys `{ cnic }` → POSSIBLE_CANDIDATE_REVIEW. Each case additionally asserts that the unnamed opposing subject of the original case yields POSSIBLE_CANDIDATE_REVIEW (never CLEAR). Run — the three PASS with no change to `src/`. Commit separately: `test(d1): link-state cases name the subject by clientId (3424355 tailoring)` with the reason in the body.
- [ ] **Step 1: Failing tests** — `d1.linkState.test.ts` with `now = Date.parse("2026-10-08T00:00:00Z")` and `ts(ms) = Timestamp.fromMillis(ms)`: `{state:"candidate",disputed:false,createdAt:ts(now-30d+1)}` → `candidate`; `createdAt: ts(now-30d)` → `auto_confirmed`; `{state:"candidate",disputed:true,createdAt:ts(now-31d)}` → `disputed`; `{state:"confirmed",disputed:true}` → `confirmed`; `{state:"rejected"}` → `rejected`; `{state:"split"}` → `candidate`; `{state:"candidate",createdAt:ts(now-31d)}` (disputed missing) → `candidate`; every one of those with the flag off → `candidate`; `autoConfirmAt({state:"candidate",disputed:false,createdAt:ts(Date.parse("2026-10-01T00:00:00Z"))})` → `2026-10-31T00:00:00.000Z`; disputed → null; `pairIdOf({leftId:"a",rightId:"b"})` → `"a_b"`. Emulator (`d1.conflict.emu.test.ts`): **O-27** — an opposing `matter_parties` row `{ matterId: <a seeded confidential matter>, classification: "privileged", matterClassification: "confidential" }` hit by a prospective client of the same name (a review-level `adverse_history` hit, so it counts toward the check label) → hit `matterClassification: "privileged"` and stored check `classification: "privileged"` (2a gave `confidential`); the same with a standalone row (`matterId: null`) → `privileged`; **rejected** — two clients same CNIC (forensic shape), link rows set `state: "rejected"`, check naming one by `clientId` → `CLEAR` (the informational hit is NONE, no `unresolvedLinkIds`); same with an opposing party row carrying the other entity and the CNIC → POSSIBLE_CANDIDATE_REVIEW (never CLEAR); with `SIKANDER_FLAG_L17_2_ENABLED=false` the rejected pair → POSSIBLE_CANDIDATE_REVIEW for the forensic shape.
- [ ] **Step 2: Run** `npm --prefix functions test -- linkState` and `npm --prefix functions run test:emu -- d1.conflict.emu` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, then `npm --prefix functions run test:emu` — all PASS.
- [ ] **Step 5: Commit** `feat(d1): L17.2 effective link state; engine ignores rejected pairs; O-27 party label is max(matter, row)`.

### Task 2: Entity permission actions in the shared decision table

**Files:**
- Modify: `platform/p5/permissionDecision.ts`, `functions/src/p5/permission.ts` (only if `requirePermission`'s action type needs widening; it takes `D1Action`, so adding to `D1_ACTIONS` suffices)
- Test: `tests/p5.permission-d1-actions.test.ts`, `tests/p5.permission-decision.parity.test.ts` (run; extend only if it enumerates actions)

**Interfaces:**
- Produces: `D1_ACTIONS` gains `"entity.review"`, `"entity.confirm"`, `"entity.dispute"`, `"entity.reject"` (15 actions). `D1_ROLES`: review, confirm, dispute → `["partner", "associate"]`; reject → `["partner"]`. All four are firm-level (not in `D1_MATTER_LEVEL`). Client / `own_matters` scope → `client-denied`; accounts → `accounts-register-only` (existing rows).

- [ ] **Step 1: Failing tests** — extend `MATRIX` with the four actions (`entity.review: PA`, `entity.confirm: PA`, `entity.dispute: PA`, `entity.reject: P`); the "exports the N actions" test now expects 15; the existing 6-role matrix loop covers allow/deny (clerk and intern → `role-not-permitted`, client → `client-denied`, accounts → `accounts-register-only`).
- [ ] **Step 2: Run** `npx vitest run tests/p5.permission-d1-actions.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/p5` and `npm --prefix functions test` — PASS.
- [ ] **Step 5: Commit** `feat(p5): entity review, confirm, dispute and reject actions (L17.2)`.

### Task 3: Read routes — listReviewQueue, getEntity, listAliases

**Files:**
- Create: `functions/src/d1/entity/flag.ts`, `functions/src/d1/entity/summary.ts`, `functions/src/d1/entity/read.ts`
- Modify: `functions/src/http/router.ts` (`const D1_ENTITY = "/api/d1/entity"`; three `get(...)` entries), `firestore.indexes.json` (composite index `entity_links`: `firmId ASC, state ASC, disputed ASC, createdAt ASC, __name__ ASC`), `functions/test/g2.cross-firm.test.ts` (PROBES `listReviewQueue: { data: () => ({}), target: false }`, `getEntity: { data: (a) => ({ entityId: a.entityId }), target: true }`, `listAliases: { data: (a) => ({ entityId: a.entityId }), target: true }`; `HANDLER_MODULES` gains `entityRead`; firm A's seed in `beforeAll` adds `entities/{entityId}` (`canonicalName: "G2 Alpha Entity"`, `classification: "internal"`), a second entity, and `entity_links/{firmA}_{e1}_{e2}_cnic` (`state: "candidate"`, `disputed: false`, `classification: "internal"`, `createdAt: now`); `FirmA` gains `entityId` and `linkId`; `firmATokens` gains both ids and `"G2 Alpha Entity"`)
- Test: `functions/test/d1.entity-read.emu.test.ts`

**Interfaces:**
- Consumes: Task 1 (`effectiveLinkState`, `autoConfirmAt`, `pairIdOf`), Task 2 (`entity.review`), `parsePage`/`encodeCursor`/`decodeCursor`, `l17_2Enabled`, `maxLabel`/`knownOrHighest`.
- Produces: `requireL17_2(firmId: string): Promise<void>` (reads `firms/{firmId}`; off → `HttpError(404, "feature_disabled")`). `entitySummary(entityId, entityRow, clientRow | undefined): EntitySummary` and `clientOfEntity(firmId, entityId)` (query `clients` where `firmId` and `entityId`, limit 1) in `summary.ts` (Task 4 reuses both). Ops (all `auth: "firm"`, `kind: "general"`, action `entity.review`, `requirePermission(caller, "entity.review")` then `requireL17_2`):
  - `listReviewQueueOp` (GET `?view=pending|disputed&limit&cursor`; other `view` → 400 `invalid_query`). Query `entity_links` where `firmId == caller.firmId`, `state == "candidate"`, `disputed == (view === "disputed")`, and for `pending` also `createdAt > Timestamp.fromMillis(now - LINK_AUTO_CONFIRM_MS)` (so auto-confirmed rows are never scanned), ordered `createdAt` asc then `__name__` asc, scanned in batches of 100. Rows with `classification` above the caller's clearance are skipped. Rows are grouped by `pairIdOf`; a page holds `limit` pairs; after the `limit`-th pair it keeps consuming the immediately following rows of that same pair, and `nextCursor` encodes the last consumed row (`sortKey = "{seconds}.{nanos}"`, id). Each item is a `QueueItem` with `left`/`right` from `entitySummary` (an entity or client unreadable or above clearance → the pair is skipped).
  - `getEntityOp` (GET `?entityId`): entity in the caller's firm within clearance (else 404 `not_found`); `links` = every `entity_links` row with `leftId == entityId` or `rightId == entityId` (two queries), within clearance, grouped by pair → `EntityLinkView` (state from `effectiveLinkState`; `mergeEventId` from `confirmation.mergeEventId` or null), sorted by `pairId`.
  - `listAliasesOp` (GET `?entityId`): same 404 gate; items in this order, deduplicated on `kind + "\u0000" + value`, truncated to 200: entity `name` + each key (`source: "entity"`); the client's `alternateMobile` as `phone` (`source: "client"`); `entity_aliases` where `firmId`, `entityId`, within clearance (`source: "alias"`); for each pair whose effective state is `confirmed` or `auto_confirmed` and whose label is within clearance, the other entity's name and keys (`source: "confirmed_link"`, `entityId` = other). Returns `{ items, nextCursor: null }`.

- [ ] **Step 1: Failing tests** (fake clock via `viaApi(name, { now })`, `now = Date.parse("2026-10-08T00:00:00Z")`; links aged by updating `createdAt` with the Admin SDK) — three clients registered with the same CNIC by a partner (`internal`) → 3 pairs (`a_b`, `a_c`, `b_c`), each one CNIC row plus a phone row when phones match; `listReviewQueue` as associate → 3 items, oldest first, each `effectiveState: "candidate"`, `autoConfirmAt` = createdAt + 30 d in ISO; a pair aged exactly 30 d is absent and one aged 30 d − 1 ms is present (Review Focus 2); `limit=1` over two pairs whose rows are CNIC + phone → page 1 has 1 item with `linkIds.length === 2` and a cursor, page 2 has 1 item and `nextCursor: null` (pair completion); `view=disputed` lists only a pair seeded `disputed: true`; `view=x` → 400 `invalid_query`; `limit=0` → 400 `invalid_limit`; a pair labelled `confidential` is omitted for an `internal` associate and listed for a `confidential` one (Review Focus 5); clerk → 403 `role_not_permitted`; client → 403 `client_denied`; firm with `featureFlags: { L17_2_ENABLED: false }` → 404 `feature_disabled`; `getEntity` returns the entity, `clientCode` `SKD-2026-0001`, and its two links with `effectiveState` `candidate`; a link set `state: "confirmed"` with `confirmation.mergeEventId: "m1"` shows `mergeEventId: "m1"`; above-clearance entity → 404 `not_found`; cross-firm `entityId` → 404; `listAliases` on entity A whose pair with B is confirmed → items include `{ kind: "name", value: <B's name>, source: "confirmed_link", entityId: B }` and never C's name while A–C is candidate; a seeded `entity_aliases` row `{ kind: "name", value: "M. Ali", classification: "internal" }` appears with `source: "alias"`, one labelled `privileged` does not for an `internal` reader; duplicates appear once; each read writes exactly one allow `audit_log` row.
- [ ] **Step 2: Run** `npm --prefix functions run test:emu -- d1.entity-read` — FAIL.
- [ ] **Step 3: Implement** (and the G-2 probe entries and `HANDLER_MODULES` addition in the same commit; `npm run gate:g2` must stay green).
- [ ] **Step 4: Run** the same, `npm --prefix functions run test:emu`, `npm run gate:g2` — PASS.
- [ ] **Step 5: Commit** `feat(d1): entity review queue, getEntity and listAliases (L17.2)`.

### Task 4: Decision routes — confirmMerge, disputeLink, rejectLink

**Files:**
- Create: `functions/src/d1/entity/pair.ts`, `functions/src/d1/entity/ops.ts`
- Modify: `functions/src/http/router.ts` (three `post(...)` entries under `D1_ENTITY`), `functions/test/g2.cross-firm.test.ts` (PROBES `confirmMerge`, `disputeLink`, `rejectLink`: `{ data: (a) => ({ linkId: a.linkId, note: "G2 probe decision note, long enough" }), target: true }`; `HANDLER_MODULES` gains `entityOps`)
- Test: `functions/test/d1.entity-decisions.emu.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 (`effectiveLinkState`, `pairIdOf`, `requireL17_2`, `entitySummary`), `maxLabel`, `rankOf`.
- Produces: `readPair(tx: Transaction, caller: Caller, linkId: string): Promise<Pair>` — `linkId` must be a safe doc id (else 400 `invalid_query`); reads the row (missing / other firm → 404 `not_found`), then all rows `where firmId == caller.firmId, leftId == a, rightId == b`, both `entities` docs (missing / other firm → 404), and computes `label = maxLabel` over every row and both entities; caller clearance below `label` → 404 `not_found`. `Pair = { pairId, a, b, rows: Array<{ ref, data }>, left: DocumentData, right: DocumentData, label: Classification }`. Ops (`auth: "firm"`, `kind: "general"`, body `{ linkId, note }`; note not a string → 400 `invalid_query`, trimmed length < 20 → 400 `note_too_short`; order: permission → `requireL17_2` → body validation → transaction → `readPair` → state checks → writes; every state code is decided after the 404 gate so it is no oracle):
  - `confirmMergeOp` (action `entity.confirm`): any row with `state !== "candidate"` → 409 `link_not_candidate`; any row `disputed === true` and caller not partner → 403 `role_not_permitted`. `priorState` = `disputed` if any row disputed, else `auto_confirmed` if every row's effective state is `auto_confirmed`, else `candidate`. Writes `merge_events/{auto}` (data shape; `keys` and `linkIds` sorted; `evidence.keyValues` from the left entity's fields for those keys; `snapshot` from both entity docs), updates every row `{ state: "confirmed", confirmation: {…, mergeEventId}, classification: label }` (the `disputed` and `dispute` fields stay as they are), creates `events/{mergeEventId}_confirmed`, stages the allow audit row. Returns `DecisionResult` `{ state: "confirmed", disputed: <unchanged>, mergeEventId }`.
  - `disputeLinkOp` (action `entity.dispute`): any row not `candidate` → 409 `link_not_candidate`; any row already `disputed` → 409 `already_disputed`. Updates every row `{ disputed: true, dispute: {…}, classification: label }`. No event. Allowed after day 30 (late dispute, P2-28).
  - `rejectLinkOp` (action `entity.reject`): any row not `candidate` → 409 `link_not_candidate`. Updates every row `{ state: "rejected", rejection: {…}, classification: label }`. No event.

- [ ] **Step 1: Failing tests** — setup: partner registers A then B with CNIC `42101-1234567-1` and the same phone → pair `a_b` with rows `…_cnic` and `…_phone`. **confirm** by associate with `linkId` = the phone row → 200 `{ state: "confirmed", mergeEventId: <id> }`; both rows `state: "confirmed"`, `confirmation.by` = associate uid, `confirmation.mergeEventId` = id; `merge_events/<id>` matches `{ kind: "link_confirmed", pairId: "a_b", linkIds: [cnicRow, phoneRow].sort(), keys: ["cnic", "phone"], score: 0.99, basis: "deterministic_key", priorState: "candidate", actorRole: "associate", reverted: false, classification: "internal", evidence: { note, keyValues: { cnic: "4210112345671", phone: "+923001234567" } } }` and `snapshot.left.canonicalName`/`snapshot.right.canonicalName` equal the two names; one `events` row `{ name: "entity.confirmed", payload: { entityIds: [a, b], mergeEventId: id, score: 0.99 }, idempotencyKey: "<id>:confirmed" }`; one allow audit row with `action: "entity.confirm"`. **Second confirm** → 409 `link_not_candidate`. **Parallel**: `Promise.allSettled` of two confirms on a fresh pair (one per row id) → statuses `[200, 409]` in some order; `merge_events` where `pairId` → 1 doc; `entity.confirmed` events → 1 (Review Focus 1). **Auto-confirmed**: rows aged 31 d → confirm → `priorState: "auto_confirmed"`. **Monotonic**: B registered `confidential` (pair label `confidential`), one row's `classification` forced to `internal` with the Admin SDK → after confirm by a `confidential` partner every row and the merge_event are `confidential`; an `internal` associate's confirm on that pair → 404 `not_found` and nothing written (Review Focus 5). **Dispute** by associate → rows `disputed: true`, `dispute.note` stored; second dispute → 409 `already_disputed`; dispute of a 31-day-old pair succeeds and the pair's effective state becomes `disputed`; dispute of a confirmed pair → 409 `link_not_candidate`. **Disputed confirm**: associate → 403 `role_not_permitted`, rows unchanged; partner → 200, `priorState: "disputed"`, rows keep `disputed: true` and gain `confirmation` (Review Focus 3). **Reject**: associate → 403 `role_not_permitted`; partner → rows `state: "rejected"`, `rejection.by` = partner; confirm/dispute/reject afterwards → 409 `link_not_candidate`. **Validation**: note of 19 chars → 400 `note_too_short`; `linkId: "a/b"` → 400 `invalid_query`; unknown linkId → 404; other-firm linkId → 404; flag off → 404 `feature_disabled`; clerk → 403 `role_not_permitted`. **Idempotency**: the same `Idempotency-Key` twice → identical body, one merge_event. **Immutability**: no op path updates an existing `merge_events` doc (assert the doc's `updateTime` is unchanged after a later dispute attempt on the same pair).
- [ ] **Step 2: Run** `npm --prefix functions run test:emu -- d1.entity-decisions` — FAIL.
- [ ] **Step 3: Implement** (with the G-2 probes and `HANDLER_MODULES` in the same commit).
- [ ] **Step 4: Run** the same, `npm --prefix functions run test:emu`, `npm run gate:g2` — PASS.
- [ ] **Step 5: Commit** `feat(d1): confirmMerge with immutable merge_events, dispute and partner rejection (L17.2)`.

### Task 5: entity.candidate emission and the conflict-check invariants

**Files:**
- Modify: `functions/src/d1/client/ops.ts` (`registerClient` writes one `events/{firmId}_{a}_{b}_candidate` per matched entity, in the same transaction, `classification` = that pair's link label)
- Test: `functions/test/d1.client.emu.test.ts` (event case), `functions/test/d1.entity-invariants.emu.test.ts` (new; the two gate tests)

**Interfaces:**
- Consumes: Tasks 1, 4; 2a `runConflictCheck`, `resolveReviewItem`, `recordPartnerWaiver`, `openMatter`; the 2a seeding pattern for an opposing `matter_parties` row carrying `entityId`.
- Produces: no new exports. Test names (exact; the gate filters on them):
  - `"L17.2 invariant: confirmMerge turns a key review into FLAG and a contradicted resolution into check_stale"`
  - `"L17.2 invariant: a rejected or disputed pair is never confirmed identity"`

- [ ] **Step 1: Failing tests** — `d1.client.emu.test.ts`: registering B with A's CNIC and phone writes exactly one `entity.candidate` event (`payload: { entityIds: [a, b].sort(), mergeEventId: null, score: 0.99 }`, `idempotencyKey: "<firmId>_<a>_<b>:candidate"`), not one per key; a client with no shared key writes none. `d1.entity-invariants.emu.test.ts`, **invariant 1**: clients A, B (same CNIC X, candidate pair); a seeded matter `NHS/2026/0009` for a third client with an opposing `matter_parties` row `{ entityId: B, keys: { cnic: X }, name: "B Trading" }`; check for client A by `clientId` with one opposing party → POSSIBLE_CANDIDATE_REVIEW (hits: same-role on B, role-crossing `adverse_history` on the party row); the requester resolves every review hit `different_person` (20+ char notes; the hits are A's own record, client B and the party row, because A's entity has an unresolved link) → `CLEAR`, decision `cleared`; associate `confirmMerge` on the pair; `openMatter` on that check → 409 `check_stale` and the check's `stale` is `true` (Review Focus 4); a new check for A → `FLAG`, the `adverse_history` hit `{ outcome: "FLAG", identityBasis: "confirmed_identity", reliedOnLinkIds: [cnicRowId] }`, and the same-role hit on B has outcome `NONE`. **Invariant 2**: same seed; partner `disputeLink` → new check for A → `POSSIBLE_CANDIDATE_REVIEW`, never FLAG, identityBasis `candidate_only`; a separate firm with the same seed and partner `rejectLink` → the same-role hit is `NONE` and the role-crossing hit is `POSSIBLE_CANDIDATE_REVIEW` (never FLAG, never CLEAR overall); in both firms a check resolved and cleared *before* the dispute/reject opens a matter successfully afterwards (no stale, P2-30); and with the flag off for a third firm whose pair is `state: "confirmed"`, the check is `POSSIBLE_CANDIDATE_REVIEW`.
- [ ] **Step 2: Run** `npm --prefix functions run test:emu -- d1.client d1.entity-invariants` — expect the event case to FAIL. The invariant cases exercise Tasks 1 and 4, already in; if they pass at once they stay as the gate's cross-module pins (they are not weakened to fail first).
- [ ] **Step 3: Implement** the event write.
- [ ] **Step 4: Run** the same and `npm --prefix functions run test:emu` — PASS.
- [ ] **Step 5: Commit** `feat(d1): entity.candidate on duplicate-key registration; L17.2 conflict invariants`.

### Task 6: Firestore rules — merge_events and entity_aliases server-only

**Files:**
- Modify: `firestore.rules` (the two blocks, spec §5), `tests/firestore.rules.test.ts` (seed rows at the `entity_aliases`/`merge_events` `setDoc` lines in the "#4" and accounts sections gain `classification: "internal"`; no assertion changes)
- Create: `tests/firestore.rules.d1-phase2b.test.ts`; add it to the `test:rules` script in `package.json`

**Interfaces:**
- Produces: `merge_events` — `allow read: if sameFirm() && role() in ['partner', 'associate'] && cleared(resource.data.classification); allow create, update, delete: if false;` `entity_aliases` — `allow read: if sameFirm() && isStaff() && cleared(resource.data.classification); allow create, update, delete: if false;`

- [ ] **Step 1: Failing tests** — `merge_events`: partner SDK `setDoc` denied; partner `updateDoc` of `{ reverted: true, revertedBy, revertedAt }` denied (the withdrawn Phase 0 revert path); same-firm associate `internal` reads an `internal` row, is denied a `confidential` row; clerk and intern denied; cross-firm partner denied; a row without `classification` denied (fail closed). `entity_aliases`: associate SDK create denied (previously allowed); same-firm clerk reads an `internal` row; `internal` reader denied a `privileged` row; client and accounts denied; cross-firm denied.
- [ ] **Step 2: Run** `npm run test:rules` — FAIL.
- [ ] **Step 3: Implement** the blocks and the seed-label additions.
- [ ] **Step 4: Run** `npm run test:rules` and `npm run gate:g2` (its rules half reads every block cross-firm) — PASS.
- [ ] **Step 5: Commit** `feat(rules): merge_events and entity_aliases are server-only with cleared reads (E-41)`.

### Task 7: G-2 snapshot and positive control, G-4 phase-close for 2b-A, and records

**Files:**
- Modify: `functions/test/g2.cross-firm.test.ts` — (the firm-A entity and link seed came in Task 3) `snapshotFirmA` includes the link row's `state`, `disputed` and the count of `merge_events` for firm A (so a cross-firm decision that wrote anything fails the "unchanged" test); the positive control reads `getEntity` (token `"G2 Alpha Entity"`) and `listAliases` (token `"G2 Alpha Entity"`).- Create: `ci_gates/gate_g4_phase2b_a.sh`
- Modify: `package.json` (`"gate:g4:phase2b-a": "bash ci_gates/gate_g4_phase2b_a.sh"`), `.github/workflows/gate-g0.yml` (run it in the gates job after the Phase 2a G-4 step)
- Modify: `docs/architecture/ERRATUM_SET_2_PROPOSED.md` — title range and §ES2-1 heading to "E-23 to E-41"; add row **E-41** (PROPOSED; text below); open items O-27 (closed), O-28, O-29 and the "O-15 to O-29 are new" sentence.
- Modify: `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md` — append a "Phase 2b-A rulings" section: P2-23..P2-41 by reference to the spec; O-27, O-28, O-29 rows; "Phase 2b-A close is Gate G-4 (`npm run gate:g4:phase2b-a`)".
- Test: `ci_gates/test_check_route_coverage.py` (add a case: a fixture router with `const D1_ENTITY = "/api/d1/entity"` and an uncovered `get(\`${D1_ENTITY}/getEntity\`, …)` → exit 1 naming `/api/d1/entity/getEntity`)

**Interfaces:**
- Produces: `gate_g4_phase2b_a.sh`, modelled on `gate_g4_phase2a.sh` (same emulator config handling and `--inner` pattern): [1] `python3 ci_gates/check_route_coverage.py functions/src/http/router.ts functions/test` (must report `d1 routes found: 20; d1 entries in the route table: 20` — 14 from 2a plus 6 entity routes); [2] `functions/test/d1.boot.test.ts`; [3] under the emulators, `vitest run test/d1.entity-invariants.emu.test.ts -t "L17.2 invariant"` with the JSON reporter, passing only if `numPassedTests === 2 && numFailedTests === 0` (`G4B_FILTER` env overrides the filter only to prove the check can fail); [4] `bash ci_gates/gate_g2.sh`.
- E-41 text (one table row): "Layer 17 L17.2 (L6921-6964); Layer 18 §7 (L8398-8414), §5.2 (L8284); Erratum Set No. 1 minimum rules policy (L9355); events register (L8193-8194); Phase 2b-A spec P2-23..P2-41. PROPOSED. (a) Routes `/api/d1/entity/{listReviewQueue, getEntity, listAliases, confirmMerge, disputeLink, rejectLink}`; permission actions `entity.review`, `entity.confirm`, `entity.dispute` (partner, associate) and `entity.reject` (partner); a disputed pair is confirmed only by a partner. (b) `confirmMerge` confirms an entity link and writes an immutable `merge_events` row (who, when, evidence, score 0.99, pre-merge snapshot); it re-points nothing and merges no records — un-merge and its saga are Phase 2b-B. `entity_links` gains state `rejected` and the set-once fields `dispute`, `confirmation`, `rejection`; the conflict engine ignores rejected pairs. (c) `firestore.rules`: `merge_events` and `entity_aliases` become server-only (the partner 'merge_events revert-only' SDK update of the Correction Pack minimum policy (Erratum Set No. 1, L9355) is withdrawn: a revert outside the saga would be a half-state, L8414; L8284 already calls merge_events immutable); reads are cleared on `classification`. (d) The 30-day auto-confirm (L18 §7.1) stays computed at read time and writes no `merge_events` row until a human confirms (O-28). (e) Events `entity.candidate` (registerClient, once per pair) and `entity.confirmed` (confirmMerge) are now emitted; dispute and rejection emit none. (f) Functions reads only `merge_events` rows with `kind == 'link_confirmed'`; the transitional Next.js persistence's rows of another shape in that collection are ignored."
- Open items: **O-27** "Opposing-party hit label (Phase 2a engine took the matter's label alone when the matter existed). Closed in Phase 2b-A: the label is max(matter, party row) (spec P2-37)" | Engineering (closed). **O-28** "Auto-confirm materialisation: a P2 job that, at day 30, writes a `merge_events` row (`priorState: "candidate"`, actor `system`) for each undisputed candidate pair, so L17.2 #16 holds for auto-links too and un-merge can replay them" | Engineering, with the P2 jobs (Phase 3) and 2b-B. **O-29** "Responsible-associate assignment: review items go to any partner or associate cleared to the pair; there is no per-entity or per-client responsible associate to route them to (L17.2 Human control)" | Partner (whether to assign), then engineering.

- [ ] **Step 1: Failing tests** — the new pytest case; run `npm run gate:g2` with the new seed before updating `snapshotFirmA` users (expect the positive control to fail on the missing reads until added).
- [ ] **Step 2: Run** `python3 -m pytest ci_gates/test_check_route_coverage.py` — FAIL on the new case only if the checker does not handle `D1_ENTITY` (it should already; if it passes at once, keep the case as a regression pin).
- [ ] **Step 3: Implement** the seed, the script, the npm script, the CI step and the two documents.
- [ ] **Step 4: Run** `python3 -m pytest ci_gates/test_check_route_coverage.py`, `npm run gate:g2`, `npm run gate:g4:phase2a`, `npm run gate:g4:phase2b-a`, `npm run test:rules`, `npx vitest run tests/p5`, `npm --prefix functions run test:emu` — all PASS. Also prove the gate fails: `G4B_FILTER="no such test" npm run gate:g4:phase2b-a` exits non-zero.
- [ ] **Step 5: Commit** `ci(gates): G-4 phase-close for Phase 2b-A; G-2 over the entity routes; E-41 and O-27..O-29`.
