# Independent Phase Auditor forensic audit: PR #191 ack-recon transport-boundary receipt reconciliation (stub-honest)

Date: 2026-09-23  
Repo: `shamail-sikander/cursor-init`  
PR: `#191` → `main` (merged)  
Main tip audited: `43c8d56481640eb30a36e751a8f25c641eadf230` (`origin/main` @ audit close)  
Landed merge commit: `43c8d56` (parents `3a88d73` + feature `8f4eeff`)  
Stack base: `3a88d73` (PR #188 ack-recon partner-delivery-receipt freeze-override seal verification)  
Feature commit (substantive): `8f4eeff` (+1685/-2, 13 paths)  
Claim-gate anchor on `main`: `ede9a9c` (`ci_gates/check_pr_phase_claims.py` plain `key=value` + table parsing)

## Verdict (lead)

**PASS (severity: low).**

Independent replay confirms dual-track **ack-recon seal-verification → transport-boundary receipt reconciliation** scaffolding is backend-real in memory and Firestore: child document IDs use `buildWorkflowOpsChainedDocumentId` (`woa:<sha256>`) and stay ≤1500 UTF-8 bytes (dedicated custody-id test + repository seeds + runtime-mode mega flow), repositories compile with **zero duplicate top-level `const` bindings** in `tests/persistence.repositories.test.ts`, Firestore emulator trio **22/22**, focused Vitest **119/119**, **G-0 PASSED** and **G-1 10/10**, and claim-gate replay green on canonical stub-honest metadata for diff `3a88d73..8f4eeff`.

**Release / product classification remains PARTIAL** (not DONE): `transport_stub=true`, `externalTransportChannel: blocked_todo_firm`, provenance `transport_stub:true`, and global filing transport `TODO(firm)` — honestly scoped; no COMPLETE/product-done claim in replay metadata.

**Non-blocking residuals:** (1) six new partner POST actions for this slice lack dedicated HTTP POST assertions in `tests/api.ops-reporting.test.ts` (GET view seeds + `tests/persistence.route-wiring.test.ts` filters cover surfaces); (2) merge commit / public GitHub API did not expose PR body plain `key=value` flags — gate replay used canonical labels matching builder claims; (3) `docs/LEGAL_OS_ROADMAP.md` labels this slice **PR #189** while forge merge is **#191** (numbering drift only); (4) builder stub `docs/audits/phase-prXXX-workflow-slo-ack-recon-transport-boundary-receipt-reconciliation.md` was **not** used as evidence (superseded by this file).

---

## Scope and provenance checked

- `git fetch origin main`; `origin/main` = `43c8d56`; `git merge-base --is-ancestor 43c8d56 origin/main`.
- Substantive diff `3a88d73..8f4eeff`: 13 files, **0** `app/ops/**` paths.
- Parent lineage: PR #188 @ `3a88d73` (`workflowOpsAckReconPartnerDeliveryReceiptFreezeOverrideSealVerificationGovernance` parents).
- Claimed commands executed independently @ `43c8d56`.

---

## A–F verification matrix

### A) BACKEND_REAL

Status: **PASS**

Evidence:

1. Row types + runtime maps in `platform/spine/store.ts` (L3910–3978 types; L4284–4292 maps) for:
   - Waiver/custody: `…PartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow`
   - Variance/closure: `…OutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationRow`
2. Memory repos `platform/persistence/spineRepositories.ts` and Firestore adapters `platform/persistence/firestoreSpineRepositories.ts` (`upsert` / `get` / `listByFirm` / `listAll`).
3. Firestore client deny-write (`firestore.rules` L205–206) for:
   - `…_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations` (waiver track)
   - `…_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations` (variance track)
4. Governance `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationGovernance.ts`:
   - IDs via **`buildWorkflowOpsChainedDocumentId`** (L17–32).
   - Stub transport: `WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM`, `TRANSPORT_STUB_PROVENANCE_TAG` (`transport_stub:true`) (L15, L169, L177–179).
   - Partner POST gate example: reconcile requires `partner_delivery_receipt_freeze_override_seal_verified` and `partnerDeliverySealBacklogCount === 0` (`app/api/d2/ops-reporting/route.ts` L20010–20021).
   - Digest-rebuild sync from seal-verification parents in ops-reporting recompute path (route L5048–5093).
5. `/api/d2/ops-reporting`:
   - **Two** new paginated GET `view=` surfaces (L9042–9117): waiver + variance transport-boundary reconciliation keys.
   - **Six** partner POST actions registered in action union (L9396–9406) with handlers (L19989–20420): waiver reconcile / digest checkpoint / control finalization; variance closure digest checkpoint / attest closure / control finalization.
   - Audit write-through on reconcile (e.g. L20049–20057).

**Firestore ID length (checklist):**

- `tests/workflow-ops-custody-closure-firestore-id.test.ts` L259–280: `Buffer.byteLength` ≤1500 for both child id builders.
- `tests/persistence.repositories.test.ts` L2687–2691: seeded repo ids `.length` ≤1500.
- `tests/persistence.runtime-mode.test.ts` L9681–9714: persisted emulator docs `entry.id.length <= 1500`.

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

1. Claimed labels: `frontend_real=false`.
2. Diff `3a88d73..8f4eeff` and merge `43c8d56` exclude `app/ops/**` (0 ops files).
3. No new `/ops` call sites for transport-boundary reconciliation actions.

### C) No COMPLETE overclaim

Status: **PASS**

1. Replay metadata: `classification=PARTIAL`, `transport_stub=true`, explicit negated COMPLETE/product-done wording.
2. Global filing transport stubs remain (`platform/persistence/filingDispatchQueue.ts` → `TODO(firm)` / `blocked_todo_firm`).
3. Slice rows keep `externalTransportChannel: "blocked_todo_firm"` and `transport_stub:true` provenance (repository seed L2636–2639).

### D) SHA-on-main integrity

Status: **PASS**

1. `origin/main` @ audit close: `43c8d56481640eb30a36e751a8f25c641eadf230`.
2. Merge parents: `3a88d73` + `8f4eeff`; feature stat matches claim (+1685/-2, 13 files).

### E) Focused tests + gates

Status: **PASS**

| Suite | Command | Result @ `43c8d56` |
|---|---|---|
| Ops reporting + route wiring + custody-id | `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts` | **119/119** |
| Firestore trio | `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"` | **22/22** |
| G-0 | `bash ci_gates/gate_g0.sh` | **PASSED** |
| G-1 | `python3 ci_gates/gate_g1.py` | **10/10** |

Duplicate `const` scan on `tests/persistence.repositories.test.ts`: **0** duplicate top-level bindings (independent node script).

### F) Process flags (plain `key=value`)

Status: **PASS (replay)** / **PARTIAL (forge visibility)**

1. Canonical replay @ `43c8d56`:

```text
backend_real=true
frontend_real=false
transport_stub=true
classification=PARTIAL
Never COMPLETE while transport_stub=true. No product-done claim.
```

`PR_BODY` + `BASE_SHA=3a88d73` + `HEAD_SHA=8f4eeff` → `ci_gates/check_pr_phase_claims.py` exits **0**.

2. Public GitHub API returned empty PR #191 body (repo likely private); merge commit message contains title only — **could not independently certify forge PR description** without Origin credentials. This does not invalidate backend replay.

---

## Commands (audit replay log)

```bash
git fetch origin main
git rev-parse origin/main   # 43c8d56
npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts
npx firebase-tools emulators:exec --only firestore --project demo-sikander \
  "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"
bash ci_gates/gate_g0.sh
python3 ci_gates/gate_g1.py
PR_BODY='...' BASE_SHA=3a88d73 HEAD_SHA=8f4eeff python3 ci_gates/check_pr_phase_claims.py
```

---

## Classification summary

| Label | Auditor finding |
|---|---|
| backend_real | true (PASS) |
| frontend_real | false (PASS honesty) |
| transport_stub | true (expected) |
| Product DONE | **No** — capped at **PARTIAL** |
| Audit verdict | **PASS (low)** |
