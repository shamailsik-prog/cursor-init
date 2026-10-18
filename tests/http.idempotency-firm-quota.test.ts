// Re-audit N-1: the shared idempotency store is process-wide, so one firm flooding it evicted
// every other firm's entries, and their retries re-ran instead of replaying. Each firm is now
// capped at a quarter of the global entry and byte bounds, so it cannot push another firm's
// entries out. Audit F10 (spec ruling 14): a firm at its cap no longer evicts its own completed
// entries either (that let their retries re-run): its new claims are refused, and an answer over
// its byte budget is kept without its body.
import { afterEach, describe, expect, it } from "vitest"
import {
  IDEMPOTENCY_FIRM_MAX_BYTES,
  IDEMPOTENCY_FIRM_MAX_ENTRIES,
  IDEMPOTENCY_MAX_BYTES,
  IDEMPOTENCY_MAX_ENTRIES,
  IdempotencyStore,
  beginIdempotentRequest,
  idempotencyStoreForTests,
  resetIdempotencyForTests,
  runWithIdempotencyScope,
} from "@/platform/http/idempotency"

const limits = {
  ttlMs: 60_000,
  maxEntries: 8,
  maxBytes: 8_000,
  maxEntryBytes: 1_000,
  leaseMs: 50,
  firmMaxEntries: 2,
  firmMaxBytes: 2_000,
}

function done(s: IdempotencyStore, firm: string, key: string, body: unknown, now: number) {
  const begun = s.begin(key, "fp", now, firm)
  if (begun.kind !== "claimed") throw new Error(`expected a claim for ${key}, got ${begun.kind}`)
  s.complete(key, begun.claimId, body, now)
}

describe("IdempotencyStore per-firm quotas", () => {
  it("firm A flooding the store by entry count leaves firm B's replay intact, and A's own completed keys replay", () => {
    const s = new IdempotencyStore(limits)
    done(s, "firmB", "B|k1", "B1", 0)
    done(s, "firmA", "A|k0", 0, 1)
    done(s, "firmA", "A|k1", 1, 2)
    // A is at its quota: every further claim of A is refused, and nothing of A's or B's is evicted.
    for (let i = 2; i < 50; i++) expect(s.begin(`A|k${i}`, "fp", 2 + i, "firmA")).toEqual({ kind: "capacity" })
    expect(s.begin("B|k1", "fp", 100, "firmB")).toEqual({ kind: "replay", body: "B1" })
    expect(s.begin("A|k0", "fp", 101, "firmA")).toEqual({ kind: "replay", body: 0 })
    expect(s.begin("A|k1", "fp", 101, "firmA")).toEqual({ kind: "replay", body: 1 })
    expect(s.size).toBe(3)
    // B is unaffected by A's quota.
    expect(s.begin("B|k2", "fp", 102, "firmB").kind).toBe("claimed")
  })

  it("firm A flooding the store by bytes leaves firm B's replay intact; A's answers past its budget are kept without their body", () => {
    const s = new IdempotencyStore({ ...limits, firmMaxEntries: 100, maxEntries: 100 })
    done(s, "firmB", "B|big", "b".repeat(400), 0) // ~804 bytes
    for (let i = 0; i < 30; i++) done(s, "firmA", `A|${i}`, "a".repeat(400), 1 + i)
    expect(s.begin("B|big", "fp", 100, "firmB")).toEqual({ kind: "replay", body: "b".repeat(400) })
    expect(s.storedBytes).toBeLessThanOrEqual(2_000 + 804)
    // A's first two answers fit its 2,000-byte budget; the rest are kept, never re-run, without their body.
    expect(s.begin("A|0", "fp", 101, "firmA")).toEqual({ kind: "replay", body: "a".repeat(400) })
    expect(s.begin("A|29", "fp", 101, "firmA")).toEqual({ kind: "unavailable" })
  })

  it("a firm's live in-progress claims are never evicted to make room for its own new ones", () => {
    const s = new IdempotencyStore(limits)
    expect(s.begin("A|1", "fp", 0, "firmA").kind).toBe("claimed")
    expect(s.begin("A|2", "fp", 0, "firmA").kind).toBe("claimed")
    expect(s.begin("A|3", "fp", 1, "firmA")).toEqual({ kind: "capacity" })
    expect(s.begin("A|1", "fp", 2, "firmA")).toEqual({ kind: "in_progress" })
  })

  it("the shared store caps each firm at a quarter of the global entry and byte bounds", () => {
    expect(IDEMPOTENCY_FIRM_MAX_ENTRIES).toBe(IDEMPOTENCY_MAX_ENTRIES / 4)
    expect(IDEMPOTENCY_FIRM_MAX_BYTES).toBe(IDEMPOTENCY_MAX_BYTES / 4)
  })
})

describe("beginIdempotentRequest keys each firm's entries to its quota", () => {
  afterEach(() => resetIdempotencyForTests())
  const req = () => new Request("http://x/api/route", { method: "POST" })
  const uuid = (n: number) => `3b241101-e2bb-4255-8caf-${n.toString(16).padStart(12, "0")}`

  it("firm A filling its whole quota and more does not evict firm B's completed key, nor its own; its excess is refused 503", async () => {
    await runWithIdempotencyScope({ firmId: "firmB", userId: "ub" }, async () => {
      ;(await beginIdempotentRequest(req(), uuid(0), "fp")).claim!.complete({ firm: "B" })
    })
    const refused: number[] = []
    await runWithIdempotencyScope({ firmId: "firmA", userId: "ua" }, async () => {
      for (let i = 1; i <= IDEMPOTENCY_FIRM_MAX_ENTRIES + 500; i++) {
        const begun = await beginIdempotentRequest(req(), uuid(i), "fp")
        if (begun.claim) begun.claim.complete({ i })
        else {
          expect(begun.response.status).toBe(503)
          expect(((await begun.response.json()) as { code: string }).code).toBe("idempotency_capacity_exhausted")
          refused.push(i)
        }
      }
    })
    expect(refused).toHaveLength(500)
    expect(idempotencyStoreForTests().size).toBe(IDEMPOTENCY_FIRM_MAX_ENTRIES + 1)
    await runWithIdempotencyScope({ firmId: "firmB", userId: "ub" }, async () => {
      const replay = (await beginIdempotentRequest(req(), uuid(0), "fp")).response!
      expect(await replay.json()).toEqual({ result: { firm: "B" }, idempotencyKey: uuid(0), reused: true })
    })
    await runWithIdempotencyScope({ firmId: "firmA", userId: "ua" }, async () => {
      const replay = (await beginIdempotentRequest(req(), uuid(1), "fp")).response!
      expect(await replay.json()).toEqual({ result: { i: 1 }, idempotencyKey: uuid(1), reused: true })
    })
  })
})
