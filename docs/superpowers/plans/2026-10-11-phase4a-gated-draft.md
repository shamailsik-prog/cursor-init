# Phase 4a: the gated draft in Cloud Functions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner-approvable draft record in Cloud Functions. Drafts carry versions, a restore path and a lock. Every version passes the Module 33 citation gate (with temporal checks) before a partner can approve it. A non-OK gate is cleared only by an audited partner override bound to that exact version.

**Architecture:**
- **Pure gate core.** The citation extractor, the charset checks and a new pure verdict module (`services/d4-2/citationVerdict.ts`), shared with the Next.js tree.
- **Functions D4 package (`functions/src/d4/`).** The `AuthorityStore` port (empty in production until the corpus connector exists), the gate runner, the document-type seed reader, and the HTTP operations under `/api/d4/drafting/` and `/api/d4/intelligence/`.

**Tech Stack:** TypeScript Cloud Functions (`functions/`), Firestore Admin SDK, vitest (unit tests, and tests against the Auth and Firestore emulators).

**Spec:** `docs/superpowers/specs/2026-10-11-phase4a-gated-draft-design.md` (rulings P4-1 to P4-15, E-50, E-51, O-59 to O-67).

## Global Constraints

- **Routes.**
  - `/api/d4/drafting/` holds `createDraft`, `saveDraftVersion`, `restoreDraftVersion`, `getDraft` (GET), `listDrafts` (GET), `listDraftVersions` (GET), `overrideGate` and `approveDraft`.
  - `/api/d4/intelligence/` holds `listDocumentTypes` (GET), `getTypeProfile` (GET), `gateDraft` and `getVerificationReport` (GET).
  - All routes use rate kind `general`.
- **Actions.**
  - `draft.create`, `draft.edit`, `draft.gate` and `draft.read`: partner, associate and clerk; matter-level.
  - `draft.override` and `draft.approve`: partner; matter-level.
  - `doctype.read`: partner, associate and clerk; firm-level.
- **Collections.**
  - `drafts`, `draft_versions/{draftId}_{n}`, `draft_gate_results/{draftId}_{n}` and `draft_gate_overrides/{draftId}_{n}`. All client writes are denied.
  - `draft_gate_results` and `draft_gate_overrides` are also unreadable by clients.
- **Statuses.**
  - Per authority: `VERIFIED`, `UNVERIFIED`, `OVERRULED`.
  - Per temporal check: `OK`, `TEMPORAL_MISMATCH`, `TEMPORAL_UNAVAILABLE`.
  - Overall, in severity order: `OVERRULED`, `TEMPORAL_MISMATCH`, `UNVERIFIED`, `TEMPORAL_UNAVAILABLE`, `OK`.
- **Size caps.**
  - Body: at most 500,000 characters (the charset rule) and at most 900,000 UTF-8 bytes, else 422 `draft_too_large`.
  - Title: 1 to 500 characters.
  - Temporal checks: at most 20, each with `usedText` of 1 to 10,000 characters.
  - Override reason: 20 to 2,000 characters after trimming.
- **Error codes.**
  - 400: `matter_required`, `invalid_document_type`, `invalid_title`, `invalid_body`, `invalid_classification`, `invalid_version`, `invalid_temporal_checks`, `invalid_reason`.
  - 404: `not_found`, `document_type_not_found`, `version_not_found`.
  - 409: `draft_changed`, `draft_locked`, `not_gated`, `nothing_to_override`, `already_overridden`, `gate_blocked`.
  - 422: `court_mismatch`, `classification_below_matter`, `unsupported_characters`, `draft_too_large`, `title_too_long`.
  - 403: `clearance`.
- **Events.**
  - Names: `draft.autosaved`, `draft.gated`, `draft.approved`.
  - Payload: `{ draftId, matterId, documentTypeId, version, gateResult: status | null, masterVersion: null }`.
  - Classification: the draft's.
  - Id: `<draftId>_<version>_<autosaved|gated|approved>`. A re-gate of the same version uses `<draftId>_<version>_gated_<n>`, where n is the count of gate runs, so ids never collide.
