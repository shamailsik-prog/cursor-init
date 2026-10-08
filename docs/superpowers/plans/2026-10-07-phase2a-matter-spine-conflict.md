# Phase 2a Matter Spine and Conflict Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloud Functions routes under `/api/d1/{client,conflict,matter}/*` that register clients, run a Module 6 conflict check (CLEAR / FLAG / POSSIBLE_CANDIDATE_REVIEW with identity basis), resolve review items, record partner waivers, and open numbered matters only on a cleared check.

**Architecture:** Pure matching logic (`functions/src/d1/conflict/normalise.ts`, `match.ts`) under unit tests; Firestore-backed operations in the existing `Operation` shape (`functions/src/p5/common.ts`) registered in `functions/src/http/router.ts`; permissions through the shared decision table `platform/p5/permissionDecision.ts`; Firestore rules for the new collections; a G-4 phase-close script.

**Tech Stack:** TypeScript, firebase-functions v6 (asia-south1), firebase-admin, Firestore emulator, vitest 3, `@firebase/rules-unit-testing`.

**Spec:** `docs/superpowers/specs/2026-10-07-phase2a-matter-spine-conflict-design.md` (rulings P2-1..P2-22). Architecture: `docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt`.

## Global Constraints

- Routes: `/api/d1/{service}/{function}`, Bearer + `X-Firm-Id`; firm never from the body; every POST carries `Idempotency-Key` (existing router does this).
- List GETs: `limit` default 20, max 100; opaque `cursor`; response `{ items, nextCursor }` (`nextCursor: null` at the end).
- Every write is audited with exactly one `audit_log` row per call through `CallAudit` / `runAudited` (existing pattern); every Firestore artefact write carries `classification` and `firmId`.
- Errors: `{ error: { code } }` via `HttpError(status, code)`; codes exactly as spec §6.
- Outcomes: `"CLEAR" | "FLAG" | "POSSIBLE_CANDIDATE_REVIEW"`; identity basis `"confirmed_identity" | "candidate_only"`; never return a PBC rule number (P2-19). Any comment or test text naming the rule writes `PBC Rule 85 [REQUIRES VERIFICATION]`.
- Name hit threshold: token-set ratio ≥ 0.80 (P2-16). Entity link auto-confirm window: 30 days (P2-5). Check validity for opening: 30 days (P2-6). Daily conflict cap: 100 per firm per Asia/Karachi day (P2-17). Waiver note ≥ 50 chars; review note ≥ 20 chars (P2-7, P2-8). Opposing parties per check: 1-20.
- Numbering: client code `{clientPrefix}-{YYYY}-{NNNN}`, matter number `{matterPrefix}/{YYYY}/{NNNN}`, NNNN zero-padded to 4, year in Asia/Karachi; prefix regex `^[A-Z]{2,6}$` (P2-11).
- Stage order: `pre_filing, filed, hearing, reserved, decided, archived`; status `engagement_unconfirmed | live | closed` (P2-12).
- No new npm dependencies. No P1 / provider calls anywhere in this plan.
- Do not modify the Next.js `app/api/d1/*` routes or `services/d1-*` (P2 spec §8).
- Commit messages end with the two attribution lines the session uses (`Co-Authored-By: …`, `Claude-Session: …`).

### Data shapes (Firestore, all docs carry `firmId`, `classification`, `createdAt` server timestamp)

