# FA-F42-R1-004-001 — halt() defence-in-depth move of processor instructions

Repository: `shamailsik-prog/cursor-init`  
Finding: **FA-F42-R1-004-001** [LOW]  
Register: issue #30 (no `Fixes #30` on the PR)

## Gap

ME re-audit of PR #158 (**mutant B**): remove `moveInstructions` from `halt()` in `functions/src/retention/saga.ts` and every existing FA-F42-R1-004 emulator path still passes, because each path already moved `pending_operator` → `held` via `placeLegalHoldOp` before `halt()` runs. The suite did not prove `halt()`'s own move when a hold is active but `placeLegalHold` did not run the instruction transition.

## Correction

Test-only:

- `functions/test/f42-r1-followup.e2e.emu.test.ts` — **FA-F42-R1-004-001**: after the prepare `external` step creates a `pending_operator` Opik summary, seed `legal_holds/{matterId}` directly (FA-F42-R1-012 pattern, not `placeLegalHoldOp`); the next prepare step dead-letters; assert the instruction is **`held`** and the request shows `halted: legal_hold_active`.
- `functions/test/f42-mutants.json` — **H5-halt-skips-instruction-held** (mutant B): drop `halt()`'s `moveInstructions`; killed by the new test filter.

Production behaviour unchanged (already correct on main after #133 / #158).

## Verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r4 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-004'"

node functions/scripts/f42-mutants.mjs H5-halt-skips-instruction-held
```

| Step | Evidence | Expected |
| --- | --- | --- |
| GREEN | `FA-F42-R1-004-001` on tip | Instruction `held` after halt with direct hold seed |
| RED | Mutant **H5** / ME re-audit mutant B | Instruction stays `pending_operator` while request `halted` |

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | **PARTIAL** |
