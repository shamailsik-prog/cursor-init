import type { P1Transport } from "./transport"

/**
 * The P1 fake-transport seam (audit F18 re-audit follow-up, spec ruling R13). It holds only the test transport a suite
 * installs, never paid code, so it is the one Functions P1 module G-0 [19]'s allowlist lets a root test import (the F18
 * e2e serves the Functions router in process and installs its fake here). functions/src/p1/transport.ts reads it first
 * and re-exports the setter for the Functions suites.
 */

let testTransport: P1Transport | null = null

/** Test-only. Refused in production, like `platform/p1/internalAICaller.ts`'s `setTransportForTests`. */
export function setP1TransportForTests(t: P1Transport | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setP1TransportForTests is test-only")
  testTransport = t
}

/** The installed test transport, if any. */
export function installedTestTransport(): P1Transport | null {
  return testTransport
}
