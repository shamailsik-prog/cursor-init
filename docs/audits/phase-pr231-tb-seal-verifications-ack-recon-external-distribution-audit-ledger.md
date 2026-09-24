# Independent Phase Auditor A–F audit: PR #231 TB seal-verifications acknowledgment-reconciliation external-distribution audit ledger

> **Verdict (2026-09-24): FAIL — 0 blockers, 1 major, 0 minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: #231 (closed / squash-landed)  
Audited landed tip: `15088d49ef273379f13d66e5ddc1043dd57ef01c`  
Parent before land: `c987491df65e1389883a8f278fecbf22b557bb20`  
Original PR head: `6897d0103efc3c47c80a377d2d0c06916c210744`

## Verified labels and classification

| Claim | Independent result |
|---|---|
| `backend_real=true` | **FAIL** — Firestore repository construction crashes at runtime. |
| `frontend_real=true` | PASS — the executable `/ops` lattice has GET 491/492 and all six concrete POST call sites. |
| `transport_stub=true` | PASS — explicit and fail-closed. |
| `classification=PARTIAL` | PASS — the transport stub precludes COMPLETE. |

## A. Scope, acceptance, and merge lattice integrity — PASS

- The landed change is a real 11-file product slice: route, `/ops` lattice,
  governance, store/repositories, focused tests, and roadmap.
- **Lattice-integrity finding: PASS.** The original PR-head `route.ts` is
  15,887 lines; `15088d4` is 33,182 lines. A direct comparison shows 17,295
  route lines restored by the squash resolution, matching the merge note rather
  than landing the truncated head.
- The landed `/ops` lattice contains all eight GET view steps **485–492**:
  parent 485/486, parent 487/488, direct parents 489/490, and new 491/492.
  The route retains 40 reconciliation-view token occurrences, and the focused
  route/API suite executes the relevant route code.

## B. Architecture and `backend_real` — FAIL (major)

- The route contains typed GET 491/492 view handling and six lifecycle POST
  handlers. The new governance builders model finalized-parent prerequisites,
  repository writes, audit entries, idempotency, and the fail-closed transport
  state.
- **Major regression:** this landed change adds two calls to
  `createDenyByDefaultWorkflowOpsRepository` in
  `platform/persistence/firestoreSpineRepositories.ts`, but no such function
  exists anywhere in that module or persistence directory. Blame attributes the
  two references to `15088d4`; the direct parent contains neither reference.
- Consequently `createFirestoreRepositories()` throws
  `ReferenceError: createDenyByDefaultWorkflowOpsRepository is not defined`.
  This prevents Firestore-mode route persistence from initializing, so
  `backend_real=true` cannot be sustained despite the in-memory targeted route
  tests passing.

**Required fix:** replace both undefined placeholder calls with real Firestore
adapters (the adjacent `upsert/get/listByFirm/listByMatter` repository shape),
or add a correctly scoped helper with that concrete behavior. Run the complete
Firestore/persistence suite afterward; do not merely suppress the failing
tests.

## C. `frontend_real` — PASS

- `readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice`
  calls GET `/api/d2/ops-reporting` for **491** custody audit-ledger and **492**
  closure partner-handoff-attestation views after the 489/490 parent lifecycle.
- It contains **6/6** concrete POST call sites to the same endpoint:
  custody checkpoint, record, finalization; closure register, attest,
  finalization.
- Both direct 489/490 parent GETs and their six lifecycle POSTs remain present
  immediately before 491/492. This is not the prior 3/6 wiring defect.
- The focused `/ops` and route/API suite passes **4 files, 133 tests**.

## D. Data, Firestore, security, and governance honesty — FAIL (major)

- Governance remains honest: the builders and UI preserve
  `transport_stub:true` and `blocked_todo_firm`; no live court or external
  transport credential is introduced or needed.
- The relevant Firestore rules remain same-firm, classification-cleared,
  role-gated read-only surfaces with client writes denied.
- However, the new undefined repository helper means the server cannot
  initialize its Firestore repository graph. `npm run test:rules` reports
  **7 passed / 15 failed**: rules pass, while the repository test and all 14
  runtime-mode tests fail from the same new `ReferenceError`.

## E. Tests and gates — FAIL overall

| Command | Result |
|---|---|
| Focused FE + API + route-wiring Vitest suite | PASS — 4 files, 133/133 |
| Exact closed-PR claim-gate replay | PASS |
| `npm run gate:g0` | PASS |
| `npm run gate:g1` | PASS — 10/10 |
| `npm run test:rules` | **FAIL — 7/22 pass; 15 fail** |

This failure is not the inherited `cee14af` / #205 test-reference minor. The
direct parent lacks the undefined helper calls; the two offending references
were introduced by `15088d4` and break the full Firestore repository factory.

## F. Docs, labels, and regressions — FAIL due to major

- The closed PR metadata accurately declares the three required labels,
  machine-readable `/ops` mappings, a focused `tests/ops*.test.ts`, and
  concrete `/api/d2/ops-reporting` evidence. Replaying it with
  `BASE_SHA=c987491...` and `HEAD_SHA=15088d4...` passes the claim gate.
- The label `backend_real=true` is nevertheless false at the landed tip because
  Firestore persistence cannot initialize. The phase audit therefore fails,
  even though the metadata-format gate passes.

## Final classification

**Phase audit: FAIL (0 blockers, 1 major, 0 minors). Product: PARTIAL.**

The squash merge correctly preserved the complete GET 485–492 route and
operator-console lattice; truncation is **not** the defect. The blocking major
is the new undefined Firestore repository helper. Keep the product PARTIAL:
`transport_stub=true` is accepted as the terminal transport boundary and must
not be converted into a COMPLETE claim or a request for live credentials.
