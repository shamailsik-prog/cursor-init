// StrykerJS on the F03 document vault (audit FA-D16-002: the integrity checks were never exercised,
// documentObjectStore.ts scored 57.65 % with the hash, key and version checks uncovered).
// `npm run mutation:documents`; Gate G-0 runs it on every ready PR ("Mutation floor (document vault)").
// The unit suites alone cover both files: the S3 adapter's failure paths run against the fault proxy
// in tests/f03-document-object-s3.faults.unit.test.ts, no MinIO needed.
import base from "./stryker.config.mjs"

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  ...base,
  vitest: { configFile: "vitest.stryker.documents.config.ts", related: false },
  mutate: ["platform/documents/documentObjectStore.ts", "platform/documents/documentObjectS3.ts"],
  incremental: false,
  incrementalFile: undefined,
  htmlReporter: { fileName: "reports/mutation/documents/index.html" },
  jsonReporter: { fileName: "reports/mutation/documents/mutation.json" },
  thresholds: { high: 90, low: 85, break: 85 },
}

export default config
