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

- [ ] **T1 RED tests.** `functions/test/f34-fu-r1.e2e.emu.test.ts` (R1-001, R1-002, R1-006, R1-007, R1-009, R1-010 through the real router and the embedding handler), `tests/f34-p1-transport-import-gate.test.ts` and new cases in `tests/g0-gate-e2e.test.ts` (R1-003), `tests/f34-prompt-template-pins.test.ts` (R1-004), units in `functions/test/f34-decision-units.test.ts` (R1-005, R1-009, R1-011), `tests/f34-eve-usage.test.ts` (R1-008). Run them against a `git archive` of `origin/main` with the tests copied in; record the failures below.
- [ ] **T2 R15.** `buildTrace`: hash only at rank <= 1 and not blocked; `modelReported` recognised or `"unrecognised"`.
- [ ] **T3 R16.** `embedding.ts`: verdicts, seed in the reserve args, the record staged in the commit for every outcome, `transportMs` on the attempt; `reconciledDecision` carries `caller` and `corpusOperationId`; the embedding transport's `id`.
- [ ] **T4 R17.** `ci_gates/check_p1_transport_imports.py`, G-0 [21]; the call-site test runs the gate.
- [ ] **T5 LOWs.** R18 (RELEASED, literal history keys), R21 (`attemptRecord: "recorded"`, `fromSeed`), R22 (eve bridge), R23 (`disabledReason`, `p1.opik_misconfigured`, manifest, alerts.tf), R25 (`MASK_POLICY_VERSION`); `DECISION_RECORD_VERSION` `"f34.2"`.
- [ ] **T6 Verification.** Typechecks, eslint on touched files, the F34 and FA-D3C suites and neighbours, the full Functions suite, G-0, G-1, G-2, G-4 Phase 3d (with its exact-name list), deploy contract, claim gate, gitleaks; at least 12 mutants.

## RED/GREEN ledger

Filled in from the runs; evidence in `/tmp/claude-0/-home-user/7c93b457-ba66-5c9c-b05b-44e0b66b7f92/scratchpad/evidence-f34-fu.txt`.
