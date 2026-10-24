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

## RED/GREEN ledger

Filled in as the runs happen (exact counts; main = `origin/main` f39d007 export with the branch's test files copied in).

| Suite | main | branch |
| --- | --- | --- |
| (filled in below) | | |

## Mutation ledger

| # | Mutant | Target test | Result |
| --- | --- | --- | --- |
| (filled in below) | | | |
