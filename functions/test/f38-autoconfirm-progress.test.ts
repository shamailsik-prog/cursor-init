import { describe, expect, it } from "vitest"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { autoConfirmHandler } from "../src/d1/entity/autoConfirmJob"
import { AUTO_CONFIRM_RECHECK_MS, deferralIdOf, judgeRows } from "../src/d1/entity/autoConfirmDeferral"
import { LINK_AUTO_CONFIRM_MS } from "../src/d1/entity/linkState"

/**
 * Audit F38 (spec docs/superpowers/specs/2026-10-18-f38-auto-confirm-progress-design.md), the pure parts:
 * the job payload (R6), the deferral reasons, their precedence and due times (R3, R4), and the deferral id (R2).
 */

const DAY = 86_400_000
const NOW = Date.parse("2033-03-01T00:00:00Z")
const ts = (ms: number) => Timestamp.fromMillis(ms)
const aged = (extra: Record<string, unknown> = {}): DocumentData => ({ state: "candidate", disputed: false, createdAt: ts(NOW - LINK_AUTO_CONFIRM_MS - DAY), ...extra })
const rows = (...data: DocumentData[]) => data.map((d, i) => ({ id: `link-${i}`, data: d }))

describe("F38 auto-confirm job payload (R6)", () => {
  const parse = (p: unknown) => autoConfirmHandler.parse(p)

  it("accepts the scheduled run's { period } as continuation 0 and a continuation's { period, continuation: 1..23 }", () => {
    expect(parse({ period: "2033-03-01" })).toEqual({ period: "2033-03-01", continuation: 0 })
    expect(parse({ period: "2033-03-01", continuation: 1 })).toEqual({ period: "2033-03-01", continuation: 1 })
    expect(parse({ period: "2033-03-01", continuation: 23 })).toEqual({ period: "2033-03-01", continuation: 23 })
  })

  it("refuses continuation 0, 24, a fraction, a string, an extra key and a bad period as the permanent invalid_payload", () => {
    for (const bad of [
      { period: "2033-03-01", continuation: 0 },
      { period: "2033-03-01", continuation: 24 },
      { period: "2033-03-01", continuation: 1.5 },
      { period: "2033-03-01", continuation: "1" },
      { period: "2033-03-01", continuation: 1, extra: true },
      { period: "2033-03-01", other: 1 },
      { period: "2033-3-1" },
      { continuation: 1 },
      null,
      [],
    ]) {
      expect(() => parse(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "invalid_payload", permanent: true }))
    }
  })
})

describe("F38 deferral reasons and due times (R3, R4)", () => {
  it("a pair with no row left in the scan's predicate has left the backlog", () => {
    expect(judgeRows(rows(aged({ disputed: true })), NOW)).toEqual({ kind: "gone" })
    expect(judgeRows(rows(aged({ state: "confirmed" }), aged({ state: "rejected" })), NOW)).toEqual({ kind: "gone" })
    expect(judgeRows(rows(aged({ createdAt: ts(NOW - DAY) })), NOW)).toEqual({ kind: "gone" })
    expect(judgeRows([], NOW)).toEqual({ kind: "gone" })
  })

  it("every row an aged undisputed candidate is eligible, exactly at the 30-day mark too", () => {
    expect(judgeRows(rows(aged(), aged()), NOW)).toEqual({ kind: "eligible" })
    expect(judgeRows(rows(aged({ createdAt: ts(NOW - LINK_AUTO_CONFIRM_MS) })), NOW)).toEqual({ kind: "eligible" })
  })

  it("each row reason, with the deciding row's id and a recheck 7 days on", () => {
    const later = NOW + AUTO_CONFIRM_RECHECK_MS
    expect(AUTO_CONFIRM_RECHECK_MS).toBe(7 * DAY)
    const cases: Array<[DocumentData, string]> = [
      [aged({ unmerge: { status: "in_progress" } }), "unmerge_in_progress"],
      [aged({ state: "confirmed" }), "confirmed_row"],
      [aged({ state: "rejected" }), "rejected_row"],
      [aged({ disputed: true }), "disputed_row"],
      [aged({ state: "merged" }), "invalid_row"],
      [aged({ disputed: "no" }), "invalid_row"],
      [aged({ createdAt: "2033-01-01" }), "invalid_row"],
    ]
    for (const [other, reason] of cases) {
      expect(judgeRows(rows(aged(), other), NOW), reason).toEqual({ kind: "deferred", reason, rowId: "link-1", recheckAtMs: later })
    }
  })

  it("a young row defers the pair until the latest young row's 30-day mark", () => {
    const young1 = NOW - 5 * DAY
    const young2 = NOW - 2 * DAY
    expect(judgeRows(rows(aged(), aged({ createdAt: ts(young1) }), aged({ createdAt: ts(young2) })), NOW)).toEqual({
      kind: "deferred",
      reason: "young_row",
      rowId: "link-1",
      recheckAtMs: young2 + LINK_AUTO_CONFIRM_MS,
    })
  })

  it("precedence: unmerge_in_progress > confirmed_row > rejected_row > disputed_row > invalid_row > young_row", () => {
    const order: Array<[DocumentData, string]> = [
      [aged({ unmerge: { status: "in_progress" } }), "unmerge_in_progress"],
      [aged({ state: "confirmed" }), "confirmed_row"],
      [aged({ state: "rejected" }), "rejected_row"],
      [aged({ disputed: true }), "disputed_row"],
      [aged({ state: "merged" }), "invalid_row"],
      [aged({ createdAt: ts(NOW - DAY) }), "young_row"],
    ]
    for (let i = 0; i < order.length; i += 1) {
      // The stronger cause is put last, so precedence (not row order) decides.
      const weaker = order.slice(i + 1).map(([d]) => d)
      const verdict = judgeRows(rows(aged(), ...weaker, order[i][0]), NOW)
      expect(verdict, order[i][1]).toMatchObject({ kind: "deferred", reason: order[i][1], rowId: `link-${weaker.length + 1}` })
    }
  })
})

describe("F38 deferral id (R2), fixed vector", () => {
  it("acd_ + the first 40 hex of SHA-256(firmId NUL pairId), checked against a hard-coded digest", () => {
    // Computed independently (Python hashlib) from b"firm-1\x00aaa_bbb".
    expect(deferralIdOf("firm-1", "aaa_bbb")).toBe("acd_42e573d746f33bd7fd45615a75ce3fbf531f9c53")
    expect(deferralIdOf("firm-2", "aaa_bbb")).not.toBe(deferralIdOf("firm-1", "aaa_bbb"))
  })
})
