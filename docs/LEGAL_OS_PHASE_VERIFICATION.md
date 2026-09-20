# Legal OS phase verification status (audited sample: PR #34-#73 selected batches)

Last updated: 2026-09-20  
Primary source: `docs/audits/phase-reaudit-70-73-after-stream1.md`.

## Executive verdict

No audited sample phase qualifies as **DONE product**.

- `backend_real`: PASS across sampled batches (#34-#37, #38-#47, #48-#59, #60-#69, #70-#73).
- `frontend_real`: mixed; #34-#37 and #70-#73 pass via `/ops`; Batch D/E/F widened-scope lanes remain partial because `runApiCallAllowingStatuses` is referenced but not defined in `/ops` action-lattice paths.
- `transport_stub`: still true because filing transport remains `TODO(firm)` + `_stub` + `blocked_todo_firm`.

Because `transport_stub=true`, final status remains **PARTIAL** for all sampled phases.

## Label-based summary (required on every closure claim)

| PR | Claimed phase | Claimed merge SHA | Landed on `main` | backend_real | frontend_real | transport_stub | Final classification | Severity |
|---|---|---|---|---|---|---|---|---|
| #34 | Firestore-backed runtime mode switch | `27d594f` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #35 | Firestore write-path parity (documents/filings/workflow) | `3a60438` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #36 | Workflow timeline + OCR job persistence | `aebefbb` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #37 | Drafts + Court Ops persistence | `45cacaf` | Yes | PASS | PASS (`/ops`) | true | PARTIAL | major |
| #70 | Debt-burndown forecasting + expiry attestation | `0e2d397` | Yes | PASS | PASS (`/ops` phase actions/views wired) | true | PARTIAL | major |
| #71 | Burndown recalibration + attestation queue orchestration | `ca564d8` | Yes | PASS | PASS (`/ops` phase actions/views wired) | true | PARTIAL | major |
| #72 | Burndown settlement + queue drain | `65b1615` | Yes | PASS | PASS (`/ops` phase actions/views wired) | true | PARTIAL | major |
| #73 | Settlement attestation + queue drain reconciliation | `3a1812c` | Yes | PASS | PASS (`/ops` phase actions/views wired) | true | PARTIAL | major |

## Re-audit correction + current lane update (independent, 2026-09-20)

- Stream 1 remediation lanes are landed on `main`:
  - PR #79 tip `4158eea61a3b`
  - PR #86 tip `f8e8e9321e72`
  - PR #88 tip `fbeba2c0de41`
  - PR #90 tip `835578cb3742`
  - PR #92 tip `453d7929fcb9`
- #70-#73 now satisfy frontend call-site requirements in `/ops` with phase-specific actions + views.
- Widened-scope follow-up found a blocker for Batch D/E/F action lattices (including Batch D follow-up PR #92): `/ops` references `runApiCallAllowingStatuses` repeatedly but no definition exists in `app/ops/operator-audit-console.tsx`, so those lanes remain partial pending fix.
- COMPLETE claim hard-fail remains enforced while transport stubs exist via:
  - `ci_gates/check_pr_phase_claims.py`
  - `.github/workflows/pr-phase-claim-gate.yml`

## Blocking conditions for DONE classification

1. **Transport placeholder remains active**
   - `platform/persistence/filingDispatchQueue.ts` still carries `TODO(firm)` for external transport.
   - `_stub` channels and `blocked_todo_firm` remain in filing operational models.
2. **Claim hygiene must stay machine-enforced**
   - "scaffold-only" narrative is invalid when route/tests changed.
   - "COMPLETE/product-done" is invalid while filing transport stubs remain.

## Required gate behavior (hard fail)

The repository now includes a lightweight PR metadata gate:

- Script: `ci_gates/check_pr_phase_claims.py`
- Workflow: `.github/workflows/pr-phase-claim-gate.yml`

The gate fails when either condition is true:

1. PR metadata claims scaffold/docs-only or no runtime changes while `app/api/**` or `tests/**` changed.
2. PR metadata claims `COMPLETE`/`product-done` while transport stubs still exist.

## Verification checklist for future COMPLETE claims

1. **Merge/SHA integrity**
   - Confirm PR is merged.
   - Confirm claimed SHA is on `main`.
2. **Backend reality**
   - Inspect merge diff for route actions/views, repository wiring, Firestore rules, and tests.
3. **Runtime evidence**
   - Run focused route tests + persistence suites + `gate_g0` + `gate_g1`.
4. **Frontend reality**
   - Verify a user-facing TSX path executes the touched APIs (minimum `/ops` route or richer product UI).
   - Capture walkthrough evidence.
5. **Transport-stub policy**
   - Scan for `TODO(firm)`, `_stub`, and `blocked_todo_firm` in filing transport paths.
   - If any remain, classification is capped at PARTIAL and COMPLETE/product-done claims must fail.
6. **PR metadata gate**
   - Ensure `ci_gates/check_pr_phase_claims.py` passes before merge.
7. **Audit publication**
   - Publish verdict, evidence paths, command list, failed checks, and remediation.

## Batch E ledger — PR #48-#59 (independent audit)

- Audit file: `docs/audits/phase-sample-48-59-findings.md`
- Verdict: **NOT COMPLETE / PARTIAL only**
- Date: 2026-09-20

### Blocking findings

1. Auditor baseline found `FRONTEND_REAL` not met for this batch (audited merge diffs had no corresponding product UI coverage for these capabilities).
2. Filing transport across `#49-#53` remains explicit stub/TODO(firm) boundary (`_stub` channels, `blocked_todo_firm`, `todo_firm_external_transport_blocked`), so transport realism is incomplete and must stay fail-closed.

### DoD summary

- `SHA on main`: PASS (`#48-#59` confirmed on `main` by audit).
- `BACKEND_REAL`: PASS/PARTIAL (transport-related items are internal parity only while external transport remains blocked).
- `FRONTEND_REAL`: PARTIAL (call-site lane landed, but action execution is blocked by undefined `runApiCallAllowingStatuses` in `/ops`).
- `stubs policy`: PASS (explicit and fail-closed).

## Batch D ledger — PR #38-#47 (independent audit)

- Audit file: `docs/audits/phase-sample-38-47-findings.md`
- Verdict: **PARTIAL** (major overall; blockers present on filing-linked items)
- Date: 2026-09-20

### DoD summary

- `SHA on main`: PASS (`#38-#47` confirmed on `main` by audit).
- `BACKEND_REAL`: PASS across sampled claims.
- `FRONTEND_REAL`: PARTIAL (view coverage is present, but action lane is blocked by undefined `runApiCallAllowingStatuses` in `/ops`).
- `stubs policy`: filing-linked slices remain capped by explicit transport stubs (`TODO(firm)`, `_stub`, `blocked_todo_firm`).

### PR matrix (Batch D)

| PR | Claimed phase | Claimed merge SHA | Landed on `main` | backend_real | frontend_real | transport_stub | Final classification | Severity |
|---|---|---|---|---|---|---|---|---|
| #38 | Follow-up source persistence | `f78abce` | Yes | PASS | PARTIAL (action path wired but blocked by missing helper in `/ops`) | true | PARTIAL | major |
| #39 | Membership persistence | `f93ec73` | Yes | PASS | PASS (`/ops` route family) | true | PARTIAL | blocker |
| #40 | Tenancy membership | `2a411b5` | Yes | PASS | PARTIAL (`/api/p5/tenancy` reads wired; action lane blocked by missing helper) | true | PARTIAL | major |
| #41 | Tenancy audit | `e0ee204` | Yes | PASS | PARTIAL (`/api/p5/tenancy` audit read wired; action lane blocked by missing helper) | true | PARTIAL | major |
| #42 | Entity/client persistence | `b895247` | Yes | PASS | PARTIAL (`/api/d1/clients` call sites wired; create/conflict actions blocked by missing helper) | true | PARTIAL | major |
| #43 | Audit write-through non-tenancy | `9ed9195` | Yes | PASS | PARTIAL (affected action lane blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #44 | Committee-brain output persistence | `a48f868` | Yes | PASS | PARTIAL (write path in batch action lane blocked by missing helper; list read is wired) | true | PARTIAL | major |
| #45 | Matter/client reporting + search index | `2d2d0a8` | Yes | PASS | PARTIAL (reporting read wired; related action lane blocked by missing helper) | true | PARTIAL | major |
| #46 | Draft template analytics | `b896b60` | Yes | PASS | PASS (`/ops` templates + compose + drafts views) | true | PARTIAL | major |
| #47 | Workflow ops reporting | `be269a9` | Yes | PASS | PARTIAL (`/api/d2/ops-reporting` read wired; batch action lane helper gap remains) | true | PARTIAL | major |

## Batch F ledger — PR #60-#69 (independent audit)

- Audit file: `docs/audits/phase-sample-60-69-findings.md`
- Verdict: **PARTIAL (blocker severity)** for COMPLETE-product classification
- Date: 2026-09-20

### Blocking findings

1. Follow-up `/ops` lattice wiring landed, but `FRONTEND_REAL` remains partial because the lattice helper `runApiCallAllowingStatuses` is undefined.
2. `transport_stub` remains true (`TODO(firm)`, `_stub`, `blocked_todo_firm`) so COMPLETE/product-done remains fail-closed.
3. Metadata-to-implementation drift appears in #66-#69 claim text vs runtime-affecting merged deltas.

### PR matrix (Batch F)

| PR | Claimed phase | Claimed merge SHA | Landed on `main` | backend_real | frontend_real (`/ops`) | transport_stub | Final classification | Severity |
|---|---|---|---|---|---|---|---|---|
| #60 | Remediation expiry + rollover breach watch | `72cc388` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #61 | Remediation lifecycle + reaffirmation SLA | `625ccc5` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #62 | Closure compliance digest + follow-up queue | `ab9cdca` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #63 | Closure SLA windows + auto-assignment | `5b2bd06` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #64 | Closure attestation + SLA exception digest | `5f0651e` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #65 | Attestation dispute + exception expiry enforcement | `8733a06` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #66 | Exception adjudication + enforcement rebalance | `c598fc9` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #67 | Panel quorum + rebalance execution | `1a3dd2c` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #68 | Adjudication SLO + rebalance safeguards | `f563876` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |
| #69 | SLO debt remediation + safeguard expiry | `15254ca` | Yes | PASS | PARTIAL (action lattice blocked by missing helper in `/ops`) | true | PARTIAL | blocker |

