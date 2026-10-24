// Audit FA-D4-001: the firm-qualified id, the row validator, the one decision both repositories write through, and the
// memory repository (the unit suite's persistence) keep each firm's template analytics on its own row.
import { describe, expect, it } from "vitest"
import {
  DraftTemplateAnalyticsIdError,
  DraftTemplateAnalyticsRefusedError,
  draftTemplateAnalyticsId,
  isLegacyDraftTemplateAnalyticsId,
  nextDraftTemplateAnalyticsRow,
  parseDraftTemplateAnalyticsId,
  readDraftTemplateAnalyticsRow,
} from "@/platform/persistence/draftTemplateAnalytics"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { SpineStore } from "@/platform/spine/store"

const TEMPLATE = { id: "writ_mandamus", name: "Writ of Mandamus", posture: "writ", category: "constitutional" }

/** A stored row of firm_a for writ_mandamus, written by hand (not by the code under test). */
const stored = (extra: Record<string, unknown> = {}) => ({
  id: "template:firm_a:writ_mandamus",
  firmId: "firm_a",
  templateId: "writ_mandamus",
  templateName: "Writ of Mandamus",
  templatePosture: "writ",
  templateCategory: "constitutional",
  composeCount: 4,
  templateSearchCount: 2,
  lastComposedAt: 100,
  lastTemplateSearchAt: 90,
  lastTemplateSearchQuery: "mandamus",
  updatedAt: 100,
  ...extra,
})

describe("FA-D4-001: the firm-qualified id", () => {
  it("is template:{firmId}:{templateId}", () => {
    expect(draftTemplateAnalyticsId("firm_a", "writ_mandamus")).toBe("template:firm_a:writ_mandamus")
    expect(draftTemplateAnalyticsId("firm_b", "writ_mandamus")).toBe("template:firm_b:writ_mandamus")
  })

  it.each([
    ["an empty firm", "", "writ_mandamus"],
    ["a blank firm", "   ", "writ_mandamus"],
    ["a firm with a colon", "firm:a", "writ_mandamus"],
    ["a firm with a slash", "firm/a", "writ_mandamus"],
    ["an empty template", "firm_a", ""],
    ["a template with a colon", "firm_a", "writ:mandamus"],
    ["a template with a slash", "firm_a", "writ/mandamus"],
  ])("refuses %s", (_label, firmId, templateId) => {
    expect(() => draftTemplateAnalyticsId(firmId, templateId)).toThrow()
  })

  it("refuses a separator with its own error (not a missing-firm error) when the firm is present", () => {
    expect(() => draftTemplateAnalyticsId("firm:a", "writ_mandamus")).toThrow(DraftTemplateAnalyticsIdError)
    expect(() => draftTemplateAnalyticsId("firm_a", "writ/mandamus")).toThrow(DraftTemplateAnalyticsIdError)
  })

  it("parses a firm-qualified id and nothing else", () => {
    expect(parseDraftTemplateAnalyticsId("template:firm_a:writ_mandamus")).toEqual({ firmId: "firm_a", templateId: "writ_mandamus" })
    expect(parseDraftTemplateAnalyticsId("template:writ_mandamus")).toBeNull()
    expect(parseDraftTemplateAnalyticsId("template:a:b:c")).toBeNull()
    expect(parseDraftTemplateAnalyticsId("template::writ_mandamus")).toBeNull()
    expect(parseDraftTemplateAnalyticsId("other:firm_a:writ_mandamus")).toBeNull()
  })

  it("recognises the legacy shared id only", () => {
    expect(isLegacyDraftTemplateAnalyticsId("template:writ_mandamus")).toBe(true)
    expect(isLegacyDraftTemplateAnalyticsId("template:firm_a:writ_mandamus")).toBe(false)
    expect(isLegacyDraftTemplateAnalyticsId("template:")).toBe(false)
    expect(isLegacyDraftTemplateAnalyticsId("writ_mandamus")).toBe(false)
  })
})

describe("FA-D4-001: the row validator", () => {
  it("returns the row with the document id, whatever id the data carries", () => {
    expect(readDraftTemplateAnalyticsRow("template:firm_a:writ_mandamus", stored({ id: "forged" }))).toEqual(stored())
  })

  it("refuses a legacy id and an id naming another firm or template", () => {
    expect(readDraftTemplateAnalyticsRow("template:writ_mandamus", stored())).toBeNull()
    expect(readDraftTemplateAnalyticsRow("template:firm_b:writ_mandamus", stored())).toBeNull()
    expect(readDraftTemplateAnalyticsRow("template:firm_a:writ_certiorari", stored())).toBeNull()
  })

  it.each([
    ["firmId absent", { firmId: undefined }],
    ["templateId as a number", { templateId: 7 }],
    ["templateName absent", { templateName: undefined }],
    ["templatePosture as null", { templatePosture: null }],
    ["templateCategory as a number", { templateCategory: 1 }],
    ["a negative composeCount", { composeCount: -1 }],
    ["a fractional composeCount", { composeCount: 1.5 }],
    ["composeCount as a string", { composeCount: "4" }],
    ["a negative templateSearchCount", { templateSearchCount: -2 }],
    ["lastComposedAt as a string", { lastComposedAt: "100" }],
    ["lastTemplateSearchAt absent", { lastTemplateSearchAt: undefined }],
    ["lastTemplateSearchQuery as a number", { lastTemplateSearchQuery: 3 }],
    ["updatedAt as NaN", { updatedAt: Number.NaN }],
  ])("refuses %s", (_label, extra) => {
    expect(readDraftTemplateAnalyticsRow("template:firm_a:writ_mandamus", stored(extra))).toBeNull()
  })

  it("refuses data that is not a plain object", () => {
    expect(readDraftTemplateAnalyticsRow("template:firm_a:writ_mandamus", null)).toBeNull()
    expect(readDraftTemplateAnalyticsRow("template:firm_a:writ_mandamus", [stored()])).toBeNull()
  })
})

