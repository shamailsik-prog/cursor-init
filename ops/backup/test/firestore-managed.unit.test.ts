import { describe, expect, it } from "vitest"
import { firestoreCommands } from "../firestore/managed"
import type { FirestoreBackupConfig } from "../config"

const cfg: FirestoreBackupConfig = {
  database: "(default)",
  schedule: { recurrence: "daily", retention: "14w" },
  exportBucket: { retentionDays: 35, lock: false },
  restore: { destinationDatabase: "restore-f33" },
}

describe("firestoreCommands", () => {
  const cmds = firestoreCommands(cfg, { project: "p", location: "l", exportBucket: "exp" })

  it("never uses force or delete", () => {
    for (const argv of Object.values(cmds)) {
      const line = argv.join(" ")
      expect(line).not.toMatch(/\b(--force|delete|rm)\b/)
      expect(line).not.toContain("/rm/")
    }
  })

  it("omits bucket lock unless configured", () => {
    expect(cmds.bucketLock).toBeUndefined()
    const locked = firestoreCommands(
      { ...cfg, exportBucket: { retentionDays: 35, lock: true } },
      { project: "p", location: "l", exportBucket: "exp" }
    )
    expect(locked.bucketLock).toBeDefined()
  })

  it("restore targets a new database id", () => {
    expect(cmds.restoreBackup.join(" ")).toContain("--destination-database=restore-f33")
    expect(cmds.restoreBackup.join(" ")).not.toContain("(default)")
  })
})