```ts
// firms/{firmId} (existing doc) gains: clientPrefix?: string; matterPrefix?: string
// counters/{firmId}_{kind}_{YYYY}   kind: "client" | "matter"          { firmId, kind, year, next: number }
// counters/{firmId}_conflictday_{YYYYMMDD}                              { firmId, count: number, expiresAt }
// clients/{clientId}  { firmId, clientCode, entityId, canonicalName, type: "individual"|"company"|"government",
//   companyName?, reference?, primaryMobile, alternateMobile?, concernedPersonName?, email?, cnic?, ntn?,
//   secpNumber?, address?, corporateGroup?, classification, createdBy, createdAt }
// entities/{entityId} { firmId, canonicalName, cnic?, ntn?, secpNumber?, phone?, classification, createdAt }
// entity_links/{firmId}_{a}_{b} (a<b) { firmId, leftId, rightId, key: "cnic"|"ntn"|"secp"|"phone",
//   state: "candidate"|"confirmed", disputed: boolean, createdAt }
// matter_parties/{id} { firmId, matterId: string|null, role: "client"|"opposing", name, names: string[] (normalised),
//   keys: {cnic?, ntn?, secp?, phone?}, entityId?: string, matterClassification, matterStatus, classification }
// conflict_checks/{checkId} { firmId, requestedBy, subjects: Subject[], hits: Hit[], result, identityBasis,
//   classification, decision: "pending"|"cleared", waiver?: Waiver, boundMatterId: string|null, stale: boolean, createdAt }
// conflict_events/{id} { firmId, checkId, kind: "decided"|"review_resolved"|"waived"|"bound", actorId, detail, createdAt }
// matters/{matterId} (existing collection) adds: matterNo, stage, status, conflictCheckId, clientId, title, courtId?
// matter_events/{id} { firmId, matterId, kind: "opened"|"stage_advanced"|"closed", from?, to?, actorId, reason?, createdAt }
// transliteration_map/{id} { firmId, script: string, roman: string[] }   (firm additions; read by normalise)
```

```ts
type Role = "client" | "opposing"
type Keys = { cnic?: string; ntn?: string; secp?: string; phone?: string }
type Subject = { role: Role; name: string; keys: Keys; clientId?: string }
type Hit = {
  subjectIndex: number; hitRole: Role; type: "direct_adverse" | "former_client" | "adverse_history" | "informational"
  basis: "key" | "name"; score: number; identityBasis: "confirmed_identity" | "candidate_only"
  outcome: "FLAG" | "POSSIBLE_CANDIDATE_REVIEW" | "NONE"; matchedName: string; matterId: string | null
  matterNo: string | null; matterClassification: string; reliedOnLinkIds: string[]
  review?: { resolution: "different_person" | "same_person"; by: string; note: string; at: string }
}
type Waiver = { partnerId: string; note: string; clientConsent: true; consentReference: string; at: string }
```

## Review Focus

1. Urdu-script party names (e.g. `محمد علی`) against a Roman client `Muhammad Ali` must hit; expected: POSSIBLE_CANDIDATE_REVIEW, not CLEAR. Pinned in Task 4 and Task 7.
2. A CNIC typed with dashes and spaces (`42101-1234567-1`, `4210112345671 `) must equal the bare 13 digits; a 12-digit value must be rejected `invalid_subjects`. Pinned in Task 4 and Task 6.
3. Two concurrent `openMatter` calls on the same cleared check: exactly one succeeds, the other `check_already_bound`; matter numbers never repeat under 10 parallel opens. Pinned in Task 9 and Task 3.
4. A non-member associate's check that hits a matter they are not on must not reveal that matter's number or title (`matter: "restricted"`). Pinned in Task 7.
5. The 101st check in a firm on one Asia/Karachi day returns 429 `daily_limit` with Retry-After to local midnight; the count resets at 19:00 UTC. Pinned in Task 7.

---

### Task 1: Router GET with query parameters and pagination helper

**Files:**
- Modify: `functions/src/http/router.ts` (GET passes parsed query as `data`)
- Create: `functions/src/d1/pagination.ts`
- Modify: `functions/test/api.ts` (`viaApi` sends `data` as the query string for GET routes)
- Test: `functions/test/http.test.ts`, `functions/test/d1.pagination.test.ts`

**Interfaces:**
- Produces: GET routes receive `data: Data` built from `req.query` (string values only; arrays → 400 `invalid_query`). `parsePage(data: Data): { limit: number; cursor: string | null }` (400 `invalid_limit` for non-integer, < 1 or > 100). `encodeCursor(sortKey: string, id: string): string` / `decodeCursor(c: string): { sortKey: string; id: string }` (base64url JSON; malformed → 400 `invalid_cursor`). `Page<T> = { items: T[]; nextCursor: string | null }`.

