import { describe, expect, it } from "vitest"
import { MAX_OUTPUT_TOKENS, MODEL_PRICES, PROVIDER_ID, TASK_MODEL, costMicroUsd, estimateTokens } from "../src/p1/costTable"
import { isMonthKey, monthKeyPkt } from "../src/p1/month"
import { buildTrace, opikConfig, type TraceRecord } from "../src/p1/opik"
import { TRANSPORT_ERROR } from "../src/p1/types"
import { uuidv7 } from "../src/p1/uuidv7"

const OPUS = "anthropic/claude-opus-5.5"

describe("P1 cost table (P3-62)", () => {
  it("routes the committee task to Opus at the pinned list price", () => {
    expect(TASK_MODEL.committee).toBe(OPUS)
    expect(MODEL_PRICES[OPUS]).toMatchObject({ inputNanoUsdPerToken: 4000, outputNanoUsdPerToken: 20000, fetchedAt: "2026-10-11" })
    expect(MODEL_PRICES[OPUS]?.source).toMatch(/\S/)
    expect(MAX_OUTPUT_TOKENS).toBe(4096)
    expect(PROVIDER_ID).toBe("ai-gateway")
  })

  it("costMicroUsd is ceil((in x inputPrice + out x outputPrice) / 1000)", () => {
    expect(costMicroUsd(OPUS, 1000, 500)).toBe(14000)
    expect(costMicroUsd(OPUS, 1, 0)).toBe(4)
    expect(costMicroUsd(OPUS, 0, 1)).toBe(20)
    expect(costMicroUsd(OPUS, 0, 0)).toBe(0)
    // 1 x 4000 + 1 x 20000 = 24000 nano-USD is exactly 24 micro-USD; one more input token rounds up.
    expect(costMicroUsd(OPUS, 1, 1)).toBe(24)
    expect(costMicroUsd(OPUS, 3, 0)).toBe(12)
  })

  it("costMicroUsd rounds a fractional micro-USD up, never down", () => {
    const prices = MODEL_PRICES as Record<string, unknown>
    prices["test/odd-price"] = { inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1, source: "test", fetchedAt: "2026-10-11" }
    try {
      expect(costMicroUsd("test/odd-price", 1, 0)).toBe(1)
      expect(costMicroUsd("test/odd-price", 1000, 0)).toBe(1)
      expect(costMicroUsd("test/odd-price", 1001, 0)).toBe(2)
    } finally {
      delete prices["test/odd-price"]
    }
  })

  it("costMicroUsd returns null for an unpriced model, including inherited object keys", () => {
    expect(costMicroUsd("x/unknown", 1, 1)).toBeNull()
    expect(costMicroUsd("", 1, 1)).toBeNull()
    expect(costMicroUsd("constructor", 1, 1)).toBeNull()
    expect(costMicroUsd("__proto__", 1, 1)).toBeNull()
    expect(costMicroUsd("toString", 1, 1)).toBeNull()
  })

  it("estimateTokens is ceil(UTF-8 bytes / 3)", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("abc")).toBe(1)
    expect(estimateTokens("abcd")).toBe(2)
    expect(estimateTokens("ک")).toBe(1) // 2 bytes
    expect(estimateTokens("کک")).toBe(2) // 4 bytes
    expect(estimateTokens("€")).toBe(1) // 3 bytes
    expect(estimateTokens("😀")).toBe(2) // 4 bytes
  })
})

