import { describe, expect, it } from "vitest"
import { canonicalEncode, collectionPattern, docHash } from "../firestore/canonical"

describe("canonicalEncode", () => {
  it("distinguishes null, false, 0, empty string, array and object", () => {
    const enc = (v: unknown) => canonicalEncode(v).toString("utf8")
    expect(enc(null)).not.toBe(enc(false))
    expect(enc(false)).not.toBe(enc(0))
    expect(enc(0)).not.toBe(enc(""))
    expect(enc("")).not.toBe(enc([]))
    expect(enc([])).not.toBe(enc({}))
    expect(enc("0")).not.toBe(enc(0))
  })

  it("handles -0 and NaN", () => {
    expect(canonicalEncode(-0).toString("utf8")).toContain("-0")
    expect(canonicalEncode(NaN).toString("utf8")).toContain("NaN")
  })

  it("sorts map keys", () => {
    const a = canonicalEncode({ b: 1, a: 2 })
    const b = canonicalEncode({ a: 2, b: 1 })
    expect(a.equals(b)).toBe(true)
  })

  it("depends on array order", () => {
    const a = canonicalEncode([1, 2])
    const b = canonicalEncode([2, 1])
    expect(a.equals(b)).toBe(false)
  })
})

describe("collectionPattern", () => {
  it("replaces document ids with *", () => {
    expect(collectionPattern("firms/abc/clients/def")).toBe("firms/*/clients/*")
  })
})

describe("docHash", () => {
  it("changes when data changes", () => {
    const a = docHash("clients/x", { firmId: "firm-alpha" })
    const b = docHash("clients/x", { firmId: "firm-bravo" })
    expect(a.equals(b)).toBe(false)
  })
})
