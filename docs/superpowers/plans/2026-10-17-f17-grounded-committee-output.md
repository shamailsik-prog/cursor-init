# F17 Grounded Committee Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every committeeBrain answer is graded against the firm's authority corpus before it is stored and returned: a strict, structured answer contract; every cited authority resolved independently through the D4 gate's own pieces; a grounding record and an advisory flag on the row, the API answer and the resume path; the reported model recorded beside the configured one; a versioned Urdu/English evaluation set with a deterministic grader, a live harness, and a CI gate that refuses an unrecorded model, routing, policy or grading change.

**Architecture:**
- `platform/p1/systemPolicy.ts`: registry version `f17.1` (committee-brain asks for the JSON contract); `f16.1` kept verbatim in the history.
- `platform/p1/committeeAnswer.ts`: strict JSON reader (no duplicate keys, no `\u` escapes, bounded) and a zod `.strict()` contract.
- `functions/src/d4/gate.ts`: `lookUpCitation`, `verdictOfJudgment`, `budgetedStore` exported; `checkCitations` composed from them, behaviour unchanged.
- `functions/src/p1/grounding.ts`: `groundAnswer(...)` → `Grounding` (status rules `f17.1`), `isAdvisory`.
- `functions/src/p1/transport.ts`, `gateway.ts`: the reported model id; `onAnswer` hook; `modelReported` on the result, the usage row and the receipt.
- `functions/src/p1/ops.ts`: grounding started from `onAnswer`, awaited after `callP1`; on resume computed from the receipt; row and answer carry `grounding`, `advisory`, `model`, `modelReported`, `modelMatch`; `receiptOf` refuses a `grounding` field and a malformed `modelReported`.
- `docs/evals/committee-brain-eval-set.json`, `docs/evals/committee-brain-eval-record.json`, `functions/src/p1/evalSet.ts`, `functions/src/cli/committeeEval.ts`, `ci_gates/check_committee_eval_record.py`.

**Tech Stack:** TypeScript, zod 4, vitest, firebase-admin, the Auth and Firestore emulators, PostgreSQL 16 + pgvector (F05 suite), Python 3 (gate).

**Spec:** `docs/superpowers/specs/2026-10-17-f17-grounded-committee-output-design.md`

## Global Constraints

- Do not edit `platform/http/withSession.ts`, `platform/p5/session.ts`, `platform/persistence/adminFirestore.ts`, `platform/persistence/firestoreSpineRepositories.ts`, `platform/p5/committeeScope.ts`, `platform/p5/insecureDevAuth.ts`; no `app/api/**`.
- F07/F08 reservation and accounting unchanged; F09 resume of a pre-change receipt kept; a malformed receipt fails closed 409.
- Never skip or weaken a test; never rename a test the G-4 gate selects by name. Every changed expectation is listed in the ledger below with its reason.
- Invented names only (Qalvo, Nura, Tariq Zarvani, Haris Qalbani, Omer Daryani); synthetic 2099 citations; no real case presented as in the corpus.
- Invisible and bidi characters only as `\u` escapes in source; the eval set holds none (checked by a test).
- Emulators on private ports (an uncommitted scratch copy of `firebase.json`).
- Commit and push after each task.

## Review Focus

- Grading sees exactly what is shown: strict reader, no `\u` escapes, no duplicate keys, unknown keys refused.
- The gate's citation behaviour is unchanged (its suites pass unmodified); grounding reuses its steps.
- Nothing is ever `grounded` without a corpus; an empty citation set is `not_assessed`, never OK.
- Grounding adds no time to the worst case (import-time check) and no spend; a failure never loses the answer.
- Receipts: pre-change resumes; `grounding` on a receipt or a malformed `modelReported` is 409 with no second call.

---

### Task 1: Spec and plan

- [x] Write the spec (rulings 1-7, refinements R1a-R1c, R3a, R6a, residual risk) and this plan. Commit and push.

### Task 2: D4 gate pieces (refactor under the existing suites)

- [ ] Write `functions/test/f17-gate-pieces.test.ts`: `lookUpCitation` outcomes (suspect, not normalised, unavailable, not found, found with key `j:<id>`), `verdictOfJudgment` (VERIFIED, OVERRULED, pending → UNVERIFIED, treatments unavailable), `budgetedStore` cut-off. Run: FAIL (exports missing).
- [ ] Refactor `gate.ts`; run the new test and `test/d4.gate.test.ts` (unchanged): PASS.

