# Phase 2a: Matter Spine and Module 6 Conflict Engine (design)

Status: approved under the owner's standing autonomy instruction (CLAUDE.md, 2026-10-07): every design decision below is a recorded ruling, not a question.
Governing text: `docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt` ("Lnnnn" = line). Extract with quotes: the Phase 2 spec extract in the session scratchpad, summarised here.

## 1. What this builds and why

v6 §21 (L2033-2054) puts the **matter spine** second in the build order: Client (Module 1 → D1-1), Matter (Module 2 → D1-2), Conflict Checker (Module 6 → D1-4) and Document Storage (Module 7 → D1-6/D3-1). The MVP journey is "WhatsApp intake → conflict check → matter → document upload → …" (L2053). Everything later (drafting, research, WhatsApp) assumes a client and a matter exist and that the matter was opened only after a defensible conflict decision.

Phase 2 is split into three sub-projects, each with its own spec, plan and PR:

| Part | Scope | Why separate |
| --- | --- | --- |
| **2a (this spec)** | D1-1 client registration, D1-2 matter opening (numbering, stage flow, parties), D1-4 conflict engine (matching, outcomes, waiver, trail), Firestore rules, gate script | The core legal-conduct path; testable on the emulator alone. |
| 2b | L17.2 entity review queue (0.70-0.95 band), confirmMerge, un-merge saga over P2 jobs | Needs the P2 job engine (Phase 3); 2a reads entity links but does not merge. |
| 2c | D1-6 upload write path to R2, D3-1 read path | Blocked on R2 credentials and the SigV4 live-bucket test (open item O-2). |

The work lands in **Cloud Functions** (`functions/`, asia-south1) under `/api/d1/{client,matter,conflict}/{function}`, per E-23 (Next.js is transitional). The existing Next.js D1 routes stay untouched until the Flutter shell replaces them (E-39(3)).

Success: a partner can register a client, run a conflict check naming the client and the opposing parties, see CLEAR / FLAG / POSSIBLE_CANDIDATE_REVIEW with the identity basis, waive a FLAG with a written note and client consent, and open a numbered matter only on a cleared check; every step is audited, cross-firm access is denied, and a G-4 phase-close script proves it.

## 2. Rulings on the architecture's gaps

Each ruling: what, why, cost if wrong. Numbers refer to the extract's gap list.

