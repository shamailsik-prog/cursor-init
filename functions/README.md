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

### Functions emulator (end-to-end through the HTTP `api`)

The Functions emulator sets `FUNCTION_TARGET`. `onboardFirm` treats that as
hosted, so the first-firm bootstrap needs a founder email to be configured.
Create `functions/.env.local` (the root `.gitignore` already ignores `.env*`):

```bash
SIKANDER_BOOTSTRAP_FOUNDER_EMAIL=you@example.com
```

Then sign in to the Auth emulator with that address, with a verified email,
and call `POST /api/platform/identity/onboardFirm` with `{ "name": ... }` (see
"HTTP API" below).

Without the variable, the call fails with 409 `bootstrap_not_configured`.
A different or unverified email fails with 403 `bootstrap_founder_mismatch`.

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
that, only a `platformAdmin` can onboard more firms, and only once Gate G-2
has passed (R-5, see "Gates" below). To keep a stranger from winning that race:

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
   `POST /api/platform/identity/onboardFirm` with `{ name }`. Check that `platform/bootstrap` has
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

## Gates and the second firm (R-5, L18 §10)

- R-5: no second firm is onboarded until tenant isolation has passed a live
  cross-tenant test. Once `platform/bootstrap` exists, `onboardFirm` on the
  platformAdmin path fails with 409 `second_firm_forbidden`
  (audited as a deny) unless `platform/gates.g2PassedAt` is set.
- Run `npm run gate:g2` (repo root). On a green run it prints an evidence
  line: `{ summary, commitSha, runUrl, counts: { tested, notBuilt, outOfScope,
  global, allowed } }` (it also writes it to `G2_EVIDENCE_OUT` when set). A
  platform admin posts `{ gate: "G-2", evidence }` (that object as `evidence`) to
  `POST /api/platform/gates/recordGatePass`.
  `commitSha`, an https `runUrl` and the counts are required, and the counts
  must be green: `tested` > 0 and `allowed` = 0, otherwise `invalid_evidence`.
  Anyone without `platformAdmin: true` is refused with `platform_admin_only`.
  In one transaction the call writes the allow audit row, `platform/gates`
  (`g2PassedAt`, `g2PassedBy`, `g2Evidence`, `g2PassId`) and an append-only
  `gate_passes/{id}`. Both are server-only (no rules match).
