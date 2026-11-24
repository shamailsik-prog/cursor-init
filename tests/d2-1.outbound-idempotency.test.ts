import { createHash, createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Timestamp } from "firebase-admin/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import { newStore } from "@/platform/spine/store"
import { D2_WHATSAPP_GRAMMAR_FLAG } from "@/services/d2-1/grammar"
import {
  claimWhatsAppOutboundKey,
  createFirestoreOutboundKeyStore,
  createMemoryOutboundKeyStore,
  firestoreOutboundKeyWrite,
  openWhatsAppOutboundKeyStore,
  outboundKeyHash,
  releaseWhatsAppOutboundKey,
  sendWhatsAppOnce,
  sweepExpiredWhatsAppOutboundKeys,
  WHATSAPP_OUTBOUND_KEYS_COLLECTION,
  WHATSAPP_OUTBOUND_SWEEP_LIMIT,
  type OutboundKeyDoc,
} from "@/services/d2-1/outboundKeys"
import type { OutboundWhatsApp, WhatsAppSendResult, WhatsAppTransport } from "@/services/d2-1/transport"
import {
  handleWhatsAppWebhook,
  resetD2WhatsAppWebhookForTests,
  WHATSAPP_DEDUPE_TTL_MS,
  WHATSAPP_PROCESSING_TIMEOUT_MS,
  type WebhookDeps,
} from "@/services/d2-1/webhook"

/**
 * R3-L4. The once-only send is a whatsapp_outbound_keys create, not the stub's
 * deliveredKeys map. The cross-process webhook case is red on 7ae1a33f.
 */

const SECRET = "test-whatsapp-secret-0123456789a"
const NOW = Date.parse("2026-11-15T00:00:00Z")