- [ ] **Step 1: Failing tests** — `http.test.ts`: a test GET route registered via `createRouter([...])` receives `{ limit: "5" }` from `?limit=5`; `?a=1&a=2` → 400 `invalid_query`; GET still needs no Idempotency-Key. `d1.pagination.test.ts`: `parsePage({})` → `{ limit: 20, cursor: null }`; `parsePage({ limit: "100" })` ok; `"0"`, `"101"`, `"2.5"`, `"x"` → `invalid_limit`; `decodeCursor(encodeCursor("2026-10-07T00:00:00Z","abc"))` round-trips; `decodeCursor("%%")` → `invalid_cursor`.
- [ ] **Step 2: Run** `npm --prefix functions test -- http pagination` — expect FAIL.
- [ ] **Step 3: Implement.** The router reads `req.query` (express parsed) for GET; the mock request in tests supplies `query`.
- [ ] **Step 4: Run** the same — PASS; then `npm --prefix functions test` all PASS.
- [ ] **Step 5: Commit** `feat(functions): GET query data and cursor pagination helper`.

### Task 2: D1 permission actions in the shared decision table

**Files:**
- Modify: `platform/p5/permissionDecision.ts`
- Test: `tests/p5.permission-d1-actions.test.ts` (root vitest), `functions/test/p5.permission.test.ts` (one emulator case)

**Interfaces:**
- Produces: exported `D1_ACTIONS` const with `client.register`, `client.read`, `matter.open`, `matter.advance_stage`, `matter.close`, `conflict.run`, `conflict.resolve_review`, `conflict.waive`, `conflict.read_trail`, `firm.set_numbering`, `matter.read`; `isD1Action(a)`. Firm-level decisions (no matterId): `client.register`, `matter.open`, `conflict.run`, `conflict.resolve_review` → partner|associate (clerk also for `client.register`); `client.read` → partner|associate|clerk|intern; `conflict.waive`, `firm.set_numbering` → partner; `conflict.read_trail` → partner|associate (ops narrow associates to their own checks). Matter-level (`matter.read`, `matter.advance_stage`, `matter.close`) go through the existing membership + clearance path, then role: read → partner|associate|clerk|intern, advance → partner|associate, close → partner. Client and accounts → deny for every D1 action (`client-denied`, `accounts-register-only`). Deny reasons: `role-not-permitted`.

- [ ] **Step 1: Failing tests** — a table test over the 6 roles × 10 actions asserting the allow/deny matrix above; matter-level actions deny `not-member` and `clearance` as existing actions do.
- [ ] **Step 2: Run** `npx vitest run tests/p5.permission-d1-actions.test.ts` — FAIL.
- [ ] **Step 3: Implement** as a branch in `decide()` before the generic allow; keep existing behaviour for every other action (run the existing permission tests).
- [ ] **Step 4: Run** `npx vitest run tests/p5` and `npm --prefix functions test` — PASS.
- [ ] **Step 5: Commit** `feat(p5): D1 permission actions for clients, matters and conflict checks`.

### Task 3: Numbering counters and setFirmNumbering

**Files:**
- Create: `functions/src/d1/numbering.ts`, `functions/src/d1/client/numberingOp.ts`
- Modify: `functions/src/http/router.ts` (route `POST /api/d1/client/setFirmNumbering`)
- Test: `functions/test/d1.numbering.emu.test.ts`

**Interfaces:**
- Produces: `karachiYear(now: Date): number`, `karachiDay(now: Date): string` ("YYYYMMDD"); `allocateNumber(tx: Transaction, firmId: string, kind: "client"|"matter", now: Date): Promise<number>`; `formatClientCode(prefix, year, n)` → `SKD-2026-0001`; `formatMatterNo(prefix, year, n)` → `NHS/2026/0001` (n ≥ 10000 prints all digits); `readPrefixes(tx, firmId): Promise<{ clientPrefix: string; matterPrefix: string }>` throwing 409 `numbering_not_configured`. Op `setFirmNumberingOp` (action `firm.set_numbering`, body `{ clientPrefix, matterPrefix }`, 400 `invalid_prefix`).

