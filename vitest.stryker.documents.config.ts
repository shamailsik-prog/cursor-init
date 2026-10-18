import { defineConfig } from "vitest/config"
import base from "./vitest.config"

// StrykerJS on the document vault (stryker.documents.config.mjs). Only the F03 suites that need no
// emulator or MinIO: every mutant, static ones included, then runs against a few dozen tests instead
// of the whole unit suite (most route tests import the vault through the runtime store). VITEST="true"
// as in vitest.stryker.config.ts. Spread, not mergeConfig: mergeConfig would append to `include`.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    env: { ...base.test?.env, VITEST: "true" },
    include: [
      "tests/f03-document-object-store.unit.test.ts",
      "tests/f03-document-object-s3.faults.unit.test.ts",
      "tests/f03-document-vault-contract.unit.test.ts",
      "tests/f03-document-bytes.e2e.test.ts",
    ],
  },
})
