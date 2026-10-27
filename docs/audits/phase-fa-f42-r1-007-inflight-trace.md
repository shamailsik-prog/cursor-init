# FA-F42-R1-007 — In-flight P1 traces recorded for Opik deletion

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-007** (F42 R1 follow-up, spec R27; was RES-2)

## Problem (RED baseline)

Before PR #133 (`d3b87dbb`), a P1 call still in flight when a matter deletion was approved could lose its Opik trace from the deletion workflow:

1. **Prepare** snapshot trace ids from `ai_usage_logs` / `p1_decisions` before the purge jobs ran.
2. The call **settled after** that read and wrote a usage row (and decision record) with an exported trace id.
3. **Purge/anonymise** removed or stripped `matterId` from those rows without adding the new trace id to `deletion_external_requests` (`{requestId}_opik_p{n}`).
4. The row was anonymised in Firestore but **no operator instruction** requested Opik deletion for that trace.

Root cause: no transactional “late id” capture on anonymise/purge chunks (spec R27a) and no P1 write seam when rows landed after their store was already acknowledged (spec R27b). A committee answer could still publish for a tombstoned matter (spec R27c).

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further behaviour change on top of `f8218c9f`).

**Chosen approach:** transactional extra `_p{n}` parts on the Opik processor request in the same Firestore transaction that anonymises or purges trace-source rows (preferred over delaying prepare for the longest P1 call).

- **`functions/src/retention/lateTraces.ts`:** `readLateIds` / `stageLateIds` read every existing part in one transaction and append only ids not yet recorded (`late: true` on new parts; summary `lateIds` / `parts` / `count` updated). `readLateWrite` / `stageLateWrite` apply the same recording when P1 commits after the store ack.
- **`functions/src/retention/saga.ts` (`purgeChunk`):** Before rows lose the matter, `capturesFor` + `stageLateIds` for each external processor (FA-F42-R1-007 / R27a).
- **`functions/src/p1/gateway.ts` (`stage`):** On commit, when the matter is tombstoned and the usage/decision stores are already acknowledged, writes rows with `matterId: null`, `anonymisedBy`, and stages late trace ids (R27b).
- **`functions/src/p1/ops.ts`:** Publication refuses `403 matter_deleted` when the output’s matter is tombstoned (R27c).
- **Rejected alternative:** Delaying prepare until the longest in-flight P1 call completes (unbounded wall time, couples deletion to provider latency).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-007; `functions/src/retention/saga.ts` before #133 | No `stageLateIds` in purge/anonymise chunks; late usage rows anonymised without new Opik parts |
| RED | `functions/src/p1/gateway.ts` before #133 | No tombstone seam on P1 commit after store ack |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-007` (3 cases) | Late row after prepare: `trace-inflight` in Opik parts, `lateIds: 1`, rows anonymised; zero prepare traces → processor request created; in-flight committee call: trace recorded, `matter_deleted` on publish, no output |
| GREEN | `functions/test/f42-retention.units.test.ts` — `FA-F42-R1-007` | `capturesFor` / `exportedIds` / `stageLateIds` late-part append behaviour |
| GREEN | `functions/test/f42-retention.units.test.ts` — `FA-F42-R2-002` | `readLateIds` reads all parts in one tx (no cache drop double-count) |
| GREEN | Spec R27 (`docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`) | RES-2 marked corrected by R27 |

## Focused verification

```bash
npm --prefix functions test -- --run f42-retention.units.test.ts -t 'FA-F42-R1-007'

npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r7 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-007'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (in-flight trace capture for Opik instructions; broader F42 retention/deletion remains gated elsewhere) |

No COMPLETE / product-done claim.