- [ ] **Step 1: Failing tests** — `karachiYear(new Date("2026-12-31T19:30:00Z"))` → 2027; `formatMatterNo("NHS", 2026, 7)` → `NHS/2026/0007`; `formatMatterNo("NHS",2026,12345)` → `NHS/2026/12345`; emulator: 10 parallel `allocateNumber` transactions return 1..10 with no repeat; partner sets prefixes; associate → 403; `"nhs"` and `"TOOLONGX"` → 400 `invalid_prefix`; unset → `readPrefixes` 409.
- [ ] **Step 2: Run** `npm --prefix functions run test:emu -- numbering` — FAIL.
- [ ] **Step 3: Implement** counters per the data shape; the op checks permission through `checkPermission(caller, "firm.set_numbering")` → 403 `role_not_permitted`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(d1): atomic client and matter numbering`.

### Task 4: Name and key normalisation with transliteration

**Files:**
- Create: `functions/src/d1/conflict/translit-seed.ts`, `functions/src/d1/conflict/normalise.ts`
- Test: `functions/test/d1.normalise.test.ts`

**Interfaces:**
- Produces: `normaliseCnic(raw: string): string | null` (13 digits after stripping `-` and spaces, else null); `normalisePhone(raw: string): string | null` (E.164 `+92…`; accepts `03xx…`, `92…`, `+92…`; null otherwise); `normaliseNtn(raw)`, `normaliseSecp(raw)` (uppercase, strip spaces/dashes; null if empty); `nameForms(name: string, firmMap?: ReadonlyMap<string, string[]>): string[][]` — each form is a token list of lowercase Roman tokens with honorifics removed (`mr, mrs, ms, dr, syed, sayed, haji, hafiz, mian, ch, chaudhry, rana, malik, begum, sahib, sb` are dropped only when other tokens remain) and variant expansion. Seed variant groups (from L18 §7.2): `muhammad|mohammad|mohammed|mohd|m`, `ali|aly`, `hussain|hussein|husain`, `ahmed|ahmad`, `shaikh|sheikh|shekh`; Arabic-script names map through a seed word table (`محمد`→muhammad, `علی`/`علي`→ali, `حسین`→hussain, `احمد`→ahmed, `شیخ`→shaikh, `خان`→khan, `بھٹو`→bhutto, `میمن`→memon, `سومرو`→soomro, `بلوچ`→baloch, `جوکھیو`→jokhio) and an unmapped Arabic-script word falls back to a per-character Arabic→Latin table. Family tokens (bhutto, jokhio, baloch, memon, soomro) are kept as tokens.

- [ ] **Step 1: Failing tests** — `normaliseCnic("42101-1234567-1")` → `"4210112345671"`; `"4210112345671 "` same; `"421011234567"` → null; `normalisePhone("0300-1234567")` → `"+923001234567"`; `"+92 300 1234567"` same; `"12345"` → null; `nameForms("Mr. Muhammad Ali")` contains `["muhammad","ali"]`; `nameForms("محمد علی")` contains `["muhammad","ali"]`; `nameForms("Mohd. Hussein Shaikh")` contains a form equal to `["muhammad","hussain","shaikh"]` (variants canonicalised to the group's first spelling); `nameForms("Syed")` keeps `["syed"]`; a firm map entry `{ "بابر": ["babar"] }` maps `بابر` → `babar`.
- [ ] **Step 2: Run** `npm --prefix functions test -- normalise` — FAIL.
- [ ] **Step 3: Implement** — canonicalise each token to its variant group's first spelling (so expansion is a lookup, not a cross product); return one form per input form (the firm map can add alternatives).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(d1): name and identifier normalisation with Urdu/Sindhi transliteration`.

### Task 5: Matching, role-crossing and outcome precedence (pure)

**Files:**
- Create: `functions/src/d1/conflict/match.ts`
- Test: `functions/test/d1.match.test.ts`

