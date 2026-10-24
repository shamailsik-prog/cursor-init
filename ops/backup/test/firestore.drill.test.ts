import { describe, expect, it } from "vitest"
import { runCommand } from "../lib/exec"

describe("firestore emulator drill", () => {
  it(
    "fails fast when firebase-tools is not installed",
    async () => {
      const r = await runCommand(["bash", "-lc", "npx firebase --version"])
      expect(r.code, "run npm ci so firebase-tools is available, and install Java 21 for the Firestore emulator").toBe(0)
    },
    120_000
  )
})