describe("FA-D4-001: the decision every write goes through", () => {
  it("a first compose creates the firm's row with count 1", () => {
    expect(nextDraftTemplateAnalyticsRow("firm_a", TEMPLATE, null, { kind: "compose" }, { now: 500 })).toEqual({
      id: "template:firm_a:writ_mandamus",
      firmId: "firm_a",
      templateId: "writ_mandamus",
      templateName: "Writ of Mandamus",
      templatePosture: "writ",
      templateCategory: "constitutional",
      composeCount: 1,
      templateSearchCount: 0,
      lastComposedAt: 500,
      lastTemplateSearchAt: null,
      lastTemplateSearchQuery: null,
      updatedAt: 500,
    })
  })

  it("a compose increments the stored row and keeps its search fields", () => {
    expect(nextDraftTemplateAnalyticsRow("firm_a", TEMPLATE, stored(), { kind: "compose" }, { now: 600 })).toEqual(
      stored({ composeCount: 5, lastComposedAt: 600, updatedAt: 600 })
    )
  })

  it("a search increments the search count and records the query", () => {
    expect(nextDraftTemplateAnalyticsRow("firm_a", TEMPLATE, stored(), { kind: "search", query: "writ" }, { now: 700 })).toEqual(
      stored({ templateSearchCount: 3, lastTemplateSearchAt: 700, lastTemplateSearchQuery: "writ", updatedAt: 700 })
    )
  })

  it("refuses a stored row stamped with another firm (foreign_firm), for a compose and for a search", () => {
    for (const change of [{ kind: "compose" } as const, { kind: "search", query: "writ" } as const]) {
      let err: unknown
      try {
        nextDraftTemplateAnalyticsRow("firm_a", TEMPLATE, stored({ firmId: "firm_b" }), change)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(DraftTemplateAnalyticsRefusedError)
      expect((err as DraftTemplateAnalyticsRefusedError).reason).toBe("foreign_firm")
    }
  })

  it("refuses a malformed stored row of the caller's firm (malformed)", () => {
    let err: unknown
    try {
      nextDraftTemplateAnalyticsRow("firm_a", TEMPLATE, stored({ composeCount: "4" }), { kind: "compose" })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DraftTemplateAnalyticsRefusedError)
    expect((err as DraftTemplateAnalyticsRefusedError).reason).toBe("malformed")
  })

  it("refuses a stored row with no firm at all", () => {
    expect(() => nextDraftTemplateAnalyticsRow("firm_a", TEMPLATE, stored({ firmId: undefined }), { kind: "compose" })).toThrow(
      DraftTemplateAnalyticsRefusedError
    )
  })
})

describe("FA-D4-001: the memory repository", () => {
  it("two firms composing one template keep two rows with their own counts", async () => {
    const store = new SpineStore()
    const repos = createMemoryRepositories(store)
    await repos.draftTemplateAnalytics.record("firm_b", TEMPLATE, { kind: "compose" })
    await repos.draftTemplateAnalytics.record("firm_a", TEMPLATE, { kind: "compose" })
    await repos.draftTemplateAnalytics.record("firm_a", TEMPLATE, { kind: "search", query: "writ" })
    expect((await repos.draftTemplateAnalytics.listByFirm("firm_b")).map((r) => [r.id, r.composeCount, r.templateSearchCount])).toEqual([
      ["template:firm_b:writ_mandamus", 1, 0],
    ])
    expect((await repos.draftTemplateAnalytics.listByFirm("firm_a")).map((r) => [r.id, r.composeCount, r.templateSearchCount])).toEqual([
      ["template:firm_a:writ_mandamus", 1, 1],
    ])
    expect(await repos.draftTemplateAnalytics.get("template:firm_b:writ_mandamus", "firm_a")).toBeNull()
  })

  it("ignores a legacy row: not listed, not read, not written", async () => {
    const store = new SpineStore()
    const legacy = stored({ id: "template:writ_mandamus" })
    store.draftTemplateAnalytics.set("template:writ_mandamus", legacy as never)
    const repos = createMemoryRepositories(store)
    expect(await repos.draftTemplateAnalytics.listByFirm("firm_a")).toEqual([])
    expect(await repos.draftTemplateAnalytics.get("template:writ_mandamus", "firm_a")).toBeNull()
    const next = await repos.draftTemplateAnalytics.record("firm_a", TEMPLATE, { kind: "compose" })
    expect(next.composeCount).toBe(1)
    expect(store.draftTemplateAnalytics.get("template:writ_mandamus")).toEqual(legacy)
  })

  it("refuses to write over a row at the firm's id stamped with another firm, and leaves it", async () => {
    const store = new SpineStore()
    const foreign = stored({ firmId: "firm_b" })
    store.draftTemplateAnalytics.set("template:firm_a:writ_mandamus", foreign as never)
    const repos = createMemoryRepositories(store)
    await expect(repos.draftTemplateAnalytics.record("firm_a", TEMPLATE, { kind: "compose" })).rejects.toBeInstanceOf(
      DraftTemplateAnalyticsRefusedError
    )
    expect(store.draftTemplateAnalytics.get("template:firm_a:writ_mandamus")).toEqual(foreign)
  })

  it("requires a caller firm", async () => {
    const repos = createMemoryRepositories(new SpineStore())
    await expect(repos.draftTemplateAnalytics.record("", TEMPLATE, { kind: "compose" })).rejects.toThrow()
    await expect(repos.draftTemplateAnalytics.listByFirm("")).rejects.toThrow()
  })
})
