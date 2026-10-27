# FA-F42-R1-006-001 — Transitive partner provisioning lineage

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-006-001** (F42 / FA-F42-R1-006 residuals, spec R26)

## Problem (RED baseline)

On main at `ed1bcbb2`, `requireIndependentPartners` in `functions/src/retention/ops.ts` compared only **one hop** of `users/{uid}.createdBy` and `partnerGrantedBy`. A sole founder partner **P** could create **Q**, have **Q** create **R**, backdate **R** past `deletion.approverMinTenureDays` (30 days), request matter deletion, and have **R** approve — satisfying tenure while **R** remains in **P**'s provisioning lineage. ME re-audit probe (issue #30 / PR #160 FAIL 8.0).

Root cause: independence treated as direct edges only, not the transitive provisioning graph toward the firm founder.

## Correction

- **`functions/src/retention/partnerLineage.ts`:** Depth-capped walk (max 32 hops) of `createdBy` and `partnerGrantedBy` from each partner; refuse on cycle or depth overflow (fail closed).
- **`functions/src/retention/ops.ts`:** After existing one-hop checks and tenure rules, `refusePartnerLineage` runs inside the approval transaction with `tx.get` loads. New **403** codes: `approver_lineage_of_requester`, `requester_lineage_of_approver`, `approver_lineage_unknown`, `requester_lineage_unknown`. One-hop codes unchanged.
- **Rejected alternative:** Blocking only `createdBy` chains and ignoring `partnerGrantedBy` transitively (would leave promotion chains open).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME probe P→Q→R + 40d tenure on R | Approval **200** / saga proceeds (main before this fix) |
| RED | Issue #30 FA-F42-R1-006-001 | Two-step chain defeats two-partner rule |
| GREEN | `functions/test/f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-006-001` | P requests, R approves → **403** `approver_lineage_of_requester`; no tombstone |
| GREEN | Same file — `FA-F42-R1-006` | One-hop puppet, promotion, tenure, and control approve cases still pass |
| GREEN | `functions/test/f42-retention.units.test.ts` — `FA-F42-R1-006-001` | Ancestor sets, refuse/allow, cycle → `null` |

## Focused verification

```bash
npm --prefix functions test -- --run f42-retention.units.test.ts -t 'FA-F42-R1-006-001'

npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r6001 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-006-001'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (transitive R26 lineage on deletion approval; FU-7 platform countersign still not built) |
