import { describe, expect, it } from "vitest"
import { firestoreEmulatorImportArgv } from "../firestore/emulator"

describe("firestoreEmulatorImportArgv", () => {
  it("passes the inner command as one script string (emulators:exec takes a single command)", () => {
    const inner = "npx vite-node ops/backup/test/helpers/firestore-verify-import.ts /tmp/manifest.json"
    const argv = firestoreEmulatorImportArgv("/tmp/export", inner)
    expect(argv[argv.length - 1]).toBe(inner)
    expect(argv.filter((a) => a === "npx")).toHaveLength(0)
    expect(argv.filter((a) => a === "vite-node")).toHaveLength(0)
    expect(argv).not.toContain("emulators:import")
  })
})
