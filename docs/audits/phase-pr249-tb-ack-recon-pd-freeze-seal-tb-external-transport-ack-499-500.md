# Independent Phase Auditor A–F audit: PR #249 TB ack-recon PD freeze seal external transport receipt ack GET 499–500

> **Verdict (2026-09-26): PASS — 0 blockers, 0 majors, 4 minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: [#249](https://cursor.com/codebase/shamail-sikander/cursor-init/pull/249) (closed / squash-landed)  
Audited landed tip: `5625596358d945b8f1760dfb2975c775c7afd3f2`  
First parent (squash base on `main`): `72be3ce2462ed3f3eb0049f68e290a5f9dd4a797` (independent PR #244 audit docs #246)  
Follow-up docs note on `main`: `903cc9de655d098e5f9d7e23abe904533d22ef3e`  
Pre-squash PR branch tip (forge metadata): `9b81c35b98af` ← `72be3ce` (not identical to squash commit)

Evidence log: `/opt/cursor/artifacts/pr249_verification.log`

## Executive finding

Squash `5625596` lands **after** audit docs `72be3ce` and extends the TB ack-recon lattice with GET **499–500**
(`${view497}_external_transport_receipt_acknowledgments` / `${view498}_external_transport_receipt_acknowledgments`),
six lifecycle POSTs parented on finalized **497/498** rows, deny-by-default persistence for both new repository keys,
and `/ops` call sites after the **497/498** block. `parseView` remains identity-only through **500**; **485–498** handlers
and the `it.each` identity suite are intact (**16** slices **485–500**). Focused vitest replay (full lattice file set,
no `-t` filter): **16 files, 187 passed, 0 skipped**. `transport_stub=true` caps product at **PARTIAL**; labels and
roadmap do not claim COMPLETE. `check_pr_phase_claims.py` replay on the actual PR #249 body with `BASE=72be3ce`,
`HEAD=5625596` **PASS** (unlike PR #244).

## Landing order and lattice on current `main`

`git log --oneline -15 main` (tip `903cc9d`):

1. `903cc9d` — docs slice note (builder)
2. `5625596` — **PR #249 product squash**
3. `72be3ce` — PR #244 independent audit (#246)
4. `3c7c607` — PR #244 product (#244)

**5625596 is after 72be3ce** (feature landed on top of the #244 audit commit). First parent of `5625596` is **`72be3ce`**, not `3c7c607`.

Current `main` (`903cc9d`) retains the full **485–500** GET lattice in `route.ts` (35,704 lines) and **16** `it.each` cases.

## A. Scope, acceptance, and labels — PASS (with minors)

| Source | Claim | Independent result |
|---|---|---|
| `docs/LEGAL_OS_ROADMAP.md` slice `cursor/tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-499-500-7b68` | GET **499–500**, six POSTs, parents **497/498** | **PASS** — matches landed diff |
| PR #249 body | `backend_real` / `frontend_real` / `transport_stub` true; not COMPLETE | **PASS** — table + disclaimer |
| PR #249 body | `/ops` view → `operator-audit-console.tsx`; `/api/d2/ops-reporting` | **PASS** — concrete call-site evidence |
| Forge PR metadata | Branch `9b81c35b98af` ← `72be3ce` | **Minor** — squash on `main` is **`5625596`** |
| Squash stat | 13 files | **PASS** — `72be3ce..5625596`: 13 files, +2,193 / −20 (matches user anchor) |
| Line counts | (not quoted in PR body) | **PASS** — `route.ts` **35,047 → 35,704** (+657); `operator-audit-console.tsx` **5,019 → 5,147** (+128) at parent `72be3ce` → `5625596` (PR #244 audit baseline at `3c7c607` was **35,047** / **5,019**) |

## B. Lattice integrity — PASS

| Artifact | Before (`72be3ce`) | After (`5625596`) | Δ |
|---|---:|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 35,047 | 35,704 | +657 |
| `app/ops/operator-audit-console.tsx` | 5,019 | 5,147 | +128 |

- GET **499** handler: `route.ts` **L12080–L12116** (after **497** block ending ~L12078).
- GET **500** handler: `route.ts` **L12118–L12154**.
- POST block comment **L35258**; six `parsed.action` handlers **L35259, L35336, L35402, L35462, L35542, L35608** (checkpoint / acknowledge / control × waiver + variance).
- `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS`: slices **485–500** (16 entries, ordered); `it.each` asserts `json.view === requestedView` (`tests/persistence.route-wiring.test.ts` **L6448–L6542**).
- `/ops`: `readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice` — GET **499–500** **L4710–L4737**; six POST `runApiCallAllowingStatuses` **L4738–L4835** after **497/498** control POSTs; ordering test in `tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-499-500-frontend-real.test.ts`.

## C. `parseView` and dispatch — PASS

- Read **entire** `parseView` (**L554–L840**, 287 lines). Automated scan: **0** non-identity returns (`return value`, `return "activity"`, or `return undefined` only).
- New branches for **499/500** suffix views at **L832–L837** (after **497/498** at **L825–L830**); no parent→child remap.
- Regression: `it("ops reporting parseView identity: GET 492/493/494/495/496/497/498/499/500…")` at `persistence.route-wiring.test.ts` **L6576+**.

## D. Persistence — PASS

- Governance: `platform/persistence/workflowOpsAckReconTbSealVerificationsOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentGovernance.ts`.
- Deny-by-default binder entries for **499** and **500** repo keys at `denyByDefaultWorkflowOpsRepository.ts` **L33–L38**.
- `firestoreSpineRepositories.ts` + `spineRepositories.ts` wire memory/Firestore adapters; `firestore.rules` adds deny-write collections (squash diff).
- `npm run test:rules`: **22/22** (3 files). Inherited **#205** `persistence.repositories` round-trip: **not regressed**.

## E. Tests and gates — PASS (with minors)

| Command | Result |
|---|---|
| Focused vitest (16 files, **no** `-t` filter) | **16 files, 187 passed, 0 skipped** |
| `npm run test:rules` | **3 files, 22 passed** |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10** |
| `npx vitest run tests/pr-phase-claim-gate.test.ts` | **20/20** (1 Vitest worker `onTaskUpdate` timeout logged; tests green) |
| `check_pr_phase_claims.py` `BASE_SHA=72be3ce`, `HEAD_SHA=5625596`, PR #249 description | **PASS** |

**Test-file reconciliation vs PR #244 audit (`15` files / `181` passed):**

| Metric | PR #244 auditor replay | PR #249 auditor replay | Δ |
|---|---:|---:|---|
| Vitest files | 15 | 16 | +1 (`tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-499-500-frontend-real.test.ts`) |
| Vitest tests | 181 | 187 | +6 (2 frontend-real + 4 route-wiring: slices **499–500** `it.each`, parseView extension, repo wiring) |

PR #249’s **“13 files”** in squash metadata is the **git changed-file count**, not the focused vitest file list. No focused lattice file from #244 was dropped or deleted.

**Focused vitest file list (auditor replay):** same as `docs/audits/phase-pr244-tb-ack-recon-pd-freeze-seal-tb-recon-497-498.md` §E, plus  
`tests/ops.pr-tb-ack-recon-pd-freeze-seal-tb-external-transport-ack-499-500-frontend-real.test.ts`.

## F. `frontend_real` — PASS

- GET `/api/d2/ops-reporting` with `view` for **499** / **500** at `operator-audit-console.tsx` **L4710–L4737** (`path: "/api/d2/ops-reporting"`).
- Six POST actions on same path **L4738–L4835**; transport honesty via `blocked_todo_firm:transport_stub_*:ops_probe` only.

## Findings summary

| ID | Severity | Finding |
|---|---|---|
| PR249-M1 | **minor** | Forge PR branch tip `9b81c35b98af` ≠ squash tip `5625596`. |
| PR249-M2 | **minor** | Squash `5625596` first parent is audit commit `72be3ce`, not product parent `3c7c607` (valid fast-forward topology, but auditors must diff `72be3ce..5625596`). |
| PR249-M3 | **minor** | Builder embedded `docs/LEGAL_OS_PHASE_VERIFICATION.md` + roadmap edits in product squash `5625596`; follow-up `903cc9d` duplicated the 499–500 verification block (self-certification noise, not a product defect). |
| PR249-M4 | **minor** | `pr-phase-claim-gate.test.ts` logs unhandled Vitest worker timeout; all 20 tests passed. |

## Final classification

| Dimension | Verdict |
|---|---|
| **Phase audit** | **PASS** (0 blockers, 0 majors, 4 minors) |
| **Product** | **PARTIAL** (`transport_stub=true`; COMPLETE invalid) |
| `backend_real` | **PASS** (scoped) |
| `frontend_real` | **PASS** |
| `transport_stub` | **PASS** (honest) |

---

## Auditor replay commands

```bash
git log --oneline -15 main
git rev-parse 5625596358d945b8f1760dfb2975c775c7afd3f2^

export PR_TITLE='Legal OS GET 499-500: TB ack-recon PD freeze-seal external transport receipt ack #249'
export PR_BODY="$(origin pr view 249 --json body -q .body)"
export BASE_SHA=72be3ce2462ed3f3eb0049f68e290a5f9dd4a797
export HEAD_SHA=5625596358d945b8f1760dfb2975c775c7afd3f2
python3 ci_gates/check_pr_phase_claims.py

npx vitest run tests/persistence.route-wiring.test.ts tests/api.ops-reporting.test.ts \
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