function sign(raw: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`
}

function signed(payload: unknown): Request {
  const raw = JSON.stringify(payload)
  return new Request("http://127.0.0.1/api/d2/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": sign(raw),
    },
    body: raw,
  })
}

function naiveTransport(): WhatsAppTransport & { sent: OutboundWhatsApp[] } {
  const sent: OutboundWhatsApp[] = []
  return {
    sent,
    async send(message: OutboundWhatsApp): Promise<WhatsAppSendResult> {
      sent.push(message)
      return { delivered: false, transport: "stub" }
    },
  }
}

function deps(transport: WhatsAppTransport, extra: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    store: () => newStore(),
    transport,
    secret: () => SECRET,
    now: NOW,
    ...extra,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  resetD2WhatsAppWebhookForTests()
})

describe("R3-L4 durable outbound idempotency", () => {
  it("a naive transport sends one message when a second process retries the same webhook", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const transport = naiveTransport()
    const keys = createMemoryOutboundKeyStore()
    const payload = { messageId: "wamid.durable", userId: "clerk1", text: "/help" }
    const first = await handleWhatsAppWebhook(signed(payload), deps(transport, { outboundKeys: keys }))
    expect(first.status).toBe(200)
    expect(transport.sent).toHaveLength(1)
    resetD2WhatsAppWebhookForTests()
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const second = await handleWhatsAppWebhook(signed(payload), deps(transport, { outboundKeys: keys, now: NOW }))
    expect(second.status).toBe(200)
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toBe("not linked")
    const docs = await keys.listAll()
    expect(docs).toHaveLength(1)
    expect(docs[0]?.keyHash).toBe(docs[0]?.id)
    expect(Object.keys(docs[0] ?? {}).sort()).toEqual(["createdAt", "expiresAt", "firmId", "id", "keyHash", "leaseUntil", "state"])
    expect(docs[0]?.state).toBe("sent")
    expect(docs[0]?.firmId).toBe("unbound")
    expect(Number.isFinite(docs[0]?.expiresAt)).toBe(true)
    expect(JSON.stringify(docs[0])).not.toContain("not linked")
    expect(JSON.stringify(docs[0])).not.toContain("/help")
  })

  it("two concurrent identical webhooks on a naive transport send once", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const transport = naiveTransport()
    const keys = createMemoryOutboundKeyStore()
    const payload = { messageId: "wamid.race", userId: "clerk1", text: "/help" }
    const call = () => handleWhatsAppWebhook(signed(payload), deps(transport, { outboundKeys: keys }))
    const [left, right] = await Promise.all([call(), call()])
    expect(left.status).toBe(200)
    expect(right.status).toBe(200)
    expect(transport.sent).toHaveLength(1)
  })

  it("two concurrent claims call a naive transport once, and the key is sha256(firmId|idempotencyKey)", async () => {
    const keys = createMemoryOutboundKeyStore()
    const transport = naiveTransport()
    const message = { toUserId: "unbound", text: "not linked" }
    const idempotencyKey = "payload-key"
    await Promise.all([
      sendWhatsAppOnce(transport, message, { firmId: "firmA", idempotencyKey, keys, now: NOW, idempotencyTtlMs: 1_000 }),
      sendWhatsAppOnce(transport, message, { firmId: "firmA", idempotencyKey, keys, now: NOW, idempotencyTtlMs: 1_000 }),
    ])
    expect(transport.sent).toHaveLength(1)
    const docs = await keys.listAll()
    expect(docs).toHaveLength(1)
    const expected = createHash("sha256").update("firmA|payload-key").digest("hex")
    expect(docs[0]?.keyHash).toBe(expected)
    expect(docs[0]?.keyHash).toBe(outboundKeyHash("firmA", idempotencyKey))
    expect(docs[0]?.firmId).toBe("firmA")
    expect(docs[0]?.createdAt).toBe(NOW)
    expect(docs[0]?.expiresAt).toBe(NOW + 1_000)
  })

  it("a failed send before acceptance releases the key, and an accepted send does not", async () => {
    const keys = createMemoryOutboundKeyStore()
    const failing: WhatsAppTransport = {
      async send() {
        throw new Error("provider down")
      },
    }
    await expect(
      sendWhatsAppOnce(failing, { toUserId: "unbound", text: "not linked" }, {
        firmId: "firmA",
        idempotencyKey: "retry-me",
        keys,
        now: NOW,
        idempotencyTtlMs: 1_000,
      })
    ).rejects.toThrow("provider down")
    const transport = naiveTransport()
    await sendWhatsAppOnce(transport, { toUserId: "unbound", text: "not linked" }, {
      firmId: "firmA",
      idempotencyKey: "retry-me",
      keys,
      now: NOW,
      idempotencyTtlMs: 1_000,
    })
    expect(transport.sent).toHaveLength(1)

    let accepted = false
    const stall: WhatsAppTransport = {
      async send(_message, options) {
        accepted = true
        options?.onAccepted?.()
        throw new Error("accepted then failed")
      },
    }
    await expect(
      sendWhatsAppOnce(stall, { toUserId: "unbound", text: "kept" }, {
        firmId: "firmA",
        idempotencyKey: "kept",
        keys,
        now: NOW,
        idempotencyTtlMs: 1_000,
      })
    ).rejects.toThrow("accepted then failed")
    expect(accepted).toBe(true)
    const again = naiveTransport()
    await sendWhatsAppOnce(again, { toUserId: "unbound", text: "kept" }, {
      firmId: "firmA",
      idempotencyKey: "kept",
      keys,
      now: NOW,
      idempotencyTtlMs: 1_000,
    })
    expect(again.sent).toHaveLength(0)
  })

  it("refuses a key document that carries message content", async () => {
    const keys = createMemoryOutboundKeyStore()
    await expect(
      keys.runTransaction(async (tx) => {
        tx.create(WHATSAPP_OUTBOUND_KEYS_COLLECTION, "x", {
          keyHash: "x",
          firmId: "firmA",
          createdAt: 1,
          expiresAt: 2,
          state: "pending",
          leaseUntil: 3,
          text: "secret",
        } as OutboundKeyDoc)
      })
    ).rejects.toThrow(/state and leaseUntil/)
  })

  it("refuses a write that omits expiresAt or firmId, and every accepted row carries both", async () => {
    const keys = createMemoryOutboundKeyStore()
    await expect(
      keys.runTransaction(async (tx) => {
        tx.create(WHATSAPP_OUTBOUND_KEYS_COLLECTION, "x", {
          keyHash: "x",
          firmId: "firmA",
          createdAt: 1,
        } as OutboundKeyDoc)
      })
    ).rejects.toThrow(/expiresAt/)
    await expect(
      keys.runTransaction(async (tx) => {
        tx.create(WHATSAPP_OUTBOUND_KEYS_COLLECTION, "x", {
          keyHash: "x",
          createdAt: 1,
          expiresAt: 2,
        } as OutboundKeyDoc)
      })
    ).rejects.toThrow(/firmId/)
    expect(
      firestoreOutboundKeyWrite({
        keyHash: "h",
        firmId: "firmA",
        createdAt: 10,
        expiresAt: 15,
        state: "pending",
        leaseUntil: 20,
      }).expiresAt.toMillis()
    ).toBe(15)
    expect(() =>
      firestoreOutboundKeyWrite({
        keyHash: "h",
        firmId: "",
        createdAt: 10,
        expiresAt: 15,
        state: "pending",
        leaseUntil: 20,
      })
    ).toThrow(/malformed/)
    const claim = await claimWhatsAppOutboundKey(keys, { firmId: "firmA", idempotencyKey: "row", now: 10, ttlMs: 5 })
    expect(claim.status).toBe("claimed")
    const docs = await keys.listAll()
    expect(docs).toHaveLength(1)
    expect(docs.every((doc) => doc.firmId === "firmA" && Number.isFinite(doc.expiresAt))).toBe(true)
  })

  it("firestore.indexes.json TTL-expires whatsapp_outbound_keys.expiresAt", () => {
    const indexes = JSON.parse(readFileSync(path.join(process.cwd(), "firestore.indexes.json"), "utf8")) as {
      fieldOverrides?: { collectionGroup: string; fieldPath: string; ttl?: boolean; indexes?: unknown[] }[]
    }
    const override = indexes.fieldOverrides?.find(
      (entry) => entry.collectionGroup === WHATSAPP_OUTBOUND_KEYS_COLLECTION && entry.fieldPath === "expiresAt"
    )
    expect(override?.ttl).toBe(true)
    expect(override?.indexes?.length).toBeGreaterThanOrEqual(3)
  })

  it("the sweep drops only expired keys, at most the bound per call, and 3000 expired keys at 10×TTL drain to none", async () => {
    const keys = createMemoryOutboundKeyStore()
    const ttl = 1_000
    const t0 = 5_000
    for (let i = 0; i < 3_000; i++) {
      const claim = await claimWhatsAppOutboundKey(keys, { firmId: "firmA", idempotencyKey: `k${i}`, now: t0, ttlMs: ttl })
      expect(claim.status).toBe("claimed")
    }
    for (const name of ["live-a", "live-b", "live-c"]) {
      const claim = await claimWhatsAppOutboundKey(keys, {
        firmId: "firmA",
        idempotencyKey: name,
        now: t0,
        ttlMs: ttl * 11,
      })
      expect(claim.status).toBe("claimed")
    }
    const clock = t0 + ttl * 10
    const first = await sweepExpiredWhatsAppOutboundKeys(keys, clock, 10)
    expect(first).toBe(10)
    expect(first).toBeLessThanOrEqual(WHATSAPP_OUTBOUND_SWEEP_LIMIT)
    const oversize = await sweepExpiredWhatsAppOutboundKeys(keys, clock, 1_000_000)
    expect(oversize).toBe(WHATSAPP_OUTBOUND_SWEEP_LIMIT)
    let rounds = 2
    let remaining = 3_000 - first - oversize
    while (remaining > 0) {
      const pruned = await sweepExpiredWhatsAppOutboundKeys(keys, clock)
      expect(pruned).toBeGreaterThan(0)
      expect(pruned).toBeLessThanOrEqual(WHATSAPP_OUTBOUND_SWEEP_LIMIT)
      remaining -= pruned
      rounds += 1
      expect(rounds).toBeLessThan(20)
    }
    expect(await sweepExpiredWhatsAppOutboundKeys(keys, clock)).toBe(0)
    const left = await keys.listAll()
    expect(left).toHaveLength(3)
    expect(left.every((doc) => doc.firmId === "firmA" && doc.expiresAt > clock)).toBe(true)
    expect(left.map((doc) => doc.keyHash).sort()).toEqual(
      ["live-a", "live-b", "live-c"].map((name) => outboundKeyHash("firmA", name)).sort()
    )
  })

  it("an expired key allows one new send and the webhook TTL boundary still sends again", async () => {
    const keys = createMemoryOutboundKeyStore()
    const transport = naiveTransport()
    const message = { toUserId: "unbound", text: "not linked" }
    await sendWhatsAppOnce(transport, message, {
      firmId: "unbound",
      idempotencyKey: "same",
      keys,
      now: NOW,
      idempotencyTtlMs: WHATSAPP_DEDUPE_TTL_MS,
    })
    await sendWhatsAppOnce(transport, message, {
      firmId: "unbound",
      idempotencyKey: "same",
      keys,
      now: NOW + WHATSAPP_DEDUPE_TTL_MS - 1,
      idempotencyTtlMs: WHATSAPP_DEDUPE_TTL_MS,
    })
    expect(transport.sent).toHaveLength(1)
    await sendWhatsAppOnce(transport, message, {
      firmId: "unbound",
      idempotencyKey: "same",
      keys,
      now: NOW + WHATSAPP_DEDUPE_TTL_MS,
      idempotencyTtlMs: WHATSAPP_DEDUPE_TTL_MS,
    })
    expect(transport.sent).toHaveLength(2)
  })

  it("the Firestore adapter inserts with tx.create, a Timestamp expiresAt, firmId, and no message", async () => {
    const docs = new Map<string, ReturnType<typeof firestoreOutboundKeyWrite>>()
    const createdIn: string[] = []
    const bounds: unknown[] = []
    const db = {
      collection(name: string) {
        return {
          doc(id: string) {
            return { id, collection: name }
          },
          where(_field: string, _op: string, value: unknown) {
            bounds.push(value)
            return {
              orderBy() {
                return {
                  limit() {
                    return {
                      async get() {
                        return {
                          docs: [...docs.entries()].map(([id, data]) => ({ id, data: () => data })),
                        }
                      },
                    }
                  },
                }
              },
            }
          },
        }
      },
      async runTransaction<T>(fn: (tx: {
        get(ref: { id: string }): Promise<{ exists: boolean; data(): ReturnType<typeof firestoreOutboundKeyWrite> | undefined }>
        create(ref: { id: string; collection: string }, data: ReturnType<typeof firestoreOutboundKeyWrite>): void
        delete(ref: { id: string }): void
      }) => Promise<T>): Promise<T> {
        return fn({
          async get(ref) {
            const data = docs.get(ref.id)
            return { exists: data !== undefined, data: () => data }
          },
          create(ref, data) {
            createdIn.push(ref.collection)
            if (docs.has(ref.id)) throw Object.assign(new Error("exists"), { code: "already-exists" })
            docs.set(ref.id, data)
          },
          delete(ref) {
            docs.delete(ref.id)
          },
        })
      },
    }
    const store = createFirestoreOutboundKeyStore(db as never)
    const claim = await claimWhatsAppOutboundKey(store, { firmId: "firmA", idempotencyKey: "k", now: 10, ttlMs: 5 })
    expect(claim.status).toBe("claimed")
    expect(createdIn).toEqual([WHATSAPP_OUTBOUND_KEYS_COLLECTION])
    const row = [...docs.values()][0]
    expect(row && Object.keys(row).sort()).toEqual(["createdAt", "expiresAt", "firmId", "keyHash", "leaseUntil", "state"])
    expect(row?.firmId).toBe("firmA")
    expect(row?.expiresAt).toBeInstanceOf(Timestamp)
    expect(row?.expiresAt.toMillis()).toBe(15)
    expect(JSON.stringify(row)).not.toContain("hello")
    const again = await claimWhatsAppOutboundKey(store, { firmId: "firmA", idempotencyKey: "k", now: 11, ttlMs: 5 })
    expect(again.status).toBe("inFlight")
    expect(docs.size).toBe(1)
    const expired = await store.listExpired(20, 1)
    expect(expired).toHaveLength(1)
    expect(expired[0]?.firmId).toBe("firmA")
    expect(bounds[0]).toBeInstanceOf(Timestamp)
    expect((bounds[0] as Timestamp).toMillis()).toBe(20)
  })

  it("a pending duplicate does not call onAccepted, and a stale pending lease can be taken over", async () => {
    const keys = createMemoryOutboundKeyStore()
    let accepted = 0
    let releaseHold: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve
    })
    const transport: WhatsAppTransport = {
      async send(_message, options) {
        await hold
        options?.onAccepted?.()
        return { delivered: false, transport: "stub" }
      },
    }
    const message = { toUserId: "unbound", text: "not linked" }
    const first = sendWhatsAppOnce(transport, message, {
      firmId: "firmA",
      idempotencyKey: "held",
      keys,
      now: 1_000,
      idempotencyTtlMs: 60_000,
      leaseMs: 5_000,
      onAccepted: () => {
        accepted += 1
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const inflight = await sendWhatsAppOnce(transport, message, {
      firmId: "firmA",
      idempotencyKey: "held",
      keys,
      now: 2_000,
      idempotencyTtlMs: 60_000,
      leaseMs: 5_000,
      onAccepted: () => {
        accepted += 1
      },
    })
    expect(inflight.status).toBe("inFlight")
    expect(accepted).toBe(0)
    const blocked = await claimWhatsAppOutboundKey(keys, {
      firmId: "firmA",
      idempotencyKey: "held",
      now: 2_000,
      ttlMs: 60_000,
      leaseMs: 5_000,
    })
    expect(blocked.status).toBe("inFlight")
    const stolen = await claimWhatsAppOutboundKey(keys, {
      firmId: "firmA",
      idempotencyKey: "held",
      now: 1_000 + 5_000,
      ttlMs: 60_000,
      leaseMs: 5_000,
    })
    expect(stolen.status).toBe("claimed")
    if (stolen.status !== "claimed") return
    await releaseWhatsAppOutboundKey(keys, { firmId: "firmA", idempotencyKey: "held", createdAt: 1_000 })
    const left = await keys.listAll()
    expect(left).toHaveLength(1)
    expect(left[0]?.createdAt).toBe(stolen.createdAt)
    expect(left[0]?.state).toBe("pending")
    expect(left[0]?.firmId).toBe("firmA")
    expect(Number.isFinite(left[0]?.expiresAt)).toBe(true)
    releaseHold()
    await first.catch(() => undefined)
  })

  it("503, then an in-flight retry, then one real send and no lost message", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const realSetTimeout = globalThis.setTimeout
    vi.useFakeTimers()
    try {
      const sent: OutboundWhatsApp[] = []
      let calls = 0
      let finishFirst: (err: Error) => void = () => {}
      const gate = new Promise<void>((_resolve, reject) => {
        finishFirst = reject
      })
      const transport: WhatsAppTransport = {
        async send(message, options) {
          calls += 1
          if (calls === 1) await gate
          if (options?.signal?.aborted) throw new Error("aborted")
          sent.push(message)
          options?.onAccepted?.()
          return { delivered: false, transport: "stub" }
        },
      }
      const keys = createMemoryOutboundKeyStore()
      const payload = { messageId: "wamid.pending", userId: "clerk1", text: "/help" }
      const started = handleWhatsAppWebhook(signed(payload), deps(transport, { outboundKeys: keys, now: NOW }))
      for (let i = 0; i < 20 && calls !== 1; i += 1) {
        await new Promise((resolve) => realSetTimeout(resolve, 0))
      }
      expect(calls).toBe(1)
      resetD2WhatsAppWebhookForTests()
      vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
      const inflight = await handleWhatsAppWebhook(signed(payload), deps(transport, { outboundKeys: keys, now: NOW }))
      expect(inflight.status).toBe(503)
      expect(inflight.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/)
      expect(await inflight.json()).toEqual({ ok: false })
      expect(calls).toBe(1)
      expect(sent).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(WHATSAPP_PROCESSING_TIMEOUT_MS)
      const first = await started
      expect(first.status).toBe(503)
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => realSetTimeout(resolve, 0))

      const delivered = await handleWhatsAppWebhook(signed(payload), deps(transport, { outboundKeys: keys, now: NOW }))
      expect(delivered.status).toBe(200)
      expect(await delivered.json()).toEqual({ ok: false })
      expect(sent).toHaveLength(1)
      expect(sent[0]?.text).toBe("not linked")
      expect(calls).toBe(2)

      resetD2WhatsAppWebhookForTests()
      vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
      const again = await handleWhatsAppWebhook(signed(payload), deps(transport, { outboundKeys: keys, now: NOW }))
      expect(again.status).toBe(200)
      expect(sent).toHaveLength(1)
      expect(calls).toBe(2)
      finishFirst(new Error("aborted"))
    } finally {
      vi.useRealTimers()
    }
  })

  it("refuses a memory outbound-key store when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "memory")
    await expect(openWhatsAppOutboundKeyStore()).rejects.toThrow(/memory/)
  })
})
