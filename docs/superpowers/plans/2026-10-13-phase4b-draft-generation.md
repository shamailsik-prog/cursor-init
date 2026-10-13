# Phase 4b: draft generation through P1 and the 4a gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An advocate's facts become a gated draft a partner can approve: `startDraft` → `generateOutline` (one P1 call) → `approveOutline` → `generateDraft` (one P1 call per section) → assembly as version 1 of a 4a draft, born gated, in one transaction.

**Architecture:**
- **P1** (`functions/src/p1/`, `platform/p1/`). A second task type `drafting`, routed to the one priced model. A `truncated` flag read from `finish_reason`. An indexed pseudonymiser beside the lossy mask, whose one map serves the request and the response and is returned to the in-process caller only.
- **D4 generation** (`functions/src/d4/`). A generation store (brief, outlines, sections) with an empty template port. Around each synchronous P1 call: a lease, a time budget and fail-closed guardrails. One assembly transaction writes the 4a `drafts` row, version 1, its gate result, three events and the audit row, so no generated version exists ungated.
- **Gate and records.** `gate:g4:phase4b`, G-2 probes for the seven routes, errata E-52 and E-53, open items O-77 to O-86, and the rulings ledger.

**Tech Stack:** TypeScript Cloud Functions (`functions/`), the Firestore Admin SDK, and vitest: unit tests, Auth and Firestore emulator tests, and `@firebase/rules-unit-testing` for the rules.

**Spec:** `docs/superpowers/specs/2026-10-13-phase4b-draft-generation-design.md` (rulings P4B-1 to P4B-22, errata E-52 and E-53, open items O-77 to O-86). Executors read the spec and this plan together. Where this plan decides something the spec leaves open, the decision is listed under "Plan decisions" (D1 to D22) and is recorded in the ledger in Task 5.

## Global Constraints

**Routes** (P4B-1, "Routes"). All are under `/api/d4/drafting/`. Every POST needs an `Idempotency-Key`. `generateOutline` and `generateDraft` are rate kind `p1` (10 per minute); the other five are `general`. Lists paginate as in 4a (`?limit=` 1 to 100, default 20; `?cursor=`).

| Route | Method | Action | Input | Returns |
| --- | --- | --- | --- | --- |
| `startDraft` | POST | `draft.create` | `{ matterId, documentTypeId, title, facts, verbatim?, partyNames?, classification? }` | `{ generationId, stage, classification, outlineVersion }` |
| `generateOutline` | POST | `draft.generate` | `{ generationId, baseOutlineVersion }` (the new version is base + 1) | `OutlineStepResult` |
| `approveOutline` | POST | `draft.outline.approve` | `{ generationId, outlineVersion, outlineSha256, outline?, acknowledgedMissingFacts }` | `{ generationId, stage, outlineVersion, outlineSha256, sectionCount }` |
| `generateDraft` | POST | `draft.generate` | `{ generationId, outlineVersion, section }` | `SectionStepResult` |
| `getGeneration` | GET | `draft.read` | `?generationId=` | the brief, with `inFlight` shown as `inProgress: boolean` |
| `getOutline` | GET | `draft.read` | `?generationId=&version=` (default: the current version) | the outline, with `approved: boolean` |
| `listGenerations` | GET | `draft.read` | `?matterId=&limit=&cursor=` | cleared briefs, newest `updatedAt` first, without `facts`, `verbatim`, `partyNames` or `unsupportedRefs` |

**Step results.**
- `OutlineStepResult` is `{ generationId, stage, step: "outline", outlineVersion, called, outcome, reason, path, model, usage: { inputTokens, outputTokens, costMicroUsd }, usageLogId, traceId }`. `usage`, `usageLogId` and `traceId` belong to this request, and are zero or null when `called` is false.
- `SectionStepResult` has the same fields with `step: "section"`, plus `section`, `assembly` (`"none"`, `"assembled"`, `"refused"` or `"pending"`), `assemblyReason` and `draftId`.
- A POST response never carries text: no facts, no outline, no section, no refused refs (P4B-14).

**Order in the P1 routes** (both `generateOutline` and `generateDraft`). The first refusal wins.
1. Parse (400).
2. Load the brief and check the permission.
3. A closed matter: 409 `matter_closed`.
4. A stored document for this step: return it with `called: false`, assembling if due.
5. 409 `generation_closed`.
6. The approval and version checks: `outline_changed`, `outline_not_approved`, `section_not_found`, `previous_section_missing`.
7. A live lease: 409 `generation_in_progress`.
8. `deterministicFirstCheck` (501).
9. The lease transaction.
10. `callP1`.
11. The guardrails.
12. The outcome transaction: totals, `lastAttempt`, lease release, and the outline or section if accepted.
13. Assembly, when due.

**Outcomes** (a 200 body).
- `stored`: `reason` is null.
- `blocked`: `reason` is one of `kill_switch_platform`, `kill_switch_firm`, `policy_denied`, `not_minimised`, `model_unpriced`, `budget_not_set`, `budget_exhausted`, `no_credentials`.
- `failed`: `reason` is `transport_error`.
- `refused`: `reason` is one of `output_truncated`, `output_unparseable`, `rehydration_failed`, `output_too_large`, `output_unsupported_characters`, `unsupported_authority`.
- `assembly: "refused"` carries an `assemblyReason`: `draft_too_large`, `gate_result_too_large`, `matter_closed` or `court_mismatch`.

**Error codes.** An error body is only `{ error: { code } }`.
- 400: `matter_required`, `invalid_document_type`, `invalid_title`, `invalid_facts`, `invalid_verbatim`, `invalid_party_names`, `invalid_classification`, `invalid_generation_id`, `invalid_version`, `invalid_outline_hash`, `invalid_outline`, `invalid_acknowledgement`, `invalid_section`, `invalid_cursor`, `invalid_limit`.
- 403: `clearance`, and the codes `requirePermission` maps: `not_member`, `role_not_permitted`, `intern_channel_denied`, `client_denied`, `accounts_register_only`.
- 404: `not_found`, `document_type_not_found`, `outline_not_found`, `section_not_found`.
- 409: `matter_closed`, `generation_closed`, `outline_changed`, `outline_not_approved`, `previous_section_missing`, `generation_in_progress`, `generation_changed`.
- 422: `court_mismatch`, `classification_below_matter`, `unsupported_characters`, `title_too_long`, `reserved_tokens`, `missing_facts_not_acknowledged`.
- 501: `deterministic_not_built`.
- 503: `generation_busy`, `audit_unavailable`.

**Parse rules.**
- The 400 checks run before the permission, in field order.
- `baseOutlineVersion` is an integer ≥ 0. `outlineVersion`, `version` and `section` are integers ≥ 1. A query-string `version` is 1 to 9 digits with no leading zero, as 4a's.
- `outlineSha256` is 64 lowercase hex characters.
- `acknowledgedMissingFacts` holds distinct integers from 0 to 49.
- The 422 text rules apply after the permission, so they give no oracle.
- None of the new 409 codes joins `STORED_409_CODES`.

**Limits.** Every length is in UTF-16 code units (`String.length`; D1).
- `title`: 4a's rule (one line, at most 500).
- `facts`: 1 to 100,000.
- `verbatim`: at most 20 `{ field, text }`. `field` is a distinct name from the type's `requiredFields`; `text` is 1 to 10,000; the texts total at most 50,000.
- `partyNames`: at most 50, each 1 to 200.
- An outline has 1 to 25 `{ heading (one line, 1 to 200), purpose (1 to 2,000) }` and 0 to 50 `{ field (one line, 1 to 100), note (1 to 500) }`.
- An answer is at most 200,000 after re-hydration.
- At most 50 `unsupportedRefs` are recorded.
- Every P1 call sends `max_tokens: 4096`.

**Constants.**
- `TASK_MODEL.drafting = "anthropic/claude-opus-5.5"`; the prices are unchanged; the trace name is `p1.drafting`.
- `PROMPT_VERSION = "4b.1"`, `OUTLINE_PURPOSE = "draft-outline"`, `SECTION_PURPOSE = "draft-section"`.
- `D4_PRECALL_BUDGET_MS = 5_000`, `D4_WRITE_DEADLINE_MS = 10_000`, `D4_ATTEMPT_SLACK_MS = 4_000`, `GENERATION_LEASE_MS = 180_000`.
- The import-time check: 60,000 + 2,000 + 30,000 + 10,000 + 5,000 + 10,000 = 117,000 < 120,000, and `D4_ATTEMPT_SLACK_MS < D4_WRITE_DEADLINE_MS`.
- The budget's clock starts at the op's entry (`d4Now()`), never the router's `session.now`, which the emulator suites fix (D23).
- No write attempt (outcome write or assembly) starts later than `D4_WRITE_DEADLINE_MS − D4_ATTEMPT_SLACK_MS` (6,000 ms) after `callP1` returns. The last 4,000 ms are for the attempt in flight, as P1 reserves `COMMIT_ATTEMPT_SLACK_MS` (D24).
- The 3,000 ms left of the 120 s timeout cover the router's own work around the handler (auth, rate limit, the idempotency claim and result write).
- `SECTION_WORD_BUDGET = 1_000` (D25).

**Tokens.**
- An indexed token is `⟦KIND_n⟧`, KIND one of `VERBATIM`, `CNIC`, `PHONE`, `EMAIL`, `IBAN`, `NTN`, `PASSPORT`, `PARTY`, n from 1 per kind.
- The lossy tokens are `[PARTY]`, `[CNIC]`, `[PHONE]`, `[EMAIL]`, `[IBAN]`, `[NTN]`, `[PASSPORT]`.
- Caller text holding `⟦`, `⟧`, a lossy token or a bare token (`/\b(?:PARTY|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT|VERBATIM)_\d+\b/`) is 422 `reserved_tokens` (D26).
- An answer is refused `rehydration_failed` if, after re-hydration, it still holds `⟦`, `⟧`, a lossy token, or `/\b(?:PARTY|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT|VERBATIM)_\d+\b/`.

**Collections** (top-level, `firmId` on every row, written by Functions in transactions).
- **`draft_generations/{auto}`.** Fields: `firmId`, `matterId`, `documentTypeId`, `title`, `facts`, `verbatim`, `partyNames`, `classification`, `stage`, `outlineVersion`, `approvedOutline` (`null` or `{ version, sha256, by, at, acknowledgedMissingFacts: number[] }`), `sectionCount`, `sectionsStored`, `templateId`, `path`, `model`, `promptVersion`, `calls`, `costMicroUsd`, `lastAttempt` (`null` or `{ step, outlineVersion, section, outcome, reason, unsupportedRefs, usageLogId, traceId, costMicroUsd, at, by }`), `inFlight` (`null` or `{ claimId, step, outlineVersion, section, by, leaseUntil }`), `draftId`, `createdBy`, `createdAt`, `updatedAt`.
- **`draft_outlines/{generationId}_{n}`** (immutable). Fields: `firmId`, `matterId`, `generationId`, `version`, `kind` (`generated` or `edited`), `sections`, `missingFacts`, `sha256`, `classification`, `editedFrom`, `path`, `model`, `promptVersion`, `traceId`, `inputTokens`, `outputTokens`, `costMicroUsd`, `usageLogId`, `createdBy`, `createdAt`.
  - `sha256` is the lowercase hex SHA-256 of UTF-8 `JSON.stringify({ sections: [{ heading, purpose }], missingFacts: [{ field, note }] })`, keys in that order, over the stored strings.
- **`draft_sections/{generationId}_{v}_{i}`** (immutable). Fields: `firmId`, `matterId`, `generationId`, `outlineVersion`, `section`, `heading`, `text`, `textSha256`, `classification`, `path`, `model`, `promptVersion`, `usageLogId`, `traceId`, `inputTokens`, `outputTokens`, `costMicroUsd`, `createdBy`, `createdAt`.
- **Stages.**

  | From | Step | To |
  | --- | --- | --- |
  | (none) | `startDraft` | `facts` |
  | any but `assembled` | `generateOutline` | `outlined` (voids any approval) |
  | `outlined`, `approved`, `drafting` | `approveOutline` | `approved` |
  | `approved` | first section stored | `drafting` |
  | `drafting` | assembly | `assembled` (`draftId` set) |

  `generateDraft` runs only in `approved` and `drafting`. In `assembled`, every step but a replay is 409 `generation_closed`.
- **Changes to 4a.**
  - `drafts` gains `generationId`, and `DraftView` returns it.
  - `draft_versions.kind` gains `"generate"`. Version 1 carries `generation: { generationId, outlineVersion, outlineSha256, path, model, promptVersion, usageLogIds, costMicroUsd, masterVersion: null }`. `usageLogIds` is the approved outline's `usageLogId` (when not null), then each section's.
  - The draft's and version 1's `createdBy` is the assembling caller.
  - The body is each section's heading, a blank line and its text, with a blank line between sections. The title is the brief's.

**Classification** (P4B-13).
- The brief takes `classifyForMatter`'s label.
- Every later step uses the strictest of the brief's label and the matter's current label. That label is written back (it never falls), is carried by the outline, the section, the draft and their rows and events, and is passed as P1's `classification`.
- The label is never in the prompt.

**Permissions** (P4B-16).
- `draft.generate` is for partner, associate and clerk; `draft.outline.approve` for partner and associate. Both are matter-level.
- Every write transaction re-decides the permission with `requireStillPermitted` (R12): the brief, the lease, the outcome, the approval and the assembly.

**Events and audit** (P4B-15).
- No outline events.
- At assembly: `draft.generated` (`<draftId>_1_generated`), `draft.autosaved` (`<draftId>_1_autosaved`) and `draft.gated` (`<draftId>_1_gated_1`). Each payload is `{ draftId, matterId, documentTypeId, version: 1, gateResult: <assembly status>, masterVersion: null }`, with the draft's label.
- Audit actions: `draft.create` (target `draft_generations/{id}`); `draft.generate` (the two P1 routes, and the assembly row with reason `assembled` and target `drafts/{draftId}`); `draft.outline.approve`; `draft.read`.

**Rules and indexes** (P4B-18, "Data model").
- `draft_generations` and `draft_outlines` take the `drafts` read expression and deny create, update and delete. `draft_sections` is `allow read, write: if false`.
- Index `draft_generations` by `firmId` ↑, `matterId` ↑, `updatedAt` ↓, `__name__` ↓.
- Exempt from single-field indexing: `draft_generations.facts`, `.verbatim` and `.partyNames`; `draft_outlines.sections` and `.missingFacts`; `draft_sections.text`.

**Fixtures** (P4B-21). Use these constants and no others. Citations use the year 2099; CNICs and phones are all nines; parties are fictitious.

```ts
const TYPE = "constitutional_petition_199"            // template_cp_199_v1; courts BHC, IHC, LHC, PHC, SHC
const DEED = "sale_deed"                              // NON_FORUM; requiredFields include "exactLandDescription"
const PERSON = "Ardeshir Testani"
const INSTITUTION = "Federation of Testlandia through the Secretary, Ministry of Fixtures"
const CNIC = "99999-9999999-9"
const CNIC_PLAIN = "9999999999999"
const PHONE = "0399-9999999"
const OWN_CITATION = "PLD 2099 SC 101"
const NEW_CITATION = "2099 SCMR 7"
const LAND = "Plot 99-T, Block Z, Test Housing Scheme, measuring 999 square yards"
const FACTS = `The petitioner ${PERSON} (CNIC ${CNIC}, mobile ${PHONE}) challenges the order of the ${INSTITUTION} dated 1 January 2099, relying on ${OWN_CITATION}.`
```

**Toolchain and known traps.**
- The Functions lint has zero warnings: `npx eslint --max-warnings 0 functions`.
- Typechecks must be clean: `npx tsc --noEmit -p functions`, root `npm run typecheck` and root `npm run lint`. `platform/` and `tests/` are root files.
- Run emulator tests from the repo root, one file and test name at a time: `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- <file> -t '<name>'"`. Run rules tests with `--only firestore` and `npx vitest run --no-file-parallelism <file>`.
- **Never run `vitest list --json <file>`.** In this repo it overwrites the test file.
- A test title must render as exactly the string the gate selects. Use no `it.each` title that can render `NaN` (use `$name`-style titles only), and no template-literal title.
- `functions/test/g2.cross-firm.test.ts` runs only with `G2_GATE=1`, inside `npm run gate:g2`.
- The PR claim gate (`ci_gates/check_pr_phase_claims.py`) treats the words "complete" and "product-done" in a PR body as a completeness claim. Do not use them.
- Never weaken or skip an existing test. A pinned route, action or name list may be extended. Every amended assertion below becomes stricter or keeps its meaning, and its commit says so.

## Plan decisions (ambiguities the spec leaves open; recorded in the ledger in Task 5)

- **D1.** Every length is in UTF-16 code units, as `committeeBrain`'s 100,000 cap and the charset rule's caps are.
- **D2.** P4B-12's "never in a response" means never in a POST response or a list.
  - `getGeneration` returns `lastAttempt.unsupportedRefs`. The brief is client-readable anyway (P4B-18), and the spec excludes them from `listGenerations` only.
- **D3.** Step 4's "stored result" is the step's deterministic document: `draft_outlines/{g}_{base+1}` of kind `generated`, or `draft_sections/{g}_{v}_{i}`.
  - An edited outline n + 1 is not a `generateOutline` result. It falls through to 409 `outline_changed`.
- **D4.** `generateDraft`'s step-6 checks run in this order:
  1. `outlineVersion !== brief.outlineVersion` → 409 `outline_changed`;
  2. no approval of that version → 409 `outline_not_approved`;
  3. `section > sectionCount` → 404 `section_not_found`;
  4. `section > 1` and `sectionsStored < section - 1` → 409 `previous_section_missing`.

  So a newer outline answers `outline_changed` (test 6b).
- **D5.** The call's own audit row (action `draft.generate`, target `draft_generations/{id}`) is staged in the outcome transaction. It is `allow`/`ok` when the outcome is `stored`, otherwise `deny` with the outcome's reason.
  - The assembly row is a separate `stageAudit` row: reason `assembled`, target `drafts/{draftId}`, the draft's label.
  - P1's `ai.gateway.decision` row is P1's own.
- **D6.** `approveOutline` also refuses a closed matter (409 `matter_closed`) and a live lease (409 `generation_in_progress`).
  - An `outline` edit whose hash equals the current version's is treated as no edit.
- **D7.** `acknowledgedMissingFacts` must equal `{0, …, m − 1}`, where m is the approved (or edited) outline's `missingFacts.length`. Anything else is 422 `missing_facts_not_acknowledged`.
- **D8.** An edited outline stores `path`, `model`, `promptVersion` and `traceId` as null, and `inputTokens`, `outputTokens` and `costMicroUsd` as 0. Its `usageLogId` is its source's.
- **D9.** Version 1's `generation.costMicroUsd` is the brief's `costMicroUsd` at assembly: the cost of producing the draft, billed refusals included (L5498).
- **D10.** If a section answer's first line, trimmed and without a trailing colon, equals its heading (case-insensitive), that line and the blank lines after it are dropped before guardrail 4 (Review Focus 4).
- **D11.** An outline answer parses only if it is one of two shapes:
  - the bare JSON object;
  - exactly one fenced block tagged `json` (any case), with only whitespace around it.

  Its keys must be exactly `sections` and `missingFacts`, and its entries exactly `{ heading, purpose }` and `{ field, note }`. Strings are trimmed and stored in the charset rule's normalised form.
- **D12.** A refusal at the outcome write (403 under R12, 409 `generation_changed`) writes nothing. The lease runs out at `leaseUntil`.
- **D13.** `P1Transport.send`'s `finishReason` is optional in the type, and absent counts as null. Existing test transports then compile unchanged. The Gateway transport always returns the field.
- **D14.** How an assembly failure answers:
  - A failure that is not an `HttpError` (the seam, contention, the deadline) answers `assembly: "pending"` and logs `d4.assembly_failed` with ids and a code only.
  - A re-check mismatch in the transaction (another outline approved since) writes nothing and answers `assembly: "none"`.
  - A 403 from R12 propagates as the request's 403. The section stays stored.