- **Re-run obligation.** A pass covers the code at its `commitSha`. Re-run
  `gate:g2` and record a new pass when the tenant surface changes shape: when
  the D2-1 WhatsApp webhook (phone-number to user binding) lands, when D5-1
  web research reads land, and when the Postgres migration puts matters and
  documents behind RLS (L18 §10: "after the Postgres migration the same suite
  runs against RLS"). Until then the gate lists those reads as not built.
- The G-2 functions suite (`test/g2.cross-firm.test.ts`) runs only inside
  `gate:g2` (`G2_GATE=1`); `npm test` and `test:emu` skip it, so CI runs it once.
- The emulator suites share singleton docs (`platform/bootstrap`,
  `platform/gates`), so `vitest.config.ts` runs test files one at a time.

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

- `enforceMfaForRole({ role, enforced })` (partner) edits
  `firms/{firmId}.mfaEnforcedRoles`. `requireAuth` / `bindHttpSession` (the
  shared identity policy, `platform/p5/identityPolicy.ts`, which the Next.js
  session applies too) refuse an enforced role whose token has no
  `firebase.sign_in_second_factor` with 403 `mfa_required`. The only exemptions are `disableMfa` called by
  the subject themself (a user who lost the device) and `syncMfaStatus`.
- `generateRecoveryCodes({})` returns 10 codes once and replaces any
  earlier set. Only HMAC-SHA-256 hashes with a per-user salt are stored, in
  the server-only `mfa_recovery/{uid}` (no rules match, so clients are denied).
  It needs an enrolled factor (`factor_required`) and a second-factor
  session (`mfa_required`): enrol first, then generate. The codes are bound
  to the factor uids enrolled at generation time.
- `syncMfaStatus({})` sets `users/{uid}.mfaEnabled` from the Auth
  user's enrolled factors. The client calls it after enrolling.
- Disabling needs two people: another partner calls
  `approveMfaDisable({ uid })`, which creates a one-hour, single-use
  `mfa_disable_approvals/{id}`. Then the subject, or a partner who is not the
  approver, calls `disableMfa({ uid, recoveryCode, approvalId })`.
  This invalidates all remaining codes. It removes only the factors recorded
  on the approval at commit. If a step after commit fails, the same caller
  can retry with the same approval and no code until it expires or
  completes. An approval allows five code attempts, then it is void
  (`approval_voided`), even when calls run in parallel.
- In the emulator tests, `mintMfaIdToken` (test/emu.ts) signs in through the
  Auth emulator's phone MFA flow to get a real second-factor token.

## HTTP API (`api`, L18 §4.1–4.4)

`api` is one `onRequest` function that serves the route table in
`src/http/router.ts`. It is the **only** entry point to the P5 operations
(`src/p5/identity.ts`, `src/p5/mfa.ts`, `src/p5/gates.ts`): there are no
`onCall` callables (U-1). The deployed functions are `api` and `health`.

- **Routes:** `POST /api/platform/identity/{onboardFirm, createFirmUser,
  setUserClaims, deactivateUser, enforceMfaForRole, approveMfaDisable,
  disableMfa, generateRecoveryCodes, syncMfaStatus}` and
  `POST /api/platform/gates/recordGatePass`. The body is the operation's input
  (never a `firmId`). The router also accepts the path without the `/api`
  prefix, as a direct function URL delivers it.
- **Headers:** `Authorization: Bearer <ID token>`, `X-Firm-Id` (the firm is
  taken from here, never from the body; the firmless `onboardFirm` and
  `recordGatePass` ignore it), and on POST/PUT `Idempotency-Key: <UUID v4>`.
- **Authorisation:** the identity policy above, then each operation's own
  check. The partner-only operations (createFirmUser, setUserClaims,
  deactivateUser, enforceMfaForRole, approveMfaDisable) go through P5
  `checkPermission` (`src/p5/permission.ts`, the shared table in
  `platform/p5/permissionDecision.ts`) with the actions `identity.manage_users`,
  `identity.set_claims`, `identity.deactivate`, `mfa.enforce` and
  `mfa.approve_disable`; a refusal is 403 `partner_only`.
- **Order:** route (404 `route_not_found`, 405 `method_not_allowed`), body
  (413 `payload_too_large` over 1 MB, 415 unless `application/json`, 400
  `invalid_body` unless an object), auth (401/403), rate limit (429
  `rate_limited` + `Retry-After`), idempotency, handler. Errors are
  `{ "error": { "code": "..." } }`.
- **Rate limits:** fixed one-minute UTC windows per user, counted in
  `rate_limits/{uid}_{kind}_{yyyyMMddHHmm}`: 60/min `general`, 10/min `p1`.
  Each request adds one with an atomic increment and reads the count back,
  instead of a transaction, because parallel calls from one user would contend
  on the doc. This never admits more than the limit. A firm can override the
  limits with `firms/{firmId}.rateLimits = { general, p1 }` (integers 1–1000).
  Requests that fail authentication count against the client IP, 60/min.
  Over that they get 429 and no `audit_log` row. The client IP comes from
  `X-Forwarded-For`. Google's front end appends the connecting address, and
  every hop to its left is client-supplied. With `TRUSTED_PROXY_HOPS=N` the
  key is the entry N+1 from the right. The default is 0, the last hop, which
  is right for direct `*.cloudfunctions.net` / `*.run.app` URLs. If the header
  has fewer entries than that, or none, `req.ip` is used.
- **Fixed-window boundary burst:** windows are whole UTC minutes, so a user
  can get up to 2× the limit in about a second across a minute boundary (the
  last moment of one window and the first of the next). This is accepted for
  the fixed window. A sliding window would be the fix if it matters.
- **Idempotency:** `idempotency_keys/{firmId}_{key}` (`_nofirm_{key}` for
  `onboardFirm`) holds the claim and the stored response for 24 h. A replay
  returns the stored status and body with `reused: true`. The same key with
  another body, route or user gives 422 `idempotency_key_reused`, and a
  duplicate while the first is running gives 409 `idempotency_in_progress`.
  The claim is a 5-minute lease (`claimedAt`): a claim still `in_progress`
  after that, for example after a crash, is taken over by the same request.
  5xx responses are not stored, so a retry runs again. The
  `generateRecoveryCodes` response is never stored: its replay is
  `{ redacted: true, reused: true }`, so generate again with a new key if the
  codes were lost.
- **Audit:** a replay is not audited. It is the stored answer to a decision
  that already has its row. The idempotency refusals (400
  `idempotency_key_required`, 409 `idempotency_in_progress`, 422
  `idempotency_key_reused`) are audited as denies under the route's action.
  Rate-limit refusals are not audited.
- **Stored results:** only 2xx, 400, 404, 422 and business-conflict 409s
  (`already_exists`, `already_onboarded`, `last_partner`, `code_used`) are
  stored and replayed. 401/403 (a refreshed token or a step-up may succeed),
  contention 409s (`claims_sync_failed`, …), 429 and 5xx release the key, so a
  retry with the same key runs again. See `isStorableResult`.
- **Timeouts:** `api` pins `timeoutSeconds: 120`
  (`FUNCTION_TIMEOUT_SECONDS`). The 5-minute idempotency lease must be longer,
  and `idempotency.ts` throws at load if it is not.
- **Build check:** `npm run build` loads the route table and fails on a
  duplicate method + path before bundling.
- **TTL policies (set once per project):** both collections carry `expiresAt`.
  Enable Firestore TTL on it so old docs are purged. Until the purge runs, an
  expired idempotency key is treated as absent.

  ```bash
  gcloud firestore fields ttls update expiresAt --collection-group=idempotency_keys --enable-ttl
  gcloud firestore fields ttls update expiresAt --collection-group=rate_limits --enable-ttl
  ```

- **Deploy note, proxies:** set `TRUSTED_PROXY_HOPS` when `api` is served
  through a proxy of ours that appends to `X-Forwarded-For`. For an external
  Application Load Balancer with a serverless NEG, it appends
  `<client>, <lb-ip>`, so set `1`. For a Firebase Hosting rewrite, Hosting's
  CDN adds its own hop, so set `1` after confirming the header shape on a
  test request. If this is left at 0 behind a proxy, every failed-auth request
  shares the proxy's single 60/min bucket, and one attacker can turn everyone
  else's 401 into 429. Set it in `functions/.env.<projectId>`.

  When `TRUSTED_PROXY_HOPS` > 0, also set
  `SIKANDER_INGRESS_SETTINGS=ALLOW_INTERNAL_AND_GCLB`. This applies to `api`,
  and it rejects direct requests that bypass the load
  balancer. A direct request could otherwise put any address in the hop that
  is now trusted. Accepted values are `ALLOW_ALL` (the default, right for
  hops = 0), `ALLOW_INTERNAL_ONLY` and `ALLOW_INTERNAL_AND_GCLB`. Any other
  value fails the deploy. If hops > 0 while ingress is still `ALLOW_ALL`, the
  functions log a warning when they load. For a Firebase Hosting rewrite,
  check that Hosting still reaches the functions under the restricted ingress
  before you rely on it.
- **Rules:** both collections are server-only. No rule matches them, so the
  default deny applies.