- **Audit actions.** `draft.create`, `draft.edit`, `draft.gate`, `draft.gate_override`, `draft.approve`, each in the decision's transaction.
- **Test fixtures.** Citations use the year 2099 only (e.g. `PLD 2099 SC 101`, `2099 SCMR 7`). Statute ids look like `test_act_s1`. No real judgment or statute is named in any test.
- **Toolchain.** Functions lint at zero warnings, a clean `npx tsc --noEmit -p functions`, and the root `npm run typecheck` / `npm run lint` (shared `platform/` and `services/` files). Emulator tests run from the repo root with `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- <files>"`.
- **Existing tests.** Never weaken or skip an existing test. Rules tests that asserted client writes to `drafts` or `draft_versions` are amended to assert denial (P4-11), and the commit says so. A pinned route, action or collection list may be extended.

## Review Focus

1. **A body change after a gate or an override.**
   - A save after a gate must make `approveDraft` refuse (`draft_changed` or `not_gated` for the new version).
   - An override for version n never clears version n+1.
   - Approving version n after version n+1 exists is `draft_changed`.
2. **A corpus change between the override and the approval.** An authority cleared as UNVERIFIED that the store now reports OVERRULED blocks approval (`gate_blocked`).
3. **A forged or cross-firm override.**
   - An intern, an associate, a partner of another firm, or a partner who is not a member of the matter cannot override or approve.
   - The override records the authenticated caller, never a body field.
4. **Concurrent saves.** Two saves on the same `baseVersion` give exactly one new version, and the other save gets `draft_changed`. The version numbers are dense: 1, 2, 3 and so on.
5. **Hostile text.** Bidirectional or invisible characters, or confusables, in the title or body give 422 `unsupported_characters` before anything is stored or gated. Urdu text near the byte cap is refused (422), never truncated.

---

### Task 1: The pure gate core (P4-2, P4-3, P4-6, P4-13)

**Files:**
- Create:
  - `services/d4-2/citationVerdict.ts`
  - `functions/src/d4/types.ts`
  - `functions/src/d4/authority.ts`
  - `functions/src/d4/gate.ts`
  - `functions/src/d4/doctypes.ts`
- Modify: `services/d4-2/draftingIntelligence.ts` (`verdictFor` delegates; no behaviour change)
- Test: `functions/test/d4.gate.test.ts`, `functions/test/d4.doctypes.test.ts`, `tests/citationVerdict.test.ts`

**Interfaces (produces):**
- `services/d4-2/citationVerdict.ts`:
  - `type Bench = "single" | "division" | "full" | "larger"`
  - `benchRank(b: Bench): number` (1 to 4)
  - `type TreatmentFact = { kind: string; treatingJudgmentBench: Bench | null; recordedTreatingBench: Bench }`
  - `verdictFromTreatments(treatedBench: Bench, treatments: readonly TreatmentFact[]): "VERIFIED" | "UNVERIFIED" | "OVERRULED"`. Only `kind === "overruled"` counts. It returns OVERRULED if some overruling has a `treatingJudgmentBench` that outranks the treated bench, or a `recordedTreatingBench` of `"larger"`. It returns UNVERIFIED if overrulings exist but none qualifies. Otherwise it returns VERIFIED.
- `functions/src/d4/types.ts`:
  - `CitationStatus`, `TemporalStatus`, `GateStatus`
  - `type CitationFinding = { ref: string; judgmentId: string | null; status: CitationStatus }`
  - `type TemporalCheck = { sectionId: string; asAtDate: string; jurisdiction: string; usedText: string }`
  - `type TemporalFinding = TemporalCheck & { status: TemporalStatus; inForceText: string | null }`
  - `type GateEvaluation = { status: GateStatus; citations: CitationFinding[]; temporal: TemporalFinding[] }`
  - `GATE_SEVERITY: readonly GateStatus[]`
