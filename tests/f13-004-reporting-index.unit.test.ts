// Audit F13 FA-F13-004 (reporting-index slice) and FA-F13-008 (mutant M8): the matter/client search index is read
// and written through one canonical reader. These fail until that reader is on the repository paths.
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { buildMatterSearchIndexRow } from "@/platform/persistence/matterClientSearchIndex"
import { newStore, type Matter, type MatterClientSearchIndexRow } from "@/platform/spine/store"

const root = path.resolve(__dirname, "..")

function good(firmId: string, id: string): MatterClientSearchIndexRow {
  return {
    id,
    firmId,
    rowType: "matter",
    referenceId: "mat_1",
    classification: "internal",
    label: "Indexed",
    detail: "",
    linkedMatterId: "mat_1",
    linkedClientId: "client_1",
    status: "engagement_unconfirmed:pending",
    tags: ["indexed"],
    updatedAt: 1,
  }
}

async function reader(): Promise<(id: string, data: unknown) => MatterClientSearchIndexRow | null> {
  const mod = await import("@/platform/persistence/matterClientSearchIndex")
  if (typeof mod.readMatterClientSearchIndexRow !== "function") {
    throw new Error("readMatterClientSearchIndexRow is not exported")
  }
  return mod.readMatterClientSearchIndexRow
}

const courtless: Matter = {
  id: "m_null_court",
  firmId: "firm_a",
  clientId: "client_a",
  title: "Recovery suit",
  classification: "internal",
  status: "engagement_unconfirmed",
  courtId: null,
  caseNumber: null,
  caseNumberStatus: "pending",
}

describe("F13 FA-F13-004: search-index reader and repository contract", () => {
  it("the Firestore repositories read and write the search index through the canonical reader, not a blind cast", () => {
    const repo = readFileSync(path.join(root, "platform/persistence/firestoreSpineRepositories.ts"), "utf8")
    expect(repo).toContain("readMatterClientSearchIndexRow")
    expect(repo).toContain("SearchIndexMalformedError")
    expect(repo).not.toMatch(/getById<MatterClientSearchIndexRow>/)
    expect(repo).not.toMatch(/listByFirm<MatterClientSearchIndexRow>/)
  })

  it("M8: a courtless matter's index row has an empty detail and the reader accepts that row", async () => {
    const row = buildMatterSearchIndexRow(courtless, { updatedAt: 1 })
    expect(row.detail).toBe("")
    expect(row.tags).not.toContain("null")
    const read = await reader()
    expect(read(row.id, row)).toMatchObject({ id: row.id, detail: "", rowType: "matter" })
  })

  it("the reader keeps the document id and refuses a malformed row", async () => {
    const read = await reader()
    expect(read("idx_real", { ...good("firm_a", "idx_real"), id: "forged" })?.id).toBe("idx_real")
    expect(read("idx_real", { ...good("firm_a", "idx_real"), detail: null })).toBeNull()
    expect(read("idx_real", { ...good("firm_a", "idx_real"), classification: "top-secret" })).toBeNull()
    expect(read("idx_real", { ...good("firm_a", "idx_real"), tags: "indexed" })).toBeNull()
    expect(read("idx_real", { ...good("firm_a", "idx_real"), updatedAt: Number.NaN })).toBeNull()
    expect(read("", good("firm_a", ""))).toBeNull()
    expect(read("idx_real", null)).toBeNull()
  })

  it("a memory get of a malformed row throws, and the list leaves it out", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    const ok = good("firm_mem", "idx_ok")
    const bad = { ...good("firm_mem", "idx_bad"), detail: null }
    store.matterClientSearchIndex.set(ok.id, ok)
    store.matterClientSearchIndex.set(bad.id, bad as never)
    await expect(repos.reportingIndex.get(bad.id, "firm_mem")).rejects.toThrow(/malformed/)
    expect((await repos.reportingIndex.listByFirm("firm_mem")).map((row) => row.id)).toEqual([ok.id])
    expect(await repos.reportingIndex.get("missing", "firm_mem")).toBeNull()
  })

  it("a memory upsert of a malformed row does not write, and a valid upsert does not repair a malformed one", async () => {
    const store = newStore()
    const repos = createMemoryRepositories(store)
    const fresh = "idx_fresh"
    await expect(repos.reportingIndex.upsert({ ...good("firm_mem", fresh), rowType: "both" } as never)).rejects.toThrow(/malformed/)
    expect(store.matterClientSearchIndex.has(fresh)).toBe(false)

    const stored = { ...good("firm_mem", "idx_stored"), detail: null }
    store.matterClientSearchIndex.set(stored.id, stored as never)
    await expect(repos.reportingIndex.upsert(good("firm_mem", stored.id))).rejects.toThrow(/malformed/)
    expect(store.matterClientSearchIndex.get(stored.id)).toEqual(stored)

    const valid = good("firm_mem", "idx_valid")
    await repos.reportingIndex.upsert(valid)
    await expect(repos.reportingIndex.upsert({ ...valid, classification: "nope" } as never)).rejects.toThrow(/malformed/)
    expect(store.matterClientSearchIndex.get(valid.id)).toEqual(valid)
  })
})
