# FA-F42-R1-004 — Legal hold halts prepare and Opik/external deletion instructions

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-004** (F42 R1 follow-up, spec R24)

## Problem (RED baseline)

Before PR #133 (`d3b87dbb`), a legal hold placed **after approval** and **before** `retention.matter.prepare` ran did not stop the prepare job from issuing third-party deletion work. `runPrepare` / `prepareSteps` had no `assertNoHold` in their fenced transactions (unlike purge). Prepare could still write `deletion_external_requests/{requestId}_opik` with `status: pending_operator` while the retention request later showed `halted: { code: legal_hold_active }`. The operator runbook did not require checking an active hold before acting on pending Opik (or other processor) rows.

A hold placed **after** prepare had already created a `pending_operator` instruction also left that row actionable until purge failed, instead of moving it to `held` when the saga halted.

Root cause: prepare steps did not re-read `legal_holds/{matterId}` inside each transaction; `halt()` did not move existing processor instructions to `held`; `placeLegalHold` did not freeze pending instructions; runbook gap on operator pre-checks.

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further behaviour change on top of `a85a58bd`).

- **Prepare (`functions/src/retention/saga.ts`):** `assertNoHold` runs inside every fenced prepare step (static acknowledgements, external/processor request, purge enqueue). `runPrepare` catches `legal_hold_active` and calls `halt()` before dead-lettering.
- **Halt (`halt`):** In one step, sets `deletion_requests` `halted: { code: legal_hold_active }` and moves every matter `deletion_external_requests` summary still `pending_operator` to `held` (FA-F42-R2-001: re-reads the hold inside the transaction so a release between `assertNoHold` and commit does not wedge `halted` with no active hold).
- **Hold ops (`functions/src/retention/ops.ts`):** `placeLegalHold` moves `pending_operator` instructions to `held` in the same transaction; `releaseLegalHold` clears `halted` on in-progress requests and returns `held` instructions to `pending_operator`.
- **Runbook (`docs/runbooks/retention-deletion.md`):** Operator must verify row `status`, request `halted`, and `legal_holds/{matterId}` before acting on any `deletion_external_requests` row.
- **Rejected alternative:** Leaving Opik rows `pending_operator` and relying on operators to notice `halted` alone (spec R24: a hold stops every remaining destructive step, including instructions to third parties).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-004; main before #133 | Hold after approval → prepare still creates Opik request `pending_operator` while request `halted` |
| RED | Runbook before #133 | No explicit hold check before acting on `deletion_external_requests` |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — hold **before** prepare | Prepare `legal_hold_active`; no external request, no purge jobs, no acks; request `halted`; after release + retry, Opik `pending_operator` |
| GREEN | Same file — hold **after** prepare | Instruction moves to `held` on place; saga halts; release restores `pending_operator`; saga completes |
| GREEN | Same file — hold **after** saga completed | Pending instruction moves to `held` |
| GREEN | `functions/test/f42-r2-followup.e2e.emu.test.ts` — `FA-F42-R2-001` | Hold released before `halt` commit → request not wedged `halted`; no erroneous `held` Opik row |
| GREEN | `functions/test/f42-retention-deletion.e2e.emu.test.ts` — hold mid-saga | Purge stops; request `halted`; stores not acked |
| GREEN | `docs/runbooks/retention-deletion.md` | Three-part operator check documented (status, `halted`, `legal_holds`) |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r4 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-004'"

npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r2 \
  "npm --prefix functions test -- --run f42-r2-followup.e2e.emu.test.ts -t 'FA-F42-R2-001'"

npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- --run f42-retention-deletion.e2e.emu.test.ts -t 'a hold placed while the saga runs halts it'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (legal hold gates prepare and external deletion instructions; broader F42 retention/deletion remains gated elsewhere) |

No COMPLETE / product-done claim.
