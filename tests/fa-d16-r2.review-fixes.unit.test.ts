/**
 * Re-audit round 2 (delta re-audit of 1bce2bc):
 * - R2-D1: an S3 error code is server-controlled text. Only a code shaped like a real one
 *   (`/^[A-Z][A-Za-z]{2,63}$/` with at least one lower-case letter, e.g. PreconditionFailed) may
 *   reach an error message or a log line; anything else is dropped and the status stands alone.
 * - R2-D2: the settle hold has a declared budget. Each settling read gets
 *   min(request timeout, time left in the window); the window is measured on the monotonic clock
 *   (performance.now), so a wall-clock step cannot stretch it; the upload route's maxDuration
 *   covers the whole upload budget.
 * - R2-D3: with a frozen clock and a zero window the settle loop reads exactly once (kills the
 *   `remaining <= 0` -> `remaining < 0` mutant, which looped without end).
 */
import { randomBytes, randomUUID } from "node:crypto"
import { inspect } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { maxDuration, POST } from "@/app/api/d1/documents/route"
import {
  createR2DocumentObjectBackend,
  r2HoldBudget,
  resetDocumentObjectStoreForTests,
  setDocumentObjectBackendForTests,
  type R2DocumentObjectBackendConfig,
} from "@/platform/documents/documentObjectStore"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { createFakeS3, hangUntilAborted, type FakeS3, type RecordedS3Request } from "@/tests/helpers/fakeS3"

const KEY = "firmA/documents/doc_r2/v1.enc"
let fake: FakeS3

beforeEach(() => {
  fake = createFakeS3()
})

afterEach(() => {
  vi.restoreAllMocks()
  setDocumentObjectBackendForTests(null)
  resetRuntimeStoreForTests()
  resetDocumentObjectStoreForTests()
})

function backend(overrides: Partial<R2DocumentObjectBackendConfig> = {}) {
  return createR2DocumentObjectBackend({
    endpoint: "https://account-id.r2.example.test",
    bucket: "sikander-vault",
    accessKeyId: "FAKEACCESSKEYFAD16",
    secretAccessKey: "fake-secret-for-unit-tests-only",
    region: "auto",
    fetchImpl: fake.fetchImpl,
    ...overrides,
  })
}

/** The PUT gets no response; its body lands when `landAfterGets` settling reads were answered. */
function ambiguousPut(landAfterGets: number) {
  let pending: RecordedS3Request | undefined
  let gets = 0
  fake.intercept((req) => {
    if (req.method === "PUT") {
      pending = req
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })
    }
    if (req.method === "GET") {
      if (pending && gets >= landAfterGets) {
        fake.objects.set(decodeURIComponent(req.path), pending.body)
        pending = undefined
      }
      gets += 1
    }
    return undefined
  })
}

const getCount = () => fake.requests.filter((r) => r.method === "GET").length

describe("R2-D1: only a real-looking S3 error code reaches a message", () => {
  const AKID_SHAPED = `AKIDR2CANARY${randomBytes(6).toString("hex").toUpperCase()}`
  const SIGNATURE = randomBytes(32).toString("hex")
  // Built at run time (capitals only, 20 long like an access key id) so no key-shaped literal is
  // committed.
  const CAPITALS_ONLY = `AKIA${Array.from(randomBytes(16), (b) => String.fromCharCode(65 + (b % 26))).join("")}`

  it.each([
    ["an AKID-shaped value with digits", AKID_SHAPED],
    ["an access-key-shaped value of capitals only", CAPITALS_ONLY],
    ["a 64-hex signature", SIGNATURE],
    ["a dotted string", "Internal.Error"],
    ["a code with digits", "XAmzContentSHA256Mismatch"],
    ["a lower-case first letter", "noSuchKey"],
    ["two letters", "Ab"],
    ["65 letters", `A${"b".repeat(64)}`],
    ["a space", "No Such Key"],
    ["an empty code", ""],
  ])("drops a <Code> holding %s: the message carries the status only", async (_label, code) => {
    fake.intercept(() => new Response(`<Error><Code>${code}</Code><Message>x</Message></Error>`, { status: 403 }))
    const err = (await backend().get(KEY).catch((e: unknown) => e)) as Error
    expect(err.message).toBe(`R2 GET ${KEY} failed: HTTP 403`)
    if (code) expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(code)
  })

  // "ABcdef" / "XAmzSomething": more than one leading capital before the first lower-case letter.
  it.each(["PreconditionFailed", "NoSuchKey", "AccessDenied", "SlowDown", "InternalError", "SignatureDoesNotMatch", "Abc", `A${"b".repeat(63)}`, "ABcdef", "XAmzSomething"])(
    "keeps the real-looking code %s",
    async (code) => {
      fake.intercept(() => new Response(`<Error><Code>${code}</Code></Error>`, { status: 500 }))
      const err = (await backend().get(KEY).catch((e: unknown) => e)) as Error
      expect(err.message).toBe(`R2 GET ${KEY} failed: HTTP 500 ${code}`)
    }
  )

  it("a hostile endpoint's code never reaches the upload route's log", async () => {
    const lines: string[] = []
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(inspect(args, { depth: 10, showHidden: true }))
    })
    fake.intercept(() => new Response(`<Error><Code>${AKID_SHAPED}</Code></Error>`, { status: 403 }))
    setDocumentObjectBackendForTests(backend())
    const res = await POST(
      new Request("http://127.0.0.1/api/d1/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          action: "ingest",
          actorId: "partner_a",
          firmId: "firmA",
          contentBase64: Buffer.from("%PDF-hostile code%").toString("base64"),
          sourceChannel: "web",
          classification: "internal",
        }),
      })
    )
    const body = await res.text()
    expect(res.status).toBe(400)
    const logged = lines.join("\n")
    expect(logged).toContain("failed: HTTP 403")
    expect(logged + body).not.toContain(AKID_SHAPED)
  })
})

