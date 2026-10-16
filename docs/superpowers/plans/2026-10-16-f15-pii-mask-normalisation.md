# F15 PII Mask Normalisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the outbound mask sees identifiers in every digit script and through invisible characters, matches recorded names through case, spacing and Arabic-letter variants, and the rank >= 3 obligation is checked by an independent residual detector whose counts are recorded on every call.

**Architecture:**
- `platform/p1/piiText.ts` builds a detection view (NFKC, digits to ASCII, dashes, spaces, invisibles dropped) with a per-unit map to original offsets, and a folded name view on top of it.
- `maskOutboundPII` runs main's patterns and the folded names on the views in one pass and replaces the mapped spans in the original text.
- `platform/p1/residualPII.ts` scans the masked text's detection view by digit-run length and contextual cues; `assertMinimised` requires both a clean mask re-run and zero residual findings.
- `callP1` records `residualCounts` beside `redactionCounts`; committeeBrain adds the matter's client record names.

**Tech Stack:** TypeScript, vitest, firebase-admin, the Auth and Firestore emulators.

**Spec:** `docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md`

## Global Constraints

- Do not edit `platform/http/withSession.ts`, `platform/p5/session.ts`, `platform/persistence/adminFirestore.ts`, `platform/persistence/firestoreSpineRepositories.ts`, `platform/p5/committeeScope.ts`, `platform/p5/insecureDevAuth.ts`; no `app/api/**`.
- Never skip or weaken a test. Exact-shape assertions that list `outbound` keys gain `residualCounts`; nothing else in an existing test changes.
- Invented names only (Qalvo, Nura, Tariq Zarvani, Haris Qalbani, Omer Daryani, Kamran); synthetic numbers.
- Emulators on private ports (a scratch copy of `firebase.json` with its own ports, never committed).
- Invisible and space characters are written as `\u` escapes in source (eslint `no-irregular-whitespace`).

## Review Focus

- The output keeps every unmatched code unit of the original (pinned by an exact-equality test with zero-width and NBSP characters outside matches).
- No catastrophic backtracking on 100,000 characters (pinned by a time-bounded test).
- The false-positive corpus produces zero residual findings; each refinement in spec ruling 5 has its own test row.
- The receipt path tolerates a pre-F15 receipt without `residualCounts` (F09 resume).

---

### Task 1: Spec and plan

- [x] Write the spec (rulings 1-9, residual risk) and this plan.

### Task 2: RED tests on main's sources

**Files:** create `tests/f15-detection-view.test.ts`, `tests/f15-mask-unicode.test.ts`, `tests/f15-residual-pii.test.ts`, `functions/test/f15-pii-mask.e2e.emu.test.ts`.

- [x] Write the four files before any implementation.
- [x] Run them with the sources still identical to main 0844ed8; record the failures (scratchpad logs, then the PR body).

### Task 3: Detection view and name view

**Files:** create `platform/p1/piiText.ts`.

- [x] `detectionView(text)`: `{ text, start, end }`, per original code point: `\p{Cf}` dropped; NFKC; `\p{Nd}` to ASCII by the run-start rule; `\p{Pd}` and U+2212 to `-`; `\p{Zs}` to a space. ASCII fast path.
- [x] `nameView(view)` and `foldName(name)`: lower-case, NFD minus `\p{M}`, tatweel dropped, the Arabic letter folds of ruling 3.
- [x] `tests/f15-detection-view.test.ts` GREEN.

### Task 4: The mask on the views

**Files:** modify `platform/p1/maskOutboundPII.ts`.

- [x] Patterns on the detection view, priority order kept, accepted spans blanked with U+E000.
- [x] Names: folded, de-duplicated, longest first, whitespace as `\s*`, matched on the name view built from the blanked detection view.
- [x] Output assembled from original slices and tokens; overlapping spans merged.
- [x] Header: risk reduction, not anonymisation; the list of gaps.
- [x] `tests/f15-mask-unicode.test.ts` mask cases GREEN; `tests/p1.outbound-mask.test.ts`, `tests/p1.provider-policy.table.test.ts`, `tests/p1.eve-committee-brain.test.ts` still GREEN.

