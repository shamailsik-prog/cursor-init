# F43 R1 follow-ups: implementation plan

Spec: `docs/superpowers/specs/2026-10-24-f43-durable-alert-delivery-design.md` section 8 (rulings R15 to R27). Branch `claude/remediate-f43-fu` from `origin/main` d3b857c. Method: test first; each new test fails on `origin/main` and passes on the branch through the real path (the emulator, the real HTTP router, the real sweeper, escalator, checker and `callP1Embedding`, and firebase-functions 6.6.0's real logger).

## Tasks

1. **Tests first (RED).**
   - `functions/test/deploy-contract-alert-runtime.test.ts` (rewritten, R15 to R17): HCL-subset parse of the rendered and committed `alerts.tf`; one policy per event with one log-match condition, a rate limit, auto-close and the on-call channel; the filter evaluator against the real logger's lines for every registered event; real emitters; the registry walk over the TypeScript AST. Helpers in `functions/test/alertPolicyTools.ts`.
   - `functions/test/f43-alerts-fu.e2e.emu.test.ts` (R18, R21 to R24): the acknowledgment hold through the real sweeper, router and escalator, and at its exact boundary; the level-2 re-page; clearing a derived condition; kill-switch alerts at level 0; the platform switch as one alert.
   - `functions/test/f43-alerts-escalation.e2e.emu.test.ts`: PROBE-06, 08, 09 ported (R19).
   - `functions/test/f43-alerts-p2.e2e.emu.test.ts`: PROBE-14, 15 ported (R19).
   - `functions/test/f43-alerts-checker-paging.e2e.emu.test.ts`: C2, C4, the quarantined order and the pass rotation (R19, R20).
   - `functions/test/f43-alerts-p1.e2e.emu.test.ts`: the embedding path (R26).
   - `functions/test/f43-alerts.unit.test.ts`: `ACK_HOLD_MS` and the other new constants.
2. **Renderer and manifest** (R16): `infra/render_terraform.py`, `infra/deploy-manifest.json` (`labels` on the page policy), `infra/terraform/alerts.tf` re-rendered.
3. **Emitters** (R15): `event` as the last field of every registered ERROR line in `functions/src`.
4. **Alerts module** (R18, R20 to R24): `model.ts`, `raise.ts`, `escalator.ts`, `checker.ts`, `notifier.ts`, `specs.ts`, `functions.ts`; `firestore.indexes.json` (`ai_reservations (state, quarantinedAt)`).
5. **P1** (R26): `embedding.ts` commit `nowMs`.
6. **G-2** (R25): `{ timeout: 60_000 }` on the route probe.
7. **Docs**: `functions/src/alerts/README.md` (hold, re-page, clearing, kill switch, runbook wording), this ledger, the PR body.
8. **GREEN**, neighbours, typecheck, eslint, G-0, G-1, G-2 (measured), the F32 deploy contract and its tests, `render --check`, the claim gate.
9. **Mutation**: at least 12 hand mutants (ledger below).

## RED/GREEN ledger

Filled in from the runs; exact counts.

## Mutation ledger

Filled in from the runs.
