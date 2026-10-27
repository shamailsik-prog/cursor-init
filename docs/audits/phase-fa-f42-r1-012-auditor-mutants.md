# FA-F42-R1-012 — Auditor surviving mutants (R07, R08, R09, R14, R16, R21)

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-012** (F42 R1 follow-up, LOW)

## Problem (RED baseline)

After PR **#133** (`d3b87dbb`) landed the retention/deletion R1 slice, the independent F42 auditor re-run reported **6 of 29** hand mutants still **survived** the targeted test suites:

| Auditor id | Guard (what breaks if the mutant wins) |
| --- | --- |
| **R07** | Releasing a matter legal hold must clear `deletion_requests.halted` in the same transaction as the hold row, **before** a partner retries dead-lettered jobs, so status is not stuck `in_progress` with a stale halt. |
| **R08** | A matter hold placed **after** a purge group finishes but **before** its store is acknowledged must run `assertNoHold` at acknowledgement time and must not extend `acked` beyond what prepare already wrote. |
| **R09** | `retention.apply` must **re-read** matter holds inside the fenced chunk transaction after the page query (and after any test seam), so a hold placed in that window does not anonymise or purge the matter's rows. |
| **R14** | `retentionDeletionWatch` must **re-read** each candidate request inside the alert transaction (`alertedAt` still null, still overdue); a concurrent run that already alerted the request must not produce a second F43 alert or notification. |
| **R16** | A **class** `legalHold` on `vault_object` or `third_party_trace` alone must make `policyHolds` / `holdRefusal` refuse matter deletion (`legal_hold_policy`), even when no matter hold exists. |
| **R21** | `storeKey(storeId)` in Functions and `store_key(store_id)` in `ci_gates/check_data_inventory.py` must agree on every inventoried store id and on long / odd ids (hash vs keep rules). |

Root cause of the surviving mutants: tests existed for the broad legal-hold and watch behaviour, but not pins aimed at the auditor's exact seams (release clears halt, ack-vs-hold race, apply chunk re-read, watch double-alert race, trace/vault class holds alone, cross-language store keys).

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further behaviour change on top of `54ac90d81eb61291cd868e277e841c3f2524689f`).

**Chosen approach:** add focused FA-F42-R1-012 tests (and one R07 assertion inside the existing FA-F42-R1-004 hold saga) that fail if each guard above is removed; spec **R33** records the mapping.

- **`functions/src/retention/ops.ts` — `releaseLegalHoldOp`:** Clears `halted` on halted in-progress requests when the hold is released (R07).
- **`functions/src/retention/saga.ts` — `beforeAck` / `assertNoHold`:** Acknowledgement commits only when no active matter hold (R08); mid-prepare holds via `retentionTestSeam.afterStep` (R08 “own”).
- **`functions/src/retention/apply.ts`:** Hold set re-read inside the chunk transaction (R09).
- **`functions/src/retention/watch.ts`:** Transactional re-read before `stageAlert` + `alertedAt` stamp (R14).
- **`functions/src/retention/config.ts` — `policyHolds` / `holdRefusal`:** Class holds on vault and trace classes (R16).
- **`functions/src/retention/config.ts` + `ci_gates/check_data_inventory.py` — `storeKey` / `store_key`:** Shared acknowledgement key algorithm (R21).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-012 | Six auditor mutants (R07, R08, R09, R14, R16, R21) survived |
| GREEN | Spec R33 (`docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`) | Each survivor named with a killing test |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — FA-F42-R1-004 + **R07** comment | After `releaseLegalHold`, `status` shows `halted: null` before retry |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-012` | **R08** (`beforeAck` hold); **own** (hold after `static` / `external` prepare steps) |
| GREEN | `functions/test/f42-retention-apply.e2e.emu.test.ts` — `FA-F42-R1-012` | **R09** (hold before chunk commit); **R14** (watch race via `afterQuery` seam) |
| GREEN | `functions/test/f42-retention.units.test.ts` — `FA-F42-R1-012` | **R16** (`vault_object`, `third_party_trace` class holds); **R21** (TS/Python `store_key` parity) |

### Mutants that must stay killed

| Id | Killing test (vitest `-t` filter) | If the mutant survives |
| --- | --- | --- |
| R07 | `f42-r1-followup.e2e.emu.test.ts` — `hold placed after the approval and before prepare` | `halted` stays set after release until a job runs; assertion `expect(...halted).toBeNull()` fails |
| R08 | `f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-012` / `R08:` | Purge acks advance under an active hold; `Object.keys(view.acked)` grows past `before` |
| R08 (own) | `f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-012` / `own:` | Prepare continues to processor instruction or spawns `retention.store.purge` jobs after mid-step hold |
| R09 | `f42-retention-apply.e2e.emu.test.ts` — `FA-F42-R1-012 (R09)` | Rows anonymised despite hold placed between query and chunk commit |
| R14 | `f42-retention-apply.e2e.emu.test.ts` — `FA-F42-R1-012 (R14)` | Outer watch run increments alerts when request already stamped `alertedAt` |
| R16 | `f42-retention.units.test.ts` — `FA-F42-R1-012 (R16)` | `policyHolds` false or `holdRefusal` null with only vault/trace class hold |
| R21 | `f42-retention.units.test.ts` — `FA-F42-R1-012 (R21)` | Python `store_key` list diverges from TypeScript `storeKey` |

No new product code is required for this acceptance slice; those mutants are already guarded by the shipped tests from **#133**.

## Focused verification

Unit (R16, R21):

```bash
npm --prefix functions test -- test/f42-retention.units.test.ts -t 'FA-F42-R1-012'
```

With Auth + Firestore emulators (R07, R08, R09, R14):

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- test/f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-012|hold placed after the approval and before prepare'"

npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42apply \
  "npm --prefix functions test -- test/f42-retention-apply.e2e.emu.test.ts -t 'FA-F42-R1-012'"
```

Broader F42 mutation baseline (39 mutants in `functions/test/f42-mutants.json`, optional):

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "node functions/scripts/f42-mutants.mjs"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (auditor mutant kill acceptance for R1-012; retention/deletion product scope unchanged) |

No COMPLETE / product-done claim. This ledger only proves the six named auditor survivors are pinned by tests on main after **#133**.
