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