- **D15.** Verbatim text and party names pass the charset rule (422 `unsupported_characters`) and are stored in its normalised form, which the assembled body takes anyway (P4-4). Facts are checked with `checkedText`'s body rule. A party name with a control character is 400 `invalid_party_names`.
- **D16.** How pseudonyms are numbered:
  - `VERBATIM_n` and `PARTY_n` follow the order the lists are passed. D4 passes party names longest first, as `partyNamesFor` returns them.
  - Pattern tokens number distinct values in the order they are found, pattern by pattern in the mask's order.
  - Replacement is always longest first, and never inside a token already placed.
- **D17.** The G-2 probes and firm-A seed stay in Task 5, as the decomposition says. `g2.cross-firm.test.ts` runs only under `G2_GATE=1`, so Tasks 2 to 4 leave every routinely run suite green. Instead, the boot test's route list grows with each task.
- **D18.** Task 2 renames the 4a boot test, which can no longer say "exactly the twelve", and updates its name in `gate_g4_phase4a.sh`. Task 5 updates that gate's `d4/drafting` count from 8 to 15, the precedent 3b set for the d1 counts of earlier gates.
- **D19.** The lease and both budgets read `d4GenerationTestSeam.wallClock ?? Date.now`.
  - The first outcome-write attempt always runs. No retry starts later than `D4_WRITE_DEADLINE_MS − D4_ATTEMPT_SLACK_MS` after `callP1` returns (D24).
  - Assembly starts only before that start-by time, and each attempt of its transaction checks it first.
- **D20.** The pre-call budget is checked before the lease transaction and after it commits.
  - If it is past after the commit, the lease is released in its own transaction and the answer is 503 `generation_busy`.
  - A lease transaction that gives up under contention is also 503 `generation_busy`.
