# Independent forensic phase audit: Origin PR #213

Date: 2026-09-24
Repository: `shamail-sikander/cursor-init`
Origin PR: #213 (closed / landed)
Audited landed tip: `955bf5e8a01656172670789c6eb8a6a0bb8b3166`
Parent tip: `0b52925cfd8cf198316ebc7891a66f0d74f8af26`
Slice: TB seal-verifications transport-boundary external transport receipt acknowledgment reconciliation

## Verdict

| Layer | Result |
|---|---|
| Phase audit | **FAIL** |
| Product | **PARTIAL** |
| Severity | **major** |

The implementation substantiates `backend_real=true`, `frontend_real=true`, and
`transport_stub=true`; it must remain **PARTIAL**, never COMPLETE. The phase
audit nevertheless fails because replaying the repository's claim gate against
the actual Origin PR #213 description exits 1. The description does not
supply the machine-readable action-name-to-`app/ops/operator-audit-console.tsx`
evidence required for an `app/ops/**` change, nor the required concrete
`/api/...` fetch-path evidence. This is a release-process major, not a request
to obtain court credentials.

No blocker and no product-code defect were found in the audited slice. One
minor test-depth gap remains: the focused `/ops` test proves the lattice source
contains GET 477/478 and the custody reconcile POST, but it does not mount the
console and observe network requests; the new collection-specific Firestore
deny-write paths are inspected and covered by the general emulator trio rather
than directly attempted by a rules test.

## A–F audit matrix

### A. Scope and acceptance — PASS

The `0b52925..955bf5e` product delta contains the named dual-track
acknowledgment-reconciliation slice: governance, in-memory and Firestore
repositories, route surfaces, rules, `/ops` lattice wiring, and focused test.
`git diff --check` is clean.

The roadmap accurately scopes PR #213 to rows parented on the PR #206
acknowledgment parents and calls out views 477–478 plus the waiver reconcile
action (`docs/LEGAL_OS_ROADMAP.md:455-461`).

### B. Architecture and backend_real — PASS

- Both custody and closure IDs are generated through
  `buildWorkflowOpsChainedDocumentId`
  (`platform/persistence/workflowOpsAckReconTbSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationGovernance.ts:20-35`).
- The governance builders require both parent tracks to be acknowledged before
  reconciliation and calculate receipt-reference parity
  (`...Governance.ts:126-169` and `:289-330`).
- The route rejects a custody reconcile unless both parents are acknowledged
  (`app/api/d2/ops-reporting/route.ts:14770-14784`), then persists through the
  repository and in-memory map (`:14805-14813`). The closure sequence requires
  its digest checkpoint before reconcile (`:15067-15080`).
- Both adapter tracks expose Firestore `upsert`, `get`, `listByFirm`, and
  `listByMatter`; the emulator repository/runtime suite passed, including
  persistence after reset. This specifically guards against the PR #209
  closure-adapter failure remediated by PR #211.

### C. frontend_real — PASS

`readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice`
contains executable `/api/d2/ops-reporting` requests: GET view 477, GET view
478, then the custody POST reconcile
(`app/ops/operator-audit-console.tsx:3464-3518`). The focused test passed
2/2 and asserts the two view constants, GET method/path, POST action, and
ordering after the PR #206 checkpoint
(`tests/ops.pr-213-tb-external-transport-receipt-ack-reconciliation-frontend-real.test.ts:25-65`).

This is not an API-only scaffold. The test is source/lattice-level proof rather
than component-mounted request observation; add a request-spy interaction test
to remove the minor residual.

### D. Firestore, adapters, and security — PASS

The two new reconciliation collection rules grant only scoped reads and
explicitly deny all client writes (`firestore.rules:206-207`). The Firestore
adapter writes both new collections, and the in-memory store/repository types
are present. The required Firestore emulator trio passed 22/22, demonstrating
the adapter route/runtime integration after the PR #209 remediation.

Add direct emulator assertions that a partner, associate, and clerk cannot
write either new collection; the present rule test suite exercises generic
deny paths, not these two long collection names.

### E. Tests and gates — FAIL (major process gate)

| Check | Result |
|---|---|
| `npm test -- tests/ops.pr-213-tb-external-transport-receipt-ack-reconciliation-frontend-real.test.ts` | PASS — 2/2 |
| `npm run test:rules` | PASS — 3 files, 22/22 |
| `npm run gate:g0` | PASS |
| `npm run gate:g1` | PASS — 10/10 |
| `BASE_SHA=0b52925... HEAD_SHA=955bf5e... PR_BODY="$(origin pr view 213 --json description --jq .description)" python3 ci_gates/check_pr_phase_claims.py` | **FAIL** |

The exact PR description declares the three labels and says PARTIAL, but the
claim gate reports two violations:

1. missing action-name → `app/ops/operator-audit-console.tsx` evidence; and
2. missing concrete `/api/...` fetch-path evidence for the changed `/ops`
   path.

The prior canonicalized replay passed only after manually adding the evidence
the PR description itself omitted; it is therefore not valid as a pass for the
landed PR metadata.

### F. Label honesty, documentation, and #209-parent regression — FAIL (major)

The labels themselves are factually honest:

- `backend_real=true`: supported by real adapters and the green emulator trio.
- `frontend_real=true`: supported by GET 477/478 and POST reconcile lattice
  call sites plus the focused test.
- `transport_stub=true`: supported by `blocked_todo_firm`,
  `transport_stub:true`, and stub parity digests in the builders
  (`...Governance.ts:18`, `:164-167`, `:206`, `:328-329`, `:368`).
- Product status **PARTIAL**: correctly stated in the Origin PR and roadmap.

The independent phase verdict remains FAIL solely because the actual PR
metadata fails the mandatory claim gate. Amend equivalent future PR
descriptions to include, for example:

```text
view-477 -> app/ops/operator-audit-console.tsx -> /api/d2/ops-reporting
waiver-reconcile -> app/ops/operator-audit-console.tsx -> /api/d2/ops-reporting
```

## Disposition

Do not relabel this slice COMPLETE and do not seek live court or external
transport credentials as a remediation. The required fix is documentation and
release metadata: publish the concrete `/ops` action/view-to-fetch-path
evidence so the claim gate passes. A follow-up may also add direct rules
denial and mounted UI-request tests.
