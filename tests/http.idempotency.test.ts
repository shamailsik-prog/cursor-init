// Final audit F4 + SEC-4: one shared Next idempotency store. The key is reserved before the
// first await (a concurrent duplicate is refused), scoped firm|user|route|key, fingerprinted
// with sha256, holds only the response, and is a bounded LRU with a 24 h TTL.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DOCS } from "@/app/api/d1/documents/route"
import { POST as MATTERS } from "@/app/api/d1/matters/route"
import { POST as NORMALISE } from "@/app/api/g0/normalise/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import {
  IdempotencyStore,
  idempotencyStoreForTests,
  resetIdempotencyForTests,
} from "@/platform/http/idempotency"

afterEach(() => {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
})

const req = (url: string, body: unknown, key: string) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  })

const matterBody = {
  action: "create",
  actorId: "partner_a",
  firmId: "firmA",
  clientId: "client_a",
  title: "dup",
  courtId: "SHC",
  classification: "internal",
}

function matterWithPartner() {
  const store = getRuntimeStore()
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
  addMember(store, m.id, "partner_a", "firmA")
  return { store, matterId: m.id }
}

const ingest = (matterId: string, content: string) => ({
  action: "ingest",
  actorId: "partner_a",
  firmId: "firmA",
  matterId,
  contentBase64: Buffer.from(content).toString("base64"),
  sourceChannel: "web",
  classification: "internal",
})

describe("Next idempotency: in-flight claim (F4)", () => {
  it("same key + same body, concurrently: the effect runs once, the duplicate gets 409 idempotency_in_progress", async () => {
    const store = getRuntimeStore()
    const before = store.matters.size
    const key = "b2b2b2b2-0000-4000-8000-000000000002"
    const rs = await Promise.all([
      MATTERS(req("http://127.0.0.1/api/d1/matters", matterBody, key)),
      MATTERS(req("http://127.0.0.1/api/d1/matters", matterBody, key)),
    ])
    expect(store.matters.size - before).toBe(1)
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409])
    const dup = rs.find((r) => r.status === 409)!
    expect(((await dup.json()) as { code: string }).code).toBe("idempotency_in_progress")
    // once the first finished, a retry replays it
    const retry = await MATTERS(req("http://127.0.0.1/api/d1/matters", matterBody, key))
    expect(retry.status).toBe(200)
    expect(((await retry.json()) as { reused: boolean }).reused).toBe(true)
    expect(store.matters.size - before).toBe(1)
  })

  it("same key + different bodies, concurrently: exactly one runs, the other gets 422 idempotency_key_reused", async () => {
    const { store, matterId } = matterWithPartner()
    const key = "b2b2b2b2-0000-4000-8000-000000000001"
    const rs = await Promise.all([
      DOCS(req("http://127.0.0.1/api/d1/documents", ingest(matterId, "one"), key)),
      DOCS(req("http://127.0.0.1/api/d1/documents", ingest(matterId, "two"), key)),
    ])
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1)
    const other = rs.find((r) => r.status !== 200)!
    expect(other.status).toBe(422)
    expect(((await other.json()) as { code: string }).code).toBe("idempotency_key_reused")
    expect([...store.documents.values()].filter((d) => d.matterId === matterId)).toHaveLength(1)
  })

  it("same key + different body after completion: 422 idempotency_key_reused (functions semantics)", async () => {
    const key = "b2b2b2b2-0000-4000-8000-000000000003"
    expect((await MATTERS(req("http://127.0.0.1/api/d1/matters", matterBody, key))).status).toBe(200)
    const res = await MATTERS(req("http://127.0.0.1/api/d1/matters", { ...matterBody, title: "other" }, key))
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe("idempotency_key_reused")
  })

  it("a refused request releases its key: a corrected retry with the same key runs", async () => {
    const store = getRuntimeStore()
    const key = "b2b2b2b2-0000-4000-8000-000000000004"
    const bad = await MATTERS(req("http://127.0.0.1/api/d1/matters", { ...matterBody, clientId: "ghost_client" }, key))
    expect(bad.status).toBe(400)
    const before = store.matters.size
    const good = await MATTERS(req("http://127.0.0.1/api/d1/matters", matterBody, key))
    expect(good.status).toBe(200)
    expect(((await good.json()) as { reused: boolean }).reused).toBe(false)
    expect(store.matters.size - before).toBe(1)
  })

  it("keys are scoped to the caller: the same key from another user runs on its own", async () => {
    const key = "b2b2b2b2-0000-4000-8000-000000000005"
    const store = getRuntimeStore()
    const before = store.matters.size
    const a = await MATTERS(req("http://127.0.0.1/api/d1/matters", matterBody, key))
    const b = await MATTERS(req("http://127.0.0.1/api/d1/matters", { ...matterBody, actorId: "associate_a" }, key))
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(((await b.json()) as { reused: boolean }).reused).toBe(false)
    expect(store.matters.size - before).toBe(2)
  })

  it("keys are scoped to the route: the same key on another route is not a reuse", async () => {
    const key = "b2b2b2b2-0000-4000-8000-000000000006"
    expect((await MATTERS(req("http://127.0.0.1/api/d1/matters", matterBody, key))).status).toBe(200)
    const res = await NORMALISE(req("http://127.0.0.1/api/g0/normalise", { actorId: "partner_a", raw: "C.P. No. D-1234 of 2025", courtId: "SHC" }, key))
    expect(res.status).toBe(200)
  })
})