**Interfaces:**
- Consumes: `nameForms`, normalisers (Task 4).
- Produces: `tokenSetRatio(a: string[], b: string[]): number` (0..1, Levenshtein-based token-set ratio as in rapidfuzz's `token_set_ratio`/100); `type Candidate = { role: "client"|"opposing"; name: string; forms: string[][]; keys: Keys; entityId?: string; matterId: string|null; matterNo: string|null; matterClassification: string; matterStatus: "live"|"closed"|null; clientHasLiveMatter: boolean; linkState: "none"|"candidate"|"confirmed"; linkIds: string[]; unresolvedLinkIds: string[] }`; `screen(subjects: Subject[], subjectForms: string[][][], candidates: Candidate[]): { hits: Hit[]; result: Outcome; identityBasis: IdentityBasis }`.
- Rules (spec P2-3..P2-5): a candidate is hit when any exact normalised key equals the subject's (basis `key`, score 1) or max tokenSetRatio over form pairs ≥ 0.80 (basis `name`). Different non-empty CNICs on both sides → not a hit (distinct persons). Role-crossing: subject client vs candidate opposing → `adverse_history`; subject opposing vs candidate client → `direct_adverse` if `clientHasLiveMatter` else `former_client`; same role → `informational` (outcome NONE unless `unresolvedLinkIds` non-empty, then POSSIBLE_CANDIDATE_REVIEW). Role-crossing outcome: FLAG if basis `key` and `linkState === "confirmed"`, or the subject carries `clientId` whose entity equals the candidate's `entityId`; otherwise POSSIBLE_CANDIDATE_REVIEW. Result = max by FLAG > POSSIBLE_CANDIDATE_REVIEW > CLEAR; overall identityBasis = `candidate_only` if any non-NONE hit is candidate_only, else `confirmed_identity`.

- [ ] **Step 1: Failing tests** — `tokenSetRatio(["muhammad","ali"],["muhammad","ali","khan"])` = 1; `(["ali","raza"],["ali","reza"])` ≥ 0.80; a pair scoring exactly 0.79 (compute a fixture) is not a hit and 0.80 is; role matrix (4 cases) gives the four types; same CNIC + confirmed link + opposing vs client → FLAG `confirmed_identity`; same CNIC + candidate link → POSSIBLE_CANDIDATE_REVIEW `candidate_only`; name-only hit → POSSIBLE_CANDIDATE_REVIEW, never FLAG; different CNICs + identical names → no hit; no candidates → CLEAR; forensic test 3 shape (subject client "Muhammad Ali" CNIC X, two candidate clients "Muhammad Ali" same CNIC with `unresolvedLinkIds: ["l1"]`) → POSSIBLE_CANDIDATE_REVIEW with identityBasis set, never CLEAR.
- [ ] **Step 2: Run** `npm --prefix functions test -- match` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(d1): conflict matching and outcome rules (Module 6, L18 §7)`.

### Task 6: Client registration, read and list

**Files:**
- Create: `functions/src/d1/client/ops.ts`, `functions/src/d1/validate.ts`
- Modify: `functions/src/http/router.ts`
- Test: `functions/test/d1.client.emu.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: ops `registerClientOp` (POST, action `client.register`), `getClientOp` (GET `?clientId=`, action `client.read`), `listClientsOp` (GET, action `client.read`, ordered by `createdAt` desc then id). `parseKeys(data): Keys` and `parseName(value): string` (1-200 chars trimmed, else 400 `invalid_subjects`) in `validate.ts` (Task 7 reuses them). Register body: L7.2 fields (`name`, `type`, `primaryMobile` required; others optional; `companyName` required when `type === "company"`), `classification` (required, ≤ caller clearance else 403 `exceeds_own_clearance`). One transaction: allocate client code, write `entities` + `clients`, and for each other firm entity sharing an exact normalised key write `entity_links` `state: "candidate"` (L18 §7.1). Response `{ clientId, clientCode, entityId, possibleDuplicates: [{ clientId, clientCode, key }] }`. `getClient`/`listClients` return only clients whose classification ≤ caller clearance (others: 404 / omitted).

- [ ] **Step 1: Failing tests** — happy path returns `SKD-2026-0001` then `-0002`; clerk may register, client role → 403; cross-firm `getClient` → 404 `not_found`; CNIC `42101-1234567-1` stored as 13 digits; 12-digit CNIC → 400 `invalid_subjects`; second client with the same CNIC → `possibleDuplicates` length 1 and one `entity_links` doc in state candidate; `company` without `companyName` → 400; listClients pagination: 25 clients, `limit=20` → 20 + cursor, next page 5 + `nextCursor: null`; idempotent replay returns the same `clientId`; exactly one `audit_log` allow row per call.
- [ ] **Step 2: Run** `npm --prefix functions run test:emu -- d1.client` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(d1): client registration (L7.2) with duplicate-key candidate links`.

### Task 7: Conflict engine, runConflictCheck and getConflictResult

**Files:**
- Create: `functions/src/d1/conflict/engine.ts`, `functions/src/d1/conflict/ops.ts`, `functions/src/d1/conflict/disclosure.ts`, `functions/src/d1/dailyLimit.ts`
- Modify: `functions/src/http/router.ts`
- Test: `functions/test/d1.conflict.emu.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6 (`parseKeys`, `parseName`).
- Produces: `loadCandidates(firmId: string, now: Date): Promise<Candidate[]>` (all firm `clients` as role client with `clientHasLiveMatter` from their matters, plus `matter_parties` rows with role `opposing` only — client-role party rows duplicate the `clients` rows and are skipped; `linkState` from `entity_links` with the 30-day auto-confirm rule computed at read time — `state === "candidate" && !disputed && createdAt <= now - 30d` counts as confirmed; with flag `L17_2_ENABLED` off every key link counts as candidate, P2-18); `runConflictCheckOp` (POST, action `conflict.run`, rate kind `p1`, body `{ client: { clientId } | { name, keys? }, opposingParties: [{ name, keys? }] }`); `getConflictResultOp` (GET `?checkId=`, requester or partner). `consumeDailyConflict(firmId, now)` throws `RateLimitedError("daily_limit", secondsToKarachiMidnight)`. `discloseFor(caller, check, memberMatterIds): DisclosedCheck` — non-partners see `matterNo`/`matterId` only for matters they are members of, else `"restricted"`; partners see all hits whose `matterClassification` ≤ their clearance, `"restricted"` otherwise. Writes `conflict_checks` (classification = max(`confidential`, hit matter classifications), `decision: "cleared"` iff result CLEAR else `"pending"`), one `conflict_events` `decided` row, and an outbox event `conflict.decided` (use the existing outbox/event helper if present; otherwise a `events` collection row `{ name, firmId, payload, classification, occurredAt, idempotencyKey }` per L8148).

- [ ] **Step 1: Failing tests** — no data → CLEAR, decision cleared; opposing party named as an existing client with a live matter + same CNIC + link confirmed (createdAt 31 days ago) → FLAG `direct_adverse` `confirmed_identity`; same with link 2 days old → POSSIBLE_CANDIDATE_REVIEW; **forensic test 3**: two clients "Muhammad Ali", same CNIC, different phones (registered via Task 6, so a candidate link exists) and a check naming one → POSSIBLE_CANDIDATE_REVIEW with `identityBasis`, never CLEAR; Urdu `محمد علی` opposing vs client "Muhammad Ali" → POSSIBLE_CANDIDATE_REVIEW (Review Focus 1); non-member associate's hit shows `matterNo: "restricted"` while a partner sees `NHS/2026/0001` (Review Focus 4); 0 or 21 opposing parties → 400 `invalid_subjects`; client role → 403; cross-firm `getConflictResult` → 404; 100 checks pass and the 101st → 429 `daily_limit` with Retry-After = seconds to 19:00 UTC (fake clock via `createRouter(ROUTES, { now })`) (Review Focus 5); result payload never contains the string `Rule 85`.
- [ ] **Step 2: Run** `npm --prefix functions run test:emu -- d1.conflict` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(d1): Module 6 conflict check with identity basis and disclosure rules`.

### Task 8: Review resolution, partner waiver and trail

**Files:**
- Modify: `functions/src/d1/conflict/ops.ts`, `functions/src/http/router.ts`
- Test: `functions/test/d1.conflict-decisions.emu.test.ts`

**Interfaces:**
- Consumes: Task 7 (`conflict_checks` shape, `discloseFor`).
- Produces: `resolveReviewItemOp` (POST, action `conflict.resolve_review`, body `{ checkId, hitIndex, resolution: "different_person"|"same_person", note }`): hit must have outcome POSSIBLE_CANDIDATE_REVIEW and no review (else 409 `not_review_item`); note ≥ 20 chars (400 `note_too_short`); `different_person` → hit outcome NONE; `same_person` → FLAG with `confirmed_identity`; recompute result; decision `cleared` when result becomes CLEAR. `recordPartnerWaiverOp` (POST, action `conflict.waive`, body `{ checkId, note, clientConsent, consentReference }`): result must be FLAG (409 `not_waivable`), no open review items (409 `review_pending`), not already waived (409 `already_waived`), note ≥ 50 (400 `note_too_short`), `clientConsent === true` and non-empty `consentReference` (400 `consent_required`), caller clearance ≥ check classification (403 `exceeds_own_clearance`) → sets `waiver`, decision `cleared`, event `conflict.waived`. `getConflictTrailOp` (GET `?checkId=`, action `conflict.read_trail`; associates only for their own checks → 403 otherwise) returns the `conflict_events` rows in order. All state changes in a transaction; a bound check (`boundMatterId` set) refuses changes with 409 `check_already_bound`.

- [ ] **Step 1: Failing tests** — each rule above with its exact code; associate waiver → 403; partner waiver happy path → decision cleared and a `waived` trail row; trail order `decided, review_resolved, waived`; second waiver → 409 `already_waived`; waiver with an unresolved review hit → 409 `review_pending`.
- [ ] **Step 2: Run** `npm --prefix functions run test:emu -- d1.conflict-decisions` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(d1): conflict review resolution, partner waiver and immutable trail`.

### Task 9: Opening matters, stage flow and closure

**Files:**
- Create: `functions/src/d1/matter/ops.ts`
- Modify: `functions/src/http/router.ts`
- Test: `functions/test/d1.matter.emu.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 7, 8.
- Produces: `openMatterOp` (POST, action `matter.open`, body `{ conflictCheckId, title (1-300), courtId?, classification, memberUserIds?: string[] (≤ 20, same-firm active staff, never client/accounts) }`). Transaction: re-read the check — missing/other firm 404 `check_not_found`; `decision !== "cleared"` 409 `check_not_cleared`; `boundMatterId` set 409 `check_already_bound`; `stale` 409 `check_stale`; older than 30 days 409 `check_expired`; subject client must reference an existing `clientId` 409 `subjects_mismatch`; classification ≤ caller clearance. Writes `matters/{id}` (`matterNo`, `stage: "pre_filing"`, `status: "engagement_unconfirmed"`, `clientId`, `conflictCheckId`, `title`, `courtId`, `classification`), `matter_members` for the caller and each listed member (doc id `{matterId}_{uid}`, existing shape), `matter_parties` one per check subject (with `matterId`, normalised `names`, `keys`, `matterStatus: "live"`), `matter_events` `opened`, sets check `boundMatterId`, `conflict_events` `bound`, emits `matter.created`. `getMatterOp` / `listMattersOp` (GET; list = matters the caller is a member of, cursor paginated; get uses `checkPermission(caller, "matter.read", matterId)`; a deny for a missing or other-firm matter answers 404 `not_found`). `advanceStageOp` (POST `{ matterId, to }`, action `matter.advance_stage`): `to` must be the next stage (409 `invalid_stage_transition`). `closeMatterOp` (POST `{ matterId, reason? }`, action `matter.close`): stage must be `decided` or `reason` ≥ 20 chars; sets `status: "closed"`, updates that matter's `matter_parties.matterStatus` to `closed`.

- [ ] **Step 1: Failing tests** — open on a CLEAR check → `NHS/2026/0001`, members, parties, events; uncleared / bound / stale / 31-day-old / other-firm check → the five codes; **two parallel opens on one check → one 200 and one 409 `check_already_bound`** (Review Focus 3); 10 parallel opens on 10 checks → 10 distinct numbers; member list containing a client-role uid → 400 `invalid_member`; stage `pre_filing → filed` ok, `pre_filing → hearing` → 409; non-member advance → 403; associate close → 403; partner close at `filed` without reason → 409 `invalid_stage_transition`, with a 20-char reason → closed; after close, a new check naming that client as opposing yields `former_client`; listMatters returns only member matters; cross-firm getMatter → 404.
- [ ] **Step 2: Run** `npm --prefix functions run test:emu -- d1.matter` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(d1): open matters only on a cleared conflict check; numbered stage flow`.

### Task 10: Firestore rules for the new collections

**Files:**
- Modify: `firestore.rules`
- Test: `tests/firestore.rules.d1-phase2a.test.ts`; add it to the `test:rules` script in `package.json`

**Interfaces:**
- Produces (spec §5): `counters`, `transliteration_map`, `conflict_events` (partner read only), `conflict_checks` (read: same firm and (`requestedBy == uid` or partner)), `matter_parties` (same-firm staff with clearance on `classification`), `matter_events` (same-firm member read via the existing `memberReader(matterId)`), `entity_links` (same-firm staff read) — all with `create, update, delete: if false`.

- [ ] **Step 1: Failing tests** — for each collection: SDK write denied for a partner; cross-firm read denied; the allowed reader can read; a client-role user is denied every read; an associate cannot read another user's conflict check.
- [ ] **Step 2: Run** `npm run test:rules` — FAIL.
- [ ] **Step 3: Implement** the blocks next to the existing D1 blocks.
- [ ] **Step 4: Run** `npm run test:rules` — PASS.
- [ ] **Step 5: Commit** `feat(rules): server-only Phase 2a collections with scoped reads`.

### Task 11: G-2 re-run, G-4 phase-close script and records

**Files:**
- Modify: `functions/test/g2.cross-firm.test.ts` (add the new GET routes: getClient, listClients, getConflictResult, getConflictTrail, getMatter, listMatters → firm B caller gets 404/empty, never firm A data)
- Create: `ci_gates/gate_g4_phase2a.sh`, `ci_gates/check_route_coverage.py`
- Modify: `package.json` (`"gate:g4:phase2a": "bash ci_gates/gate_g4_phase2a.sh"`), `.github/workflows/gate-g0.yml` (run it in the gates job after G-2)
- Modify: `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md` (append P2-1..P2-22 by reference to the spec, and open item O-25 corporate-group screening), `docs/architecture/ERRATUM_SET_2_PROPOSED.md` (add E-40: events `conflict.decided`, `conflict.waived`; collections `conflict_checks`, `conflict_events`, `matter_parties`, `matter_events`, `entity_links`, `counters` added to L18 §5.2; PROPOSED)
- Test: `ci_gates/test_check_route_coverage.py`

**Interfaces:**
- Produces: `check_route_coverage.py <routes-file> <tests-dir>`: extracts every `/api/d1/...` path from `functions/src/http/router.ts` and fails (exit 1, listing them) when a route's final segment never appears in a `viaApi("<name>")` call under `functions/test/`. `gate_g4_phase2a.sh` runs: the coverage check, the forensic test 3 case (`vitest -t "forensic test 3"`), the G-2 suite, and a disable-every-layer boot check (import `functions/src/index.ts` with every layer flag off and assert the router builds).

- [ ] **Step 1: Failing tests** — pytest: a fixture router with an untested route → exit 1 naming it; all covered → exit 0.
- [ ] **Step 2: Run** `python3 -m pytest ci_gates/test_check_route_coverage.py` — FAIL.
- [ ] **Step 3: Implement** the checker, script, CI step, and the G-2 additions; update the two docs.
- [ ] **Step 4: Run** `python3 -m pytest ci_gates/test_check_route_coverage.py`, `npm run gate:g2`, `npm run gate:g4:phase2a` — all PASS.
- [ ] **Step 5: Commit** `ci(gates): G-4 phase-close for Phase 2a; G-2 over the new read routes`.