- `functions/src/d4/authority.ts`:
  - `interface AuthorityStore { findJudgment(canonical: string): Promise<{ judgmentId: string; benchType: Bench } | null>; listTreatments(judgmentId: string): Promise<TreatmentFact[]>; getSectionAsAt(sectionId: string, asAtDate: string, jurisdiction: string): Promise<{ text: string } | "no_history"> }`
  - `EMPTY_AUTHORITY_STORE`, whose `getSectionAsAt` always returns `"no_history"`
  - `class InMemoryAuthorityStore implements AuthorityStore`, with `addJudgment(id, citation, bench)`, `addTreatment(treatingId, treatedId, kind, recordedTreatingBench)` and `addSectionVersion(sectionId, jurisdiction, effectiveFrom, effectiveTo | null, text)`
  - `activeAuthorityStore(): AuthorityStore`
  - `setAuthorityStoreForTests(s: AuthorityStore | null): void`, which throws when `NODE_ENV === "production"`
- `functions/src/d4/gate.ts`:
  - `runGate(input: { title: string; body: string; temporalChecks: readonly TemporalCheck[] }, store: AuthorityStore): Promise<GateEvaluation>`
  - It extracts with `extractCitations(title + "\n" + body)` and de-duplicates by judgment id or canonical ref, as the Next.js `verifyCitations` does. It sends `UNRECOGNISED:` refs to UNVERIFIED without querying the store.
  - Temporal entries compare after NFC on both sides.
  - The overall status is the most severe across citations and temporal entries, or `OK` when both lists are empty.
- `functions/src/d4/doctypes.ts`:
  - `type DocumentType` (the seed row)
  - `getDocumentType(id: string): DocumentType | null`, which returns only rows with status `VERIFIED`
  - `listDocumentTypes(filter: { category?: string; courtId?: string; q?: string }): DocumentType[]`, sorted by id
  - `courtAllowed(type: DocumentType, courtId: string | undefined): boolean`, true when `courtId` is undefined

- [ ] **Step 1: Write failing tests.**
  - `tests/citationVerdict.test.ts`:
    - no treatments gives VERIFIED;
    - `followed` gives VERIFIED;
    - overruled by a bench that outranks the treated one gives OVERRULED;
    - overruled with `recordedTreatingBench: "larger"` gives OVERRULED;
    - overruled by an equal bench with no record gives UNVERIFIED;
    - overruled with `treatingJudgmentBench: null` and `recordedTreatingBench: "division"` against a `full` bench gives UNVERIFIED.
    - The existing Next.js `tests/citations.*` and `tests/drafts.*` suites stay green unchanged.
  - `functions/test/d4.gate.test.ts` (in-memory store, 2099 fixtures):
    - The G-1 test 4 core: `PLD 2099 SC 101` (division) overruled by a larger bench gives OVERRULED overall.
    - An unknown citation gives UNVERIFIED.
    - An `UNRECOGNISED:` suspect gives UNVERIFIED and is never looked up (use a spy store).
    - The same citation written two ways gives one finding.
    - Severity order: OVERRULED + UNVERIFIED gives OVERRULED, and TEMPORAL_MISMATCH + UNVERIFIED gives TEMPORAL_MISMATCH.
    - The G-1 test 5 core: section `test_act_s1` (jurisdiction `PK`) has 2015 text A (effective 2010-01-01 to 2018-06-01) and 2018 text B. A check dated 2015-03-01 using text B gives TEMPORAL_MISMATCH with `inForceText: A`. The same check using A gives OK.
    - No history gives TEMPORAL_UNAVAILABLE.
    - A wrong jurisdiction gives TEMPORAL_UNAVAILABLE.
    - An empty body and no checks give OK.
    - `EMPTY_AUTHORITY_STORE` turns every citation UNVERIFIED and every check TEMPORAL_UNAVAILABLE.
    - The seam throws in production.
  - `functions/test/d4.doctypes.test.ts`:
    - `getDocumentType("constitutional_petition_199")` returns the seed row;
    - an unknown id returns null;
    - `courtAllowed` for a listed court, an unlisted court, and undefined;
    - the list filter by `courtId` and `q` (case-insensitive name match) is sorted.
