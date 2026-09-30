// The unit suite drives route handlers directly with request-supplied
// actorId/userId, so it runs in the explicit local-only auth mode. Tests that
// exercise real authentication override this per test (see auth.session.test.ts).
process.env.SIKANDER_AUTH_MODE ??= "insecure-dev"
