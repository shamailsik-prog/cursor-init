import { defineConfig } from "vitest/config"
import base from "./vitest.config"

// Used only by stryker.documents.config.mjs (`npm run mutation:documents`). Every test file
// imports platform/spine/runtimeStore.ts, which imports the vault, so Stryker's "related" mode
// would run the whole suite (2,300 tests) for each of the ~200 module-level mutants: hours per run.
// This lists the suites that exercise the vault directly (they import the vault modules or drive
// /api/d1/documents). Fewer tests can only leave more mutants alive, so the score it reports is a
// lower bound. VITEST="true" as in vitest.stryker.config.ts.
export const DOCUMENT_VAULT_TESTS = [
  "tests/fa-d16-001.object-store-config.unit.test.ts",
  "tests/fa-d16-001.r2-object-backend.unit.test.ts",
  "tests/fa-d16-002.document-object-integrity.unit.test.ts",
  "tests/fa-d16-002.upload-document-paths.unit.test.ts",
  "tests/fa-d16-002.vault-edges.unit.test.ts",
  "tests/fa-d16-003.round-trip-cleanup.unit.test.ts",
  "tests/fa-d16-r1.credential-hygiene.unit.test.ts",
  "tests/fa-d16-r1.ambiguous-put-settle.unit.test.ts",
  "tests/fa-d16-r2.review-fixes.unit.test.ts",
  "tests/f03-document-bytes.e2e.test.ts",
  "tests/f03-document-object-store.unit.test.ts",
  "tests/api.documents.test.ts",
  "tests/api.document-workflow.test.ts",
  "tests/security.dedup-oracle.test.ts",
  "tests/security.loose-vault-api.test.ts",
  "tests/security.accounts-role.test.ts",
  "tests/spine.hardening.test.ts",
  "tests/jobs.matter-id.test.ts",
  "tests/http.idempotency.test.ts",
  "tests/persistence.route-wiring.test.ts",
]

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    env: { VITEST: "true" },
    include: DOCUMENT_VAULT_TESTS,
  },
})