describe("P1 PKT month key (P3-64)", () => {
  it("monthKeyPkt rolls over at 19:00 UTC on the last day, the PKT midnight", () => {
    expect(monthKeyPkt(Date.parse("2026-10-31T19:00:00Z"))).toBe("2026-11")
    expect(monthKeyPkt(Date.parse("2026-10-31T18:59:59Z"))).toBe("2026-10")
    expect(monthKeyPkt(Date.parse("2026-12-31T19:00:00Z"))).toBe("2027-01")
    expect(monthKeyPkt(Date.parse("2026-12-31T18:59:59.999Z"))).toBe("2026-12")
    expect(monthKeyPkt(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-01")
    expect(monthKeyPkt(Date.parse("2026-02-28T19:00:00Z"))).toBe("2026-03")
    expect(monthKeyPkt(Date.parse("2028-02-28T19:00:00Z"))).toBe("2028-02")
    expect(monthKeyPkt(Date.parse("2028-02-29T19:00:00Z"))).toBe("2028-03")
  })

  it("isMonthKey accepts YYYY-MM with months 01 to 12 only", () => {
    for (const ok of ["2026-01", "2026-09", "2026-10", "2026-12", "0001-06"]) expect(isMonthKey(ok), ok).toBe(true)
    for (const bad of ["2026-13", "2026-00", "2026-1", "2026-011", "202-01", "x", "", "2026-01-01", " 2026-01", "2026-01\n"]) {
      expect(isMonthKey(bad), JSON.stringify(bad)).toBe(false)
    }
    for (const bad of [null, undefined, 202601, {}, ["2026-01"]]) expect(isMonthKey(bad)).toBe(false)
  })
})

describe("P1 UUIDv7 (P3-67)", () => {
  const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it("has the v7 layout and carries the millisecond timestamp in its first 48 bits", () => {
    const t = Date.parse("2026-10-11T12:34:56.789Z")
    const id = uuidv7(t)
    expect(id).toMatch(UUID7)
    expect(id.replace(/-/g, "").slice(0, 12)).toBe(t.toString(16).padStart(12, "0"))
  })

  it("defaults to the current time", () => {
    const before = Date.now()
    const id = uuidv7()
    const after = Date.now()
    const ts = parseInt(id.replace(/-/g, "").slice(0, 12), 16)
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it("pads small timestamps and keeps the version and variant bits over many draws", () => {
    expect(uuidv7(0).startsWith("00000000-0000-7")).toBe(true)
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const id = uuidv7(1_700_000_000_000)
      expect(id).toMatch(UUID7)
      seen.add(id)
    }
    expect(seen.size).toBe(500)
  })

  it("sorts by time", () => {
    expect(uuidv7(1_000) < uuidv7(2_000)).toBe(true)
    expect(uuidv7(0xfffffffffff) < uuidv7(0xffffffffffff)).toBe(true)
  })

  it("refuses a timestamp outside 0 to 2^48-1", () => {
    for (const bad of [-1, 0xffffffffffff + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => uuidv7(bad), String(bad)).toThrow(RangeError)
    }
    expect(uuidv7(0xffffffffffff)).toMatch(UUID7)
  })
})

describe("P1 Opik configuration (P3-67)", () => {
  const confirmed = { OPIK_SELF_HOSTED_CONFIRMED: "true" }

  it("is disabled when unset, unconfirmed, or pointed at Comet", () => {
    expect(opikConfig({})).toEqual({ enabled: false, reason: "unset" })
    expect(opikConfig({ OPIK_BASE_URL: "" })).toEqual({ enabled: false, reason: "unset" })
    expect(opikConfig({ OPIK_BASE_URL: "   " })).toEqual({ enabled: false, reason: "unset" })
    expect(opikConfig({ OPIK_SELF_HOSTED_CONFIRMED: "true" })).toEqual({ enabled: false, reason: "unset" })
    expect(opikConfig({ OPIK_BASE_URL: "http://opik.internal/api" })).toEqual({ enabled: false, reason: "unconfirmed" })
    for (const v of ["false", "TRUE", "1", "yes", ""]) {
      expect(opikConfig({ OPIK_BASE_URL: "http://opik.internal/api", OPIK_SELF_HOSTED_CONFIRMED: v }), v).toEqual({ enabled: false, reason: "unconfirmed" })
    }
    expect(opikConfig({ OPIK_BASE_URL: "https://www.comet.com/opik/api", ...confirmed })).toEqual({ enabled: false, reason: "third_party_host" })
    expect(opikConfig({ OPIK_BASE_URL: "https://comet.com/x", ...confirmed })).toEqual({ enabled: false, reason: "third_party_host" })
  })

  it("refuses comet.com whatever the case, a trailing dot, a port or userinfo, and a malformed URL", () => {
    const comet = (url: string) => opikConfig({ OPIK_BASE_URL: url, ...confirmed })
    expect(comet("https://API.Comet.COM/x")).toEqual({ enabled: false, reason: "third_party_host" })
    expect(comet("https://comet.com./x")).toEqual({ enabled: false, reason: "third_party_host" })
    expect(comet("https://comet.com:8443/x")).toEqual({ enabled: false, reason: "third_party_host" })
    expect(comet("https://user:pw@comet.com/x")).toEqual({ enabled: false, reason: "third_party_host" })
    expect(comet("not a url")).toEqual({ enabled: false, reason: "unconfirmed" })
    expect(comet("ftp://opik.internal/api")).toEqual({ enabled: false, reason: "unconfirmed" })
  })

  it("enables a confirmed self-hosted URL with the default or named project", () => {
    expect(opikConfig({ OPIK_BASE_URL: "https://notcomet.com/api", ...confirmed })).toEqual({ enabled: true, baseUrl: "https://notcomet.com/api", project: "sikander-p1" })
    expect(opikConfig({ OPIK_BASE_URL: "https://comet.com.example.org/api", ...confirmed })).toMatchObject({ enabled: true })
    expect(opikConfig({ OPIK_BASE_URL: " http://opik.internal:5173/api/// ", OPIK_PROJECT_NAME: " my-p1 ", ...confirmed })).toEqual({
      enabled: true,
      baseUrl: "http://opik.internal:5173/api",
      project: "my-p1",
    })
    expect(opikConfig({ OPIK_BASE_URL: "http://opik.internal/api", OPIK_PROJECT_NAME: "  ", ...confirmed })).toMatchObject({ project: "sikander-p1" })
  })

  it("reads process.env when no environment is passed", () => {
    const keys = ["OPIK_BASE_URL", "OPIK_SELF_HOSTED_CONFIRMED", "OPIK_PROJECT_NAME"] as const
    const saved = keys.map((k) => process.env[k])
    try {
      for (const k of keys) delete process.env[k]
      expect(opikConfig()).toEqual({ enabled: false, reason: "unset" })
      process.env.OPIK_BASE_URL = "http://opik.internal/api"
      process.env.OPIK_SELF_HOSTED_CONFIRMED = "true"
      expect(opikConfig()).toEqual({ enabled: true, baseUrl: "http://opik.internal/api", project: "sikander-p1" })
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])))
    }
  })
})

