import { describe, expect, it } from "vitest"
import {
  matterIdsInBody,
  matterIdsToCheck,
  MAX_RECORDED_MATTERS,
  recordOperationMatter,
  recordedMatterFields,
  runRecordingMatters,
} from "@/platform/retention/operationMatters"

describe("FA-F42-R1-001: operation matter recording (shared idempotency tombstone replay)", () => {
  it("collects matterId and linkedMatterId from a stored answer body", () => {
    expect(matterIdsInBody({ matterId: "m1", nested: { linkedMatterId: "m2" } }).sort()).toEqual(["m1", "m2"])
    expect(matterIdsInBody({ matterId: "", matterIdWithSlash: "bad/id" })).toEqual([])
  })

  it("recordedMatterFields unions the permission scope and the body, sorted and capped", () => {
    const fields = recordedMatterFields(["b", "a"], { matterId: "c", linkedMatterId: "a" })
    expect(fields).toEqual({ matterIds: ["a", "b", "c"], matterIdsTruncated: false })
  })

  it("marks truncation when more than MAX_RECORDED_MATTERS ids would be stored", () => {
    const many = Array.from({ length: MAX_RECORDED_MATTERS + 1 }, (_, i) => `m${i}`)
    const fields = recordedMatterFields(many, null)
    expect(fields.matterIds).toHaveLength(MAX_RECORDED_MATTERS)
    expect(fields.matterIdsTruncated).toBe(true)
  })

  it("matterIdsToCheck unions record matterIds with body ids and honours matterIdsTruncated", () => {
    const { ids, truncated } = matterIdsToCheck({ matterIds: ["stored"] }, { matterId: "from-body" })
    expect(ids.sort()).toEqual(["from-body", "stored"])
    expect(truncated).toBe(false)
    expect(matterIdsToCheck({ matterIdsTruncated: true }, { matterId: "x" }).truncated).toBe(true)
  })

  it("runRecordingMatters chains into nested scopes (F02 frame + inner core)", () => {
    const outer = new Set<string>()
    const inner = new Set<string>()
    runRecordingMatters(outer, () => {
      recordOperationMatter("outer-only")
      runRecordingMatters(inner, () => {
        recordOperationMatter("both")
      })
    })
    expect([...outer].sort()).toEqual(["both", "outer-only"])
    expect([...inner]).toEqual(["both"])
  })
})