- **D21.** `drafts.ts` exports these unchanged helpers for `generations.ts`: `classifyForMatter` (the spec's), `strictest`, `parseTitle`, `parseTimeCursor`, `withinClearance` and `iso`.
  - `gateOps.ts` exports `resultDocument`, `summaryOf` and `requireStorable` (the spec's).
  - `p1/ops.ts` exports `partyNamesFor` (the spec's).
- **D22.** Assembly calls `classifyForMatter(caller, matter, documentTypeId, strictest([brief.classification, matter.classification]))`. A matter label raised mid-run therefore never trips `classification_below_matter`.

The engineering review of 13 October 2026 added D23 to D28. Each one's finding, reason and record is in "Engineering review" at the end of this plan.

- **D23.** Both budgets start at the op's entry, `startedMs = d4Now()`. The router's `session.now` is not a real clock in the emulator suites (`p1.gateway.emu.test.ts:25`), and the router's own work falls inside the 3,000 ms the arithmetic leaves.
- **D24.** `D4_ATTEMPT_SLACK_MS = 4_000` of `D4_WRITE_DEADLINE_MS` is reserved for the write attempt in flight. No outcome-write or assembly attempt starts later than 6,000 ms after `callP1` returns. This mirrors P1's `COMMIT_ATTEMPT_SLACK_MS` (`gateway.ts:92`, `:99`).
- **D25.** The section prompt asks for at most about `SECTION_WORD_BUDGET` (1,000) words. The outline prompt asks the model to split any part that would need more into further sections, up to the 25 cap.
  - Reason: at an assumed 40 to 70 output tokens a second, 4,096 tokens take about 60 to 100 s, past the 60 s transport timeout [estimated, unmeasured: O-57].
  - A timeout is billed at the 4,096-token ceiling and stores nothing (`gateway.ts:226-233`).
- **D26.** `RESERVED_TOKEN` also matches a bare token (`/\b(?:PARTY|…|VERBATIM)_\d+\b/`). Without this, caller text holding `PARTY_1` would make every answer that echoes it a billed `rehydration_failed`.
- **D27.** If anything throws after `claimLease` commits and before `writeOutcome` begins, `releaseLease` frees the lease, then the error is rethrown. That covers `callP1` itself (`gateway.ts:160`'s `db.getAll` can reject before any provider call), building the prompt and the guards.
  - `releaseLease` runs its own transaction and acts only while `inFlight.claimId` is still this request's. It is best effort and logs `d4.lease_released_after_error` with ids and a code only.
  - Without it, a throw holds the lease for 180 s, and every retry answers 409 `generation_in_progress` for a call that billed nothing.
- **D28.** `assembleGeneration` reads the k sections with one `getAll`, never one read per section.

## Review Focus

The five input classes most likely to bite, with the test that pins each:

1. **A damaged or invented token in a model answer**, such as `⟦PARTY_9⟧`, `⟦party_1⟧`, `⟦PARTY_1 ⟧`, a bare `CNIC_1` or a lone `⟧`. It must be refused `rehydration_failed` with nothing stored, never stored half-restored. Pinned in Task 3: `rehydration_failed for any bracket, lossy token or bare token left after re-hydration, a damaged token included`.
2. **A party name the model writes in another case**, including the institutional name in capitals. It must re-hydrate exactly as supplied, never become `[PARTY]` and never be refused. Pinned in Task 1: `a party name the model writes in another case, the institutional name included, re-hydrates as supplied`.
3. **An outline answer wrapped in prose, in two fences or followed by trailing text.** Only the two D11 shapes parse. Anything else is `output_unparseable`: one billed call and nothing stored, never a guessed outline. Pinned in Task 3: `accepts the bare JSON object or exactly one json fence, and nothing else`.
4. **The model repeating its section heading as the first line.** The line is dropped (D10), so each heading appears once in the assembled body. Pinned in Task 3: `a section whose first line repeats its heading loses that line; a section with nothing else is output_unparseable`.
5. **The advocate's citation written in another form**, such as `P.L.D. 2099 Supreme Court 101`, which the model writes as `PLD 2099 SC 101`. It is the same authority by canonical form, so it is stored, not refused. Pinned in Task 3: `an authority the advocate wrote in another form is the advocate's authority`.

---

### Task 1: P1: the `drafting` route, truncation, and the indexed pseudonymiser (E-52(a) to (c); P4B-4 to P4B-6)

**Files:**
- Create: `platform/p1/pseudonymiseOutboundPII.ts`, `tests/p1.pseudonymise.test.ts`
- Modify:
  - `platform/p1/maskOutboundPII.ts`: export the pattern constants and `MASK_PATTERNS`, with no behaviour change.
  - `functions/src/p1/types.ts`, `functions/src/p1/costTable.ts`, `functions/src/p1/transport.ts`, `functions/src/p1/gateway.ts`.
  - `functions/src/p1/README.md`: the `drafting` route, `truncated`, and `pseudonymise` / `pseudonyms`.
- Test:
  - `functions/test/p1.units.test.ts` and `functions/test/p1.transport.test.ts`.
  - `functions/test/p1.gateway.emu.test.ts`: its `fakeTransport` `Reply` type gains `finishReason?: string | null`, passed through as given.
  - `functions/test/p1.api.emu.test.ts`.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `platform/p1/maskOutboundPII.ts`:
    - `MASK_PATTERNS: ReadonlyArray<{ kind: "cnic" | "phone" | "email" | "iban" | "ntn" | "passport"; re: RegExp }>`, in the mask's order: CNIC separated, CNIC plain, mobile in parentheses, mobile, email, IBAN, NTN, passport.
    - `LOSSY_TOKENS: readonly string[]`.
  - `platform/p1/pseudonymiseOutboundPII.ts`:
    - `type PseudonymKind = "verbatim" | "cnic" | "phone" | "email" | "iban" | "ntn" | "passport" | "party"`
    - `type Pseudonym = Readonly<{ token: string; kind: PseudonymKind; value: string }>`
    - `type PseudonymMap = readonly Pseudonym[]`
    - `INDEXED_TOKEN: RegExp`, which is `/⟦(VERBATIM|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT|PARTY)_([1-9]\d*)⟧/g`
    - `pseudonymise(text: string, opts: { partyNames?: readonly string[]; verbatim?: readonly string[] }): { text: string; map: PseudonymMap; redactionCounts: Record<PseudonymKind, number> }`
    - `applyMap(text: string, map: PseudonymMap, opts: { partyNames?: readonly string[] }): string`
    - `rehydrate(text: string, map: PseudonymMap): string`
  - `functions/src/p1/types.ts`: `type TaskType = "committee" | "drafting"`.
  - `functions/src/p1/transport.ts`: `send` resolves `{ text; inputTokens; outputTokens; finishReason?: string | null }` (D13).
  - `functions/src/p1/gateway.ts`:
    - `P1Request.pseudonymise?: { verbatim: readonly string[] }`
    - `P1Result.truncated: boolean` (always present)
    - `P1Result.pseudonyms?: PseudonymMap`, present only on an `ok` result of a pseudonymised request

- [ ] **Step 1: Write the failing pseudonymiser tests** in `tests/p1.pseudonymise.test.ts`, under `describe("P1 indexed pseudonymiser (P4B-6)")`. Use the fixture constants.

```ts
it("replaces verbatim strings first, longest first, numbered in the order given", () => {
  expect(pseudonymise(`Land: ${LAND}. Short: Plot 99-T.`, { verbatim: ["Plot 99-T", LAND] }).text).toBe("Land: ⟦VERBATIM_2⟧. Short: ⟦VERBATIM_1⟧.")
})
it("gives each distinct pattern value one token per kind, numbered pattern by pattern in the mask's order", () => {
  expect(pseudonymise(`B ${CNIC_PLAIN}, A ${CNIC}, again ${CNIC}; call ${PHONE}.`, {}).text).toBe("B ⟦CNIC_2⟧, A ⟦CNIC_1⟧, again ⟦CNIC_1⟧; call ⟦PHONE_1⟧.")
})
it("gives every supplied party name one token, matched case-insensitively and longest first, even when absent from the text", () => {
  const r = pseudonymise(`${PERSON.toUpperCase()} v. the ${INSTITUTION}`, { partyNames: [INSTITUTION, PERSON, "Absent Party"] })
  expect(r.text).toBe("⟦PARTY_2⟧ v. the ⟦PARTY_1⟧")
  expect(r.map.filter((p) => p.kind === "party").map((p) => [p.token, p.value])).toEqual([["⟦PARTY_1⟧", INSTITUTION], ["⟦PARTY_2⟧", PERSON], ["⟦PARTY_3⟧", "Absent Party"]])
})
it("never rewrites inside a token already placed, even for a party name that spells a token", () => {
  expect(pseudonymise(`Party ${CNIC} and Party`, { partyNames: ["Party", "CNIC_1"] }).text).toBe("⟦PARTY_1⟧ ⟦CNIC_1⟧ and ⟦PARTY_1⟧")
})
it("redactionCounts counts every replacement by kind, verbatim included", () => {
  expect(pseudonymise(`${LAND}; ${PERSON}, ${PERSON}; ${CNIC}; ${PHONE}`, { verbatim: [LAND], partyNames: [PERSON] }).redactionCounts)
    .toEqual({ verbatim: 1, cnic: 1, phone: 1, email: 0, iban: 0, ntn: 0, passport: 0, party: 2 })
})
it("the map is frozen, entry by entry, and holds every supplied name and verbatim string", () => {
  const { map } = pseudonymise("nothing here", { verbatim: [LAND], partyNames: [PERSON] })
  expect(Object.isFrozen(map) && map.every((p) => Object.isFrozen(p))).toBe(true)
  expect(map.map((p) => [p.token, p.kind, p.value])).toEqual([["⟦VERBATIM_1⟧", "verbatim", LAND], ["⟦PARTY_1⟧", "party", PERSON]])
})
it("applyMap turns a mapped value into its token and any other pattern match into the lossy token", () => {
  const { map } = pseudonymise(`${PERSON} ${CNIC}`, { partyNames: [PERSON] })
  expect(applyMap(`${PERSON.toLowerCase()} holds ${CNIC}; another ${CNIC_PLAIN}; mail x@example.test`, map, { partyNames: [PERSON] }))
    .toBe("⟦PARTY_1⟧ holds ⟦CNIC_1⟧; another [CNIC]; mail [EMAIL]")
})
it("rehydrate restores every known token in one pass, a party name as supplied, and leaves an unknown token in place", () => {
  const { map } = pseudonymise(`${PERSON} ${CNIC}`, { partyNames: [PERSON] })
  expect(rehydrate("⟦PARTY_1⟧ ⟦CNIC_1⟧ ⟦PARTY_9⟧", map)).toBe(`${PERSON} ${CNIC} ⟦PARTY_9⟧`)
})
// Review Focus 2
it("a party name the model writes in another case, the institutional name included, re-hydrates as supplied", () => {
  const names = [INSTITUTION, PERSON]
  const { map } = pseudonymise("x", { partyNames: names })
  expect(rehydrate(applyMap(`THE ${INSTITUTION.toUpperCase()} and ${PERSON.toLowerCase()}`, map, { partyNames: names }), map)).toBe(`THE ${INSTITUTION} and ${PERSON}`)
})
it("maskOutboundPII is unchanged: the exported patterns are in the mask's order and its lossy output is as before", () => {
  expect(MASK_PATTERNS.map((p) => p.kind)).toEqual(["cnic", "cnic", "phone", "phone", "email", "iban", "ntn", "passport"])
  expect(maskOutboundPII(`${PERSON} ${CNIC} ${PHONE}`, { partyNames: [PERSON] }).masked).toBe("[PARTY] [CNIC] [PHONE]")
})
```

- [ ] **Step 2: Write the failing P1 unit and transport tests.**
  - In `functions/test/p1.units.test.ts`, under `describe("P1 cost table (P3-62)")`:

    ```ts
    it("routes the drafting task to Opus as well, and prices no other model (P4B-4, O-77)", () => {
      expect(TASK_MODEL).toEqual({ committee: OPUS, drafting: OPUS })
      expect(Object.keys(MODEL_PRICES)).toEqual([OPUS])
    })
    ```

    And under `describe("P1 Opik trace payload (P3-67)")`:

    ```ts
    it("names a drafting call's trace p1.drafting (P4B-4)", () => {
      expect(buildTrace(record({ taskType: "drafting" }), "sikander-p1").name).toBe("p1.drafting")
    })
    ```

  - In `functions/test/p1.transport.test.ts`, under `describe("P1 Gateway transport (P3-68)")`:

    ```ts
    it("returns choices[0].finish_reason when it is a string, and null otherwise (P4B-5)", async () => {
      for (const [raw, want] of [["stop", "stop"], ["length", "length"], [undefined, null], [7, null], [null, null]] as const) {
        respond = json(200, { choices: [{ message: { content: "hi" }, ...(raw === undefined ? {} : { finish_reason: raw }) }] })
        expect([raw, (await gatewayTransport("k", base).send(request)).finishReason]).toEqual([raw, want])
      }
    })
    ```

    Amend the two existing whole-object assertions, `posts the OpenAI-compatible body with the bearer key and parses text and usage` and `gives null tokens when the response carries no usage`, to include `finishReason: null`. This makes them stricter.
- [ ] **Step 3: Write the failing `callP1` emulator tests** in `functions/test/p1.gateway.emu.test.ts`, under a new `describe("drafting, truncation and pseudonyms (P4B-4 to P4B-6)")`. Each test uses its own firm from `seedFirm()`.

```ts
it("truncated is true for an ok answer whose finishReason is anything but stop, absent included; the charge, row and event are unchanged", async () => {
  for (const [finishReason, truncated] of [["stop", false], ["length", true], [null, true], [undefined, true], ["content_filter", true]] as const) {
    const firmId = await seedFirm(); fakeTransport({ finishReason })
    const r = await callP1(req(firmId, { taskType: "drafting" }), at)
    expect([finishReason, r.outcome, r.truncated, r.costMicroUsd, r.model]).toEqual([finishReason, "ok", truncated, 14000, OPUS])
    expect((await rowOf(r.usageLogId))?.outcome).toBe("ok")
    expect(await eventsOf(firmId, "ai.call.completed")).toHaveLength(1)
  }
})
it("truncated is false on a blocked call and on a failed call", async () => {
  // blocked: seedFirm(null), so budget_not_set; failed: fakeTransport(() => Promise.reject(new P1TransportError("gateway_status", { billable: false, status: 500 })))
  expect([blocked.outcome, blocked.truncated, failed.outcome, failed.truncated]).toEqual(["blocked", false, "failed", false])
})
it("with pseudonymise the transport, the row, the event, the audit row, the trace and every log line carry tokens only, and an ok result carries the frozen map", async () => {
  const firmId = await seedFirm(); const sent = fakeTransport({ text: `⟦PARTY_1⟧, ${PERSON}, holds ⟦CNIC_1⟧` }); const opik = fakeOpik(); const logs = spyLogs()
  const r = await callP1(req(firmId, { taskType: "drafting", body: `${PERSON} (${CNIC}) owns ${LAND}`, partyNames: [PERSON], pseudonymise: { verbatim: [LAND] } }), at)
  expect(sent[0]!.body).toBe("⟦PARTY_1⟧ (⟦CNIC_1⟧) owns ⟦VERBATIM_1⟧")
  expect(r.text).toBe("⟦PARTY_1⟧, ⟦PARTY_1⟧, holds ⟦CNIC_1⟧")
  expect(r.outbound.redactionCounts).toMatchObject({ verbatim: 1, cnic: 1, party: 1 })
  expect(r.pseudonyms?.map((p) => p.value)).toEqual([LAND, CNIC, PERSON]); expect(Object.isFrozen(r.pseudonyms)).toBe(true)
  const everywhere = JSON.stringify([await rowsOf(firmId), await eventsOf(firmId), await auditsOf(firmId), opik.bodies, logs.all()])
  for (const v of [PERSON, CNIC, LAND]) expect(everywhere).not.toContain(v)
})
it("without pseudonymise the call is as before: lossy masking, no pseudonyms, no verbatim count", async () => {
  expect(sent[0]!.body).toBe("[PARTY] [CNIC]"); expect("pseudonyms" in r).toBe(false); expect(r.outbound.redactionCounts).not.toHaveProperty("verbatim")
})
it("a pseudonymised privileged call with an executed DPA passes assertMinimised and goes out", async () => {
  setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: false } })
  // body `${PERSON} ${CNIC}`, partyNames [PERSON], pseudonymise { verbatim: [] }, classification "privileged"
  expect([r.outcome, r.blockReason]).toEqual(["ok", null]); expect(sent).toHaveLength(1)
})
```

  In `functions/test/p1.api.emu.test.ts`, under `describe("committeeBrain: output (P3-70)")`. Use that file's `newFirm`, `send`, `brainAt`, `base` and `outputsOf`.

```ts
it("committeeBrain is unchanged by 4b: task committee, lossy masking, no pseudonyms, and a length-truncated answer stored and returned as before (P4B-5, P4B-6)", async () => {
  const f = await newFirm({ parties: [{ name: "Ali Raza" }] })
  // setP1TransportForTests: records each request, answers { text: "Reply for Ali Raza", inputTokens: 1000, outputTokens: 500, finishReason: "length" }
  const r = await send(brainAt, f.P, base(f, { body: "Draft for Ali Raza." })) as Out
  expect(r).toMatchObject({ blocked: false, text: "Reply for [PARTY]" }); expect(sentBodies).toEqual(["Draft for [PARTY]."])
  expect((await outputsOf(f.firmId))[0]!.data.text).toBe("Reply for [PARTY]")
  expect((await adminDb().collection("ai_usage_logs").where("firmId", "==", f.firmId).get()).docs.map((d) => d.get("taskType"))).toEqual(["committee"])
})
```

- [ ] **Step 4: Run them and see them fail.**
  - Run `npx vitest run tests/p1.pseudonymise.test.ts`. Expected: FAIL, because the module `pseudonymiseOutboundPII` does not exist.
  - Run `npm --prefix functions test -- p1.units p1.transport`. Expected: FAIL on `TASK_MODEL.drafting` and on `finishReason`.
  - Run `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- p1.gateway.emu -t 'drafting, truncation and pseudonyms'"`. Expected: FAIL, because `truncated` is undefined.
- [ ] **Step 5: In `platform/p1/maskOutboundPII.ts`, export the eight pattern constants, `MASK_PATTERNS` and `LOSSY_TOKENS`.** `maskOutboundPII`'s body does not change.
- [ ] **Step 6: Implement `pseudonymise`, `applyMap` and `rehydrate`** in `platform/p1/pseudonymiseOutboundPII.ts`. The algorithm the signatures leave open:
  - **Order.** `pseudonymise` places tokens in this order:
    1. the verbatim strings (exact match), longest first;
    2. each `MASK_PATTERNS` entry in order, giving every distinct matched string of a kind its own `n`;
    3. the party names (trimmed, empties skipped, `escapeRegExp` + `"gi"`), longest first.
  - **Numbering** is D16's.
  - **No rewrites inside tokens.** Every replacement runs only on the text between tokens already placed: split on `INDEXED_TOKEN`, replace in the gaps, and re-join.
  - **The map.** It lists the verbatim entries, then the pattern entries, then the party entries. It is `Object.freeze`d, entry by entry. It holds every supplied name and verbatim string, present in the text or not.
  - **`applyMap`** replaces the map's values with their tokens, longest first: party values case-insensitively, every other value exactly, never inside a token. It then runs `maskOutboundPII(gap, { partyNames: [] })` on each gap between tokens, so any unmapped pattern match becomes its lossy token.
  - **`rehydrate`** is a single `replace(INDEXED_TOKEN, …)` pass that substitutes a token's value when the map has the token, and otherwise leaves the token in place.
- [ ] **Step 7: Route, transport and types.**
  - `TaskType = "committee" | "drafting"`.
  - `TASK_MODEL = Object.freeze({ committee: "anthropic/claude-opus-5.5", drafting: "anthropic/claude-opus-5.5" })`.
  - In `gatewayTransport`, `GatewayBody.choices[0]` gains `finish_reason?: unknown`, and `send` returns `finishReason: typeof fr === "string" ? fr : null`.
- [ ] **Step 8: `callP1` (`functions/src/p1/gateway.ts`).**
  - **Step 4 of `callP1`.** When `req.pseudonymise` is present:
    - `pseudo = pseudonymise(req.body, { partyNames, verbatim: req.pseudonymise.verbatim })`;
    - `outbound.body = pseudo.text`;
    - `outbound.redactionCounts = pseudo.redactionCounts`;
    - the purpose keeps the lossy mask.
  - **Step 9 of `callP1`.** The answer becomes `pseudo ? applyMap(res.text, pseudo.map, { partyNames }) : maskOutboundPII(res.text, { partyNames }).masked`, and `finishReason = typeof res.finishReason === "string" ? res.finishReason : null`.
  - **The result.** It gains `truncated: outcome === "ok" && finishReason !== "stop"` and `...(outcome === "ok" && pseudo ? { pseudonyms: pseudo.map } : {})`.
  - **What does not change:** charging, rows, events and traces. The map never reaches the trace record, the commit, a log line or an error.
- [ ] **Step 9: Document the contract in `functions/src/p1/README.md`** (route table, `truncated`, `pseudonymise` and `pseudonyms`, and the in-process-only rule for the map).
- [ ] **Step 10: Run the tests and see them pass.**
  - `npx vitest run tests/p1.pseudonymise.test.ts`
  - `npm --prefix functions test -- p1.units p1.transport`
  - The whole P1 emulator suites, unchanged and green: `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- p1.gateway.emu p1.api.emu"`.
  - Then `npx tsc --noEmit -p functions`, `npx eslint --max-warnings 0 functions`, `npm run typecheck` and `npm run lint`.

  Expected: PASS, with zero warnings.
- [ ] **Step 11: Commit.**

```bash
git add platform/p1/maskOutboundPII.ts platform/p1/pseudonymiseOutboundPII.ts tests/p1.pseudonymise.test.ts functions/src/p1 functions/test/p1.units.test.ts functions/test/p1.transport.test.ts functions/test/p1.gateway.emu.test.ts functions/test/p1.api.emu.test.ts
git commit -m "feat(p1): drafting task type, finish_reason truncation flag, indexed pseudonymiser returned in process only (P4B-4..P4B-6, E-52(a)-(c))

Two transport assertions gain finishReason: null (stricter). committeeBrain is unchanged."
```

### Task 2: The generation store, the entry routes, permissions and rules (P4B-1, P4B-8, P4B-9 port, P4B-13, P4B-16, P4B-18)

**Files:**
- Create:
  - `functions/src/d4/templates.ts`
  - `functions/src/d4/generations.ts`
  - `functions/test/d4.generation.emu.test.ts`, holding the fixtures and helpers below
  - `functions/test/d4.generation.test.ts`
  - `tests/firestore.rules.d4-phase4b.test.ts`
- Modify:
  - `platform/p5/permissionDecision.ts`
  - `functions/src/p5/permission.ts`: its doc comment only. `DraftAction` derives from `DRAFT_ACTIONS`.
  - `functions/src/d4/drafts.ts`: D21's exports, unchanged.
  - `functions/src/http/router.ts`: `startDraft`, `getGeneration` and `listGenerations`.
  - `firestore.rules`, `firestore.indexes.json`
  - `vitest.config.ts`: exclude the new rules file without an emulator.
  - `package.json`: add the new rules file to `test:rules`.
  - `functions/test/d4.boot.test.ts`
  - `ci_gates/gate_g4_phase4a.sh`: the renamed boot test's name only (D18).
  - `tests/p5.permission-draft-actions.test.ts`, `tests/p5.permission-decision.parity.test.ts`

**Interfaces:**
- Consumes: `classifyForMatter`, `strictest`, `parseTitle`, `parseTimeCursor`, `withinClearance`, `iso`, `checkedText`, `requireMatterAction` and `requireStillPermitted` from `drafts.ts`; `getDocumentType` from `doctypes.ts`; `parsePage` and `encodeCursor` from `d1/pagination.ts`.
- Produces:
  - `templates.ts`:
    - `type Template = { templateId: string; documentTypeId: string }`
    - `interface TemplateStore { findTemplate(documentTypeId: string, templateId: string): Promise<Template | null> }`
    - `EMPTY_TEMPLATE_STORE`: frozen, and always null
    - `class InMemoryTemplateStore implements TemplateStore { addTemplate(documentTypeId: string, templateId: string): this }`
    - `setTemplateStoreForTests(s: TemplateStore | null): void`, which throws `"setTemplateStoreForTests is test-only"` when `NODE_ENV === "production"`
    - `activeTemplateStore(): TemplateStore`
  - `generations.ts`:
    - `type Stage = "facts" | "outlined" | "approved" | "drafting" | "assembled"`
    - `type StepOutcome = "stored" | "blocked" | "failed" | "refused"`
    - `type VerbatimField = { field: string; text: string }`
    - `generations()`, `outlines()` and `sectionDocs()`: the three collection refs
    - `outlineId(generationId: string, version: number): string`, which gives `${generationId}_${version}`
    - `sectionId(generationId: string, outlineVersion: number, section: number): string`, which gives `${generationId}_${outlineVersion}_${section}`
    - `parseGenerationId(value: unknown): string` (400 `invalid_generation_id`)
    - `loadGenerationForCaller(caller: Caller, generationId: string, action: DraftAction): Promise<{ ref: DocumentReference; brief: DocumentData }>`. This is `loadDraftForCaller`'s rule: an unsafe id, an absent brief, another firm's brief and one above the caller's clearance are all 404 `not_found`; the action is checked on the brief's matter.
    - `generationLabel(caller: Caller, brief: DocumentData, matter: DocumentData): Classification`. This gives the strictest of the brief's label and the matter's label. An unreadable label, or a result above the caller's clearance, is 403 `clearance`.
    - `RESERVED_TOKEN: RegExp` (`/[⟦⟧]|\[(?:PARTY|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT)\]|\b(?:PARTY|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT|VERBATIM)_\d+\b/`, D26) and `refuseReservedTokens(texts: readonly string[]): void` (422 `reserved_tokens`)
    - `liveLease(brief: DocumentData, nowMs: number): boolean`, true when `inFlight` exists and `inFlight.leaseUntil.toMillis() > nowMs`
    - `type GenerationView`: every brief field, with `generationId`, timestamps as ISO strings, and `inProgress` in place of `inFlight`
    - `generationView(id: string, d: DocumentData, nowMs: number): GenerationView` and `generationSummary(id: string, d: DocumentData, nowMs: number)`. The summary is the view without `facts`, `verbatim`, `partyNames` and `lastAttempt.unsupportedRefs`.
    - `startDraftOp`, `getGenerationOp`, `listGenerationsOp`
  - The emulator-test helpers, which Tasks 3 and 4 reuse:
    - `newFirm(label = "internal")`:
      - members `P`, `A`, `C`, `intern`, `accounts` and `client`, cleared to `privileged-restricted`;
      - `low`, an associate member cleared to `internal`;
      - `outsider`, a partner who is not a member;
      - a matter with `courtId: "SHC"`;
      - firm `rateLimits: { general: 1000, p1: 1000 }`;
      - `ai_config` budget `1_000_000_000`.
    - `scripted(answers)`: installs a P1 transport that answers in order. Each answer is `{ text: string | ((body: string) => string), finishReason?, inputTokens?, outputTokens? }`, defaulting to `"stop"`, 1000 and 500. It returns the bodies sent.
    - `outlineJson(sections, missingFacts = [])`.
    - `tokensIn(body, kind)`: the tokens of a kind in a sent body, in order.
    - `start(firm, over?, member = firm.A)`.
    - One helper per route, of the form `(member, data, headers?)`, that sends `{ firmId, ...data }` through `viaApi`:
      - `startApi`, `getGenerationApi` and `listGenerationsApi` (this task);
      - `outlineApi`, `approveApi` and `getOutlineApi` (Task 3);
      - `draftApi`, plus the 4a routes `reportApi`, `overrideApi`, `approveDraftApi` and `getDraftApi` (Task 4).
    - `spyLogs()` and `fakeOpik()`, as in `p1.gateway.emu.test.ts`.
    - `docsOf(collection, firmId)`: each row as `{ id, ...data }`.
    - `idempotencyRowsOf(firmId)`: the `idempotency_keys` documents whose id starts with `${firmId}_`.

**Contracts.**
- **`startDraft`.**
  - The 400 checks run in field order:
    - `matterId`: `matter_required`.
    - `documentTypeId`: `invalid_document_type`, then 404 `document_type_not_found`.
    - `title`: `parseTitle` (`invalid_title`).
    - `facts`: a string of 1 to 100,000 (`invalid_facts`).
    - `verbatim`: absent, or an array of at most 20 `{ field, text }`. Each `field` is a distinct `requiredFields` name of the type; each `text` is 1 to 10,000; the texts total at most 50,000. Anything else is `invalid_verbatim`.
    - `partyNames`: absent, or at most 50 strings, each 1 to 200 after trimming, with no control character (`invalid_party_names`).
    - `classification`: `invalid_classification`.
  - Then `requireMatterAction(caller, "draft.create", matterId)`, and the matter is read (404 `not_found`).
  - Then `classifyForMatter`, which can answer 403 `clearance`, 409 `matter_closed`, 422 `court_mismatch` or 422 `classification_below_matter`.
  - Then the text rules (D15): `checkedText(title, facts)`, then the charset rule on each verbatim text and party name, then `refuseReservedTokens` over the title, the facts, the verbatim texts and the party names.
  - One transaction re-runs `requireStillPermitted` and `classifyForMatter`, stages the audit row (target `draft_generations/{id}`), and creates the brief.
  - The new brief has `stage: "facts"`, `outlineVersion: 0`, `approvedOutline: null`, `sectionCount: null`, `sectionsStored: 0`, the type's `templateId`, `path: null`, `model: null`, `promptVersion: null`, `calls: 0`, `costMicroUsd: 0`, `lastAttempt: null`, `inFlight: null` and `draftId: null`.
- **`getGeneration ?generationId`** (`draft.read`) returns `generationView`.
- **`listGenerations ?matterId&limit&cursor`** (`draft.read` on the matter; 400 `matter_required`) works as `listDrafts` does: `updatedAt` descending, then id descending; clearance-filtered; `generationSummary` rows; the `<seconds>.<nanos>` cursor.

- [ ] **Step 1: Write the failing permission tests.**
  - In `tests/p5.permission-draft-actions.test.ts`:
    - `MATRIX` gains `"draft.generate": PAC` and `"draft.outline.approve": ["partner", "associate"]`, and `MATTER_LEVEL` gains both.
    - Rename `exports the 6 draft actions and doctype.read` to `exports the 8 draft actions and doctype.read`. No gate names this test.
    - Add:

      ```ts
      it("draft.generate is partner, associate and clerk; draft.outline.approve is partner and associate; an intern member is intern-channel-denied (P4B-16, P4B-10)", () => {
        expect(decide(caller("clerk"), "draft.generate", matter, true)).toEqual({ allow: true, reason: "ok" })
        expect(decide(caller("clerk"), "draft.outline.approve", matter, true)).toEqual({ allow: false, reason: "role-not-permitted" })
        expect(decide(caller("associate"), "draft.outline.approve", matter, true)).toEqual({ allow: true, reason: "ok" })
        expect(decide(caller("intern"), "draft.generate", matter, true)).toEqual({ allow: false, reason: "intern-channel-denied" })
      })
      ```

  - In `tests/p5.permission-decision.parity.test.ts`, `CASES` gains four cases on `OWN` with `member: true`:
    - `draft.generate by a member clerk`: `ok`
    - `draft.generate by an intern member`: `intern-channel-denied`
    - `draft.outline.approve by a member associate`: `ok`
    - `draft.outline.approve by a member clerk`: `role-not-permitted`
- [ ] **Step 2: Write the failing rules tests** in `tests/firestore.rules.d4-phase4b.test.ts`, under `describe("draft_generations, draft_outlines and draft_sections (P4B-18)")`. Model the file on `tests/firestore.rules.d4-phase4a.test.ts`: its callers, its `RAISED` matter, and a brief and an outline seeded at `internal` on `MATTER` and on `RAISED`.
  - `control: a partner, associate and clerk member cleared for the row and the matter read a brief and an outline` (`assertSucceeds` `getDoc` for `READERS`).
  - `an intern member, a client, accounts, a non-member and another firm's partner are denied a brief and an outline` (`assertFails`).
  - `cross-label: an internal-cleared member cannot read a brief or an outline of a matter raised to privileged, even when the stored label is internal`.
  - `no client of any role creates, updates or deletes a brief or an outline, even a cleared member author`.
  - `draft_sections is server-only: no role of either firm reads, lists, creates, updates or deletes it`.
  - `an unauthenticated client can neither read nor write any of the three`.
- [ ] **Step 3: Write the failing boot and port tests.**
  - In `functions/test/d4.boot.test.ts`:
    - Rename the 4a test to `the entry point exports api, and the router built with every layer flag off serves the twelve Phase 4a D4 routes unchanged, each kind general`. Its assertion becomes: the D4 routes whose last path segment is one of the twelve 4a names, sorted, equal `D4_ROUTES`.
    - Add `const D4_GENERATION_ROUTES = ["POST /api/d4/drafting/startDraft general", "GET /api/d4/drafting/getGeneration general", "GET /api/d4/drafting/listGenerations general"]`, which Tasks 3 and 4 append to.
    - Add `describe("D4 generation boot (P4B-9, P4B-22)")` with these tests:

      ```ts
      it("the router built with every layer flag off serves exactly the Phase 4a and 4b D4 routes; generateOutline and generateDraft are kind p1 and every other one general", async () => {
        expect(d4.sort()).toEqual([...D4_ROUTES, ...D4_GENERATION_ROUTES].sort())
      })
      it("the production template store is EMPTY_TEMPLATE_STORE: a fresh load of the generation modules runs on it", async () => {
        vi.resetModules(); const t = await import("../src/d4/templates"); await import("../src/d4/generations")
        expect(t.activeTemplateStore()).toBe(t.EMPTY_TEMPLATE_STORE); expect(Object.isFrozen(t.EMPTY_TEMPLATE_STORE)).toBe(true)
      })
      it("firestore.indexes.json indexes draft_generations by firm, matter and updatedAt, and exempts the generation text from single-field indexing", () => {
        for (const f of ["draft_generations.facts", "draft_generations.verbatim", "draft_generations.partyNames", "draft_outlines.sections", "draft_outlines.missingFacts", "draft_sections.text"]) expect(exempt).toContain(f)
        expect(composite("draft_generations")).toEqual(["firmId ASCENDING", "matterId ASCENDING", "updatedAt DESCENDING", "__name__ DESCENDING"])
      })
      ```

  - In `functions/test/d4.generation.test.ts`, under `describe("D4 template port (P4B-9)")`:

    ```ts
    it("EMPTY_TEMPLATE_STORE is frozen and finds nothing; InMemoryTemplateStore finds a template by type and id only", async () => {
      expect(await EMPTY_TEMPLATE_STORE.findTemplate(TYPE, "template_cp_199_v1")).toBeNull()
      const s = new InMemoryTemplateStore().addTemplate(TYPE, "template_cp_199_v1")
      expect(await s.findTemplate(TYPE, "template_cp_199_v1")).toEqual({ documentTypeId: TYPE, templateId: "template_cp_199_v1" })
      expect(await s.findTemplate(DEED, "template_cp_199_v1")).toBeNull()
    })
    it("setTemplateStoreForTests throws when NODE_ENV is production", () => {
      vi.stubEnv("NODE_ENV", "production"); expect(() => setTemplateStoreForTests(null)).toThrow("setTemplateStoreForTests is test-only")
    })
    ```

- [ ] **Step 4: Write the failing entry-route emulator tests** in `functions/test/d4.generation.emu.test.ts`, under `describe("D4 generation: entry routes (P4B-1, P4B-8, P4B-13, P4B-14)")`. Each test reads its writes back with the Admin SDK.

```ts
it("startDraft writes the brief at stage facts and its audit row in one transaction, and answers ids, stage, classification and outlineVersion only", async () => {
  const out = await start(f, { partyNames: [PERSON] })
  expect(Object.keys(out).sort()).toEqual(["classification", "generationId", "outlineVersion", "stage"])
  expect(out).toMatchObject({ stage: "facts", classification: "internal", outlineVersion: 0 })
  expect(brief).toMatchObject({ firmId: f.firmId, matterId: f.matterId, documentTypeId: TYPE, facts: FACTS, partyNames: [PERSON], stage: "facts", outlineVersion: 0, approvedOutline: null, sectionCount: null, sectionsStored: 0, templateId: "template_cp_199_v1", path: null, model: null, promptVersion: null, calls: 0, costMicroUsd: 0, lastAttempt: null, inFlight: null, draftId: null, createdBy: f.A.uid })
  expect(audits.filter((a) => a.action === "draft.create" && a.target === `draft_generations/${out.generationId}` && a.decision === "allow")).toHaveLength(1)
})
it("startDraft checks its fields in order before the permission: matter, type, title, facts, verbatim, party names, classification", async () => {
  // as the intern: each malformed field gives its 400, never 403; with two bad fields, the earlier one wins
  expect(codes).toEqual(["matter_required", "invalid_document_type", "invalid_title", "invalid_facts", "invalid_verbatim", "invalid_party_names", "invalid_classification"])
  // invalid_facts for "" and for 100,001 characters; invalid_verbatim for a field outside requiredFields, a repeated field, 21 entries, a 10,001-character text, and 50,001 characters in total; invalid_party_names for 51 names, a 201-character name, and a name containing "\n"
})
it("startDraft classification: at least internal, never below the matter's, within the caller's clearance; a closed matter is 409 matter_closed and a type that does not admit the court 422 court_mismatch", async () => {
  // a public matter gives internal; a confidential matter with classification "internal" gives 422 classification_below_matter; f.low asking for privileged gives 403 clearance; status "closed" gives 409 matter_closed; courtId "NOT_A_COURT" with TYPE gives 422 court_mismatch
})
it("reserved tokens: a ⟦, a ⟧, a lossy mask token or a bare token in the title, facts, a verbatim text or a party name is 422 reserved_tokens, after the permission, with nothing stored", async () => {
  for (const over of [{ title: "Petition ⟦PARTY_1⟧" }, { facts: `${FACTS} [CNIC]` }, { facts: `${FACTS} See PARTY_1.` }, { documentTypeId: DEED, verbatim: [{ field: "exactLandDescription", text: "Plot ⟧" }] }, { partyNames: ["[PARTY]"] }]) {
    expect((await apiErrorOf(start(f, over))).code).toBe("reserved_tokens")
  }
  expect((await apiErrorOf(start(f, { facts: "⟦x⟧" }, f.intern))).code).toBe("intern_channel_denied")
  expect(await docsOf("draft_generations", f.firmId)).toHaveLength(0)
})
it("the text rules come after the permission: a bidirectional or invisible character in any field is 422 unsupported_characters, with nothing stored", async () => {
  // "‮" in the title, the facts, a verbatim text and a party name: each gives 422 unsupported_characters; as a non-member the same input gives 403 not_member
})
it("access: an intern, a client, accounts and a non-member are refused; another firm's brief and one above the caller's clearance are 404 not_found on getGeneration", async () => {
  // startDraft: intern 403 intern_channel_denied, client 403 client_denied, accounts 403 accounts_register_only, outsider 403 not_member
  // getGeneration: another firm's id → 404 not_found; a brief started with classification "privileged" on the internal matter, read by f.low → 404 not_found; a malformed id → 404 not_found
})
it("getGeneration returns the brief with inProgress and never inFlight; listGenerations returns cleared briefs newest first without facts, verbatim, partyNames or unsupportedRefs, and pages", async () => {
  expect(view).toMatchObject({ generationId: g, facts: FACTS, inProgress: false }); expect(view).not.toHaveProperty("inFlight")
  expect(page1.items.map((b) => b.generationId)).toEqual([g3, g2]); expect(page1.nextCursor).not.toBeNull()
  for (const row of page1.items) for (const k of ["facts", "verbatim", "partyNames", "inFlight"]) expect(row).not.toHaveProperty(k)
  // a brief labelled privileged on the internal matter is not listed to f.low; a bad cursor is 400 invalid_cursor
})
```

- [ ] **Step 5: Run them and see them fail.**
  - Run `npx vitest run tests/p5.permission-draft-actions.test.ts tests/p5.permission-decision.parity.test.ts`. Expected: FAIL, because the draft actions are not in the table.
  - Run `npm --prefix functions test -- d4.boot d4.generation.test`. Expected: FAIL, because the `templates` module and the routes are missing.
  - Run `npx firebase emulators:exec --only firestore --project demo-sikander "npx vitest run --no-file-parallelism tests/firestore.rules.d4-phase4b.test.ts"`. Expected: FAIL, because the collections fall through to deny.
  - Run `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- d4.generation.emu -t 'D4 generation: entry routes'"`. Expected: FAIL with `route_not_found`.
- [ ] **Step 6: Permissions.** In `DRAFT_ACTIONS`, add `"draft.generate"` and `"draft.outline.approve"`. In `DRAFT_ROLES`, add `"draft.generate": ["partner", "associate", "clerk"]` and `"draft.outline.approve": ["partner", "associate"]`. Update the doc comments in both permission modules.
- [ ] **Step 7: Implement `templates.ts`** to the interface above, after `authority.ts`.
- [ ] **Step 8: Implement `generations.ts`** to the interfaces and contracts above. Export the D21 helpers from `drafts.ts`, unchanged.
- [ ] **Step 9: Register the routes.** Add `post(\`${D4_DRAFTING}/startDraft\`, startDraftOp)`, `get(\`${D4_DRAFTING}/getGeneration\`, getGenerationOp)` and `get(\`${D4_DRAFTING}/listGenerations\`, listGenerationsOp)`.
- [ ] **Step 10: Rules and indexes.**
  - `match /draft_generations/{id}` and `match /draft_outlines/{id}`: the `drafts` read expression, and `allow create, update, delete: if false`.
  - `match /draft_sections/{id} { allow read, write: if false; }`, each on its own line or block.
  - Add the composite index and the six exemptions.
  - Add the rules file to `vitest.config.ts`'s exclude list and to `test:rules`.
  - Update the renamed test's name in `gate_g4_phase4a.sh`'s `D4_BOOT_TESTS`.
- [ ] **Step 11: Run the tests and see them pass.**
  - Run Step 5's four commands. Expected: PASS.
  - Also run `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- d4. p5. http.test"` and `npm run test:rules`. Expected: PASS, every existing D4, P5 and rules test included.
  - Then run both typechecks and both lints. Expected: zero warnings.
- [ ] **Step 12: Commit.**

```bash
git add platform/p5/permissionDecision.ts functions/src/p5/permission.ts functions/src/d4/templates.ts functions/src/d4/generations.ts functions/src/d4/drafts.ts functions/src/http/router.ts firestore.rules firestore.indexes.json vitest.config.ts package.json functions/test/d4.boot.test.ts functions/test/d4.generation.test.ts functions/test/d4.generation.emu.test.ts tests/firestore.rules.d4-phase4b.test.ts tests/p5.permission-draft-actions.test.ts tests/p5.permission-decision.parity.test.ts ci_gates/gate_g4_phase4a.sh
git commit -m "feat(d4): generation store — startDraft, getGeneration, listGenerations, empty TemplateStore, draft.generate and draft.outline.approve, server-only generation rules (P4B-1, P4B-8, P4B-9, P4B-13, P4B-16, P4B-18)

The 4a boot test is renamed (it can no longer pin exactly twelve D4 routes); the exact set is pinned by the new 4b boot test. The permission test 'exports the 6 draft actions' becomes '8'."
```

### Task 3: The outline steps: prompt, lease, time budget, deterministic-first and guardrails (P4B-2, P4B-9, P4B-10, P4B-12, P4B-14, P4B-17, P4B-19, P4B-20)

**Files:**
- Create:
  - `functions/src/d4/generationPrompt.ts`
  - `functions/src/d4/guardrails.ts`
  - `functions/src/d4/generationRun.ts`: the lease, the budget, the P1 wrapper, the outcome write and the seam.
  - `functions/src/d4/outlineOps.ts`
- Modify:
  - `functions/src/d4/templates.ts`: `deterministicFirstCheck`.
  - `functions/src/p1/ops.ts`: export `partyNamesFor`, unchanged.
  - `functions/src/http/router.ts`: `generateOutline`, `getOutline` and `approveOutline`.
  - `functions/test/d4.boot.test.ts`: append `"POST /api/d4/drafting/generateOutline p1"`, `"GET /api/d4/drafting/getOutline general"` and `"POST /api/d4/drafting/approveOutline general"`.
- Test: `functions/test/d4.generation.test.ts`, `functions/test/d4.generation.emu.test.ts`.

**Interfaces:**
- Consumes:
  - Task 1: `callP1`, `P1Result.truncated`, `P1Result.pseudonyms`, `rehydrate`, `PseudonymMap`.
  - Task 2: `generations.ts` (all of it), `activeTemplateStore`, the test helpers.
  - 4a: `requireStillPermitted`, `getDocumentType`, `extractCitations` (it returns canonical refs), `normaliseCitation`, `isUnrecognisedRef`, `checkDraftCharset`, `requireSupportedDraftBody`.
- Produces:
  - `templates.ts`: `deterministicFirstCheck(store: TemplateStore, documentTypeId: string, templateId: string): Promise<"ai" | "deterministic">`.
  - `generationPrompt.ts`:
    - `PROMPT_VERSION = "4b.1"`, `OUTLINE_PURPOSE = "draft-outline"`, `SECTION_PURPOSE = "draft-section"`
    - `outlinePrompt(i: { type: DocumentType; verbatim: readonly VerbatimField[]; facts: string }): string`
    - `sectionPrompt(i: { type: DocumentType; verbatim: readonly VerbatimField[]; facts: string; outline: OutlineContent; section: number; previousText: string | null }): string`
    - `SECTION_WORD_BUDGET = 1_000` (D25)
  - `guardrails.ts`:
    - `type OutlineContent = { sections: { heading: string; purpose: string }[]; missingFacts: { field: string; note: string }[] }`
    - `type RefusalReason = "output_truncated" | "output_unparseable" | "rehydration_failed" | "output_too_large" | "output_unsupported_characters" | "unsupported_authority"`
    - `type Guarded<T> = { ok: true; value: T } | { ok: false; reason: RefusalReason; unsupportedRefs: string[] }`
    - `MAX_OUTPUT_CHARS = 200_000`, `MAX_UNSUPPORTED_REFS = 50`
    - `validOutline(value: unknown): OutlineContent | null` (D11's shape and the outline limits, strings trimmed)
    - `parseOutlineAnswer(text: string): OutlineContent | null`
    - `outlineSha256(o: OutlineContent): string`
    - `advocateText(brief: { title: string; facts: string; verbatim: readonly VerbatimField[] }, outline?: OutlineContent): string` (the parts joined with `"\n"`)
    - `newAuthorities(text: string, own: string): string[]`
    - `checkOutlineAnswer(answer: { text: string; truncated: boolean; pseudonyms?: PseudonymMap }, own: string): Guarded<OutlineContent>`
    - `checkSectionAnswer(answer: { text: string; truncated: boolean; pseudonyms?: PseudonymMap }, own: string, heading: string): Guarded<string>`
  - `generationRun.ts`:
    - `D4_PRECALL_BUDGET_MS`, `D4_WRITE_DEADLINE_MS`, `D4_ATTEMPT_SLACK_MS`, `GENERATION_LEASE_MS`, and the import-time check
    - `d4GenerationTestSeam: { failAssembly?: boolean; outcomeWriteFailures?: Error[]; lostCommitAnswers?: Error[]; wallClock?: () => number; beforeCall?: () => Promise<void>; beforeOutcomeWrite?: () => Promise<void> }`, inert in production. `beforeCall` runs in `callDrafting` just before `callP1`; a throw from it stands in for `callP1` throwing (D27).
    - `d4Now(): number`
    - `type StepResult`: `OutlineStepResult`'s fields with `step: "outline" | "section"`
    - `type StepClaim = { claimId: string; brief: DocumentData; matter: DocumentData; label: Classification; startedMs: number }`
    - `claimLease(caller: Caller, ref: DocumentReference, step: { step: "outline" | "section"; outlineVersion: number; section: number | null }, recheck: (brief: DocumentData) => void, startedMs: number): Promise<StepClaim>`
    - `callDrafting(caller: Caller, claim: StepClaim, purpose: string, body: string, routerNow: number | undefined): Promise<P1Result>`
    - `releaseLease(ref: DocumentReference, claimId: string): Promise<void>` (D27): its own transaction; clears `inFlight` only while `inFlight.claimId === claimId`; never throws (a failure is logged with ids and a code)
    - `outcomeOf(result: P1Result, guard: Guarded<unknown> | null): { outcome: StepOutcome; reason: string | null; unsupportedRefs: string[] }`
    - `writeOutcome(a: { caller: Caller; audit: CallAudit; ref: DocumentReference; claim: StepClaim; result: P1Result; verdict: ReturnType<typeof outcomeOf>; step: "outline" | "section"; outlineVersion: number; section: number | null; deadlineMs: number; onStored?: (tx: Transaction, brief: DocumentData, label: Classification, at: Timestamp) => Record<string, unknown> }): Promise<DocumentData>`
  - `outlineOps.ts`: `generateOutlineOp`, `getOutlineOp`, `approveOutlineOp`, `type OutlineStepResult = StepResult & { step: "outline" }`, and `type OutlineView`. The view holds the outline's fields without `firmId` and `matterId`, plus `approved`.

**Contracts.**
- **`claimLease`.** One transaction does the following, in order:
  1. re-read the brief (404 if it is gone);
  2. `requireStillPermitted(tx, caller, "draft.generate", matterId)`;
  3. a closed matter is 409 `matter_closed`;
  4. `recheck(brief)`;
  5. a live lease is 409 `generation_in_progress`;
  6. `label = generationLabel(...)`;
  7. write `inFlight: { claimId: randomUUID(), step, outlineVersion, section, by: caller.uid, leaseUntil: Timestamp.fromMillis(d4Now() + GENERATION_LEASE_MS) }`, `classification: label` and `updatedAt`.

  The pre-call budget is D20's.
- **`callDrafting`.** It calls `callP1` with:
  - `taskType: "drafting"`, `classification: claim.label` and `jobId: null`;
  - `partyNames: await partyNamesFor(firmId, matterId, brief.partyNames)`, read fresh;
  - `pseudonymise: { verbatim: brief.verbatim.map((v) => v.text) }`;
  - the router-clock pattern `committeeBrain` uses.
- **`outcomeOf`.**
  - P1 `blocked` gives `blocked` with `blockReason`.
  - P1 `failed` gives `failed` with `transport_error`.
  - P1 `ok` with a failed guard gives `refused` with the guard's reason and refs.
  - Otherwise it gives `stored`.
- **`writeOutcome`.**
  - `beforeOutcomeWrite` runs once.
  - Each attempt is one transaction:
    1. re-read the brief: `inFlight?.claimId !== claim.claimId` is 409 `generation_changed`;
    2. `requireStillPermitted`;
    3. `label = generationLabel`;
    4. stage the call's audit row (D5).
  - The update adds 1 to `calls` and `result.costMicroUsd` to `costMicroUsd`, and writes:
    - `path: "ai"`, `model: result.model`, `promptVersion: PROMPT_VERSION`, `classification: label`;
    - `lastAttempt`, with `unsupportedRefs` capped at 50;
    - `inFlight: null` and `updatedAt`;
    - plus `onStored`'s fields when the outcome is `stored` (`onStored` also creates the document).
  - Seam queues: `outcomeWriteFailures` throws before an attempt; `lostCommitAnswers` throws after a commit.
  - After a failure, a brief whose `lastAttempt.usageLogId === result.usageLogId` means the write is done.
  - An `HttpError` is never retried.
  - The back-off between attempts is 100 ms, doubling, never past the start-by time. No retry starts after `D4_WRITE_DEADLINE_MS − D4_ATTEMPT_SLACK_MS` (D24), and the last error is rethrown (500, O-85).
- **The lease on an error (D27).** In both P1 routes, a throw after `claimLease` commits and before `writeOutcome` begins (from `callDrafting`, the prompt or a guard) calls `releaseLease(ref, claim.claimId)`, then rethrows. Nothing is stored on the brief; P1's usage row records any spend.
- **The guards.** Each runs the P4B-12 steps in order, and the first failure wins:
  1. `truncated`;
  2. parse or empty (`parseOutlineAnswer`; for a section, empty after D10);
  3. `pseudonyms` absent, or `rehydrate` per string, then the leftover check from Global Constraints;
  4. the total after re-hydration over 200,000;
  5. the charset rule on each string (`checkDraftCharset(s).ok`); a passing string is stored in `requireSupportedDraftBody` form;
  6. `newAuthorities(all strings, own)` not empty.

  For step 6, a ref that `isUnrecognisedRef` flags, or that does not normalise, always counts as new. Comparison is by canonical form.
- **`generateOutline`** follows the 13-step order with D3, and `baseOutlineVersion !== brief.outlineVersion` is 409 `outline_changed`.
  - The template check: if `deterministicFirstCheck(activeTemplateStore(), documentTypeId, templateId)` gives `"deterministic"`, the answer is 501 `deterministic_not_built`, with no call and no write.
  - `onStored` creates `draft_outlines/{g}_{base+1}` with `kind: "generated"`, `editedFrom: null`, the hash, the label, `path: "ai"`, `model`, `promptVersion`, `traceId`, `inputTokens`, `outputTokens`, `costMicroUsd` and `usageLogId`.
  - It also sets the brief's `outlineVersion: base + 1`, `stage: "outlined"`, `approvedOutline: null`, `sectionCount: null` and `sectionsStored: 0`.
- **`approveOutline`.**
  - The 400 checks run in field order: `invalid_generation_id`, `invalid_version`, `invalid_outline_hash`, `invalid_outline` (`validOutline`, when `outline` is present), `invalid_acknowledgement`.
  - Then `loadGenerationForCaller(…, "draft.outline.approve")`.
  - Then these refusals, in order:
    1. 409 `matter_closed` (D6);
    2. 409 `generation_closed`;
    3. `outlineVersion` 0 is 404 `outline_not_found`;
    4. a version or hash mismatch with the stored current outline is 409 `outline_changed`;
    5. a live lease is 409 `generation_in_progress` (D6);
    6. the edit's charset (422 `unsupported_characters`), then `reserved_tokens`;
    7. the acknowledgement (D7, 422).
  - One transaction re-checks all of these under `requireStillPermitted` and stages the audit row. Then:
    - **An edit (D6)** creates n + 1 (`kind: "edited"`, `editedFrom: n`, D8) and sets the approval on n + 1.
    - **No edit of a version already approved under the same hash** writes only the audit row.
    - **Otherwise** it sets `approvedOutline: { version, sha256, by: caller.uid, at, acknowledgedMissingFacts }`, `stage: "approved"`, `sectionCount` and `sectionsStored: 0`.
- **`getOutline ?generationId&version?`** (`draft.read`) answers 404 `outline_not_found` for an absent version or a current version of 0. `approved` means `approvedOutline?.version === version && approvedOutline.sha256 === sha256`.

- [ ] **Step 1: Write the failing pure tests** in `functions/test/d4.generation.test.ts`.
  - Under `describe("D4 outline answer parser (P4B-12 step 2)")`:

    ```ts
    // Review Focus 3
    it("accepts the bare JSON object or exactly one json fence, and nothing else", () => {
      const j = outlineJson([{ heading: "Facts", purpose: "State the facts." }])
      for (const ok of [j, `  ${j}\n`, "```json\n" + j + "\n```", "```JSON\n" + j + "\n```"]) expect(parseOutlineAnswer(ok)).not.toBeNull()
      for (const bad of [`Here is the outline:\n${j}`, `${j}\nHope this helps.`, "```json\n" + j + "\n```\n```json\n" + j + "\n```", "```\n" + j + "\n```", "{}", "not json"]) expect(parseOutlineAnswer(bad)).toBeNull()
    })
    it("enforces the limits: 1-25 sections, one-line headings of 1-200, purposes of 1-2,000, 0-50 missing facts with one-line fields of 1-100 and notes of 1-500", () => {
      // each boundary passes and boundary + 1 fails: 0 and 26 sections, "" and 201-character headings, a heading with "\n", a 2,001-character purpose, 51 missing facts, a 101-character field, a field with "\n", a 501-character note
    })
    it("refuses extra keys, a missing missingFacts, and a non-string value", () => {
      expect(validOutline({ sections: [{ heading: "H", purpose: "P" }], missingFacts: [], extra: 1 })).toBeNull()
      expect(validOutline({ sections: [{ heading: "H", purpose: "P" }] })).toBeNull()
      expect(validOutline({ sections: [{ heading: "H", purpose: 7 }], missingFacts: [] })).toBeNull()
    })
    ```

  - Under `describe("D4 guardrails (P4B-12)")`. Use `pseudo = pseudonymise(FACTS, { partyNames: [INSTITUTION, PERSON] })` and `own = advocateText({ title: "T", facts: FACTS, verbatim: [] })`.

    ```ts
    it("the checks run in order and the first failure wins: truncated, unparseable, rehydration, size, charset, authority", () => {
      expect(checkSectionAnswer({ text: "", truncated: true, pseudonyms: pseudo.map }, own, "Grounds")).toMatchObject({ ok: false, reason: "output_truncated" })
      expect(checkSectionAnswer({ text: "⟦PARTY_9⟧ ‮ 2099 SCMR 7", truncated: false, pseudonyms: pseudo.map }, own, "Grounds")).toMatchObject({ ok: false, reason: "rehydration_failed" })
      expect(checkSectionAnswer({ text: "‮ 2099 SCMR 7", truncated: false, pseudonyms: pseudo.map }, own, "Grounds")).toMatchObject({ ok: false, reason: "output_unsupported_characters" })
    })
    // Review Focus 1
    it("rehydration_failed for any bracket, lossy token or bare token left after re-hydration, a damaged token included", () => {
      for (const t of ["⟦PARTY_9⟧", "⟦party_1⟧", "⟦PARTY_1 ⟧", "a lone ⟧", "PARTY_1", "CNIC_1", "VERBATIM_2", "[CNIC]", "[PARTY]", "no pseudonyms"])
        expect([t, checkSectionAnswer({ text: t, truncated: false, pseudonyms: t === "no pseudonyms" ? undefined : pseudo.map }, own, "H").ok]).toEqual([t, false])
    })
    it("output_too_large over 200,000 characters after re-hydration, and not at 200,000", () => {
      // "a".repeat(200_000) passes; the token ⟦PARTY_1⟧ that brings the total to 200,001 after re-hydration is refused output_too_large
    })
    it("unsupported_authority: a ref not in the advocate's own text, or an UNRECOGNISED suspect, is new; at most 50 are recorded", () => {
      expect(checkSectionAnswer({ text: `Relies on ${NEW_CITATION}.`, truncated: false, pseudonyms: pseudo.map }, own, "H")).toEqual({ ok: false, reason: "unsupported_authority", unsupportedRefs: [NEW_CITATION] })
      expect(checkSectionAnswer({ text: `Relies on ${OWN_CITATION}.`, truncated: false, pseudonyms: pseudo.map }, own, "H")).toMatchObject({ ok: true })
      // 60 distinct 2099 refs give unsupportedRefs of length 50; for a section, refs in the approved outline count as the advocate's
    })
    // Review Focus 5
    it("an authority the advocate wrote in another form is the advocate's authority", () => {
      const ownOdd = advocateText({ title: "T", facts: "Relies on P.L.D. 2099 Supreme Court 101.", verbatim: [] })
      expect(checkSectionAnswer({ text: `As held in ${OWN_CITATION}.`, truncated: false, pseudonyms: pseudo.map }, ownOdd, "H")).toMatchObject({ ok: true })
    })
    // Review Focus 4
    it("a section whose first line repeats its heading loses that line; a section with nothing else is output_unparseable", () => {
      expect(checkSectionAnswer({ text: "GROUNDS:\n\nThe order is void.", truncated: false, pseudonyms: pseudo.map }, own, "Grounds")).toEqual({ ok: true, value: "The order is void." })
      expect(checkSectionAnswer({ text: "Grounds\n\n", truncated: false, pseudonyms: pseudo.map }, own, "Grounds")).toMatchObject({ ok: false, reason: "output_unparseable" })
    })
    it("an outline answer is re-hydrated string by string and stored in the charset rule's normalised form", () => {
      const r = checkOutlineAnswer({ text: outlineJson([{ heading: "Facts", purpose: "The case of ⟦PARTY_2⟧ against ⟦PARTY_1⟧." }]), truncated: false, pseudonyms: pseudo.map }, own)
      expect(r).toEqual({ ok: true, value: { sections: [{ heading: "Facts", purpose: `The case of ${PERSON} against ${INSTITUTION}.` }], missingFacts: [] } })
    })
    ```

  - Under `describe("D4 outline hash (P4B-10)")`:

    ```ts
    it("outlineSha256 is the SHA-256 of JSON.stringify({ sections: [{ heading, purpose }], missingFacts: [{ field, note }] }), keys in that order", () => {
      const o = { missingFacts: [{ note: "n", field: "f" }], sections: [{ purpose: "p", heading: "h" }] }
      expect(outlineSha256(o)).toBe(sha256Hex('{"sections":[{"heading":"h","purpose":"p"}],"missingFacts":[{"field":"f","note":"n"}]}'))
    })
    ```

  - Under `describe("D4 generation prompt (P4B-4, prompt contract)")`:

    ```ts
    it("the outline prompt carries the fixed instructions, the type's name, firstGroundRule and requiredFields, the verbatim fields as <field>: <text>, and the facts; never a label, a matter id or a party list", () => {
      const p = outlinePrompt({ type: getDocumentType(DEED)!, verbatim: [{ field: "exactLandDescription", text: LAND }], facts: FACTS })
      for (const s of [getDocumentType(DEED)!.name, getDocumentType(DEED)!.firstGroundRule, ...getDocumentType(DEED)!.requiredFields, `exactLandDescription: ${LAND}`, FACTS, '"sections"', '"missingFacts"', "⟦"]) expect(p).toContain(s)
      for (const s of ["classification", "matterId", "partyNames"]) expect(p).not.toContain(s) // the signature takes no label, id or party list; the emulator tests 1 and "classification" check the sent bodies
      expect(outlinePrompt({ type: getDocumentType(DEED)!, verbatim: [], facts: FACTS })).toBe(outlinePrompt({ type: getDocumentType(DEED)!, verbatim: [], facts: FACTS }))
    })
    it("the section prompt carries section i of k, the numbered approved outline and section i − 1's text", () => {
      const p = sectionPrompt({ type: getDocumentType(TYPE)!, verbatim: [], facts: FACTS, outline: { sections: [{ heading: "Facts", purpose: "pf" }, { heading: "Grounds", purpose: "pg" }], missingFacts: [] }, section: 2, previousText: "PREVIOUS SECTION TEXT" })
      for (const s of ["2 of 2", "1. Facts", "2. Grounds", "PREVIOUS SECTION TEXT", getDocumentType(TYPE)!.firstGroundRule]) expect(p).toContain(s)
    })
    it("both prompts carry the section word budget: the section prompt caps the body at about 1,000 words and the outline prompt asks for longer parts to be split (D25)", () => {
      expect(SECTION_WORD_BUDGET).toBe(1_000)
      expect(sectionPrompt({ type: getDocumentType(TYPE)!, verbatim: [], facts: FACTS, outline: { sections: [{ heading: "Facts", purpose: "pf" }], missingFacts: [] }, section: 1, previousText: null })).toContain("1,000 words")
      expect(outlinePrompt({ type: getDocumentType(TYPE)!, verbatim: [], facts: FACTS })).toContain("1,000 words")
    })
    it("PROMPT_VERSION is 4b.1 and the purposes are draft-outline and draft-section", () => {
      expect([PROMPT_VERSION, OUTLINE_PURPOSE, SECTION_PURPOSE]).toEqual(["4b.1", "draft-outline", "draft-section"])
    })
    ```

  - Under `describe("D4 generation time budget (P4B-17)")`:

    ```ts
    it("P1's 102 s worst case, the 5 s pre-call budget and the 10 s write deadline make 117 s, inside the 120 s timeout; 4 s of the write deadline is the in-flight slack; the 180 s lease outlives the timeout", () => {
      expect(TRANSPORT_TIMEOUT_MS + OPIK_TIMEOUT_MS + COMMIT_DEADLINE_MS + COMMIT_ATTEMPT_SLACK_MS).toBe(102_000)
      expect([D4_PRECALL_BUDGET_MS, D4_WRITE_DEADLINE_MS, D4_ATTEMPT_SLACK_MS, GENERATION_LEASE_MS]).toEqual([5_000, 10_000, 4_000, 180_000])
      expect(102_000 + D4_PRECALL_BUDGET_MS + D4_WRITE_DEADLINE_MS).toBe(117_000); expect(117_000).toBeLessThan(FUNCTION_TIMEOUT_SECONDS * 1000)
      expect(GENERATION_LEASE_MS).toBeGreaterThan(FUNCTION_TIMEOUT_SECONDS * 1000)
    })
    ```

- [ ] **Step 2: Write the failing emulator tests** in `functions/test/d4.generation.emu.test.ts`, under `describe("D4 generation: outline steps (P4B-9, P4B-10, P4B-12, P4B-14, P4B-17, P4B-19, P4B-20)")`.
  - `afterEach` resets these:
    - `setProviderConfigForTests(null)`, `setTemplateStoreForTests(null)`, `setAuthorityStoreForTests(null)`, `setP1TransportForTests(null)` and `setOpikFetchForTests(null)`;
    - every `d4GenerationTestSeam` key;
    - `vi.unstubAllEnvs()`, then `vi.restoreAllMocks()`.
  - The helper `outlined(f, opts)` runs `start`, then `generateOutline` with one scripted answer, and returns `{ generationId, outlineVersion, sha }`.

```ts
it("2. bad tokens: ⟦PARTY_9⟧, a bare PARTY_1 and [CNIC] in an answer are each refused rehydration_failed, with nothing stored", async () => {
  for (const bad of ["⟦PARTY_9⟧", "PARTY_1", "[CNIC]"]) {
    scripted([{ text: outlineJson([{ heading: "Facts", purpose: `The case of ${bad}.` }]) }])
    const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    expect([bad, r.outcome, r.reason, r.called]).toEqual([bad, "refused", "rehydration_failed", true])
  }
  expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
  expect(brief).toMatchObject({ outlineVersion: 0, stage: "facts", calls: 3, lastAttempt: { step: "outline", outcome: "refused", reason: "rehydration_failed" } })
})
it("4. privileged, no DPA: policy_denied, ai.call.blocked, recorded on the brief, and no outline stored", async () => {
  const f = await newFirm("privileged"); setProviderConfigForTests({}); const sent = scripted([])
  const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
  expect([r.outcome, r.reason, r.called, r.usage.costMicroUsd]).toEqual(["blocked", "policy_denied", true, 0])
  expect(sent).toHaveLength(0)
  expect((await docsOf("events", f.firmId)).filter((e) => e.name === "ai.call.blocked" && e.id.startsWith(r.usageLogId!))).toHaveLength(1)
  expect(brief).toMatchObject({ classification: "privileged", calls: 1, costMicroUsd: 0, stage: "facts", lastAttempt: { outcome: "blocked", reason: "policy_denied", usageLogId: r.usageLogId } })
  expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
})
it("6a. approval binding: a clerk is 403 role_not_permitted, a wrong hash or version is 409 outline_changed, unacknowledged missing facts are 422, and an edit is stored as n + 1 (kind edited) and approved", async () => {
  // outline 1 has one missingFacts entry
  expect((await apiErrorOf(approveApi(f.C, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [0] }))).code).toBe("role_not_permitted")
  expect((await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: "0".repeat(64), acknowledgedMissingFacts: [0] }))).code).toBe("outline_changed")
  expect((await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 2, outlineSha256: sha, acknowledgedMissingFacts: [0] }))).code).toBe("outline_changed")
  expect((await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [] }))).code).toBe("missing_facts_not_acknowledged")
  const edit = { sections: [{ heading: "Facts", purpose: "State the facts." }, { heading: "Prayer", purpose: "Pray for relief." }], missingFacts: [] }
  const ok = await approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, outline: edit, acknowledgedMissingFacts: [] })
  expect(ok).toEqual({ generationId: g, stage: "approved", outlineVersion: 2, outlineSha256: outlineSha256(edit), sectionCount: 2 })
  expect(outline2).toMatchObject({ version: 2, kind: "edited", editedFrom: 1, sha256: outlineSha256(edit), path: null, costMicroUsd: 0, usageLogId: outline1.usageLogId })
  expect(brief.approvedOutline).toMatchObject({ version: 2, sha256: outlineSha256(edit), by: f.A.uid, acknowledgedMissingFacts: [] })
  // D6: an "edit" identical to the current outline is no edit: on a fresh generation, approving outline 1 with outline equal to its stored content approves version 1 and stores no version 2
})
it("8. rank 4: privileged-restricted is policy_denied with an empty config and with a DPA but not in-region; no deterministic path is offered", async () => {
  for (const cfg of [{}, { "ai-gateway": { dpaExecuted: true, inRegion: false } }]) {
    setProviderConfigForTests(cfg)
    const r = await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })
    expect([r.outcome, r.reason, r.path]).toEqual(["blocked", "policy_denied", "ai"])
  }
  expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
})
it("deterministic-first: a test template gives 501 deterministic_not_built with no transport call, no usage row and the brief unchanged", async () => {
  setTemplateStoreForTests(new InMemoryTemplateStore().addTemplate(TYPE, "template_cp_199_v1")); const sent = scripted([])
  const e = await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))
  expect([e.status, e.code, sent.length, (await docsOf("ai_usage_logs", f.firmId)).length]).toEqual([501, "deterministic_not_built", 0, 0])
  expect(brief).toMatchObject({ calls: 0, path: null, inFlight: null })
})
it("ranks 0-4 through setProviderConfigForTests: {} lets ranks 0-1 through, a DPA adds ranks 2-3, a DPA in-region adds rank 4", async () => {
  const labels = ["public", "internal", "confidential", "privileged", "privileged-restricted"]
  const expectFor = { none: ["stored", "stored", "blocked", "blocked", "blocked"], dpa: ["stored", "stored", "stored", "stored", "blocked"], region: ["stored", "stored", "stored", "stored", "stored"] }
  // one firm and one brief per label and config; the public brief is labelled internal
  expect(outcomes).toEqual(expectFor)
})
it("reserved tokens in an outline edit are 422 reserved_tokens, and nothing is stored", async () => {
  const e = await apiErrorOf(approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, outline: { sections: [{ heading: "⟦PARTY_1⟧", purpose: "p" }], missingFacts: [] }, acknowledgedMissingFacts: [] }))
  expect([e.status, e.code]).toEqual([422, "reserved_tokens"]); expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(1); expect(brief.approvedOutline).toBeNull()
})
it("R12: a member removed during the call gets 403 at the outcome write; nothing is stored and the usage row is present", async () => {
  d4GenerationTestSeam.beforeOutcomeWrite = () => adminDb().collection("matter_members").doc(`${f.matterId}_${f.A.uid}`).delete().then(() => undefined)
  const e = await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))
  expect([e.status, e.code]).toEqual([403, "not_member"])
  expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0); expect(brief).toMatchObject({ calls: 0, outlineVersion: 0 })
  expect((await docsOf("ai_usage_logs", f.firmId)).map((u) => u.outcome)).toEqual(["ok"])
})
it("a stored outline: version base + 1, kind generated, with its hash, label, path ai, model, prompt version and usage; the answer holds ids and usage only", async () => {
  expect(Object.keys(r).sort()).toEqual(["called", "generationId", "model", "outcome", "outlineVersion", "path", "reason", "stage", "step", "traceId", "usage", "usageLogId"])
  expect(r).toMatchObject({ stage: "outlined", step: "outline", outlineVersion: 1, called: true, outcome: "stored", reason: null, path: "ai", model: "anthropic/claude-opus-5.5", usage: { inputTokens: 1000, outputTokens: 500, costMicroUsd: 14000 } })
  expect(outline1).toMatchObject({ version: 1, kind: "generated", editedFrom: null, sha256: outlineSha256(outline1Content), classification: "internal", path: "ai", promptVersion: "4b.1", usageLogId: r.usageLogId, traceId: r.traceId, costMicroUsd: 14000 })
  expect(brief).toMatchObject({ stage: "outlined", outlineVersion: 1, path: "ai", promptVersion: "4b.1", calls: 1, costMicroUsd: 14000, inFlight: null })
})
it("a new outline voids the approval; a stale base is 409 outline_changed; a stored base + 1 is returned with called: false and no transport call", async () => {
  // after approving 1: generateOutline base 1 gives version 2, stage outlined, approvedOutline null, sectionCount null, sectionsStored 0
  // base 0 again: called false, outcome stored, outlineVersion 1, usage zeros, usageLogId null, traceId null, sent.length unchanged
  // base 5: 409 outline_changed
})
it("a live lease is 409 generation_in_progress for generateOutline and approveOutline, and the outcome write releases it", async () => {
  // a transport held open by a promise: while the first call is in flight, a second generateOutline (new key) and an approveOutline each give 409 generation_in_progress; after the release, brief.inFlight is null
})
it("a lease that is no longer this request's at the outcome write is 409 generation_changed, with nothing stored", async () => {
  d4GenerationTestSeam.beforeOutcomeWrite = () => generations().doc(g).update({ "inFlight.claimId": "someone-else" }).then(() => undefined)
  expect((await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).code).toBe("generation_changed")
  expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(0)
})
it("the outcome write is retried to the D4 deadline, and a lost commit answer is confirmed by lastAttempt.usageLogId: one outline, billed once", async () => {
  d4GenerationTestSeam.outcomeWriteFailures = [Object.assign(new Error("x"), { code: 14 })]; d4GenerationTestSeam.lostCommitAnswers = [Object.assign(new Error("y"), { code: 14 })]
  expect(r.outcome).toBe("stored"); expect(await docsOf("draft_outlines", f.firmId)).toHaveLength(1); expect(brief).toMatchObject({ calls: 1, costMicroUsd: 14000 })
})
it("the pre-call budget: past 5,000 ms before the lease commits is 503 generation_busy, with no call made and no lease left", async () => {
  let t = Date.now(); d4GenerationTestSeam.wallClock = () => (t += 6_000); const sent = scripted([])
  expect((await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).code).toBe("generation_busy")
  expect(sent).toHaveLength(0); expect(brief.inFlight).toBeNull()
})
it("a throw after the lease commits and before the outcome write releases the lease: the request fails, nothing is billed or stored, and a retry runs at once (D27)", async () => {
  d4GenerationTestSeam.beforeCall = () => Promise.reject(Object.assign(new Error("boom"), { code: 14 })); const sent = scripted([{ text: outlineJson([{ heading: "Facts", purpose: "State the facts." }]) }])
  expect((await apiErrorOf(outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 }))).status).toBe(500)
  expect(brief).toMatchObject({ inFlight: null, calls: 0, outlineVersion: 0 }); expect(sent).toHaveLength(0); expect(await docsOf("ai_usage_logs", f.firmId)).toHaveLength(0)
  delete d4GenerationTestSeam.beforeCall
  expect(await outlineApi(f.A, { generationId: g, baseOutlineVersion: 0 })).toMatchObject({ outcome: "stored", outlineVersion: 1 })
})
it("approveOutline with no edit of a version already approved under the same hash writes only its audit row", async () => {
  expect(briefAfter.updatedAt.isEqual(briefBefore.updatedAt)).toBe(true)
  // requirePermission writes its own rows (target matters/…); the call's rows target the brief
  expect(audits.filter((a) => a.action === "draft.outline.approve" && a.target === `draft_generations/${g}` && a.decision === "allow")).toHaveLength(2)
})
it("getOutline returns the current or a named version with approved; an absent version is 404 outline_not_found; a closed matter is 409 matter_closed for generateOutline and approveOutline", async () => {
  expect(await getOutlineApi(f.C, { generationId: g })).toMatchObject({ version: 1, approved: true }); expect((await getOutlineApi(f.C, { generationId: g, version: "9" }).catch((e) => e)).code).toBe("outline_not_found")
  // status set to "closed": generateOutline and approveOutline each give 409 matter_closed
})
```

- [ ] **Step 3: Run them and see them fail.**
  - Run `npm --prefix functions test -- d4.generation.test`. Expected: FAIL, because the modules are missing.
  - Run `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- d4.generation.emu -t 'D4 generation: outline steps'"`. Expected: FAIL with `route_not_found`.
- [ ] **Step 4: Implement `deterministicFirstCheck`.** It returns `"deterministic"` when `store.findTemplate(documentTypeId, templateId)` is not null, and `"ai"` otherwise.
- [ ] **Step 5: Implement `generationPrompt.ts`.**
  - The fixed text carries the spec's "Prompt contract" bullets for each call, in its own words.
  - The outline prompt is followed by the type's `name`, `firstGroundRule` and `requiredFields`, one `<field>: <text>` line per verbatim field, and the facts.
  - The section prompt is followed by the type's `name` and `firstGroundRule`, the verbatim lines, the facts, the outline numbered `1. <heading>: <purpose>`, `section i of k`, and section i − 1's text when there is one.
  - D25: the section instructions ask for a body of at most about 1,000 words (`SECTION_WORD_BUDGET`, written "1,000 words"). The outline instructions ask for any part that would need more to be split into further sections, within 25.
- [ ] **Step 6: Implement `guardrails.ts`** to the interface and the guard contract. Export `partyNamesFor` from `p1/ops.ts`.
- [ ] **Step 7: Implement `generationRun.ts`** to the contracts. Place the import-time check beside P1's: if `TRANSPORT_TIMEOUT_MS + OPIK_TIMEOUT_MS + COMMIT_DEADLINE_MS + COMMIT_ATTEMPT_SLACK_MS + D4_PRECALL_BUDGET_MS + D4_WRITE_DEADLINE_MS >= FUNCTION_TIMEOUT_SECONDS * 1000`, or if `D4_ATTEMPT_SLACK_MS >= D4_WRITE_DEADLINE_MS`, it throws.
- [ ] **Step 8: Implement `outlineOps.ts`**, register the three routes, and append them to `D4_GENERATION_ROUTES`.
- [ ] **Step 9: Run the tests and see them pass.**
  - Run Step 3's two commands, and `npm --prefix functions test -- d4.boot`. Expected: PASS.
  - Run `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- d4. p1.api.emu"`. Expected: PASS, the 4a suites included.
  - Then run both typechecks and both lints. Expected: zero warnings.
- [ ] **Step 10: Commit.**

```bash
git add functions/src/d4/templates.ts functions/src/d4/generationPrompt.ts functions/src/d4/guardrails.ts functions/src/d4/generationRun.ts functions/src/d4/outlineOps.ts functions/src/p1/ops.ts functions/src/http/router.ts functions/test/d4.boot.test.ts functions/test/d4.generation.test.ts functions/test/d4.generation.emu.test.ts
git commit -m "feat(d4): generateOutline, getOutline, approveOutline — prompt 4b.1, lease and time budget, deterministic-first check, fail-closed guardrails, outline approval bound to version and hash (P4B-2, P4B-9, P4B-10, P4B-12, P4B-14, P4B-17)"
```

### Task 4: `generateDraft`: the sections, assembly and version 1 (P4B-3, P4B-11, P4B-13, P4B-15, P4B-16)

**Files:**
- Create: `functions/src/d4/sectionOps.ts`.
- Modify:
  - `functions/src/d4/drafts.ts`:
    - `stageDraftEvent`'s name union gains `"draft.generated"`;
    - `DraftView` gains `generationId?: string`;
    - `draftView` returns `generationId` when the row has it.
  - `functions/src/d4/gateOps.ts`: export `resultDocument`, `summaryOf` and `requireStorable`, unchanged.
  - `functions/src/http/router.ts`: `generateDraft`.
  - `functions/test/d4.boot.test.ts`: append `"POST /api/d4/drafting/generateDraft p1"`.
- Test: `functions/test/d4.generation.test.ts`, `functions/test/d4.generation.emu.test.ts`.

**Interfaces:**
- Consumes:
  - Task 3: `claimLease`, `callDrafting`, `outcomeOf`, `writeOutcome`, `d4Now`, `d4GenerationTestSeam`, `StepResult`, `checkSectionAnswer`, `advocateText`, `sectionPrompt`, `SECTION_PURPOSE`, `deterministicFirstCheck`.
  - Task 2: `generations.ts`.
  - 4a: `checkedText`, `sha256Hex`, `classifyForMatter`, `strictest`, `requireStillPermitted`, `stageDraftEvent`, `versionId`, `runGate`, `activeAuthorityStore`, `normaliseEvaluation`, `resultDocument`, `summaryOf`, `requireStorable`.
- Produces:
  - `type SectionStepResult = StepResult & { step: "section"; section: number; assembly: "none" | "assembled" | "refused" | "pending"; assemblyReason: AssemblyReason | null; draftId: string | null }`
  - `type AssemblyReason = "draft_too_large" | "gate_result_too_large" | "matter_closed" | "court_mismatch"`
  - `assembleBody(sections: readonly { heading: string; text: string }[]): string`
  - `assembleGeneration(caller: Caller, ref: DocumentReference, deadlineMs: number): Promise<{ assembly: SectionStepResult["assembly"]; assemblyReason: AssemblyReason | null; draftId: string | null }>`
  - `generateDraftOp`

**Contracts.**
- **`generateDraft`.**
  - Parse: `invalid_generation_id`, then `invalid_version` (`outlineVersion` ≥ 1), then `invalid_section` (≥ 1).
  - Then `loadGenerationForCaller(…, "draft.generate")`, then the 13-step order, with D3 for step 4 and D4 for step 6.
  - The prompt takes the approved outline (`draft_outlines/{g}_{v}`) and `previousText`, which is section i − 1's stored text.
  - `own = advocateText(brief, approved outline)`.
  - `onStored` creates `draft_sections/{g}_{v}_{i}` with:
    - `heading`, `text`, `textSha256: sha256Hex(text)` and `classification: label`;
    - `path: "ai"`, `model`, `promptVersion`, `usageLogId`, `traceId`, `inputTokens`, `outputTokens`, `costMicroUsd`;
    - `createdBy` and `createdAt`.

    On the brief it sets `sectionsStored: i` and `stage: "drafting"`.
  - Assembly is due when the stored section is `sectionCount` of the approved version. After the outcome write, `assembleGeneration` runs with `deadlineMs` (D19).
  - In the step-4 shortcut, the answer is:
    - `assembly: "assembled"` with the brief's `draftId`, when the stage is already `assembled`;
    - otherwise, `assembleGeneration` with `deadlineMs = d4Now() + D4_WRITE_DEADLINE_MS`, when assembly is due;
    - otherwise `"none"`.
- **`assembleGeneration`.**
  1. Read the approved outline's sections 1 to k with one `getAll` (D28). Build `assembleBody`.
  2. Run `checkedText(brief.title, body)`. A 422 `draft_too_large` gives `refused` / `draft_too_large`.
  3. `normaliseEvaluation(await runGate({ title, body, temporalChecks: [] }, activeAuthorityStore()))`, then `requireStorable`. A 422 `gate_result_too_large` gives `refused`.
  4. One transaction. Each attempt first checks the deadline and `failAssembly` (D14, D19). Then:
     - re-read the brief: `assembled` returns its `draftId`; a changed approval or `sectionsStored !== sectionCount` gives `"none"`;
     - `requireStillPermitted(tx, caller, "draft.generate", matterId)`;
     - `classification = classifyForMatter(caller, matter, documentTypeId, strictest([brief.classification, matter.classification]))` (D22). A 409 `matter_closed` or 422 `court_mismatch` gives `refused`.
  5. Write:
     - `drafts/{auto}`, as `createDraftOp` writes it, plus `generationId`, `gateResult: summaryOf(1, sha, status, at, false, doc.resultId)` and `lastGatedVersion: 1`;
     - `draft_versions/{d}_1`, with `kind: "generate"`, `generation: { generationId, outlineVersion, outlineSha256, path: "ai", model, promptVersion, usageLogIds, costMicroUsd: brief.costMicroUsd, masterVersion: null }` (D9) and `createdBy: caller.uid`;
     - `draft_gate_results/{d}_1`, as `resultDocument(draft, d, 1, sha, e, caller.uid, at, 1)`;
     - `stageDraftEvent` three times: `"draft.generated"`/`"generated"`, `"draft.autosaved"`/`"autosaved"` and `"draft.gated"`/`"gated_1"`, each with `gateResult: e.status`;
     - the brief: `stage: "assembled"`, `draftId`, `classification` and `updatedAt`;
     - `stageAudit({ firmId, actorId: caller.uid, action: "draft.generate", target: \`drafts/${draftId}\`, classification, decision: "allow", reason: "assembled" }, tx)`.

- [ ] **Step 1: Write the failing pure test** in `functions/test/d4.generation.test.ts`, under `describe("D4 assembly body (P4B-11)")`:

```ts
it("each section is its heading, a blank line and its text, with a blank line between sections", () => {
  expect(assembleBody([{ heading: "Facts", text: "1. The petitioner." }, { heading: "Prayer", text: "It is prayed." }])).toBe("Facts\n\n1. The petitioner.\n\nPrayer\n\nIt is prayed.")
})
```

- [ ] **Step 2: Write the failing emulator tests** in `functions/test/d4.generation.emu.test.ts`, under `describe("D4 generation: sections and assembly (P4B-3, P4B-11, P4B-13, P4B-15, P4B-16)")`.
  - The helper `approved(f, { sections: n, start?: over })` runs `outlined` and then `approveOutline`, and returns `{ generationId, outlineVersion }`.
  - Section answers use `(body) => …` to echo the tokens found in the body (`tokensIn`).

```ts
it("1. mask round trip: the transport and the trace receive neither the CNIC nor either party name; the stored outline, sections and draft hold the real text; no row, event, audit row, idempotency row or log line holds a fixture value", async () => {
  // PERSON is a matter_parties row; INSTITUTION is supplied in partyNames; FACTS carry CNIC and PHONE
  const opik = fakeOpik(); const logs = spyLogs()
  // outline: purposes echo ⟦PARTY_n⟧; two sections echo every PARTY and CNIC token
  for (const b of sent.map((s) => s.body)) for (const v of [PERSON, INSTITUTION, CNIC, PHONE, f.matterId]) expect(b).not.toContain(v)
  for (const v of [PERSON, INSTITUTION, CNIC]) expect(version1.body).toContain(v)
  expect(JSON.stringify(sections.map((s) => s.text))).toContain(INSTITUTION); expect(JSON.stringify(outline1.sections)).toContain(PERSON)
  const leaks = JSON.stringify([await docsOf("ai_usage_logs", f.firmId), await docsOf("events", f.firmId), await docsOf("audit_log", f.firmId), await idempotencyRowsOf(f.firmId), opik.bodies, logs.all()])
  for (const v of [PERSON, INSTITUTION, CNIC, PHONE]) expect(leaks).not.toContain(v)
})
it("3. introduced authority: a section citing 2099 SCMR 7 is refused with the ref on the brief only; one citing only PLD 2099 SC 101 is stored, assembled and gated UNVERIFIED; approval is gate_blocked until a member partner overrides", async () => {
  setAuthorityStoreForTests(new InMemoryAuthorityStore())
  scripted([{ text: `The order offends ${NEW_CITATION}.` }])
  const refused = await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })
  expect([refused.outcome, refused.reason]).toEqual(["refused", "unsupported_authority"]); expect(JSON.stringify(refused)).not.toContain(NEW_CITATION)
  expect(brief.lastAttempt.unsupportedRefs).toEqual([NEW_CITATION]); expect(await docsOf("draft_sections", f.firmId)).toHaveLength(0)
  scripted([{ text: `The order offends ${OWN_CITATION}.` }])
  const ok = await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })
  expect([ok.outcome, ok.assembly]).toEqual(["stored", "assembled"])
  const report = await reportApi(f.P, { draftId: ok.draftId }); expect(report.gateResult.status).toBe("UNVERIFIED")
  expect((await apiErrorOf(approveDraftApi(f.P, { draftId: ok.draftId, version: 1, resultId: report.gateResult.resultId }))).code).toBe("gate_blocked")
  const latest = (await reportApi(f.P, { draftId: ok.draftId })).gateResult.resultId
  await overrideApi(f.P, { draftId: ok.draftId, version: 1, resultId: latest, reason: "The partner has read the authority and accepts it on the record." })
  expect((await approveDraftApi(f.P, { draftId: ok.draftId, version: 1, resultId: latest })).draft).toMatchObject({ status: "approved", locked: true, generationId: g })
})
it("5. truncation: a length and an absent finish_reason are each refused output_truncated; the call is billed on the brief and the usage row, and no section is stored", async () => {
  for (const finishReason of ["length", null]) {
    scripted([{ text: "The order is void.", finishReason }])
    const r = await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })
    expect([finishReason, r.outcome, r.reason, r.usage.costMicroUsd]).toEqual([finishReason, "refused", "output_truncated", 14000])
  }
  expect(brief).toMatchObject({ costMicroUsd: before + 28000, calls: callsBefore + 2 })
  expect((await docsOf("ai_usage_logs", f.firmId)).filter((u) => u.taskType === "drafting" && u.costMicroUsd === 14000).length).toBeGreaterThanOrEqual(3)
  expect(await docsOf("draft_sections", f.firmId)).toHaveLength(0)
})
it("6b. generateDraft binding: 409 outline_not_approved before approval, and 409 outline_changed after a newer outline", async () => {
  expect((await apiErrorOf(draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 }))).code).toBe("outline_not_approved")
  // approve 1, then generateOutline base 1 stores 2
  expect((await apiErrorOf(draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 }))).code).toBe("outline_changed")
})
it("7. stop between sections: a firm kill switch after section 1 leaves section 2 blocked and section 1 stored; once cleared, section 2 (new key) is stored with no second call for section 1; the same holds for budget_exhausted", async () => {
  // two sections; section 1 stored (1 transport call)
  await firmConfigRef(f.firmId).set({ killSwitch: { disableAll: true, disabledModels: [], reason: "stop", setBy: f.P.uid, setAt: Timestamp.now() } }, { merge: true })
  expect(await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 2 })).toMatchObject({ outcome: "blocked", reason: "kill_switch_firm", assembly: "none" })
  await firmConfigRef(f.firmId).update({ killSwitch: FieldValue.delete() })
  expect(await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 2 })).toMatchObject({ outcome: "stored", assembly: "assembled" })
  expect(sent).toHaveLength(2) // `sent` is the transport scripted after approval: section 1 once, section 2 once, nothing while blocked
  // a second generation: after section 1, monthRef(firmId, month).set({ spentMicroUsd: 1_000_000_000 }) gives section 2 "blocked"/"budget_exhausted"; deleting it stores section 2; sent grows by 2 in total
})
it("9. replay: a same-key replay has no text field; a new-key request for a stored section makes no transport call; two concurrent requests for one section make one call, and the other gets 409 generation_in_progress", async () => {
  const key = randomUUID(); const a = await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 }, { "idempotency-key": key })
  const b = await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 }, { "idempotency-key": key })
  expect(b).toEqual({ ...a, reused: true }); expect(Object.keys(a).sort()).toEqual(["assembly", "assemblyReason", "called", "draftId", "generationId", "model", "outcome", "outlineVersion", "path", "reason", "section", "stage", "step", "traceId", "usage", "usageLogId"])
  const c = await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })
  expect(c).toMatchObject({ called: false, outcome: "stored", usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }, usageLogId: null, traceId: null }); expect(sent).toHaveLength(1)
  // section 2: a held transport; the first request is in flight, a second (new key) gives 409 generation_in_progress; after the release one section 2 exists and sent.length is 2
})
it("10. one assembly transaction: a seam failure in assembly leaves no draft, version, gate result or event, and a retry assembles; draft_versions/{id}_1 and draft_gate_results/{id}_1 share bodySha256", async () => {
  d4GenerationTestSeam.failAssembly = true
  expect(await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })).toMatchObject({ outcome: "stored", assembly: "pending", draftId: null })
  for (const c of ["drafts", "draft_versions", "draft_gate_results"]) expect(await docsOf(c, f.firmId)).toHaveLength(0)
  expect((await docsOf("events", f.firmId)).filter((e) => e.name.startsWith("draft."))).toHaveLength(0)
  d4GenerationTestSeam.failAssembly = false
  const r = await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })
  expect(r).toMatchObject({ called: false, assembly: "assembled" })
  expect(version1.bodySha256).toBe(result1.bodySha256); expect(result1.gateRuns).toBe(1); expect(draft.gateResult.resultId).toBe(result1.resultId)
})
it("verbatim: the text is stored exactly in the section and the draft, and is never sent", async () => {
  // DEED with verbatim [{ field: "exactLandDescription", text: LAND }]; the outline purpose and the section answer echo ⟦VERBATIM_1⟧
  for (const b of sent.map((s) => s.body)) expect(b).not.toContain(LAND)
  expect(brief.verbatim).toEqual([{ field: "exactLandDescription", text: LAND }]); expect(section1.text).toContain(LAND); expect(version1.body).toContain(LAND)
})
it("classification: a label raised mid-run raises the next section, the brief, the draft and the P1 label", async () => {
  setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: false } })
  // two sections; section 1 stored at internal; then the matter is set to confidential
  expect([section1.classification, section2.classification, brief.classification, draft.classification, version1.classification]).toEqual(["internal", "confidential", "confidential", "confidential", "confidential"])
  expect((await rowOf(r2.usageLogId!)).classification).toBe("confidential"); expect(sent[sent.length - 1]!.body).not.toContain("confidential")
  expect((await docsOf("events", f.firmId)).filter((e) => e.name === "draft.generated").map((e) => e.classification)).toEqual(["confidential"])
})
it("events and audit: draft.generated, draft.autosaved and draft.gated _1_gated_1 and the assembled audit row at assembly; no event at the outline steps", async () => {
  // one section citing OWN_CITATION; the production (empty) authority store makes it UNVERIFIED
  expect((await docsOf("events", f.firmId)).filter((e) => e.name.startsWith("draft."))).toHaveLength(0) // after generateOutline and approveOutline
  // after assembly:
  expect(draftEvents.map((e) => e.id).sort()).toEqual([`${d}_1_autosaved`, `${d}_1_gated_1`, `${d}_1_generated`])
  for (const e of draftEvents) expect(e.payload).toEqual({ draftId: d, matterId: f.matterId, documentTypeId: TYPE, version: 1, gateResult: "UNVERIFIED", masterVersion: null })
  expect(audits.filter((a) => a.action === "draft.generate" && a.reason === "assembled" && a.target === `drafts/${d}`)).toHaveLength(1)
})
it("sections in order: section i needs i − 1 stored (409 previous_section_missing); a section beyond the outline is 404 section_not_found", async () => {
  expect((await apiErrorOf(draftApi(f.A, { generationId: g, outlineVersion: 1, section: 2 }))).code).toBe("previous_section_missing")
  expect((await apiErrorOf(draftApi(f.A, { generationId: g, outlineVersion: 1, section: 3 }))).code).toBe("section_not_found")
})
it("deterministic-first before a section call too: a template added after approval gives 501 with no transport call", async () => {
  setTemplateStoreForTests(new InMemoryTemplateStore().addTemplate(TYPE, "template_cp_199_v1")); const sent = scripted([])
  const e = await apiErrorOf(draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 }))
  expect([e.status, e.code, sent.length]).toEqual([501, "deterministic_not_built", 0])
})
it("assembly refused: a body over 900,000 bytes is draft_too_large, and a matter closed before assembly is matter_closed; the sections stay stored and nothing else is written", async () => {
  // three sections of "ک".repeat(160_000) (2 bytes each in UTF-8): 480,000 characters and 960,000 bytes; the last answer is assembly "refused", assemblyReason "draft_too_large"; 3 sections stored; no drafts
  // another generation: beforeOutcomeWrite sets the matter's status to "closed"; the last section gives assembly "refused", assemblyReason "matter_closed"
})
it("write deadline: an assembly that cannot start before the deadline is pending, and a retry assembles", async () => {
  let t = Date.now(); d4GenerationTestSeam.wallClock = () => t; d4GenerationTestSeam.beforeOutcomeWrite = async () => { t += 11_000 }
  expect(await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })).toMatchObject({ outcome: "stored", assembly: "pending" })
  delete d4GenerationTestSeam.beforeOutcomeWrite
  expect(await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })).toMatchObject({ called: false, assembly: "assembled" })
})
it("a superseded approval never assembles: sections stored with assembly pending, then a newer outline; replaying the last section answers called false and assembly none, and no draft exists", async () => {
  d4GenerationTestSeam.failAssembly = true
  expect(await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })).toMatchObject({ outcome: "stored", assembly: "pending" })
  d4GenerationTestSeam.failAssembly = false
  await outlineApi(f.A, { generationId: g, baseOutlineVersion: 1 }) // stores outline 2 and voids the approval
  expect(await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })).toMatchObject({ called: false, assembly: "none", draftId: null })
  expect(await docsOf("drafts", f.firmId)).toHaveLength(0)
})
it("after assembly every step but a replay is 409 generation_closed", async () => {
  for (const p of [outlineApi(f.A, { generationId: g, baseOutlineVersion: 1 }), approveApi(f.A, { generationId: g, outlineVersion: 1, outlineSha256: sha, acknowledgedMissingFacts: [] })]) expect((await apiErrorOf(p)).code).toBe("generation_closed")
  expect(await draftApi(f.A, { generationId: g, outlineVersion: 1, section: 1 })).toMatchObject({ called: false, assembly: "assembled", draftId: d })
})
it("the draft is a 4a draft from version 1: kind generate with provenance, generationId on the DraftView, createdBy the assembling caller, born gated with gateRuns 1", async () => {
  expect(version1).toMatchObject({ version: 1, kind: "generate", createdBy: f.C.uid, generation: { generationId: g, outlineVersion: 1, outlineSha256: sha, path: "ai", model: "anthropic/claude-opus-5.5", promptVersion: "4b.1", usageLogIds: [outline1.usageLogId, s1.usageLogId, s2.usageLogId], costMicroUsd: brief.costMicroUsd, masterVersion: null } })
  expect(await getDraftApi(f.C, { draftId: d })).toMatchObject({ generationId: g, currentVersion: 1, createdBy: f.C.uid, title: brief.title, gateResult: { version: 1, overridden: false } })
  expect(result1).toMatchObject({ version: 1, gateRuns: 1, gatedBy: f.C.uid })
})
```

- [ ] **Step 3: Run them and see them fail.**
  - Run `npm --prefix functions test -- d4.generation.test -t 'D4 assembly body'`. Expected: FAIL, because `assembleBody` is undefined.
  - Run `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- d4.generation.emu -t 'D4 generation: sections and assembly'"`. Expected: FAIL with `route_not_found`.
- [ ] **Step 4: Make the 4a changes.**
  - In `drafts.ts`: the `stageDraftEvent` union, and `DraftView.generationId`.
  - In `gateOps.ts`: the three exports.

  No behaviour changes for 4a drafts.
- [ ] **Step 5: Implement `sectionOps.ts`** to the contracts. Register `post(\`${D4_DRAFTING}/generateDraft\`, generateDraftOp)` and append it to `D4_GENERATION_ROUTES`.
- [ ] **Step 6: Run the tests and see them pass.**
  - Run Step 3's two commands, and `npm --prefix functions test -- d4.boot`. Expected: PASS.
  - Run the whole D4 and P1 emulator set: `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test -- d4. p1."`. Expected: PASS.
  - Then run both typechecks and both lints. Expected: zero warnings.
- [ ] **Step 7: Commit.**

```bash
git add functions/src/d4/sectionOps.ts functions/src/d4/drafts.ts functions/src/d4/gateOps.ts functions/src/http/router.ts functions/test/d4.boot.test.ts functions/test/d4.generation.test.ts functions/test/d4.generation.emu.test.ts
git commit -m "feat(d4): generateDraft — sectioned P1 calls, one assembly transaction writing the draft, version 1 (kind generate), its gate result, three events and the audit row (P4B-3, P4B-11, P4B-13, P4B-15, P4B-16)"
```

### Task 5: G-2, the gate, CI and the records (P4B-22; E-52, E-53; O-77 to O-86)

**Files:**
- Create: `ci_gates/gate_g4_phase4b.sh`.
- Modify:
  - `functions/test/g2.cross-firm.test.ts`
  - `ci_gates/gate_g4_phase4a.sh`: the `d4/drafting` count goes from 8 to 15 (D18).
  - `package.json`: `"gate:g4:phase4b": "bash ci_gates/gate_g4_phase4b.sh"`.
  - `.github/workflows/gate-g0.yml`
  - `functions/src/d4/README.md`
  - `docs/architecture/ERRATUM_SET_2_PROPOSED.md`
  - `docs/architecture/README.md`
  - `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md`

**Interfaces:**
- Consumes: every route, op module and named test of Tasks 1 to 4.
- Produces: `npm run gate:g4:phase4b`.

- [ ] **Step 1: Run G-2 before editing and see it fail.** Run `npm run gate:g2`. Expected: FAIL at `only the HTTP api, the health probe and the job runtime functions are deployed; every route has a cross-firm probe and runs its operation`, because seven routes have no probe.
- [ ] **Step 2: Add the G-2 probes, seed and controls** in `functions/test/g2.cross-firm.test.ts`.
  - `HANDLER_MODULES` gains `generations`, `outlineOps` and `sectionOps`.
  - The firm-A seed adds a brief `draft_generations/{g2genA}` and an approved outline `draft_outlines/{g2genA}_1`. The brief is at stage `approved`, `outlineVersion: 1`, `approvedOutline` for version 1, `sectionCount: 1`, `facts: "G2 ALPHA FACTS"`. The outline has one section, `{ heading: "G2 Alpha Heading", purpose: "G2 alpha purpose" }`. `FirmA` gains `generationId` and `outlineSha256`.
  - `PROBES` gains these entries, each with `target: true`:
    - `startDraft: (a) => ({ matterId: a.matterId, documentTypeId: "constitutional_petition_199", title: "G2 probe brief", facts: "G2 probe facts." })`
    - `generateOutline: (a) => ({ generationId: a.generationId, baseOutlineVersion: 1 })`
    - `approveOutline: (a) => ({ generationId: a.generationId, outlineVersion: 1, outlineSha256: a.outlineSha256, acknowledgedMissingFacts: [] })`
    - `generateDraft: (a) => ({ generationId: a.generationId, outlineVersion: 1, section: 1 })`
    - `getGeneration: (a) => ({ generationId: a.generationId })`
    - `getOutline: (a) => ({ generationId: a.generationId })`
    - `listGenerations: (a) => ({ matterId: a.matterId })`
  - The positive control gains three rows:
    - `["/api/d4/drafting/getGeneration", { generationId: A.generationId }, "G2 ALPHA FACTS"]`
    - `["/api/d4/drafting/getOutline", { generationId: A.generationId }, "G2 Alpha Heading"]`
    - `["/api/d4/drafting/listGenerations", { matterId: A.matterId }, A.generationId]`
  - `snapshotFirmA` gains the brief, the outline, and the counts of `draft_generations`, `draft_outlines` and `draft_sections` for firm A.
  - Every firm-B probe must answer 404 `not_found` or the cross-firm refusal, and leak nothing. No firm-B probe may reach P1: assert there is no `ai_usage_logs` row for either firm.
- [ ] **Step 3: Run G-2 and see it pass.** Run `npm run gate:g2`. Expected: PASS, with the counts and evidence lines printed. Any failure here is a real cross-firm leak, so fix it in the owning op, with a test in that op's emulator file, before going on.
- [ ] **Step 4: Write `ci_gates/gate_g4_phase4b.sh`**, modelled on `gate_g4_phase4a.sh`, with the same ports, project handling, `--inner` runner and `verify`.
  - **[1] Route coverage.**
    - d1: 21. `platform/jobs`: 4. `platform/brain`: 5. `d4/drafting`: 15, listing the 8 routes of 4a and the 7 of 4b. `d4/intelligence`: 4.
  - **[2] Boot** with every layer flag off.
  - **[3] Named tests** under `--only auth,firestore`, selected by exact full name and counted from the arrays:
    - Functions: `test/p1.units.test.ts`, `test/p1.transport.test.ts`, `test/p1.gateway.emu.test.ts`, `test/p1.api.emu.test.ts`, `test/d4.boot.test.ts`, `test/d4.generation.test.ts`, `test/d4.generation.emu.test.ts`.
    - Root: `tests/p1.pseudonymise.test.ts`, `tests/p5.permission-draft-actions.test.ts`, `tests/p5.permission-decision.parity.test.ts` and `tests/firestore.rules.d4-phase4b.test.ts`, run with `--no-file-parallelism`.
    - The arrays are `P1_TESTS`, `PSEUDONYMISE_TESTS`, `PERMISSION_TESTS`, `RULES_TESTS`, `GEN_BOOT_TESTS`, `GEN_UNIT_TESTS` and `GEN_EMU_TESTS`. Between them they hold every test named in Tasks 1 to 4, as `"<describe> <it>"`. `G4B_FILTER` overrides the filter, and exists only to prove the gate can fail.
  - **[4]** `npx eslint --max-warnings 0 functions`.
  - **[5]** `bash ci_gates/gate_g2.sh`.
- [ ] **Step 5: Run the gate both ways.**
  - Run `G4B_FILTER='^no such test$' npm run gate:g4:phase4b`. Expected: FAIL at [3] ("passed tests are not exactly the N named tests").
  - Run `npm run gate:g4:phase4b`. Expected: `=== Gate G-4 (Phase 4b): PASSED ===`.
  - Run `npm run gate:g4:phase4a`. Expected: PASSED, with 15 `d4/drafting` routes and the renamed boot test.
- [ ] **Step 6: Add the CI step** to `.github/workflows/gate-g0.yml`, after the Phase 4a step:

```yaml
      - name: Gate G-4 Phase 4b close (P1 drafting route and pseudonymiser, generation store, outline and section steps, assembly, rules, routes, G-2)
        if: ${{ !cancelled() }}
        run: npm run gate:g4:phase4b
```

- [ ] **Step 7: Write the records.**
  - **`functions/src/d4/README.md`.**
    - The intro no longer says "Phase 4a has no AI generation".
    - "Every route is rate kind general" names the two `p1` routes.
    - A new section, `## Generation (Phase 4b)`, covers: the seven routes; the three collections and the stages; the 13-step order; the outcomes and assembly; the guardrails; the time budget and the lease; the rules; and the template port.
    - "Events and audit" gains the three assembly events.
    - "Test seams" gains `setTemplateStoreForTests` and `d4GenerationTestSeam`.
    - "Not in this phase" takes the spec's "Out of scope" list.
    - "Open items" says that O-63 (retention) now extends to the three new collections, and lists O-77 to O-86.
  - **`ERRATUM_SET_2_PROPOSED.md`.**
    - Add the E-52 row, with (a) to (e) as the spec states them, and the E-53 row, with (a) to (g). Each row cites the rulings and lines the spec cites, says "Pending the partner's signature", and gives the spec's cost if wrong.
    - Add O-77 to O-86, verbatim from the spec's table.
    - The header becomes "errata E-23 to E-53", the register heading "(E-23 to E-53)", and the footer "O-15 to O-86 are new".
  - **`docs/architecture/README.md`.** The index entry becomes "E-23 to E-53 and open items O-15 to O-86".
  - **The rulings ledger.** Add `## Phase 4b rulings`: one line per ruling, P4B-1 to P4B-22, each as `- P4B-n <name>: <ruling>. Basis: <grounds>.`, then an "Open items" line (O-77 to O-86). Then add `## Phase 4b plan decisions`: D1 to D22 of this plan, one line each with its reason.
- [ ] **Step 8: Run the full verification once.**
  - The full Functions emulator suite: `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test"`.
  - Then `npm run test:rules`, `npm run test:unit`, `npm run gate:g0`, `npm run lint` and `npm run typecheck`.

  Expected: all PASS.
- [ ] **Step 9: Commit.**

```bash
git add ci_gates/gate_g4_phase4b.sh ci_gates/gate_g4_phase4a.sh package.json .github/workflows/gate-g0.yml functions/test/g2.cross-firm.test.ts functions/src/d4/README.md docs/architecture/ERRATUM_SET_2_PROPOSED.md docs/architecture/README.md docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md
git commit -m "ci: gate:g4:phase4b in CI and G-2 probes for the seven generation routes; record Phase 4b rulings, plan decisions and errata (E-52, E-53, O-77..O-86)

gate_g4_phase4a.sh now expects 15 d4/drafting routes (8 from 4a + 7 from 4b), as earlier gates absorbed 3b's d1 route."
```

When the PR is opened, set `backend_real`, `frontend_real` and `transport_stub` truthfully. Run `ci_gates/check_pr_phase_claims.py` before landing, and keep "complete" and "product-done" out of the PR body.

---

## Self-review

**1. Spec coverage.**

| Spec section or ruling | Task |
| --- | --- |
| P4B-1 scope, seven routes, new drafts only | 2 (store and GETs), 3 (outline routes), 4 (`generateDraft`) |
| P4B-2 synchronous, one P1 call per request; E-52(d) | 3, 4 (one `callDrafting` per request); 5 (E-52(d)) |
| P4B-3 sectioned, ≤ 25, in order, input | 3 (`validOutline`, `sectionPrompt`), 4 (`previous_section_missing` test) |
| P4B-4 `drafting` task type, purposes, `p1.drafting` | 1 (route and trace), 3 (purposes) |
| P4B-5 truncation flag; D4 refuses | 1 (`truncated`), 3 (guard step 1), 4 (test 5) |
| P4B-6 indexed pseudonymiser, map in process only | 1 (unit and `callP1`), 4 (test 1) |
| P4B-7 verbatim fields and reserved tokens | 2 (`reserved_tokens`, verbatim parse), 3 (edit), 4 (verbatim test) |
| P4B-8 store, stages, deterministic ids | 2, 3, 4 |
| P4B-9 deterministic-first, empty port, 501 | 2 (port), 3 and 4 (501 tests) |
| P4B-10 outline approval binding | 3 (test 6a), 4 (test 6b) |
| P4B-11 one assembly transaction | 4 (tests 10, the 4a-draft test, events) |
| P4B-12 guardrails 1 to 6 | 3 (unit tests), 4 (test 3) |
| P4B-13 classification | 2 (`startDraft`), 4 (label raised mid-run) |
| P4B-14 no text in POSTs, lease, billed once | 3 (lease, lost commit), 4 (test 9) |
| P4B-15 events and audit | 4 |
| P4B-16 permissions; R12 everywhere | 2 (table and parity), 3 (R12 test), 4 (assembly re-decides) |
| P4B-17 time budget | 3 (constants, pre-call 503), 4 (write deadline gives `pending`) |
| P4B-18 rules | 2 |
| P4B-19 rank 4 | 3 (test 8) |
| P4B-20 policy-agnostic; ranks 0 to 4 | 3 (ranks test); no change to `providerPolicy.ts` or `data/provider_dpa.json` |
| P4B-21 fixtures | Global Constraints, used by every task |
| P4B-22 gate and CI | 5 |
| Data model; indexes; changes to 4a | 2 (indexes, exports), 4 (`generationId`, kind `generate`, provenance) |
| Prompt contract | 3 |
| P1 changes 1 to 4 | 1 |
| Routes; the order in the P1 routes | 2, 3, 4 (D3, D4) |
| Outcomes and errors | 3, 4; replay (no new stored 409) in Global Constraints |
| Testing: required 1 to 10 | 4 (1, 3, 5, 6b, 7, 9, 10), 3 (2, 4, 6a, 8) |
| Testing: also required | 3 (deterministic-first, ranks, reserved edit, R12, timing), 2 (reserved at `startDraft`, permissions, rules, boot), 4 (verbatim, classification, events and audit, boot), 1 (P1 units), 5 (G-2) |
| Errata E-52 and E-53; O-77 to O-86; ledger | 5 |

**2. Type consistency.**
- `StepOutcome` and `VerbatimField` are defined in Task 2.
- `OutlineContent`, `RefusalReason`, `Guarded`, `StepResult` and `StepClaim` are defined in Task 3.
- `SectionStepResult` and `AssemblyReason` are defined in Task 4 and extend `StepResult`.
- `PseudonymMap` (Task 1) is the type of `P1Result.pseudonyms`, which Task 3's guards consume.
- The route names match the boot lists and the G-2 `PROBES` keys.
- `d4GenerationTestSeam`'s fields (`failAssembly`, `outcomeWriteFailures`, `lostCommitAnswers`, `wallClock`, `beforeOutcomeWrite`) are the spec's, and are the ones the tests use.

**3. Review Focus.**
- Each of the five lines has a named test in its owning task: 1, 3, 4 and 5 in Task 3's `D4 guardrails` and `D4 outline answer parser`; 2 in Task 1's pseudonymiser tests.
- Hostile characters, a retry after a lost response, and the R12 race are covered by required tests and are not repeated there.

**4. Proportion.** The plan pins signatures, contracts, test names and assertions. It writes no op bodies. The only algorithms it spells out are those its signatures leave open: the pseudonymiser's order and its "no rewrite inside a token" rule, the guard order, and the assembly writes. The plan is about 1,340 lines against the spec's 353 (3.8 times). Two things account for that: Global Constraints copies the spec's values verbatim, as required, and about 90 named tests are given as assertions carrying the spec's numbers. With the test bodies taken out, the plan would be about the spec's length. The implementation it describes (seven routes, a pseudonymiser, guards, an assembly transaction and about 90 tests) is several times longer than the plan.

---

## Engineering review (gstack `/plan-eng-review`, 13 October 2026)

**Target:** this plan together with its spec, `docs/superpowers/specs/2026-10-13-phase4b-draft-generation-design.md`, at `37659bf`. The owner chose this review ("Eng review of 4b"). Every later choice was decided under the owner's standing autonomy instruction (`/root/.claude/CLAUDE.md`, 7 October 2026): the recommended option was taken and recorded below. Plan decisions D23 to D28 above are the accepted changes. The review's question numbers (Q3 to Q12) are separate from the plan's D numbers.

**Prior learning applied:** `ops-claim-gate` (confidence 9/10, 2026-10-10). The PR body keeps "complete" and "product-done" out, and `check_pr_phase_claims.py` runs before landing (Task 5).

### Scope Challenge

**A. What already exists, by sub-problem.**
- Masking: `platform/p1/maskOutboundPII.ts:28-36`, reused for the patterns.
- The P1 chokepoint: `functions/src/p1/gateway.ts:147`.
- R12: `functions/src/d4/drafts.ts:143`.
- The 4a gate and its stores: `gateOps.ts:182` (`normaliseEvaluation`, already exported), `:361` (`requireStorable`), `:407` (`resultDocument`), `:436` (`summaryOf`).
- Classification: `drafts.ts:296` (`classifyForMatter`).
- Citations: `services/d4-2/citations.ts:36`, `:1256`, `:1266`.
- The charset rule: `services/d4-2/draftCharset.ts:222`, `:395`.
- The template port mirrors `d4/authority.ts:21-101`.

Nothing on `origin/main` since 2026-10-12 touches these paths (`e7e18e6` is the tip).

**Search check** (WebSearch, standard):
- **[Layer 1] Reversible placeholders.** Detect, replace with an indexed placeholder, send, then restore. This is current practice; the mapping is the high-value target and must stay protected. The plan keeps it in process only. Source: [Grepture: mask and restore](https://grepture.com/blog/mask-and-restore-reversible-redaction-llm), [MLflow: PII redaction](https://mlflow.org/articles/pii-redaction-llm).
- **[Layer 1] Firestore lease.** A lease longer than the worst-case run, an idempotent transaction body and a fencing token on writes. The plan has 180 s > 120 s and `claimId` checked at the outcome write. Source: [the Oscar Firestore lock](https://go.googlesource.com/oscar/+/master/internal/gcp/firestore/db.go), [Firestore contention docs](https://firebase.google.com/docs/firestore/transaction-data-contention?hl=es).
- **Open.** No published mapping of Anthropic stop reasons to the Gateway's `finish_reason` was found; only `"stop"` appears in [Vercel's chat completions reference](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/chat-completions). O-84 stays [REQUIRES VERIFICATION].

**TODOS.md:** none in the repository. Open items (O-nn) serve that purpose.

**Complexity check** (estimated, from the plan's file lists):
- About 45 changed files.
- 8 new modules: the pseudonymiser, `templates`, `generations`, `generationPrompt`, `guardrails`, `generationRun`, `outlineOps` and `sectionOps`.
- The gate trips (8+ files, 2+ new modules).

**B. Complexity selectors.**
- **Q3, feature cuts: none proposed.** Each feature serves a ruling:
  - Without the pseudonymiser, party names come back as `[PARTY]`, so the draft is unusable.
  - `listGenerations` is the resume path.
  - Verbatim fields are the owner's standard.
  - The template port is L16.1's deterministic-first check.
- **Q4, structure.**
  - A) Original arrangement (recommended): eight focused modules, one responsibility each, following the `authority.ts` port precedent.
  - B) Smaller arrangement: fold `templates.ts` into `generations.ts` and `guardrails.ts` into `generationPrompt.ts`, which saves 2 files but mixes the port with the store and the guards with the prompt.
  - **Answer:** A, auto-decided (recommended).
  - **Scope record:** feature answers Q3 (no cuts); structure A; accepted scope is the plan as written plus D23 to D28; no pending remedies.

**C. Findings.** No issues found at scope level. **Scope accepted as-is.**

**Reality rows:**

```
REALITY: premise-table pass 14 premises checked, unverified=2 (Opus output speed for D25; the Gateway's finish_reason values, O-84) functions/src/p1/transport.ts:104-108
REALITY: already-done pass origin/main e7e18e6 has no commit since 2026-10-12 touching functions/src/d4, functions/src/p1 or platform/p1 functions/src/d4/drafts.ts:143
REALITY: surface-check pass npm scripts test:rules, test:unit, gate:g0, gate:g2, gate:g4:phase4a, typecheck and lint exist; the helpers rowsOf/eventsOf/auditsOf/rowOf, seedFirm and fakeTransport exist functions/test/p1.gateway.emu.test.ts:58-107
REALITY: binding-decisions pass gstack decision log empty; the owner rulings honoured: GitHub is the master copy, autonomy, issue #26 unconfirmed (P4B-20) AGENTS.md:1
REALITY: numbers finding 14,000 micro-USD and USD 0.05 re-derived [measured: costTable prices]; 102 s and 117 s re-derived [measured: gateway.ts:99, opik.ts:9, transport.ts:14]; "117 s < 120 s" was stated as a bound with no in-flight slack, fixed by D24 functions/src/p1/gateway.ts:92
REALITY: deferred-asks pass issue #26 deferred as O-82 with its reason; every spec deferral carries a reason docs/superpowers/specs/2026-10-13-phase4b-draft-generation-design.md:74
REALITY: pr-count pass one PR (#28); no .gstack/ship-policy.json, so one PR per wave docs/superpowers/plans/2026-10-13-phase4b-draft-generation.md:1
REALITY: transaction-semantics pass every write is one transaction that re-decides R12; the lease is fenced by claimId at the outcome write functions/src/d4/drafts.ts:143
REALITY: units pass every budget is in ms; FUNCTION_TIMEOUT_SECONDS (s) is multiplied by 1000 everywhere it is compared functions/src/health.ts:12
```

### 1. Architecture review

- `[P2] (confidence: 8/10) functions/src/p1/gateway.ts:160 — "const [platformSnap, configSnap, totalSnap] = await db.getAll(...)"`
  - `callP1` can reject before any provider call, and the plan's guards or prompt can throw after `claimLease` commits.
  - Nothing releases `inFlight`, so every retry answers 409 `generation_in_progress` for 180 s for a call that billed nothing.
  - Found by: Claude, native review.
- `[P2] (confidence: 8/10) functions/src/p1/gateway.ts:92,99 — "export const COMMIT_ATTEMPT_SLACK_MS = 10_000" and the 102 s check`
  - P1 reserves slack for the commit attempt still running at its deadline. The plan's D4 write deadline (10 s) has none: the outcome-write or assembly attempt that starts just before it can run past the 117 s the import check claims.
  - The budget's start (`startedMs`) is also undefined, and the router clock is fixed in the emulator suites: `functions/test/p1.gateway.emu.test.ts:25` `const at = { now: () => T }`.
  - Found by: Claude, native review.
- `[P2] (confidence: 6/10) functions/src/p1/gateway.ts:226-233 — a billable failure is charged "reportedOut ?? MAX_OUTPUT_TOKENS"`
  - Medium confidence; verify this is a real issue.
  - A section near `max_tokens: 4096` likely exceeds the 60 s transport timeout (`transport.ts:14`) at an assumed 40 to 70 output tokens a second [estimated, unmeasured: O-57].
  - Each such timeout bills the 4,096-token ceiling and stores nothing, on every retry. The prompt gives no length budget.
  - Found by: Claude, native review.

Failure scenarios for the new paths, with the plan's handling:
- **Provider down.** The answer is `failed`/`transport_error`, billed per I1, recorded on the brief. Tested (outcome tests).
- **Kill switch mid-run.** The section is `blocked`. Test 7.
- **Lost commit answer.** It is confirmed by `lastAttempt.usageLogId`. Tested.
- **Firestore read failure inside `callP1`.** Previously the lease was stuck; now D27 releases it, with a test.

Distribution: no new artifact; the Functions deploy is unchanged.

**Q5 (A1 → D27).** Release the lease on a throw.
- A) Release it in its own transaction (fenced by `claimId`), then rethrow, with a test (recommended). Human ~2 h / CC ~10 min.
- B) Leave it to expire in 180 s.

