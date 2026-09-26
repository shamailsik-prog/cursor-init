# Independent Phase Auditor A–F audit: PR #244 TB ack-recon PD freeze seal TB receipt recon GET 497–498

> **Verdict (2026-09-26): PASS — 0 blockers, 0 majors, 3 minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: [#244](https://cursor.com/codebase/shamail-sikander/cursor-init/pull/244) (closed / squash-landed)  
Audited landed tip: `3c7c6073c73f68ccad860e07b7fe967dd1e5dab8`  
Parent before land: `9265559c3d9f9debf9fdb6a0fac399995443fa19` (PR #239 lattice)  
Docs anchor on `main`: `a4f18646cb3c7de915a383b7b4147f6546b463bf` (PR #242 independent #239 audit)  
Pre-squash PR branch tip (forge metadata): `3b21bb73128798325d55cb1efd3fd3ffbf05bab8`

Evidence log: `/opt/cursor/artifacts/pr244_verification.log`

## Executive finding

Squash `3c7c607` extends the TB ack-recon lattice with GET **497–498** transport-boundary receipt
reconciliation views parented on finalized **495/496** seal-verification rows, six lifecycle POSTs,
deny-by-default persistence for both new repository keys, and `/ops` call sites after the **495/496**
block. `parseView` remains identity-only through **498**; **485–496** handlers and `it.each` identity
cases are intact. Focused vitest replay matches CM counts (**15 files, 181 passed, 0 skipped**).
`transport_stub=true` caps product at **PARTIAL**; roadmap and PR labels do not claim COMPLETE.

## A. Scope, acceptance, and labels — PASS (with minor metadata)

| Source | Claim | Independent result |
|---|---|---|
| `docs/LEGAL_OS_ROADMAP.md` slice `cursor/tb-ack-recon-pd-freeze-seal-tb-recon-497-498-872c` | GET **497–498**, six POSTs, `backend_real` / `frontend_real` / `transport_stub` / **PARTIAL** | **PASS** — matches landed diff |
| PR #244 body | `route.ts` 34,395 → 35,047 | **PASS** — `9265559` → `3c7c607`: **34,395 → 35,047** (+652) |
| PR #244 body | `classification=PARTIAL`, never COMPLETE while `transport_stub=true` | **PASS** |
| PR #244 body | `check_pr_phase_claims.py` BASE=9265559 HEAD=**3b21bb7** | **Minor** — squash tip is **`3c7c607`**; branch head ref not fetchable post-squash |
| PR #244 body | Claim-gate PASS | **Minor** — auditor replay with landed `HEAD=3c7c607` **FAIL** (missing `action -> app/ops/...` and `/api/...` evidence strings in body); see §E |

## B. Lattice integrity — PASS

| Artifact | Before (`9265559`) | After (`3c7c607`) | Δ |
|---|---:|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 34,395 | 35,047 | +652 |
| `app/ops/operator-audit-console.tsx` | 4,887 | 5,019 | +132 |

- Squash diff (`9265559..3c7c607`): 13 files, +1,549 / −1; no deletions inside TB lattice GET/POST blocks.
- GET **497** / **498** handlers at `route.ts` **L11899** / **L11934**, after **495** (**L11829**) and **496** (**L11864**).
- POST block comment at **L34541**; **6** `parsed.action` handlers at **L34543, L34623, L34697, L34778, L34864, L34948**.
- `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS` lists slices **485–498** (14 entries); `it.each` asserts `json.view === requestedView` (`tests/persistence.route-wiring.test.ts` **L6396–L6479**).
- `/ops`: `readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice` adds GET **497–498** and **6/6** POST `runApiCallAllowingStatuses` entries after **495/496** control POSTs (**L4573–L4703**); ordering test in `tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-497-498-frontend-real.test.ts`.

## C. `parseView` and dispatch — PASS

- Read **entire** `parseView` (**L544–L823**, 280 lines). Every branch returns `"activity"`, `value`, or `undefined` only.
- Child views **497/498** have dedicated branches (**L815–L818**) after **495/496** (**L809–L814**); no parent shadowing.
- Regression: `it("ops reporting parseView identity: GET 492/493/494/495/496/497/498…")` at `persistence.route-wiring.test.ts` **L6514+**.

## D. Persistence — PASS

- Governance: `platform/persistence/workflowOpsAckReconTbSealVerificationsOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationGovernance.ts` (PR slice **497–498** header).
- Deny-by-default binder entries for **497** and **498** repo keys at `denyByDefaultWorkflowOpsRepository.ts` **L30–L33**.
- `firestoreSpineRepositories.ts` + `spineRepositories.ts` wire memory/Firestore adapters; `firestore.rules` adds deny-write collections (**L222–L223** in squash diff).
- `npm run test:rules`: **22/22** (3 files). Inherited **#205** `persistence.repositories` round-trip: **not regressed**.

## E. Tests and gates — PASS (with minors)

| Command | Result |
|---|---|
| Focused vitest (15 files, **no** `-t` filter) | **15 files, 181 passed, 0 skipped** |
| `npm run test:rules` | **3 files, 22 passed** |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10** |
| `npx vitest run tests/pr-phase-claim-gate.test.ts` | **20/20** (1 Vitest worker `onTaskUpdate` timeout logged; tests green) |
| `check_pr_phase_claims.py` `BASE_SHA=9265559`, `HEAD_SHA=3c7c607`, PR #244 description | **FAIL** — missing `/ops` call-site arrow evidence and `/api/...` path in PR metadata |
| `check_pr_phase_claims.py` `HEAD_SHA=3b21bb7` | **SKIP** — ref absent after squash |

**Focused vitest file list (auditor replay):**

`tests/persistence.route-wiring.test.ts`, `tests/api.ops-reporting.test.ts`,
`tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-recon-497-498-frontend-real.test.ts`,
`tests/ops.pr-tb-ack-recon-pd-freeze-seal-495-496-frontend-real.test.ts`,
`tests/ops.pr-tb-ack-recon-outbound-registry-attestation-ledger-493-494-frontend-real.test.ts`,
`tests/ops.pr-tb-ack-recon-external-distribution-audit-ledger-frontend-real.test.ts`,
`tests/ops.pr-tb-outbound-registry-seal-transport-boundary-reconciliation-frontend-real.test.ts`,
`tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-frontend-real.test.ts`,
`tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-reconciliation-frontend-real.test.ts`,
`tests/ops.pr-tb-outbound-registry-attestation-ledger-frontend-real.test.ts`,
`tests/ops.pr-tb-partner-delivery-freeze-override-seal-frontend-real.test.ts`,
`tests/ops.pr-205-tb-transport-boundary-receipt-reconciliation-frontend-real.test.ts`,
`tests/ops.pr-206-tb-external-transport-receipt-ack-frontend-real.test.ts`,
`tests/ops.pr-213-tb-external-transport-receipt-ack-reconciliation-frontend-real.test.ts`,
`tests/ops.pr-217-tb-external-distribution-audit-ledger-frontend-real.test.ts`

## F. `frontend_real` — PASS

- GET `/api/d2/ops-reporting` with `view` query for **497** / **498** at `operator-audit-console.tsx` **L4578–L4605** (`path: "/api/d2/ops-reporting"`).
- Six POST actions on same path **L4606–L4703**; transport honesty via `blocked_todo_firm:transport_stub_*:ops_probe` only.

## Findings summary

| ID | Severity | Finding |
|---|---|---|
| PR244-M1 | **minor** | Closed PR body cites branch HEAD `3b21bb7`; squash on `main` is `3c7c607`. |
| PR244-M2 | **minor** | `check_pr_phase_claims.py` replay **FAIL** on PR #244 description (metadata format); landed code and labels are otherwise honest. |
| PR244-M3 | **minor** | `pr-phase-claim-gate.test.ts` run logs unhandled Vitest worker timeout; all 20 tests passed. |

## Final classification

| Dimension | Verdict |
|---|---|
| **Phase audit** | **PASS** (0 blockers, 0 majors, 3 minors) |
| **Product** | **PARTIAL** (`transport_stub=true`; COMPLETE invalid) |
| `backend_real` | **PASS** (scoped) |
| `frontend_real` | **PASS** |
| `transport_stub` | **PASS** (honest) |

---

## Auditor replay commands

```bash
git rev-parse 3c7c6073c73f68ccad860e07b7fe967dd1e5dab8 9265559c3d9f9debf9fdb6a0fac399995443fa19
wc -l app/api/d2/ops-reporting/route.ts
git show 9265559:app/api/d2/ops-reporting/route.ts | wc -l

npx vitest run tests/persistence.route-wiring.test.ts tests/api.ops-reporting.test.ts \
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
