# functions/: Cloud Functions (asia-south1)

Firebase Cloud Functions for Sikander. Everything deploys to `asia-south1`.
Dependencies live only in this folder.

```bash
npm --prefix functions install
npm --prefix functions run typecheck
npm --prefix functions run build      # bundles to functions/lib (esbuild)
npm --prefix functions test           # unit tests only; emulator suites are skipped
```

## Local and emulator setup

### Tests against the Auth and Firestore emulators

```bash
npm --prefix functions run test:emu
```

This runs `firebase emulators:exec --only auth,firestore --project demo-sikander`.
It uses the ports in the repo `firebase.json`: Firestore 18088, Auth 19099 and
Functions 15001. The suites in `test/` detect the emulators through
`FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST`, and skip
themselves when those are not set.

### Functions emulator (end-to-end callables)

The Functions emulator sets `FUNCTION_TARGET`. `onboardFirm` treats that as
hosted, so the first-firm bootstrap needs a founder email to be configured.
Create `functions/.env.local` (the root `.gitignore` already ignores `.env*`):

```bash
SIKANDER_BOOTSTRAP_FOUNDER_EMAIL=you@example.com
```

Then sign in to the Auth emulator with that address, with a verified email,
and call `onboardFirm({ name })`.

Without the variable, the call fails with `failed-precondition` / `bootstrap_not_configured`.
A different or unverified email fails with `permission-denied` / `bootstrap_founder_mismatch`.

### Port notes

- If a default port is taken, for example by another checkout's emulators,
  do not edit the repo `firebase.json`. Write a temporary config with free
  ports and point the CLI at it:

  ```json
  {
    "emulators": {
      "firestore": { "port": 38088, "host": "127.0.0.1", "websocketPort": 39150 },
      "auth": { "port": 39099, "host": "127.0.0.1" },
      "hub": { "port": 44400, "host": "127.0.0.1" },
      "logging": { "port": 44500, "host": "127.0.0.1" },
      "ui": { "enabled": false }
    }
  }
  ```

  ```bash
  NO_PROXY="127.0.0.1,localhost,$NO_PROXY" \
    npx firebase emulators:exec --config /path/to/firebase.json \
    --only auth,firestore --project demo-sikander "npm --prefix <repo>/functions test"
  ```

- The hub and logging emulators also need free ports. The CLI checks them
  without `SO_REUSEADDR`, so a socket in TIME_WAIT from the previous run can
  cause "port taken" for about a minute. Wait, or pick other ports.
- Keep `127.0.0.1` and `localhost` in `NO_PROXY` when an HTTPS proxy is set,
  or emulator traffic goes out through the proxy.
- Tests set `METADATA_SERVER_DETECTION=none` (in `vitest.config.ts`). This
  stops the Admin SDK from probing the GCE metadata server.

## Production bootstrap (first firm)

The first call to `onboardFirm` on a fresh project makes the caller the
founding partner of the first firm. It records `platform/bootstrap`. After
that, only a `platformAdmin` can onboard more firms. To keep a stranger from
winning that race:

1. **Keep self sign-up off.** Disable new-account creation in Firebase Auth
   (Identity Platform "user actions: enable create") until step 5 is done.
   Create the founder account by hand in the console or with the Admin SDK,
   and make sure its email is verified.
2. **Set the founder email** for the deployed functions:
   `SIKANDER_BOOTSTRAP_FOUNDER_EMAIL=<founder address>`. Use `functions/.env.<projectId>`
   or your deploy pipeline's env. On hosted runs (`K_SERVICE` or
   `FUNCTION_TARGET` set), the first-firm bootstrap needs the caller's
   **verified** token email to equal this value; matching is trimmed and
   case-insensitive. If the variable is unset, the result is
   `bootstrap_not_configured`.
3. **Deploy:** `firebase deploy --only functions,firestore:rules`.
4. **Onboard immediately.** The founder signs in and calls
   `onboardFirm({ name })`. Check that `platform/bootstrap` has
   `{ firstFirmId, founderUid }`, and that the founder's token (after a refresh)
   carries `firmId`, `role: "partner"` and `clearanceLevel: "privileged-restricted"`.
5. **After onboarding**, the partner adds users through `createFirmUser`. Keep
   self sign-up off, because all accounts are provisioned by partners.
   Clearing the env var afterwards is optional: once `platform/bootstrap`
   exists, the gate is never consulted again.

If the claims write fails after the firm was created, the founder sees
`internal`. The founder should simply call `onboardFirm` again: the call
resumes idempotently and returns the same `firmId` (audited as
`bootstrap_resume`).

## Identity model (P5, Module 40)

- `users/{uid}` is authoritative for role, clearance and `active`. Token
  claims can only restrict: the clearance used is the lower of the two, and
  a role mismatch is refused with `claims_stale`. Identity fields on that
  doc must be server-only in `firestore.rules`.
