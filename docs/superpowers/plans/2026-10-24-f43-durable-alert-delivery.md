# F43 durable alert delivery: implementation plan

Spec: `docs/superpowers/specs/2026-10-24-f43-durable-alert-delivery-design.md`. Branch `claude/remediate-f43` from `origin/main` f39d007. Method: test first; each e2e test fails on main and passes on the branch through the real path (emulator, real HTTP router, real worker, sweeper and `callP1`).

## Tasks

1. **Tests first (RED).** Four files under `functions/test/`:
   - `f43-alerts.unit.test.ts`: alert id, ladder, windows, severity steps, detail validation, `alert.read`/`alert.ack` table rows.
   - `f43-alerts-p2.e2e.emu.test.ts`: dispatch stall, dead letter (worker and sweeper), aborted dead letter writes nothing, commit failure, dedupe across a manual retry, queue age, stuck saga.
   - `f43-alerts-p1.e2e.emu.test.ts`: reservation failure, settlement failure (checker), 70/90 crossings, kill switch, aborted crossing writes nothing.
   - `f43-alerts-escalation.e2e.emu.test.ts`: escalation steps and fence, acknowledgment (operator, partner), owner rule, resolve and reopen, delivery.
   Run against an `origin/main` export with the test files copied in; record the failures.
2. **`functions/src/alerts/`**: `model.ts` (constants, types, id), `raise.ts` (prepare, stage, standalone and best-effort raise), `notifier.ts` (interface, log notifier, outbox staging, delivery pass), `escalator.ts`, `checker.ts`, `ops.ts` (four operations), `functions.ts` (two schedules), `README.md` (runbook).
3. **Emission points**: `p2/worker.ts` (dead letter in the transaction; best-effort `job.commit_failed`), `p2/sweeper.ts` (dead letter in query B's transaction; stall set and raise after the sweep), `p1/gateway.ts` (`stage` reads and writes the P1 alerts; `CommitArgs.nowMs`).
4. **P5 and routes**: `platform/p5/permissionDecision.ts` (`ALERT_ACTIONS`), `functions/src/p5/permission.ts` (type union), `functions/src/http/router.ts` (four routes), `functions/src/index.ts` (two exports).
5. **Rules, indexes, manifest, Terraform**: `firestore.rules`, `firestore.indexes.json`, `infra/deploy-manifest.json`, `infra/terraform/alerts.tf` (rendered).
6. **Existing tests that list exports or routes**: `p2.boot`, `p5.identity`, `runtime-options`, `g2.cross-firm`.
7. **GREEN** on the branch; neighbours (P2 jobs, sweeper, worker, events, scheduled, invariants, load, api; P1 gateway, api, F07/F08, F17 reconcile; F11; G-2); typecheck; eslint; G-0; G-1; G-2; deploy-contract gate; claim gate.
8. **Mutation**: at least 10 hand mutants, each one exact edit, run against its targeted file; table below.
9. Docs: P2 README (O-41 closed, dead-letter runbook points at the alert routes), P1 README alerts paragraph, this ledger, the PR body.

## Progress

- [x] Spec and plan (6395e7b).
- [x] Tests first: 25 tests in four files (3d24564), all 25 failing on `origin/main` f39d007 for behavioural reasons.
- [x] Implementation (63f7fc0): `functions/src/alerts/`, worker, sweeper, gateway, P5 table, routes, exports, rules, indexes, manifest, Terraform, export-list and G-2 tests.
- [x] One unit failure on the first GREEN run was a real defect: a NUL-joined id is ambiguous; the id now hashes a JSON array.
- [x] Docs: spec rulings updated with the implementation decisions; P1 and P2 READMEs; `functions/src/alerts/README.md` runbook.

## RED/GREEN ledger

Exact counts; main = `origin/main` f39d007 export with the branch's test files copied in; emulators on the builder's private ports.

| Suite | main | branch |
| --- | --- | --- |
| `f43-alerts.unit.test.ts` | 6/6 FAIL (5: module missing; 1: an associate's `alert.read` is allowed, fail open) | 6/6 PASS |
| `f43-alerts-p2.e2e.emu.test.ts` | 8/8 FAIL (no `ops_alerts` document after each fault; checker missing) | 8/8 PASS |
| `f43-alerts-p1.e2e.emu.test.ts` | 5/5 FAIL (no alert; checker missing) | 5/5 PASS |
| `f43-alerts-escalation.e2e.emu.test.ts` | 6/6 FAIL (the dead letter raises no alert; no routes, no escalator) | 6/6 PASS |
| Total | 25/25 FAIL | 25/25 PASS |

## Mutation ledger

Hand mutants, one exact edit each, run against their targeted files on the emulator (runner and logs kept in the builder's scratchpad). 18 of 18 killed. M16 survived the first pass: the concurrency assertion did not force two delivery passes onto one claimed page; the test "a page another run has claimed is not delivered twice; a claim that lapsed is delivered again" was added and kills it.

| # | Mutant | Targeted files | Result |
| --- | --- | --- | --- |
| M01 | dedupe key ignores the subject | unit, P2 | killed (2 failed / 14) |
| M02 | an open alert is re-opened on every raise | P2, P1 | killed (6 / 13) |
| M03 | a resolved alert is counted, not reopened | escalation | killed (1 / 6) |
| M04 | stall threshold 3 → 4 re-dispatches | P2 | killed (1 / 8) |
| M05 | stall comparison `>=` → `>` | P2 | killed (1 / 8) |
| M06 | queue-age cutoff 1 ms late | P2 | killed (1 / 8) |
| M07 | escalation takes two levels per step | escalation | killed (3 / 6) |
| M08 | escalation fence removed (no re-read of level and deadline) | escalation | killed (1 / 6) |
| M09 | escalation does not raise the severity | escalation | killed (1 / 6) |
| M10 | owner rule: a partner may act at level 0 | escalation | killed (1 / 6) |
| M11 | P5 table: an associate may acknowledge | unit, escalation | killed (2 / 12) |
| M12 | acknowledge leaves the alert open | escalation | killed (2 / 6) |
| M13 | P1 coupling: alerts raised in their own transaction | P1 | killed (1 / 5) |
| M14 | P2 coupling: dead-letter alert raised in its own transaction | P2 | killed (1 / 8) |
| M15 | no alert after a failed commit | P2 | killed (1 / 8) |
| M16 | delivery claim ignores the page's status | escalation | survived, then killed after the added test (1 / 7) |
| M17 | saga threshold 60 → 59 minutes | P2 | killed (1 / 8) |
| M18 | unresolved-reservation cutoff 1 ms early | P1 | killed (1 / 5) |

Known redundancy (recorded, not a defect): the escalation fence has two independent checks (the level the query saw, and the deadline); with the new deadline always computed from now, either one alone stops a second step, so a mutant removing only one survives by design. M08 removes both.
