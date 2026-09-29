#!/usr/bin/env bash
# Canonical TB ack-recon lattice focused ops vitest bundle (38 files, no -t filter).
# Ledger: docs/audits/lattice-focused-ops-vitest-bundle.md
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FILES=(
  tests/persistence.route-wiring.test.ts
  tests/api.ops-reporting.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-outbound-registry-attestation-ledger-505-506-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-503-504-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-501-502-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-499-500-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-497-498-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-495-496-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-outbound-registry-attestation-ledger-493-494-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-external-distribution-audit-ledger-frontend-real.test.ts
  tests/ops.pr-tb-outbound-registry-seal-transport-boundary-reconciliation-frontend-real.test.ts
  tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-frontend-real.test.ts
  tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-reconciliation-frontend-real.test.ts
  tests/ops.pr-tb-outbound-registry-attestation-ledger-frontend-real.test.ts
  tests/ops.pr-tb-partner-delivery-freeze-override-seal-frontend-real.test.ts
  tests/ops.pr-205-tb-transport-boundary-receipt-reconciliation-frontend-real.test.ts
  tests/ops.pr-206-tb-external-transport-receipt-ack-frontend-real.test.ts
  tests/ops.pr-213-tb-external-transport-receipt-ack-reconciliation-frontend-real.test.ts
  tests/ops.pr-217-tb-external-distribution-audit-ledger-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-partner-delivery-507-508-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-509-510-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-511-512-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-513-514-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-515-516-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-outbound-registry-attestation-ledger-517-518-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-partner-delivery-519-520-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-521-522-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-523-524-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-525-526-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-527-528-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-529-530-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-531-532-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-533-534-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-535-536-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-537-538-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-539-540-frontend-real.test.ts
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-541-542-frontend-real.test.ts
)

if [[ "${#FILES[@]}" -ne 38 ]]; then
  echo "focused lattice ops bundle: expected 38 files, got ${#FILES[@]}" >&2
  exit 1
fi

exec npx vitest run "${FILES[@]}"
