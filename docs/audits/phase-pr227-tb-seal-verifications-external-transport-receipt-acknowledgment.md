# Independent Phase Auditor A–F audit: PR #227 TB seal-verifications external transport receipt acknowledgment

> **Verdict (2026-09-24): PASS — 0 blockers, 0 majors, 1 inherited minor. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: #227 (closed / landed)  
Audited tip: `8547426fb89b3999b3f3f30610d88a48db5eece6`  
Direct parent: `fd3bf60c9b92d63b55a3c80afb6ef3c49e9efb6f`

## Verified labels and classification

| Claim | Independent result |
|---|---|
| `backend_real=true` | PASS |
| `frontend_real=true` | PASS |
| `transport_stub=true` | PASS — honest transport boundary |
| `classification=PARTIAL` | PASS — `transport_stub=true` precludes COMPLETE |

The closed Origin body contains the three machine-readable labels, two GET view mappings,
six action-to-`app/ops/operator-audit-console.tsx` mappings, and concrete
`/api/d2/ops-reporting` evidence. Replaying that exact metadata at
`fd3bf60..8547426` passes the claim gate.

## A. Scope and acceptance versus reality — PASS

- The landed commit is a single-parent squash from `fd3bf60` and changes only the
  claimed route, `/ops` call sites, persistence-test import, roadmap, governance
  re-export, and focused call-site test.
- This is not API-only scaffolding: the route exposes both monitored child
  collections and six state-changing actions, while `/ops` invokes them after its
  485/486 parent reconciliation lifecycle.
- No claim of live filing, court transport, or external credentials is made. The
  phase remains product **PARTIAL**, not COMPLETE.

## B. Architecture and `backend_real` — PASS

- `platform/persistence/workflowOpsAckReconTbOutboundRegistrySealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentGovernance.ts:6-14`
  truthfully re-exports the established builders for the outbound-registry
  485/486 parent chain.
- `app/api/d2/ops-reporting/route.ts:341` imports that boundary module; its
  repository sync/list paths include both acknowledgment collections (for example,
  `:4402-4414`), and the targeted API suite executes GET 487/488 successfully.
- The repository adapters exist for both tracks in
  `platform/persistence/spineRepositories.ts:4434-4482` and
  `platform/persistence/firestoreSpineRepositories.ts:3819-3854`.

## C. `frontend_real` — PASS

- `app/ops/operator-audit-console.tsx:3934-3960` performs concrete GET calls for
  custody view 487 and closure view 488 to `/api/d2/ops-reporting`.
- `:3961-4055` contains all six concrete lifecycle POST call sites in order:
  custody checkpoint, acknowledge, finalization; closure digest checkpoint,
  acknowledge, finalization.
- `tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-frontend-real.test.ts:49-103`
  asserts both views, all six action identifiers, methods, endpoint, and that the
  first new POST follows view 488. The focused test passes 2/2; the 485/486 parent
  focused test also passes 2/2.

## D. Data, Firestore, security, and governance honesty — PASS

- The collections are represented by memory and Firestore repositories; the store
  holds both track maps at `platform/spine/store.ts:4986-4995`.
- Inherited Firestore rules grant only same-firm, cleared-data reads and deny all
  direct client writes for the two 487/488 collections:
  `firestore.rules:212-213`.
- Stub provenance remains explicit in `/ops` request data
  (`blocked_todo_firm` at `app/ops/operator-audit-console.tsx:3971-3972` and
  `:4018-4019`). The governance re-export does not misrepresent this as live
  transport.

## E. Tests and gates — PASS, inherited minor recorded

| Command | Result |
|---|---|
| `npx vitest run tests/ops.pr-tb-outbound-registry-seal-verifications-external-transport-ack-frontend-real.test.ts tests/ops.pr-tb-outbound-registry-seal-transport-boundary-reconciliation-frontend-real.test.ts tests/api.ops-reporting.test.ts` | PASS — 3 files, 8/8 tests |
| exact Origin #227 `PR_TITLE`/`PR_BODY`, `BASE_SHA=fd3bf60`, `HEAD_SHA=8547426` `python3 ci_gates/check_pr_phase_claims.py` | PASS |
| `npm run gate:g0` | PASS |
| `npm run gate:g1` | PASS — 10/10 |
| `npm run test:rules` | 21/22 pass — 7 rules + 14 runtime-mode pass; one inherited persistence failure |

**Minor (inherited):** `tests/persistence.repositories.test.ts:3017` references an
undefined long-form reconciliation-row builder. `git blame` attributes that line
at the audited base to `cee14af` (PR #205), not #227. The #227 test diff changes
only the module import at line 3044; it does not introduce the failing reference.
This does not invalidate the PR #227 API or `/ops` evidence, but it leaves the
repository-adapter emulator mega-test non-green.

Recommendation: repair or remove the stale builder reference in a dedicated
persistence-test follow-up, then restore the emulator suite to 22/22.

## F. Docs, labels, and regressions — PASS

- The PR body is label- and claim-gate-honest; no COMPLETE/product-done assertion
  conflicts with the active transport stub.
- `docs/LEGAL_OS_ROADMAP.md` advances to a subsequent reconciliation slice without
  claiming live external transport.
- No blockers or majors were found. The inherited test minor is documented above
  rather than being attributed to #227.

## Final classification

**Phase audit: PASS (0 blockers, 0 majors, 1 inherited minor). Product: PARTIAL.**
The accepted transport stub is a truthful terminal boundary; it does not make the
product COMPLETE and requires no live-court or external-credential escalation.
