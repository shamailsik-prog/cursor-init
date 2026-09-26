# Independent Phase Auditor A–F audit: PR #235 TB ack-recon outbound-registry attestation ledger

> **Verdict (2026-09-26): FAIL — 0 blockers, 1 major, 0 new minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: #235 (closed / squash-landed)  
Audited landed tip: `93cb5c0d10ad0028e0f7aa31e3029bbc28619cd0`  
Parent before land: `a0f73c286f3f180f3af380696273b8fd8c55b2ab`

## Executive finding

**Lattice-integrity finding: FAIL (major).** The squash did not truncate the
files: `route.ts` grew from 33,182 to 33,798 lines and the `/ops` source still
contains GET steps 485–494. However, the public GET 492 parent view is
semantically replaced by GET 494 in `parseView`. The console still issues its
declared GET 492 request, but the parser returns the 494 child view and the
route lists child rows. This breaks the required 491/492 parent chain
end-to-end, so source presence and the passing grep-oriented tests are not
sufficient for acceptance.

## Verified labels and product classification

| Claim | Independent result |
|---|---|
| `backend_real=true` | PARTIAL — 493/494 handlers, governance builders, memory/Firestore repositories, and rules are present; the required 492 parent GET contract is broken by route parsing. |
| `frontend_real=true` | **FAIL** — the `/ops` call site is concrete, but its 492 request does not render/list the requested parent surface. |
| `transport_stub=true` | PASS — `transport_stub:true` and `blocked_todo_firm` are explicit and fail-closed. |
| `classification=PARTIAL` | PASS — transport stubbing correctly precludes COMPLETE; no live court transport credentials are required. |

## A. Scope, acceptance, and merge lattice integrity — FAIL (major)

- Git confirms the audited tip is `93cb5c0` with direct parent `a0f73c2`.
  `route.ts` is exactly **33,182 → 33,798** lines; its diff is 618 lines
  (617 additions, one deletion). `operator-audit-console.tsx` is
  **4,629 → 4,755** lines.
- The executable console lattice retains source steps 485, 486, 487, 488, 489,
  490, 491, 492, 493, and 494. GET 493/494 appear after the 491/492 lifecycle,
  and the new block has six concrete POST calls to `/api/d2/ops-reporting`.
- This physical preservation is not functional parent preservation. The 492
  view string is accepted only by a `parseView` branch that maps it to the 494
  child string. No preceding `return value` branch accepts the original 492
  string. Consequently the 492 console query reaches the 494 route branch.

**Required fix:** keep the existing 492 view string as `return value`, remove
the parent-to-child remap, and add a route assertion proving a 492 query returns
the parent row/status rather than a 494 row. Retain distinct exact-value branches
for 493 and 494.

## B. Architecture and `backend_real` — PARTIAL

- The new 493/494 POST handlers validate finalized/attested parent prerequisites,
  build rows, persist through repository adapters, write audit records, and
  maintain idempotency.
- The #233 remediation remains intact: the deny-by-default Firestore binder
  maps both parent and child workflow-ops keys and factory construction is
  exercised by the emulator suite.
- The broken 492 parser contract means the stated “on 491/492 parents”
  architecture cannot be accepted end-to-end. The defect is introduced by this
  landed PR and is not the inherited #205 persistence minor.

## C. `frontend_real` — FAIL (major)

- `readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice`
  has concrete GET `/api/d2/ops-reporting` call sites for 491/492 and 493/494,
  followed by **6/6** POST call sites for the new slice.
- GET 491, 493, and 494 are covered by repository route-wiring tests and pass.
  The test suite does not assert GET 492’s returned parent shape/status.
- The console’s 492 request supplies the parent `partner_handoff_attestations`
  view. `parseView` converts it to
  `partner_handoff_attestations_outbound_registry_attestation_ledgers`; this is
  494, not 492. Therefore the claimed parent UI surface is API-call scaffolding
  with incorrect runtime semantics, not a valid frontend-real completion.

## D. Data, Firestore, security, and governance honesty — PASS

- `npm run test:rules` passes **22/22**: Firestore rules 7, repository adapter
  1, and runtime persistence mode 14.
- The deny-by-default binder explicitly maps parent and new child collections;
  server repositories provide `upsert`, `get`, `listByFirm`, and `listByMatter`.
- Governance records retain `transport_stub:true`, use the
  `blocked_todo_firm` external channel, and do not add external court transport
  credentials. Client write denial and same-firm/classification protections stay
  covered by the emulator rules tests.

## E. Tests and gates — FAIL overall

| Command | Independent result |
|---|---|
| `npx vitest run tests/ops.pr-tb-ack-recon-outbound-registry-attestation-ledger-493-494-frontend-real.test.ts tests/persistence.route-wiring.test.ts tests/api.ops-reporting.test.ts` | PASS — 3 files, **133/133** |
| `npm run test:rules` | PASS — 3 files, **22/22** |
| `npm run gate:g0` | PASS |
| `npm run gate:g1` | PASS — **10/10** |
| Exact closed-PR #235 metadata replay through `check_pr_phase_claims.py` | PASS |

The focused tests prove the source call sites and 491/493/494 repository
responses, but they omit the 492 parent-response regression. The claim gate
correctly validates metadata format; it does not prove parser semantics.

## F. Docs, labels, and regressions — FAIL due to major

- The closed PR body correctly supplies all three labels, `classification=PARTIAL`,
  `/ops` action-to-call-site evidence, a focused `tests/ops*.test.ts`, and the
  concrete `/api/d2/ops-reporting` path. Its exact metadata replay passes with
  `BASE_SHA=a0f73c2...` and `HEAD_SHA=93cb5c0...`.
- The labels are nevertheless overbroad at the landed tip: source-level
  `frontend_real=true` is contradicted by the 492 → 494 remap. The accepted
  terminal Product classification remains PARTIAL solely because
  `transport_stub=true`.

## Final classification

**Phase audit: FAIL (0 blockers, 1 major, 0 new minors). Product: PARTIAL.**

The merge is physically complete, not truncated. Its critical defect is
functional lattice damage: GET 492 has been remapped to GET 494. Restore the
492 parser identity and add returned-row assertions for all four surfaces
491–494 before a re-audit.
