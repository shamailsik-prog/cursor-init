# F34 R1 Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the independent re-audit FAIL 6/10 at e37b115 (F34, #121): no reversible prompt hash leaves the process (R1-001), the corpus embedding path writes its decision record (R1-002), and an import rule run from G-0 replaces the bypassable call-site regex (R1-003); plus the LOWs in the same files (R1-004 to R1-011).

**Architecture:** The trace rule moves into `buildTrace` (hash only where text may ride); `callP1Embedding` tracks verdicts and stages its record through the shared `commit`; a pure-Python G-0 check resolves every import of the two transport modules and allows the restricted names only to four named files.

**Tech Stack:** TypeScript, firebase-admin, vitest over the Auth and Firestore emulators, Python 3 (G-0).

**Spec:** `docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md`, section 5 (rulings R15 to R25).

## Global constraints

- No new dependency; no lockfile change; no `npm ci` (node_modules symlinked).
- Emulators on the private ports only (Firestore 8397, Auth 9397, hub 4391, logging 4393, websocket 8398), project `demo-f34-fu`, UI off.
- `gateway.ts` is shared with F43 (#120): edits limited to the decision record fields (mask version, export reason).
- FA-D3C (`embedding.ts`): auth, firm and money semantics unchanged; `fa-d3c-*` suites green.
- Synthetic data only; planted markers are invented strings.

## Tasks

- [x] **T1 RED tests.** `functions/test/f34-fu-r1.e2e.emu.test.ts` (R1-001, R1-002, R1-006, R1-007, R1-009, R1-010 through the real router and the embedding handler), `tests/f34-p1-transport-import-gate.test.ts` and new cases in `tests/g0-gate-e2e.test.ts` (R1-003), `tests/f34-prompt-template-pins.test.ts` (R1-004), units in `functions/test/f34-decision-units.test.ts` (R1-005, R1-009, R1-011), `tests/f34-eve-usage.test.ts` (R1-008). Run them against a `git archive` of `origin/main` with the tests copied in; record the failures below.
- [x] **T2 R15.** `buildTrace`: hash only at rank <= 1 and not blocked; `modelReported` recognised or `"unrecognised"`.
- [x] **T3 R16.** `embedding.ts`: verdicts, seed in the reserve args, the record staged in the commit for every outcome, `transportMs` on the attempt; `reconciledDecision` carries `caller` and `corpusOperationId`; the embedding transport's `id`.
- [x] **T4 R17.** `ci_gates/check_p1_transport_imports.py`, G-0 [21]; the call-site test runs the gate.
- [x] **T5 LOWs.** R18 (RELEASED, literal history keys), R21 (`attemptRecord: "recorded"`, `fromSeed`), R22 (eve bridge), R23 (`disabledReason`, `p1.opik_misconfigured`, manifest, alerts.tf), R25 (`MASK_POLICY_VERSION`); `DECISION_RECORD_VERSION` `"f34.2"`.
- [x] **T6 Verification.** Typechecks, eslint on touched files, the F34 and FA-D3C suites and neighbours, the full Functions suite, G-0, G-1, G-2, G-4 Phase 3d (with its exact-name list), deploy contract, claim gate, gitleaks; at least 12 mutants.

## RED/GREEN ledger

Filled in from the runs; evidence in `/tmp/claude-0/-home-user/7c93b457-ba66-5c9c-b05b-44e0b66b7f92/scratchpad/evidence-f34-fu.txt`. RED is the final version of each test run against a `git archive` of `origin/main` 0d9af65 (F43 #120 and FA-D5-003 #124 landed) with the branch's tests copied in, on a fresh private emulator. GREEN is the branch after merging that main.

| Test file | RED (main 0d9af65 + the tests) | GREEN (branch) |
| --- | --- | --- |
| `functions/test/f34-fu-r1.e2e.emu.test.ts` | 16 of 24 fail. R1-001: 8 of 10 (the privileged dictionary attack, the not_minimised name attack, ranks 2 to 4, a blocked call, the re-export, the model name; ranks 0 and 1 pass as they should). R1-002: 5 of 5 (no embedding record anywhere). R1-007, R1-009, R1-011: 3 of 3. Pass on main by design: R1-006 (characterises residual 10) and the five R1-010 mutant-killing tests | 24 of 24 pass |
| `functions/test/f34-decision-trace.e2e.emu.test.ts` (changed expectations) | 3 of 10 fail (record version; ranks 2 and 3 still export the hash) | 10 of 10 pass |
| `functions/test/f34-decision-units.test.ts` | 10 of 27 fail | 27 of 27 pass |
| `functions/test/p1.units.test.ts` (one changed expectation) | 1 of 39 fails | 39 of 39 pass |
| `functions/test/f34-template-callsites.test.ts` | 1 fails (no G-0 [21] gate); 4 pass | 5 of 5 pass |
| `tests/f34-p1-transport-import-gate.test.ts` | 29 of 29 fail (the gate does not exist) | 29 of 29 pass |
| `tests/g0-gate-e2e.test.ts` | 3 of 24 fail: both auditor shapes pass main's G-0; the control lacks check [21] | 24 of 24 pass |
| `tests/f34-eve-usage.test.ts` | 1 of 9 fails (a send that threw reports none_sent) | 9 of 9 pass |
| `tests/f34-prompt-template-pins.test.ts` | 6 of 6 pass; mutant M25 (the auditor's T5: a bump that drops f17.1) survives main's 4 pin tests | 6 of 6 pass; M25 killed (3 fail) |

Review round (PR #129, two Codex P2s on the gate). The fixtures were written first and run against the gate at a27f100: 15 failed, 55 passed in the gate test and the G-0 end-to-end test. The failures were 6 must-fail Codex #1 shapes, the concatenation bypass, 6 must-pass Codex #2 whitespace and comment shapes, and both G-0 end-to-end cases. After the fix, the gate test passes 44 of 44 and the G-0 end-to-end test 26 of 26. Mutants MF1 to MF7 on the fix are all killed.

Mutation (`scratchpad/f34-fu/mutate.py`, each mutant applied alone in a copy of the branch, the files restored and checked by SHA-256): 30 mutants, 25 on the new code, the gate and the export rule (M01 to M25) and the auditor's five survivors (A02, A08, A14, A15, A17). All 30 are killed. M15 (inline `type` specifiers skipped by the gate) survived the first test set; the inline-type case was added and kills it.
