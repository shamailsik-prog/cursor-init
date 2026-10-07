// Spec audit U-11 (L18 §4.3): list endpoints take `limit` (default 20, max 100).
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, parseCursor, parseLimit } from "@/platform/http/pagination"
import { GET as MATTERS_GET } from "@/app/api/d1/matters/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

afterEach(() => resetRuntimeStoreForTests())

describe("list pagination (L18 §4.3)", () => {
  it("limit defaults to 20 and is capped at 100", () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(20)
    expect(MAX_PAGE_LIMIT).toBe(100)
    expect(parseLimit(null)).toBe(20)
    expect(parseLimit("")).toBe(20)
    expect(parseLimit("0")).toBe(20)
    expect(parseLimit("-3")).toBe(20)
    expect(parseLimit("abc")).toBe(20)
    expect(parseLimit("7")).toBe(7)
    expect(parseLimit("100")).toBe(100)
    expect(parseLimit("101")).toBe(100)
  })

  it("cursor is a non-negative offset (transitional)", () => {
    expect(parseCursor(null)).toBe(0)
    expect(parseCursor("-1")).toBe(0)
    expect(parseCursor("x")).toBe(0)
    expect(parseCursor("40")).toBe(40)
  })

  it("a list route without a limit returns 20 items", async () => {
    const store = getRuntimeStore()
    for (let i = 0; i < 25; i++) {
      const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: `m${i}`, courtId: "SHC", classification: "internal" })
      addMember(store, m.id, "partner_a", "firmA")
    }
    const res = await MATTERS_GET(new Request("http://127.0.0.1/api/d1/matters?userId=partner_a"))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: unknown[]; limit: number; nextCursor: string | null }
    expect(json.limit).toBe(20)
    expect(json.items).toHaveLength(20)
    expect(json.nextCursor).toBe("20")
  })
})
