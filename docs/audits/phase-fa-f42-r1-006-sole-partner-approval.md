# FA-F42-R1-006 — Sole-partner self-approval on retention deletion

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-006** (F42 R1 follow-up, spec R26)

## Problem (RED baseline)

Before PR #133 (`d3b87dbb`), `approveMatterDeletion` enforced only that the approver was a different partner uid from the requester (`403 second_partner_required`). A sole partner could defeat the two-partner rule by calling `createFirmUser` to mint a second partner account, then approving their own deletion request with that puppet (auditor scenario FP7). Promoting an associate to partner via `setUserClaims` left no durable link from requester to approver, so tenure and provisioning lineage could not be judged at approval time.

Root cause: identity provisioning did not record who created an account or who granted the partner role; deletion approval did not require independent partners or minimum tenure before the request and at approval.

## Correction

Implemented on main in **#133** (`fix(F42): close retention/deletion R1+R2 findings`). This slice formalises closure with acceptance evidence only (no behaviour change on top of `ed1bcbb2`).

- **Identity (`functions/src/p5/identity.ts`):** `createFirmUser` writes `createdBy` on the users doc; partner accounts also get `partnerSince` and `partnerGrantedBy`. `setUserClaims` records the same partner fields when a role becomes partner and clears them when it leaves.
- **Approval (`functions/src/retention/ops.ts`):** `requireIndependentPartners` refuses approval when either side created or promoted the other (`approver_created_by_requester`, `approver_promoted_by_requester`, `requester_created_by_approver`, `requester_promoted_by_approver`). It requires both partners' account/role start (later of account and partner role per spec R26) to predate the request and to meet `deletion.approverMinTenureDays` (shipped **30** in `infra/retention/policy.json`), with fail-closed `*_tenure_unknown` when start cannot be read. Unreadable request time → **409** `request_invalid`.
- **Policy (`functions/src/retention/config.ts`, `infra/retention/policy.json`):** `approverMinTenureDays` is a positive integer validated at load and in CI (`ci_gates/check_data_inventory.py`).
- **Sole-partner firm:** No in-firm countersignature when every account is provisioned by one person; pending requests expire. Platform-operator countersignature (FU-7) is out of scope for this finding.
- **Rejected alternative:** Trusting uid inequality only (preserves FP7); blocking all `createFirmUser` partner roles (breaks legitimate provisioning).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-006; main before #133 | Sole partner creates second partner via `createFirmUser`, approves own request → tombstone written |
| RED | Spec R26 (design) | Approver independent of requester; minimum tenure; lineage on users doc |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-006` FP7 | Puppet partner (even backdated) cannot approve requester's request → **403** `approver_created_by_requester`; reverse request/approve → **403** `requester_created_by_approver`; no tombstone |
| GREEN | Same describe — promotion / tenure / unknown | `approver_promoted_by_requester`, `approver_tenure_too_short`, `approver_tenure_unknown` refused; deny audit rows; established independent partner **Q** approves → `in_progress` |
| GREEN | Same describe — requester side | `requester_promoted_by_approver`, `requester_tenure_too_short` refused; independent **P** approves promoted requester's matter |
| GREEN | `functions/test/f42-retention.units.test.ts` — `FA-F42-R1-006` | Shipped `approverMinTenureDays` is 30; `validatePolicy` rejects missing, zero, fractional, or non-integer values |
| GREEN | `functions/test/f42-retention-deletion.e2e.emu.test.ts` | Two established partners: request + approve still succeeds under R26 guards |
| GREEN | `ci_gates/test_check_data_inventory.py` — `test_the_approver_tenure_is_a_positive_whole_number_of_days` | Gate refuses bad `approverMinTenureDays`; shipped policy passes |

## Focused verification

```bash
npm --prefix functions test -- --run f42-retention.units.test.ts -t 'FA-F42-R1-006'

npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r6 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-006'"

cd ci_gates && python3 -m unittest test_check_data_inventory.Planted.test_the_approver_tenure_is_a_positive_whole_number_of_days -v
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (two-partner independence and tenure on deletion approve; FU-7 platform countersignature and broader F42 retention/deletion remain gated elsewhere) |

No COMPLETE / product-done claim.
