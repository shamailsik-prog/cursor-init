# FA-F42-R1-011 — Periodic retention `periodBasis` / `ageable` gate blocks unsafe ratification

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-011** (F42 R1 follow-up, LOW)

## Problem (RED baseline)

Before PR **#133** (`d3b87dbb`), periodic retention had no coherent contract for what a class's period ages from, and validation did not refuse policies that `retention.apply` could only partially execute:

1. **Inventory:** 28 Firestore stores use profile `matter_content`; only **`firestore:committee_outputs`** declares an `ageField` (`createdAt`, millis). The other 27 matter-content stores have no row-age anchor.
2. **Semantics:** Module 9 frames retention for **closed matters** (age from matter closure), not from each row's `createdAt`. A deleting period that aged only `committee_outputs` would silently leave the other 27 stores untouched while appearing ratified.
3. **Risk:** Ratifying `periodDays` + deleting `periodicAction` on `matter_content` (or any class with non-`ageable` stores) before FU-8 or full inventory coverage would violate the finding's **must be fixed before any period is ratified** bar.

Root cause: no `periodBasis` on classes, and no rule that a **deleting** period must be adoptable on **every** store of its class via `ageable()` (Firestore matter-keyed store with `ageField`).

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further behaviour change on top of `5d733c975569124f49759b9f316d7b69c81b1681`).

**Chosen approach:** name what each class's period ages from (`periodBasis`: `row_age` | `matter_closure`); refuse incoherent ratification in `validatePolicy` and `ci_gates/check_data_inventory.py`; fail `retention.apply` permanently (`retention_policy_invalid`) if an invalid policy slips through.

- **`functions/src/retention/config.ts` — `PeriodBasis`, `ageable()`, `validatePolicy`:** Every class must have a known `periodBasis`. A deleting period with `periodBasis: matter_closure` throws (`class … periodBasis matter_closure (FU-8)`). A deleting period on a class where any store is not `ageable()` throws (`store … period not applicable`).
- **`infra/retention/policy.json`:** Every class has `periodBasis`. `matter_content` ships `periodDays: null`, `periodicAction: retain`, `periodBasis: matter_closure` (proposed 2190-day purge in `proposed` is inert until ratified and until FU-8 / full coverage).
- **`functions/src/retention/apply.ts`:** `policyForRun()` → `activePolicy()`; `RetentionConfigError` → permanent `retention_policy_invalid` before any row is read.
- **`ci_gates/check_data_inventory.py`:** Mirrors the same rules on `policy.json` + `inventory.json` so CI blocks ratification of unsafe periods.
- **Intentional gap (not closed by bulk `ageField` edits):** 1/28 `matter_content` `ageField` coverage remains until the owner ratifies with FU-8 (matter-closure aging) or inventory work gives every matter-content store a defensible row-age field. Adding 27 invented `ageField`s would falsely imply `row_age` readiness and would still not implement matter-closure aging.
- **Rejected alternative:** Ratifying a deleting `row_age` period on `matter_content` by only tagging `committee_outputs` (partial purge while 27 stores retain rows).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-011 | Periodic retention could be ratified without full class coverage or without matter-closure semantics |
| RED | Inventory `infra/retention/inventory.json` | 28 `matter_content` stores; `ageField` only on `committee_outputs` |
| GREEN | `validatePolicy` + shipped policy | `matter_content` validates with no period; deleting `matter_closure` or partial `row_age` periods throw |
| GREEN | `functions/test/f42-retention.units.test.ts` — `FA-F42-R1-011` | Refuses missing/unknown basis, FU-8 deleting `matter_closure`, deleting `row_age` on incomplete class, vault/audit stores; accepts row-aged period on `ai_record` and retain-only period on `matter_content` |
| GREEN | `functions/test/f42-retention-apply.e2e.emu.test.ts` — `FA-F42-R1-011` | Invalid policies dead-letter `retention_policy_invalid`; no `retention_runs` doc; seeded rows unchanged |
| GREEN | `ci_gates/test_check_data_inventory.py` — `test_a_deleting_period_must_cover_its_class_and_matter_closure_is_not_adoptable` | Gate messages for FU-8 and non-`ageable` stores; green when test inventory adds required `ageField` |
| GREEN | Spec R31 (`docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`) | R1-011: periodic retention cannot be ratified incoherently |

### Mutant that must stay killed

If `validatePolicy` skipped the `matter_closure` deleting-period check, or treated stores without `ageField` as `ageable`, the existing unit case **`FA-F42-R1-011: a deleting period is adoptable only aged by row, on a class whose every store retention.apply can age`** would stop throwing on:

- `class matter_content periodBasis matter_closure (FU-8)` with `periodDays: 30`, `periodicAction: purge`
- `store firestore:custody_events period not applicable` with `matter_content` deleting `row_age` period

No new product code is required for this acceptance slice; those mutants are already guarded by the shipped test.

## Focused verification

```bash
npm --prefix functions test -- test/f42-retention.units.test.ts -t 'FA-F42-R1-011'
```

CI inventory gate (Python):

```bash
python -m pytest ci_gates/test_check_data_inventory.py -k 'deleting_period_must_cover_its_class'
```

With Auth + Firestore emulators (apply path):

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- test/f42-retention-apply.e2e.emu.test.ts -t 'FA-F42-R1-011'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (periodBasis / ageable gate acceptance for R1-011; matter-closure execution remains FU-8; full matter_content `ageField` inventory not claimed) |

No COMPLETE / product-done claim. Unsafe period ratification is gated; matter-closure **execution** and full matter-content row aging are follow-ups, not this ledger.