- `claims_sync/{uid}` is server-only. It holds the latest committed claims
  result and its version. Claim syncs and reverts are keyed on it.
- Every identity call writes one `audit_log` decision row. If a claims sync
  fails after commit, extra `deny` rows record it: `claims_sync_failed` and
  `revert_blocked_last_partner`.

## MFA policy and recovery (P5, E-19)

- `enforceMfaForRole({ firmId, role, enforced })` (partner) edits
  `firms/{firmId}.mfaEnforcedRoles`. `requireAuth` and `callerFromCallable`
  refuse an enforced role whose token has no `firebase.sign_in_second_factor`
  with 403 `mfa_required`. The only exemptions are `disableMfa` called by
  the subject themself (a user who lost the device) and `syncMfaStatus`.
- `generateRecoveryCodes({ firmId })` returns 10 codes once and replaces any
  earlier set. Only HMAC-SHA-256 hashes with a per-user salt are stored, in
  the server-only `mfa_recovery/{uid}` (no rules match, so clients are denied).
  It needs an enrolled factor (`factor_required`) and a second-factor
  session (`mfa_required`): enrol first, then generate. The codes are bound
  to the factor uids enrolled at generation time.
- `syncMfaStatus({ firmId })` sets `users/{uid}.mfaEnabled` from the Auth
  user's enrolled factors. The client calls it after enrolling.
- Disabling needs two people: another partner calls
  `approveMfaDisable({ firmId, uid })`, which creates a one-hour, single-use
  `mfa_disable_approvals/{id}`. Then the subject, or a partner who is not the
  approver, calls `disableMfa({ firmId, uid, recoveryCode, approvalId })`.
  This invalidates all remaining codes. It removes only the factors recorded
  on the approval at commit. If a step after commit fails, the same caller
  can retry with the same approval and no code until it expires or
  completes. An approval allows five code attempts, then it is void
  (`approval_voided`), even when calls run in parallel.
- In the emulator tests, `mintMfaIdToken` (test/emu.ts) signs in through the
  Auth emulator's phone MFA flow to get a real second-factor token.

## HTTP API (`api`, L18 §4.1–4.4)

`api` is one `onRequest` function that serves the route table in
`src/http/router.ts`. Each route runs the same P5 operation as its callable
(`src/p5/identity.ts`, `src/p5/mfa.ts`), so behaviour and audit rows match.

- **Routes:** `POST /api/platform/identity/{onboardFirm, createFirmUser,
  setUserClaims, deactivateUser, enforceMfaForRole, approveMfaDisable,
  disableMfa, generateRecoveryCodes, syncMfaStatus}`. The body is the
  callable's `data` without `firmId`. The router also accepts the path without
  the `/api` prefix, as a direct function URL delivers it.
- **Headers:** `Authorization: Bearer <ID token>`, `X-Firm-Id` (the firm is
  taken from here, never from the body; `onboardFirm` ignores it), and on
  POST/PUT `Idempotency-Key: <UUID v4>`.
- **Order:** route (404 `route_not_found`, 405 `method_not_allowed`), body
  (413 `payload_too_large` over 1 MB, 415 unless `application/json`, 400
  `invalid_body` unless an object), auth (401/403), rate limit (429
  `rate_limited` + `Retry-After`), idempotency, handler. Errors are
  `{ "error": { "code": "..." } }`.
- **Rate limits:** fixed one-minute UTC windows per user, counted in
  `rate_limits/{uid}_{kind}_{yyyyMMddHHmm}`: 60/min `general`, 10/min `p1`.
  A firm can override them with `firms/{firmId}.rateLimits = { general, p1 }`
  (integers 1–1000). Requests that fail authentication count against the
  client IP (first `X-Forwarded-For` hop, else `req.ip`), 60/min; over that they
  get 429 and no `audit_log` row.
- **Idempotency:** `idempotency_keys/{firmId}_{key}` (`_nofirm_{key}` for
  `onboardFirm`) holds the claim and the stored response for 24 h. A replay
  returns the stored status and body with `reused: true`. The same key with
  another body, route or user gives 422 `idempotency_key_reused`, and a
  duplicate while the first is running gives 409 `idempotency_in_progress`.
  5xx responses are not stored, so a retry runs again. The
  `generateRecoveryCodes` response is never stored: its replay is
  `{ redacted: true, reused: true }`, so generate again with a new key if the
  codes were lost.
- **TTL policies (set once per project):** both collections carry `expiresAt`.
  Enable Firestore TTL on it so old docs are purged. Until the purge runs, an
  expired idempotency key is treated as absent.

  ```bash
  gcloud firestore fields ttls update expiresAt --collection-group=idempotency_keys --enable-ttl
  gcloud firestore fields ttls update expiresAt --collection-group=rate_limits --enable-ttl
  ```

- **Rules:** both collections are server-only. No rule matches them, so the
  default deny applies.
