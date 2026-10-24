import { describe, expect, it } from "vitest"
import { comparePgManifests, type PgManifest } from "../postgres/manifest"

function emptyManifest(): PgManifest {
  return {
    meta: {
      serverVersion: "16.0",
      database: "legal_scraper",
      encoding: "UTF8",
      collation: "en_US.UTF-8",
      backupTime: "2026-01-01T00:00:00.000Z",
      snapshotId: "snap",
    },
    tables: {},
    sequences: {},
    foreignKeys: {},
    links: {},
    extensions: {},
    definitions: [],
    roles: [],
    grants: [],
  }
}

describe("comparePgManifests", () => {
  it("reports no differences for equal manifests", () => {
    const m = emptyManifest()
    m.tables["public.judgment"] = { rows: 2, digest: "abc" }
    expect(comparePgManifests(m, { ...m })).toEqual([])
  })

  it("reports table row and digest changes", () => {
    const a = emptyManifest()
    const b = emptyManifest()
    a.tables["public.judgment"] = { rows: 2, digest: "d1" }
    b.tables["public.judgment"] = { rows: 3, digest: "d2" }
    const lines = comparePgManifests(a, b)
    expect(lines).toContain("table public.judgment: rows 2 -> 3")
    expect(lines).toContain("table public.judgment: digest differs")
  })

  it("reports missing and unexpected tables", () => {
    const a = emptyManifest()
    const b = emptyManifest()
    a.tables["public.a"] = { rows: 0, digest: "x" }
    b.tables["public.b"] = { rows: 0, digest: "y" }
    const lines = comparePgManifests(a, b)
    expect(lines).toContain("table public.a: missing")
    expect(lines).toContain("table public.b: unexpected")
  })

  it("reports link and definition drift", () => {
    const a = emptyManifest()
    const b = emptyManifest()
    a.links.receipt_queue = 0
    b.links.receipt_queue = 1
    a.definitions = ["def-a"]
    b.definitions = ["def-b"]
    const lines = comparePgManifests(a, b)
    expect(lines.some((l) => l.includes("links.receipt_queue"))).toBe(true)
    expect(lines).toContain("definitions: missing def-a")
    expect(lines).toContain("definitions: unexpected def-b")
  })
})
