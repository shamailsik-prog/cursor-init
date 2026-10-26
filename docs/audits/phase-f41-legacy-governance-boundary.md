# Phase audit — F41 legacy governance product boundary

Finding **F41** (issue #30): frozen governance chains (ops-reporting, filings
lattice, operator console, duplicated `workflowOps*Governance.ts` adapters)
overwhelmed active Legal OS boundaries — large monoliths and mirror tests still
consumed review and CI attention while `LEGACY_GOVERNANCE_CHAINS` stays off.

## RED / GREEN (ledger)

| State | Evidence | Result |
| --- | --- | --- |
| RED | `7c23e3cf` (main after PR #146 / F40): no line or adapter cap; CodeQL scanned only one path-too-long adapter; active routes had no enforced import barrier against governance adapters | Measured monoliths: ops-reporting **32,900** lines, filings **19,082**, operator console **7,338**; **45** `workflowOps*Governance.ts` files |
| GREEN | Branch `cursor/f41-legacy-governance-boundary-1d5d`: `platform/boundaries/legacyGovernanceQuarantine.json` + G-0 check [23] `check_legacy_governance_boundary.py`; CodeQL `paths-ignore` for quarantined trees | Local: `python3 ci_gates/check_legacy_governance_boundary.py` PASS; `python3 ci_gates/test_check_legacy_governance_boundary.py` PASS |

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