- [ ] **Step 2: Run them and see them fail.**
  - `npm --prefix functions test -- d4.gate d4.doctypes`
  - `npx vitest run tests/citationVerdict.test.ts`
- [ ] **Step 3: Implement.**
  - Make `draftingIntelligence.ts`'s `verdictFor` build the `TreatmentFact` list from its store: `treatingJudgmentBench` is the treating judgment's bench if known, otherwise null. It then calls `verdictFromTreatments`.
- [ ] **Step 4: Run** the tests above, plus `npx vitest run tests/citations tests/drafts tests/gate_g1.test.ts`. Then run typecheck and lint for the root and for functions.
- [ ] **Step 5: Commit.** `feat(d4): pure citation verdict, authority port, gate runner and document-type seed reader (P4-2, P4-3, P4-6)`

### Task 2: The draft store and the document-type routes (P4-4, P4-5, P4-10, P4-11, P4-12)

**Files:**
- Create: `functions/src/d4/drafts.ts` (operations and the shared draft view), `functions/src/d4/doctypeOps.ts`
- Modify:
  - `platform/p5/permissionDecision.ts` (the `DRAFT_ACTIONS` family and `doctype.read`)
  - `functions/src/p5/permission.ts`
  - `functions/src/http/router.ts`
  - `firestore.rules`
  - the rules tests that pin `drafts` and `draft_versions` client writes
  - `functions/test/g2.cross-firm.test.ts`
  - any pinned route or action list
- Test:
  - `functions/test/d4.drafts.emu.test.ts`
  - `tests/firestore.rules.d4-phase4a.test.ts` (added to `test:rules`)

**Interfaces:**
- Consumes: Task 1 (`getDocumentType`, `courtAllowed`, `listDocumentTypes`); `requireSupportedDraftBody` and `requireSupportedDraftTitle` (`@/services/d4-2/draftCharset`, which throws `DraftCharsetError` with `.code`).
- Produces:
  - Operations: `createDraftOp`, `saveDraftVersionOp`, `restoreDraftVersionOp`, `getDraftOp`, `listDraftsOp`, `listDraftVersionsOp`, `listDocumentTypesOp`, `getTypeProfileOp`.
  - `loadDraftForCaller(caller, draftId, action): Promise<{ ref, draft }>`. It runs the permission check on the draft's matter. It returns 404 `not_found` for a draft that is absent or cross-firm.
  - `type DraftView = { draftId, matterId, documentTypeId, title, classification, status, currentVersion, currentBodySha256, locked, masterVersion, gateResult, approvedBy?, approvedAt?, approvedVersion?, createdBy, createdAt, updatedAt }`.
  - `getDraft` returns `DraftView & { version, body }`, for the current version or a requested one.

**Operation contracts:**
- `createDraft { matterId, documentTypeId, title, body, classification? }`.
  - Validates the input, then checks `draft.create` on the matter, then reads the matter (404).
  - Court check: 422 `court_mismatch`. Classification check: 422 below the matter's label; result is the strictest label. Clearance check: 403.
  - Applies the charset, size and byte checks.
  - One transaction writes the draft, version 1 (`kind: "create"`), the `draft.autosaved` event and the audit row.
  - Returns `DraftView`.
- `saveDraftVersion { draftId, baseVersion, title, body }`.
  - `draft.edit`. A locked draft gives 409 `draft_locked`. A `baseVersion` that is not the current version gives 409 `draft_changed`, checked inside the transaction.
  - An identical title and body give `{ saved: false, draft }`. Otherwise it writes version n+1 (`kind: "save"`) and returns `{ saved: true, draft }`.
- `restoreDraftVersion { draftId, baseVersion, fromVersion }`.
  - As save, with the content of `fromVersion` (404 `version_not_found`), `kind: "restore"` and `restoredFrom`.
