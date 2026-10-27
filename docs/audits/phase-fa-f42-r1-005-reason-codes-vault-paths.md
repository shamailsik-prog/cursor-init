# FA-F42-R1-005 — Closed reason codes and id-shaped vault tombstone paths

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-005** (F42 R1 follow-up, spec R25)

## Problem (RED baseline)

Before PR #133 (`d3b87dbb`), retention APIs accepted any snake_case `reasonCode` (a regex shape check only), so client-specific text such as `client_ayesha_siddiqui_khula` could be written into `deletion_requests` and `legal_holds` and therefore into the permanent deletion trail. `purgeChunk` copied each row's `storagePath` verbatim into `vault_object_tombstones`, so a legacy or malformed path could embed a matter title or other content in an audit-trail collection that survives deletion.

Root cause: free-form reason validation at the route layer; no closed enum in `infra/retention/policy.json` enforced at runtime and in CI; vault tombstones trusted caller-supplied paths instead of the vault's canonical id-shaped key for the row.

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no further behaviour change on top of `0d03cada`).

- **Policy (`infra/retention/policy.json`):** `deletion.reasonCodes` and `legalHold.reasonCodes` are distinct closed lists (PROPOSED); ratification is a policy change, not a runtime string.
- **Config (`functions/src/retention/config.ts`):** `validatePolicy` requires each list to be non-empty, code-shaped (`REASON_CODE_SHAPE`), and duplicate-free; `activePolicy` refuses invalid policy at load.
- **Routes (`functions/src/retention/ops.ts`):** `parseReason` allows only `policy.deletion.reasonCodes` on `requestMatterDeletion` and `policy.legalHold.reasonCodes` on `placeLegalHold`; anything else is **400** `invalid_reason_code` before any read or write.
- **Saga (`functions/src/retention/saga.ts`):** `vaultPathOf` keeps `storagePath` on a tombstone only when it matches `fs://` or `s3://`, the job's `firmId`, `documents`, the row's document id, and `v<n>`. Otherwise the tombstone stores `storagePath: null`, `storagePathSha256` (SHA-256 of the original path, tombstone doc id), and `pathShape: "refused"`; the vault ack records `detail.refusedPaths`.
- **CI gate (`ci_gates/check_data_inventory.py`):** The same closed-list rules apply to the shipped `policy.json` so a bad list cannot be ratified.
- **Rejected alternative:** Sanitising or truncating free-text reason codes (would still admit arbitrary facts); rewriting arbitrary paths by stripping suffixes (would not prove firm/document alignment).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-005; main before #133 | `client_*` reason codes accepted; vault tombstones store verbatim `storagePath` with embedded titles |
| RED | Spec R25 (design) | Reason codes and vault paths must be policy- and id-shaped, not content-bearing |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-005` reason codes | `client_ayesha_siddiqui_khula` and cross-list codes **400** on request and hold; no `deletion_requests` / `legal_holds`; listed codes still work; audit trail has no `ayesha` |
| GREEN | Same file — vault paths | Legacy title path, other-firm path, and bad version suffix → tombstones with `pathShape: "refused"` and hash id; only canonical `fs://` / `s3://` paths kept; `refusedPaths: 3`; trail has no planted title |
| GREEN | `functions/test/f42-retention.units.test.ts` — policy reason lists | `validatePolicy` throws on missing, empty, non-code-shaped, or duplicate `deletion.reasonCodes` / `legalHold.reasonCodes` |
| GREEN | Same file — `vaultPathOf` | Id-shaped paths kept for matching firm/document; title paths, wrong firm/document, bad scheme, and malformed segments **null** |
| GREEN | `ci_gates/test_check_data_inventory.py` — `test_reason_codes_are_a_closed_list_of_codes` | Gate rejects mutated policy lists; shipped policy passes |
| GREEN | `docs/runbooks/retention-deletion.md` | Documents closed `deletion.reasonCodes` and `400 invalid_reason_code` |

## Focused verification

```bash
npm --prefix functions test -- --run f42-retention.units.test.ts -t 'FA-F42-R1-005'

npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r5 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-005'"

python3 -m unittest ci_gates.test_check_data_inventory.CheckDataInventoryGateTest.test_reason_codes_are_a_closed_list_of_codes -v
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (closed reason codes and id-shaped vault tombstone paths; broader F42 retention/deletion remains gated elsewhere) |

No COMPLETE / product-done claim.
