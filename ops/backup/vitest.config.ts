import { defineConfig } from "vitest/config"
import path from "node:path"

// Backup and restore tooling (audit F33). Run from the repository root:
//   npx vitest run -c ops/backup/vitest.config.ts                       (unit tests and drills)
//   npx vitest run -c ops/backup/vitest.config.ts ops/backup/test/*.unit.test.ts   (unit tests only)
// The drills start real PostgreSQL clusters, the Firestore emulator and MinIO themselves and FAIL when a
// prerequisite is missing; nothing is skipped (docs/runbooks/backup-restore.md, "Running the drills").
export default defineConfig({
  root: path.resolve(__dirname, "../.."),
  test: {
    environment: "node",
    include: ["ops/backup/test/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "../..") },
  },
})