Answer: A, auto-decided. **Accepted.**

**Q6 (A2 → D23, D24).** The time budget.
- A) Reserve 4 s of the 10 s write deadline for the attempt in flight (no attempt starts after 6 s), start both budgets at the op's own `d4Now()`, and state that the 3 s remainder covers the router (recommended). Human ~1 h / CC ~5 min.
- B) Keep the plan's arithmetic.

Answer: A, auto-decided. **Accepted.**

**Q7 (A3 → D25).** The section length.
- A) A 1,000-word section budget in the section prompt, and a split instruction in the outline prompt, with a prompt test (recommended). Human ~30 min / CC ~5 min.
- B) Rely on `max_tokens` alone.

Answer: A, auto-decided. **Accepted.** The throughput premise stays under O-57.

Dispositions: A1 accepted (Q5); A2 accepted (Q6); A3 accepted (Q7).

### 2. Code quality review

- `[P3] (confidence: 7/10) plan Task 2 "RESERVED_TOKEN: RegExp (/[⟦⟧]|\[(?:PARTY|…)\]/)" against Global Constraints "refused rehydration_failed if … /\b(?:PARTY|…|VERBATIM)_\d+\b/"`
  - Caller text holding a bare `PARTY_1` passes the input check but makes every answer that echoes it a billed `rehydration_failed`.
  - Found by: Claude, native review.
