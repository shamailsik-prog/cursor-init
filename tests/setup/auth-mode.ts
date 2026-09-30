// The unit suite drives route handlers directly with request-supplied
// actorId/userId, so it runs in the explicit local-only auth mode. Tests that
// exercise real authentication override this per test (see auth.session.test.ts).
process.env.SIKANDER_AUTH_MODE ??= "insecure-dev"

// `firebase emulators:exec` (npm run test:rules) synthesises FIREBASE_CONFIG for
// its child process. That variable is also a hosted-runtime marker that makes
// insecure-dev refuse to start, so drop it when we are demonstrably running
// against the local emulator. Test-only: this file is loaded solely through
// vitest.config.ts setupFiles.
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_EMULATOR_HUB) {
  delete process.env.FIREBASE_CONFIG
}
