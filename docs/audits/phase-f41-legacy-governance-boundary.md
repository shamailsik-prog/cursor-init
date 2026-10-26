# Phase audit — F41 legacy governance product boundary

Finding **F41** (issue #30): frozen governance chains (ops-reporting, filings
lattice, operator console, duplicated `workflowOps*Governance.ts` adapters)
overwhelmed active Legal OS boundaries — large monoliths and mirror tests still
consumed review and CI attention while `LEGACY_GOVERNANCE_CHAINS` stays off.

## RED / GREEN (ledger)

| State | Evidence | Result |
| --- | --- | --- |
| RED | `7c23e3cf` (main after PR #146 / F40): no line or adapter cap; CodeQL scanned only one path-too-long adapter; active routes had no enforced import barrier against governance adapters | Measured monoliths: ops-reporting **32,900** lines, filings **19,082**, operator console **7,338**; **45** `workflowOps*Governance.ts` files |
| GREEN | PR #147: `platform/boundaries/legacyGovernanceQuarantine.json` + G-0 check [23] `check_legacy_governance_boundary.py` (growth cap + active-product import barrier; flag default off) | See FA-F41-001 for CodeQL scope |

### FA-F41-001 [HIGH] — CodeQL must not drop live firm-data handlers

| State | Evidence | Result |
| --- | --- | --- |
| RED | PR #147 @ `0ac8d9e3`–`4b5e91d5`: `.github/codeql/codeql-config.yml` ignored `app/api/d4/filings`, ops-reporting, operator console, and all `workflowOps*Governance.ts` adapters | Filings core (`create_package` / `decide_package` / package list) and spine-linked adapters left unscanned vs base (`7c23e3cf`, one filename only) |
| GREEN | Same PR after FA-F41-001 fix: broad `paths-ignore` reverted; only the single trap-path-limit adapter excluded (same as base) | CodeQL (javascript-typescript) PASS on CI; G-0 check [23] unchanged |

## Scope note

This does **not** delete frozen chains or collapse the spine types (that needs
owner authorization per E-24). It **quarantines** growth and blocks new coupling
from active product trees into governance adapters, and documents the boundary in
machine-readable form. Consolidation to a single lifecycle engine remains future
work.

| Claim | Value |
| --- | --- |
| OR-1..OR-4 | unchanged |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
