// LEGACY_GOVERNANCE_CHAINS is off by default (Erratum E-24). The test files
// below exercise the frozen ops-reporting / filings chains, so they run with the
// flag on: they keep proving the frozen code still works when re-enabled. Every
// other file (including tests/boot.all-layers-disabled.test.ts and
// tests/feature-flags.legacy-chains.test.ts) sees the production default.
// Loaded through vitest.config.ts setupFiles, once per test file.
import path from "node:path"
import { expect } from "vitest"

export const LEGACY_CHAIN_TEST_FILES = [
  "tests/api.filings.get-side-effect-free.test.ts",
  "tests/api.filings.test.ts",
  "tests/api.ops-reporting.behaviour-fixes.test.ts",
  "tests/api.ops-reporting.dispatch-coverage.test.ts",
  "tests/api.ops-reporting.test.ts",
  "tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts",
  "tests/persistence.route-wiring.test.ts",
  "tests/persistence.runtime-mode.test.ts",
  "tests/security.review-round1.test.ts",
  "tests/security.review-round2.test.ts",
] as const

// LEGACY_D1_NEXT_WRITES is off by default (Phase 2a final review I3, Erratum E-40): the
// Next.js D1 check-free paths (matters `create`, clients `conflict_check`) are frozen. The
// test files below exercise those two actions (directly or as setup), so they run with the
// flag on and stay unchanged. tests/boot.all-layers-disabled.test.ts and
// tests/feature-flags.legacy-d1-next-writes.test.ts see the production default.
export const LEGACY_D1_NEXT_WRITES_TEST_FILES = [
  "tests/api.clients.test.ts",
  "tests/api.d1-validation.test.ts",
  "tests/api.matters.member-validation.test.ts",
  "tests/api.matters.test.ts",
  "tests/api.reporting.test.ts",
  "tests/audit.request-persistence.test.ts",
  "tests/auth.body-limit.test.ts",
  "tests/auth.session.test.ts",
  "tests/g2.cross-firm.test.ts",
  "tests/http.idempotency.test.ts",
  "tests/persistence.runtime-mode.test.ts",
  "tests/platform.surface.test.ts",
  "tests/security.review-round2.test.ts",
] as const

const testPath = expect.getState().testPath
const relative = testPath ? path.relative(path.resolve(__dirname, "../.."), testPath).split(path.sep).join("/") : ""

/** Turns `flag` on for the listed files, and clears an opt-in a reused worker left behind. */
function optIn(files: readonly string[], flag: string, marker: string): void {
  const flagEnv = `SIKANDER_FLAG_${flag}`
  if (files.includes(relative)) {
    process.env[flagEnv] = "true"
    process.env[marker] = "1"
  } else if (process.env[marker]) {
    // A worker reused from an opted-in file: drop the opt-in it left behind,
    // but never an override set from outside the test run.
    delete process.env[flagEnv]
    delete process.env[marker]
  }
}

optIn(LEGACY_CHAIN_TEST_FILES, "LEGACY_GOVERNANCE_CHAINS", "SIKANDER_TEST_SETUP_SET_LEGACY_FLAG")
optIn(LEGACY_D1_NEXT_WRITES_TEST_FILES, "LEGACY_D1_NEXT_WRITES", "SIKANDER_TEST_SETUP_SET_LEGACY_D1_FLAG")
