// StrykerJS mutation testing for the security-critical Next-side modules.
// `npm run mutation` (about 20-40 min on 4 cores; not part of per-PR CI, see
// .github/workflows/mutation.yml). Summary: docs/audits/mutation-report.md.
//
// Scope (docs/audits/README.md "Mutation testing"):
//   - P5 identity: session resolution, request-scoped identity, checkPermission,
//     Committee Brain scope. tenancyAdmin.ts (2.7k lines of admin orchestration)
//     is out of this run: its authorisation decisions call checkPermission and
//     the functions-side P5 callables, which are mutated here and in
//     functions/stryker.config.mjs.
//   - P1 provider policy and the classification helpers in p1/types.ts.
//   - HTTP surface: validation, withSession, errors, idempotency, surface.
//   - Feature flags and route gates.
//   - Audit writes: there is no platform/audit/ directory; the audit write path
//     lives in platform/persistence/audit*.ts and is mutated here.
//   - persistence/runtimeRepositories.ts (memory vs Firestore fail-closed choice).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: "vitest",
  // vitest.stryker.config.ts = vitest.config.ts + the VITEST="true" the CLI sets.
  vitest: { configFile: "vitest.stryker.config.ts", related: true },
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  // Re-runs reuse the previous result for every mutant whose code and covering
  // tests are unchanged (a fresh checkout, as in CI, runs everything).
  incremental: true,
  incrementalFile: "reports/mutation/next/stryker-incremental.json",
  mutate: [
    "platform/p5/session.ts",
    "platform/p5/requestSession.ts",
    "platform/p5/checkPermission.ts",
    "platform/p5/committeeScope.ts",
    "platform/p1/providerPolicy.ts",
    "platform/p1/types.ts",
    "platform/http/**/*.ts",
    "platform/flags/**/*.ts",
    "platform/persistence/auditWriteThrough.ts",
    "platform/persistence/auditSync.ts",
    "platform/persistence/auditAppendConflictError.ts",
    "platform/persistence/runtimeRepositories.ts",
  ],
  // Keep the sandbox small: nothing outside the Next app and its tests is needed.
  // (tests read docs/, postgres/, data/ and ci_gates/, so those stay).
  ignorePatterns: ["functions", "corpus_service", ".next", "reports", "coverage"],
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/next/index.html" },
  jsonReporter: { fileName: "reports/mutation/next/mutation.json" },
  thresholds: { high: 90, low: 85, break: 85 },
  concurrency: 3,
  timeoutMS: 20000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
}

export default config
