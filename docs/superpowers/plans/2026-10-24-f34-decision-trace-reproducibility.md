# F34 Decision Trace Reproducibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every P1 attempt leaves a durable, redacted decision record (template identity, prompt hash, model and transport identity, retrieval anchors, policy verdicts, phase timings, cost, approval state, export state) that an operator query joins with the usage row, the reservation and the output; traces carry no confidential or privileged text; lost exports are retried and end in a recorded state; the eve bridge reports real usage.

**Architecture:** A sibling collection `p1_decisions/{usageLogId}` staged in the call's commit transaction (no new time-budget phase), seeded on the reservation for the lease reconciler, merged by the committee publisher; a pinned template hash table in `platform/p1`; a fenced scheduled export reconciler; a pure join for reconstruction behind an operator CLI.

**Tech Stack:** TypeScript, firebase-admin, firebase-functions v2 scheduler, vitest over the Auth and Firestore emulators.

**Spec:** `docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md` (rulings R1 to R14).

## Global constraints

- No new dependency; no lockfile change; no `npm ci`.
- Emulators on the private ports only (Firestore 8397, Auth 9397, hub 4391, logging 4393, websocket 8398).
- `gateway.ts` is shared with F43: metadata and trace edits only; merge `origin/main` before each push.
- `CALL_WORST_CASE_MS` and the committee time budget are unchanged (R2).
- Synthetic data only; planted markers are invented strings.

## Tasks

- [ ] **T1 RED tests.** Write `functions/test/f34-decision-trace.e2e.emu.test.ts`, `functions/test/f34-decision-units.test.ts`, `functions/test/f34-template-callsites.test.ts`, `tests/f34-prompt-template-pins.test.ts`, `tests/f34-eve-usage.test.ts`. Run them on the unchanged tree; record the failures (ledger below).
- [ ] **T2 Template pins (R3).** `platform/p1/promptTemplates.ts`: `PROMPT_TEMPLATE_PINS`, `promptTemplateOf`, `promptHash`. Gateway refuses an unpinned template (`system_unverified`).
- [ ] **T3 Decision record (R1, R2, R4 to R8).** `functions/src/p1/decisionRecord.ts`: types, builders, `decisionRef`, the export state machine, `reconstructP1Decision`. Gateway: phase timings, verdicts, `decisionSeed` on the reservation, `transportMs` on the attempt, the record staged in `stage`. Transport: `id`.
- [ ] **T4 Retrieval anchors (R5) and publication merge (R9).** Grounding records verification anchors through a recording store; `ops.ts` merges them, the output link and the approval state in the publication transaction (new call and resume).
- [ ] **T5 Lease reconciler (R2).** Stage the decision record from the reservation's seed and attempt.
- [ ] **T6 Trace hygiene (R10).** `buildTrace` text only at ranks 0 to 1; metadata ids and hashes; update the P3-67 unit expectations.
- [ ] **T7 Export reconciler (R11).** `functions/src/p1/traceExportReconciler.ts`, export in `index.ts`, manifest function and alert, composite index, README runbook entry.
- [ ] **T8 Eve bridge usage (R12).** `committeeBrainModel.ts`, `internalAICaller.ts` usage pass-through.
- [ ] **T9 Operator CLI (R13).** `functions/src/cli/p1Decision.ts`, build entry, script.
- [ ] **T10 Docs.** P1 README sections (decision record, trace, runbook for `p1.trace_export_abandoned`), open item O-55 narrowed.
- [ ] **T11 Verification.** Typecheck (root, functions), eslint on touched files, the suites and neighbours, G-0, G-1, G-2, deploy-contract gate, claim gate, gitleaks; mutation (at least 10 mutants).

## RED/GREEN ledger

Filled in as the tasks run; exact counts from the runs, evidence in `/tmp/claude-0/-home-user/7c93b457-ba66-5c9c-b05b-44e0b66b7f92/scratchpad/evidence-f34.txt`.

| Test file | RED (tree = main + tests) | GREEN (branch) |
| --- | --- | --- |
| `functions/test/f34-decision-trace.e2e.emu.test.ts` | pending | pending |
| `functions/test/f34-decision-units.test.ts` | pending | pending |
| `functions/test/f34-template-callsites.test.ts` | pending | pending |
| `tests/f34-prompt-template-pins.test.ts` | pending | pending |
| `tests/f34-eve-usage.test.ts` | pending | pending |
