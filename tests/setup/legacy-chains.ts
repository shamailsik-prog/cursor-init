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

const FLAG_ENV = "SIKANDER_FLAG_LEGACY_GOVERNANCE_CHAINS"
const MARKER_ENV = "SIKANDER_TEST_SETUP_SET_LEGACY_FLAG"

const testPath = expect.getState().testPath
const relative = testPath ? path.relative(path.resolve(__dirname, "../.."), testPath).split(path.sep).join("/") : ""

if ((LEGACY_CHAIN_TEST_FILES as readonly string[]).includes(relative)) {
  process.env[FLAG_ENV] = "true"
  process.env[MARKER_ENV] = "1"
} else if (process.env[MARKER_ENV]) {
  // A worker reused from an opted-in file: drop the opt-in it left behind,
  // but never an override set from outside the test run.
  delete process.env[FLAG_ENV]
  delete process.env[MARKER_ENV]
}
