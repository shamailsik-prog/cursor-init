import { describe, expect, it } from "vitest"
import { isKnownClassification, rankOf } from "../src/p5/classification"

const PROTO_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]

describe("p5 classification guard", () => {
  it("accepts exactly the five labels, with integer ranks 0–4", () => {
    const labels = ["public", "internal", "confidential", "privileged", "privileged-restricted"] as const
    for (const [i, l] of labels.entries()) {
      expect(isKnownClassification(l)).toBe(true)
      expect(rankOf(l)).toBe(i)
    }
  })

  it.each(PROTO_KEYS)("rejects Object.prototype key %j", (key) => {
    expect(isKnownClassification(key)).toBe(false)
    expect(() => rankOf(key as never)).toThrow()
  })

  it("rejects non-strings and unknown labels", () => {
    for (const v of [undefined, null, 0, {}, "bogus", "Public"]) expect(isKnownClassification(v)).toBe(false)
  })
})
