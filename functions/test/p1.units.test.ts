import { describe, expect, it } from "vitest"
import * as costTable from "../src/p1/costTable"
import { MAX_OUTPUT_TOKENS, MODEL_PRICES, PROVIDER_ID, REQUEST_OVERHEAD_TOKENS, TASK_MODEL, bodyTokenCeiling, costMicroUsd, estimateTokens, inputTokenCeiling, modelInputOverhead, priceMicroUsd } from "../src/p1/costTable"
import { CALL_WORST_CASE_MS, assertOperationTimeBudget, ledgerQueue } from "../src/p1/gateway"
import { COMMITTEE_HANDLER_OVERHEAD_MS, REQUEST_TIMEOUT_MARGIN_MS } from "../src/p1/ops"
import { FUNCTION_TIMEOUT_SECONDS } from "../src/health"
import { isMonthKey, monthKeyPkt } from "../src/p1/month"
import { buildTrace, opikConfig, type TraceRecord } from "../src/p1/opik"
import { TRANSPORT_ERROR } from "../src/p1/types"
import { uuidv7 } from "../src/p1/uuidv7"

const OPUS = "anthropic/claude-opus-5.5"

describe("P1 cost table (P3-62)", () => {
  it("routes the committee task to Opus at the pinned list price", () => {
    expect(TASK_MODEL.committee).toBe(OPUS)
    expect(MODEL_PRICES[OPUS]).toEqual({
      inputNanoUsdPerToken: 4000,
      outputNanoUsdPerToken: 20000,
      source: "Vercel AI Gateway public model list, GET https://ai-gateway.vercel.sh/v1/models",
      fetchedAt: "2026-10-11",
      // Audit F07, Copilot finding on PR #40: the input overhead reserved per request, and whether it is verified (G-1).
      inputOverheadTokens: 1024,
      inputOverheadVerified: false,
    })
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

  it("priceMicroUsd rounds a fractional micro-USD up, never down", () => {
    const odd = { inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1 }
    expect(priceMicroUsd(odd, 0, 0)).toBe(0)
    expect(priceMicroUsd(odd, 1, 0)).toBe(1)
    expect(priceMicroUsd(odd, 1000, 0)).toBe(1)
    expect(priceMicroUsd(odd, 1001, 0)).toBe(2)
    expect(priceMicroUsd(odd, 500, 501)).toBe(2) // 1001 nano-USD
    expect(priceMicroUsd({ inputNanoUsdPerToken: 4000, outputNanoUsdPerToken: 20000 }, 1000, 500)).toBe(14000)
    expect(priceMicroUsd({ inputNanoUsdPerToken: 3, outputNanoUsdPerToken: 7 }, 100, 100)).toBe(1) // 1000 nano-USD exactly
    expect(priceMicroUsd({ inputNanoUsdPerToken: 3, outputNanoUsdPerToken: 7 }, 101, 100)).toBe(2) // 1003 nano-USD
  })

  it("costMicroUsd prices through priceMicroUsd", () => {
    expect(costMicroUsd(OPUS, 123, 456)).toBe(priceMicroUsd(MODEL_PRICES[OPUS]!, 123, 456))
  })

  it("the price and routing tables are frozen, so nothing can change a price at run time", () => {
    expect(Object.isFrozen(MODEL_PRICES)).toBe(true)
    expect(Object.isFrozen(MODEL_PRICES[OPUS])).toBe(true)
    expect(Object.values(MODEL_PRICES).every((row) => Object.isFrozen(row))).toBe(true)
    expect(Object.isFrozen(TASK_MODEL)).toBe(true)
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

  it("the reservation's input ceiling is the largest UTF-8 length of the body and its four normal forms, plus the request overhead (re-audit R2-D3)", () => {
    expect(bodyTokenCeiling("")).toBe(0)
    expect(bodyTokenCeiling("abc")).toBe(3)
    // U+FDFA is 3 bytes as written; NFKC and NFKD expand it to the 33-byte phrase it stands for.
    expect(Buffer.byteLength("ﷺ", "utf8")).toBe(3)
    expect(bodyTokenCeiling("ﷺ")).toBe(33)
    // A precomposed letter whose decomposition is longer: NFD of "é" is 3 bytes against 2.
    expect(bodyTokenCeiling("é")).toBe(3)
    expect(inputTokenCeiling("ﷺ")).toBe(33 + REQUEST_OVERHEAD_TOKENS)
  })

  it("every priced model carries its input overhead, and a model without one is not dispatched (Copilot finding, fail closed)", () => {
    expect(modelInputOverhead(OPUS)).toBe(1024)
    for (const unknown of ["x/unknown", "", "constructor", "__proto__", "toString"]) expect([unknown, modelInputOverhead(unknown)]).toEqual([unknown, null])
    // Every routed model is priced and has an overhead: a task can never route to a model it cannot reserve for.
    for (const model of Object.values(TASK_MODEL)) expect([model, modelInputOverhead(model) !== null, costMicroUsd(model, 0, 0) !== null]).toEqual([model, true, true])
  })

  it("a learned overhead counts only up to LEARNED_OVERHEAD_MAX_FACTOR times the model's own overhead (re-audit R3-D1)", () => {
    const t = costTable as unknown as {
      LEARNED_OVERHEAD_MAX_FACTOR?: number
      learnedOverheadCap?: (model: string) => number | null
      reservationOverheadTokens?: (model: string, learned: unknown) => number | null
    }
    expect([t.LEARNED_OVERHEAD_MAX_FACTOR, t.learnedOverheadCap?.(OPUS)]).toEqual([4, 4096])
    const reserve = (learned: unknown) => t.reservationOverheadTokens?.(OPUS, learned)
    // Nothing learned, or less than the table's figure: the table's 1,024.
    expect([reserve(0), reserve(500)]).toEqual([1024, 1024])
    // Between the table's figure and the clamp: exactly what was learned.
    expect([reserve(2_000), reserve(4_096)]).toEqual([2_000, 4_096])
    // Beyond the clamp, however far: the clamp, with no overflow.
    expect([reserve(4_097), reserve(24_999_972), reserve(Number.MAX_SAFE_INTEGER)]).toEqual([4_096, 4_096, 4_096])
    // Anything that is not a non-negative safe integer counts as nothing learned.
    expect([reserve(Number.NaN), reserve(-5), reserve(Number.POSITIVE_INFINITY), reserve(2.5), reserve("4000")]).toEqual([1024, 1024, 1024, 1024, 1024])
    // A model the cost table does not know has no overhead and no clamp: it is never dispatched.
    expect([t.learnedOverheadCap?.("x/unknown"), t.reservationOverheadTokens?.("x/unknown", 2_000)]).toEqual([null, null])
  })
})

describe("P1 request time budget (Codex P1 on PR #40: the whole committeeBrain request fits the function timeout)", () => {
  it("the call's phases, the handler's own work and a margin fit the api function's timeout", () => {
    expect(CALL_WORST_CASE_MS + COMMITTEE_HANDLER_OVERHEAD_MS + REQUEST_TIMEOUT_MARGIN_MS).toBeLessThanOrEqual(FUNCTION_TIMEOUT_SECONDS * 1000)
    expect(() => assertOperationTimeBudget({ callMs: CALL_WORST_CASE_MS, handlerMs: COMMITTEE_HANDLER_OVERHEAD_MS, marginMs: REQUEST_TIMEOUT_MARGIN_MS, timeoutMs: FUNCTION_TIMEOUT_SECONDS * 1000 })).not.toThrow()
  })

  it("the import-time check refuses shares that exceed the function timeout", () => {
    // The round-1 shares: 116 s of call phases left 4 s for everything else in a 120 s request.
    expect(() => assertOperationTimeBudget({ callMs: 116_000, handlerMs: COMMITTEE_HANDLER_OVERHEAD_MS, marginMs: REQUEST_TIMEOUT_MARGIN_MS, timeoutMs: 120_000 })).toThrow(/must fit in the function timeout/)
    expect(() => assertOperationTimeBudget({ callMs: 100_000, handlerMs: 16_000, marginMs: 5_000, timeoutMs: 120_000 })).toThrow(/must fit in the function timeout/)
    expect(() => assertOperationTimeBudget({ callMs: 99_000, handlerMs: 16_000, marginMs: 5_000, timeoutMs: 120_000 })).not.toThrow()
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

  it("monthKeyPkt refuses a time it cannot place in a month", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8.64e15, -8.64e15 - 5 * 3_600_000 - 1, undefined as never]) {
      expect(() => monthKeyPkt(bad), String(bad)).toThrow(RangeError)
    }
    expect(monthKeyPkt(0)).toBe("1970-01")
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

  it("refuses comet.com whatever the case, a trailing dot or a port", () => {
    const comet = (url: string) => opikConfig({ OPIK_BASE_URL: url, ...confirmed })
    expect(comet("https://API.Comet.COM/x")).toEqual({ enabled: false, reason: "third_party_host" })
    expect(comet("https://comet.com./x")).toEqual({ enabled: false, reason: "third_party_host" })
    expect(comet("https://comet.com:8443/x")).toEqual({ enabled: false, reason: "third_party_host" })
  })

  it("reports an unparseable, non-http(s) or query/fragment-bearing URL as invalid_url", () => {
    const invalid = { enabled: false, reason: "invalid_url" }
    for (const url of [
      "not a url",
      "ftp://opik.internal/api",
      "file:///etc/passwd",
      "opik.internal/api",
      "https://h/api?x=1",
      "https://h/api#f",
      "https://h/api?",
      "https://h/api#",
      "https://h/api?x=1#f",
      // fetch refuses a URL with credentials, so export could never succeed: fail it at config time.
      "https://user:pw@host/api",
      "https://user@host/api",
      "https://:pw@host/api",
      "http://user:pw@127.0.0.1:5173/api",
      "https://user:pw@comet.com/x",
    ]) {
      expect(opikConfig({ OPIK_BASE_URL: url, ...confirmed }), url).toEqual(invalid)
    }
  })

  it("checks unset, then invalid_url, then unconfirmed, then third_party_host", () => {
    // An invalid URL is reported as invalid even when it is also unconfirmed.
    expect(opikConfig({ OPIK_BASE_URL: "https://h/api?x=1" })).toEqual({ enabled: false, reason: "invalid_url" })
    expect(opikConfig({ OPIK_BASE_URL: "ftp://h/api", OPIK_SELF_HOSTED_CONFIRMED: "false" })).toEqual({ enabled: false, reason: "invalid_url" })
    expect(opikConfig({ OPIK_BASE_URL: "https://comet.com/x?y=1", ...confirmed })).toEqual({ enabled: false, reason: "invalid_url" })
    // A valid but unconfirmed URL is unconfirmed even when its host is Comet.
    expect(opikConfig({ OPIK_BASE_URL: "https://comet.com/x" })).toEqual({ enabled: false, reason: "unconfirmed" })
    expect(opikConfig({ OPIK_BASE_URL: "https://comet.com/x", OPIK_SELF_HOSTED_CONFIRMED: "yes" })).toEqual({ enabled: false, reason: "unconfirmed" })
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

  it("allows a plain-http base only for loopback, a private IPv4 literal, or a host ending in .internal or .local", () => {
    for (const url of [
      "http://localhost:5173/api",
      "http://LOCALHOST/api",
      "http://127.0.0.1:5173/api",
      "http://127.255.0.9/api",
      "http://[::1]:5173/api",
      "http://10.0.0.5/api",
      "http://10.255.255.255/api",
      "http://172.16.0.1/api",
      "http://172.31.255.254/api",
      "http://192.168.1.20:8080/api",
      "http://opik.internal/api",
      "http://opik.svc.internal./api",
      "http://opik.local/api",
      "http://Opik.LAN.local:5173/api",
    ]) {
      expect(opikConfig({ OPIK_BASE_URL: url, ...confirmed }), url).toMatchObject({ enabled: true })
    }
  })

  it("refuses a plain-http base on any other host as invalid_url, before the confirmation is read; https is unaffected", () => {
    const invalid = { enabled: false, reason: "invalid_url" }
    for (const url of [
      "http://opik.example.com/api",
      "http://opik.internal.test/api",
      "http://opik.local.example.com/api",
      "http://internal/api",
      "http://localhost.example.com/api",
      "http://172.15.255.255/api",
      "http://172.32.0.1/api",
      "http://192.169.0.1/api",
      "http://11.0.0.1/api",
      "http://8.8.8.8/api",
      "http://[2001:db8::1]/api",
      "http://comet.com/x",
    ]) {
      expect(opikConfig({ OPIK_BASE_URL: url, ...confirmed }), url).toEqual(invalid)
    }
    expect(opikConfig({ OPIK_BASE_URL: "http://opik.example.com/api" })).toEqual(invalid)
    expect(opikConfig({ OPIK_BASE_URL: "https://opik.example.com/api", ...confirmed })).toEqual({ enabled: true, baseUrl: "https://opik.example.com/api", project: "sikander-p1" })
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

// Audit F34 (spec ruling R10) changed P3-67's content rule: masked text rides only at ranks 0 and 1 (it was 0 to 3), and
// the metadata carries the decision record's version. The default record below is therefore `internal` (it was
// `confidential`), and the rank tests say 0 to 1.
describe("P1 Opik trace payload (P3-67, audit F34 R10)", () => {
  const T0 = Date.parse("2026-10-11T10:00:00.000Z")
  const record = (over: Partial<TraceRecord> = {}): TraceRecord => ({
    traceId: "0199c3a0-0000-7000-8000-000000000001",
    startMs: T0,
    endMs: T0 + 1500,
    taskType: "committee",
    classification: "internal",
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

  it("carries masked input and output at rank 1, with the full metadata", () => {
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
        classification: "internal",
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
        // The decision record's format version: f34.2 since the F34 re-audit R1 follow-up (spec section 5).
        decisionRecordVersion: "f34.3",
      },
      tags: ["internal", "ok"],
    })
  })

  it("carries content at ranks 0 and 1 and metadata only at ranks 2 to 4", () => {
    for (const c of ["public", "internal"] as const) {
      const t = buildTrace(record({ classification: c }), "p")
      expect(t.input, c).toEqual({ prompt: "MASKED BODY" })
      expect(t.output, c).toEqual({ text: "MASKED RESPONSE" })
    }
    for (const c of ["confidential", "privileged", "privileged-restricted"] as const) {
      const t = buildTrace(record({ classification: c }), "p")
      expect("input" in t, c).toBe(false)
      expect("output" in t, c).toBe(false)
      expect((t.metadata as { classification: string }).classification, c).toBe(c)
      expect(t.tags, c).toEqual([c, "ok"])
    }
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
    expect(t.tags).toEqual(["internal", "failed"])
    expect("error_info" in buildTrace(record(), "p")).toBe(false)
  })

  it("uses the project and ISO times it is given, and fails closed on an unknown classification", () => {
    expect(buildTrace(record(), "other").project_name).toBe("other")
    expect(() => buildTrace(record({ classification: "constructor" as never }), "p")).toThrow()
  })
})

describe("P1 ledger queue (audit F07: contention control that never costs liveness)", () => {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const waitError = () => Object.assign(new Error("waited too long"), { code: "test_deadline" })
  let n = 0
  const key = () => `firm-queue-${++n}`

  it("runs one firm's operations one at a time, in arrival order, whether they succeed or fail", async () => {
    const k = key()
    const log: string[] = []
    const op = (name: string, ms: number, fail = false) => async () => {
      log.push(`${name} start`)
      await sleep(ms)
      log.push(`${name} end`)
      if (fail) throw new Error(name)
      return name
    }
    const results = await Promise.allSettled([
      ledgerQueue(k, 5_000, 5_000, waitError, op("a", 30, true)),
      ledgerQueue(k, 5_000, 5_000, waitError, op("b", 10)),
      ledgerQueue(k, 5_000, 5_000, waitError, op("c", 1)),
    ])
    expect(log).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"])
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"])
  })

  it("an operation that holds the queue past the hold time lets the next one run beside it", async () => {
    const k = key()
    let finishHung!: () => void
    const hung = ledgerQueue(k, 5_000, 50, waitError, () => new Promise<string>((resolve) => (finishHung = () => resolve("hung"))))
    const started = Date.now()
    const next = await ledgerQueue(k, 5_000, 50, waitError, async () => "next")
    expect(next).toBe("next")
    expect(Date.now() - started).toBeLessThan(2_000)
    finishHung()
    expect(await hung).toBe("hung")
  })

  it("a waiter whose wait runs out is refused with its own error and its operation never runs; the queue then moves on", async () => {
    const k = key()
    let finishFirst!: () => void
    const first = ledgerQueue(k, 5_000, 60_000, waitError, () => new Promise<string>((resolve) => (finishFirst = () => resolve("first"))))
    let ran = false
    await expect(
      ledgerQueue(k, 30, 60_000, waitError, async () => {
        ran = true
        return "late"
      })
    ).rejects.toMatchObject({ code: "test_deadline" })
    const third = ledgerQueue(k, 5_000, 60_000, waitError, async () => "third")
    finishFirst()
    expect(await first).toBe("first")
    expect(await third).toBe("third")
    expect(ran).toBe(false)
  })

  it("different firms never wait for each other", async () => {
    const [a, b] = [key(), key()]
    let finishA!: () => void
    const held = ledgerQueue(a, 5_000, 60_000, waitError, () => new Promise<string>((resolve) => (finishA = () => resolve("a"))))
    expect(await ledgerQueue(b, 100, 60_000, waitError, async () => "b")).toBe("b")
    finishA()
    expect(await held).toBe("a")
  })
})
