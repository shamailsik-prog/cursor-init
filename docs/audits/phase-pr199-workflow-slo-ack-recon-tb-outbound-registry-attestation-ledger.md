# Independent Phase Auditor forensic audit: PR #199 ack-recon TB external distribution audit ledger partner handoff attestation + outbound registry attestation ledger (stub-honest)

Date: 2026-09-23  
Repo: `shamail-sikander/cursor-init`  
PR: `#199` → `main` (squash-merged)  
Main tip audited: `e00046ad270f14c4f7561eb4265f0218adcc77bb`  
Landed merge commit: `e00046a` (parent `7f3b0a3` — PR #198 independent audit docs for product #197)  
Stack base: `184372f` (PR #197 ack-recon TB external distribution audit ledger + partner handoff attestation)  
Product diff measured: `184372f..e00046a` (+1501/-35 product paths; **0** `app/ops/**` files)  
Claim-gate anchor on `main`: `ede9a9c` (`ci_gates/check_pr_phase_claims.py` plain `key=value` + table parsing)

## Verdict (lead)

**PASS (severity: low).**

Independent replay confirms dual-track **ack-recon TB external distribution audit ledger → partner handoff attestation (waiver/custody)** and **TB partner handoff attestation → outbound registry attestation ledger (variance/closure)** scaffolding is backend-real in memory and Firestore: hashed chained document IDs stay ≤1500 UTF-8 bytes (custody-id test + repository seeds + runtime-mode mega flow), Firestore deny-write rules for both new collections (`firestore.rules` L213–214), parent gates on finalized TB audit ledger / attested TB partner handoff in governance builders, `/api/d2/ops-reporting` two paginated GET views + six partner POST actions with digest-rebuild sync from PR #197 parents (mirrors PR #186 outbound-registry attestation-ledger pattern on TB chain), focused Vitest **131/131**, Firestore emulator trio **22/22**, **G-0 PASSED** and **G-1 10/10**, and claim-gate replay green on canonical stub-honest metadata (`184372f..e00046a`).

**Release / product classification remains PARTIAL** (not DONE): `transport_stub=true`, `externalTransportChannel: blocked_todo_firm`, provenance `transport_stub:true`, stub partner-handoff registry prefix `blocked_todo_firm:transport_stub_partner_handoff_registry`, and global filing transport `TODO(firm)` — honestly scoped; no COMPLETE/product-done claim in replay metadata.

**Non-blocking residuals:** (1) six new partner POST actions lack dedicated HTTP POST assertions in `tests/api.ops-reporting.test.ts` (GET view seeds in `tests/persistence.route-wiring.test.ts` L3966–3998 cover the new surfaces); (2) roadmap “in flight” section landed without a forge number (cosmetic only; forge merge is **#199**); (3) this audit does **not** start the queued NEXT PHASE slice (partner-delivery receipt freeze-override seal verification on TB outbound-registry attestation ledger).

---

## Scope and provenance checked

- Audited ref `e00046a`; parent `7f3b0a3` is docs-only (PR #198 audit for #197).
- Substantive product diff `184372f..e00046a`: 11 files touched on merge tip (includes roadmap in-flight note from product PR).
- Parent lineage: PR #197 @ `184372f` (TB ack-recon external distribution audit ledger + partner handoff attestation).
- Claimed test/gate commands executed independently @ `e00046a`.

---

## A–F verification matrix

### A) Architecture / BACKEND_REAL

Status: **PASS**

Evidence:

1. Row types + runtime maps in `platform/spine/store.ts` (types L4234–4313; maps L4650–4659) for waiver custody TB audit-ledger partner-handoff attestation and variance closure TB partner-handoff outbound-registry attestation-ledger child rows.
2. Memory repos `platform/persistence/spineRepositories.ts` and Firestore adapters `platform/persistence/firestoreSpineRepositories.ts` (`upsert` / `get` / `listByFirm` / `listAll`).
3. Firestore client deny-write (`firestore.rules` L213–214) for:
   - `…_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations` (waiver track)
   - `…_partner_handoff_attestation_outbound_registry_attestation_ledgers` (variance track, TB ack-recon chain)
4. Governance `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerGovernance.ts`:
   - IDs via **`buildWorkflowOpsChainedDocumentId`** (L19–34).
   - Waiver parent gate: TB external distribution audit ledger status `…_external_distribution_audit_ledger_finalized` (L83–86).
   - Variance parent gate: attested or finalized TB partner handoff attestation (L260–264).
   - Stub transport: `WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM`, `TRANSPORT_STUB_PROVENANCE_TAG` (`transport_stub:true`) (L16–17, L180, L196–203).
5. `/api/d2/ops-reporting`:
   - **Two** paginated GET `view=` surfaces (route-wiring L3966–3998): custody TB outbound-registry partner handoff attestations + closure TB outbound registry attestation ledgers.
   - **Six** partner POST action types added in product diff: waiver register outbound registry / attest partner handoff / outbound-registry freeze override checkpoint; variance checkpoint outbound attestation ledger / partner delivery receipt freeze override digest / control seal (TB-parent chain; same lifecycle pattern as PR #186).
   - Digest-rebuild sync from PR #197 TB audit-ledger and partner-handoff parents.

**Firestore ID length (checklist emphasis):**

- `tests/workflow-ops-custody-closure-firestore-id.test.ts` (TB outbound-registry child id case): `Buffer.byteLength` ≤1500 for both child id builders.
- `tests/persistence.repositories.test.ts` L2932–2969: seeded repo ids `.length` ≤1500 for both new row types.
- `tests/persistence.runtime-mode.test.ts`: persisted emulator docs with `entry.id.length <= 1500` for both new collections.

### B) Frontend honesty (`frontend_real=false`)

Status: **PASS**

1. Claimed labels: `frontend_real=false`.
2. Diff `184372f..e00046a` excludes `app/ops/**` (0 ops files).
3. No new `/ops` call sites for outbound-registry attestation-ledger / partner-handoff attestation actions.

### C) Transport stub honesty (`transport_stub=true`)

Status: **PASS**

1. Rows set `externalTransportChannel: "blocked_todo_firm"` and provenance includes `transport_stub:true`.
2. Partner-handoff builder uses `STUB_PARTNER_HANDOFF_REGISTRY_PREFIX` (`blocked_todo_firm:transport_stub_partner_handoff_registry`) for default attestation references (governance L17, L97–100, L169–171).
3. Global filing transport stubs remain (`platform/persistence/filingDispatchQueue.ts` → `TODO(firm)` / `blocked_todo_firm`).
4. Classification correctly capped at **PARTIAL**; replay metadata negates COMPLETE/product-done while `transport_stub=true`.

### D) SHA-on-main integrity

Status: **PASS**

1. Audited merge tip: `e00046ad270f14c4f7561eb4265f0218adcc77bb`.
2. Immediate parent `7f3b0a3` (PR #198 docs); product stack base `184372f` (PR #197) is ancestor of `e00046a`.

### E) Tests / rules / gates

Status: **PASS**

| Suite | Command | Result @ `e00046a` |
|---|---|---|
| Ops reporting + route wiring + custody-id | `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts` | **131/131** |
| Firestore trio | `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"` | **22/22** |
| G-0 | `bash ci_gates/gate_g0.sh` | **PASSED** |
| G-1 | `python3 ci_gates/gate_g1.py` | **10/10** |

`ci_gates/check_pr_phase_claims.py` with canonical `PR_BODY` (merge commit message) + `BASE_SHA=184372f` + `HEAD_SHA=e00046a` exits **0**.

### F) Docs / roadmap consistency

Status: **PASS**

1. Roadmap documents slice scope under in-flight heading (landed with product PR); forge merge is **#199** — independent audit pointer added in roadmap + ledger append.
2. Ledger append: `docs/LEGAL_OS_PHASE_VERIFICATION.md` (PR #199 targeted entry).
3. `NEXT PHASE` remains queued (TB partner-delivery receipt freeze-override seal verification); this audit does **not** chain the next feature.

---

## Key paths (pointers)

| Area | Path |
|---|---|
| Governance | `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerGovernance.ts` |
| Store types/maps | `platform/spine/store.ts` |
| Repositories | `platform/persistence/spineRepositories.ts`, `platform/persistence/firestoreSpineRepositories.ts` |
| Ops reporting | `app/api/d2/ops-reporting/route.ts` |
| Firestore rules | `firestore.rules` (L213–214) |
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

Independent Phase Auditor: **PASS (low)** for PR #199 backend slice @ `e00046a`. Do not treat `transport_stub=true` lanes as product-complete.
