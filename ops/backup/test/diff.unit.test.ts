import { createHash, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { MultisetDigest } from "../lib/digest"
import { diffRecords, diffSets } from "../lib/diff"

describe("diffRecords", () => {
  it("returns no lines when records are equal", () => {
    const a = { x: 1, y: "two" }
    expect(diffRecords("root", a, a)).toEqual([])
  })

  it("reports a changed value", () => {
    const lines = diffRecords("table.public.t", { a: 1 }, { a: 2 })
    expect(lines).toEqual(["table.public.t.a: 1 -> 2"])
  })

  it("reports a missing key", () => {
    const lines = diffRecords("m", { a: 1, b: 2 }, { a: 1 })
    expect(lines).toEqual(["m.b: missing (expected 2)"])
  })

  it("reports an extra key", () => {
    const lines = diffRecords("m", { a: 1 }, { a: 1, z: 9 })
    expect(lines).toEqual(["m.z: unexpected (actual 9)"])
  })
})

describe("diffSets", () => {
  it("returns no lines when sets are equal", () => {
    expect(diffSets("defs", ["a", "b"], ["b", "a"])).toEqual([])
  })

  it("reports missing and unexpected entries", () => {
    const lines = diffSets("roles", ["r1", "r2"], ["r2", "r3"])
    expect(lines).toContain("roles: missing r1")
    expect(lines).toContain("roles: unexpected r3")
    expect(lines).toHaveLength(2)
  })
})

describe("MultisetDigest", () => {
  function rowHash(text: string): Buffer {
    return createHash("sha256").update(text).digest()
  }

  it("is order independent", () => {
    const a = new MultisetDigest()
    const b = new MultisetDigest()
    const h1 = rowHash("one")
    const h2 = rowHash("two")
    a.add(h1)
    a.add(h2)
    b.add(h2)
    b.add(h1)
    expect(a.digest()).toBe(b.digest())
    expect(a.count).toBe(2)
  })

  it("is count sensitive (duplicate rows change the digest)", () => {
    const once = new MultisetDigest()
    const twice = new MultisetDigest()
    const h = rowHash("dup")
    once.add(h)
    twice.add(h)
    twice.add(h)
    expect(once.digest()).not.toBe(twice.digest())
    expect(twice.count).toBe(2)
  })

  it("is content sensitive", () => {
    const a = new MultisetDigest()
    const b = new MultisetDigest()
    a.add(rowHash("alpha"))
    b.add(rowHash("bravo"))
    expect(a.digest()).not.toBe(b.digest())
  })

  it("matches the SQL golden formulation (four int64 word sums)", () => {
    const d = new MultisetDigest()
    const rows = ["pk\x1e{}", "only-row-no-pk"]
    for (const r of rows) d.add(createHash("sha256").update(r).digest())
    // Golden computed once from the reference SQL in the pg drill; fixed fixture.
    expect(d.digest()).toBe("ac9bed4f0699c609f463d524a2edb28f9ba2999773702a8c2b9d1a9accc6f94f")
  })
})
