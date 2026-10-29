# FA-F43-R1-002-001 — Level-0 reset on hold-expired reopen (escalated ack)

Finding: **FA-F43-R1-002-001** [LOW] (residual of **FA-F43-R1-002** / PR #225)

ME re-audit noted FA-F43-R1-002 pins reopen after `ACK_HOLD_MS` but every fixture acknowledges at level 0, so a mutant that keeps `current.level` on reopen survives. Product `stageAlert` already sets `level: 0` on reopen; this slice adds coverage only.

## Change

| Layer | Artifact |
| --- | --- |
| Unit | `functions/test/f43-r1-002-ack-hold.unit.test.ts` — **FA-F43-R1-002-001** with `acknowledgedEscalatedRow` (level 1 partner ack) |
| E2e | `functions/test/f43-alerts-escalation.e2e.emu.test.ts` — partner ack at level 1, hold lapse, reopen at level 0 + `e2_l0` page |
| Mutant | `F43-R1-002-M04` in `functions/test/f43-r1-002-mutants.json` — reopen uses `level: current?.level ?? 0` |

## Verify

```bash
cd functions && npx vitest run test/f43-r1-002-ack-hold.unit.test.ts
node functions/scripts/f43-r1-002-mutants.mjs F43-R1-002-M04
```

Claim gate: **PARTIAL** — `backend_real` ok via unit + mutant script; e2e requires emulators (`transport_stub` ok).
