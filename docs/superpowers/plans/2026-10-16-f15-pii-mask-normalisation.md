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

- [ ] Write the four files before any implementation.
- [ ] Run them with the sources still identical to main 0844ed8; record the failures (scratchpad logs, then the PR body).

### Task 3: Detection view and name view

**Files:** create `platform/p1/piiText.ts`.

- [ ] `detectionView(text)`: `{ text, start, end }`, per original code point: `\p{Cf}` dropped; NFKC; `\p{Nd}` to ASCII by the run-start rule; `\p{Pd}` and U+2212 to `-`; `\p{Zs}` to a space. ASCII fast path.
- [ ] `nameView(view)` and `foldName(name)`: lower-case, NFD minus `\p{M}`, tatweel dropped, the Arabic letter folds of ruling 3.
- [ ] `tests/f15-detection-view.test.ts` GREEN.

### Task 4: The mask on the views

**Files:** modify `platform/p1/maskOutboundPII.ts`.

- [ ] Patterns on the detection view, priority order kept, accepted spans blanked with U+E000.
- [ ] Names: folded, de-duplicated, longest first, whitespace as `\s*`, matched on the name view built from the blanked detection view.
- [ ] Output assembled from original slices and tokens; overlapping spans merged.
- [ ] Header: risk reduction, not anonymisation; the list of gaps.
- [ ] `tests/f15-mask-unicode.test.ts` mask cases GREEN; `tests/p1.outbound-mask.test.ts`, `tests/p1.provider-policy.table.test.ts`, `tests/p1.eve-committee-brain.test.ts` still GREEN.

### Task 5: Residual detector

**Files:** create `platform/p1/residualPII.ts`.

- [ ] `residualPII(text)`: four kinds, counts only, on the detection view; refinements of ruling 5.
- [ ] `tests/f15-residual-pii.test.ts` GREEN (true positives, false-positive corpus, bound).

### Task 6: assertMinimised

**Files:** modify `platform/p1/providerPolicy.ts`.

- [ ] Mask re-run clean and `residualPII` zero, on body and purpose.
- [ ] Truth table in `tests/f15-mask-unicode.test.ts` GREEN.

### Task 7: Functions wiring

**Files:** modify `functions/src/p1/gateway.ts`, `functions/src/p1/ops.ts`; modify `functions/test/p1.gateway.emu.test.ts`, `functions/test/p1.api.emu.test.ts` (exact key lists only).

- [ ] `outbound.residualCounts` on every call; `P1Result["outbound"]` type.
- [ ] `outputRow` writes `metadata.residualCounts`; `receiptOf` validates it when present.
- [ ] `partyNamesFor` reads `clients/{matter.clientId}` in parallel with `matter_parties` and adds `canonicalName`, `companyName`, `concernedPersonName` for the caller's firm.
- [ ] `functions/test/f15-pii-mask.e2e.emu.test.ts` GREEN on private-port emulators.

### Task 8: Docs

**Files:** modify `functions/src/p1/README.md`.

- [ ] Steps 4 and 5, the `not_minimised` row, `residualCounts` on the output row, the client read in the query table, the "not anonymisation" statement and its gaps.

### Task 9: Verification

- [ ] New and changed tests RED against main's sources (temporary checkout of main's source files, restored after).
- [ ] `npm run test:unit`; `npm --prefix functions run typecheck`; `npm --prefix functions run build`; the Functions emulator suite (`test:emu`, private ports); the rules suite (`test:rules`, private ports); `npm run lint`; `npm run typecheck`; `npm run typecheck:tests`; `BASE=origin/main bash ci_gates/gate_g0.sh`.
- [ ] Re-read the diff adversarially; PR body through `ci_gates/check_pr_phase_claims.py`.

## Execution record

Execution is native (inline), self-approved under the owner's standing autonomy instruction. Results are recorded in the PR body.
