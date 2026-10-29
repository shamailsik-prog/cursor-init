# FA-F42-R1-006-003-001 — Independent-partner register and attestation

**Finding:** Lineage alone cannot distinguish puppets from real hires when every product partner shares the onboarding founder as a provisioning ancestor (PR #162’s blanket shared-ancestor refuse blocked legitimate firms).

**Remediation (this slice):** Server-only `independentPartner` register plus `attestIndependentPartner`; deletion approval also refuses direct `partnerAttestedBy` links (symmetric with `createdBy` / `partnerGrantedBy`). Transitive ancestor-of (#161) and 30-day tenure unchanged. No shared-provisioning-ancestor gate.

## Fields and codes

| Field | Set by | Meaning |
| --- | --- | --- |
| `independentPartner` | `onboardFirm` → `true`; `createFirmUser` partner → `false`; attestation → `true` | Outside-lineage independence for deletion |
| `partnerAttestedBy` | `attestIndependentPartner` | Uid of the independent partner who attested |
| `partnerAttestedAt` | `attestIndependentPartner` | Server timestamp |

| HTTP / approval code | When |
| --- | --- |
| `approver_attested_by_requester` | Approver was attested by requester |
| `requester_attested_by_approver` | Requester was attested by approver |
| `approver_not_independent` | Approver not on register |
| `requester_not_independent` | Requester not on register |
| `attester_not_independent` | Attestation caller not `independentPartner: true` |
| `attestation_sole_independent_provisioned_refused` | Sole independent attesting a partner they provisioned while policy disallows (006-003-001-001) |

Route: `POST /api/platform/identity/attestIndependentPartner` (`identity.attest_independent_partner`). Sole-independent provisioned attestation audit reason when allowed: `sole_independent_attested_provisioned_partner` (see `docs/audits/phase-fa-f42-r1-006-003-001-001-sole-attest-puppet.md`).

## Tests

| Case | Location | Expected |
| --- | --- | --- |
| **RED** | `f42-r1-followup.e2e.emu.test.ts` — sole founder attests one hire, founder requests, hire approves | 403 (`approver_created_by_requester` or `approver_attested_by_requester`); no tombstone |
| **GREEN** | Same file — `onboardFirm` + two `createFirmUser` partners, founder attests both, tenure aged, Q requests, R approves | `in_progress`; tombstone exists |
| Units | `f42-retention.units.test.ts` | Register + attestation link helpers |

## vs PR #162

#162 refused approval when requester and approver shared any provisioning ancestor, which blocked every realistic firm (founder → Q/R). This slice uses **direct** provisioning and attestation edges plus **transitive ancestor-of** (#161), not a common-ancestor blanket.