- `getDraft ?draftId&version?`, `listDrafts ?matterId&limit&cursor` and `listDraftVersions ?draftId&limit&cursor`.
  - These use `draft.read`.
  - Lists paginate with `functions/src/d1/pagination.ts`. They return metadata only, without bodies, newest first.
- `listDocumentTypes ?category&courtId&q&limit&cursor` and `getTypeProfile ?typeId`. Both use `doctype.read`.

- [ ] **Step 1: Write failing tests.** Cover every contract above. Also cover:
  - **Permissions:** interns and clients are denied; a non-member is denied; a cross-firm draft gives 404.
  - **Concurrent saves:** two `saveDraftVersion` calls on the same base give exactly one success and one `draft_changed`, and the versions are dense.
  - **Rejected text:** a hostile-character body gives 422 `unsupported_characters` and stores nothing. An Urdu body over 900,000 bytes but under 500,000 characters gives 422 `draft_too_large`.
  - **Events and audit:** one event and one audit row per stored version, and none for an identical save.
  - **Rules:** clients cannot write `drafts`, `draft_versions`, `draft_gate_results` or `draft_gate_overrides`, and cannot read the last two.
  - **G-2:** probes for the 8 new firm routes.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `d4.` with `g2.cross-firm`, `p5.` and `http.test` under the emulators. Then run `npm run test:rules`, `npm run test:unit`, and typecheck and lint for both the root and functions.
- [ ] **Step 5: Commit.** `feat(d4): draft store — create, save, restore, read, document types; server-only draft rules (P4-4, P4-5, P4-10..P4-12)`

### Task 3: Gate, override and approval routes (P4-6..P4-9, P4-12, P4-14 tests)

**Files:**
- Create: `functions/src/d4/gateOps.ts`
- Modify: `functions/src/http/router.ts`, `functions/test/g2.cross-firm.test.ts`
- Test: `functions/test/d4.gate.emu.test.ts`

**Interfaces:**
- Consumes: Task 1's `runGate`, `activeAuthorityStore` and `InMemoryAuthorityStore`, and Task 2's `loadDraftForCaller` and `DraftView`.
- Produces: `gateDraftOp`, `getVerificationReportOp`, `overrideGateOp`, `approveDraftOp`.

**Operation contracts:**
- `gateDraft { draftId, version, temporalChecks? }`.
  - `draft.gate`. A version that is not current gives 409 `draft_changed`.
  - Validates `temporalChecks`: `sectionId` matches `/^[A-Za-z0-9_.:-]{1,200}$/`; `asAtDate` is a valid `YYYY-MM-DD` calendar date; `jurisdiction` is 1 to 50 characters; `usedText` is 1 to 10,000 characters; at most 20 entries. Otherwise 400 `invalid_temporal_checks`.
  - Runs the gate on the stored version's title and body.
  - In one transaction it sets `draft_gate_results/{draftId}_{version}` (`GateResult`), the draft's `gateResult` summary (`overridden: false`, unless an override doc for that version and hash exists), the `draft.gated` event and the audit row.
  - Returns the `GateResult`.
- `getVerificationReport ?draftId`.
  - `draft.read`. Returns `{ gateResult: GateResult | null, override: OverrideView | null, current: boolean }`, where `current` means the result's version and hash equal the draft's current ones.
- `overrideGate { draftId, version, reason }`.
  - `draft.override`.
  - Refusals, with codes: a version that is not current (409 `draft_changed`); no result for it (409 `not_gated`); a result with status OK (409 `nothing_to_override`); an existing override doc (409 `already_overridden`); a reason outside 20 to 2,000 characters after trimming (400 `invalid_reason`).
  - Creates the immutable override doc. `cleared` holds every non-OK citation (`{ kind: "citation", ref, status }`) and temporal entry (`{ kind: "temporal", sectionId, asAtDate, jurisdiction, status }`).
  - Sets `gateResult.overridden: true` and writes the audit row (`draft.gate_override`, targeting the override doc).
