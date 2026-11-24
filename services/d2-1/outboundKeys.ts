import { createHash } from "node:crypto"
import type { OutboundWhatsApp, WhatsAppSendOptions, WhatsAppSendResult, WhatsAppTransport } from "./transport"

/**
 * Durable once-only outbound sends (R3-L4).
 *
 * Before a send, a transaction `create`s `whatsapp_outbound_keys/{keyHash}`.
 * keyHash is sha256(firmId|idempotencyKey). The document is only keyHash,
 * createdAt and expiresAt: no recipient and no message text. A live row means
 * the send is not attempted, whether or not the transport looks at the key.
 * Expired rows are removed by `sweepExpiredWhatsAppOutboundKeys`, which is
 * exported and not scheduled. The collection is inventoried by W1-INV.
 */

export const WHATSAPP_OUTBOUND_KEYS_COLLECTION = "whatsapp_outbound_keys"

/** One sweep call deletes at most this many expired keys. */
export const WHATSAPP_OUTBOUND_SWEEP_LIMIT = 500

/** Firm id used when the webhook has no phone binding. */
export const UNBOUND_OUTBOUND_FIRM = "unbound"

export type OutboundKeyDoc = {
  keyHash: string
  createdAt: number
  expiresAt: number
}

export type OutboundKeyTx = {
  get(collection: string, id: string): Promise<OutboundKeyDoc | null>
  create(collection: string, id: string, data: OutboundKeyDoc): void
  delete(collection: string, id: string): void
}

export type OutboundKeyStore = {
  runTransaction<T>(fn: (tx: OutboundKeyTx) => Promise<T>): Promise<T>
  /** Expired documents only, oldest expiry first, at most `limit`. */
  listExpired(now: number, limit: number): Promise<Array<{ id: string } & OutboundKeyDoc>>
  delete(id: string): Promise<void>
}

export type MemoryOutboundKeyStore = OutboundKeyStore & {
  listAll(): Promise<Array<{ id: string } & OutboundKeyDoc>>
}

export class OutboundKeyExistsError extends Error {
  constructor() {
    super("ALREADY_EXISTS")
    this.name = "OutboundKeyExistsError"
  }
}

const DOC_FIELDS = ["keyHash", "createdAt", "expiresAt"] as const

