import { describe, expect, it } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import {
  autoConfirmAt,
  DETERMINISTIC_KEY_SCORE,
  effectiveLinkState,
  isConfirmedState,
  LINK_AUTO_CONFIRM_MS,
  pairIdOf,
} from "../src/d1/entity/linkState"
import { LINK_AUTO_CONFIRM_MS as ENGINE_LINK_AUTO_CONFIRM_MS, linkConfirmed } from "../src/d1/conflict/engine"

/** L17.2 effective link state at read time (spec P2-26, P2-29; Review Focus 2). */

const DAY_MS = 24 * 60 * 60 * 1000
const now = Date.parse("2026-10-08T00:00:00Z")
const ts = (ms: number) => Timestamp.fromMillis(ms)

const table: Array<[string, Record<string, unknown>, string]> = [
  ["undisputed candidate at 30 d minus 1 ms", { state: "candidate", disputed: false, createdAt: ts(now - 30 * DAY_MS + 1) }, "candidate"],
  ["undisputed candidate at exactly 30 d", { state: "candidate", disputed: false, createdAt: ts(now - 30 * DAY_MS) }, "auto_confirmed"],
  ["disputed candidate at 31 d", { state: "candidate", disputed: true, createdAt: ts(now - 31 * DAY_MS) }, "disputed"],
  ["confirmed (even if disputed was set)", { state: "confirmed", disputed: true }, "confirmed"],
  ["rejected", { state: "rejected" }, "rejected"],
  ["an unknown state", { state: "split" }, "candidate"],
  ["a candidate with disputed missing", { state: "candidate", createdAt: ts(now - 31 * DAY_MS) }, "candidate"],
]

describe("effectiveLinkState", () => {
  it("constants", () => {
    expect(LINK_AUTO_CONFIRM_MS).toBe(30 * DAY_MS)
    expect(ENGINE_LINK_AUTO_CONFIRM_MS).toBe(LINK_AUTO_CONFIRM_MS)
    expect(DETERMINISTIC_KEY_SCORE).toBe(0.99)
  })

  for (const [label, row, expected] of table) {
    it(`${label} → ${expected} (flag on); candidate (flag off)`, () => {
      expect(effectiveLinkState(row, now, true)).toBe(expected)
      expect(effectiveLinkState(row, now, false)).toBe("candidate")
    })
  }

  it("a missing or non-Timestamp createdAt never auto-confirms; a non-boolean disputed reads as candidate", () => {
    expect(effectiveLinkState({ state: "candidate", disputed: false }, now, true)).toBe("candidate")
    expect(effectiveLinkState({ state: "candidate", disputed: false, createdAt: now - 31 * DAY_MS }, now, true)).toBe("candidate")
    expect(effectiveLinkState({ state: "candidate", disputed: "true", createdAt: ts(now - 31 * DAY_MS) }, now, true)).toBe("candidate")
  })

  it("isConfirmedState: confirmed and auto_confirmed only", () => {
    expect(["candidate", "auto_confirmed", "disputed", "confirmed", "rejected"].filter((s) => isConfirmedState(s as never))).toEqual([
      "auto_confirmed",
      "confirmed",
    ])
  })

  it("engine linkConfirmed delegates: rejected and disputed are never confirmed", () => {
    for (const [, row, expected] of table) {
      expect(linkConfirmed(row, now, true)).toBe(expected === "confirmed" || expected === "auto_confirmed")
      expect(linkConfirmed(row, now, false)).toBe(false)
    }
  })
})

describe("autoConfirmAt / pairIdOf", () => {
  it("createdAt + 30 d for an undisputed candidate", () => {
    const at = autoConfirmAt({ state: "candidate", disputed: false, createdAt: ts(Date.parse("2026-10-01T00:00:00Z")) })
    expect(at?.toISOString()).toBe("2026-10-31T00:00:00.000Z")
  })
  it("null when disputed, confirmed, rejected or without a createdAt", () => {
    const createdAt = ts(Date.parse("2026-10-01T00:00:00Z"))
    expect(autoConfirmAt({ state: "candidate", disputed: true, createdAt })).toBeNull()
    expect(autoConfirmAt({ state: "confirmed", disputed: false, createdAt })).toBeNull()
    expect(autoConfirmAt({ state: "rejected", disputed: false, createdAt })).toBeNull()
    expect(autoConfirmAt({ state: "candidate", disputed: false })).toBeNull()
  })
  it("pairIdOf joins leftId and rightId", () => {
    expect(pairIdOf({ leftId: "a", rightId: "b" })).toBe("a_b")
  })
})
