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

function sectionAfterHeading(markdown: string, heading: RegExp): string {
  const match = markdown.match(heading)
  expect(match, `heading ${heading}`).toBeTruthy()
  const start = (match?.index ?? 0) + (match?.[0].length ?? 0)
  const tail = markdown.slice(start)
  const next = tail.search(/\n## /)
  return next === -1 ? tail : tail.slice(0, next)
}

/** Numbered steps 1..5 in document order (kills step-order mutants). */
function numberedStepOffsets(section: string, count = 5): number[] {
  const offsets: number[] = []
  for (let n = 1; n <= count; n++) {
    const re = new RegExp(`^${n}\\. `, "m")
    const hit = section.match(re)
    expect(hit?.index, `step ${n} in restore section`).toBeTypeOf("number")
    offsets.push(hit!.index!)
  }
  for (let i = 1; i < offsets.length; i++) {
    expect(offsets[i], "numbered steps must ascend").toBeGreaterThan(offsets[i - 1]!)
  }
  return offsets
}

function sliceStep(section: string, offsets: number[], step: number): string {
  const start = offsets[step - 1]!
  const end = step < offsets.length ? offsets[step] : section.length
  return section.slice(start, end)
}

/** Step-1 export enumeration (excludes trailing gcloud example) for FA-F42-R1-014-001-001. */
function step1ExportListText(step1: string): string {
  const cut = step1.split(/\b(?:\(for example|Example:)/i)[0]!
  return cut
}

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

describe("FA-F42-R1-014-001: restore runbook guard binds step order, before-traffic, NOT DEMONSTRATED", () => {
  it("backup-restore post-restore section: ordered steps, before traffic before re-purge, drill NOT DEMONSTRATED", () => {
    const backup = readFileSync(BACKUP_RUNBOOK, "utf8")
    const firestore = sectionAfterHeading(backup, /^## Firestore\r?\n/m)
    expect(firestore).toMatch(/before routing clients/i)
    const postRestoreHeading = "## Post-restore: tombstones and completed deletions"
    expect(backup.indexOf("before routing clients")).toBeLessThan(backup.indexOf(postRestoreHeading))

    const section = sectionAfterHeading(
      backup,
      /^## Post-restore: tombstones and completed deletions/m,
    )
    expect(section).toMatch(/before the restored environment serves a request/i)
    expect(section).toMatch(/\*\*NOT DEMONSTRATED:\*\*/)

    const steps = numberedStepOffsets(section)
    const step1 = sliceStep(section, steps, 1)
    const step2 = sliceStep(section, steps, 2)
    const step3 = sliceStep(section, steps, 3)
    const step4 = sliceStep(section, steps, 4)
    const step5 = sliceStep(section, steps, 5)

    expect(step1).toMatch(/Before the restore/i)
    expect(step1).toMatch(/export/i)
    const step1ExportList = step1ExportListText(step1)
    for (const col of DELETION_TRAIL_COLLECTIONS) {
      expect(step1ExportList, `step 1 export list must name ${col}`).toContain(col)
    }
    expect(step5).toMatch(/legal_holds|Legal holds/i)
    expect(step5).toMatch(/hold/i)
    expect(step5).toMatch(/purge|purged/i)
    expect(step2).toMatch(/Restore Firestore/i)
    expect(step3).toMatch(/\*\*Before traffic:\*\*/i)
    expect(step3).toMatch(/matter_members/)
    expect(step4).toMatch(/in_progress|completed/i)

    expect(section.indexOf("**Before traffic:**")).toBeLessThan(section.indexOf("in_progress"))
    expect(section.indexOf("**NOT DEMONSTRATED:**")).toBeGreaterThan(steps[4]!)
  })

  it("retention-deletion Restoring a backup: ordered steps, serve gate before re-purge, NOT DEMONSTRATED", () => {
    const retention = readFileSync(RETENTION_RUNBOOK, "utf8")
    const section = sectionAfterHeading(
      retention,
      /^## Restoring a backup \(FA-F42-R1-014/m,
    )
    expect(section).toMatch(/NOT DEMONSTRATED/)
    expect(section).toMatch(/only after these steps/i)

    const steps = numberedStepOffsets(section)
    const step1 = sliceStep(section, steps, 1)
    const step3 = sliceStep(section, steps, 3)
    const step4 = sliceStep(section, steps, 4)
    const step5 = sliceStep(section, steps, 5)

    expect(step1).toMatch(/Before the restore/i)
    const step1ExportList = step1ExportListText(step1)
    for (const col of DELETION_TRAIL_COLLECTIONS) {
      expect(step1ExportList, `step 1 export list must name ${col}`).toContain(col)
    }
    expect(step5).toMatch(/legal_holds|Legal holds/i)
    expect(step5).toMatch(/hold/i)
    expect(step5).toMatch(/purge|purged/i)
    expect(step3).toMatch(/Before the restored database serves any request/i)
    expect(step4).toMatch(/in_progress|completed/i)

    expect(section.indexOf("serves any request")).toBeLessThan(section.indexOf("in_progress"))
  })
})
