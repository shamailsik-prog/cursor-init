# Independent Phase Auditor forensic audit: PR #172 workflow alert adjudication SLO partner-delivery receipt freeze-override seal verification + archival-export partner-delivery transport-boundary receipt reconciliation

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
PR: `#172` (`cursor/freeze-override-seal-transport-boundary-reconciliation-29ce` → `main`, merged)  
Main tip audited: `ab27a3c379755bccd43026200925c2d988b068a8` (`origin/main` @ audit close)  
Landed merge commit: `13c37e5` (parents `fc4d96d` + slice head `8fec696ab14e3f5863ee8c535f406d59b551ede8`)  
Implementation stack base: `632d8f8` (PR #170 merge; slice branched here — **not** from docs-only `fc4d96d`)  
Claim-gate anchor on `main` (post-`ede9a9c`): table + `key=value` label parsing in `ci_gates/check_pr_phase_claims.py`

## Verdict (lead)

**FAIL (severity: major).**

Memory-mode scaffolding, route wiring, governance builders, Firestore deny-write rules, and label honesty (`frontend_real=false`, `transport_stub=true`, `classification=PARTIAL`) are largely as claimed, but **Firestore persistence mode is broken** for this slice: chained workflow-ops document IDs exceed Firestore’s **1500-byte document-ID limit**, causing the standard mega-flow runtime-mode test to fail on `main` after merge. That contradicts the builder’s implied “green tests” posture for backend_real + Firestore parity and fails checklist **A** (Firestore leg) and **E** (full focused Firestore suite).

**Product / release classification remains PARTIAL** (not DONE) because `transport_stub=true` — unchanged.

Builder stub `docs/audits/phase-prXXX-workflow-slo-partner-delivery-receipt-freeze-override-seal-verification-archival-export-transport-boundary-receipt-reconciliation.md` was **not** used as evidence (marked PENDING; superseded by this file).

---

## Scope and provenance checked

- PR #172 closed merged (`origin pr view 172`); `origin/main` @ audit close `ab27a3c`.
- Merge subject: `Merge pull request #172: freeze-override seal verification + transport-boundary receipt reconciliation`.
- Slice head `8fec696` is merge parent-2 and an ancestor of `ab27a3c`.
- `git show --stat 13c37e5` → **11 implementation paths** (+ follow-up docs commit `ab27a3c` on roadmap only); **excludes** `app/ops/**`.
- Provenance note: merge parent-1 `fc4d96d` is the PR #170 **auditor docs** commit on `main`, parallel to slice branch from `632d8f8` (`git merge-base fc4d96d 8fec696` → `632d8f8`). Non-blocking merge hygiene; implementation diff correctly measured as `632d8f8..8fec696`.
- Claimed commands executed independently @ `ab27a3c` (implementation unchanged since `8fec696`).

---

## A–F verification matrix

### A) BACKEND_REAL

Status: **FAIL (major)**

Evidence (present):

1. Durable row models in `platform/spine/store.ts` for freeze-override seal verification and transport-boundary receipt reconciliation tracks.
2. Memory repositories in `platform/persistence/spineRepositories.ts` and Firestore adapters in `platform/persistence/firestoreSpineRepositories.ts` (`upsert` / `get` / `listByFirm` / `listAll`).
3. Firestore client write deny rules (`firestore.rules` L191–192) for both new collections.
4. Governance helper `platform/persistence/workflowOpsAlertPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationGovernance.ts` (deterministic IDs, status builders, backlog counters).
5. `/api/d2/ops-reporting`: two paginated GET views + **six** new partner POST actions with shared idempotency cache + `persistAuditEntriesSince` audit write-through (verified in route diff `632d8f8..8fec696`).

Evidence (blocking):

6. **Firestore document IDs exceed platform limit** after full chained lineage from the ops-reporting refresh mega flow. Example seal-verification doc id length **2042 UTF-8 bytes** (limit **1500**). Emulator error on `main` @ `ab27a3c`:

   `INVALID_ARGUMENT: The key path element name is longer than 1500 bytes.`

7. `tests/persistence.runtime-mode.test.ts` → `persists workflow/court-ops activity index and rehydrates reporting after reset` **passes @ `632d8f8`**, **fails @ `8fec696` / `ab27a3c`** during the same mega flow (regression introduced by PR #172 entity chain).

8. `tests/persistence.repositories.test.ts` round-trips seeded rows with **shorter** synthetic IDs and still passes — does **not** disprove production-length ID failure in integrated refresh.

**Auditor finding:** `backend_real=true` is **overclaimed** for Firestore-backed runtime mode; in-memory + API wiring alone are insufficient for this repo’s backend_real bar.

### B) FE honesty (`frontend_real=false`)

Status: **PASS**

1. PR #172 metadata: plain `key=value` `frontend_real=false`.
2. Diff `632d8f8..8fec696` and merge `13c37e5` exclude `app/ops/**`.
3. No new `/ops` call sites for seal-verification / transport-boundary reconciliation actions.

### C) No COMPLETE overclaim

Status: **PASS**

1. PR metadata: `classification=PARTIAL`, explicit negated product-done disclaimer while `transport_stub=true`.
2. Roadmap labels match PARTIAL; no DONE product assertion for this slice.
3. Filing transport stubs remain (`platform/persistence/filingDispatchQueue.ts` → `TODO(firm)` / `blocked_todo_firm`).
4. Claim-gate negation parsing accepts disclaimer phrasing (see **F**).

### D) SHA-on-main integrity

Status: **PASS**

1. `origin/main` @ audit close: `ab27a3c379755bccd43026200925c2d988b068a8` (post-merge roadmap SHA record).
2. Feature merge: `13c37e5`; slice head: `8fec696` (matches user-supplied SHAs).
3. `git merge-base --is-ancestor 8fec696 ab27a3c` → true; `git merge-base --is-ancestor 13c37e5 ab27a3c` → true.

### E) Focused tests + gates

Status: **FAIL (major)**

Executed independently @ `ab27a3c`:

| Suite | Command | Result |
|---|---|---|
| Ops reporting + route wiring | `npx vitest run tests/api.ops-reporting.test.ts tests/persistence.route-wiring.test.ts` | **98** passed, exit **0** |
| Ops reporting + route wiring + claim-gate unit | `+ tests/pr-phase-claim-gate.test.ts` | **118** passed, exit **0** (Vitest worker `onTaskUpdate` timeout noise — recurring, non-blocking) |
| Firestore parity (auditor standard) | `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts tests/persistence.runtime-mode.test.ts tests/firestore.rules.test.ts"` | **21 passed, 1 failed**, exit **1** |
| G-0 | `bash ci_gates/gate_g0.sh` | PASS |
| G-1 | `python3 ci_gates/gate_g1.py` | PASS (**10** tests) |

Failure detail:

- `tests/persistence.runtime-mode.test.ts` → `persists workflow/court-ops activity index and rehydrates reporting after reset` — Firestore write rejected (1500-byte doc id limit) after PR #172 collections participate in refresh persistence.

Builder PR **Testing** section lists only api/route-wiring + G-0/G-1 — **omits** the Firestore emulator trio that prior independent audits treat as mandatory for backend_real workflow-ops slices. That omission masked the regression.

Non-blocking residual (recurring): **zero** dedicated HTTP assertions in `tests/api.ops-reporting.test.ts` for the six new partner POST actions (same pattern as #170/#156).

### F) Process flags (post-`ede9a9c`)

Status: **PASS**

1. PR #172 body uses machine-parseable plain `key=value` release labels plus human `classification=PARTIAL`.
2. `ci_gates/check_pr_phase_claims.py` replay with verbatim PR #172 title/body, `BASE_SHA=632d8f8`, `HEAD_SHA=8fec696` → exit **0** (`PASS: PR phase-claim gate.`).
3. `ede9a9c` is on `main` lineage (`git merge-base --is-ancestor ede9a9c ab27a3c`).
4. Claim-gate unit suite **20/20** when included in vitest run above.

---

## Release labels (auditor confirmation)

| Flag | PR claim | Auditor finding |
|---|---|---|
| `backend_real` | true | **overclaimed** — FAIL for Firestore runtime mode (doc id > 1500 bytes) |
| `frontend_real` | false | **false** (PASS — honest) |
| `transport_stub` | true | **true** (PASS — honest) |
| `classification` | PARTIAL | **PARTIAL** (not COMPLETE / not product-done) |

---

## Remediation required before PASS

1. Shorten or hash Firestore document IDs for deep workflow-ops chains (keep human-readable ids in row payload if needed) so integrated refresh persists under Firestore limits.
2. Re-run full Firestore emulator trio + runtime-mode mega test on `main`; expect **22/22** green.
3. Extend PR testing checklist to include the Firestore suite when touching workflow-ops spine collections (avoid repeating masked regressions).

---

## Auditor sign-off

Independent forensic replay @ `ab27a3c` (implementation `8fec696`) **rejects** builder backend_real / full-test claims for this phase due to Firestore ID limit regression. Severity **major**. Release classification stays **PARTIAL** because `transport_stub=true`.
