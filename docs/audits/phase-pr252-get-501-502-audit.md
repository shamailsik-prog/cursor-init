# Independent Phase Auditor A–F audit: PR #252 TB ack-recon PD freeze seal external transport receipt ack reconciliation GET 501–502

> **Verdict (2026-09-26): PASS — 0 blockers, 0 majors, 5 minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: [#252](https://cursor.com/codebase/shamail-sikander/cursor-init/pull/252) (merged / squash-landed)  
Audited landed tip: `0c1634ce9ec73c828cfe53eb1ef7c9a7593c526c`  
Squash first parent on `main`: `8edc890d69a54cb4816e8dff9a145bd9b68c1854` (chore #248 — not PR #251 audit docs)  
PR #251 audit docs (`0ad8db0`) landed **before** this squash on first-parent `main`.  
Forge PR `headSha` / body `HEAD_SHA`: `a999a3920f8d84cf8428f2852e45c0e84c66c601` (not present in local clone; merge commit is `0c1634c`).

Evidence log: `/opt/cursor/artifacts/pr252_verification.log`

## Executive finding

Squash `0c1634c` is **code-only** (7 files, +1,333 / −37), extends the TB ack-recon lattice with GET **501–502**
(`${view499}_external_transport_receipt_acknowledgment_reconciliations` / `${view500}_external_transport_receipt_acknowledgment_reconciliations`),
six lifecycle POSTs parented on acknowledged **499/500** rows, deny-by-default binder entries for the two reconciliation
repository keys (refactored in `firestoreSpineRepositories.ts`), governance module for **501–502**, and `/ops` call sites
after the **499/500** block. `parseView` remains identity-only through **502**; lattice `it.each` covers **485–502** (18 slices).
Focused vitest replay (full lattice file set, no `-t` filter): **17 files, 191 passed, 0 skipped**. `transport_stub=true` caps
product at **PARTIAL**. `check_pr_phase_claims.py` replay on PR #252 body with `BASE=8edc890`, `HEAD=0c1634c` **PASS**.

## A. Landing order and squash scope — PASS (with minor)

`git log --first-parent -5 main`:

1. `0c1634c` — **PR #252 product squash**
2. `8edc890` — chore #248 (squash **first parent**)
3. `0ad8db0` — PR #249 independent audit docs #251
4. `903cc9d` — builder verification note
5. `5625596` — PR #249 product

| Check | Result |
|---|---|
| #251 docs before #252 product | **PASS** — `0ad8db0` is ancestor of `0c1634c` |
| Squash first parent = `0ad8db0` (builder narrative) | **Minor FAIL narrative** — actual parent is `8edc890` (#248) |
| Squash diff code-only | **PASS** — `git diff --name-only 8edc890..0c1634c` has **no** `docs/` paths |
| Changed files | 7 (matches builder “7 files”) |

## B. Lattice integrity — PASS

| Artifact | @ `0ad8db0` (pre-squash baseline) | @ `0c1634c` | Δ |
|---|---:|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 35,704 | 36,391 | +687 |
| `app/ops/operator-audit-console.tsx` | 5,147 | 5,275 | +128 |

- GET **501** handler: `route.ts` **L12302–L12337** (after **499/500** block).
- GET **502** handler: `route.ts` **L12340–L12375**.
- POST block comment **L35927**; six `parsed.action` handlers **L35929, L35997, L36078, L36143, L36228, L36289** (reconcile / checkpoint digest / control finalization × waiver + variance).
- `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS`: slices **485–502** (18 entries, ordered; none missing).
- Prior GET slices **485–500** remain in `parseView` and dispatch; no truncation observed.

## C. `parseView` and dispatch — PASS

- `parseView` body: **L564–L857**; automated scan: **0** non-identity returns (`return value`, `return "activity"`, or `return undefined` only).
- New identity branches for **501/502** suffix views at **L849–L854** (after **499/500** at **L842–L847**).
- `it.each` lattice asserts `json.view === requestedView` for **485–502** (`tests/persistence.route-wiring.test.ts` **L6541–L6551**).
- Dedicated regression: `it("ops reporting parseView identity: GET 492/…/501/502…")` **L6586–L6679** (11 views **492–502**).

## D. Persistence — PASS (with minor)

- Governance: `platform/persistence/workflowOpsAckReconTbPdFreezeSealOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationGovernance.ts` (new in squash).
- Deny-by-default binder entries for **501/502** repo keys at `denyByDefaultWorkflowOpsRepository.ts` **L38–L41**.
- `firestoreSpineRepositories.ts`: inline Firestore adapters for the two reconciliation repos replaced with `createDenyByDefaultWorkflowOpsRepository` (**squash diff**).
- `npm run test:rules`: **22/22** (3 files). Squash did **not** edit `firestore.rules`; collections at **L206/L208** already deny-write and match binder paths.
- Inherited **#205** `persistence.repositories` round-trip: **not re-tested** this pass; no new undefined references in squash diff.

## E. Tests and gates — PASS (with minor)

| Command | Result |
|---|---|
| Focused vitest (17 files, **no** `-t` filter) | **17 files, 191 passed, 0 skipped** |
| `npm run test:rules` | **3 files, 22 passed** |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10** |
| `npx vitest run tests/pr-phase-claim-gate.test.ts` | **20/20** (1 Vitest worker `onTaskUpdate` timeout logged; tests green) |
| `check_pr_phase_claims.py` `BASE_SHA=8edc890`, `HEAD_SHA=0c1634c`, PR #252 description | **PASS** |

**Test-file reconciliation vs PR #249 audit (16 files / 187 passed):**

| Metric | PR #249 auditor replay | PR #252 auditor replay | Δ |
|---|---:|---:|---|
| Vitest files | 16 | 17 | +1 `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-501-502-frontend-real.test.ts` |
| Vitest tests | 187 | 191 | +4 (2 frontend-real + 2 `it.each` slices + parseView cases) |

No focused lattice file from #249 was dropped.

## F. `frontend_real` — PASS

| Step | File:line | Path |
|---|---|---|
| GET view **501** | `operator-audit-console.tsx` **L4837–L4850** | `GET /api/d2/ops-reporting` |
| GET view **502** | `operator-audit-console.tsx` **L4851–L4864** | `GET /api/d2/ops-reporting` |
| POST reconcile custody (**501**) | **L4865–L4878** | `POST /api/d2/ops-reporting` |
| POST checkpoint custody digest | **L4880–L4896** | same |
| POST control custody finalization | **L4897–L4911** | same |
| POST checkpoint closure digest | **L4912–L4928** | same |
| POST reconcile closure (**502**) | **L4929–L4943** | same |
| POST control closure finalization | **L4944–L4958** | same |

Checkpoint digests use honest `blocked_todo_firm:transport_stub_*:ops_probe` strings (**L4890–L4891**, **L4922–L4923**) — consistent with `transport_stub=true`, not API-only scaffolds.

Static ordering test: `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-501-502-frontend-real.test.ts`.

## Findings summary

| ID | Severity | Finding |
|---|---|---|
| PR252-M1 | **minor** | Squash first parent is `8edc890` (#248), not `0ad8db0` (#251 audit); auditors must diff `8edc890..0c1634c`. |
| PR252-M2 | **minor** | Forge `headSha` `a999a3920…` not fetchable locally; landed merge is `0c1634c` (cannot verify byte-identical squash vs branch tip). |
| PR252-M3 | **minor** | `pr-phase-claim-gate.test.ts` logs unhandled Vitest worker timeout; all 20 tests passed. |
| PR252-M4 | **minor** | No new dedicated repository wiring `it()` for **501/502** beyond lattice `it.each` (incremental pattern; not a regression). |
| PR252-M5 | **minor** | `firestore.rules` unchanged in squash; relies on pre-landed deny-write rules for reconciliation collections. |

## Final classification

| Dimension | Verdict |
|---|---|
| **Phase audit** | **PASS** (0 blockers, 0 majors, 5 minors) |
| **Product** | **PARTIAL** (`transport_stub=true`; COMPLETE invalid) |
| `backend_real` | **PASS** (scoped) |
| `frontend_real` | **PASS** |
| `transport_stub` | **PASS** (honest) |

## Auditor replay commands

```bash
git log --first-parent -8 main
git rev-parse 0c1634c^
wc -l app/api/d2/ops-reporting/route.ts app/ops/operator-audit-console.tsx

export PR_TITLE='feat(legal-os): TB ack-recon PD freeze seal external transport receipt ack reconciliation (GET 501–502)'
export PR_BODY="$(origin pr view 252 --json description -q .description)"
export BASE_SHA=8edc890d69a54cb4816e8dff9a145bd9b68c1854
export HEAD_SHA=0c1634ce9ec73c828cfe53eb1ef7c9a7593c526c
python3 ci_gates/check_pr_phase_claims.py

npx vitest run tests/persistence.route-wiring.test.ts tests/api.ops-reporting.test.ts \
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
