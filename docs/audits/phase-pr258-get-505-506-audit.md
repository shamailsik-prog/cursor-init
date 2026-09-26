# Independent Phase Auditor A–F audit: PR #258 TB ack-recon PD freeze seal outbound registry attestation ledger GET 505–506

> **Verdict (2026-09-26): PASS — 0 blockers, 0 majors, 4 minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: [#258](https://cursor.com/codebase/shamail-sikander/cursor-init/pull/258) (squash-landed)  
Audited landed tip: `dce3a5861081e4606ec3f0a2a72a22f0f7c1d35a`  
Squash first parent: `5296b8932045f72cbcfb9272baf96db321c8aa1f` (docs PR #256 — independent PR #255 audit)  
Forge PR branch tip: `29ac75e3d90781ee64269e585799b88bfbe26e00` (fetched; tree identical to squash `dce3a58`).

Evidence log: `/opt/cursor/artifacts/pr258_verification.log`

## Executive finding

Squash `dce3a58` is **code-only** (5 files, +1,011 / −1), extends the TB ack-recon lattice with GET **505–506** on **503/504** parents (same step pattern as **493–494** after **491–492**), six lifecycle POSTs parented on finalized **503/504** rows, governance re-exports (+8 lines) in the long-named `…Governance.ts` module, and `/ops` call sites after the **503/504** block. `parseView` remains identity-only through **506** (automated scan: 0 non-identity view remaps; inherited `activity` default at L573). Lattice `it.each` covers **485–506** (22 slices, ordered). Dedicated repository wiring `it()` for **505** and **506** assert `outboundRegistryAttestationLedgerStatus` (not status-only HTTP). Focused vitest replay (full lattice file set, no `-t` filter): **19 files, 203 passed, 0 skipped**. `transport_stub=true` caps product at **PARTIAL**. `check_pr_phase_claims.py` replay on PR #258 body with `BASE=5296b89`, `HEAD=dce3a58` and `HEAD=29ac75e` both **PASS**.

## A. Landing order and squash scope — PASS

`git rev-parse dce3a58^` → `5296b8932045f72cbcfb9272baf96db321c8aa1f` (matches builder claim; docs #256 / #255 audit landing).

| Check | Result |
|---|---|
| #256 docs before #258 product | **PASS** — `5296b89` is direct parent of `dce3a58` |
| Squash diff code-only | **PASS** — no `docs/` paths in `5296b89..dce3a58` |
| Changed files | 5 (route, console, governance re-export, 2 test files) |

## B. Lattice integrity — PASS

| Artifact | @ `5296b89` (pre-squash) | @ `dce3a58` | Δ |
|---|---:|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 37,134 | 37,873 | +739 |
| `app/ops/operator-audit-console.tsx` | 5,406 | 5,533 | +127 |

- GET **505** handler: `route.ts` **L12731–L12764** (after **504** block ending **L12729**).
- GET **506** handler: `route.ts` **L12768+** (immediately after **505**).
- POST block comment **L36918**; six **505/506** action bodies **L36919+** (checkpoint/digest/control × custody + closure).
- `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS`: slices **485–506** (22 entries, ordered; none missing).
- Prior GET slices through **504** remain in `parseView` and dispatch; no truncation observed.

## C. `parseView` and dispatch — PASS

- `parseView` body: **L572–L878**; automated scan: **0** non-identity `if (value === …) return …` branches for TB views; inherited `activity` remap **L573** only.
- New identity branches for **505/506** at **L863–L873** (after **503/504** at **L860–L871**).
- `it.each` lattice asserts `json.view === requestedView` for **485–506** (`tests/persistence.route-wiring.test.ts` **L6448–L6572**).
- Dedicated regression: `it("ops reporting parseView identity: GET 492/…")` includes **505/506** (**L6620–L6727**).
- Dedicated wiring: view **(505)** **L6773–L6788** (`outboundRegistryAttestationLedgerStatus`); view **(506)** **L6791–L6806** (closure ledger status field).

## D. Persistence — PASS

GET **505** reads `repos.workflowOpsAlertWaiverExpiry…OutboundRegistryAttestationLedgers` (**`firestoreSpineRepositories.ts` L3042–L3067**; client deny-write **`firestore.rules` L189**).  
GET **506** reads `repos.workflowOpsAlertVariance…PartnerHandoffAttestationsOutboundRegistryAttestationLedgers` (**L3575+**; **`firestore.rules` L202**).  
This slice **reuses** outbound-registry attestation ledger collections from earlier lattice steps (**493–494**); squash adds **no** new `createDenyByDefaultWorkflowOpsRepository` binder lines or `firestore.rules` diff (unlike #255’s +2 rules).  
Firestore emulator trio: **22/22** (`persistence.repositories` round-trip **PASS**; no new `ReferenceError` introduced). Inherited #205 spine noise not re-opened this pass.

## E. Tests and gates — PASS (with minor)

| Command | Result |
|---|---|
| Focused vitest (19 files, **no** `-t` filter) | **19 files, 203 passed, 0 skipped** |
| `npm run test:rules` | **3 files, 22 passed** |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10** |
| `npx vitest run tests/pr-phase-claim-gate.test.ts` | **20/20** (1 Vitest worker `onTaskUpdate` timeout logged; tests green) |
| `check_pr_phase_claims.py` `BASE_SHA=5296b89`, `HEAD_SHA=dce3a58`, PR #258 description | **PASS** |
| `check_pr_phase_claims.py` `HEAD_SHA=29ac75e` | **PASS** (identical tree to `dce3a58`) |

**Test-file reconciliation vs PR #255 auditor replay (18 files / 197 passed):**

| Metric | PR #255 auditor replay | PR #258 auditor replay | Δ |
|---|---:|---:|---|
| Vitest files | 18 | 19 | +1 `tests/ops.pr-tb-ack-recon-pd-freeze-seal-outbound-registry-attestation-ledger-505-506-frontend-real.test.ts` |
| Vitest tests | 197 | 203 | +6 (2 frontend-real + 2 `it.each` slices + parseView/wiring cases) |

No focused lattice file from #255 was dropped.

## F. `frontend_real` — PASS

| Step | File:line | Path |
|---|---|---|
| View vars **505/506** | `operator-audit-console.tsx` **L5091–L5094** | (constants) |
| GET view **505** | **L5096–L5109** | `runApiCall` → `GET /api/d2/ops-reporting` |
| GET view **506** | **L5110–L5123** | `runApiCall` → `GET /api/d2/ops-reporting` |
| POST checkpoint custody (**505**) | **L5124–L5138** | `runApiCallAllowingStatuses` → `POST /api/d2/ops-reporting` |
| POST digest custody freeze override | **L5140–L5154** | same |
| POST control custody seal | **L5156–L5168** | same |
| POST checkpoint closure (**506**) | **L5170–L5184** | same |
| POST digest closure freeze override | **L5186–L5200** | same |
| POST control closure seal | **L5202–L5215** | same |

Checkpoint/digest bodies use honest `blocked_todo_firm:transport_stub_tb_ack_recon_pd_freeze_seal_*:ops_probe` strings — consistent with `transport_stub=true`, not API-only scaffolds.

Static ordering test: `tests/ops.pr-tb-ack-recon-pd-freeze-seal-outbound-registry-attestation-ledger-505-506-frontend-real.test.ts`.

## Findings summary

| ID | Severity | Finding |
|---|---|---|
| PR258-M1 | **minor** | Pre-audit `origin/main` ref in clone lagged at `959cb21` until `git fetch`; landed tip is `dce3a58`. |
| PR258-M2 | **minor** | `pr-phase-claim-gate.test.ts` logs unhandled Vitest worker timeout; all 20 tests passed. |
| PR258-M3 | **minor** | `transport_stub=true` — product remains PARTIAL (accepted policy). |
| PR258-M4 | **minor** | No new `firestore.rules` / deny-binder diff in squash — intentional reuse of **493–494** ledger collections. |

## Final classification

| Dimension | Verdict |
|---|---|
| **Phase audit** | **PASS** (0 blockers, 0 majors, 4 minors) |
| **Product** | **PARTIAL** (`transport_stub=true`; COMPLETE invalid) |
| `backend_real` | **PASS** (scoped) |
| `frontend_real` | **PASS** |
| `transport_stub` | **PASS** (honest) |

## Auditor replay commands

```bash
git rev-parse dce3a58^ HEAD
git diff --stat 5296b89..dce3a58

export PR_TITLE='TB ack-recon PD freeze seal outbound registry attestation ledger GET 505-506 #258'
export PR_BODY="$(origin pr view 258 | sed -n '/^## Summary/,$p')"
export BASE_SHA=5296b8932045f72cbcfb9272baf96db321c8aa1f
export HEAD_SHA=dce3a5861081e4606ec3f0a2a72a22f0f7c1d35a
python3 ci_gates/check_pr_phase_claims.py

npx vitest run tests/persistence.route-wiring.test.ts tests/api.ops-reporting.test.ts \
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-outbound-registry-attestation-ledger-505-506-frontend-real.test.ts \
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-503-504-frontend-real.test.ts \
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-501-502-frontend-real.test.ts \
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-499-500-frontend-real.test.ts \
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-497-498-frontend-real.test.ts \
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-495-496-frontend-real.test.ts \
  tests/ops.pr-tb-ack-recon-outbound-registry-attestation-ledger-493-494-frontend-real.test.ts \
  tests/ops.pr-tb-ack-recon-external-distribution-audit-ledger-frontend-real.test.ts \
  tests/ops.pr-tb-outbound-registry-seal-transport-boundary-reconciliation-frontend-real.test.ts \
  tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-frontend-real.test.ts \
  tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-reconciliation-frontend-real.test.ts \
  tests/ops.pr-tb-outbound-registry-attestation-ledger-frontend-real.test.ts \
  tests/ops.pr-tb-partner-delivery-freeze-override-seal-frontend-real.test.ts \
  tests/ops.pr-205-tb-transport-boundary-receipt-reconciliation-frontend-real.test.ts \
  tests/ops.pr-206-tb-external-transport-receipt-ack-frontend-real.test.ts \
  tests/ops.pr-213-tb-external-transport-receipt-ack-reconciliation-frontend-real.test.ts \
  tests/ops.pr-217-tb-external-distribution-audit-ledger-frontend-real.test.ts

npm run test:rules && npm run gate:g0 && npm run gate:g1
npx vitest run tests/pr-phase-claim-gate.test.ts
```
