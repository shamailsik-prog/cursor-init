# FA-F42-R1-006-003-001-001-001 — Sole-independent peer count excludes attester puppets

**Finding (ME REAUDIT_PR218):** After #218 (`006-003-001-001`), `otherIndependentPartnerCount` for `decideSoleIndependentProvisionedAttestation` included partners the attester had already provisioned or attested. Founder F attesting Q then R (F→Q→R) saw R allowed with generic audit `ok` because attested Q counted as another independent partner (`not_applicable`). A later `allowSoleIndependentAttestationOfProvisionedPartners: false` flip did not refuse R on the sole-provisioned path.

**Parent:** [006-003-001-001 sole attestation puppet](./phase-fa-f42-r1-006-003-001-001-sole-attest-puppet.md)

**Remediation:** When counting other active independent partners for the sole-provisioned attestation gate, exclude peers that the attester directly provisioned, attested (`partnerAttestedBy`), or that sit in the attester’s provisioning subtree (`createdBy` / `partnerGrantedBy` lineage). Helpers: `excludeFromOtherIndependentCountForSoleAttestation`, `countOtherIndependentPartnersForSoleProvisionedAttestation` in `functions/src/retention/partnerIndependence.ts`; call site `attestIndependentPartnerOp` in `functions/src/p5/identity.ts`.

Deletion approval (006-003-001) unchanged.

## Tests

| Case | Location | Expected |
| --- | --- | --- |
| Units | `f42-retention.units.test.ts` — `006-003-001-001-001` | Count excludes Q; F→Q descendant R still sole path |
| **GREEN** | `f42-r1-followup.e2e.emu.test.ts` — F→Q→R after Q attested | R allow audit `sole_independent_attested_provisioned_partner`, not `ok` |
| **RED** | Same file — policy true for Q, then false for R | R `403 attestation_sole_independent_provisioned_refused` |

Existing `006-003-001` / `006-003-001-001` cases remain green.

Transitive provisioning targets (e.g. R with `createdBy: Q` under attester F) use the same sole path via `isAttesterProvisionedAttestationTarget`.
