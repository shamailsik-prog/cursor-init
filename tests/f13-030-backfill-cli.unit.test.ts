// FA-F13-030 / FA-F13-031: a backfill --apply that recorded write failures must exit 1, and later rows still run.
// FA-F13-032: document --apply output names each malformed row. These fail until the CLI runners do that.
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { MatterShapeBackfillStore } from "@/platform/persistence/matterShapeBackfill"
import type { DocumentBytesBackfillStore } from "@/platform/persistence/documentBytesBackfill"

const root = path.resolve(__dirname, "..")

const legacyMatter = (i: number) => ({
  id: `m${String(i).padStart(5, "0")}`,
  data: { firmId: "firmA", clientId: "c1", title: "Suit", classification: "internal", status: "live" },
})

const goodDoc = (id: string): Record<string, unknown> => ({
  id,
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
})

describe("F13 FA-F13-030: matter-shape --apply exits 1 when a write failed", () => {
  it("continues past the thrown write and returns exit code 1", async () => {
    const { runMatterShapeBackfill } = await import("@/scripts/lib/matterShapeBackfillCli")
    const writes: string[] = []
    const store: MatterShapeBackfillStore = {
      async completeMatter(planned) {
        if (planned.id === "m00001") throw new Error("disk full")
        writes.push(planned.id)
        return { status: "written" }
      },
      async completeMember() {
        return { status: "written" }
      },
      async appendAudit() {},
    }
    const code = await runMatterShapeBackfill(["--apply"], {
      load: async () => ({ matters: [legacyMatter(0), legacyMatter(1), legacyMatter(2)], members: [] }),
      store,
      log() {},
      runId: "r30",
      now: 1,
    })
    expect(writes).toEqual(["m00000", "m00002"])
    expect(code).toBe(1)
  })

  it("a clean apply returns 0", async () => {
    const { runMatterShapeBackfill } = await import("@/scripts/lib/matterShapeBackfillCli")
    const store: MatterShapeBackfillStore = {
      async completeMatter() {
        return { status: "written" }
      },
      async completeMember() {
        return { status: "written" }
      },
      async appendAudit() {},
    }
    const code = await runMatterShapeBackfill(["--apply"], {
      load: async () => ({ matters: [legacyMatter(0)], members: [] }),
      store,
      log() {},
      runId: "r30ok",
      now: 1,
    })
    expect(code).toBe(0)
  })

  it("the script assigns that code to process.exitCode", () => {
    const src = readFileSync(path.join(root, "scripts/backfill-matter-shapes.ts"), "utf8")
    expect(src).toContain("process.exitCode = await runMatterShapeBackfill")
  })
})

describe("F13 FA-F13-031: document-bytes --apply exits 1 when a stamp failed", () => {
  it("stamps the later row and returns exit code 1", async () => {
    const { runDocumentBytesBackfill } = await import("@/scripts/lib/documentBytesBackfillCli")
    const stamped: string[] = []
    const store: DocumentBytesBackfillStore = {
      async stamp(id) {
        if (id === "doc_bad_write") throw new Error("disk full")
        stamped.push(id)
        return { status: "written" }
      },
    }
    const code = await runDocumentBytesBackfill(["--apply"], {
      readRows: async () => [
        { id: "doc_a", data: goodDoc("doc_a") },
        { id: "doc_bad_write", data: goodDoc("doc_bad_write") },
        { id: "doc_c", data: goodDoc("doc_c") },
      ],
      store,
      log() {},
    })
    expect(stamped).toEqual(["doc_a", "doc_c"])
    expect(code).toBe(1)
  })

  it("a clean apply returns 0", async () => {
    const { runDocumentBytesBackfill } = await import("@/scripts/lib/documentBytesBackfillCli")
    const store: DocumentBytesBackfillStore = {
      async stamp() {
        return { status: "skipped" }
      },
    }
    const row = { ...goodDoc("doc_ok"), objectBytesStatus: "available" }
    const code = await runDocumentBytesBackfill(["--apply"], {
      readRows: async () => [{ id: "doc_ok", data: row }],
      store,
      log() {},
    })
    expect(code).toBe(0)
  })

  it("the script assigns that code to process.exitCode", () => {
    const src = readFileSync(path.join(root, "scripts/backfill-document-bytes.ts"), "utf8")
    expect(src).toContain("process.exitCode = await runDocumentBytesBackfill")
  })
})

describe("F13 FA-F13-032: document-bytes --apply names malformed rows", () => {
  it("prints the malformed count and each path when every write count is zero", async () => {
    const { runDocumentBytesBackfill } = await import("@/scripts/lib/documentBytesBackfillCli")
    const lines: string[] = []
    const store: DocumentBytesBackfillStore = {
      async stamp() {
        throw new Error("stamp should not run")
      },
    }
    const bad = goodDoc("doc_bad")
    bad.byteSize = "12"
    const code = await runDocumentBytesBackfill(["--apply"], {
      readRows: async () => [{ id: "doc_bad", data: bad }],
      store,
      log: (line) => lines.push(line),
    })
    expect(code).toBe(0)
    const text = lines.join("\n")
    expect(text).toContain("[backfill-document-bytes] applied 0, skipped 0, rejected 0, failed 0, malformed 1")
    expect(text).toContain("[backfill-document-bytes] documents/doc_bad malformed byteSize")
  })
})
