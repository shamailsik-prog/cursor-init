# Independent Phase Auditor forensic audit: PR #195 ack-recon external transport receipt acknowledgment reconciliation (stub-honest)

Date: 2026-09-23  
Repo: `shamail-sikander/cursor-init`  
PR: `#195` → `main` (squash-merged)  
Main tip audited: `a7ae742fdb709a1e0477d969714e2282fcd39c49`  
Landed merge commit: `a7ae742` (parent `807a004` — PR #194 independent audit docs)  
Stack base: `4084826` (PR #193 ack-recon transport-boundary external transport receipt acknowledgment)  
Product diff measured: `4084826..a7ae742` (+1624/-3 product paths; merge tip includes squash commit `a7ae742`)  
Claim-gate anchor on `main`: `ede9a9c` (`ci_gates/check_pr_phase_claims.py` plain `key=value` + table parsing)

## Verdict (lead)

**PASS (severity: low).**

Independent replay confirms dual-track **external transport receipt acknowledgment → acknowledgment reconciliation** scaffolding is backend-real in memory and Firestore: child document IDs use `buildWorkflowOpsChainedDocumentId` (`woa:<sha256>`) and stay ≤1500 UTF-8 bytes (dedicated custody-id test + repository seeds + runtime-mode mega flow), Firestore deny-write rules for both reconciliation collections, cross-track receipt-reference parity gates in governance builders, `/api/d2/ops-reporting` two paginated GET views + six partner POST actions with digest-rebuild sync from acknowledgment parents, focused Vitest **125/125**, Firestore emulator trio **22/22**, **G-0 PASSED** and **G-1 10/10**, and claim-gate replay green on canonical stub-honest metadata (`4084826..a7ae742`).

**Release / product classification remains PARTIAL** (not DONE): `transport_stub=true`, `externalTransportChannel: blocked_todo_firm`, provenance `transport_stub:true`, stub receipt reference parity digests, and global filing transport `TODO(firm)` — honestly scoped; no COMPLETE/product-done claim in replay metadata.

**Non-blocking residuals:** (1) six new partner POST actions lack dedicated HTTP POST assertions in `tests/api.ops-reporting.test.ts` (GET view seeds + `tests/persistence.route-wiring.test.ts` status filters cover surfaces); (2) `docs/LEGAL_OS_ROADMAP.md` labels this slice **PR #194** while forge merge is **#195** (numbering drift only); (3) builder stub `docs/audits/phase-prXXX-workflow-slo-ack-recon-transport-boundary-receipt-reconciliation-external-transport-receipt-acknowledgment-reconciliation.md` was **not** used as evidence (superseded by this file).

---

## Scope and provenance checked

- Audited ref `a7ae742`; parent `807a004` is docs-only (PR #194 audit for #193).
- Substantive product diff `4084826..a7ae742`: 12 files, **0** `app/ops/**` paths.
- Parent lineage: PR #193 @ `4084826` (external transport receipt acknowledgment child rows on PR #191 transport-boundary reconciliation parents).
- Claimed test/gate commands executed independently @ `a7ae742`.

---

## A–F verification matrix

### A) Architecture / BACKEND_REAL

Status: **PASS**

Evidence:

1. Row types + runtime maps in `platform/spine/store.ts` (L4070–4154 types; L4467–4476 maps) for waiver custody and variance closure acknowledgment-reconciliation rows.
2. Memory repos `platform/persistence/spineRepositories.ts` and Firestore adapters `platform/persistence/firestoreSpineRepositories.ts` (`upsert` / `get` / `listByFirm` / `listAll`).
3. Firestore client deny-write (`firestore.rules` L209–210) for:
   - `…_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations` (waiver track)
   - `…_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations` (variance track)
4. Governance `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationGovernance.ts`:
   - IDs via **`buildWorkflowOpsChainedDocumentId`** (L20–35).
   - Cross-track gate: `externalTransportReceiptReferencesMatch` + both parents must be `…_external_transport_receipt_acknowledged` (L127–146).
   - Stub transport: `WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM`, `TRANSPORT_STUB_PROVENANCE_TAG` (`transport_stub:true`) (L18, L206–207, L222–229).
5. `/api/d2/ops-reporting`:
   - **Two** paginated GET `view=` surfaces (L9549–9610): waiver + variance acknowledgment-reconciliation keys.
   - **Six** partner POST actions (action union ~L9919–9929; handlers ~L21452–21860): waiver reconcile / digest checkpoint / control finalization; variance digest checkpoint / reconcile / control finalization.
   - Digest-rebuild sync from external-transport-receipt-acknowledgment parents (route ~L5329–5356).

**Firestore ID length (checklist):**

- `tests/workflow-ops-custody-closure-firestore-id.test.ts` L307+: `Buffer.byteLength` ≤1500 for both child id builders.
- `tests/persistence.repositories.test.ts`: seeded repo ids `.length` ≤1500.
- `tests/persistence.runtime-mode.test.ts` L9752+: persisted emulator docs for reconciliation statuses.

### B) Frontend honesty (`frontend_real=false`)

Status: **PASS**

1. Claimed labels: `frontend_real=false`.
2. Diff `4084826..a7ae742` excludes `app/ops/**` (0 ops files).
3. No new `/ops` call sites for acknowledgment-reconciliation actions.

### C) Transport stub honesty (`transport_stub=true`)

Status: **PASS**

1. Rows set `externalTransportChannel: "blocked_todo_firm"` and provenance includes `transport_stub:true`.
2. Reconciliation builders use stub receipt reference defaults and emit `transport_stub:parity*` digests when cross-track references align.
3. Global filing transport stubs remain (`platform/persistence/filingDispatchQueue.ts` → `TODO(firm)` / `blocked_todo_firm`).
4. Classification correctly capped at **PARTIAL**; replay metadata negates COMPLETE/product-done while `transport_stub=true`.

### D) SHA-on-main integrity

Status: **PASS**

1. Audited merge tip: `a7ae742fdb709a1e0477d969714e2282fcd39c49`.
2. Immediate parent `807a004` (PR #194 docs); product stack base `4084826` (PR #193) is ancestor of `a7ae742`.

### E) Tests / rules / gates

Status: **PASS**

| Suite | Command | Result @ `a7ae742` |
|---|---|---|
| Ops reporting + route wiring + custody-id | `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts` | **125/125** |
| Firestore trio | `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"` | **22/22** |
| G-0 | `bash ci_gates/gate_g0.sh` | **PASSED** |
| G-1 | `python3 ci_gates/gate_g1.py` | **10/10** |

`ci_gates/check_pr_phase_claims.py` with canonical `PR_BODY` + `BASE_SHA=4084826` + `HEAD_SHA=a7ae742` exits **0**.

### F) Docs / roadmap consistency

Status: **PASS (with numbering drift noted)**

1. Roadmap section **PR #194** documents slice scope; forge merge is **#195** (same drift pattern as #192/#193).
2. Roadmap still points at builder stub for auditor checklist — superseded by this independent audit + ledger append.
3. Ledger append: `docs/LEGAL_OS_PHASE_VERIFICATION.md` (PR #195 targeted entry).
4. `NEXT PHASE` placeholder remains queued; this audit does **not** chain the next feature.

---

## Key paths (pointers)

| Area | Path |
|---|---|
| Governance | `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationGovernance.ts` |
| Store types/maps | `platform/spine/store.ts` |
| Repositories | `platform/persistence/spineRepositories.ts`, `platform/persistence/firestoreSpineRepositories.ts` |
| Ops reporting | `app/api/d2/ops-reporting/route.ts` |
| Firestore rules | `firestore.rules` (L209–210) |
| Tests | `tests/persistence.repositories.test.ts`, `tests/persistence.route-wiring.test.ts`, `tests/persistence.runtime-mode.test.ts`, `tests/workflow-ops-custody-closure-firestore-id.test.ts` |

---

## Classification summary

| Label | Auditor finding |
|---|---|
| backend_real | true (PASS) |
| frontend_real | false (PASS honesty) |
| transport_stub | true (expected; PASS honesty) |
| Product classification | **PARTIAL** (not DONE) |
| Audit verdict | **PASS (low)** |