### Task 5: Residual detector

**Files:** create `platform/p1/residualPII.ts`.

- [x] `residualPII(text)`: four kinds, counts only, on the detection view; refinements of ruling 5.
- [x] `tests/f15-residual-pii.test.ts` GREEN (true positives, false-positive corpus, bound).

### Task 6: assertMinimised

**Files:** modify `platform/p1/providerPolicy.ts`.

- [x] Mask re-run clean and `residualPII` zero, on body and purpose.
- [x] Truth table in `tests/f15-mask-unicode.test.ts` GREEN.

### Task 7: Functions wiring

**Files:** modify `functions/src/p1/gateway.ts`, `functions/src/p1/ops.ts`; modify `functions/test/p1.gateway.emu.test.ts`, `functions/test/p1.api.emu.test.ts` (exact key lists only).

- [x] `outbound.residualCounts` on every call; `P1Result["outbound"]` type.
- [x] `outputRow` writes `metadata.residualCounts`; `receiptOf` validates it when present.
- [x] `partyNamesFor` reads `clients/{matter.clientId}` in parallel with `matter_parties` and adds `canonicalName`, `companyName`, `concernedPersonName` for the caller's firm.
- [x] `functions/test/f15-pii-mask.e2e.emu.test.ts` GREEN on private-port emulators.

### Task 8: Docs

**Files:** modify `functions/src/p1/README.md`.

- [x] Steps 4 and 5, the `not_minimised` row, `residualCounts` on the output row, the client read in the query table, the "not anonymisation" statement and its gaps.

### Task 9: Verification

