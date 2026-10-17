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

- [x] Write `functions/test/f17-gate-pieces.test.ts`: `lookUpCitation` outcomes (suspect, not normalised, unavailable, not found, found with key `j:<id>`), `verdictOfJudgment` (VERIFIED, OVERRULED, pending → UNVERIFIED, treatments unavailable), `budgetedStore` cut-off. Run: FAIL (exports missing).
- [x] Refactor `gate.ts`; run the new test and `test/d4.gate.test.ts` (unchanged): PASS.

### Task 3: answer contract and strict reader

- [x] Write `tests/f17-committee-answer.test.ts` (valid answers in English and Urdu; each refusal: not an object, fence, prose before/after, duplicate key at each level, `\u` escape, depth, size, unknown key, wrong kind, bounds, `__proto__`). Run: FAIL (module missing).
- [x] Implement `platform/p1/committeeAnswer.ts`. Run: PASS.

### Task 4: grounding

- [x] Write `functions/test/f17-grounding.test.ts` (every status rule; per-citation statuses; dedupe and `source`; statute authorities; masking of suspect refs; cap and `omitted`; unavailable store; generic error → unverifiable; EMPTY store never grounded; budget). Run: FAIL.
- [x] Implement `functions/src/p1/grounding.ts`. Run: PASS.

### Task 5: registry f17.1

- [x] Write `tests/f17-system-policy.test.ts` (current version f17.1; committee text asks for the contract; f16.1 texts unchanged by SHA-256 pinned from main; f16.1 still resolves). Run: FAIL.
- [x] Bump the registry. Run the new test and every `tests/f16-*` test: PASS.

### Task 6: transport and gateway: model identity, onAnswer

- [x] Write `functions/test/f17-transport-model.test.ts` (a new file rather than additions to `p1.transport.test.ts`, so its RED run on main is one file: reported `model` returned when an id; dropped when not) and `functions/test/f17-gateway-model.emu.test.ts` (`modelReported` on the result and the usage row; `onAnswer` called once with the masked text, never for a blocked or failed call; a throwing hook does not break the call). Run: FAIL.
- [x] Implement. Run: PASS.

### Task 7: committeeBrain: grounding, advisory, model identity, receipts

- [x] Write `functions/test/f17-grounded-output.e2e.emu.test.ts` (spec ruling 7 (a) to (e)). Run against main's sources (RED evidence) and on the branch before the change: FAIL.
- [x] Implement in `ops.ts` (time-budget import check, `p1OpsTestSeam.groundingBudgetMs`). Run the e2e and the P1/F07-F08/F09/F15/F16 emulator files: PASS.

### Task 8: evaluation set, deterministic grader, live harness

- [x] Write `functions/test/f17-eval-set.test.ts` (set shape and counts: at least 40 items, both languages, every category; no `\p{Cf}` in the file; every item graded as expected; record counts match) and `functions/test/f17-eval-live.test.ts` (no key: NOT RUN, exit 0, no fetch; with a stub transport: grades and checks live expectations). Run: FAIL.
- [x] Write the set, `functions/src/p1/evalSet.ts`, `functions/src/cli/committeeEval.ts`, the build entry and the npm script. Run: PASS.

### Task 9: the change gate

- [x] Write `tests/f17-eval-record-gate.test.ts` (passes on the repo; fails on an unrecorded model change, passes once recorded; fails on routing, policy, rules or set change, a failed result, a missing NOT RUN note, an unreadable source). Run: FAIL.
- [x] Write the gate, the record, G-0 check [17], `npm run gate:f17-eval-record`. Run: PASS; `BASE=origin/main bash ci_gates/gate_g0.sh`: PASS.

### Task 10: the corpus-backed e2e (F05 suite)

- [x] Write `functions/test/f17-grounding-corpus.pg.test.ts`; add it to `test:f05-authority`. Run against main (RED) and the branch (GREEN) on a local PG16 + pgvector under /tmp.

### Task 11: docs, verification, PR body

- [x] `functions/src/p1/README.md` section "Grounded committee output (audit F17)"; spec ledger.
- [x] Verification: `npm run test:unit`; `npm run test:rules`; the Functions emulator files; the F05 suite; one full Functions emulator run with a hard timeout; `npm run typecheck`, `typecheck:tests`, functions typecheck and build; `npm run lint`; `BASE=origin/main bash ci_gates/gate_g0.sh`; the gate's tests. Adversarial re-read of the diff.
- [x] PR body (scratchpad), checked with `ci_gates/check_pr_phase_claims.py`.

## Ledger

