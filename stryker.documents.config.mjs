// StrykerJS for the document vault (F03; audit v2 FA-D16-001/002/003): the encrypted envelope,
// key and storagePath validation, the fail-closed backend choice, the fs/memory and R2 backends,
// and the upload path that writes and rolls back objects.
//
// `npm run mutation:documents` runs Stryker, then scripts/check-mutation-per-file.mjs, which
// fails the run when any file below scores under its own floor (`perFileBreak`). The floors are
// what the FA-D16 tests reach (measured, see the PR); raise them as tests improve, never lower
// them. Weekly and on demand in .github/workflows/mutation.yml (job `documents`).
//
// Audit v2 baseline (main@0f72cd8, before FA-D16-002): documentObjectStore.ts 57.65 %,
// uploadDocument.ts 50.00 %. The fs/memory backends moved from documentObjectStore.ts to
// localObjectBackends.ts and stay under mutation here.
import base from "./stryker.config.mjs"

/**
 * Per-file break thresholds: mutation score in percent. Measured with the FA-D16 tests: every
 * file at 99-100 % (uploadDocument.ts keeps one equivalent mutant: `>` vs `>=` on the matter
 * classification floor, where equal ranks mean the same label). The floor of 95 leaves room for
 * an equivalent mutant in a future edit; it is ten points above the repository's 85.
 */
export const perFileBreak = {
  "platform/documents/documentObjectStore.ts": 95,
  "platform/documents/r2ObjectBackend.ts": 95,
  "platform/documents/localObjectBackends.ts": 95,
  "platform/documents/objectBackend.ts": 95,
  "services/d1-6/uploadDocument.ts": 95,
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  ...base,
  // The vault's own suites (vitest.documents-mutation.config.ts), not "related": every test file
  // reaches the vault through runtimeStore.ts, which would make each run take hours.
  vitest: { configFile: "vitest.documents-mutation.config.ts", related: false },
  mutate: Object.keys(perFileBreak),
  incrementalFile: "reports/mutation/documents/stryker-incremental.json",
  htmlReporter: { fileName: "reports/mutation/documents/index.html" },
  jsonReporter: { fileName: "reports/mutation/documents/mutation.json" },
  // Whole-run floor; the per-file floors above are the binding ones.
  thresholds: { high: 98, low: 95, break: 95 },
}

export default config
