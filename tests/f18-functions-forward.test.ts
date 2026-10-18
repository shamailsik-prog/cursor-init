import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { installNetworkTripwire } from "@/tests/helpers/network-tripwire"

/**
 * Audit F18, spec rulings R1, R4, R7 and R8: the Next side's only client for committee work,
 * platform/p1/functionsCommitteeBrain.ts. It sends a committee request to the Cloud Functions P1 route
 * (`/api/platform/brain/committeeBrain`) with the caller's own credentials and the same Idempotency-Key, and nowhere else.
 *
 * The module is loaded dynamically, so on main this file runs and fails on its absence. No network: `fetch` is a fake
 * passed in, the `ai` SDK is a fake, and the shared tripwire refuses every non-loopback fetch and socket from the moment
 * this file loads (re-audit follow-up).
 */

vi.mock("ai", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    createGateway: () => ({ languageModel: (id: string) => ({ fakeModelId: id }) }),
    generateText: async () => ({ text: "Answer from the fake provider." }),
  }
})

const tripwire = installNetworkTripwire()

afterAll(() => {
  tripwire.uninstall()
  expect(tripwire.refused, "non-loopback requests attempted by this file").toEqual([])
})

type Forward = typeof import("@/platform/p1/functionsCommitteeBrain")

async function forward(): Promise<Forward> {
  const mod = (await import("@/platform/p1/functionsCommitteeBrain").catch(() => null)) as Forward | null
  expect(mod, "platform/p1/functionsCommitteeBrain.ts exists").not.toBeNull()
  return mod!
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("audit F18: the Functions P1 base URL (R8)", () => {
  it("is unset without configuration", async () => {
    const { functionsP1BaseUrl } = await forward()
    expect(functionsP1BaseUrl({})).toBeNull()
  })

  it("takes the server variable first, then the console's, without a trailing slash", async () => {
    const { functionsP1BaseUrl } = await forward()
    expect(functionsP1BaseUrl({ SIKANDER_FUNCTIONS_API_BASE_URL: "https://asia-south1-demo.cloudfunctions.net/api/" })).toBe("https://asia-south1-demo.cloudfunctions.net/api")
    expect(functionsP1BaseUrl({ NEXT_PUBLIC_SIKANDER_FUNCTIONS_API_BASE_URL: "https://fn.example.test" })).toBe("https://fn.example.test")
    expect(
      functionsP1BaseUrl({ SIKANDER_FUNCTIONS_API_BASE_URL: "https://server.example.test", NEXT_PUBLIC_SIKANDER_FUNCTIONS_API_BASE_URL: "https://console.example.test" })
    ).toBe("https://server.example.test")
  })

  it("accepts plain http only to a loopback host", async () => {
    const { functionsP1BaseUrl } = await forward()
    expect(functionsP1BaseUrl({ SIKANDER_FUNCTIONS_API_BASE_URL: "http://127.0.0.1:15001" })).toBe("http://127.0.0.1:15001")
    expect(functionsP1BaseUrl({ SIKANDER_FUNCTIONS_API_BASE_URL: "http://localhost:15001" })).toBe("http://localhost:15001")
    expect(functionsP1BaseUrl({ SIKANDER_FUNCTIONS_API_BASE_URL: "http://[::1]:15001" })).toBe("http://[::1]:15001")
    for (const url of ["http://10.0.0.5:15001", "http://fn.example.test", "http://127.0.0.1.example.test"]) {
      expect(functionsP1BaseUrl({ SIKANDER_FUNCTIONS_API_BASE_URL: url }), url).toBeNull()
    }
  })

  it("refuses credentials, a query, a fragment, another scheme and garbage", async () => {
    const { functionsP1BaseUrl } = await forward()
    for (const url of ["https://user:pw@fn.example.test", "https://fn.example.test/?a=1", "https://fn.example.test/#x", "ftp://fn.example.test", "not a url"]) {
      expect(functionsP1BaseUrl({ SIKANDER_FUNCTIONS_API_BASE_URL: url }), url).toBeNull()
    }
  })

  it("uses the Functions emulator host outside production only", async () => {
    const { functionsP1BaseUrl } = await forward()
    expect(functionsP1BaseUrl({ FIREBASE_FUNCTIONS_EMULATOR_HOST: "127.0.0.1:15001", GCLOUD_PROJECT: "demo-sikander" })).toBe(
      "http://127.0.0.1:15001/demo-sikander/asia-south1/api"
    )
    expect(functionsP1BaseUrl({ NODE_ENV: "production", FIREBASE_FUNCTIONS_EMULATOR_HOST: "127.0.0.1:15001" })).toBeNull()
  })
})

type Call = { url: string; init: RequestInit }

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} }
      calls.push(call)
      return respond(call)
    }) as typeof fetch,
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const REQUEST = {
  authorization: "Bearer emulator-id-token",
  firmId: "firm-1",
  idempotencyKey: "0b8a1e9c-4f2d-4a7b-9c1e-2d3f4a5b6c7d",
  payload: { matterId: "m-1", body: "Draft the reply.", purpose: "committee-brain", classification: "internal" as const, partyNames: ["Qalvo Nura"] },
}

