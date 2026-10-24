/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "ops/backup/vitest.config.ts" },
  mutate: [
    "ops/backup/lib/diff.ts",
    "ops/backup/lib/digest.ts",
    "ops/backup/firestore/canonical.ts",
    "ops/backup/postgres/manifest.ts",
  ],
  thresholds: { break: 50, low: 60, high: 80 },
}
