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

- [x] **T1 RED tests.** Write `functions/test/f34-decision-trace.e2e.emu.test.ts`, `functions/test/f34-decision-units.test.ts`, `functions/test/f34-template-callsites.test.ts`, `tests/f34-prompt-template-pins.test.ts`, `tests/f34-eve-usage.test.ts`. Run them on the unchanged tree; record the failures (ledger below).
- [x] **T2 Template pins (R3).** `platform/p1/promptTemplates.ts`: `PROMPT_TEMPLATE_PINS`, `promptTemplateOf`, `promptHash`. Gateway refuses an unpinned template (`system_unverified`).
- [x] **T3 Decision record (R1, R2, R4 to R8).** `functions/src/p1/decisionRecord.ts`: types, builders, `decisionRef`, the export state machine, `reconstructP1Decision`. Gateway: phase timings, verdicts, `decisionSeed` on the reservation, `transportMs` on the attempt, the record staged in `stage`. Transport: `id`.
- [x] **T4 Retrieval anchors (R5) and publication merge (R9).** Grounding records verification anchors through a recording store; `ops.ts` merges them, the output link and the approval state in the publication transaction (new call and resume).
- [x] **T5 Lease reconciler (R2).** Stage the decision record from the reservation's seed and attempt.
- [x] **T6 Trace hygiene (R10).** `buildTrace` text only at ranks 0 to 1; metadata ids and hashes; update the P3-67 unit expectations.
- [x] **T7 Export reconciler (R11).** `functions/src/p1/traceExportReconciler.ts`, export in `index.ts`, manifest function and alert, composite index, README runbook entry.
- [x] **T8 Eve bridge usage (R12).** `committeeBrainModel.ts`, `internalAICaller.ts` usage pass-through.
- [x] **T9 Operator CLI (R13).** `functions/src/cli/p1Decision.ts`, build entry, script.
- [x] **T10 Docs.** P1 README sections (decision record, trace, runbook for `p1.trace_export_abandoned`), open item O-55 narrowed.
- [x] **T11 Verification.** Typecheck (root, functions), eslint on touched files, the suites and neighbours, G-0, G-1, G-2, deploy-contract gate, claim gate, gitleaks; mutation (at least 10 mutants).

## RED/GREEN ledger

Exact counts from the runs; evidence in `/tmp/claude-0/-home-user/7c93b457-ba66-5c9c-b05b-44e0b66b7f92/scratchpad/evidence-f34.txt`. RED is the final version of each test run against main f39d007's source (a `git archive` of `origin/main` with the tests copied in); GREEN is the branch head after merging main (F32 #116, #117).

| Test file | RED (main f39d007 + the tests) | GREEN (branch) |
| --- | --- | --- |
| `functions/test/f34-decision-trace.e2e.emu.test.ts` | 10 of 10 fail: no `p1_decisions` record for a committee call, a blocked call, a failed export or a reconciled reservation; confidential and privileged planted text in the Opik payload; no prompt hash in the trace metadata; no reconstruction query, export reconciler or operator CLI | 10 of 10 pass |
| `functions/test/f34-decision-units.test.ts` | does not load (`platform/p1/promptTemplates` absent): 0 of 17 run | 17 of 17 pass |
| `functions/test/f34-template-callsites.test.ts` | does not load: 0 of 5 run | 5 of 5 pass |
| `tests/f34-prompt-template-pins.test.ts` | does not load: 0 of 4 run | 4 of 4 pass |
| `tests/f34-eve-usage.test.ts` | 8 of 8 fail: every usage count undefined | 8 of 8 pass |
| `tests/firestore.rules.p1-phase3d.test.ts` | 1 fails (`p1_decisions` has no match block of its own), 25 pass (the catch-all already denied it) | 26 of 26 pass |

Mutation: 20 manual mutants on the hashing, the template pin, the trace content rule, the export state machine and its fence, the join, the gateway's template gate and prompt hash, the grounding anchors, the publisher's merge and the lease reconciler's record; all 20 killed (`scratchpad/f34/mutate.py`, each mutant applied alone and the file restored).
