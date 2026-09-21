# Independent Phase Auditor forensic audit: PR #114 tenancy external-session identity bridge + IdP parity scaffolding

Date: 2026-09-21  
Repo: `shamail-sikander/cursor-init`  
Requested PR: `#114` (`cursor/legal-os-tenancy-id-bridge-parity-a243`)  
Feature commit: `6c4c293`  
Merge SHA on `main`: `ce57557`

## Verdict (lead)

**PARTIAL. Severity: major.**

Backend reality claims are materially true and test-backed, but process-hardening and claim-hygiene checks fail: PR metadata does not declare required phase flags and includes a "phase complete" phrase that fails the repository's own COMPLETE overclaim gate while transport stubs remain.

---

## DoD adjudication

### A) BACKEND_REAL — actions/views/repos/rules/tests for attest/quarantine/clear + mismatch listing

Status: **PASS**

Evidence:

1. `app/api/p5/tenancy/route.ts` defines and handles:
   - POST actions: `attest_external_session_identity_bridge`, `quarantine_external_session_identity_bridge`, `clear_external_session_identity_bridge`.
   - GET monitoring view: `view=session_external_session_identity_bridges` with `status`, `mismatchStatus`, and lineage-root (`rootSessionRefId`) filtering.
2. `platform/p5/tenancyAdmin.ts` implements lifecycle domain logic and telemetry:
   - `attestExternalSessionIdentityBridge`, `quarantineExternalSessionIdentityBridge`, `clearExternalSessionIdentityBridge`.
   - mismatch reason computation (`computeExternalSessionIdentityMismatchReasons`) including auth-boundary/session drift checks and asserted external-session mismatch.
3. Runtime store + repository surfaces are present:
   - row/type definitions in `platform/spine/store.ts`.
   - memory repository interface + implementation in `platform/persistence/spineRepositories.ts`.
   - Firestore adapter collection wiring in `platform/persistence/firestoreSpineRepositories.ts`.
   - runtime sync function `syncFirmTenancyExternalSessionIdentityBridges` in `platform/persistence/tenancyLineageSync.ts`.
4. Firestore rules include partner-read / deny-write posture:
   - `match /tenancy_external_session_identity_bridges/{id} { allow read: if sameFirm() && isPartner(); allow write: if false; }`.
5. Tests cover lifecycle + filtering + persistence:
   - `tests/api.tenancy.test.ts` validates attest/quarantine/clear actions, mismatch-listing filters, and idempotent replay semantics.
   - `tests/persistence.repositories.test.ts` validates repository round-trip/list paths for identity bridges.
   - `tests/persistence.runtime-mode.test.ts` validates route-driven runtime-mode persistence and persisted Firestore bridge rows.

### B) FE honesty — backend-only acceptable if `frontend_real=false` / not overclaimed

Status: **PASS (claim-honesty check)**

Evidence:

1. Feature commit `6c4c293` changes backend/runtime/test/rules/docs files only; no frontend TSX UI files were changed.
2. PR summary describes backend tenancy API/persistence/rules/test scaffolding and does not claim delivered frontend workflow.

### C) No COMPLETE overclaim

Status: **FAIL**

Evidence:

1. PR metadata description contains "mark the identity bridge phase complete".
2. Replaying `ci_gates/check_pr_phase_claims.py` against PR #114 metadata fails with:
   - missing required phase flags
   - and `PR claims COMPLETE/product-done while filing transport TODO/stub markers still exist.`

### D) SHA integrity (`ce57557` / `6c4c293` on `main`)

Status: **PASS**

Evidence:

1. `git log --oneline` on updated `main` shows:
   - `ce57557 Merge branch 'cursor/legal-os-tenancy-id-bridge-parity-a243'`
   - parent commit `6c4c293 Scaffold tenancy external session identity bridge`.
2. `git show --no-patch --pretty=fuller` confirms commit identity for both SHAs.

### E) Focused tenancy + persistence tests + G-0/G-1

Status: **PASS**

Executed:

1. `npm run test -- tests/api.tenancy.test.ts` → PASS (`7` tests).
2. `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.repositories.test.ts"` → PASS (`1` test).
3. `npx firebase-tools emulators:exec --only firestore --project demo-sikander "npx vitest run tests/persistence.runtime-mode.test.ts"` → PASS (`14` tests).
4. `npm run gate:g0` → PASS.
5. `npm run gate:g1` → PASS (`tests/gate_g1.test.ts`: `10` tests).

### F) Process hardening labels/honesty

Status: **FAIL**

Evidence:

1. PR metadata does not include explicit `backend_real`, `frontend_real`, and `transport_stub` declarations required by `ci_gates/check_pr_phase_claims.py`.
2. PR metadata does not include required action/view -> `/ops` call-site evidence entry format expected by the same gate.
3. Gate replay therefore hard-fails for metadata non-compliance (despite backend implementation correctness).

---

## Final adjudication

- **Phase verdict:** `PARTIAL`
- **Severity:** `major`
- **Why not PASS:** process integrity failures under the repository's own phase-claim hardening policy (missing required flags + COMPLETE phrasing conflict).
- **Required remediation for future phases:**
  1. Always include explicit `backend_real`, `frontend_real`, and `transport_stub` values in PR metadata.
  2. Avoid COMPLETE/product-complete phrasing while transport stubs remain active.
  3. Provide required action/view -> `/ops` call-site evidence format whenever claim gate policy requires it.