describe("R2-D2: the settle hold has a declared budget", () => {
  it("declares the budget: PUT timeout + settle window, then one verify read and one delete", () => {
    expect(r2HoldBudget()).toEqual({
      requestMs: 30_000,
      settleWindowMs: 60_000,
      putIfAbsentMs: 90_000,
      objectPutMs: 150_000,
      uploadMs: 210_000,
    })
    expect(r2HoldBudget({ timeoutMs: 400, settleWindowMs: 800 })).toEqual({
      requestMs: 400,
      settleWindowMs: 800,
      putIfAbsentMs: 1_200,
      objectPutMs: 2_000,
      uploadMs: 2_800,
    })
    expect(r2HoldBudget({ timeoutMs: 100 }).settleWindowMs).toBe(200)
  })

  it("the upload route's maxDuration covers the whole upload budget", () => {
    expect(typeof maxDuration).toBe("number")
    expect(maxDuration * 1000).toBeGreaterThanOrEqual(r2HoldBudget().uploadMs)
  })

  it("against a hanging endpoint the hold stays within PUT timeout + settle window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const hanging = (_url: string, init: RequestInit) => hangUntilAborted(init)
    const config = { fetchImpl: hanging, timeoutMs: 400, settleWindowMs: 800, settleInitialDelayMs: 250 }
    const declared = config.timeoutMs + config.settleWindowMs // r2HoldBudget(config).putIfAbsentMs
    const started = performance.now()
    const err = (await backend(config).putIfAbsent(KEY, Buffer.from("p")).catch((e: unknown) => e)) as Error
    const held = performance.now() - started
    expect(err.message).toBe(`R2 PUT ${KEY} timed out after 400 ms`)
    // Each settling read gets only the time left in the window, so the last one cannot run a
    // full request timeout past it (it used to: about 1450 ms here).
    expect(held).toBeGreaterThanOrEqual(declared - 50)
    expect(held).toBeLessThanOrEqual(declared + 150)
  })

  it("a settling read that hangs late in the window gets only the time left, not a full timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    let gets = 0
    // The PUT and every read from the third one hang; the first two reads answer 404 at once.
    const lateHang = async (_url: string, init: RequestInit) => {
      if (init.method === "GET" && ++gets <= 2) return new Response("", { status: 404 })
      return hangUntilAborted(init)
    }
    const config = { fetchImpl: lateHang, timeoutMs: 400, settleWindowMs: 800, settleInitialDelayMs: 250 }
    const started = performance.now()
    await backend(config).putIfAbsent(KEY, Buffer.from("p")).catch(() => undefined)
    const held = performance.now() - started
    // PUT 400 ms; reads at ~400 and ~650 ms answer at once; the third starts with ~50 ms left.
    expect(gets).toBeGreaterThanOrEqual(3)
    expect(held).toBeLessThanOrEqual(config.timeoutMs + config.settleWindowMs + 150)
  })

  it("a settling read whose time ran out before it was sent ends at once instead of hanging", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    // A zero window: the one settling read gets a 0 ms timeout, which fires while the request is
    // still being signed and sent (simulated by the 20 ms pause), so fetch sees a fired signal.
    const slowThenHang = async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      return hangUntilAborted(init)
    }
    const outcome = await Promise.race([
      backend({ fetchImpl: slowThenHang, settleWindowMs: 0 })
        .putIfAbsent(KEY, Buffer.from("p"))
        .then(
          () => "resolved",
          (e: Error) => e.message
        ),
      new Promise((resolve) => setTimeout(() => resolve("still settling after 2 s"), 2_000)),
    ])
    expect(outcome).toBe(`R2 PUT ${KEY} failed: no response (ECONNRESET)`)
  })

  it("a wall-clock step does not stretch the settle window (it runs on the monotonic clock)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    ambiguousPut(Number.POSITIVE_INFINITY)
    const realNow = Date.now.bind(Date)
    let calls = 0
    // The wall clock jumps an hour back on every read of it.
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - 3_600_000 * calls++)
    const outcome = await Promise.race([
      backend({ settleWindowMs: 200, settleInitialDelayMs: 20 })
        .putIfAbsent(KEY, Buffer.from("lost"))
        .then(
          () => "resolved",
          () => "rejected"
        ),
      new Promise((resolve) => setTimeout(() => resolve("still settling after 3 s"), 3_000)),
    ])
    expect(outcome).toBe("rejected")
  })
})

describe("R2-D3: a frozen clock with a zero window reads exactly once", () => {
  it("one settling read, then the original failure and the orphan line", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(performance, "now").mockReturnValue(123_456)
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
    // A loop that kept reading would see the object land on its third read and resolve.
    ambiguousPut(2)
    const err = (await backend({ settleWindowMs: 0, settleInitialDelayMs: 5 })
      .putIfAbsent(KEY, Buffer.from("lost"))
      .catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe(`R2 PUT ${KEY} failed: no response (ECONNRESET)`)
    expect(getCount()).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(`[documents] document object possible orphan: ${KEY}`)
  })
})
