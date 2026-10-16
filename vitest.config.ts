import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    environment: "node",
    // `pr-phase-claim-gate` spawns many long-lived `git` subprocesses; the default
    // `forks` pool can hit Vitest worker RPC timeouts (`onTaskUpdate`) while tests
    // still pass. Threads pool avoids that false non-zero exit.
    pool: "threads",
    include: ["tests/**/*.test.ts"],
    // Heavy legacy route-wiring tests take 2.5-6.4 s on a loaded machine; the 5 s
    // default flakes on CI runners. 15 s matches functions/vitest.config.ts.
    testTimeout: 15000,
    hookTimeout: 15000,
    // Route handlers fail closed (Firebase auth) unless told otherwise; the
    // unit suite opts into the local-only insecure-dev mode.
    // Legacy chain test files opt into LEGACY_GOVERNANCE_CHAINS (Erratum E-24).
    setupFiles: [
      "tests/setup/auth-mode.ts",
      "tests/setup/document-object-store.ts",
      "tests/setup/legacy-chains.ts",
    ],
    // These suites call initializeTestEnvironment() and require the Firestore
    // emulator. Skip them under a plain `vitest run`; they execute via
    // `npm run test:rules`, which wraps them with `firebase emulators:exec`.
    exclude: [
      ...(process.env.SIKANDER_POSTGRES_URL
        ? []
        : [
            "tests/postgres.ddl.integration.test.ts",
            "tests/probe-fa-data-001.regression.test.ts",
          ]),
      ...(process.env.FIRESTORE_EMULATOR_HOST
        ? []
        : [
            "tests/firestore.rules.test.ts",
            "tests/firestore.rules.d1-phase2a.test.ts",
            "tests/firestore.rules.d1-phase2b.test.ts",
            "tests/firestore.rules.p1-phase3d.test.ts",
            "tests/firestore.rules.d4-phase4a.test.ts",
            "tests/persistence.repositories.test.ts",
            "tests/persistence.runtime-mode.test.ts",
            "tests/audit-f01-production-persistence.e2e.test.ts",
            "tests/f03.persistence-rollback.test.ts",
            "tests/f14-document-clearance.firestore.test.ts",
            "tests/f10-durable-idempotency.firestore.test.ts",
            "tests/f10-next-idempotency.e2e.firestore.test.ts",
            "tests/audit-f02-console-functions-auth.e2e.test.ts",
            "tests/audit-f02-functions-http-emulator.e2e.test.ts",
          ]),
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