const ANSWER = { outputId: "out-1", blocked: false, text: "ok", classification: "internal", usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 24 }, traceId: "t-1" }

describe("audit F18: forwardCommitteeBrain (R1, R4, R6, R7)", () => {
  it("posts to the committeeBrain route with the caller's token, firm and key, refusing redirects, with a timeout", async () => {
    const { forwardCommitteeBrain, FUNCTIONS_COMMITTEE_BRAIN_PATH } = await forward()
    const f = fakeFetch(() => json(200, ANSWER))
    const out = await forwardCommitteeBrain("https://fn.example.test/api", REQUEST, { fetch: f.fetch })
    expect(out).toEqual({ kind: "answer", body: ANSWER })
    expect(f.calls).toHaveLength(1)
    const [call] = f.calls
    expect(FUNCTIONS_COMMITTEE_BRAIN_PATH).toBe("/api/platform/brain/committeeBrain")
    expect(call!.url).toBe("https://fn.example.test/api/api/platform/brain/committeeBrain")
    expect(call!.init.method).toBe("POST")
    expect(call!.init.redirect).toBe("error")
    expect(call!.init.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(call!.init.headers)
    expect(headers.get("authorization")).toBe(REQUEST.authorization)
    expect(headers.get("x-firm-id")).toBe("firm-1")
    expect(headers.get("idempotency-key")).toBe(REQUEST.idempotencyKey)
    expect(headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(String(call!.init.body))).toEqual(REQUEST.payload)
  })

  it("relays a Functions refusal with its status, code and Retry-After", async () => {
    const { forwardCommitteeBrain } = await forward()
    const conflict = await forwardCommitteeBrain("https://fn.example.test", REQUEST, { fetch: fakeFetch(() => json(409, { error: { code: "idempotency_in_progress" } })).fetch })
    expect(conflict).toEqual({ kind: "refused", status: 409, code: "idempotency_in_progress" })
    const limited = await forwardCommitteeBrain("https://fn.example.test", REQUEST, { fetch: fakeFetch(() => json(429, { error: { code: "rate_limited" } }, { "retry-after": "30" })).fetch })
    expect(limited).toEqual({ kind: "refused", status: 429, code: "rate_limited", retryAfter: "30" })
    const opaque = await forwardCommitteeBrain("https://fn.example.test", REQUEST, { fetch: fakeFetch(() => new Response("upstream down", { status: 500 })).fetch })
    expect(opaque).toEqual({ kind: "refused", status: 500, code: "p1_functions_error" })
  })

  // Re-audit follow-up FA-F18-004, mutant M15: a refusal's code is relayed only when it is a short lower-case identifier,
  // so nothing Functions (or anything answering in its place) puts there reaches the caller as text.
  it("relays a refusal code only when it is a short lower-case identifier; anything else is p1_functions_error", async () => {
    const { forwardCommitteeBrain } = await forward()
    const refusedWith = async (code: unknown) =>
      forwardCommitteeBrain("https://fn.example.test", REQUEST, { fetch: fakeFetch(() => json(400, { error: { code } })).fetch })
    for (const unsafe of ["Bearer emulator-id-token", "<script>alert(1)</script>", "Rate_Limited", "9_lives", "rate-limited", "a".repeat(65), "", 42, null]) {
      expect(await refusedWith(unsafe), JSON.stringify(unsafe)).toEqual({ kind: "refused", status: 400, code: "p1_functions_error" })
    }
    expect(await refusedWith("a".repeat(64))).toEqual({ kind: "refused", status: 400, code: "a".repeat(64) })
    expect(await refusedWith("matter_required")).toEqual({ kind: "refused", status: 400, code: "matter_required" })
  })

  // Re-audit follow-up FA-F18-004, mutant M18: the forward-deadline seam is test-only.
  it("refuses to shorten the forward deadline in production", async () => {
    const { setForwardTimeoutForTests } = await forward()
    vi.stubEnv("NODE_ENV", "production")
    try {
      expect(() => setForwardTimeoutForTests(1)).toThrow("setForwardTimeoutForTests is test-only")
    } finally {
      vi.unstubAllEnvs()
      setForwardTimeoutForTests(null)
    }
  })

  it("fails closed with an alert line when Functions is unreachable, slow or answers something that is not a committee answer", async () => {
    const { forwardCommitteeBrain, FORWARD_ALERT } = await forward()
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const unreachable = await forwardCommitteeBrain("https://fn.example.test", REQUEST, {
      fetch: fakeFetch(() => {
        throw new TypeError("fetch failed")
      }).fetch,
    })
    expect(unreachable).toEqual({ kind: "failed", status: 503, code: "p1_functions_unavailable" })
    const slow = await forwardCommitteeBrain("https://fn.example.test", REQUEST, {
      fetch: fakeFetch(() => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" })
      }).fetch,
    })
    expect(slow).toEqual({ kind: "failed", status: 504, code: "p1_functions_timeout" })
    const odd = await forwardCommitteeBrain("https://fn.example.test", REQUEST, { fetch: fakeFetch(() => json(200, { ok: true })).fetch })
    expect(odd).toEqual({ kind: "failed", status: 502, code: "p1_functions_bad_answer" })
    const notJson = await forwardCommitteeBrain("https://fn.example.test", REQUEST, { fetch: fakeFetch(() => new Response("<html>", { status: 200 })).fetch })
    expect(notJson).toEqual({ kind: "failed", status: 502, code: "p1_functions_bad_answer" })
    const lines = spy.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    expect(lines.filter((l) => l.includes(`ALERT ${FORWARD_ALERT}`))).toHaveLength(4)
    expect(lines.join("\n")).not.toContain("emulator-id-token")
  })
})

