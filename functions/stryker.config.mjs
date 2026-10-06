// StrykerJS mutation testing for the Cloud Functions P5 identity layer and the
// HTTP api. `npm run mutation` (from functions/) or `npm run mutation:functions`
// (from the repo root); summary in docs/audits/mutation-report.md.
//
// Most of these suites need the Auth and Firestore emulators. scripts/mutation.sh
// starts one independent emulator set per test-runner process (ephemeral ports,
// functions/README.md "Port notes") and test/setup/stryker-emulators.ts gives
// each process its own set, so concurrent mutants cannot interfere through the
// shared singleton docs. Run it only through scripts/mutation.sh.
const sets = Number(process.env.STRYKER_EMULATOR_SETS ?? "0")
if (!(sets > 0) || !process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("functions mutation testing needs the emulators: run `npm run mutation` (scripts/mutation.sh)")
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  // vitest.stryker.config.ts = vitest.config.ts + per-worker emulator claim + sandbox-safe `@` alias.
  vitest: { configFile: "vitest.stryker.config.ts", related: true },
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  // Re-runs reuse the previous result for every mutant whose code and covering
  // tests are unchanged (a fresh checkout, as in CI, runs everything).
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  mutate: ["src/p5/**/*.ts", "src/http/**/*.ts"],
  ignorePatterns: ["lib", "reports", "coverage"],
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 90, low: 85, break: 85 },
  // One test-runner process per emulator set.
  concurrency: sets,
  timeoutMS: 30000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
}

export default config
