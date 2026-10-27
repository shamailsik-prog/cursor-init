# FA-F42-R1-009 — Deleted matter's P2 job rows hidden at read time

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-009** (F42 R1 follow-up, LOW)

## Problem (RED baseline)

Before PR **#133** (`d3b87dbb`), `getJob` and `listJobs` could still expose a matter-bound job after matter deletion was approved:

1. The job document remained in `jobs` with its original `matterId` until the retention saga purged it.
2. `judge` still resolved the matter snapshot from `matters/{matterId}` while the row was intact.
3. Partners with membership (or firm-scoped list paths) could see the job in **full** or as **`matterId: "restricted"`** instead of treating the row as absent.

Root cause: P2 job visibility did not treat an approved deletion (matter tombstone) as “matter unreadable”, so API routes were not fail-closed like other matter-scoped reads.

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further behaviour change on top of `c5fd88c3`).

**Chosen approach:** read `matter_tombstones/{matterId}` alongside the matter on every job visibility decision; when the tombstone applies to the matter's firm, behave as if the matter does not exist for judging.

- **`functions/src/p2/ops.ts` — `matterNow`:** Returns `null` when the matter document is missing, or when `tomb.exists` and `isTombstoneFor(tomb, matter.firmId, matterId)` (FA-F42-R1-009 comment at the function).
- **`functions/src/p2/ops.ts` — `judge`:** With `matter === null`, matter-bound visibility collapses to `{ visibility: "none" }` (`HIDDEN`); `getJob` / `readVisibleTx` throw `404 not_found`; `listJobs` omits the row from `items`.
- **`functions/src/p2/ops.ts` — `getJobOp`, `listJobsOp`, `cancelJobOp` / `retryFailedJobOp`:** All load matter + tombstone via `tombstoneRef` and `matterNow` before building a view or mutating.
- **Related (worker, not this finding's API surface):** `functions/src/p2/worker.ts` dead-letters queued work when `matterTombstoned` — covered by `f42-retention-deletion.e2e.emu.test.ts` and mutant **T6**.
- **Rejected alternative:** Leaving jobs visible until saga purge completes (leaks existence and matter association through the job API after approval).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-009 | `getJob` / `listJobs` show deleted matter's jobs (including `matterId: "restricted"`) |
| RED | `functions/src/p2/ops.ts` before #133 | No tombstone read in `matterNow`; matter snapshot still drives `judge` after approval |
| GREEN | `functions/src/p2/ops.ts` — `matterNow` + `judge` + route ops | Tombstoned matter → `matterNow` null → visibility `none` → 404 / omitted from lists |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-009` | Before approval: `getJob` returns matter id, `listJobs` contains `jobId`; after `requestAndApprove` (tombstone only, saga not run): `getJob` 404, `listJobs` excludes job, `cancelJob` 404 |
| GREEN | `functions/test/f42-retention-deletion.e2e.emu.test.ts` — tombstone-only P2 case | Direct tombstone with memberships intact: queued diagnostic job dead-letters with `matter_deleted` (worker gate; complements API hiding) |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r9 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-009'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (deleted-matter job API hiding acceptance for R1-009; broader F42 retention/deletion and saga purge remain gated elsewhere) |

No COMPLETE / product-done claim.
