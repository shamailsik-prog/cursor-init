import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [
      "tests/gate_g1.test.ts",
      ...(process.env.FIRESTORE_EMULATOR_HOST
        ? []
        : ["tests/firestore.rules.test.ts"]),
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