### Task 3: answer contract and strict reader

- [ ] Write `tests/f17-committee-answer.test.ts` (valid answers in English and Urdu; each refusal: not an object, fence, prose before/after, duplicate key at each level, `\u` escape, depth, size, unknown key, wrong kind, bounds, `__proto__`). Run: FAIL (module missing).
- [ ] Implement `platform/p1/committeeAnswer.ts`. Run: PASS.

### Task 4: grounding

- [ ] Write `functions/test/f17-grounding.test.ts` (every status rule; per-citation statuses; dedupe and `source`; statute authorities; masking of suspect refs; cap and `omitted`; unavailable store; generic error → unverifiable; EMPTY store never grounded; budget). Run: FAIL.
- [ ] Implement `functions/src/p1/grounding.ts`. Run: PASS.

### Task 5: registry f17.1

- [ ] Write `tests/f17-system-policy.test.ts` (current version f17.1; committee text asks for the contract; f16.1 texts unchanged by SHA-256 pinned from main; f16.1 still resolves). Run: FAIL.
- [ ] Bump the registry. Run the new test and every `tests/f16-*` test: PASS.

### Task 6: transport and gateway: model identity, onAnswer

- [ ] Add to `functions/test/p1.transport.test.ts` (reported `model` returned when an id; dropped when not) and `functions/test/f17-gateway-model.emu.test.ts` (`modelReported` on the result and the usage row; `onAnswer` called once with the masked text, never for a blocked or failed call; a throwing hook does not break the call). Run: FAIL.
- [ ] Implement. Run: PASS.

### Task 7: committeeBrain: grounding, advisory, model identity, receipts

- [ ] Write `functions/test/f17-grounded-output.e2e.emu.test.ts` (spec ruling 7 (a) to (e)). Run against main's sources (RED evidence) and on the branch before the change: FAIL.
- [ ] Implement in `ops.ts` (time-budget import check, `p1OpsTestSeam.groundingBudgetMs`). Run the e2e and the P1/F07-F08/F09/F15/F16 emulator files: PASS.

### Task 8: evaluation set, deterministic grader, live harness

- [ ] Write `functions/test/f17-eval-set.test.ts` (set shape and counts: at least 40 items, both languages, every category; no `\p{Cf}` in the file; every item graded as expected; record counts match) and `functions/test/f17-eval-live.test.ts` (no key: NOT RUN, exit 0, no fetch; with a stub transport: grades and checks live expectations). Run: FAIL.
- [ ] Write the set, `functions/src/p1/evalSet.ts`, `functions/src/cli/committeeEval.ts`, the build entry and the npm script. Run: PASS.

### Task 9: the change gate

- [ ] Write `tests/f17-eval-record-gate.test.ts` (passes on the repo; fails on an unrecorded model change, passes once recorded; fails on routing, policy, rules or set change, a failed result, a missing NOT RUN note, an unreadable source). Run: FAIL.
- [ ] Write the gate, the record, G-0 check [17], `npm run gate:f17-eval-record`. Run: PASS; `BASE=origin/main bash ci_gates/gate_g0.sh`: PASS.

### Task 10: the corpus-backed e2e (F05 suite)

- [ ] Write `functions/test/f17-grounding-corpus.pg.test.ts`; add it to `test:f05-authority`. Run against main (RED) and the branch (GREEN) on a local PG16 + pgvector under /tmp.

### Task 11: docs, verification, PR body

- [ ] `functions/src/p1/README.md` section "Grounded committee output (audit F17)"; spec ledger.
- [ ] Verification: `npm run test:unit`; `npm run test:rules`; the Functions emulator files; the F05 suite; one full Functions emulator run with a hard timeout; `npm run typecheck`, `typecheck:tests`, functions typecheck and build; `npm run lint`; `BASE=origin/main bash ci_gates/gate_g0.sh`; the gate's tests. Adversarial re-read of the diff.
- [ ] PR body (scratchpad), checked with `ci_gates/check_pr_phase_claims.py`.

## Ledger

| Task | Commit | RED | GREEN |
| --- | --- | --- | --- |
| 1 | (this commit) | n/a | n/a |
