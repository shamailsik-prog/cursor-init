import { describe, expect, it } from "vitest"
import { firestoreEmulatorImportArgv } from "../firestore/emulator"

describe("firestoreEmulatorImportArgv", () => {
  it("imports via emulators:exec --import (firebase-tools has no emulators:import)", () => {
    const argv = firestoreEmulatorImportArgv("/tmp/export", ["true"])
    expect(argv[0]).toBe("firebase")
    expect(argv[1]).toBe("emulators:exec")
    expect(argv).toContain("--import")
    expect(argv).not.toContain("emulators:import")
    expect(argv[argv.indexOf("--import") + 1]).toBe("/tmp/export")
  })
})
