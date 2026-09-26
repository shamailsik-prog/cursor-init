# Independent Phase Auditor A–F audit: PR #239 TB ack-recon PD freeze-override seal verification GET 495–496

> **Verdict (2026-09-26): PASS — 0 blockers, 0 majors, 2 minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: [#239](https://cursor.com/codebase/shamail-sikander/cursor-init/pull/239) (closed / squash-landed)  
Audited landed tip: `9265559c3d9f9debf9fdb6a0fac399995443fa19`  
Parent before land (#241 docs): `a66f6e6b6f6ffe2570e52cb14e669962d754532c`  
Pre-squash PR branch tip (forge metadata only): `b5e8e97dd41a` (ref no longer fetchable after squash)

Evidence log: `/opt/cursor/artifacts/pr239_verification.log`

## Executive finding

The squash on `main` delivers the claimed **495–496** lattice extension without truncating the
**485–494** chain. `parseView` remains **identity-only** for the TB ack-recon slice (including
**491/492** after #237/#240). Six partner-governed lifecycle POSTs, deny-by-default Firestore
binding for both new repositories, and `/ops` call sites are present and exercised by a **full**
focused vitest run (**155/155**, **0 skipped**). `transport_stub=true` correctly caps product at
**PARTIAL**; no COMPLETE claim.

## A. Scope, acceptance, and labels — PASS

| Source | Claim | Independent result |
|---|---|---|
| PR #239 body | GET **495–496**, six lifecycle POSTs on 493/494 parents | **PASS** — matches `docs/LEGAL_OS_ROADMAP.md` slice `cursor/tb-ack-recon-pd-freeze-seal-495-496-820e` |
| PR #239 body | `backend_real=true`, `frontend_real=true`, `transport_stub=true`, `classification=PARTIAL` | **PASS** — flags present; explicit “not COMPLETE” disclaimer |
| PR #239 body | `route.ts` +600 lines (33,795 → 34,395) | **PASS** — `a66f6e6` → `9265559`: **33,795 → 34,395** (+600) |
| PR #239 body | `parseView` identity 491–496, no 491→493 / 492→494 remaps | **PASS** — full `parseView` body (lines 535–808): only `return "activity"`, `return value`, or `return undefined`; dedicated branches for 492 (L791) before 494 (L797); 495 (L800) before 496 (L803) |
| CM caveat | Focused vitest with `-t` filter (17 passed, **128 skipped**) | **Minor** — auditor re-ran **full** files; see §E |

**PR metadata hygiene (minor):** PR body cites HEAD `72d4d2d…` and base `0f27bc1`; squash tip is
`9265559…` with parent `a66f6e6…`. Line counts align with `a66f6e6`; SHA drift is documentation-only.

## B. Lattice integrity — PASS

| Artifact | Before (`a66f6e6`) | After (`9265559`) | Δ |
|---|---:|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 33,795 | 34,395 | +600 |
| `app/ops/operator-audit-console.tsx` | 4,755 | 4,887 | +132 |

- Squash diff (`a66f6e6..9265559`): 12 files, +1,503 / −2 lines; no deletions inside the TB lattice block.
- New POST block comment at route **L33961** (`PR slice 495-496`); prior **493–494** block at **L33546** intact.
- GET handlers for **495** / **496** at **L11718** / **L11753**, after **494** at **L11682**.
- `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS` in `tests/persistence.route-wiring.test.ts` lists slices **485–496** in order (12 entries); `it.each` asserts `json.view === requestedView` for every slice.
- **495/496 POST actions in route:** six handlers (custody checkpoint / attest verified / finalize + closure checkpoint / attest verified / finalize), matching roadmap “six partner-governed lifecycle POST actions”.
- **`/ops` wiring:** `readAckReconTbSealVerificationTransportBoundaryReceiptReconciliationLattice` adds GET **495–496** and **6/6** POST `runApiCallAllowingStatuses` entries after 493/494 control POSTs (ordering asserted in `tests/ops.pr-tb-ack-recon-pd-freeze-seal-495-496-frontend-real.test.ts`).

## C. `parseView` and dispatch — PASS

- Read **entire** `parseView` function (535–808, 274 lines). No non-identity returns.
- No `normalizeView` or alias layer on the GET path; dispatch uses `parseView(url.searchParams.get("view"))` only.
- Regression guard: `it("ops reporting parseView identity: GET 492/493/494/495/496 each resolve…")` plus 12-case `it.each` identity suite.
- **491/492 parent chain:** preserved at landed tip (post-#237/#240). `expect(json.view).toBe(view492)` test at route-wiring **L6285** still enforces 492 ≠ 494 shadowing.

## D. Persistence — PASS

- New governance module: `platform/persistence/workflowOpsAckReconTbSealVerificationsOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationGovernance.ts`.
- Deny-by-default binder maps both **495** and **496** repository keys with explicit collection paths (`denyByDefaultWorkflowOpsRepository.ts` L26–29); factories expose `upsert`, `get`, `listByFirm`, `listByMatter` (no undefined factory / #231 class).
- `firestoreSpineRepositories.ts` wires both keys through `createDenyByDefaultWorkflowOpsRepository` (L4102+, L4168+).
- `spineRepositories.ts` memory adapters implement `.get` / `.upsert` for both keys.
- `firestore.rules` updated in squash diff; `npm run test:rules` **22/22** including mega repository round-trip.

Inherited **#205** `persistence.repositories` minor: **not newly regressed** (22/22 at tip).

## E. Tests and gates — PASS (with minor noise)

| Command | Result |
|---|---|
| Focused vitest (5 files, **no** `-t` filter) | **5 files, 155 passed, 0 skipped** |
| `npm run test:rules` | **3 files, 22 passed** |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10** |
| `npx vitest run tests/pr-phase-claim-gate.test.ts` | **20/20** (Vitest worker `onTaskUpdate` timeout logged once; tests green) |
| `check_pr_phase_claims.py` `BASE_SHA=a66f6e6`, `HEAD_SHA=9265559`, PR #239 body | **PASS** |
| `check_pr_phase_claims.py` `HEAD_SHA=b5e8e97dd41a` | **SKIP** — ref absent after squash |

**Skipped tests:** none in the auditor’s full focused run. CM’s **128 skipped** tests were an artifact of `-t "TB ack-recon lattice GET|495|496|parseView identity"` on `persistence.route-wiring.test.ts`, not a product gap.

## F. `frontend_real` — PASS

- Concrete GET `/api/d2/ops-reporting` with correct `view` query strings for **495** and **496** in `operator-audit-console.tsx` (steps labeled “(495)” / “(496)”).
- Six POST actions use `/api/d2/ops-reporting` with full action strings; transport honesty via `blocked_todo_firm:transport_stub_*:ops_probe` only (no live credentials, no TODO API scaffolds).

## Findings summary

| ID | Severity | Finding |
|---|---|---|
| PR239-M1 | **minor** | Closed PR body HEAD SHA (`72d4d2d`) ≠ squash tip (`9265559`); does not affect landed code. |
| PR239-M2 | **minor** | Builder “focused vitest” used `-t` filter → 128 skipped; independent full run required for phase sign-off. |

## Final classification

| Dimension | Verdict |
|---|---|
| **Phase audit** | **PASS** (0 blockers, 0 majors, 2 minors) |
| **Product** | **PARTIAL** (`transport_stub=true`; COMPLETE invalid) |
| `backend_real` | **PASS** (scoped) |
| `frontend_real` | **PASS** |
| `transport_stub` | **PASS** (honest) |

---

## Auditor replay commands

```bash
git rev-parse 9265559c3d9f9debf9fdb6a0fac399995443fa19 a66f6e6b6f6ffe2570e52cb14e669962d754532c
wc -l app/api/d2/ops-reporting/route.ts
git show a66f6e6:app/api/d2/ops-reporting/route.ts | wc -l

npx vitest run \
  tests/persistence.route-wiring.test.ts \
  tests/api.ops-reporting.test.ts \
  tests/ops.pr-tb-ack-recon-pd-freeze-seal-495-496-frontend-real.test.ts \
  tests/ops.pr-tb-ack-recon-outbound-registry-attestation-ledger-493-494-frontend-real.test.ts \
  tests/ops.pr-tb-ack-recon-external-distribution-audit-ledger-frontend-real.test.ts

npm run test:rules && npm run gate:g0 && npm run gate:g1
npx vitest run tests/pr-phase-claim-gate.test.ts
```