| # | Ruling | Reason | Cost if wrong |
| --- | --- | --- | --- |
| P2-1 (gap 1) | Phase numbering follows v6 §21 (the Phase 1 plan's numbering). | The plan and rulings ledger already use it; L18 §3.1 tags these services "Phase 1 / spine". | Naming only. |
| P2-2 (gap 2) | Phase 2a closes on a **G-4 phase-close script** (`ci_gates/gate_g4_phase2a.sh`): every 2a route reachable and covered by a test, plus a re-run of G-2 over the new read routes and forensic test 3 against the real engine. | No gate is named for Phase 2; G-4 is the generic phase-close script (L8490). | A differently named gate later; the checks stay. |
| P2-3 (gaps 3, 4) | **Outcomes:** `CLEAR`, `FLAG`, `POSSIBLE_CANDIDATE_REVIEW`; precedence FLAG > POSSIBLE_CANDIDATE_REVIEW > CLEAR. A **FLAG** needs a role-crossing hit on a *confirmed identity*. A role-crossing hit on a *candidate identity* (name-only fuzzy match ≥ 0.80, or a key match whose link is still a candidate) is POSSIBLE_CANDIDATE_REVIEW, never FLAG and never CLEAR. | Reconciles v6's 80% fuzzy screen (L1242) with L17.2 #15 "no candidate link is used … as evidence of identity" and L18 §7.4. | Over-reporting review items; under-reporting is ruled out by "never CLEAR". |
| P2-4 (gap 3) | **Role-crossing** means: the subject's role differs from the hit's role in a way that puts the firm on both sides, i.e. a prospective *client* hits an existing *opposing party*, or a prospective *opposing party* hits an existing *client*. Same-role hits (client↔client, opposing↔opposing) are reported as `informational` and never raise the result. Conflict types are recorded per hit: `direct_adverse` (opposing ↔ current client with a live matter), `former_client` (opposing ↔ client whose matters are all closed), `adverse_history` (client ↔ past opposing party). | Standard conflict doctrine; the architecture names only client vs opposing party (L1241). | Firm may later want positional or group conflicts (2b+). |
| P2-5 (gap 24, test 3) | **Identity basis:** an exact key match (CNIC, NTN, SECP number, E.164 phone) is `confirmed` only once its entity link is `confirmed` (human-confirmed, or auto-confirmed 30 days after creation without dispute, L18 §7.1); before that it is `candidate`. A subject that resolves to an entity with an unresolved candidate link to another entity yields POSSIBLE_CANDIDATE_REVIEW (forensic test 3). Every result carries `identityBasis` (`confirmed_identity` or `candidate_only`) per hit and overall. | L18 §7.1, §7.4; L17.2 #18; forensic test 3 (L8495). | None beyond P2-3. |
| P2-6 (gaps 7, 9) | **Timing:** the check runs *before* the matter exists. `createMatter` requires a `conflictCheckId` in the same firm, run by any staff member within the last 30 days, whose subjects equal the matter's client and opposing parties, and whose decision is `cleared` (result CLEAR, or a FLAG waived, or every review item resolved). A check is single-use: it binds to the matter it opened. `matter.created` is still emitted (Conflict records the binding, it does not gate). | "A documented, defensible conflict decision before any matter is opened" (L1253); "a FLAG blocks promotion" (L1243). | A stale check could be reused within 30 days; mitigated by single use and subject equality. |
| P2-7 (gap 9) | **Resolving POSSIBLE_CANDIDATE_REVIEW:** a partner or associate resolves each review hit as `different_person` (with a note of at least 20 characters) or `same_person`. `same_person` turns that hit into a confirmed role-crossing hit, so the check becomes FLAG and needs a partner waiver. | Entity band review goes to "the responsible associate" (L6936); waiver is partner-only (L1244). | Associates can clear identity questions; partners can audit them in the trail. |
| P2-8 (gap 8) | **Waiver:** partner only; clearance at least the check's classification; written note of at least 50 characters; `clientConsent` must be `true` with a `consentReference` (letter or message id); one waiver per check, immutable, no expiry, no revocation (a changed position needs a new check). The waiving partner may be the requester (firms may have one partner); the trail records both. | L1244 "partner waiver with a mandatory written note; immutable trail". Informed consent is the professional-conduct norm for conflict waivers; the architecture is silent, so the stricter reading wins. | A firm may not want consent mandatory; easy to relax, hard to retro-fit. |
| P2-9 (gaps 5, 6) | **Data model:** new collections `conflict_checks` (one per check, append-only fields once decided), `conflict_events` (immutable trail rows: requested, decided, review_resolved, waived, bound), `matter_parties` (the adverse-party registry: one row per party per matter: role `client` or `opposing`, names, keys, matterId). Standalone registry rows (e.g. a declined enquiry's opponent) are `matter_parties` rows with `matterId: null`, created by a partner. | v6 §16 names `conflicts`; L18 §5.2 omits it; a per-row registry is queryable and rules-friendly. | Rename later is cheap before data exists. |
| P2-10 (gap 12) | **Clients:** a `clients` doc per L18 §5.2 plus the L7.2 fields (type, companyName, reference, primaryMobile, alternateMobile, concernedPersonName, email, cnic, ntn, secpNumber, address, corporateGroup) and `entityId` pointing at its `entities` row. E-39(5) ("clients are stored as entities") is satisfied by the entity row; the client doc carries the professional relationship. | L18 §5.2 is the governing schema; the existing rules already have a `clients` block. | Two writes per registration (one transaction). |
| P2-11 (gaps 13, 14) | **Numbering:** client code `{clientPrefix}-{YYYY}-{NNNN}` and matter number `{matterPrefix}/{YYYY}/{NNNN}`, each from a per-firm per-year atomic counter (`counters/{firmId}_{kind}_{YYYY}`, transaction). Prefixes are firm fields (`clientPrefix`, `matterPrefix`), 2-6 uppercase letters, set by a partner (`setFirmNumbering`); unset → 409 `numbering_not_configured`. Year is Asia/Karachi. NNNN zero-pads to 4 and grows past 9999. | L6656: "the NHS/YYYY/NNNN atomic matter numbering … is the reference implementation". The type-code variant (L1153) has no type-code table. | Adding a type code later changes new numbers only. |
| P2-12 (gap 15) | **Status vs stage:** `status` ∈ `engagement_unconfirmed`, `live`, `closed` (engagement per L17.6); `stage` ∈ `pre_filing → filed → hearing → reserved → decided → archived`, advanced one step at a time by a partner or associate member, each transition an immutable `matter_events` row. `closeMatter` (partner member) sets `status: closed` and requires stage `decided` or a closure reason. | L1154 "enforced stage flow … each transition logged". | Firms may want backward moves (appeal); a later erratum. |
| P2-13 (gap 16) | **Matter classification** is required at creation (no default) and capped at the creator's clearance. Conflict check records are classified `confidential` unless a hit touches a higher-classified matter, then `max` (monotonic, L17.3 #20). | L8473 classification guard: an artefact write never omits classification. | None. |
| P2-14 (gap 17) | **Permission actions** (added to the shared decision table): `client.register`, `client.read` (staff: partner, associate, clerk, intern within clearance), `matter.open` (partner, associate), `matter.advance_stage`, `matter.close` (partner member), `conflict.run`, `conflict.resolve_review` (partner, associate), `conflict.waive` (partner), `conflict.read_trail` (partner, or the requester for their own check), `firm.set_numbering` (partner), `matter.read` (staff members within clearance). Clients and accounts are denied all of them. | No D1 action names exist (gap 17); roles from the existing 6-role model. | Adjustable in one table. |
| P2-15 (gap 25) | **Disclosure:** the requester sees the outcome, hit count, and per hit: subject, hit role, conflict type, identity basis, matched name, and the matter number only if the requester is a member of that matter; otherwise `matter: "restricted"`. Partners see full hit detail if their clearance covers the hit's matter classification. | R-2 (no matter access without membership) vs Rule 85 screening across all matters; partners own waivers. | An associate needs a partner to see a restricted hit's matter. |
| P2-16 (gaps 4, 23) | **Matching engine** (pure, `functions/src/d1/conflict/match.ts`): normalise (lowercase, strip honorifics and punctuation, Urdu/Sindhi script → Roman via a seeded character and name table plus the firm's `transliteration_map` rows), expand known variants (محمد → muhammad / mohammad / mohd / m.), token-set ratio (Levenshtein-based) over the Roman forms; hit when ≥ 0.80 on name, or any exact normalised key. Family tokens (Bhutto, Jokhio, Baloch, Memon, Soomro) count as tokens, not noise. No external NLP library and no P1 call. | L1242, L18 §7.2. ICU transliteration is not in Node's Intl (gap 23), so a table it is. | Table coverage grows over time; the firm can add rows. |
| P2-17 (gap 20) | **Limits:** `conflict.run` is a P1-class rate kind (10/min per user, L8156), and a per-firm daily cap of 100 checks (Asia/Karachi day, counter doc) returns 429 `daily_limit` with Retry-After to the next day. No P1 call is made. | L8156-8157; closes the conflict half of E-34. | None. |
| P2-18 (gap 21) | The conflict engine is CORE and runs with every layer flag off; with `L17_2_ENABLED` off it still uses exact keys and name screening but treats every key match as `candidate` (so never FLAG on keys alone without a confirmed link). | "Core must boot and pass G-1 with every layer disabled" (L8456). | Stricter (more review items) when L17.2 is off. |
| P2-19 (gap 10) | Code, tests and UI text cite "PBC Rule 85 [REQUIRES VERIFICATION]" until open item O-11 is closed; the API never returns a rule number. | W-10, O-11. | None. |
| P2-20 (gap 19) | New events in the catalogue: `conflict.decided` (checkId, result, identityBasis) and `conflict.waived` (checkId, partnerId). Emitted to the existing outbox. | Intake needs `conflictCheckId` (L8187). | Catalogue amendment recorded here. |
| P2-21 (gap 27) | A later un-merge (2b) marks every conflict check that relied on the merged link `stale`; a stale check cannot open a matter. 2a stores `reliedOnLinkIds` per hit so 2b can find them. | Prevents a waiver resting on a reverted identity. | Small extra field. |
| P2-22 (gap 11) | Corporate group and related persons are **not** screened in 2a; `corporateGroup` is stored. | Unmodelled in the architecture; YAGNI. | A group conflict is missed until a later part adds it; recorded as open item O-25. |

## 3. Components

All under `functions/src/d1/`, each with a single purpose. Shared pure logic that the Next.js app might reuse lives under `platform/` only if both sides need it (none in 2a).

| Unit | Purpose | Depends on |
| --- | --- | --- |
| `conflict/normalise.ts` | Name and key normalisation; script transliteration; variant expansion. Pure. | seed table `conflict/translit-seed.ts` |
| `conflict/match.ts` | Token-set ratio, hit detection, role-crossing and type classification, outcome precedence. Pure. | normalise |
| `conflict/engine.ts` | Loads candidate rows (clients, matter_parties, entity links) for the firm, runs `match`, builds the check record with disclosure applied per caller. | Firestore, match |
| `conflict/ops.ts` | Operations: `runConflictCheck`, `getConflictResult`, `resolveReviewItem`, `recordPartnerWaiver`, `getConflictTrail`. | engine, P5 permission, audit, rate limit |
| `client/ops.ts` | `registerClient`, `getClient`, `listClients` (cursor pagination), `setFirmNumbering`. | counters, entities |
| `matter/ops.ts` | `openMatter`, `getMatter`, `listMatters`, `advanceStage`, `closeMatter`. | conflict check binding, counters, matter_members |
| `numbering.ts` | Atomic per-firm per-year counters and formatters. | Firestore transaction |
| `pagination.ts` | Opaque cursor (doc id + sort key), limit default 20, max 100. | — |

Routes (all firm-bound, Bearer + X-Firm-Id; POST/PUT carry Idempotency-Key):

```
POST /api/d1/client/registerClient      POST /api/d1/client/setFirmNumbering
GET  /api/d1/client/getClient           GET  /api/d1/client/listClients
POST /api/d1/conflict/runConflictCheck  GET  /api/d1/conflict/getConflictResult
POST /api/d1/conflict/resolveReviewItem POST /api/d1/conflict/recordPartnerWaiver
GET  /api/d1/conflict/getConflictTrail
POST /api/d1/matter/openMatter          GET  /api/d1/matter/getMatter
GET  /api/d1/matter/listMatters         POST /api/d1/matter/advanceStage
POST /api/d1/matter/closeMatter
```

The router gains GET support with query parameters (the router already types GET; no GET routes exist yet).

## 4. Data flow: opening a matter

1. Partner or associate: `registerClient` (or reuses an existing client). Transaction: entity row + client row + `client.created` audit; client code from the counter; exact-key duplicate → returns `possibleDuplicates` (no block; L17.2 "is this the same person?" prompt is the client's job).
2. `runConflictCheck { client: {clientId} | {name, keys}, opposingParties: [{name, keys}] (1-20) }` → engine screens every subject against all firm `clients` and `matter_parties` rows → `conflict_checks/{id}` with result, hits, identityBasis, classification; `conflict_events` row `decided`; `conflict.decided` event.
3. If POSSIBLE_CANDIDATE_REVIEW: `resolveReviewItem` per review hit. If FLAG: `recordPartnerWaiver`.
4. `openMatter { conflictCheckId, title, courtId?, classification, memberUserIds[] }` → transaction: re-read the check (cleared, unbound, not stale, ≤ 30 days, same firm), bind it, allocate the matter number, write `matters`, `matter_members` (creator + listed staff), `matter_parties` rows from the check subjects, `matter_events` (opened), status `engagement_unconfirmed`, stage `pre_filing`; emit `matter.created`.

## 5. Firestore rules

New blocks, default deny everywhere else stays:
- `conflict_checks`, `conflict_events`, `counters`, `transliteration_map`: no client SDK writes; `conflict_checks` client-SDK read only by a same-firm partner (staff) cleared to the check's classification; the stored row is unredacted, so the requester reads through `getConflictResult` (server-side disclosure). `conflict_events` read partner only.
- `matter_parties`: read by same firm AND cleared on `classification` AND (partner OR member of the row's `matterId`); a standalone registry row (`matterId` null) is partner-only; no SDK writes.
- `matter_events`: member read; no SDK writes.
- `matters`: unchanged (create already denied to the SDK; E-38).

## 6. Errors

Existing envelope `{ error: { code } }`. New codes: `numbering_not_configured` (409), `invalid_subjects` (400), `check_not_found` (404), `check_not_cleared` (409), `check_already_bound` (409), `check_stale` (409), `check_expired` (409), `subjects_mismatch` (409), `not_review_item` (409), `already_waived` (409), `consent_required` (400), `note_too_short` (400), `invalid_stage_transition` (409), `daily_limit` (429), `not_waivable` (409), `review_pending` (409), `invalid_member` (400), `invalid_prefix` (400), `invalid_query` / `invalid_limit` / `invalid_cursor` (400), `role_not_permitted` (403), `not_found` (404). Every deny is audited once (CallAudit).

## 7. Testing

- **Unit (pure):** normalise and match against a table of Pakistani name pairs (Muhammad/Mohammad/Mohd, Hussain/Husain, Urdu script → Roman, family tokens), threshold edges (0.79/0.80), role-crossing matrix, precedence, identity basis.
- **Emulator (functions):** every route: happy path, permission denies per role, cross-firm deny, idempotent replay, validation errors, daily limit, opening a matter on uncleared / bound / stale / expired / mismatched checks, waiver rules, review resolution, disclosure masking for a non-member associate.
- **Rules tests:** the new collections.
- **Forensic test 3** against the real engine (two "Muhammad Ali" clients, same CNIC, candidate link → POSSIBLE_CANDIDATE_REVIEW with identityBasis, never CLEAR).
- **G-2 re-run:** the new GET routes cross-firm → deny.
- **G-4 script:** fails if any 2a route lacks a test that calls it.

## 8. Out of scope (recorded)

2b entity review and un-merge; 2c R2 storage; CNIC photo capture (L13.2); relevant_law_dates (L17.1); hearings, diary, reminders, fee notes, pending updates (Module 2 adjuncts); intake (D1-3); corporate-group screening (O-25); the Next.js D1 routes (retire with the Flutter shell).
