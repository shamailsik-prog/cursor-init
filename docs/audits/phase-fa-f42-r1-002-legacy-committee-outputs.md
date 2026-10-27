# FA-F42-R1-002 — Legacy `committee_outputs` without `matterId`

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-002** (F42 R1 follow-up, spec R22)

## Problem (RED baseline)

Before PR #133 (`d3b87dbb`), matter deletion's purge saga removed `committee_outputs` only by `matterId`. Rows written before `matterId` was required were linked to a matter solely through `documentIds`. They were not matched by that query, so they survived document purge while the `committee_outputs` store could still be acknowledged as purged.

After deletion, those survivors remained readable:

- **Next** `GET /api/p1/committee-brain` still listed them for the author when `matterId` was null.
- **Client SDK** reads obeying `firestore.rules` still admitted null-`matterId` rows to any cleared partner, even when the linked documents were tombstoned or already deleted.

Root cause: no saga path keyed on `documentIds`, and no read-time refusal for legacy rows whose documents were gone or tombstoned.

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further behaviour change on top of `e7159b00`).

- **Saga purge (R22):** In `functions/src/retention/saga.ts`, the first purge group orders documents before `committee_outputs`. While purging `firestore:documents`, `purgeLegacyOutputs` pages the matter's document ids (300 per page), queries `committee_outputs` with `documentIds` `array-contains-any` in batches of ≤30 (`LEGACY_DOCUMENT_BATCH`), and deletes fenced chunks whose `matterId` is null, absent, or the matter being deleted (never another matter's row). Progress is recorded on the `committee_outputs` deletion ack so counts and hashes include legacy rows.
- **Next GET:** `app/api/p1/committee-brain/route.ts` serves null-`matterId` rows to the author only when every `documentIds` entry still resolves via `repos.documents.get` (purged documents and tombstoned matters drop out).
- **Firestore rules:** `legacyOutputLive` on `committee_outputs` requires each of up to three linked documents to exist, match `firmId`, and pass `matterLive` on the document's matter; more than three ids is denied (fail closed).
- **Index:** `firestore.indexes.json` composite on `firmId` + `documentIds` supports the saga query.
- **Rejected alternative:** Backfilling `matterId` on every legacy row at read time (unbounded writes, race with purge).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-002; main before #133 | Legacy null/absent `matterId` output linked only by `documentIds` survives saga; ack says `committee_outputs` purged |
| RED | Survivor readable | Author GET and cleared partner SDK read still succeed after documents gone/tombstoned |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-002: legacy committee outputs…` (31 docs, two batches) | Legacy rows purged; other-matter rows kept; `committee_outputs` ack `count: 4` matches reality |
| GREEN | Same file — acknowledgement after crash | First ack stands; late document purged; `afterAck` incremented |
| GREEN | `functions/test/f42-retention.units.test.ts` — purge group order | Documents, versions, `committee_outputs`, vault in first group |
| GREEN | `tests/f42-r1-followup-next.e2e.firestore.test.ts` — `FA-F42-R1-002` | Tombstoned/gone doc outputs omitted from GET; live doc and firm-level control remain |
| GREEN | `tests/firestore.rules.f42-tombstone.test.ts` — `FA-F42-R1-002` | Partner denied legacy rows for deleted/gone/too-many docs; live doc and firm-level control pass |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r2 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-002'"

npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npx vitest run --no-file-parallelism tests/f42-r1-followup-next.e2e.firestore.test.ts -t 'FA-F42-R1-002'"

npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npx vitest run --no-file-parallelism tests/firestore.rules.f42-tombstone.test.ts -t 'FA-F42-R1-002'"

npm --prefix functions test -- --run f42-retention.units.test.ts -t 'committee outputs'
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | true |
| transport_stub | true |
| classification | PARTIAL (legacy committee output purge and read refusal; broader F42 retention/deletion remains gated elsewhere) |

No COMPLETE / product-done claim.
