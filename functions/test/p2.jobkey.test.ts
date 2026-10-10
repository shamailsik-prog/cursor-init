import { describe, expect, it } from "vitest"
import { jobKey } from "../src/p2/enqueue"
import type { Session } from "../src/p5/common"

const KEY = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b"
const session = (uid: string, extra: { route?: string; idempotencyKey?: string }): Session =>
  ({ caller: { uid, firmId: "f1" }, secondFactor: false, ...extra }) as unknown as Session

describe("jobKey (O-44, P3-38)", () => {
  const x = { route: "POST /api/x", idempotencyKey: KEY }
  it("scopes by uid, route, lower-cased key and suffix", () => {
    expect(jobKey(session("u1", x), "ocr")).toBe(`u1:POST /api/x:${KEY}:ocr`)
  })
  it("differs for two uids sending one key on one route", () => {
    expect(jobKey(session("u1", x), "ocr")).not.toBe(jobKey(session("u2", x), "ocr"))
  })
  it("differs for two routes with one key", () => {
    expect(jobKey(session("u1", x), "ocr")).not.toBe(jobKey(session("u1", { ...x, route: "POST /api/y" }), "ocr"))
  })
  it("is equal for upper- and lower-case forms of one UUID", () => {
    expect(jobKey(session("u1", { ...x, idempotencyKey: KEY.toUpperCase() }), "ocr")).toBe(jobKey(session("u1", x), "ocr"))
  })
  it("still throws without a key, and without a route", () => {
    expect(() => jobKey(session("u1", { route: x.route }), "ocr")).toThrow(/no idempotency key/)
    expect(() => jobKey(session("u1", { ...x, idempotencyKey: "" }), "ocr")).toThrow(/no idempotency key/)
    expect(() => jobKey(session("u1", { idempotencyKey: KEY }), "ocr")).toThrow(/no route/)
  })
})
