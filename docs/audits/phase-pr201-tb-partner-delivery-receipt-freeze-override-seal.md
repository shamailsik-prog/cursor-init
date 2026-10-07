# Independent Phase Auditor forensic audit: PR #201 ack-recon TB partner-delivery receipt freeze-override seal verification (stub-honest)

Date: 2026-09-24  
Repo: `shamail-sikander/cursor-init`  
PR: `#201` (`cursor/tb-partner-delivery-receipt-freeze-override-seal-62f3` → `main`, merged)  
Main tip audited: `8bb1f1c8720bffe6eba074a45a8dbc6961d92eb1` (`origin/main` @ audit close)  
Pre-squash implementation head: `21284861895232aa4ddc6f575a073d2cb7173390`  
Stack base: `23839a67bce6` (post PR #200 audit docs on `main`)  
Product parent: **PR #199** @ `e00046a` (TB outbound-registry attestation-ledger / partner-handoff attestation)  
Analogue: **PR #188** (archival ack-recon partner-delivery-receipt freeze-override seal verification on PR #186 parents)  
Claim-gate anchor on `main`: `ede9a9c` (plain `key=value` + table parsing in `ci_gates/check_pr_phase_claims.py`)

**Cursor Manager refined packet (2026-09-24):** audited @ exact tip `8bb1f1c8720bffe6eba074a45a8dbc6961d92eb1` (short `8bb1f1c`); subject matches merge `ack-recon TB partner-delivery receipt freeze-override seal verification (stub-honest) (#201)`. Builder evidence **superseded** — do not cite `docs/audits/phase-pr200-workflow-slo-ack-recon-tb-partner-delivery-receipt-freeze-override-seal-verification.md`. Raised bar: `transport_stub=true` alone permits **accepted PARTIAL** product status; non-transport slice claims must be backend-real (no API-only scaffold, no COMPLETE while stubs remain).

## Verdict (lead)

| Layer | Result |
|---|---|
| **Phase audit (backend + claim honesty)** | **PASS** (severity: **low**) |
| **Product / release classification** | **PARTIAL** — never COMPLETE while `transport_stub=true` |

**PASS** — not a rubber stamp: independent replay failed paths that would trigger **FAIL** under the raised bar (false `frontend_real=true`, COMPLETE/product-done, or API-only scaffold) were not found; backend + Firestore + route wiring are exercised by tests @ `8bb1f1c`.

Independent replay confirms dual-track **ack-recon TB partner-delivery receipt freeze-override seal verification** child rows parented on PR #199 TB outbound-registry attestation-ledger chain endpoints are backend-real in memory and Firestore: `buildWorkflowOpsChainedDocumentId` (`woa:<sha256>`) keeps document IDs ≤1500 UTF-8 bytes (custody-id test, repository seeds, runtime-mode mega flow under emulator), two new Firestore deny-write collections, governance builders with parent posture gates and stub-honest transport provenance, `/api/d2/ops-reporting` two paginated GET views + six partner POST lifecycle actions (checkpoint / attest verified / control finalization per track) with digest-rebuild sync from PR #199 parents, focused Vitest **130/130**, Firestore emulator trio **22/22**, **G-0 PASSED** and **G-1 10/10**, and claim-gate replay green on canonical PR #201 metadata (`23839a67..2128486`).

**Product / release classification remains PARTIAL** (not DONE) because `transport_stub=true`, `externalTransportChannel: blocked_todo_firm`, and global filing transport stubs remain — honestly labeled in PR metadata; no COMPLETE/product-done claim. Under the raised 2026-09-24 completeness bar this is **accepted PARTIAL**, not rubber-stamped product-DONE.

**Non-blocking residuals:** (1) six new partner POST actions lack dedicated HTTP POST assertions in `tests/api.ops-reporting.test.ts` (GET view wiring L5700–5729 covers the two new monitoring surfaces); (2) builder stub `docs/audits/phase-pr200-workflow-slo-ack-recon-tb-partner-delivery-receipt-freeze-override-seal-verification.md` and roadmap section **PR #200** vs forge merge **#201** (numbering drift only); (3) PR body “Tb-prefixed” refers to TypeScript request body types (`*TbOutboundRegistry*`) and lifecycle naming pattern — wire action strings are long snake_case, not a literal `tb_` prefix; (4) product diff also extends digest-sync action allowlist for intermediate chain rows (94 new `parsed.action ===` branches in route diff) beyond the six primary seal-verification lifecycle actions — expected for chained refresh, not a completeness blocker.

Builder stubs (`phase-pr200-…`, `phase-prXXX-…` freeze-override seal packet) were **not** used as evidence (superseded by this file).

---

## Scope and provenance checked

- PR #201 merged on `main`; squash tip `8bb1f1c`; substantive commit `2128486` is ancestor of tip.
- Product diff measured `23839a67..2128486` → **12 implementation paths**; **excludes** `app/ops/**` (0 ops files).
- Parent lineage: PR #199 @ `e00046a`; PR #188 pattern for seal-verification lifecycle on ack-recon chain.
- Claimed test/gate commands executed independently @ `8bb1f1c`.
- User-supplied main SHA `8bb1f1c8720bffe6eba074a45a8dbc6961d92` matches audited tip prefix; full git object is `…d92eb1` (40-char).

---

## A–F verification matrix

### A) BACKEND_REAL

Status: **PASS**

Evidence:

1. Durable row models in `platform/spine/store.ts` (diff adds waiver + variance TB deepest seal-verification row types with `externalTransportChannel: "blocked_todo_firm"` and status enums).
2. Memory repositories in `platform/persistence/spineRepositories.ts` and Firestore adapters in `platform/persistence/firestoreSpineRepositories.ts` (`upsert` / `get` / `listByFirm` / `listAll`) for both new collections.
3. Firestore client write deny rules (`firestore.rules` diff adds L216–217) for:
   - `…_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications` (waiver / custody TB track)
   - `…_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications` (variance / closure TB track)
4. Governance `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationGovernance.ts`:
   - Child ids via **`buildWorkflowOpsChainedDocumentId`**.
   - Parent posture gates on PR #199 TB partner-handoff / outbound-registry attestation ledger snapshots (backlog counters when parent not checkpointed/finalized).
   - Stub transport: `WORKFLOW_OPS_EXTERNAL_TRANSPORT_CHANNEL_BLOCKED_TODO_FIRM`, provenance `transport_stub:true`.
5. `/api/d2/ops-reporting`:
   - **Two** paginated GET `view=` surfaces (route-wiring L5700–5729): custody + closure TB outbound-registry seal-verification monitoring rows.
   - **Six** partner POST lifecycle actions for this slice (added in product diff): waiver checkpoint / attest verified / control finalization; variance checkpoint / attest verified / control finalization — handlers upsert into the two new deepest repositories (e.g. POST handlers ~L23448–L23862) with idempotency + `persistAuditEntriesSince` audit write-through.
     - *Update (7 Oct 2026, final audit F8):* `persistAuditEntriesSince` has been removed. The action now only appends its rows to `store.audit`; withSession persists the request's own rows once, by object, in the end-of-request audit flush (`platform/persistence/requestAuditFlush.ts`) and answers 503 `AUDIT_UNAVAILABLE` if that flush fails. The text above records the code as audited at the time.
   - Digest-rebuild sync from PR #199 TB parents during mega refresh (route diff includes parent-key wiring for new store maps).

**Firestore ID length (checklist emphasis):**

- `tests/workflow-ops-custody-closure-firestore-id.test.ts` case “ack-recon TB outbound-registry seal verification child rows” (L79–100): `Buffer.byteLength` ≤1500 for both id builders; imports governance module for PR #201 slice.
- `tests/persistence.repositories.test.ts` L3008–3009: seeded repo ids `.length` ≤1500 for both new TB outbound-registry seal-verification row types.
- `tests/persistence.runtime-mode.test.ts` L9835–9865: persisted emulator docs with `entry.id.length <= 1500` for both new collections in mega flow.

### B) FE honesty (`frontend_real=false`) — CM emphasis (honesty vs overclaim)

Status: **PASS** (FE gap **not** a blocker — labels honest)

CM provisional: `frontend_real` **false**; no `/ops` UI for TB seal-verification surfaces unless proven otherwise.

1. PR #201 metadata: plain `key=value` `frontend_real=false` (not `true` — a `frontend_real=true` claim without `/ops` call sites would be **FAIL**, severity **major**).
2. Diff `23839a67..2128486` and merge `8bb1f1c` exclude `app/ops/**` (0 ops files).
3. **Grep proof @ `8bb1f1c`:** `rg -i 'freeze_override_seal|TbOutbound|partner_delivery_receipt_freeze_override_seal' app/ops/` → **no matches**; `app/ops/operator-audit-console.tsx` → **no matches** for TB seal-verification / freeze-override seal / outbound-registry seal strings.
4. API-only backend slice with honest `frontend_real=false` → **PASS/PARTIAL** under raised bar; **not** FAIL solely for missing `/ops` when UI was not claimed.

### C) No COMPLETE overclaim (raised bar)

Status: **PASS**

1. PR metadata: `classification=PARTIAL`, explicit negated product-done disclaimer; `transport_stub=true`.
2. Roadmap labels slice **PR #200** in-flight; forge merge is **#201** — documentation drift only.
3. Filing transport stubs remain globally (`platform/persistence/filingDispatchQueue.ts` → `TODO(firm)` / `blocked_todo_firm`).
4. No API-only scaffold: governance + repos + rules + route POST/GET + emulator/runtime tests exercise the slice end-to-end.

### D) SHA-on-main integrity (+ label/FE consistency gate)

Status: **PASS**

**SHA (verify exact tip):**

1. `git rev-parse origin/main` → `8bb1f1c8720bffe6eba074a45a8dbc6961d92eb1` (short `8bb1f1c`); `git log -1 --oneline` → `ack-recon TB partner-delivery receipt freeze-override seal verification (stub-honest) (#201)`.
2. Squash merge `8bb1f1c`; implementation head `2128486`; stack base `23839a67`.
3. `git merge-base --is-ancestor 2128486 8bb1f1c` → true; `git merge-base --is-ancestor e00046a 8bb1f1c` → true (PR #199 parent).

**Honesty gate (CM check D):** `frontend_real=false` + no `/ops` call sites (section **B**) + `classification=PARTIAL` + `transport_stub=true` → consistent; **no FAIL** for missing UI. Would **FAIL** if PR claimed **COMPLETE** or `frontend_real=true` without `operator-audit-console.tsx` (or other `/ops`) call-site proof.

### E) Focused tests + gates

Status: **PASS**

Executed independently @ `8bb1f1c`:

| Suite | Command | Result |
|---|---|---|
| Route wiring + custody Firestore id | `npx vitest run tests/persistence.route-wiring.test.ts tests/workflow-ops-custody-closure-firestore-id.test.ts` | **130** passed, exit **0** |
| Firestore parity (auditor standard trio) | `npm run test:rules` | **22** passed, exit **0** |
| G-0 | `npm run gate:g0` | PASS |
| G-1 | `npm run gate:g1` | PASS (**10/10**) |

Duplicate test `const` symbols: scan of `tests/persistence.repositories.test.ts` → **0** duplicate identifiers (separate `RULES` bindings per test file are expected and not duplicate-symbol violations).

Non-blocking: no per-action HTTP POST tests for the six new partner seal-verification actions.

### F) Process flags (post-`ede9a9c`)

Status: **PASS**

1. PR #201 body uses machine-parseable plain `key=value` release labels plus human PARTIAL disclaimer.
2. `ci_gates/check_pr_phase_claims.py` replay with PR #201 title/body, `BASE_SHA=23839a67`, `HEAD_SHA=2128486` → exit **0** (`PASS: PR phase-claim gate.`).
3. `ede9a9c` is on `main` lineage (`git merge-base --is-ancestor ede9a9c 8bb1f1c`).

---

## Release labels (auditor confirmation)

| Flag | PR claim | Auditor finding |
|---|---|---|
| backend_real | true | **PASS** (memory + Firestore + route wiring + emulator mega flow) |
| frontend_real | false | **PASS** (no `/ops` diff) |
| transport_stub | true | **PASS** (stub-honest; caps product at PARTIAL) |
| classification | PARTIAL | **PASS** (no COMPLETE/product-done) |

---

## Key paths

| Area | Path |
|---|---|
| Governance | `platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationGovernance.ts` |
| Spine | `platform/spine/store.ts` |
| Repositories | `platform/persistence/spineRepositories.ts`, `platform/persistence/firestoreSpineRepositories.ts` |
| Ops reporting | `app/api/d2/ops-reporting/route.ts` |
| Firestore rules | `firestore.rules` (new deny-write matches at L216–217) |
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

Independent Phase Auditor: **PASS (low)** for PR #201 backend slice @ `8bb1f1c` / `2128486`. Do not treat `transport_stub=true` lanes as product-complete. Builder `phase-pr200-…` stub is non-evidentiary (superseded by this document).