- `approveDraft { draftId, version }`.
  - `draft.approve`. A locked draft gives 409 `draft_locked`; a version that is not current gives 409 `draft_changed`; no stored result gives 409 `not_gated`.
  - Re-runs the gate with the stored result's temporal checks, against the authority store as it is now.
  - It passes in two cases: the fresh status is OK; or an override exists with the same hash and every non-OK fresh item matches a cleared item by key and status.
  - On pass, one transaction does the following:
    - stores the fresh result;
    - sets `status: "approved"`, `locked: true`, `approvedBy`, `approvedAt` and `approvedVersion`;
    - writes the `draft.approved` event and the audit row.
  - Otherwise it gives 409 `gate_blocked`, with the fresh findings in the error details if the router supports details. If it does not, the result is stored and the caller reads it with `getVerificationReport`.

- [ ] **Step 1: Write failing emulator tests,** with `setAuthorityStoreForTests(new InMemoryAuthorityStore())` seeded with 2099 fixtures.
  - **G-1 test 4 equivalent**, named exactly `G-1 test 4: an authority overruled by a larger bench blocks approval until the matter's partner overrides with a reason`.
    - Gating gives OVERRULED, and approval gives `gate_blocked`.
    - These callers' overrides are refused: an intern; an associate; a partner of another firm (404); a partner of the same firm who is not a member of the matter (403); a partner whose reason is shorter than 20 characters.
    - The member partner's override succeeds and its audit row targets the override doc.
    - Approval then succeeds, the draft is locked, and `draft.approved` is written once.
  - **G-1 test 5 equivalent**, named exactly `G-1 test 5: a 2015-dated check against a section amended in 2018 is TEMPORAL_MISMATCH with both texts; no history is TEMPORAL_UNAVAILABLE`.
  - **Pinning:**
    - gate version 1, save version 2, approve version 1: `draft_changed`;
    - approve version 2: `not_gated`;
    - an override of version 1 does not clear version 2 (approving version 2 after gating it is `gate_blocked`).
  - **Corpus change:** override an UNVERIFIED citation, then seed an overruling by a larger bench in the store, then approve: `gate_blocked`.
  - **Re-gate:** gating the same version twice replaces the result and writes two distinct `draft.gated` events.
  - **Lock:** a locked draft refuses save and restore.
  - **Verification report:** `getVerificationReport` returns `current: false` after a save.
  - **Production store:** with the empty store, every draft that has a citation needs an override to approve.
  - **G-2:** probes for the 4 new routes.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `d4.` with `g2.cross-firm` under the emulators, then typecheck and lint.
- [ ] **Step 5: Commit.** `feat(d4): citation gate, partner override and approval stand-in on Cloud Functions (P4-6..P4-9, G-1 tests 4 and 5)`

### Task 4: Gate, CI and records (P4-14, E-50, E-51, O-59..O-67)

**Files:**
- Create: `ci_gates/gate_g4_phase4a.sh`, `functions/src/d4/README.md`
- Modify:
  - `package.json` (`gate:g4:phase4a`)
  - `.github/workflows/gate-g0.yml` (a step after Phase 3d)
  - `ci_gates/check_route_coverage.py` (if it pins domains)
  - `docs/architecture/ERRATUM_SET_2_PROPOSED.md` (E-50, E-51; E-39(1) and E-39(2) closed; O-59 to O-67)
  - `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md` (P4-1 to P4-15)

- [ ] **Step 1: Write the gate script,** modelled on `ci_gates/gate_g4_phase3d.sh`. It includes route coverage, the named tests (the two G-1 equivalents, pinning, the corpus change, concurrent saves, hostile text and the rules), functions lint and G-2.
- [ ] **Step 2: Run** `npm run gate:g4:phase4a` locally.
- [ ] **Step 3: Add the CI step and the records.**
- [ ] **Step 4: Run the full functions emulator suite once.** Then run `npm run gate:g0`, `npm run lint`, `npm run typecheck` and `npm run test:unit`.
- [ ] **Step 5: Commit.** `ci: gate:g4:phase4a in CI; record Phase 4a rulings and errata (E-50, E-51, E-39(1)-(2) closed, O-59..O-67)`