- **Shared code considered and rejected:** `withOutputWriteRetry` and `outputCommitted` (`functions/src/p1/ops.ts:58-107`) against the plan's `writeOutcome` retry. The contracts are incompatible:
  - attempts: a fixed 3 against the deadline-bound D24;
  - confirmation: the output document existing against `brief.lastAttempt.usageLogId`;
  - the seam queues differ.

  There are no net savings; keep them separate.
- The 4a helpers the plan exports (D21) are already the single copies. `normaliseEvaluation` is already exported (`gateOps.ts:182`).

**Q8 (A4 → D26).** Bare tokens.
- A) Extend `RESERVED_TOKEN` to bare tokens, with a test row (recommended). Human ~15 min / CC ~2 min.
- B) Leave it.

Answer: A, auto-decided. **Accepted.**

Dispositions: A4 accepted (Q8).

### 3. Test review

Framework: vitest (`functions/` and the root), with the Auth and Firestore emulators and `@firebase/rules-unit-testing`. CLAUDE.md has no Testing section; the framework was detected from the repository.

```
CODE PATHS                                                  USER FLOWS
[+] platform/p1/pseudonymiseOutboundPII.ts                  [+] Advocate: facts → outline → approve → sections → draft
  ├── pseudonymise / applyMap / rehydrate [★★★ T1 unit x10]   ├── [★★★ TESTED] full run, tests 1, 3, the 4a-draft test [→E2E emu]
[+] functions/src/p1/gateway.ts (drafting, truncated, map)    ├── [★★★ TESTED] stop between sections, test 7
  ├── [★★★ TESTED] truncated matrix, map leak scan (T1)       ├── [★★★ TESTED] resume after a lost answer, test 9 / listGenerations
  └── [★★★ TESTED] committeeBrain unchanged (T1)              └── [★★★ TESTED] double submit, test 9 (concurrent → 409)
[+] d4/generations.ts startDraft/get/list [★★★ T2]          [+] Error states the advocate sees
[+] d4/guardrails.ts six steps, order, D10, D11 [★★★ T3]      ├── [★★★ TESTED] refused / blocked / failed in a 200 body
[+] d4/generationRun.ts                                       ├── [★★★ TESTED] 409 generation_in_progress while in flight
  ├── claimLease / budget / 503 [★★★ T3]                      └── [★★★ TESTED] 503 generation_busy, assembly "pending"
  ├── writeOutcome retry, lost commit, R12 403 [★★★ T3]
  ├── [GAP→ADDED] throw before outcome write releases the lease (D27)
  └── [★★ TESTED] write deadline → pending (T4)
[+] d4/outlineOps.ts approve binding [★★★ T3 test 6a]
  └── [GAP→ADDED] identical "edit" is no edit (D6)
[+] d4/sectionOps.ts assembly [★★★ T4 tests 10, events, refusals]
  └── [GAP→ADDED] superseded approval never assembles
[+] d4/generationPrompt.ts [★★ T3 unit]
  └── [GAP→ADDED] the 1,000-word budget in both prompts (D25)

LLM integration: [GAP] [→EVAL] prompt 4b.1 output quality: no eval suite; a stub transport proves the contract, not the drafting. Deferred to G-1 with a live key (O-57, O-84).

COVERAGE: 30/34 paths tested in the plan as written (88%); 34/34 with the review's additions; LLM quality 0/1 (deferred).
QUALITY: ★★★: 26 ★★: 4 ★: 0 | GAPS: 4 added, 1 eval deferred
```

