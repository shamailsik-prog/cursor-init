# Phase 1 Foundation (Spec-Aligned) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Legal OS back on its governing architecture: freeze the out-of-spec governance chains, record the stack decision, and build the spec's Phase 1 "Foundation" (identity, claims, tenancy, audit) on Firebase Cloud Functions in asia-south1.

**Architecture:** Strangler migration. The existing Next.js API keeps serving (hardened by the four defect-fix streams) while each Layer 18 service gets a spec-compliant Cloud Functions implementation under `functions/`. Shared, framework-free TypeScript (`core/`, `platform/p1/types.ts`, `platform/p5/checkPermission.ts` logic) is bundled into the functions with esbuild rather than copied. Out-of-spec code is disabled behind a feature flag (Layer 18 §9), never deleted.

**Tech Stack:** TypeScript 5, Firebase Cloud Functions v2 (`firebase-functions` ≥ 6, region `asia-south1`), `firebase-admin` ≥ 13, Firestore, Firebase Auth custom claims, vitest 3, `@firebase/rules-unit-testing`, esbuild. Flutter front end is the next plan (Phase 1b), not this one.

**Spec:** SIKANDER AI Architecture Document Set (356-page PDF; text at `docs/architecture/` once committed). Governing sections: Layer 18 §3 (23 services), §4 (engineering standards), §5 (Phase 0 data, §5.3 rules), §9 (Amendment Layer Protocol), §10 (gates); Master v6 §21 (build sequence, MVP); Erratum E-19 (MFA recovery).

## Global Constraints

- Region: Cloud Functions deploy to `asia-south1` (v6 §3).
- Every HTTP call carries `Authorization: Bearer <Firebase ID token>` and `X-Firm-Id`; POST/PUT carry `Idempotency-Key` (UUID v4) (L18 §4.1–4.2).
- Identity comes only from verified token custom claims `{ firmId, role, clearanceLevel }`; never from request body/query (L18 §4.5).
- `checkPermission(userId, action, matterId?)` is the single authority and logs every decision to `audit_log` (L18 §4.5).
- Classification ranks: `public 0, internal 1, confidential 2, privileged 3, privileged-restricted 4`; never downgraded without partner `declassify()` (L18 §4.6, W-2).
- `matter_members` (id `${matterId}_${userId}`) is the single source of truth for matter access (R-2, §5.2–5.3).
- `audit_log` is append-only: create only, never update or delete (§5.2).
- Features outside core live behind a feature flag with per-firm override; core must boot and pass G-1 with every layer disabled (L18 §9.1 rule 4).
- Nothing is deleted: disabling a feature hides routes and leaves data intact (L18 §9.1; L19.0.1(4)).
- Existing role names stay: `partner | associate | clerk | intern | accounts | client` (`platform/spine/store.ts:7-13`).
- No provider SDK imports outside P1; no scraper imports in the app repo (L18 §9.2 guards).

## Review Focus

1. **Stale claims after a role change** — a user demoted or deactivated must lose access on their next call, not after token expiry. Covered in Task 5 (`deactivateUser` revokes refresh tokens; `requireAuth` calls `verifyIdToken(token, true)` to check revocation).
2. **X-Firm-Id spoofing** — a valid token for firm A with `X-Firm-Id: firmB` must be refused (403), not silently scoped. Task 4.
3. **Partner self-escalation** — a partner must not raise their own role/clearance or grant clearance above their own. Task 5.
4. **Frozen chain still reachable through a side door** — with the flag off, both GET views and POST actions of ops-reporting and the frozen filings chain return 404 `feature_disabled`; the core filings package create/decide still works. Task 1.
5. **Audit write failure** — if the audit write fails, the permission decision must fail closed (deny), never allow without a record. Task 4.

---

### Task 1: Freeze out-of-spec governance chains behind `LEGACY_GOVERNANCE_CHAINS`

