# FA-F42-R1-006-003-001-001 — Sole independent attestation of provisioned partners

**Finding:** A sole independent partner could call `attestIndependentPartner` on partners they provisioned (`createdBy` / `partnerGrantedBy`) with only a generic allow audit (`ok`), so ME could not score the owner design-accept path for attestation puppets separately from deletion refusal (006-003-001).

**Remediation (design-accept):** Shipped retention policy declares `deletion.allowSoleIndependentAttestationOfProvisionedPartners: true`. While the firm has no other independent partner, attesting a directly provisioned target either:

- **Refuses** when the flag is `false` (`403 attestation_sole_independent_provisioned_refused`, deny audit same reason), or
- **Allows** when `true` with allow audit reason `sole_independent_attested_provisioned_partner` (not `ok`).

Deletion approval is unchanged: direct provisioning and `partnerAttestedBy` links still refuse (006-003-001).

## Policy and codes

| Field | Location | Meaning |
| --- | --- | --- |
| `allowSoleIndependentAttestationOfProvisionedPartners` | `infra/retention/policy.json` → `deletion` | Declarative owner accept for sole-independent provisioned attestation |

| HTTP / audit reason | When |
| --- | --- |
| `attestation_sole_independent_provisioned_refused` | Sole independent + provisioned target + policy `false` |
| `sole_independent_attested_provisioned_partner` | Sole independent + provisioned target + policy `true` (allow) |
| `ok` | Attestation allow when the sole-provisioned rule does not apply |

Route unchanged: `POST /api/platform/identity/attestIndependentPartner`.

## Tests

| Case | Location | Expected |
| --- | --- | --- |
| Units | `f42-retention.units.test.ts` — `006-003-001-001` | Decision helper + policy validation |
| **GREEN** | `f42-r1-followup.e2e.emu.test.ts` — declarative audit | Allow + audit `sole_independent_attested_provisioned_partner` |
| **RED** | Same file — policy `false` | `403 attestation_sole_independent_provisioned_refused` + deny audit; user stays dependent |
