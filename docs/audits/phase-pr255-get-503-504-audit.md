# Independent Phase Auditor A–F audit: PR #255 TB ack-recon PD freeze seal external distribution audit ledger + partner handoff attestation GET 503–504

> **Verdict (2026-09-26): PASS — 0 blockers, 0 majors, 4 minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: [#255](https://cursor.com/codebase/shamail-sikander/cursor-init/pull/255) (squash-landed)  
Audited landed tip: `7c9a47f567031f082fac477b8cced4f29037b9a1`  
Squash first parent: `959cb21619facb686be52209947191a8bf938916` (docs PR #253 — independent PR #252 audit)  
Forge PR branch tip: `2f3c79779b1c` (not present in auditor clone; merge subject is `7c9a47f`).

Evidence log: `/opt/cursor/artifacts/pr255_verification.log`

## Executive finding

Squash `7c9a47f` is **code-only** (6 files, +1,041 / −2), extends the TB ack-recon lattice with GET **503–504**
(`${view501}_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_…_external_transport_receipt_acknowledgment_reconciliations` /
`${view502}_partner_handoff_attestations_outbound_registry_attestation_ledgers_…_external_transport_receipt_acknowledgment_reconciliations`),
six lifecycle POSTs parented on finalized **501/502** rows, deny-by-default binder entries for the two new repository keys,
governance builders in the long-named `…Governance.ts` module (+10 lines), **+2** Firestore deny-write rules, and `/ops` call sites
after the **501/502** block. `parseView` remains identity-only through **504** (automated scan: 0 non-identity returns).
Lattice `it.each` covers **485–504** (20 slices). Dedicated repository wiring `it()` for **503** and **504** assert status fields
(not status-only HTTP). Focused vitest replay (full lattice file set, no `-t` filter): **18 files, 197 passed, 0 skipped**.
`transport_stub=true` caps product at **PARTIAL**. `check_pr_phase_claims.py` replay on PR #255 body with `BASE=959cb21`, `HEAD=7c9a47f` **PASS**.

## A. Landing order and squash scope — PASS

`git rev-parse 7c9a47f^` → `959cb21619facb686be52209947191a8bf938916` (matches builder claim; **not** an unrelated intermediate).

On audited `HEAD` first-parent chain: `7c9a47f` (product) → `959cb21` (#253 docs) → `0c1634c` (#252 product).

| Check | Result |
|---|---|
| #253 docs before #255 product | **PASS** — `959cb21` is direct parent of `7c9a47f` |
| Squash diff code-only | **PASS** — no `docs/` paths in `959cb21..7c9a47f` |
| Changed files | 6 (matches builder) |

**Minor:** local `main` ref in this clone remains at `959cb21` while audit `HEAD` is `7c9a47f` (stale default-branch pointer; use `7c9a47f` as landed tip).

## B. Lattice integrity — PASS

| Artifact | @ `959cb21` (pre-squash) | @ `7c9a47f` | Δ |
|---|---:|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 36,391 | 37,134 | +743 |
| `app/ops/operator-audit-console.tsx` | 5,275 | 5,406 | +131 |

- GET **503** handler: `route.ts` **L12514–L12550** (after **501/502** blocks at **L12438–L12512**).
- GET **504** handler: `route.ts` **L12552–L12588**.
- POST block comment **L36668**; six `503504` action bodies **L8807–L8847**; handlers in same PR slice region **L36668+**.
- `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS`: slices **485–504** (20 entries, ordered; none missing).
- Prior GET slices through **502** remain in `parseView` and dispatch; no truncation observed.

## C. `parseView` and dispatch — PASS

- `parseView` body: **L570–L869**; automated scan: **0** non-identity returns.
- New identity branches for **503/504** at **L858–L865** (after **501/502** at **L855–L856**).
- `it.each` lattice asserts `json.view === requestedView` for **485–504** (`tests/persistence.route-wiring.test.ts` **L6448–L6562**).
- Dedicated regression: `it("ops reporting parseView identity: GET 492/…/503/504…")` **L6596–L6706** (13 views **492–504**).
- Dedicated wiring: view **(503)** **L6708–L6726** (`externalDistributionAuditLedgerStatus`); view **(504)** **L6728–L6746** (`partnerHandoffAttestationStatus`).

## D. Persistence — PASS

- Deny-by-default binder (503 repo): `firestoreSpineRepositories.ts` **L4066–L4069** (`createDenyByDefaultWorkflowOpsRepository` → `…ExternalDistributionAuditLedgers`).
- Deny-by-default binder (504 repo): **L4149–L4152** (`…PartnerHandoffAttestations`).
- `firestore.rules` squash diff: **+2** `allow write: if false` lines for collections matching binder paths (diff at rules **L221–L222** region).
- Firestore emulator trio: **22/22** (no new `ReferenceError` in `persistence.repositories` round-trip this pass).

## E. Tests and gates — PASS (with minor)

| Command | Result |
|---|---|
| Focused vitest (18 files, **no** `-t` filter) | **18 files, 197 passed, 0 skipped** |
| `npm run test:rules` | **3 files, 22 passed** |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10** |
| `npx vitest run tests/pr-phase-claim-gate.test.ts` | **20/20** (1 Vitest worker `onTaskUpdate` timeout logged; tests green) |
| `check_pr_phase_claims.py` `BASE_SHA=959cb21`, `HEAD_SHA=7c9a47f`, PR #255 description | **PASS** |

**Test-file reconciliation vs PR #252 audit (17 files / 191 passed):**

| Metric | PR #252 auditor replay | PR #255 auditor replay | Δ |
|---|---:|---:|---|
| Vitest files | 17 | 18 | +1 `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-503-504-frontend-real.test.ts` |
| Vitest tests | 191 | 197 | +6 (2 frontend-real + 2 `it.each` slices + parseView/wiring cases) |

No focused lattice file from #252 was dropped.

## F. `frontend_real` — PASS

| Step | File:line | Path |
|---|---|---|
| GET view **503** | `operator-audit-console.tsx` **L4965–L4978** | `GET /api/d2/ops-reporting` |
| GET view **504** | `operator-audit-console.tsx` **L4979–L4992** | `GET /api/d2/ops-reporting` |
| POST checkpoint custody digest (**503**) | **L4993–L5009** | `POST /api/d2/ops-reporting` |
| POST record custody ledger entry | **L5010–L5026** | same |
| POST control custody finalization | **L5027–L5041** | same |
| POST register closure outbound registry | **L5042–L5057** | same |
| POST attest closure partner handoff | **L5058–L5074** | same |
| POST control closure finalization | **L5075–L5084+** | same |

Checkpoint/register/attest bodies use honest `blocked_todo_firm:transport_stub_*:ops_probe` strings — consistent with `transport_stub=true`, not API-only scaffolds.

Static ordering test: `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-distribution-audit-ledger-503-504-frontend-real.test.ts`.

## Findings summary

| ID | Severity | Finding |
|---|---|---|
| PR255-M1 | **minor** | Forge branch tip `2f3c79779b1c` not fetchable in auditor clone; landed merge subject is `7c9a47f`. |
| PR255-M2 | **minor** | Local `main` ref at `959cb21` lags audit `HEAD` `7c9a47f` (snapshot staleness). |
| PR255-M3 | **minor** | `pr-phase-claim-gate.test.ts` logs unhandled Vitest worker timeout; all 20 tests passed. |
| PR255-M4 | **minor** | `transport_stub=true` — product remains PARTIAL (accepted policy). |

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
git rev-parse 7c9a47f^ HEAD
git diff --stat 959cb21..7c9a47f

export PR_TITLE='feat(legal-os): TB ack-recon PD freeze seal external distribution audit ledger + partner handoff attestation GET 503-504'
export PR_BODY="$(origin pr view 255 | sed -n '/CURSOR_AGENT_PR_BODY_BEGIN/,/CURSOR_AGENT_PR_BODY_END/p')"
export BASE_SHA=959cb21619facb686be52209947191a8bf938916
export HEAD_SHA=7c9a47f567031f082fac477b8cced4f29037b9a1
python3 ci_gates/check_pr_phase_claims.py

npx vitest run tests/persistence.route-wiring.test.ts tests/api.ops-reporting.test.ts \
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
