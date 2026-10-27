import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const REPO = path.resolve(__dirname, "../../..")

const BACKUP_RUNBOOK = path.join(REPO, "docs/runbooks/backup-restore.md")
const RETENTION_RUNBOOK = path.join(REPO, "docs/runbooks/retention-deletion.md")

/** Collections named in spec R34 / FA-F42-R1-014 deletion-trail export. */
const DELETION_TRAIL_COLLECTIONS = [
  "matter_tombstones",
  "deletion_requests",
  "deletion_acks",
  "deletion_external_requests",
  "vault_object_tombstones",
  "legal_holds",
] as const

describe("FA-F42-R1-014: backup/restore runbooks document post-restore tombstone reconciliation", () => {
  it("backup-restore runbook has an explicit post-restore section and points at retention-deletion", () => {
    const backup = readFileSync(BACKUP_RUNBOOK, "utf8")
    expect(backup).toMatch(/## Post-restore: tombstones and completed deletions/)
    expect(backup).toContain("FA-F42-R1-014")
    expect(backup).toContain("docs/runbooks/retention-deletion.md")
    expect(backup).toContain("platform/retention/tombstone.ts")
    expect(backup).toContain("functions/src/retention/ops.ts")
    for (const col of DELETION_TRAIL_COLLECTIONS) {
      expect(backup).toContain(col)
    }
    expect(backup).toContain("matter_members")
    expect(backup).toContain("in_progress")
    expect(backup).toContain("completed")
    expect(backup).toContain("FU-9")
  })

  it("retention-deletion runbook Restoring a backup section matches the deletion-trail contract", () => {
    const retention = readFileSync(RETENTION_RUNBOOK, "utf8")
    expect(retention).toMatch(/## Restoring a backup \(FA-F42-R1-014/)
    for (const col of DELETION_TRAIL_COLLECTIONS) {
      expect(retention).toContain(col)
    }
    expect(retention).toContain("matter_members")
    expect(retention).toContain("in_progress")
    expect(retention).toContain("completed")
  })
})
