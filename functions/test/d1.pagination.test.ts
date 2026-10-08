import { describe, expect, it } from "vitest"
import { HttpError } from "../src/http/errors"
import { decodeCursor, encodeCursor, parsePage } from "../src/d1/pagination"

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code }
    throw e
  }
  throw new Error("expected HttpError")
}

describe("parsePage", () => {
  it("defaults to limit 20, no cursor", () => {
    expect(parsePage({})).toEqual({ limit: 20, cursor: null })
  })
  it("accepts 1 and 100", () => {
    expect(parsePage({ limit: "100" })).toEqual({ limit: 100, cursor: null })
    expect(parsePage({ limit: "1" }).limit).toBe(1)
  })
  it.each(["0", "101", "2.5", "x", "", "-1"])("rejects limit %j", (limit) => {
    expect(codeOf(() => parsePage({ limit }))).toEqual({ status: 400, code: "invalid_limit" })
  })
  it("passes a cursor through", () => {
    expect(parsePage({ cursor: "abc" })).toEqual({ limit: 20, cursor: "abc" })
  })
})

describe("cursor", () => {
  it("round-trips", () => {
    const c = encodeCursor("2026-10-07T00:00:00Z", "abc")
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(c)).toEqual({ sortKey: "2026-10-07T00:00:00Z", id: "abc" })
  })
  it.each(["%%", "", Buffer.from("[]").toString("base64url"), Buffer.from('{"sortKey":1,"id":"a"}').toString("base64url")])(
    "malformed %j → 400 invalid_cursor",
    (c) => {
      expect(codeOf(() => decodeCursor(c))).toEqual({ status: 400, code: "invalid_cursor" })
    }
  )
})
