# Independent Phase Auditor forensic audit: PR #197 ack-recon TB external transport receipt acknowledgment reconciliation → external distribution audit ledger + partner handoff attestation (stub-honest)

Date: 2026-09-23  
Repo: `shamail-sikander/cursor-init`  
PR: `#197` → `main` (squash-merged)  
Main tip audited: `184372f42bec20cb7f8a9fb3fdc17ccc2fe4b8f4`  
Landed merge commit: `184372f` (parent `b02a8f5` — PR #196 independent audit docs for product #195)  
Stack base: `a7ae742` (PR #195 ack-recon external transport receipt acknowledgment reconciliation)  
Product diff measured: `a7ae742..184372f` (+1679/-51 product paths; **0** `app/ops/**` files)  
Claim-gate anchor on `main`: `ede9a9c` (`ci_gates/check_pr_phase_claims.py` plain `key=value` + table parsing)

## Verdict (lead)

**PASS (severity: low).**

Independent replay confirms dual-track **ack-recon TB acknowledgment-reconciliation → external distribution audit ledger (waiver/custody)** and **partner handoff attestation (variance/closure)** scaffolding is backend-real in memory and Firestore: hashed chained document IDs stay ≤1500 UTF-8 bytes (custody-id test + repository seeds + runtime-mode mega flow), Firestore deny-write rules for both new collections (`firestore.rules` L211–212), parent reconciliation-finalized gates in governance builders, `/api/d2/ops-reporting` two paginated GET views + six partner POST actions with digest-rebuild sync from PR #195 reconciliation parents, focused Vitest **128/128**, Firestore emulator trio **22/22**, **G-0 PASSED** and **G-1 10/10**, and claim-gate replay green on canonical stub-honest metadata (`a7ae742..184372f`).

**Release / product classification remains PARTIAL** (not DONE): `transport_stub=true`, `externalTransportChannel: blocked_todo_firm`, provenance `transport_stub:true`, stub partner-handoff registry prefix `blocked_todo_firm:transport_stub_partner_handoff_registry`, and global filing transport `TODO(firm)` — honestly scoped; no COMPLETE/product-done claim in replay metadata.

**Non-blocking residuals:** (1) six new partner POST actions lack dedicated HTTP POST assertions in `tests/api.ops-reporting.test.ts` (GET view seeds in `tests/persistence.route-wiring.test.ts` L5499–5528 cover the new surfaces); (2) `docs/LEGAL_OS_ROADMAP.md` labels this slice **PR #196** while forge merge is **#197** (numbering drift only; governance file header also references PR #196); (3) builder stub `docs/audits/phase-pr196-workflow-slo-ack-recon-tb-ack-recon-external-distribution-audit-ledger-partner-handoff-attestation.md` was **not** used as evidence (superseded by this file).

---

## Scope and provenance checked

- Audited ref `184372f`; parent `b02a8f5` is docs-only (PR #196 audit for #195).
- Substantive product diff `a7ae742..184372f`: 13 files touched on merge tip (includes roadmap + builder stub from product PR).
- Parent lineage: PR #195 @ `a7ae742` (`..._external_transport_receipt_acknowledgment_reconciliations` on TB ack-recon chain).
- Claimed test/gate commands executed independently @ `184372f`.

---

## A–F verification matrix

### A) Architecture / BACKEND_REAL

Status: **PASS**

Evidence:

1. Row types + runtime maps in `platform/spine/store.ts` (types L4145–4214; maps L4555–4564) for waiver custody external-distribution audit ledger and variance closure partner-handoff attestation child rows on TB acknowledgment-reconciliation parents.
2. Memory repos `platform/persistence/spineRepositories.ts` and Firestore adapters `platform/persistence/firestoreSpineRepositories.ts` (`upsert` / `get` / `listByFirm` / `listAll`).
3. Firestore client deny-write (`firestore.rules` L211–212) for:
   - `…_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers` (waiver track)
   - `…_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations` (variance track)
4. Governance `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationGovernance.ts`:
   - IDs via **`buildWorkflowOpsChainedDocumentId`** (L18–33).
   - Waiver parent gate: reconciliation status `…_reconciliation_finalized` (L81–84).
   - Variance parent gate: `ack_recon_…_reconciliation_finalized` (L228–231).
   - Stub transport: `WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM`, `TRANSPORT_STUB_PROVENANCE_TAG` (`transport_stub:true`) (L15–16, L182, L195–202).
5. `/api/d2/ops-reporting`:
   - **Two** paginated GET `view=` surfaces (route-wiring L5499–5528): custody TB ack-recon external distribution audit ledgers + closure TB ack-recon partner handoff attestations.
   - **Six** partner POST action types (L6079–6128): waiver checkpoint / record entry / control finalization on TB ack-recon audit ledger; variance register outbound registry / attest / control finalization on TB ack-recon partner handoff.
   - Digest-rebuild sync from PR #195 acknowledgment-reconciliation parents (route module; same pattern as prior ack-recon slices).

**Firestore ID length (checklist emphasis):**

- `tests/workflow-ops-custody-closure-firestore-id.test.ts` L348–368: `Buffer.byteLength` ≤1500 for both child id builders.
- `tests/persistence.repositories.test.ts` L2932–2933: seeded repo ids `.length` ≤1500.
- `tests/persistence.runtime-mode.test.ts` L9787–9817: persisted emulator docs with `entry.id.length <= 1500`.

### B) Frontend honesty (`frontend_real=false`)

Status: **PASS**

1. Claimed labels: `frontend_real=false`.
2. Diff `a7ae742..184372f` excludes `app/ops/**` (0 ops files).
3. No new `/ops` call sites for audit-ledger / partner-handoff attestation actions.

### C) Transport stub honesty (`transport_stub=true`)

Status: **PASS**

1. Rows set `externalTransportChannel: "blocked_todo_firm"` and provenance includes `transport_stub:true`.
2. Partner-handoff builder uses `STUB_PARTNER_HANDOFF_REGISTRY_PREFIX` (`blocked_todo_firm:transport_stub_partner_handoff_registry`) for default attestation references (governance L16, L242–243).
3. Waiver audit-ledger builder emits `transport_stub:reconciliation_finalized:*` digest anchors when parent finalized without explicit anchor (governance L99–102).
4. Global filing transport stubs remain (`platform/persistence/filingDispatchQueue.ts` → `TODO(firm)` / `blocked_todo_firm`).
5. Classification correctly capped at **PARTIAL**; replay metadata negates COMPLETE/product-done while `transport_stub=true`.

### D) SHA-on-main integrity

Status: **PASS**

1. Audited merge tip: `184372f42bec20cb7f8a9fb3fdc17ccc2fe4b8f4`.
2. Immediate parent `b02a8f5` (PR #196 docs); product stack base `a7ae742` (PR #195) is ancestor of `184372f`.

### E) Tests / rules / gates

Status: **PASS**

| Suite | Command | Result @ `184372f` |
|---|---|---|
| Ops reporting + route wiring + custody-id | `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts` | **128/128** |
| Firestore trio | `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"` | **22/22** |
| G-0 | `bash ci_gates/gate_g0.sh` | **PASSED** |
| G-1 | `python3 ci_gates/gate_g1.py` | **10/10** |

`ci_gates/check_pr_phase_claims.py` with canonical `PR_BODY` + `BASE_SHA=a7ae742` + `HEAD_SHA=184372f` exits **0**.

### F) Docs / roadmap consistency

Status: **PASS (with numbering drift noted)**

1. Roadmap section **PR #196** documents slice scope; forge merge is **#197** (same drift pattern as #194/#195 and #192/#193).
2. Roadmap builder stub pointer superseded by this independent audit + ledger append.
3. Ledger append: `docs/LEGAL_OS_PHASE_VERIFICATION.md` (PR #197 targeted entry).
4. `NEXT PHASE` placeholder remains queued; this audit does **not** chain the next feature.

---

## Key paths (pointers)

| Area | Path |
|---|---|
| Governance | `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationGovernance.ts` |
| Store types/maps | `platform/spine/store.ts` |
| Repositories | `platform/persistence/spineRepositories.ts`, `platform/persistence/firestoreSpineRepositories.ts` |
| Ops reporting | `app/api/d2/ops-reporting/route.ts` |
| Firestore rules | `firestore.rules` (L211–212) |
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

---

## Auditor closure

Independent Phase Auditor: **PASS (low)** for PR #197 backend slice @ `184372f`. Do not treat `transport_stub=true` lanes as product-complete. Builder `phase-pr196-…` stub is non-evidentiary until superseded (this document).
