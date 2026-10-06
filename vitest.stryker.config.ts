import { defineConfig, mergeConfig } from "vitest/config"
import base from "./vitest.config"

// Used only by StrykerJS (stryker.config.mjs). Stryker starts Vitest through its
// Node API and sets VITEST="1"; the `vitest` CLI sets VITEST="true", which is
// what runtimeRepositories' test-runner memory default checks. Restore the CLI
// value so the suite behaves exactly as under `npm test`.
export default mergeConfig(base, defineConfig({ test: { env: { VITEST: "true" } } }))