| Task | Commit | RED (each new test seen failing first) | GREEN |
| --- | --- | --- | --- |
| 1 | 4711b7e | n/a | n/a |
| 2 | dda0505 | `f17-gate-pieces.test.ts` 7 failed (`pieces.lookUpCitation is not a function`) | 7 passed; `d4.gate.test.ts` 77 passed unchanged |
| 3 | 1dcd430 | `tests/f17-committee-answer.test.ts` 44 failed (module missing) | 44 passed |
| 4 | 362734f | `f17-grounding.test.ts` 22 failed (module missing) | 22 passed |
| 5 | 007eefc | `tests/f17-system-policy.test.ts` 4 failed, 1 passed (the f16.1 hash guard passes on main by design) | 5 passed; with the five `tests/f16-*` files that hold the registry: 224 passed, 54 skipped (pre-existing live-only cases) |
| 6 | 1a57908 | `f17-transport-model.test.ts` 4 failed, 7 passed (no-model guards); `f17-gateway-model.emu.test.ts` 7 failed, 1 passed (not-called guard) | 11 and 8 passed; `p1.gateway.emu` and `p1.transport` pass (`ROW_FIELDS` gains `modelReported`) |
| 7 | b92b801 | `f17-grounded-output.e2e.emu.test.ts` 18 failed on the branch before the change and on main's sources (`grounding status: expected undefined to be 'ungrounded'`; the 409 rows: `expected an ApiError, the call succeeded`) | 18 passed; the P1/F06/F07-F08/F09/F15/F16/D4 emulator files pass after `p1.api.emu.test.ts`'s exact key lists gain the F17 fields (142 passed) |
| 8 | a194931 | `f17-eval-set.test.ts` 62 failed, 1 passed; `f17-eval-live.test.ts` 4 failed (module missing) | 63 and 4 passed; every one of the 57 items graded as authored on the first run |
| 9 | a194931 | `tests/f17-eval-record-gate.test.ts` 18 failed (no gate, no record) | 18 passed; G-0 [17] PASS; `tests/g0-gate-e2e.test.ts` 20 passed after its tree copies the files [17] reads |
| 10 | 7218c32 | `f17-grounding-corpus.pg.test.ts` on main's sources: 3 failed, 1 passed (the precondition) | the F05 suite with it: 4 files, 90 passed |
| 11 | 3857df4 and the ledger commit | n/a | see the PR body's verification table |

Verification at the branch head (code as of f65c2d8): `npm run test:unit` 195 files, 5,576 passed, 54 skipped (pre-existing live-only); `npm run test:rules` 14 files, 682 passed; the F05 suite with the F17 file 90 passed; the full Functions emulator run 75 files passed and 1 failed (4 tests in `p2.jobs-scheduled.emu.test.ts`, 15 s timeouts), which fail the same way on origin/main b48f79d in the same environment (the tick is O(firms) over the shared emulator, order-dependent) and pass 6 of 6 alone on the branch; `npm run typecheck`, `typecheck:tests`, functions typecheck and build exit 0; `npm run lint` 0 errors (89 pre-existing warnings, none in changed files); `npx eslint --max-warnings 0 functions` exit 0; `BASE=origin/main bash ci_gates/gate_g0.sh` PASSED.

RED against main: origin/main b48f79d exported by `git archive` into a scratch directory, the new F17 test files copied in, private-port emulators: functions 5 files, 58 failed and 8 passed (the guards named above); root 48 failed and 1 passed; the F05-suite file 3 failed and 1 passed.

## Review round (Codex P1, P2 and P2 on PR #63, head 6ac73a6)

Spec section 2a (rulings R2a, R5a, R4a).

| Finding | Commit | RED (each new test seen failing first) | GREEN |
| --- | --- | --- | --- |
| P1 `grounding.ts`: a report-style citation declared `statute`, `rule` or `other` entered the judgment path (R2a) | d62a22d | `f17-grounding.test.ts` 5 failed, 22 passed (`expected 'grounded' to be 'ungrounded'`); the e2e's new Codex-example case failed (`grounding status: expected 'grounded' to be 'ungrounded'`). Mutant with the kind check dropped: 6 unit and 1 e2e failures, reverted | 27 passed; e2e 19 passed; the set f17.2 (60 items, 3 `mislabelled_authority`) graded as authored; the gate then required the record update (set and rules f17.1 to f17.2) |
| P2 `check_committee_eval_record.py`: `liveRun {passed: 0, failed: 0}` passed (R5a) | d62a22d, 4cc74a7 | `tests/f17-eval-record-gate.test.ts` 6 failed, 29 passed; after the raw-float cases were corrected to the set's own count (4cc74a7), against the 6ac73a6 gate 9 failed, 29 passed (adds live `failed: 0.0`, deterministic `passed: N.0` and `failed: 0.0`) | 38 passed; G-0 [17] PASS |
| P2 `gateway.ts`: `modelReported` was not on `providerAttempt`, so a reconciled usage row lost it (R4a) | 7807678 | `f17-reconcile-model.emu.test.ts` 6 failed of 6 (`expected undefined to be 'claude-opus-5.5'`) | 6 passed |
| Spec and README | 6e3e396 | n/a | n/a |

Verification for the review round: the P1/F06/F07-F08/F09/F15/F16/F17/D4 emulator files 22 files, 813 passed; the F05 suite with the F17 file 4 files, 90 passed; the Functions F17 unit files 115 passed; typecheck, typecheck:tests, functions typecheck and build exit 0; lint 0 errors (89 pre-existing warnings, none in changed files); functions eslint exit 0; G-0 PASSED with [17] PASS; the live harness without a key prints NOT RUN for the 60 items of f17.2 and exits 0. The root `npm run test:unit` runs alongside a parallel emulator workload (load average 4 to 5 on 4 cores) failed only wall-clock budget tests, in files this branch does not touch (`tests/citations.time-budget.test.ts`, `tests/f15-r4-bounds.test.ts`), different ones per run; both files pass alone (65 passed). The PR body records the final run.
