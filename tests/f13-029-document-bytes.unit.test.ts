// FA-F13-029: pre-10-13 document rows (no stored objectBytesStatus) need a backfill that stamps only that default,
// and a report of rows the reader refuses. Nothing else is invented. Fails until the planner and apply exist.
import { describe, expect, it } from "vitest"

const good = (id: string): Record<string, unknown> => ({
  firmId: "firmA",
  matterId: null,
  contentHash: "sha256:ab",
  sourceChannel: "web",
  classification: "internal",
  storagePath: "firm/obj",
  isImmutable: true,
  byteSize: 12,
  mimeType: "application/pdf",
  objectVersion: 1,
  uploadedBy: "u_up",
  objectBytesStatus: "available",
  id,
})

describe("F13 FA-F13-029: document bytes backfill", () => {
  it("stamps only a missing objectBytesStatus and reports a row it cannot read", async () => {
    const mod = await import("@/platform/persistence/documentBytesBackfill")
    const legacy = good("doc_legacy")
    delete legacy.objectBytesStatus
    const invalid = good("doc_bad")
    invalid.byteSize = "12"
    delete invalid.objectBytesStatus
    const plan = mod.planDocumentBytesBackfill([
      { id: "doc_legacy", data: legacy },
      { id: "doc_ok", data: good("doc_ok") },
      { id: "doc_stored_missing", data: { ...good("doc_stored_missing"), objectBytesStatus: "missing" } },
      { id: "doc_bad", data: invalid },
    ])
    expect(plan.stamp).toEqual([{ id: "doc_legacy", patch: { objectBytesStatus: "missing" } }])
    expect(plan.complete).toEqual(["documents/doc_ok", "documents/doc_stored_missing"])
    expect(plan.malformed).toEqual([{ id: "doc_bad", path: "documents/doc_bad", reason: "byteSize" }])
    const text = mod.formatDocumentBytesDryRun(plan)
    expect(text).toBe(
      [
        "[backfill-document-bytes] DRY-RUN: 1 to stamp, 2 already complete, 1 malformed (not written)",
        "[backfill-document-bytes] documents/doc_legacy objectBytesStatus",
        "[backfill-document-bytes] complete documents/doc_ok",
        "[backfill-document-bytes] complete documents/doc_stored_missing",
        "[backfill-document-bytes] documents/doc_bad malformed byteSize",
      ].join("\n")
    )
  })

  it("one failed stamp does not abort the later stamp, and a malformed id is not written", async () => {
    const mod = await import("@/platform/persistence/documentBytesBackfill")
    const stamped: string[] = []
    const store = {
      async stamp(id: string) {
        if (id === "doc_bad_write") throw new Error("disk full")
        stamped.push(id)
        return { status: "written" as const }
      },
    }
    const plan = {
      stamp: [
        { id: "doc_a", patch: { objectBytesStatus: "missing" as const } },
        { id: "doc_bad_write", patch: { objectBytesStatus: "missing" as const } },
        { id: "doc_c", patch: { objectBytesStatus: "missing" as const } },
      ],
      complete: [],
      malformed: [{ id: "doc_mal", path: "documents/doc_mal", reason: "matterId" }],
    }
    const res = await mod.applyDocumentBytesBackfill(store, plan)
    expect(res.applied).toEqual(["documents/doc_a", "documents/doc_c"])
    expect(res.failed).toEqual([{ path: "documents/doc_bad_write", message: "disk full" }])
    expect(res.skipped).toEqual([])
    expect(res.rejected).toEqual([])
    expect(stamped).toEqual(["doc_a", "doc_c"])
  })
})