Value cards for the added tests:
- **Lease released on a throw.** Value: protects=a throw before the outcome write frees the lease; fails_when=the release is removed or not fenced by claimId; why_new=no test throws between lease and write; seam=d4GenerationTestSeam.beforeCall; no_claim=a real Firestore getAll failure (seam throw stands in).
- **Identical edit.** Value: protects=D6 identical edit approves n, stores no n+1; fails_when=the hash comparison is dropped; why_new=6a covers a real edit only; seam=none; no_claim=none beyond protects.
- **Superseded approval.** Value: protects=no draft is assembled from a voided approval; fails_when=the due check ignores approvedOutline; why_new=test 10 retries with the approval intact; seam=failAssembly; no_claim=a real assembly failure (seam stands in).
- **Word budget.** Value: protects=both prompts carry the 1,000-word budget; fails_when=the budget text is dropped; why_new=the prompt tests assert structure only; seam=none; no_claim=that the model obeys it (stub transport).

**Tests made obsolete:** none. The 4a boot test is renamed, not retired (D18).

**Regression rule:**
- `committeeBrain` is pinned unchanged (Task 1).
- The 4a suites run green in Tasks 2 to 4.
- The two transport assertions become stricter.

No regression contract is unapproved.

**Q9 (the identical-edit test row)** and **Q10 (the superseded-approval test):** each A) add it (recommended), auto-decided. **Accepted.**