export function outboundKeyHash(firmId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${firmId}|${idempotencyKey}`).digest("hex")
}

function assertKeyDoc(data: OutboundKeyDoc): void {
  const keys = Object.keys(data)
  if (keys.length !== DOC_FIELDS.length || DOC_FIELDS.some((field) => !keys.includes(field))) {
    throw new Error("whatsapp_outbound_keys refuses a document that is not keyHash, createdAt and expiresAt")
  }
  if (data.keyHash === "" || !Number.isFinite(data.createdAt) || !Number.isFinite(data.expiresAt)) {
    throw new Error("whatsapp_outbound_keys document is malformed")
  }
}

function assertCollection(collection: string): void {
  if (collection !== WHATSAPP_OUTBOUND_KEYS_COLLECTION) {
    throw new Error(`whatsapp outbound keys write refused for ${collection}`)
  }
}

export function createMemoryOutboundKeyStore(): MemoryOutboundKeyStore {
  const docs = new Map<string, OutboundKeyDoc>()
  let tail: Promise<unknown> = Promise.resolve()

  function queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  return {
    runTransaction(fn) {
      return queue(async () => {
        const staged = new Map<string, OutboundKeyDoc | null>()
        const tx: OutboundKeyTx = {
          async get(_collection, id) {
            if (staged.has(id)) return staged.get(id) ?? null
            return docs.get(id) ?? null
          },
          create(collection, id, data) {
            assertCollection(collection)
            assertKeyDoc(data)
            const current = staged.has(id) ? (staged.get(id) ?? null) : (docs.get(id) ?? null)
            if (current) throw new OutboundKeyExistsError()
            staged.set(id, { keyHash: data.keyHash, createdAt: data.createdAt, expiresAt: data.expiresAt })
          },
          delete(collection, id) {
            assertCollection(collection)
            staged.set(id, null)
          },
        }
        const result = await fn(tx)
        for (const [id, value] of staged) {
          if (value === null) docs.delete(id)
          else docs.set(id, value)
        }
        return result
      })
    },
    async listExpired(now, limit) {
      const cap = Math.max(0, Math.floor(limit))
      return [...docs.entries()]
        .filter(([, doc]) => doc.expiresAt <= now)
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt || a[0].localeCompare(b[0]))
        .slice(0, cap)
        .map(([id, doc]) => ({ id, ...doc }))
    },
    async delete(id) {
      docs.delete(id)
    },
    async listAll() {
      return [...docs.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, doc]) => ({ id, ...doc }))
    },
  }
}

let memorySingleton: MemoryOutboundKeyStore | undefined

export function defaultWhatsAppOutboundKeyStore(): MemoryOutboundKeyStore {
  memorySingleton ??= createMemoryOutboundKeyStore()
  return memorySingleton
}

export function resetWhatsAppOutboundKeyStoreForTests(): void {
  memorySingleton = undefined
}

type AdminTx = {
  get(ref: unknown): Promise<{ exists: boolean; data(): Partial<OutboundKeyDoc> | undefined }>
  create(ref: unknown, data: OutboundKeyDoc): void
  delete(ref: unknown): void
}

type AdminDb = {
  collection(name: string): {
    doc(id: string): unknown
    where(
      field: string,
      op: "<=",
      value: number
    ): {
      orderBy(field: string): {
        limit(n: number): { get(): Promise<{ docs: Array<{ id: string; data(): Partial<OutboundKeyDoc> | undefined }> }> }
      }
    }
  }
  runTransaction<T>(fn: (tx: AdminTx) => Promise<T>): Promise<T>
}

function readDoc(id: string, data: Partial<OutboundKeyDoc> | undefined): ({ id: string } & OutboundKeyDoc) | null {
  if (!data || typeof data.keyHash !== "string" || typeof data.createdAt !== "number" || typeof data.expiresAt !== "number") {
    return null
  }
  return { id, keyHash: data.keyHash, createdAt: data.createdAt, expiresAt: data.expiresAt }
}

/** Firestore adapter. `tx.create` is the insert fence. Tests use the memory store. */
export function createFirestoreOutboundKeyStore(db: AdminDb): OutboundKeyStore {
  const col = () => db.collection(WHATSAPP_OUTBOUND_KEYS_COLLECTION)
  return {
    runTransaction(fn) {
      return db.runTransaction(async (tx) =>
        fn({
          async get(_collection, id) {
            const snap = await tx.get(col().doc(id))
            if (!snap.exists) return null
            const row = readDoc(id, snap.data())
            return row ? { keyHash: row.keyHash, createdAt: row.createdAt, expiresAt: row.expiresAt } : null
          },
          create(collection, id, data) {
            assertCollection(collection)
            assertKeyDoc(data)
            tx.create(col().doc(id), { keyHash: data.keyHash, createdAt: data.createdAt, expiresAt: data.expiresAt })
          },
          delete(collection, id) {
            assertCollection(collection)
            tx.delete(col().doc(id))
          },
        })
      )
    },
    async listExpired(now, limit) {
      const cap = Math.max(0, Math.floor(limit))
      if (cap === 0) return []
      const snap = await col().where("expiresAt", "<=", now).orderBy("expiresAt").limit(cap).get()
      return snap.docs.flatMap((doc) => {
        const row = readDoc(doc.id, doc.data())
        return row ? [row] : []
      })
    },
    async delete(id) {
      await db.runTransaction(async (tx) => {
        tx.delete(col().doc(id))
      })
    },
  }
}

/**
 * The store for this process. Memory unless SIKANDER_PERSISTENCE_MODE=firestore.
 * An unset mode is memory under the test runner and refused otherwise, matching
 * the platform persistence rule without a silent production default.
 */
export async function openWhatsAppOutboundKeyStore(): Promise<OutboundKeyStore> {
  const mode = process.env.SIKANDER_PERSISTENCE_MODE?.trim().toLowerCase() ?? ""
  if (mode === "firestore") {
    const { getRuntimeFirestore } = await import("@/platform/persistence/runtimeRepositories")
    return createFirestoreOutboundKeyStore((await getRuntimeFirestore()) as AdminDb)
  }
  const testRunner = process.env.VITEST === "true" && process.env.NODE_ENV !== "production"
  if (mode === "memory" || (mode === "" && testRunner)) return defaultWhatsAppOutboundKeyStore()
  throw new Error("SIKANDER_PERSISTENCE_MODE must be memory or firestore for whatsapp outbound keys")
}

function isAlreadyExists(err: unknown): boolean {
  if (err instanceof OutboundKeyExistsError) return true
  if (!err || typeof err !== "object") return false
  const code = (err as { code?: unknown }).code
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS"
}

export type OutboundClaim =
  | { status: "claimed"; keyHash: string; createdAt: number; expiresAt: number }
  | { status: "duplicate"; keyHash: string }

/**
 * Insert the key. An existing row whose expiresAt is still ahead of `now` is a
 * duplicate and the caller must not send. An expired row is deleted and the
 * insert is retried, so the create remains the fence.
 */
export async function claimWhatsAppOutboundKey(
  store: OutboundKeyStore,
  input: { firmId: string; idempotencyKey: string; now: number; ttlMs: number }
): Promise<OutboundClaim> {
  const keyHash = outboundKeyHash(input.firmId, input.idempotencyKey)
  const doc: OutboundKeyDoc = { keyHash, createdAt: input.now, expiresAt: input.now + input.ttlMs }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const outcome = await store.runTransaction(async (tx) => {
        const existing = await tx.get(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash)
        if (!existing) {
          tx.create(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash, doc)
          return "claimed" as const
        }
        if (existing.expiresAt > input.now) return "duplicate" as const
        tx.delete(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash)
        return "expired" as const
      })
      if (outcome === "claimed") {
        return { status: "claimed", keyHash, createdAt: doc.createdAt, expiresAt: doc.expiresAt }
      }
      if (outcome === "duplicate") return { status: "duplicate", keyHash }
    } catch (err) {
      if (isAlreadyExists(err)) return { status: "duplicate", keyHash }
      throw err
    }
  }
  return { status: "duplicate", keyHash }
}

/** Drop the claim when the send failed before the provider accepted it, so a retry can deliver. */
export async function releaseWhatsAppOutboundKey(
  store: OutboundKeyStore,
  input: { firmId: string; idempotencyKey: string; createdAt: number }
): Promise<void> {
  const keyHash = outboundKeyHash(input.firmId, input.idempotencyKey)
  await store.runTransaction(async (tx) => {
    const existing = await tx.get(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash)
    if (existing && existing.createdAt === input.createdAt) {
      tx.delete(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash)
    }
  })
}

/**
 * Delete expired keys only. One call removes at most `limit` rows and never
 * more than WHATSAPP_OUTBOUND_SWEEP_LIMIT. Not scheduled.
 */
export async function sweepExpiredWhatsAppOutboundKeys(
  store: OutboundKeyStore,
  now: number,
  limit = WHATSAPP_OUTBOUND_SWEEP_LIMIT
): Promise<number> {
  const requested = Number.isFinite(limit) ? Math.floor(limit) : WHATSAPP_OUTBOUND_SWEEP_LIMIT
  const cap = Math.max(0, Math.min(requested, WHATSAPP_OUTBOUND_SWEEP_LIMIT))
  if (cap === 0) return 0
  const expired = await store.listExpired(now, cap)
  let pruned = 0
  for (const doc of expired) {
    const removed = await store.runTransaction(async (tx) => {
      const current = await tx.get(WHATSAPP_OUTBOUND_KEYS_COLLECTION, doc.id)
      if (!current || current.expiresAt > now) return false
      tx.delete(WHATSAPP_OUTBOUND_KEYS_COLLECTION, doc.id)
      return true
    })
    if (removed) pruned += 1
  }
  return pruned
}

/**
 * Claim the durable key, then send. A live key does not call the transport.
 * A throw before acceptance releases the key. The transport's own key handling
 * is not the once-only guarantee.
 */
export async function sendWhatsAppOnce(
  transport: WhatsAppTransport,
  message: OutboundWhatsApp,
  options: WhatsAppSendOptions & { firmId: string; keys: OutboundKeyStore }
): Promise<WhatsAppSendResult> {
  const key = options.idempotencyKey
  if (key === undefined) return transport.send(message, options)
  const now = options.now ?? Date.now()
  // A missing TTL does not expire. A finite horizon keeps the stored expiresAt a number.
  const ttlMs = options.idempotencyTtlMs ?? 100 * 365 * 24 * 60 * 60 * 1000
  const claim = await claimWhatsAppOutboundKey(options.keys, {
    firmId: options.firmId,
    idempotencyKey: key,
    now,
    ttlMs,
  })
  if (claim.status === "duplicate") {
    options.onAccepted?.()
    return { delivered: false, transport: "stub" }
  }
  let accepted = false
  try {
    return await transport.send(message, {
      ...options,
      onAccepted: () => {
        accepted = true
        options.onAccepted?.()
      },
    })
  } catch (err) {
    if (!accepted) {
      await releaseWhatsAppOutboundKey(options.keys, {
        firmId: options.firmId,
        idempotencyKey: key,
        createdAt: claim.createdAt,
      })
    }
    throw err
  }
}
