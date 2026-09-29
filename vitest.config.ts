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
    // These suites call initializeTestEnvironment() and require the Firestore
    // emulator. Skip them under a plain `vitest run`; they execute via
    // `npm run test:rules`, which wraps them with `firebase emulators:exec`.
    exclude: [
      ...(process.env.FIRESTORE_EMULATOR_HOST
        ? []
        : [
            "tests/firestore.rules.test.ts",
            "tests/persistence.repositories.test.ts",
            "tests/persistence.runtime-mode.test.ts",
          ]),
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