Test gaps identified: 3 (identical edit; superseded approval; LLM eval, deferred), plus the proof tests the remedies need (D25 to D27). Test plan artifact: `~/.gstack/projects/shamailsik-prog-cursor-init/root-claude-superpowers-installation-5u3208-eng-review-test-plan-20261013.md`.

Dispositions: Q9 accepted; Q10 accepted; LLM eval deferred to G-1 (O-57, O-84).

### 4. Performance review

- `[P3] (confidence: 6/10) plan Task 4 "Read the approved outline's sections 1 to k."` Medium confidence; verify this is a real issue.
  - Up to 25 sequential reads of documents up to about 400 KB each could cost about 25 round trips inside the 6 s write start-by window.
  - Use one `getAll` (D28).
- **Recorded, no change.** Every section call re-sends the facts. At most that is 25 calls × about 30,000 input tokens, or about USD 3 of input per 25-section draft [estimated: 4,000 nano-USD per input token, `costTable.ts:7`]. Prompt caching is not available on the Gateway path the transport uses (unmeasured), so it is NOT in scope.
- Firestore: one `partyNamesFor` query per call; `listGenerations` uses its composite index; every write touches the brief once. No N+1 beyond the D28 item.

**Q11 (D28):** A) one `getAll` (recommended), auto-decided. **Accepted.**

