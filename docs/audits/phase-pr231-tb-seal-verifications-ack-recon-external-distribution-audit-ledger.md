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

## Re-audit — remediation PR #233 at `a075adb` (2026-09-24)

> **Verdict: PASS — 0 blockers, 0 new majors, 1 inherited minor. Product: PARTIAL.**

Audited remediation tip: `a075adb04b87406571ef3fdb1688d703c1fe7fad`
Remediation commit: `a075adb fix(persistence): wire deny-by-default Firestore repos for ops 491–492 (#233)`
Prior product failure: `15088d49ef273379f13d66e5ddc1043dd57ef01c` (#231)
Prior audit-doc commit: `95b0a4bd135eefbca26e22ac4953d4c0fb0e33ba` (#232)

### A. Prior-FAIL closure — PASS

- The #231 regression is closed, not suppressed: the remediation adds
  `platform/persistence/denyByDefaultWorkflowOpsRepository.ts`, whose explicit
  collection map covers both 491/492 spine keys and whose binder implements
  `upsert`, `get`, `listByFirm`, and `listByMatter`.
- `createFirestoreRepositories()` imports and instantiates that binder before
  assigning the two 491/492 repositories. This removes the prior unbound-name
  `ReferenceError` at factory construction.
- The required real emulator rerun is green: `npm run test:rules` reports
  **3 files, 22/22 tests passed** (rules 7, repositories 1, runtime mode 14).

### B. Architecture and `backend_real` — PASS

- The mapped binder is fail-closed for unknown property keys and binds only the
  two explicit deny-by-default Firestore collection paths. Its repositories
  use server-side Firestore access for persistence and query rows by firm or
  matter after loading the mapped collection.
- The route and repository-wiring suites execute the 491 persistence route
  path; the runtime-mode emulator suite passes after the in-memory reset.
  `backend_real=true` is now substantiated by functioning repository
  construction and the full persistence suite.

### C. `frontend_real` and lattice integrity — PASS

- `app/ops/operator-audit-console.tsx` retains the end-to-end 485–492 lattice:
  489/490 direct parent views precede 491/492, and the latter pair is followed
  by **6/6** lifecycle POSTs to `/api/d2/ops-reporting`.
- The focused frontend tests cover the 489/490 parent regression and the
  491/492 continuation; the full focused FE/API/route-wiring run is **4 files,
  133/133 tests passed**. This is a concrete operator-console call site, not
  API-only scaffolding or a missing FE call site.

### D. Data, Firestore, and security — PASS

- Firestore rules preserve same-firm, classification-cleared, role-gated reads
  with client writes denied for the workflow-ops collections. The rules suite
  passes **7/7**, including expected denied writes.
- Stub posture is unchanged and honest: the governance module retains
  `transport_stub:true` and `blocked_todo_firm`. No court or external
  transport credentials were added or exercised.

### E. Tests and release gates — PASS

| Command | Independent result |
|---|---|
| Focused FE/API/route wiring (4 files) | PASS — **133/133** |
| `npm run test:rules` | PASS — **22/22** |
| `npm run gate:g0` | PASS |
| `npm run gate:g1` | PASS — **10/10** |
| Exact closed-PR #231 metadata replay through `check_pr_phase_claims.py` | PASS |

### F. Labels and regressions — PASS

- The closed #231 metadata's `backend_real=true`, `frontend_real=true`, and
  `transport_stub=true` labels are now consistent with the audited target.
  The claim-gate replay validates its `classification=PARTIAL` posture.
- Product classification remains **PARTIAL**, never COMPLETE, because
  `transport_stub=true` is accepted as a product boundary but precludes a
  COMPLETE claim.
- The pre-existing #205 `persistence.repositories` minor is not newly
  regressed by this remediation and is non-blocking here; its repository suite
  passes in the mandated 22/22 emulator run.

**Re-audit classification: Phase audit PASS (0 blockers, 0 new majors, 1
inherited minor); Product PARTIAL.**