- [x] New and changed tests RED against main's sources (temporary checkout of main's source files, restored after).
- [x] `npm run test:unit`; `npm --prefix functions run typecheck`; `npm --prefix functions run build`; the Functions emulator suite (`test:emu`, private ports); the rules suite (`test:rules`, private ports); `npm run lint`; `npm run typecheck`; `npm run typecheck:tests`; `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [x] Re-read the diff adversarially; PR body through `ci_gates/check_pr_phase_claims.py`.

## Execution record

Execution was native (inline), self-approved under the owner's standing autonomy instruction. Emulator runs used the repo's rules and indexes on their own ports (a scratch copy of `firebase.json`, not committed), because other sessions on the host may hold `firebase.json`'s.

- RED, the branch's new and changed tests against an exact `origin/main` 0844ed8 tree: unit 48 failed / 10 passed (58), with `f15-detection-view` and `f15-residual-pii` unable to load their new modules; Functions (F15 e2e, p1.api, p1.gateway) 8 failed / 214 passed (222). The two F15 e2e cases that pass on main are compatibility guards ((d') and a pre-F15 receipt).
- GREEN at the branch head: `npm run test:unit` 170 files, 3500/3500; the `test:rules` file set 13 files, 680/680; the P1/F09/F15/p2-scheduled emulator subset 7 files, 315/315; `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck` and `build` exit 0; `npm run lint` 0 errors (89 warnings, none in a touched file); G-0 PASSED.
- The full Functions emulator suite (CI's `test:emu`): 66 of 67 files and 1628/1632 tests pass. The four failures are 15 s timeouts in `p2.jobs-scheduled`, which scans every firm the earlier files left behind. On an exact `origin/main` tree in the same environment, the same suite fails the same file the same way (3 timeouts; 1621/1624). The file passes in smaller runs: 6/6 beside the F15 file alone, and 6/6 in the P1 subset after `p1.api`, `p1.gateway` and `f09`. Its cost grows with the number of firms already in the emulator, so it fails only late in the full run. This is environmental, not an F15 regression.
- Found on the way: main's EMAIL regex backtracked quadratically (spec ruling 2). It is fixed here.

## Round 2: re-audit round 1 (FAIL 6/10)

Spec §7, rulings R2-1 to R2-6. Same constraints: TDD (each new test seen failing first), no #44 files, no `app/api/**`, escapes for invisible characters, no PR opened or edited by the builder.

### Task R2-A: the re-auditor's inputs as RED tests

**Files:** create `tests/f15-r2-corpus.ts` (the 126-line corpus, verbatim), `tests/f15-r2-mask.test.ts`, `tests/f15-r2-residual.test.ts` and `tests/f15-r2-bounds.test.ts`. Modify `functions/test/f15-pii-mask.e2e.emu.test.ts`: add rows (f) to (h), correct the header and rename (d′).

- [x] Write them before any implementation change. Run them against 92cf971's sources and record the failures.

### Task R2-B: detection view (R2-1, R2-5)

- [x] Drop `\p{Default_Ignorable_Code_Point}` and `\p{M}`.
- [x] Map enclosed and dingbat digits, and Arabic and ideographic separators.
- [x] Name view: Cyrillic and Greek fold, do-chashmi he, dots dropped, `_` and `-` read as spaces.
- [x] ASCII fast paths.

### Task R2-C: mask (R2-2, R2-4, R2-5)

- [x] Bounded separators; the IBAN first.
- [x] Patterns: general mobile, UAN, landline, NTN variants, labelled and unlabelled passport, Unicode email.
- [x] A span extends over trailing marks; the view is re-joined only after a change; honorific-free name variants; `MASK_CUES`.

### Task R2-D: residual detector (R2-2, R2-3, R2-4)

- [x] Cue regexes generated from exported word lists (`RESIDUAL_CUES`); no whitespace quantifiers meeting around an optional part.
- [x] The rulings a to h, with the refinements recorded in spec §7.

### Task R2-E: docs

- [x] Spec §7 and §5.
- [x] Mask header; README "What the mask does and does not do" and its tests paragraph.

### Task R2-F: verification

- [x] RED and GREEN as recorded below; PR body `pr-body-r2.md` through `ci_gates/check_pr_phase_claims.py`.

### Round-2 execution record

**RED, against 92cf971's sources** (the tests were committed first, at 4cb652c):
- `tests/f15-r2-mask.test.ts` and `tests/f15-r2-residual.test.ts`: 144 failed / 122 passed (266). Every failure is an assertion: identifiers sent unmasked, or clean prose counted.
- `tests/f15-r2-bounds.test.ts`: 7 failed / 7. The six audit inputs took 24.4 to 42.1 s each against a 1.5 s bound; the modules exported no cue lists.
- `functions/test/f15-pii-mask.e2e.emu.test.ts`: 10 failed / 13 passed (23).
  - Five rank-3 identifiers reached the provider.
  - The parentage clause after a role and a name was not blocked.
  - Three clean privileged bodies were blocked.
  - The quadratic body answered 503 `precall_deadline`.

**GREEN, at the round-2 tree:**
- `npm run test:unit`: 173 files, 3948/3948.
- `tests/f15-r2-bounds.test.ts`: 182/182. The worst cue took 0.99 s for eight 100,000-character inputs; the six audit inputs took 45 to 151 ms.
- The `test:rules` set: 13 files, 680/680.
- The Functions F15 e2e, p1.api, p1.gateway, both f09 files and p1.units: 324/324.
- `npm run typecheck`, `npm run typecheck:tests`, `npm --prefix functions run typecheck` and `build`: exit 0.
- `npm run lint`: 0 errors (89 warnings, none in a touched file).
- G-0: PASSED.

**False-positive rates.**
- The re-auditor's corpus: 0 of the 124 clean lines are flagged. The two lines ruled true positives count as ruled.
- The mask leaves all 126 lines unchanged.
- Round 1's own corpus (36 lines) and the round-2 row-by-row passes (37): 0 flagged.

**Changed round-1 expectations (each follows a ruling):**
- the NFKC-expansion span test now uses U+FB01;
- do-chashmi he now folds to heh goal;
- the Urdu phone-label row now has seven digits.
