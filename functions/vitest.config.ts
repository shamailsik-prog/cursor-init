import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Spec P3-20: fails any test in which functions/src writes a registry collection without bumping the registry version.
    setupFiles: ["test/setup/registryWriteRecorder.ts"],
    // The Gate G-2 suite runs once, inside `npm run gate:g2` (ci_gates/gate_g2.sh sets G2_GATE=1), not again in test:emu.
    // The F05 authority suites need real Postgres and run only in `npm run test:f05-authority` (F05_AUTHORITY_SUITE=1,
    // plan D14); there a missing SIKANDER_POSTGRES_URL fails the run (test/corpusPg.ts), it never skips.
    exclude: [
      ...(process.env.G2_GATE === "1" ? [] : ["test/g2.cross-firm.test.ts"]),
      ...(process.env.F05_AUTHORITY_SUITE === "1" ? [] : ["test/**/*.pg.test.ts", "test/f05-*.e2e.emu.test.ts"]),
    ],
    // Vitest 3's default pool was forks. Keep it. poolOptions was removed in Vitest 4;
    // execArgv is now a top-level option. firebase-tools and the client SDK import
    // punycode (DEP0040) on every worker start; nothing here uses it.
    pool: "forks",
    execArgv: ["--disable-warning=DEP0040"],
    // Vitest 5 defaults clearMocks to true and wipes call history before each test.
    // Keep the Vitest 3 default so assertions that span tests in a file stay the same.
    clearMocks: false,
    // Emulator round-trips (first gRPC connect, 1s revocation wait) exceed the 5s default on cold start.
    testTimeout: 15000,
    // Suites share one emulator and singleton docs (platform/bootstrap, platform/gates): run files one at a time.
    fileParallelism: false,
    // Tests never run on GCE: skip the metadata-server probe google-auth does on first Admin call.
    env: { METADATA_SERVER_DETECTION: "none" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "..") } },
})
