# FA-F42-R1-006-003 — Sibling partner provisioning lineage

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-006-003** (F42 / FA-F42-R1-006 residuals, spec R26)

## Problem (RED baseline)

On main at `c40ebec637adb3e27d46f45420d70561b7c3851d` (PR #161 / FA-F42-R1-006-001), `refusePartnerLineage` refused only when one partner was a **transitive ancestor** of the other. Founder **P** could create sibling partners **Q** and **R**, age both past `deletion.approverMinTenureDays` (30 days), have **Q** request matter deletion, and have **R** approve — neither is an ancestor of the other, so lineage checks passed while both remain under **P**'s provisioning tree.

Root cause: independence required a strict ancestor/descendant edge on the graph, not separation of provisioning trees.

## Correction

- **`functions/src/retention/partnerLineage.ts`:** After existing transitive ancestor-of checks (FA-F42-R1-006-001), intersect depth-capped ancestor sets from `createdBy` / `partnerGrantedBy`. Refuse when any uid appears in both sets. New **403** code: `partners_shared_provisioning_ancestor`. One-hop, tenure, and ancestor-of codes unchanged.
- **`functions/src/retention/ops.ts`:** Comment documents FA-F42-R1-006-003; approval path still calls `refusePartnerLineage` inside the transaction.
- **Rejected alternative:** Risk-accept only (no code change) — does not meet R26 two-independent-partners intent.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME escape on `c40ebec6`: P→Q+R siblings, 40d tenure, Q requests, R approves | Approval proceeds / no tombstone block from lineage |
| RED | Issue #30 FA-F42-R1-006-003 | Sibling-account bypass of two-partner rule |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-006-003` | Q requests, R approves → **403** `partners_shared_provisioning_ancestor`; independent P/Q control approves |
| GREEN | Same file — `FA-F42-R1-006` / `FA-F42-R1-006-001` | Puppet, promotion, tenure, chain, and control cases still pass |
| GREEN | `functions/test/f42-retention.units.test.ts` — `FA-F42-R1-006-003` | Siblings refused; independent roots allowed; P→Q→R chain still `approver_lineage_of_requester` |

## Focused verification

```bash
npm --prefix functions test -- --run f42-retention.units.test.ts -t 'FA-F42-R1-006-003'

npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r6003 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-006-003'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (shared provisioning ancestor on deletion approval; FU-7 platform countersign still not built) |
