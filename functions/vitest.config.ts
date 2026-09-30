import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Emulator round-trips (first gRPC connect, 1s revocation wait) exceed the 5s default on cold start.
    testTimeout: 15000,
    // Suites share one emulator and singleton docs (platform/bootstrap, platform/gates): run files one at a time.
    fileParallelism: false,
    // Tests never run on GCE: skip the metadata-server probe google-auth does on first Admin call.
    env: { METADATA_SERVER_DETECTION: "none" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "..") } },
})