Dispositions: P-1 accepted (Q11).

### Outside voice

- Codex is not installed (`CODEX_MODE: not_installed`; `codex_reviews` unset).
- The native fallback needs TaskOutput, which this session does not provide.
- **Outside voice unavailable.** Recorded as missing coverage, never as clean. The SDD whole-branch review after Task 5 is the independent check.

### TODOs

**Q12:** two candidates. Both are already open items, so nothing new is added (B, skip as a separate TODO, auto-decided):
- the live G-1 check of `finish_reason` and section latency (O-57, O-84);
- prompt caching for the repeated facts (NOT in scope).

### NOT in scope

- The P2 async path (O-79).
- Live-model evals of prompt 4b.1 (G-1, O-57, O-84).
- Prompt caching of the facts across sections (no Gateway support measured).
- Renewing the lease during a call: 180 s already exceeds the 120 s timeout.
- `matter_parties` names that look like bare tokens. D1 owns their validation; they fail closed as `rehydration_failed`.
- The rest of the spec's "Out of scope" list stands.

### What already exists

- **Reused unchanged:** the mask patterns, `callP1`, R12, `classifyForMatter`, the 4a gate and its stores, `normaliseCitation`, the charset rule, `partyNamesFor`, and the `AuthorityStore` port shape.
- **Built new:**
  - the pseudonymiser, because the lossy mask cannot be reversed;
  - the generation store, because the set has no outline collection;
  - the guardrails, because P4-15 places them in the D4 caller.

### Failure modes

| New path | Realistic failure | Test | Handling | Seen by the user |
| --- | --- | --- | --- | --- |
| Pseudonymise round trip | the model damages a token | Review Focus 1 | `rehydration_failed` | a 200 `refused` |
| Section call | timeout near `max_tokens` | test 5 analogue | D25 budget; billed `failed` | a 200 `failed` |
| Lease | throw before the outcome write | added (D27) | release, rethrow | 500, then retry works |
| Outcome write | lost commit answer | tested | confirmed by `usageLogId` | stored once |
| Assembly | contention past the deadline | tested | `pending` | retry assembles |
| Assembly | the approval voided meanwhile | added | `none` | no draft |

Critical gaps (no test, no handling and silent): 0.

### Worktree parallelization strategy

| Step | Modules touched | Depends on |
| --- | --- | --- |
| Task 1 | `platform/p1/`, `functions/src/p1/` | — |
| Task 2 | `functions/src/d4/`, `platform/p5/`, rules | — |
| Task 3 | `functions/src/d4/`, `functions/src/p1/ops.ts` | Tasks 1 and 2 |
| Task 4 | `functions/src/d4/` | Task 3 |
| Task 5 | `ci_gates/`, `docs/`, the G-2 test | Task 4 |

- Lanes: A is Task 1 and B is Task 2 (disjoint modules), then C (Tasks 3 → 4 → 5).
- Conflict flags:
  - Tasks 2 to 4 share `functions/test/d4.generation.emu.test.ts`, `d4.boot.test.ts` and `router.ts`.
  - SDD runs one implementer at a time, so execution is sequential: Task 1, then 2, 3, 4 and 5.

### Implementation Tasks

Synthesized from this review's findings. Each folds into the plan task that owns the code.

- [ ] **T1 (P2, human: ~2h / CC: ~10min)** — d4/generationRun — release the lease on a throw (D27)
  - Surfaced by: Architecture — `gateway.ts:160` `db.getAll` can reject.
  - Files: `functions/src/d4/generationRun.ts`, `outlineOps.ts`, `sectionOps.ts`, `functions/test/d4.generation.emu.test.ts`.
  - Verify: the D27 emulator test.
- [ ] **T2 (P2, human: ~1h / CC: ~5min)** — d4/generationRun — in-flight slack and the op's own clock (D23, D24)
  - Surfaced by: Architecture — `gateway.ts:92,99`.
  - Files: `functions/src/d4/generationRun.ts`, `functions/test/d4.generation.test.ts`.
  - Verify: the time budget unit test.
- [ ] **T3 (P2, human: ~30min / CC: ~5min)** — d4/generationPrompt — the 1,000-word section budget (D25)
  - Surfaced by: Architecture — `gateway.ts:226-233`.
  - Files: `functions/src/d4/generationPrompt.ts`, `functions/test/d4.generation.test.ts`.
  - Verify: the prompt budget unit test.
- [ ] **T4 (P3, human: ~15min / CC: ~2min)** — d4/generations — bare tokens are reserved (D26)
  - Surfaced by: Code Quality — `RESERVED_TOKEN`.
  - Files: `functions/src/d4/generations.ts`, `functions/test/d4.generation.emu.test.ts`.
  - Verify: the reserved-tokens test row.
- [ ] **T5 (P3, human: ~30min / CC: ~5min)** — d4/outlineOps, d4/sectionOps — the identical-edit row and the superseded-approval test
  - Surfaced by: Test review.
  - Files: `functions/test/d4.generation.emu.test.ts`.
  - Verify: tests 6a and "a superseded approval never assembles".
- [ ] **T6 (P3, human: ~10min / CC: ~2min)** — d4/sectionOps — read the sections with one `getAll` (D28)
  - Surfaced by: Performance — plan Task 4.
  - Files: `functions/src/d4/sectionOps.ts`.
  - Verify: test 10 and the 4a-draft test.

### Decision ledger

Each answer below was auto-decided under the owner's standing autonomy instruction (`/root/.claude/CLAUDE.md`, 7 October 2026: "Make every technical, product and process decision yourself"). In each case the option marked recommended was taken.

- **Q3:** feature cuts. State: approved. Answer: none proposed. Accepted scope: the plan's feature list.
- **Q4:** structure. State: approved. Answer: A, the original arrangement. Accepted scope: eight modules as planned.
- **Q5:** the lease on a throw. State: approved. Answer: A. Accepted scope: D27 and its test.
- **Q6:** the time budget. State: approved. Answer: A. Accepted scope: D23, D24, the constant, the import check and the unit test.
- **Q7:** the section length. State: approved. Answer: A. Accepted scope: D25, both prompts and the unit test.
- **Q8:** bare tokens. State: approved. Answer: A. Accepted scope: D26 and the test row.
- **Q9:** the identical-edit test. State: approved. Answer: A. Accepted scope: the 6a row.
- **Q10:** the superseded-approval test. State: approved. Answer: A. Accepted scope: the new Task 4 test.
- **Q11:** sections read with `getAll`. State: approved. Answer: A. Accepted scope: D28.
- **Q12:** TODOs. State: approved. Answer: B (both are already O-57 and O-84). Accepted scope: none.
- **Setup:** cross-project learnings. The `CROSS_PROJECT` config was left unset and learnings stay project-scoped, because this machine holds client codebases. That is the conservative choice, and it writes no config.

Approval readiness: PASS (Q3 to Q12, each with its auto-decision reference above).

### Completion summary

- Step 0: Scope Challenge: scope accepted as-is.
- Reality rows: 7/7 tier-1 rows plus 2 tier-2 rows emitted (`PLAN_REALITY: phase=eng rows=7/7 missing=none unverified=2 verdict=complete`); 2 unverified premises.
- Architecture Review: 3 issues found.
- Code Quality Review: 1 issue found.
- Test Review: diagram produced; 3 gaps identified.
- Performance Review: 1 issue found.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: 2 items proposed (both already open items; none added).
- Failure modes: 0 critical gaps flagged.
- Unresolved decisions: 0 in this review.
- Outside voice: codex, unavailable (not installed; the native fallback needs TaskOutput, which is absent).
- Parallelization: 2 lanes possible, executed sequentially (5 sequential).
- Lake Score: 7/7.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex (`/plan-eng-review` outside voice) | Independent 2nd opinion | 1 | unavailable | not installed; native fallback unavailable (no TaskOutput) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 8 issues, 0 critical gaps (all 8 accepted into the plan as D23 to D28 and tests) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, plan-review phase, unavailable (CLI not installed; native fallback unavailable). There are no outside findings, and the coverage is missing, not clean.
- **VERDICT:** no review is CLEAR. The Eng review found 8 issues, and every one is resolved in the plan, so its status records mapped work and no open decision. Eng review required: build to the amended plan, and the SDD whole-branch review is the independent check.

NO UNRESOLVED DECISIONS