describe("Next idempotency: memory (SEC-4)", () => {
  it("stores only a fixed-size fingerprint and the response, never the request payload", async () => {
    const { matterId } = matterWithPartner()
    const big = "x".repeat(600 * 1024)
    const res = await DOCS(req("http://127.0.0.1/api/d1/documents", ingest(matterId, big), "b2b2b2b2-0000-4000-8000-000000000007"))
    expect(res.status).toBe(200)
    const responseBytes = (await res.text()).length * 2
    // the upload was ~1.6 MB on the wire (base64 of 600 KB); only the small response is kept
    expect(idempotencyStoreForTests().storedBytes).toBeLessThanOrEqual(responseBytes)
    expect(idempotencyStoreForTests().storedBytes).toBeLessThan(64 * 1024)
  })
})

describe("IdempotencyStore bounds", () => {
  const limits = { ttlMs: 1_000, maxEntries: 3, maxBytes: 1_000, maxEntryBytes: 400, leaseMs: 100 }
  const done = (s: IdempotencyStore, key: string, body: unknown, now = 0) => {
    const begun = s.begin(key, "fp", now)
    if (begun.kind !== "claimed") throw new Error(`expected claim for ${key}, got ${begun.kind}`)
    s.complete(key, begun.claimId, body, now)
  }

  it("is an LRU bounded by entry count", () => {
    const s = new IdempotencyStore(limits)
    done(s, "a", 1)
    done(s, "b", 2)
    done(s, "c", 3)
    expect(s.begin("a", "fp", 1)).toEqual({ kind: "replay", body: 1 }) // a is now most recent
    done(s, "d", 4, 2)
    expect(s.size).toBe(3)
    expect(s.begin("b", "fp", 3).kind).toBe("claimed") // b was least recently used: evicted
  })

  it("is bounded by stored bytes", () => {
    const s = new IdempotencyStore({ ...limits, maxBytes: 800 })
    done(s, "a", "x".repeat(150)) // ~304 bytes
    done(s, "b", "x".repeat(150))
    done(s, "c", "x".repeat(150))
    expect(s.storedBytes).toBeLessThanOrEqual(800)
    expect(s.begin("a", "fp", 1).kind).toBe("claimed")
  })

  it("does not keep a response over the per-entry cap, but still refuses to re-run its key", () => {
    const s = new IdempotencyStore(limits)
    done(s, "big", "x".repeat(500))
    expect(s.storedBytes).toBe(0)
    expect(s.begin("big", "fp", 1)).toEqual({ kind: "unavailable" })
  })

  it("expires entries after the TTL", () => {
    const s = new IdempotencyStore(limits)
    done(s, "a", 1, 0)
    expect(s.begin("a", "fp", 999)).toEqual({ kind: "replay", body: 1 })
    expect(s.begin("a", "fp", 1_000).kind).toBe("claimed")
  })

  it("never evicts a live in-progress claim; a stale one may be taken over", () => {
    const s = new IdempotencyStore({ ...limits, maxEntries: 1 })
    expect(s.begin("a", "fp", 0).kind).toBe("claimed")
    done(s, "b", 2, 1)
    expect(s.begin("a", "fp", 2).kind).toBe("in_progress")
    expect(s.begin("a", "fp", 200).kind).toBe("claimed")
  })

  it("a released claim frees the key; a lost claim cannot complete", () => {
    const s = new IdempotencyStore(limits)
    const first = s.begin("a", "fp", 0)
    if (first.kind !== "claimed") throw new Error("claim")
    s.release("a", first.claimId)
    const second = s.begin("a", "fp", 1)
    if (second.kind !== "claimed") throw new Error("claim")
    s.complete("a", first.claimId, "stale", 2)
    expect(s.begin("a", "fp", 3).kind).toBe("in_progress")
    s.complete("a", second.claimId, "fresh", 4)
    expect(s.begin("a", "fp", 5)).toEqual({ kind: "replay", body: "fresh" })
  })
})

// Final audit F6: the effect committed but the end-of-request audit flush failed (503). The
// success response is still stored for the key, so a same-key retry replays it instead of
// committing the effect a second time.
describe("Next idempotency: committed effect + failed audit flush (F6)", () => {
  it("answers 503 AUDIT_UNAVAILABLE, and a same-key retry replays the success instead of re-running", async () => {
    const { setRequestAuditSinkForTests } = await import("@/platform/persistence/requestAuditFlush")
    const store = getRuntimeStore()
    const before = store.matters.size
    const key = "c3c3c3c3-0000-4000-8000-000000000001"
    setRequestAuditSinkForTests(async () => {
      throw new Error("audit store down")
    })
    try {
      const first = await MATTERS(req("http://127.0.0.1/api/d1/matters", matterBody, key))
      expect(first.status).toBe(503)
      expect(((await first.json()) as { code: string }).code).toBe("AUDIT_UNAVAILABLE")
      expect(store.matters.size - before).toBe(1)
      const retry = await MATTERS(req("http://127.0.0.1/api/d1/matters", matterBody, key))
      expect(retry.status).toBe(200)
      const json = (await retry.json()) as { reused: boolean; result: { matter: { id: string } } }
      expect(json.reused).toBe(true)
      expect(store.matters.has(json.result.matter.id)).toBe(true)
      expect(store.matters.size - before).toBe(1)
    } finally {
      setRequestAuditSinkForTests(null)
    }
  })
})
