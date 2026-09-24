# Independent Phase Auditor A–F audit: PR #219 outbound registry attestation ledger

Date: 2026-09-24  
Repository: `shamail-sikander/cursor-init`  
Origin PR: #219 (closed / landed)  
Audited landed tip: `2d7473bac4832058eb412274bbab277acc9eb7b4`  
Direct parent: `62480b2a106bd5ab0356eaf726f86aaa93538df8` (PR #218 audit docs; PR #217 product lineage)  
PR source replayed: `1d3f53fbedf1ea3463d3d1e0cc1bbebd9cdd39a3`

## Verdict

| Result | Finding |
|---|---|
| Phase audit | **PASS** |
| Product | **PARTIAL** |
| Blockers | **0** |
| Majors | **0** |
| Minors | **0** |

The landed delta is a real `/ops` integration layer over the already-present #199-shaped backend on the #217 parent chain. The exact PR metadata passes the claim gate. The explicit filing/partner transport stub is factual and caps the product at PARTIAL; it is not a request for court credentials.

## A. Scope and acceptance versus reality — PASS

`62480b2..2d7473b` changes four files: the operator console, one focused `/ops` test, a governance re-export, and the roadmap. It does not falsely claim a new transport implementation.

- The release metadata says `backend_real=true`, `frontend_real=true`, `transport_stub=true`, and `classification=PARTIAL`.
- Exact title/body replay against source `62480b2..1d3f53f` passes `ci_gates/check_pr_phase_claims.py`.
- The claim gate requires a focused `tests/ops*.test.ts` file and concrete `/api/...` evidence because `app/ops/**` changed; both are present.

## B. Architecture and backend reality — PASS

The two backend rows and actions pre-exist this frontend slice and are real route/repository flows, not stubs:

- custody registration requires a finalized external-distribution audit-ledger parent, builds the row, upserts its repository, writes the in-memory projection, audit-logs it, and returns an idempotent payload (`app/api/d2/ops-reporting/route.ts:27340-27404`);
- closure registration requires a finalized reconciliation plus available partner-handoff parent, then builds, persists, audit-logs, and idempotently returns the result (`app/api/d2/ops-reporting/route.ts:27125-27188`);
- the parent builders use chained IDs, enforce finalized/attested lifecycle status, and retain the explicit stub provenance (`platform/persistence/workflowOpsAckReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerGovernance.ts:16-31,81-203`).

PR #219's new governance file is honestly only a re-export anchor to the shared #199-shaped implementation, rather than a second or pretend implementation.

## C. Frontend reality — PASS

`readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice()` contains the claimed executable requests:

- GET custody partner-handoff-attestation view **481** and closure outbound-registry-attestation-ledger view **482** at `app/ops/operator-audit-console.tsx:3614-3646`;
- POST finalize of the #217 external-distribution audit ledger at `app/ops/operator-audit-console.tsx:3598-3611`;
- POST custody outbound-registry partner-handoff registration and closure outbound-registry-attestation-ledger registration at `app/ops/operator-audit-console.tsx:3647-3678`.

Every call targets `/api/d2/ops-reporting`. The focused source-level test asserts the views, POST methods, actions, helper invocation, and ordering after the #217 record action (`tests/ops.pr-tb-outbound-registry-attestation-ledger-frontend-real.test.ts:25-75`). This is a real UI call-site addition, not API-only scaffolding.

## D. Data, Firestore, security, and governance honesty — PASS

The inherited GET route branches call firm-scoped repositories, then filter by classification clearance, matter, lifecycle status, freshness, and `checkPermission(..., "research", ...)` before pagination (`app/api/d2/ops-reporting/route.ts:11082-11151`). The inherited Firestore collection rules permit cleared same-firm reads and deny direct writes (`firestore.rules:201-202,218-219`).

PR #219 does not modify `firestore.rules`, collections, or persistence adapters; an emulator rerun is therefore not required by the rules-touched criterion. No schema or security claim is attributed to this UI-only delta beyond the verified inherited surfaces.

## E. Tests and gates — PASS

Executed at `2d7473b`:

| Command | Result |
|---|---|
| `npm test -- --run tests/ops.pr-tb-outbound-registry-attestation-ledger-frontend-real.test.ts` | PASS — 2/2 |
| `npm test -- --run tests/persistence.route-wiring.test.ts -t "outbound-registry"` | PASS — 3/3 (the claimed two new views plus one pre-existing matching test) |
| `npm test -- --run tests/persistence.route-wiring.test.ts` | PASS — 124/124 |
| exact PR #219 `PR_TITLE`/`PR_BODY` replay with `BASE_SHA=62480b2..`, `HEAD_SHA=1d3f53f..` | PASS |
| `bash ci_gates/gate_g0.sh` | PASS |
| `python3 ci_gates/gate_g1.py` | PASS — 10/10 |

The focused UI test and complete route-wiring suite directly exercise the claimed read surfaces. The added UI invokes the three named POST actions; their inherited route handlers enforce parent-state gates before persistence. No Firestore rules changed in this PR, so no emulator test was run.

## F. Docs, labels, and regressions — PASS

The PR description, roadmap, added re-export, call sites, test, and runtime routes consistently say that this is an outbound-registry ledger link after #217—not a live external delivery feature. The landed SHA has parent `62480b2`, and `git diff --check 62480b2 2d7473b` is clean.

## Recommendation

Retain `classification=PARTIAL` while `platform/persistence/filingDispatchQueue.ts` continues to expose `TODO(firm)` and `blocked_todo_firm`. Re-audit this chain only when a non-stub transport replaces that boundary; no human credential escalation is appropriate for this audit.
