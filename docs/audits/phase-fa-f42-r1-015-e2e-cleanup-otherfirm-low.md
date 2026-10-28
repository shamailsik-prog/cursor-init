# FA-F42-R1-015 — F42 deletion e2e: `otherFirm` (`uniq("f42x")`) and low-clearance auth user cleanup

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-015** (F42 R1 follow-up, LOW)

## Problem (RED baseline)

Commit **`301e65d`** (`test(F42): clean up the retention e2e firms so later suites stay fast`) introduced `afterAll` cleanup via `deleteFirmScopedData(firms, uids)` on `functions/test/f42-retention-deletion.e2e.emu.test.ts`, but two resources created inside individual tests were **not** registered:

| Resource | Where created | Leak per run |
| --- | --- | --- |
| `otherFirm = uniq("f42x")` | Saga isolation case: `seedStores(otherFirm, …)` (~11 inventoried rows with `firmId` = that id) | Firestore rows keyed by an unlisted firm id |
| `low` partner (`mintIdToken` with `clearanceLevel: "public"`) | Authorisation case: clearance gate on `approveMatterDeletion` | One Auth emulator user |

Neither id was pushed to the file-level `firms` / `uids` arrays, so `afterAll` never deleted them. On a long-lived shared emulator this inflated firm-scoped scans and Auth user counts for downstream suites (same class of problem as the original `301e65d` motivation).

Spec **R35** requires every F42 e2e suite to tear down everything it creates.

## Correction

Implemented on main in **#133** (`d3b87dbb`, commit `3d306fa6` within that merge):

- `firms.push(otherFirm)` immediately after `uniq("f42x")` in the saga isolation test.
- `uids.push(low.uid)` immediately after minting the low-clearance partner in the authorisation test.

No change to production retention code; only test harness bookkeeping.

**Scope (investigated on tip `83f0f805`):** `uniq("f42x")` appears only in `f42-retention-deletion.e2e.emu.test.ts`. Other F42 emulator suites (`f42-r1-followup`, `f42-r2-followup`, `f42-retention-apply`) route firms through `newFirm()` / `firmFor()` or explicit `firms.push` and route auth users through `member()` / `uids.push`. The Next-side follow-up (`tests/f42-r1-followup-next.e2e.firestore.test.ts`) tracks `created` + `authUsers` in `afterAll`.

**Guard:** `functions/test/f42-e2e-cleanup.unit.test.ts` fails if either `firms.push(otherFirm)` or `uids.push(low.uid)` is removed from the deletion e2e source, if `afterAll` does not call `deleteFirmScopedData(firms, uids)` inside the `afterAll(async () => { … }, 120_000)` hook body before that hook’s `}, 120_000)` (mutants **M4** empty arrays, **Mmove** / **MmoveT** call relocated to `it.skip` at EOF — PR **#187** killed **Mmove** but not **MmoveT**, where an empty `afterAll` plus `it.skip(…, async () => { … deleteFirmScopedData … }, 120_000)` let a naive `[\s\S]*?` span cross the real hook close; fixed with a tempered prefix `(?:(?!\},\s*120_000\s*\))[\s\S])*` before the required call), or if a vacuous `afterAll[\s\S]*?deleteFirmScopedData` pattern is reintroduced (PR **#186** residual **FA-F42-R1-015-001-001**).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-015 | `301e65d` afterAll missed `f42x` firm rows and `low` auth user |
| RED | `301e65d` `f42-retention-deletion.e2e.emu.test.ts` | `otherFirm` seeded but not `firms.push`; `low` minted but not `uids.push` |
| GREEN | Spec R35 (`docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`) | E2e suites clean up everything they create |
| GREEN | `functions/test/f42-retention-deletion.e2e.emu.test.ts` | `firms.push(otherFirm)` + `uids.push(low.uid)` with FA-F42-R1-015 comments |
| GREEN | `functions/test/f42-e2e-cleanup.unit.test.ts` — `FA-F42-R1-015` | Source contract guard |

### Mutants that must stay killed

| Mutant | Guard |
| --- | --- |
| Drop `firms.push(otherFirm)` or `uids.push(low.uid)` | Push-order regex assertions |
| **M4** — `afterAll` calls `deleteFirmScopedData([], [])` (arrays never consumed) | `afterAll` hook body must call `deleteFirmScopedData(firms, uids)` before `}, 120_000)`; literal empty-array call forbidden |
| **Mmove** — move `deleteFirmScopedData(firms, uids)` out of `afterAll` into bare `it.skip` at EOF (FA-F42-R1-015-001-001) | `AFTER_ALL_DELETE_FIRMS_UIDS_GUARD` in `f42-e2e-cleanup.unit.test.ts`; dedicated fixture test |
| **MmoveT** — empty `afterAll(async () => {}, 120_000)`; cleanup in `it.skip(…, async () => { … }, 120_000)` at EOF so the old `[\s\S]*?` body span matched the skip’s timeout close | Same guard with hook-close tempered prefix; dedicated **MmoveT** fixture test |

## Focused verification

Unit guard (no emulators):

```bash
npm --prefix functions test -- test/f42-e2e-cleanup.unit.test.ts -t 'FA-F42-R1-015'
```

Emulator proof (the two affected cases; requires Auth + Firestore emulators):

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r1015 \
  "npm --prefix functions test -- test/f42-retention-deletion.e2e.emu.test.ts -t 'other matters and firms are untouched|authorisation: partners only'"
```

Optional: before/after row count for documents whose `firmId` contains `f42x` and Auth `listUsers` length — as recorded in `3d306fa6` (11 rows + 1 user leaked per pair of runs on the RED baseline; stable counts on GREEN).

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
| classification | **COMPLETE** — product fix on main (`3d306fa6`); this PR adds the acceptance ledger and source guard; focused emulator run on PR branch passed both affected cases (`f42r1015-emulator-e2e.log`, exit 0) |
