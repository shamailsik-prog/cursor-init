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

/** Remove HTML comments so step pins cannot be satisfied by comment-hidden tokens (FA-F42-R1-014-001-002 / M3c). */
function stripHtmlComments(markdown: string): string {
  const open = "<!--"
  const close = "-->"
  let out = ""
  let cursor = 0
  while (cursor < markdown.length) {
    const openAt = markdown.indexOf(open, cursor)
    if (openAt === -1) {
      out += markdown.slice(cursor)
      break
    }
    out += markdown.slice(cursor, openAt)
    const closeAt = markdown.indexOf(close, openAt + open.length)
    if (closeAt === -1) {
      break
    }
    cursor = closeAt + close.length
  }
  return out
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

    const section = stripHtmlComments(
      sectionAfterHeading(
        backup,
        /^## Post-restore: tombstones and completed deletions/m,
      ),
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
    expect(step5).toMatch(/do not purge|nothing .* is purged/i)
    expect(step2).toMatch(/Restore Firestore/i)
    expect(step3).toMatch(/\*\*Before traffic:\*\*/i)
    expect(step3).toMatch(/matter_members/)
    expect(step4).toMatch(/in_progress|completed/i)

    expect(section.indexOf("**Before traffic:**")).toBeLessThan(section.indexOf("in_progress"))
    expect(section.indexOf("**NOT DEMONSTRATED:**")).toBeGreaterThan(steps[4]!)
  })

  it("retention-deletion Restoring a backup: ordered steps, serve gate before re-purge, NOT DEMONSTRATED", () => {
    const retention = readFileSync(RETENTION_RUNBOOK, "utf8")
    const section = stripHtmlComments(
      sectionAfterHeading(
        retention,
        /^## Restoring a backup \(FA-F42-R1-014/m,
      ),
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
    expect(step5).toMatch(/do not purge|nothing .* is purged/i)
    expect(step3).toMatch(/Before the restored database serves any request/i)
    expect(step4).toMatch(/in_progress|completed/i)

    expect(section.indexOf("serves any request")).toBeLessThan(section.indexOf("in_progress"))
  })
})

describe("FA-F42-R1-014-001-001-001: step-5 legal-hold polarity kills L5-invert", () => {
  const step5Polarity = /do not purge|nothing .* is purged/i

  it("L5-invert allow-purge prose still mentions hold/purge but fails polarity pin", () => {
    const inverted =
      "5. **Legal holds:** holds may be dropped; purge held matter content in step 4."
    expect(inverted).toMatch(/legal_holds|Legal holds/i)
    expect(inverted).toMatch(/hold/i)
    expect(inverted).toMatch(/purge|purged/i)
    expect(inverted).not.toMatch(step5Polarity)
  })

  it("backup and retention step 5 prose satisfy the polarity pin", () => {
    const backup = stripHtmlComments(
      sectionAfterHeading(
        readFileSync(BACKUP_RUNBOOK, "utf8"),
        /^## Post-restore: tombstones and completed deletions/m,
      ),
    )
    const retention = stripHtmlComments(
      sectionAfterHeading(
        readFileSync(RETENTION_RUNBOOK, "utf8"),
        /^## Restoring a backup \(FA-F42-R1-014/m,
      ),
    )
    for (const section of [backup, retention]) {
      const steps = numberedStepOffsets(section)
      const step5 = sliceStep(section, steps, 5)
      expect(step5).toMatch(step5Polarity)
    }
  })
})

describe("FA-F42-R1-014-001-002: step pins ignore HTML comment hiding (M3c)", () => {
  it("stripHtmlComments removes multiline comments before step-body matching", () => {
    const withComment =
      "3. Route traffic now.\n   <!-- **Before traffic:** matter_members\n   hidden gate -->\n4. Re-purge in_progress"
    const stripped = stripHtmlComments(withComment)
    expect(stripped).not.toMatch(/\*\*Before traffic:\*\*/i)
    expect(stripped).not.toContain("matter_members")
    expect(stripped).toContain("in_progress")
  })

  it("M3c-style step 3 cannot satisfy before-traffic pins after comment strip", () => {
    const mutantSection = stripHtmlComments(`1. Export trail
2. Restore Firestore
3. Route traffic to the restored database now. <!-- **Before traffic:** matter_members -->
4. Reconcile in_progress and completed deletions (FU-9)
5. legal_holds hold purge`)
    const steps = numberedStepOffsets(mutantSection)
    const step3 = sliceStep(mutantSection, steps, 3)
    const step4 = sliceStep(mutantSection, steps, 4)
    expect(step3).not.toMatch(/\*\*Before traffic:\*\*/i)
    expect(step3).not.toContain("matter_members")
    expect(step4).toMatch(/in_progress|completed/i)
    expect(mutantSection.indexOf("**Before traffic:**")).toBe(-1)
  })

  it("stripHtmlComments removes unclosed comment through EOF (M3c-unclosed)", () => {
    const withUnclosed = "3. Route traffic now.\n<!-- **Before traffic:** matter_members"
    const stripped = stripHtmlComments(withUnclosed)
    expect(stripped).toBe("3. Route traffic now.\n")
    expect(stripped).not.toMatch(/\*\*Before traffic:\*\*/i)
    expect(stripped).not.toContain("matter_members")
  })

  it("M3c-unclosed step 3 cannot satisfy before-traffic pins after comment strip", () => {
    const mutantSection = stripHtmlComments(`1. Export trail
2. Restore Firestore
3. Route traffic to the restored database now. <!-- **Before traffic:** matter_members`)
    const steps = numberedStepOffsets(mutantSection, 3)
    const step3 = sliceStep(mutantSection, steps, 3)
    expect(step3).not.toMatch(/\*\*Before traffic:\*\*/i)
    expect(step3).not.toContain("matter_members")
    expect(mutantSection.indexOf("**Before traffic:**")).toBe(-1)
    expect(mutantSection).not.toContain("in_progress")
  })
})
