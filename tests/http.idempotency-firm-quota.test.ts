// Re-audit N-1: the shared idempotency store is process-wide, so one firm flooding it evicted
// every other firm's entries, and their retries re-ran instead of replaying. Each firm is now
// capped at a quarter of the global entry and byte bounds; a firm at its cap evicts its own
// oldest entries first, so it cannot push another firm's entries out.
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
  it("firm A flooding the store by entry count leaves firm B's replay intact", () => {
    const s = new IdempotencyStore(limits)
    done(s, "firmB", "B|k1", "B1", 0)
    for (let i = 0; i < 50; i++) done(s, "firmA", `A|k${i}`, i, 1 + i)
    expect(s.begin("B|k1", "fp", 100, "firmB")).toEqual({ kind: "replay", body: "B1" })
    // A kept only its newest two; its oldest were evicted first.
    expect(s.begin("A|k49", "fp", 101, "firmA")).toEqual({ kind: "replay", body: 49 })
    expect(s.begin("A|k48", "fp", 101, "firmA")).toEqual({ kind: "replay", body: 48 })
    expect(s.begin("A|k0", "fp", 102, "firmA").kind).toBe("claimed")
    expect(s.size).toBeLessThanOrEqual(limits.firmMaxEntries * 2 + 1)
  })

  it("firm A flooding the store by bytes leaves firm B's replay intact", () => {
    const s = new IdempotencyStore({ ...limits, firmMaxEntries: 100 })
    done(s, "firmB", "B|big", "b".repeat(400), 0) // ~804 bytes
    for (let i = 0; i < 30; i++) done(s, "firmA", `A|${i}`, "a".repeat(400), 1 + i)
    expect(s.begin("B|big", "fp", 100, "firmB")).toEqual({ kind: "replay", body: "b".repeat(400) })
    expect(s.storedBytes).toBeLessThanOrEqual(2_000 + 804)
  })

  it("a firm's live in-progress claims are never evicted to make room for its own new ones", () => {
    const s = new IdempotencyStore(limits)
    expect(s.begin("A|1", "fp", 0, "firmA").kind).toBe("claimed")
    expect(s.begin("A|2", "fp", 0, "firmA").kind).toBe("claimed")
    expect(s.begin("A|3", "fp", 1, "firmA").kind).toBe("claimed")
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

  it("firm A filling its whole quota and more does not evict firm B's completed key", async () => {
    await runWithIdempotencyScope({ firmId: "firmB", userId: "ub" }, async () => {
      beginIdempotentRequest(req(), uuid(0), "fp").claim!.complete({ firm: "B" })
    })
    await runWithIdempotencyScope({ firmId: "firmA", userId: "ua" }, async () => {
      for (let i = 1; i <= IDEMPOTENCY_FIRM_MAX_ENTRIES + 500; i++) {
        beginIdempotentRequest(req(), uuid(i), "fp").claim!.complete({ i })
      }
    })
    expect(idempotencyStoreForTests().size).toBeLessThanOrEqual(IDEMPOTENCY_FIRM_MAX_ENTRIES + 1)
    await runWithIdempotencyScope({ firmId: "firmB", userId: "ub" }, async () => {
      const replay = beginIdempotentRequest(req(), uuid(0), "fp").response!
      expect(await replay.json()).toEqual({ result: { firm: "B" }, idempotencyKey: uuid(0), reused: true })
    })
  })
})