/**
 * PR #88 review round 1 (Cursor Bugbot, thread 4307502869; spec R1, review-round note): the forward waits up to
 * FORWARD_TIMEOUT_MS for Cloud Functions, so the route's platform limit must sit above it. Otherwise the platform kills
 * the request first: no 504, no `p1.next_forward_failed` alert, and the Next Idempotency-Key left in progress. The value
 * must also fit the smallest Vercel plan: Hobby, 300 s maximum with Fluid compute (vercel.com/docs/functions/
 * configuring-functions/duration, read 2026-10-18). It must be a literal, because Next reads it statically.
 */
describe("audit F18 review round 1: the committee route's maxDuration covers the forward deadline", () => {
  it("exports a static maxDuration above FORWARD_TIMEOUT_MS and within the smallest plan's limit", async () => {
    const { FORWARD_TIMEOUT_MS } = await forward()
    const route = (await import("@/app/api/p1/committee-brain/route")) as { maxDuration?: unknown }
    expect(typeof route.maxDuration, "the route exports maxDuration").toBe("number")
    const seconds = route.maxDuration as number
    expect(seconds * 1000).toBeGreaterThan(FORWARD_TIMEOUT_MS)
    expect(seconds).toBeLessThanOrEqual(300)
    const source = (await import("node:fs")).readFileSync("app/api/p1/committee-brain/route.ts", "utf8")
    expect(source).toMatch(/^export const maxDuration = \d+$/m)
  })
})