describe("P1 Opik trace payload (P3-67)", () => {
  const T0 = Date.parse("2026-10-11T10:00:00.000Z")
  const record = (over: Partial<TraceRecord> = {}): TraceRecord => ({
    traceId: "0199c3a0-0000-7000-8000-000000000001",
    startMs: T0,
    endMs: T0 + 1500,
    taskType: "committee",
    classification: "confidential",
    outcome: "ok",
    blockReason: null,
    model: OPUS,
    provider: "ai-gateway",
    inputTokens: 120,
    outputTokens: 40,
    costMicroUsd: 1280,
    firmId: "firm-1",
    matterId: "matter-1",
    usageLogId: "usage-1",
    maskedBody: "MASKED BODY",
    maskedResponse: "MASKED RESPONSE",
    ...over,
  })

  it("carries masked input and output at rank 2, with the full metadata", () => {
    const t = buildTrace(record(), "sikander-p1")
    expect(t).toEqual({
      id: "0199c3a0-0000-7000-8000-000000000001",
      project_name: "sikander-p1",
      name: "p1.committee",
      start_time: "2026-10-11T10:00:00.000Z",
      end_time: "2026-10-11T10:00:01.500Z",
      input: { prompt: "MASKED BODY" },
      output: { text: "MASKED RESPONSE" },
      metadata: {
        classification: "confidential",
        taskType: "committee",
        model: OPUS,
        provider: "ai-gateway",
        outcome: "ok",
        blockReason: null,
        inputTokens: 120,
        outputTokens: 40,
        costMicroUsd: 1280,
        firmId: "firm-1",
        matterId: "matter-1",
        usageLogId: "usage-1",
      },
      tags: ["confidential", "ok"],
    })
  })

  it("carries content at ranks 0 to 3 and metadata only at rank 4", () => {
    for (const c of ["public", "internal", "confidential", "privileged"] as const) {
      const t = buildTrace(record({ classification: c }), "p")
      expect(t.input, c).toEqual({ prompt: "MASKED BODY" })
      expect(t.output, c).toEqual({ text: "MASKED RESPONSE" })
    }
    const t = buildTrace(record({ classification: "privileged-restricted" }), "p")
    expect("input" in t).toBe(false)
    expect("output" in t).toBe(false)
    expect((t.metadata as { classification: string }).classification).toBe("privileged-restricted")
    expect(t.tags).toEqual(["privileged-restricted", "ok"])
  })

  it("carries no content for a blocked call, at any rank, and records the reason", () => {
    for (const c of ["public", "confidential", "privileged", "privileged-restricted"] as const) {
      const t = buildTrace(record({ classification: c, outcome: "blocked", blockReason: "policy_denied", maskedResponse: null, costMicroUsd: 0 }), "p")
      expect("input" in t, c).toBe(false)
      expect("output" in t, c).toBe(false)
      expect(t.metadata).toMatchObject({ classification: c, outcome: "blocked", blockReason: "policy_denied", costMicroUsd: 0 })
      expect("error_info" in t).toBe(false)
    }
  })

  it("leaves out a side whose masked value is null", () => {
    const t = buildTrace(record({ maskedResponse: null }), "p")
    expect(t.input).toEqual({ prompt: "MASKED BODY" })
    expect("output" in t).toBe(false)
    const u = buildTrace(record({ maskedBody: null }), "p")
    expect("input" in u).toBe(false)
    expect(u.output).toEqual({ text: "MASKED RESPONSE" })
  })

  it("keeps the content when it is an empty string (empty is not null)", () => {
    const t = buildTrace(record({ maskedBody: "", maskedResponse: "" }), "p")
    expect(t.input).toEqual({ prompt: "" })
    expect(t.output).toEqual({ text: "" })
  })

  it("marks a failed call with the transport error and no output", () => {
    const t = buildTrace(record({ outcome: "failed", blockReason: TRANSPORT_ERROR, maskedResponse: null, costMicroUsd: 0 }), "p")
    expect(t.error_info).toEqual({ exception_type: "transport_error", traceback: "" })
    expect(t.input).toEqual({ prompt: "MASKED BODY" })
    expect("output" in t).toBe(false)
    expect(t.tags).toEqual(["confidential", "failed"])
    expect("error_info" in buildTrace(record(), "p")).toBe(false)
  })

  it("uses the project and ISO times it is given, and fails closed on an unknown classification", () => {
    expect(buildTrace(record(), "other").project_name).toBe("other")
    expect(() => buildTrace(record({ classification: "constructor" as never }), "p")).toThrow()
  })
})
