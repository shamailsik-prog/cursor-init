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
    // firebase-tools' and the client SDK's punycode import warns on every worker start (DEP0040); nothing here uses it.
    poolOptions: { forks: { execArgv: ["--disable-warning=DEP0040"] } },
    // Emulator round-trips (first gRPC connect, 1s revocation wait) exceed the 5s default on cold start.
    testTimeout: 15000,
    // Suites share one emulator and singleton docs (platform/bootstrap, platform/gates): run files one at a time.
    fileParallelism: false,
    // Tests never run on GCE: skip the metadata-server probe google-auth does on first Admin call.
    env: { METADATA_SERVER_DETECTION: "none" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "..") } },
})
