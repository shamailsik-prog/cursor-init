# Independent Phase Auditor forensic audit: PR #193 ack-recon transport-boundary external transport receipt acknowledgment (stub-honest)

Date: 2026-09-23  
Repo: `shamail-sikander/cursor-init`  
PR: `#193` → `main` (merged)  
Main tip audited: `40848261051cfb5a3948bc5be22442e55e21b1ef` (`origin/main` @ audit close)  
Landed merge commit: `4084826` (parents `40abfd8` + feature `1186635`)  
Stack base: `43c8d56` (PR #191 ack-recon transport-boundary receipt reconciliation)  
Feature commit (substantive): `1186635` (+1580/-5, 13 paths; product slice `43c8d56..1186635`)  
Claim-gate anchor on `main`: `ede9a9c` (`ci_gates/check_pr_phase_claims.py` plain `key=value` + table parsing)

## Verdict (lead)

**PASS (severity: low).**

Independent replay confirms dual-track **transport-boundary receipt reconciliation → external transport receipt acknowledgment** scaffolding is backend-real in memory and Firestore: child document IDs use `buildWorkflowOpsChainedDocumentId` (`woa:<sha256>`) and stay ≤1500 UTF-8 bytes (dedicated custody-id test + repository seeds + runtime-mode mega flow), repositories compile with **zero duplicate top-level `const` bindings** in `tests/persistence.repositories.test.ts`, Firestore emulator trio **22/22**, focused Vitest **122/122**, **G-0 PASSED** and **G-1 10/10**, and claim-gate replay green on canonical stub-honest metadata for diff `43c8d56..1186635`.

**Release / product classification remains PARTIAL** (not DONE): `transport_stub=true`, `externalTransportChannel: blocked_todo_firm`, provenance `transport_stub:true`, and global filing transport `TODO(firm)` — honestly scoped; no COMPLETE/product-done claim in replay metadata.

**Non-blocking residuals:** (1) six new partner POST actions for this slice lack dedicated HTTP POST assertions in `tests/api.ops-reporting.test.ts` (GET view seeds + `tests/persistence.route-wiring.test.ts` filters cover surfaces); (2) `docs/LEGAL_OS_ROADMAP.md` labels this slice **PR #192** while forge merge is **#193** (numbering drift only); (3) builder stub `docs/audits/phase-prXXX-workflow-slo-ack-recon-transport-boundary-receipt-reconciliation-external-transport-receipt-acknowledgment.md` was **not** used as evidence (superseded by this file).

---

## Scope and provenance checked

- `git fetch origin main`; audited ref `4084826`; `git merge-base --is-ancestor 4084826 HEAD`.
- Substantive diff `43c8d56..1186635`: 13 files, **0** `app/ops/**` paths.
- Parent lineage: PR #191 @ `43c8d56` (`workflowOpsAckReconTransportBoundaryReceiptReconciliationGovernance` parents).
- Claimed commands executed independently @ `4084826`.

---

## A–F verification matrix

### A) Architecture / BACKEND_REAL

Status: **PASS**

Evidence:

1. Row types + runtime maps in `platform/spine/store.ts` (external-transport-receipt-acknowledgment status unions + row shapes for waiver custody and variance closure tracks).
2. Memory repos `platform/persistence/spineRepositories.ts` and Firestore adapters `platform/persistence/firestoreSpineRepositories.ts` (`upsert` / `get` / `listByFirm` / `listAll`).
3. Firestore client deny-write (`firestore.rules` L207–208) for:
   - `…_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments` (waiver track)
   - `…_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments` (variance track)
4. Governance `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentGovernance.ts`:
   - IDs via **`buildWorkflowOpsChainedDocumentId`** (L18–33).
   - Stub transport: `WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM`, `WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE`, `TRANSPORT_STUB_PROVENANCE_TAG` (`transport_stub:true`) (L4–16, L163–176).
   - Parent posture: waiver backlog gates on `partner_delivery_transport_boundary_receipt_reconciliation_finalized` (L107–117); variance track mirrors closure-attested reconciliation parents.
5. `/api/d2/ops-reporting`:
   - **Two** new paginated GET `view=` surfaces (L9337–9398): waiver + variance external-transport-receipt-acknowledgment keys.
   - **Six** partner POST actions in action union (L6822–6864; handler block ~L20787+): waiver checkpoint / acknowledge / control finalization; variance digest checkpoint / acknowledge / control finalization.
   - Digest-rebuild sync from transport-boundary reconciliation parents (route ~L5194–5239).

**Firestore ID length (checklist):**

- `tests/workflow-ops-custody-closure-firestore-id.test.ts` L283–304: `Buffer.byteLength` ≤1500 for both child id builders.
- `tests/persistence.repositories.test.ts` L2699+: seeded repo ids `.length` ≤1500.
- `tests/persistence.runtime-mode.test.ts` L9730+: persisted emulator docs for new statuses.

### B) Frontend honesty (`frontend_real=false`)

Status: **PASS**

1. Claimed labels: `frontend_real=false`.
2. Diff `43c8d56..1186635` and merge `4084826` exclude `app/ops/**` (0 ops files).
3. No new `/ops` call sites for external-transport-receipt-acknowledgment actions.

### C) Transport stub honesty (`transport_stub=true`)

Status: **PASS**

1. Rows set `externalTransportChannel: "blocked_todo_firm"` and provenance includes `transport_stub:true` (governance L163–176).
2. Acknowledgment uses `WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE` when no firm receipt reference is supplied.
3. Global filing transport stubs remain (`platform/persistence/filingDispatchQueue.ts` → `TODO(firm)` / `blocked_todo_firm`).
4. Classification correctly capped at **PARTIAL**; replay metadata negates COMPLETE/product-done while `transport_stub=true`.

### D) No COMPLETE overclaim

Status: **PASS**

1. Replay metadata: `classification=PARTIAL`, `transport_stub=true`, explicit negated COMPLETE/product-done wording.
2. Slice does not claim product DONE or real external transport.

### E) Tests / rules / gates

Status: **PASS**

| Suite | Command | Result @ `4084826` |
|---|---|---|
| Ops reporting + route wiring + custody-id | `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts` | **122/122** |
| Firestore trio | `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"` | **22/22** |
| G-0 | `bash ci_gates/gate_g0.sh` | **PASSED** |
| G-1 | `python3 ci_gates/gate_g1.py` | **10/10** |

Duplicate `const` scan on `tests/persistence.repositories.test.ts`: **0** duplicate top-level bindings.

### F) Docs / roadmap consistency

Status: **PASS (with numbering drift noted)**

1. Roadmap section documents slice scope and points at governance + ops-reporting (`docs/LEGAL_OS_ROADMAP.md` PR #192 block — **forge merge is #193**).
2. Builder `phase-prXXX-…-external-transport-receipt-acknowledgment.md` checklist aligns with landed code paths; superseded by this independent audit.
3. Ledger append: `docs/LEGAL_OS_PHASE_VERIFICATION.md` (PR #193 targeted entry).
4. NEXT PHASE queue correctly scopes **acknowledgment reconciliation** as follow-up (not in this slice).

---

## Commands (audit replay log)

```bash
git fetch origin main
git rev-parse HEAD   # 4084826
npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts
npx firebase-tools emulators:exec --only firestore --project demo-sikander \
  "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"
bash ci_gates/gate_g0.sh
python3 ci_gates/gate_g1.py
PR_BODY='...' BASE_SHA=43c8d56 HEAD_SHA=1186635 python3 ci_gates/check_pr_phase_claims.py
```

---

## Classification summary

| Label | Auditor finding |
|---|---|
| backend_real | true (PASS) |
| frontend_real | false (PASS honesty) |
| transport_stub | true (expected; PASS honesty) |
| Product DONE | **No** — capped at **PARTIAL** |
| Audit verdict | **PASS (low)** |
