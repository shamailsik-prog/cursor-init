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
| GREEN | PR #147 @ `782f7e60`: broad `paths-ignore` reverted; only the single trap-path-limit adapter excluded (same as `7c23e3cf`) | CI `40332948915`: CodeQL (javascript-typescript) PASS; 16 pass / 0 fail / 4 skip |

### FA-F41-002 [MEDIUM] — Quarantine growth must not bypass via new files / renames / adapter bloat

| State | Evidence | Result |
| --- | --- | --- |
| RED | PR #147 @ `5b05c43b`: G-0 [23] capped only named file `maxLines`; missing listed paths skipped; adapters counted only in `platform/persistence/` top level; no folder totals or adapter line budgets | Re-audit escapes E4 (new 5k-line file under `filings/`), E5/E5b (rename/delete listed monolith), E7 (double adapter size) exited **0** |
| GREEN | PR #147 @ `f83f6570` (FA-F41-002 code @ `7121e0d9`): manifest inventory v2 — `quarantineFolderBudgets`, `listedBudgetPathsMustExist`, recursive adapter `rglob`, `maxGovernanceAdapterTotalLines` / `maxGovernanceAdapterLinesPerFile`; regressions E4/E5b/E7 in `test_check_legacy_governance_boundary.py` | CI `40347849890`: 17 pass / 0 fail / 4 skip |

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
