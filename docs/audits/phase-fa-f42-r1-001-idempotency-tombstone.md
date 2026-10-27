# FA-F42-R1-001 — Idempotent replay after matter tombstone

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-001** (F42 R1 follow-up, spec R21)

## Problem (RED baseline)

Before PR #133 (`d3b87dbb`), a completed idempotency record replayed its stored `{status, body}` before any authority or tombstone check. After a matter was approved for deletion and tombstoned:

- A **fresh** `createDraft` (Cloud Functions) or `compose` on `POST /api/d4/drafts` (Next) correctly returned **403** `matter_deleted`.
- A **same `Idempotency-Key` replay** of an earlier **200** still returned the stored draft (matter title in the body), leaking content from a deleted matter.

Root cause: `idempotency_keys` / `idempotency_effects` on both stacks had no link from the stored answer to the matters the operation touched, so replay could not consult `matter_tombstones`.

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no behaviour change).

- **Matter linkage on store:** `platform/retention/operationMatters.ts` records every matter a permission check named (`recordOperationMatter` from Functions `evaluate` and Next `checkPermission`) plus every `matterId` / `linkedMatterId` in the stored JSON body. Fields `matterIds` (≤50) and `matterIdsTruncated` are written on the idempotency record when the answer is stored.
- **Tombstone before replay (Functions):** `replayVerdict` in `functions/src/http/idempotency.ts` reads tombstones for all ids to check; tombstoned → **403** `matter_deleted`; truncated list → **409** `idempotency_replay_unavailable` (fail closed). Refused replays are audited as deny rows (no matter content).
- **Tombstone before replay (Next):** `DurableIdempotencyStore.begin` in `platform/http/durableIdempotency.ts` applies the same rules; `beginIdempotentRequest` maps `matter_deleted` to **403**.
- **Routes in scope for this finding:** Functions `createDraft`; Next `POST /api/d4/drafts` (`action: compose`). The same mechanism covers all matter-scoped idempotent routes listed in spec §11 R21.
- **Rejected alternative:** Purging idempotency rows in the approval transaction (unbounded keys per matter within TTL; 500-write transaction limit).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-001; main before #133 | Tombstoned matter + same-key replay of prior create/compose **200** returns old body with title |
| RED | Fresh call after tombstone | **403** `matter_deleted` |
| GREEN | `tests/platform-retention-operation-matters.test.ts` | `matterIds` union, truncation flag, nested recording scopes |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `createDraft: a same-key replay after the approval is refused 403 matter_deleted…` | Replay **403** after tombstone; pre-tombstone replay **200** `reused`; record keeps `matterIds`; body has no title |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — legacy record without `matterIds` | Replay judged from body's `matterId` → **403** after tombstone |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `matterIdsTruncated` | **409** `idempotency_replay_unavailable`; retention admin route still replays |
| GREEN | `tests/f42-r1-followup-next.e2e.firestore.test.ts` — F02 path compose | Same-key replay **403** after tombstone; fresh **403**; no title in replay body |
| GREEN | `tests/f42-r1-followup-next.e2e.firestore.test.ts` — core durable store without F02 frame | Direct Next store replay **403** `matter_deleted` after tombstone |
| GREEN | Non-deleted matter | Pre-tombstone same-key replay still **200** with `reused: true` (control in emulator tests above) |

## Focused verification

```bash
npm test -- --run tests/platform-retention-operation-matters.test.ts

npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-001'"

npm run test:rules -- --run tests/f42-r1-followup-next.e2e.firestore.test.ts -t 'FA-F42-R1-001'
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (idempotency tombstone replay on both stacks; broader F42 retention/deletion remains gated elsewhere) |

No COMPLETE / product-done claim.
