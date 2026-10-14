/**
 * Re-audit R1-D2 (LOW): a PUT that got no response (timeout, connection reset) can land after
 * the first settling read. Before, the upload then failed with no document row and left a
 * ciphertext object behind. Now the settling read is retried with bounded back-off for about
 * twice the PUT timeout: this write's exact envelope settles as this write (the upload
 * succeeds); another writer's bytes are DocumentObjectExistsError; nothing at all fails as before
 * and logs `document object possible orphan` with the key at ERROR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createR2DocumentObjectBackend,
  DocumentObjectExistsError,
  resetDocumentObjectStoreForTests,
  setDocumentObjectBackendForTests,
  type R2DocumentObjectBackendConfig,
} from "@/platform/documents/documentObjectStore"
import { newStore } from "@/platform/spine/store"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { createFakeS3, s3ErrorResponse, type FakeS3, type RecordedS3Request } from "@/tests/helpers/fakeS3"

const KEY = "firmA/documents/doc_late/v1.enc"
let fake: FakeS3

beforeEach(() => {
  fake = createFakeS3()
})

afterEach(() => {
  vi.restoreAllMocks()
  setDocumentObjectBackendForTests(null)
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
    settleInitialDelayMs: 5,
    settleWindowMs: 400,
    ...overrides,
  })
}

/**
 * The PUT gets no response; its body reaches the bucket only when `landAfterGets` settling
 * reads have been answered (Infinity: never). `bodyOverride` lands another writer's bytes.
 */
function ambiguousPut(landAfterGets: number, bodyOverride?: Buffer) {
  let pending: RecordedS3Request | undefined
  let gets = 0
  fake.intercept((req) => {
    if (req.method === "PUT") {
      pending = req
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })
    }
    if (req.method === "GET") {
      if (pending && gets >= landAfterGets) {
        fake.objects.set(decodeURIComponent(pending.path), bodyOverride ?? pending.body)
        pending = undefined
      }
      gets += 1
    }
    return undefined
  })
}

describe("R1-D2: settling an ambiguous PUT retries the read", () => {
  it("a PUT that lands after the first settling read settles as this write on a retry", async () => {
    ambiguousPut(1)
    await expect(backend().putIfAbsent(KEY, Buffer.from("this write"))).resolves.toBeUndefined()
    expect(fake.requests.map((r) => r.method)).toEqual(["PUT", "GET", "GET"])
    expect(fake.objects.get(`/sikander-vault/${KEY}`)?.toString()).toBe("this write")
  })

  it("another writer's bytes appearing on a retry are refused as an existing object", async () => {
    ambiguousPut(2, Buffer.from("another writer"))
    const err = await backend().putIfAbsent(KEY, Buffer.from("this write")).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DocumentObjectExistsError)
    expect(fake.requests.map((r) => r.method)).toEqual(["PUT", "GET", "GET", "GET"])
  })

  it("a settling read that fails transiently is retried as well", async () => {
    ambiguousPut(1)
    let failedOnce = false
    fake.intercept((req) => {
      if (req.method === "GET" && !failedOnce) {
        failedOnce = true
        return s3ErrorResponse(503, "SlowDown")
      }
      return undefined
    })
    await expect(backend().putIfAbsent(KEY, Buffer.from("this write"))).resolves.toBeUndefined()
  })

  it("a PUT that never lands fails with the transport error after the window and logs a possible orphan", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    ambiguousPut(Number.POSITIVE_INFINITY)
    const started = Date.now()
    const err = (await backend({ settleWindowMs: 120 })
      .putIfAbsent(KEY, Buffer.from("lost"))
      .catch((e: unknown) => e)) as Error
    expect(Date.now() - started).toBeGreaterThanOrEqual(110)
    expect(err.message).toBe(`R2 PUT ${KEY} failed: no response (ECONNRESET)`)
    const gets = fake.requests.filter((r) => r.method === "GET").length
    expect(gets).toBeGreaterThanOrEqual(2)
    expect(gets).toBeLessThan(40)
    expect(errorSpy).toHaveBeenCalledWith(`[documents] document object possible orphan: ${KEY}`)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("by default the window is twice the request timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    ambiguousPut(Number.POSITIVE_INFINITY)
    const started = Date.now()
    await backend({ timeoutMs: 100, settleWindowMs: undefined, settleInitialDelayMs: undefined })
      .putIfAbsent(KEY, Buffer.from("lost"))
      .catch(() => undefined)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(190)
    expect(elapsed).toBeLessThan(5000)
    // The first pause defaults to 250 ms, longer than this 200 ms window: one read, one pause
    // cut to the window, one last read.
    const gets = fake.requests.filter((r) => r.method === "GET").length
    expect(gets).toBeGreaterThanOrEqual(2)
    expect(gets).toBeLessThanOrEqual(3)
  })

  it("the back-off grows between settling reads and stops at the window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const stamps: number[] = []
    ambiguousPut(Number.POSITIVE_INFINITY)
    fake.intercept((req) => {
      if (req.method === "GET") stamps.push(Date.now())
      return undefined
    })
    await backend({ settleInitialDelayMs: 60, settleWindowMs: 600 })
      .putIfAbsent(KEY, Buffer.from("lost"))
      .catch(() => undefined)
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i])
    expect(gaps.length).toBeGreaterThanOrEqual(2)
    expect(gaps[0]).toBeGreaterThanOrEqual(55)
    expect(gaps[1]).toBeGreaterThanOrEqual(115)
    expect(stamps.at(-1)! - stamps[0]).toBeLessThan(2000)
  })
})

describe("R1-D2: the upload succeeds when the ambiguous PUT lands late", () => {
  it("uploadDocument creates the row and job, and no orphan is logged", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    ambiguousPut(1)
    setDocumentObjectBackendForTests(backend())
    const store = newStore()
    store.users.set("partner_a", {
      id: "partner_a",
      firmId: "firmA",
      role: "partner",
      clearanceLevel: "privileged-restricted",
      active: true,
    })
    const res = await uploadDocument(store, {
      firmId: "firmA",
      matterId: null,
      bytes: Buffer.from("%PDF-late landing%"),
      sourceChannel: "web",
      classification: "internal",
      idempotencyKey: "fad16r12-0000-4000-8000-000000000001",
      uploadedBy: "partner_a",
    })
    expect(res.reused).toBe(false)
    expect(store.documents.get(res.docId)?.storagePath).toBe(`r2://firmA/documents/${res.docId}/v1`)
    expect(store.jobs).toHaveLength(1)
    expect(fake.objects.size).toBe(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
