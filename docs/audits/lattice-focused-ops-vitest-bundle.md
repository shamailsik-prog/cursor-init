# Canonical focused ops vitest bundle (TB ack-recon lattice 485–536)

**Baseline:** **34 files** (independent phase auditor replay; no `-t` filter).

**Runner:** `bash ci_gates/run_focused_lattice_ops_vitest.sh`

## File list (31)

1. `tests/persistence.route-wiring.test.ts`
2. `tests/api.ops-reporting.test.ts`
3. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-outbound-registry-attestation-ledger-505-506-frontend-real.test.ts`
4. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-503-504-frontend-real.test.ts`
5. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-501-502-frontend-real.test.ts`
6. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-499-500-frontend-real.test.ts`
7. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-497-498-frontend-real.test.ts`
8. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-495-496-frontend-real.test.ts`
9. `tests/ops.pr-tb-ack-recon-outbound-registry-attestation-ledger-493-494-frontend-real.test.ts`
10. `tests/ops.pr-tb-ack-recon-external-distribution-audit-ledger-frontend-real.test.ts`
11. `tests/ops.pr-tb-outbound-registry-seal-transport-boundary-reconciliation-frontend-real.test.ts`
12. `tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-frontend-real.test.ts`
13. `tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-reconciliation-frontend-real.test.ts`
14. `tests/ops.pr-tb-outbound-registry-attestation-ledger-frontend-real.test.ts`
15. `tests/ops.pr-tb-partner-delivery-freeze-override-seal-frontend-real.test.ts`
16. `tests/ops.pr-205-tb-transport-boundary-receipt-reconciliation-frontend-real.test.ts`
17. `tests/ops.pr-206-tb-external-transport-receipt-ack-frontend-real.test.ts`
18. `tests/ops.pr-213-tb-external-transport-receipt-ack-reconciliation-frontend-real.test.ts`
19. `tests/ops.pr-217-tb-external-distribution-audit-ledger-frontend-real.test.ts`
20. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-partner-delivery-507-508-frontend-real.test.ts`
21. `tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts`
22. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-509-510-frontend-real.test.ts` (added with PR #271 GET **509–510**)
23. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-511-512-frontend-real.test.ts` (added with PR #277 GET **511–512**)
24. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-513-514-frontend-real.test.ts` (added with PR slice 513–514)
25. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-515-516-frontend-real.test.ts` (added with PR slice 515–516; parents 513/514)
26. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-outbound-registry-attestation-ledger-517-518-frontend-real.test.ts` (PR slice **517–518**; parents 515/516)
27. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-partner-delivery-519-520-frontend-real.test.ts` (PR slice **519–520**; parents 517/518)
28. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-521-522-frontend-real.test.ts` (PR slice **521–522**; parents 519/520)
29. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-523-524-frontend-real.test.ts` (PR slice **523–524**; parents 521/522)
30. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-525-526-frontend-real.test.ts` (PR slice **525–526**; parents 523/524)
31. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-527-528-frontend-real.test.ts` (PR slice **527–528**; parents 525/526)

## History

| Files | Delta |
|---:|---|
| 19 | Through PR #258 GET **505–506** |
| 20 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-partner-delivery-507-508-frontend-real.test.ts` (PR #260) |
| 21 | +`tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts` (PR #266) |
| 22 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-509-510-frontend-real.test.ts` (PR #271) |
| 23 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-511-512-frontend-real.test.ts` (PR #277) |
| 25 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-515-516-frontend-real.test.ts` (PR slice **515–516**) |
| 26 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-outbound-registry-attestation-ledger-517-518-frontend-real.test.ts` (PR slice **517–518**) |
| 27 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-partner-delivery-519-520-frontend-real.test.ts` (PR slice **519–520**) |
| 28 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-521-522-frontend-real.test.ts` (PR slice **521–522**) |
| 29 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-523-524-frontend-real.test.ts` (PR slice **523–524**) |
| 30 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-525-526-frontend-real.test.ts` (PR slice **525–526**) |
| 32 | +`tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-527-528-frontend-real.test.ts` (PR slice **527–528**) |

## Job E — `tests/firestore.rules.test.ts` per-view path variants

Dedicated `_view527` / `_view528` collections mirror `_view515` / `_view516` placement:

- `TB_ACK_RECON_PD_FREEZE_SEAL_DEDICATED_VIEW_COLLECTIONS`: append **527** and **528** full collection paths (duplicate entries per view, same pattern as **515** / **516**).
- `denyWritePaths`: insert **527** and **528** immediately after the **526** dedicated view path (same pattern as PR #298 **525** / **526** fix).

32. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-529-530-frontend-real.test.ts` (PR slice **529–530**; parents 527/528)

Dedicated `_view529` / `_view530` collections mirror `_view527` / `_view528` placement (append **529**/**530** in Job E + denyWritePaths after **528**).

33. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-531-532-frontend-real.test.ts` (PR slice **531–532**; parents 529/530)

Dedicated `_view531` / `_view532` collections mirror `_view529` / `_view530` placement (append **531**/**532** in Job E + denyWritePaths after **530**).

34. `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-535-536-frontend-real.test.ts` (PR slice **535–536**; parents 533/534 outbound registry attestation ledgers)

Dedicated `_view535` / `_view536` collections mirror `_view505` / `_view506` on deeper parents (append **535**/**536** in Job E + denyWritePaths after **532**).
