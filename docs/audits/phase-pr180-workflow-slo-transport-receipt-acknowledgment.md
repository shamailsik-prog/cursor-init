# Independent Phase Auditor forensic audit: PR #180 archival-export custody handoff + closure attestation external transport receipt acknowledgment (stub-honest)

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#180` (`cursor/external-transport-receipt-ack-2b25` → `main`, merged)  
Main tip audited: `bf93647907c870c9dc639a55b4575655f445356c` (`origin/main` @ audit close)  
Landed merge commit: `bf93647` (parents `38b4291` + slice head `a5b691fef059cc19f223bd9c78a35d12860411f4`)  
Stack base (PR body anchor): `38b42913c1fe` (post PR #179 docs re-audit merge)  
Claim-gate anchor on `main`: `ede9a9c` (plain `key=value` + markdown-table parsing in `ci_gates/check_pr_phase_claims.py`)

## Verdict (lead)

**PASS (severity: low).**

Backend-real **external transport receipt acknowledgment** scaffolding on two parent tracks (archival-export custody handoff and transport-boundary closure attestation) is verified independently: durable rows, memory + Firestore repositories, Firestore deny-write rules, `buildWorkflowOpsChainedDocumentId` / `woa:<sha256>` document IDs ≤1500 UTF-8 bytes (stacked on PR #174), `/api/d2/ops-reporting` views + six partner POST actions with stub-honest acknowledge semantics (`blocked_todo_firm`, `transport_stub:true`), focused Vitest **105/105** on the claimed lane, Firestore emulator trio **22/22**, G-0/G-1 green, and claim-gate replay green on PR #180 metadata.

**Product scope remains PARTIAL** (not DONE) because `transport_stub=true` — honestly labeled; no COMPLETE/product-done claim.

**Non-blocking residuals:** (1) five of six new partner POST actions lack dedicated HTTP assertions in `tests/api.ops-reporting.test.ts` (one custody-handoff view list test covers seeded rows + stub channel/provenance); (2) POST `Body` union types omit optional checkpoint reference / digest fields used at runtime (`request.json()` cast), producing `tsc` errors on `app/api/d2/ops-reporting/route.ts` for this slice while Vitest lanes stay green; (3) `docs/LEGAL_OS_ROADMAP.md` still headings this slice as “PR #175 (pending)” though it landed as PR #180.

Builder stub `docs/audits/phase-prXXX-workflow-slo-archival-export-custody-handoff-external-transport-receipt-acknowledgment.md` was **not** used as evidence (marked PENDING; superseded by this file).

---

## Scope and provenance checked

- Phase merge claim: PR #180 closed merged (`origin pr view 180`); `origin/main` @ audit close `bf93647` (`git fetch origin main` + fast-forward).
- Landed commit message and diff surface: `git diff --name-only 38b4291..a5b691f` → **13 paths**; **excludes** `app/ops/**`.
- Claimed test/gate commands executed independently in this audit run @ `bf93647`.
- PR #174 `buildWorkflowOpsChainedDocumentId` is on lineage (`62c863b` ancestor of `bf93647`); PR #175 custody/closure parent entities and PR #178 repositories compile fix are prerequisites on `main` before this slice.

---

## A–F verification matrix

### A) BACKEND_REAL

Status: **PASS**

Evidence:

1. Durable row models in runtime store (`platform/spine/store.ts`):
   - `WorkflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentRow`
   - `WorkflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentRow`
2. Memory repository wiring (`platform/persistence/spineRepositories.ts`) and Firestore adapters (`platform/persistence/firestoreSpineRepositories.ts`) for both collections (`upsert` / `get` / `listByFirm` / `listAll`).
3. Firestore rules deny client writes (`firestore.rules` L195–196) for:
   - `workflow_ops_alert_waiver_expiry_..._archival_export_custody_handoff_external_transport_receipt_acknowledgments`
   - `workflow_ops_alert_variance_remediation_..._closure_attestation_external_transport_receipt_acknowledgments`
4. Governance helper `platform/persistence/workflowOpsAlertArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentClosureAttestationExternalTransportReceiptAcknowledgmentGovernance.ts`:
   - Child ids via **`buildWorkflowOpsChainedDocumentId`** (PR #174); `WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM`, `WORKFLOW_OPS_EXTERNAL_TRANSPORT_RECEIPT_STUB_REFERENCE`, provenance `transport_stub:true`.
   - Acknowledge builders default `externalTransportReceiptReference` to stub reference when acknowledging.
5. `/api/d2/ops-reporting` exposes two paginated GET views + **six** partner POST actions with shared idempotency cache + `persistAuditEntriesSince` audit write-through:
   - **Views:** `alert_waiver_expiry_..._archival_export_custody_handoff_external_transport_receipt_acknowledgments`, `alert_variance_remediation_..._closure_attestation_external_transport_receipt_acknowledgments`
   - **Actions (custody-handoff track):** `checkpoint_workflow_ops_alert_waiver_expiry_..._archival_export_custody_handoff_external_transport_receipt_acknowledgment`, `acknowledge_workflow_ops_alert_waiver_expiry_..._archival_export_custody_handoff_external_transport_receipt`, `control_workflow_ops_alert_waiver_expiry_..._archival_export_custody_handoff_external_transport_receipt_acknowledgment_finalization`
   - **Actions (closure-attestation track):** `checkpoint_workflow_ops_alert_variance_remediation_..._transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_digest`, `acknowledge_workflow_ops_alert_variance_remediation_..._closure_attestation_external_transport_receipt`, `control_workflow_ops_alert_variance_remediation_..._closure_attestation_external_transport_receipt_acknowledgment_finalization`
6. Ops-reporting digest refresh materializes both row types (governance `buildWorkflowOpsAlert*ExternalTransportReceiptAcknowledgmentRow` + repository `upsert` in refresh loop).

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

Evidence:

1. PR #180 metadata declares `frontend_real=false` (plain `key=value` lines in body).
2. Diff `38b4291..a5b691f` excludes `app/ops/**`.
3. No new `/ops` call sites required for this slice.

### C) No COMPLETE overclaim

Status: **PASS**

Evidence:

1. PR metadata: `classification=PARTIAL`, explicit **Not COMPLETE / not product-done** and stub-honest acknowledge posture.
2. Roadmap bounds scope to internal scaffolding; no DONE product assertion for external transport.
3. Filing transport TODO/stub markers remain repo-wide (`platform/persistence/filingDispatchQueue.ts` → `TODO(firm)` / `blocked_todo_firm`).
4. Negated disclaimer phrasing is not treated as an affirmative COMPLETE claim by `check_pr_phase_claims.py` (verified via replay).

### D) SHA-on-main integrity

Status: **PASS**

Evidence:

1. User-claimed main anchor `bf93647907c870c9dc639a55b4575655f445356c` is current `origin/main` tip (`git rev-parse origin/main`).
2. Slice head `a5b691fef059cc19f223bd9c78a35d12860411f4` is ancestor of `origin/main` (`git merge-base --is-ancestor a5b691f bf93647`).
3. Landed merge commit `bf93647` second parent is slice head `a5b691f` (matches user-supplied feature SHA).

### E) Focused tests + gates

Status: **PASS** (with non-blocking HTTP coverage + `Body` typing gaps noted above)

Executed and observed green (independent rerun @ `bf93647`):

| Suite | Command | Result |
|---|---|---|
| Ops reporting + route wiring + Firestore id unit | `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts` | **105** passed |
| Firestore parity trio | `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"` | **22** passed |
| G-0 | `bash ci_gates/gate_g0.sh` | PASS |
| G-1 | `python3 ci_gates/gate_g1.py` | PASS (**10** tests) |

Additional evidence:

- **`tests/persistence.repositories.test.ts` compiles and runs** under emulator: external-transport acknowledgment round-trip uses distinct symbols (`closureAttestationId`, `transportBoundaryReceiptReconciliationClosureAttestation`, `closureAttestationExternalTransportReceiptAcknowledgmentId`) — no duplicate `const closureAttestation` regression from PR #175.
- `tests/workflow-ops-custody-closure-firestore-id.test.ts` asserts `woa:[a-f0-9]{64}` ids ≤1500 bytes for external-transport acknowledgment child rows under deep parents.
- `tests/persistence.route-wiring.test.ts` wires both new GET views to repository `listByFirm` adapters.
- `tests/persistence.runtime-mode.test.ts` asserts both new Firestore collection names after ops-reporting mega flow.
- `tests/api.ops-reporting.test.ts` → `lists custody handoff external transport receipt acknowledgment rows after governance seed` asserts `blocked_todo_firm` + `transport_stub:true` on listed rows.

Auditor note: full-project `npx tsc --noEmit` reports missing optional fields on two new POST `Body` types in `route.ts` (runtime JSON still carries fields); not exercised by Vitest POST assertions for checkpoint/digest actions.

### F) Process flags

Status: **PASS**

Evidence:

1. PR #180 body includes machine-parseable release labels (`backend_real=true`, `frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`) plus human PARTIAL / no product-done disclaimer.
2. Live `ci_gates/check_pr_phase_claims.py` replay with `BASE_SHA=38b4291`, `HEAD_SHA=a5b691f`, PR #180 title/body → exit **0** (`PASS: PR phase-claim gate.`).
3. Claim-gate anchor `ede9a9c` is on `main` lineage (`git merge-base --is-ancestor ede9a9c bf93647`).

---

## Classification summary

| Label | Auditor result |
|---|---|
| `backend_real` | **PASS** (persistence + ops-reporting + stub-honest governance) |
| `frontend_real` | **PASS** as honesty (`false`; no `app/ops` delta) |
| `transport_stub` | **true** (ack paths + row defaults remain `blocked_todo_firm`) |
| Product DONE / COMPLETE | **Blocked** (correctly not claimed) |
| **Final phase verdict** | **PASS** |
| **Severity** | **low** |
