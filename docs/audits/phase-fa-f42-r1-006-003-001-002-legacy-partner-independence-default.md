# FA-F42-R1-006-003-001-002 — Legacy partner independence default

**Finding (ME REAUDIT_PR163 PASS 9.6):** Partners with no `independentPartner`, no `createdBy`, and no `partnerGrantedBy` were treated as independent via the missing-flag branch in `isIndependentPartner` (`return !provisioned`). Pre-#163 `createFirmUser` rows without creator metadata could therefore sit on the deletion register without attestation.

**Parent:** [006-003-001 independent-partner register](./phase-fa-f42-r1-006-003-001-independent-partner.md)

**Remediation:**

| Layer | Change |
| --- | --- |
| Runtime | `isIndependentPartner` returns true only when `independentPartner === true` (fail closed on absent/false). |
| Backfill | `planLegacyPartnerIndependenceBackfill` / `backfillLegacyPartnerIndependence` stamp explicit flags on partners still missing the field: `true` for bootstrap founder or `partnerAttestedBy`; otherwise `false`. Cursor: `system/partnerIndependenceBackfill`. |
| Operator | `npm --prefix functions run partner-independence:backfill` (re-run until `complete=true`). |

## Tests

| Case | Location | Expected |
| --- | --- | --- |
| Bare legacy partner doc | `f42-retention.units.test.ts` | `isIndependentPartner` → false |
| Backfill plan | `legacy-partner-independence-backfill.unit.test.ts` | Founder / attested → true; ambiguous legacy → false; explicit post-#163 rows skipped |
| Emulator | `f42-r1-followup.e2e.emu.test.ts` — `006-003-001-002` | Backfill writes `independentPartner: false` on legacy hire; founder true |

Post-#163 `createFirmUser` partners (`independentPartner: false` + creator) unchanged.