**Files:**
- Create: `platform/flags/featureFlags.ts`
- Modify: `app/api/d2/ops-reporting/route.ts` (exported `GET`/`POST` only — wrap, don't edit internals)
- Modify: `app/api/d4/filings/route.ts` (exported `GET`/`POST` only)
- Modify: `vitest.config.ts` / test setup (enable the flag only for the legacy chain test files)
- Test: `tests/feature-flags.legacy-chains.test.ts`

**Interfaces:**
- Produces: `isFeatureEnabled(flag: FeatureFlag, firmId?: string): boolean`; `type FeatureFlag = "CORE_ENABLED" | "LEGACY_GOVERNANCE_CHAINS"`; `featureDisabledResponse(flag: FeatureFlag): Response` → 404 `{ error: "feature_disabled", flag }`.

- [ ] **Step 1:** Write failing tests: with env `SIKANDER_FLAG_LEGACY_GOVERNANCE_CHAINS` unset, `GET /api/d2/ops-reporting?view=<any existing view>` → 404 body `{error:"feature_disabled",flag:"LEGACY_GOVERNANCE_CHAINS"}`; `POST` any ops-reporting action → same 404; filings `view=escalation_owner_rota` and action `assign_primary_owner` → 404; filings `create_package` and `decide_package` → NOT 404 (core, v6 Module 12 approval path). With env set to `"true"` → the existing behaviour (existing tests unchanged).
- [ ] **Step 2:** Run `npx vitest run tests/feature-flags.legacy-chains.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement `featureFlags.ts` (defaults: `CORE_ENABLED=true`, `LEGACY_GOVERNANCE_CHAINS=false`; env override `SIKANDER_FLAG_<NAME>`; per-firm override map reserved for Postgres `firm_feature_overrides`, read-only stub). In filings, the frozen set = every `view`/`action` except the core list `{ create_package, decide_package, view=packages, view=package }` — derive the core list from the existing tests that cover package create/decide; everything else is frozen.
- [ ] **Step 4:** Enable the flag in the setup of the existing chain test files only (they keep proving the frozen code still works when re-enabled). Run `npm run test:unit` — expect all pass.
- [ ] **Step 5:** Commit `feat(flags): freeze out-of-spec governance chains behind LEGACY_GOVERNANCE_CHAINS (L18 §9)`.

### Task 2: Record the decisions — proposed Erratum Set No. 2

**Files:**
- Create: `docs/architecture/ERRATUM_SET_2_PROPOSED.md`
- Create: `docs/architecture/README.md` (where the spec lives, precedence, how layers are added)

**Interfaces:** none (document). Referenced by the PR and by CLAUDE.md.

- [ ] **Step 1:** Write the erratum in the set's own format (No. / Where / Change / Authority), status PROPOSED pending partner signature: E-23 stack reaffirmed (Flutter + Cloud Functions asia-south1 + Firestore + R2; Next.js app is transitional, retired service-by-service); E-24 governance/attestation/adjudication/lattice chains and the filing-transport pipeline are out of scope (no spec basis; R-4; exclusion register "Electronic filing / transmission to court"), frozen behind `LEGACY_GOVERNANCE_CHAINS`, data retained; E-25 `corpus_service/` to move to its own repository (L17.12, W-6) with Annex A tables (Annex B B-3); E-26 authentication per L18 §4.1/§4.5 is a Phase 1 blocker before any real matter.
- [ ] **Step 2:** Commit `docs(architecture): proposed Erratum Set No. 2 — stack, chain freeze, corpus split`.

### Task 3: Cloud Functions workspace (asia-south1) with shared-code bundling

**Files:**
- Create: `functions/package.json`, `functions/tsconfig.json`, `functions/build.mjs` (esbuild), `functions/src/index.ts`, `functions/src/health.ts`, `functions/vitest.config.ts`
- Modify: `firebase.json` (add `functions` source `functions`, predeploy build; emulators `auth` 19099 and `functions` 15001 on 127.0.0.1)
- Modify: `package.json` scripts: `"functions:build"`, `"functions:test"`, `"typecheck": "tsc --noEmit -p ."`
- Test: `functions/test/health.test.ts`

**Interfaces:**
- Produces: `setGlobalOptions({ region: "asia-south1" })` in `functions/src/index.ts`; `export const health = onRequest(...)` → 200 `{ status: "ok", region: "asia-south1" }`. esbuild resolves the repo alias `@/*` → repo root so functions can import `@/core/*`, `@/platform/p1/types`, `@/platform/p5/*`.

- [ ] **Step 1:** Failing test: invoking the `health` handler (via `firebase-functions-test` or by calling the exported handler with a mock req/res) returns 200 and `region: "asia-south1"`.
- [ ] **Step 2:** Run `npm --prefix functions test` — FAIL.
- [ ] **Step 3:** Scaffold; `firebase-functions` ≥ 6, `firebase-admin` ≥ 13, Node 22 engine; build bundles `src/index.ts` to `lib/index.js` (platform node, target node22, external `firebase-admin`, `firebase-functions`).
- [ ] **Step 4:** `npm --prefix functions test` and `npm --prefix functions run build` pass; `node -e "require('./functions/lib/index.js')"` loads.
- [ ] **Step 5:** Commit `feat(functions): Cloud Functions workspace in asia-south1 with shared-code bundling`.

### Task 4: P5 identity core — `requireAuth`, `checkPermission` with audit

**Files:**
- Create: `functions/src/p5/auth.ts`, `functions/src/p5/permission.ts`, `functions/src/p5/audit.ts`, `functions/src/admin.ts` (lazy `initializeApp`, `getFirestore`, `getAuth`)
- Test: `functions/test/p5.auth.test.ts`, `functions/test/p5.permission.test.ts` (Firestore + Auth emulators)

**Interfaces:**
- Consumes: Task 3 workspace; `Classification`, rank map from `@/platform/p1/types`.
- Produces:
  - `type Caller = { uid: string; firmId: string; role: Role; clearanceLevel: Classification }`
  - `requireAuth(req: { headers: Record<string,string|undefined> }): Promise<Caller>` — verifies Bearer with `getAuth().verifyIdToken(token, true)`; requires `X-Firm-Id === claims.firmId`; throws `HttpError(401|403, code)`.
  - `callerFromCallable(auth: CallableRequest["auth"], firmIdHeader?: string): Caller` for `onCall`.
  - `checkPermission(caller: Caller, action: string, matterId?: string, extra?: { scope?: "own_matters" }): Promise<{ allow: boolean; reason: string }>` — same decision table as `platform/p5/checkPermission.ts`, reading `matters/{id}` and `matter_members/{matterId}_{uid}` from Firestore; writes one `audit_log` row per decision via `appendAudit`.
  - `appendAudit(row: { firmId; actorId; action; target; classification; decision; reason }): Promise<string>` — `collection("audit_log").doc().create(...)` with `occurredAt: FieldValue.serverTimestamp()`.

- [ ] **Step 1:** Failing tests: no header → 401 `missing_token`; revoked token → 401 `token_revoked`; valid token + `X-Firm-Id` of another firm → 403 `firm_mismatch`; claims missing `firmId` → 403 `no_claims`; non-member reading a matter → deny `not-member` and one `audit_log` row with `decision:"deny"`; member with clearance below matter classification → deny `clearance`; client with `research` → deny; audit write rejected (stub `appendAudit` to throw) → decision is deny `audit_unavailable`.
- [ ] **Step 2:** Run with emulators: `npx firebase emulators:exec --only auth,firestore --project demo-sikander "npm --prefix functions test"` — FAIL.
- [ ] **Step 3:** Implement; decision table ported from `platform/p5/checkPermission.ts:9-55` (keep reasons identical so existing tests' vocabulary holds).
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(p5): verified identity, X-Firm-Id binding and audited checkPermission (L18 §4.1, §4.5)`.

### Task 5: P5 identity functions — firm onboarding, users, claims, deactivation

**Files:**
- Create: `functions/src/p5/identity.ts` (callables), export from `functions/src/index.ts`
- Test: `functions/test/p5.identity.test.ts`

**Interfaces:**
- Consumes: Task 4 `requireAuth`/`callerFromCallable`, `checkPermission`, `appendAudit`.
- Produces (all `onCall`, region asia-south1, route namespace `/api/platform/identity/*` via a thin `onRequest` router in Task 7):
  - `onboardFirm({ name })` — bootstrap only when `firms` is empty or caller has custom claim `platformAdmin: true`; creates `firms/{firmId}` `{ name, dataResidency: "PK", plan: "internal", createdAt }` and sets caller claims `{ firmId, role: "partner", clearanceLevel: "privileged-restricted" }`.
  - `createFirmUser({ email, role, clearanceLevel })` — partner only; creates Auth user + `users/{uid}` `{ firmId, role, clearanceLevel, mfaEnabled:false, active:true, createdAt }`; sets claims; returns `{ uid }`.
  - `setUserClaims({ uid, role?, clearanceLevel? })` — partner only, same firm; refuses self-change (`self_change_forbidden`); refuses clearance rank above caller's (`exceeds_own_clearance`).
  - `deactivateUser({ uid })` — partner only; `updateUser(uid,{disabled:true})`, `revokeRefreshTokens(uid)`, `users/{uid}.active=false`; documents untouched.
  - Every call writes `audit_log`.

- [ ] **Step 1:** Failing tests for each rule above, including: associate calling `createFirmUser` → `permission-denied`; partner of firm A setting claims on a firm-B user → `permission-denied`; after `deactivateUser`, a call with the user's old token → 401 `token_revoked`.
- [ ] **Step 2:** Run (emulators) — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Pass.
- [ ] **Step 5:** Commit `feat(p5): firm onboarding, user lifecycle and claims management (Module 40)`.

### Task 6: MFA recovery and enforcement (Erratum E-19)

**Files:**
- Create: `functions/src/p5/mfa.ts`
- Test: `functions/test/p5.mfa.test.ts`

**Interfaces:**
- Consumes: Tasks 4–5.
- Produces: `enforceMfaForRole({ role, enforced: boolean })` (partner) stored at `firms/{firmId}.mfaEnforcedRoles[]`; `requireAuth` denies `mfa_required` when the caller's role is enforced and `decodedToken.firebase.sign_in_second_factor` is absent; `generateRecoveryCodes()` → returns 10 codes once, stores only SHA-256 hashes in `users/{uid}.recoveryCodeHashes`; `disableMfa({ uid, recoveryCode, approvingPartnerUid })` — requires a valid unused recovery code AND a different partner's approval record, marks the code used, audit-logged; `breakGlass` is out of scope here and listed in the PR as follow-up.

- [ ] **Step 1:** Failing tests: enforced role without second factor → 403 `mfa_required`; recovery codes returned once and stored hashed only; `disableMfa` with same partner as subject → `second_partner_required`; reused code → `code_used`.
- [ ] **Step 2–4:** Run → implement → pass.
- [ ] **Step 5:** Commit `feat(p5): MFA enforcement per role and recovery codes (E-19)`.

### Task 7: HTTP route namespace, idempotency, rate limits (L18 §4.1–4.4)

**Files:**
- Create: `functions/src/http/router.ts`, `functions/src/http/idempotency.ts`, `functions/src/http/rateLimit.ts`
- Test: `functions/test/http.test.ts`

**Interfaces:**
- Consumes: Task 4 `requireAuth`.
- Produces: `export const api = onRequest(router)` serving `/api/platform/identity/{function}`; `withIdempotency(handler)` — POST/PUT without a UUID v4 `Idempotency-Key` → 400 `idempotency_key_required`; replays return the stored response with `reused: true`, stored in Firestore `idempotency_keys/{firmId}_{key}` with 24 h `expiresAt`; `rateLimit(caller, kind: "general" | "p1")` — 60/min general, 10/min P1-backed, Firestore counter per `{uid}_{minute}` → 429 with `Retry-After`.

- [ ] **Step 1:** Failing tests: missing key → 400; same key twice → identical body + `reused: true`, handler invoked once; 61st general request in a minute → 429 with `Retry-After`; unknown route → 404; duplicate route registration throws at module load (duplicate-route guard).
- [ ] **Step 2–4:** Run → implement → pass.
- [ ] **Step 5:** Commit `feat(http): /api/platform namespace with idempotency and rate limits (L18 §4.1–4.4)`.

### Task 8: Gate G-2 script and CI wiring

**Files:**
- Create: `ci_gates/gate_g2.sh`, `functions/test/g2.cross-firm.test.ts`
- Modify: `.github/workflows/gate-g0.yml` (add steps: `npm run typecheck`, `npm --prefix functions ci`, `npm --prefix functions test` under emulators, `npm run gate:g2`); `package.json` `"gate:g2": "bash ci_gates/gate_g2.sh"`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces: G-2 per L18 §10: two seeded firms; every identity read function and every `matters`/`documents`/`clients` Firestore read attempted cross-firm returns deny, through both callable/HTTP and rules.

- [ ] **Step 1:** Failing test: seed firm A + firm B users/matters in emulators; for each read path assert deny (functions) and `assertFails` (rules).
- [ ] **Step 2–4:** Run → implement script → pass.
- [ ] **Step 5:** Run the full local CI: `npm run lint`, `npm run typecheck`, `npm run test:all`, `npm run gate:g0`, `npm run gate:g1`, `npm run gate:g2`, `npm --prefix functions test`. `typecheck` joins CI only once it reports 0 errors; until then record the remaining count in the PR.
- [ ] **Step 6:** Commit `ci: gate G-2 cross-firm isolation script and functions tests in CI (L18 §10)`.

---

## Later plans (same build order, v6 §21 / L18 §3)

Phase 1b Flutter shell (login with MFA, firm/matter list, role-based dashboard shell; L9.5, D2-3) · Phase 2 matter spine (D1-1 client, D1-2 matter numbering/stages, D1-4 conflict with partner waiver, D1-6 ingestion to R2) · Phase 3a P2 job engine core · 3b un-merge saga · 3c O-28 auto-confirm job · then the AI layer (P1 cost log, 70/90% alerts, kill switch, Opik self-hosted) · Phase 4 drafting + citation gate (D4-1, D4-2) · Phase 5 WhatsApp channel (D2-1 eight-command grammar, D1-3 intake) · MVP gate G-1 on five real matters.
