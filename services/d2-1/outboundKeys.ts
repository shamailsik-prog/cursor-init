import { createHash } from "node:crypto"
import { Timestamp } from "firebase-admin/firestore"
import { resolvePersistenceMode } from "@/platform/persistence/runtimeRepositories"
import type { OutboundWhatsApp, WhatsAppSendOptions, WhatsAppSendResult, WhatsAppTransport } from "./transport"

/**
 * Durable once-only outbound sends (R3-L4).
 *
 * Before a send, a transaction `create`s `whatsapp_outbound_keys/{keyHash}`.
 * keyHash is sha256(firmId|idempotencyKey). Every row is keyHash, firmId,
 * createdAt, expiresAt, state and leaseUntil: no recipient and no message text.
 * state is pending while the send has not been accepted, then sent. A pending
 * row whose lease is still live is in flight: the caller must not treat it as
 * accepted. A pending row whose lease has passed can be taken over, so a crash
 * mid-send does not block the key until expiresAt. expiresAt is set on every
 * write. Firestore stores it as a Timestamp so the TTL field override can
 * delete the row. Expired rows are removed by `sweepExpiredWhatsAppOutboundKeys`,
 * which is exported and not scheduled. The collection is registered in the
 * retention inventory (no longer pending).
 */

export const WHATSAPP_OUTBOUND_KEYS_COLLECTION = "whatsapp_outbound_keys"

/** One sweep call deletes at most this many expired keys. */
export const WHATSAPP_OUTBOUND_SWEEP_LIMIT = 500

/** How long a pending row reserves the send before another worker may take it. */
export const WHATSAPP_OUTBOUND_LEASE_MS = 30_000

export type OutboundKeyState = "pending" | "sent"

/** Firm id used when the webhook has no phone binding. */
export const UNBOUND_OUTBOUND_FIRM = "unbound"

export type OutboundKeyDoc = {
  keyHash: string
  firmId: string
  createdAt: number
  expiresAt: number
  state: OutboundKeyState
  leaseUntil: number
}

export type OutboundKeyTx = {
  get(collection: string, id: string): Promise<OutboundKeyDoc | null>
  create(collection: string, id: string, data: OutboundKeyDoc): void
  /** Replace the row. Used to mark sent and to take over a stale pending lease. */
  set(collection: string, id: string, data: OutboundKeyDoc): void
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

const DOC_FIELDS = ["keyHash", "firmId", "createdAt", "expiresAt", "state", "leaseUntil"] as const

export function outboundKeyHash(firmId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${firmId}|${idempotencyKey}`).digest("hex")
}

/** The only document shape a write may store. expiresAt and firmId are mandatory. */
export function outboundKeyDocument(data: OutboundKeyDoc): OutboundKeyDoc {
  const keys = Object.keys(data)
  if (keys.length !== DOC_FIELDS.length || DOC_FIELDS.some((field) => !keys.includes(field))) {
    throw new Error(
      "whatsapp_outbound_keys refuses a document that is not keyHash, firmId, createdAt, expiresAt, state and leaseUntil"
    )
  }
  if (
    data.keyHash === "" ||
    data.firmId === "" ||
    !Number.isFinite(data.createdAt) ||
    !Number.isFinite(data.expiresAt) ||
    (data.state !== "pending" && data.state !== "sent") ||
    !Number.isFinite(data.leaseUntil)
  ) {
    throw new Error("whatsapp_outbound_keys document is malformed")
  }
  return {
    keyHash: data.keyHash,
    firmId: data.firmId,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
    state: data.state,
    leaseUntil: data.leaseUntil,
  }
}

function assertKeyDoc(data: OutboundKeyDoc): OutboundKeyDoc {
  return outboundKeyDocument(data)
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
            const row = assertKeyDoc(data)
            const current = staged.has(id) ? (staged.get(id) ?? null) : (docs.get(id) ?? null)
            if (current) throw new OutboundKeyExistsError()
            staged.set(id, row)
          },
          set(collection, id, data) {
            assertCollection(collection)
            staged.set(id, assertKeyDoc(data))
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

type FirestoreKeyWrite = {
  keyHash: string
  firmId: string
  createdAt: number
  expiresAt: Timestamp
  state: OutboundKeyState
  leaseUntil: number
}

type AdminTx = {
  get(ref: unknown): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>
  create(ref: unknown, data: FirestoreKeyWrite): void
  set(ref: unknown, data: FirestoreKeyWrite): void
  delete(ref: unknown): void
}

type AdminDb = {
  collection(name: string): {
    doc(id: string): unknown
    where(
      field: string,
      op: "<=",
      value: Timestamp
    ): {
      orderBy(field: string): {
        limit(n: number): { get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> | undefined }> }> }
      }
    }
  }
  runTransaction<T>(fn: (tx: AdminTx) => Promise<T>): Promise<T>
}

function expiresAtMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value instanceof Timestamp) return value.toMillis()
  return null
}

function readDoc(id: string, data: Record<string, unknown> | undefined): ({ id: string } & OutboundKeyDoc) | null {
  if (!data || typeof data.keyHash !== "string" || typeof data.firmId !== "string" || data.firmId === "") return null
  const expiresAt = expiresAtMillis(data.expiresAt)
  if (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt) || expiresAt === null) return null
  if ((data.state !== "pending" && data.state !== "sent") || typeof data.leaseUntil !== "number" || !Number.isFinite(data.leaseUntil)) {
    return null
  }
  return {
    id,
    keyHash: data.keyHash,
    firmId: data.firmId,
    createdAt: data.createdAt,
    expiresAt,
    state: data.state,
    leaseUntil: data.leaseUntil,
  }
}

/** Firestore write. expiresAt is a Timestamp on every create and every set so the TTL policy can see it. */
export function firestoreOutboundKeyWrite(data: OutboundKeyDoc): FirestoreKeyWrite {
  const row = assertKeyDoc(data)
  return {
    keyHash: row.keyHash,
    firmId: row.firmId,
    createdAt: row.createdAt,
    expiresAt: Timestamp.fromMillis(row.expiresAt),
    state: row.state,
    leaseUntil: row.leaseUntil,
  }
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
            return row
              ? {
                  keyHash: row.keyHash,
                  firmId: row.firmId,
                  createdAt: row.createdAt,
                  expiresAt: row.expiresAt,
                  state: row.state,
                  leaseUntil: row.leaseUntil,
                }
              : null
          },
          create(collection, id, data) {
            assertCollection(collection)
            tx.create(col().doc(id), firestoreOutboundKeyWrite(data))
          },
          set(collection, id, data) {
            assertCollection(collection)
            tx.set(col().doc(id), firestoreOutboundKeyWrite(data))
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
      const snap = await col().where("expiresAt", "<=", Timestamp.fromMillis(now)).orderBy("expiresAt").limit(cap).get()
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
 * The store for this process. Uses resolvePersistenceMode, so memory is refused
 * when NODE_ENV=production and an unset mode is memory only under the test runner.
 */
export async function openWhatsAppOutboundKeyStore(): Promise<OutboundKeyStore> {
  const mode = resolvePersistenceMode()
  if (mode === "firestore") {
    const { getRuntimeFirestore } = await import("@/platform/persistence/runtimeRepositories")
    return createFirestoreOutboundKeyStore((await getRuntimeFirestore()) as AdminDb)
  }
  return defaultWhatsAppOutboundKeyStore()
}

function isAlreadyExists(err: unknown): boolean {
  if (err instanceof OutboundKeyExistsError) return true
  if (!err || typeof err !== "object") return false
  const code = (err as { code?: unknown }).code
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS"
}

export type OutboundClaim =
  | { status: "claimed"; keyHash: string; createdAt: number; expiresAt: number }
  | { status: "accepted"; keyHash: string }
  | { status: "inFlight"; keyHash: string; retryAfterMs: number }

/**
 * Insert the key as pending. A sent row that has not expired is accepted and
 * must not send again. A pending row whose lease is still ahead of `now` is in
 * flight and must not be treated as accepted. A pending row whose lease has
 * passed is taken over. An expired row is deleted and the insert is retried.
 */
export async function claimWhatsAppOutboundKey(
  store: OutboundKeyStore,
  input: { firmId: string; idempotencyKey: string; now: number; ttlMs: number; leaseMs?: number }
): Promise<OutboundClaim> {
  const keyHash = outboundKeyHash(input.firmId, input.idempotencyKey)
  const leaseMs = input.leaseMs ?? WHATSAPP_OUTBOUND_LEASE_MS
  const fresh = (): OutboundKeyDoc =>
    outboundKeyDocument({
      keyHash,
      firmId: input.firmId,
      createdAt: input.now,
      expiresAt: input.now + input.ttlMs,
      state: "pending",
      leaseUntil: input.now + leaseMs,
    })
  for (let attempt = 0; attempt < 2; attempt++) {
    const doc = fresh()
    try {
      const outcome = await store.runTransaction(async (tx) => {
        const existing = await tx.get(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash)
        if (!existing) {
          tx.create(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash, doc)
          return { kind: "claimed" as const, createdAt: doc.createdAt, expiresAt: doc.expiresAt }
        }
        if (existing.expiresAt <= input.now) {
          tx.delete(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash)
          return { kind: "expired" as const }
        }
        if (existing.state === "sent") return { kind: "accepted" as const }
        if (existing.leaseUntil > input.now) {
          return { kind: "inFlight" as const, retryAfterMs: Math.max(1, existing.leaseUntil - input.now) }
        }
        tx.set(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash, doc)
        return { kind: "claimed" as const, createdAt: doc.createdAt, expiresAt: doc.expiresAt }
      })
      if (outcome.kind === "claimed") {
        return { status: "claimed", keyHash, createdAt: outcome.createdAt, expiresAt: outcome.expiresAt }
      }
      if (outcome.kind === "accepted") return { status: "accepted", keyHash }
      if (outcome.kind === "expired") continue
      return { status: "inFlight", keyHash, retryAfterMs: outcome.retryAfterMs }
    } catch (err) {
      if (isAlreadyExists(err)) continue
      throw err
    }
  }
  return { status: "inFlight", keyHash, retryAfterMs: leaseMs }
}

/** Drop the claim when the send failed before the provider accepted it, so a retry can deliver. */
export async function releaseWhatsAppOutboundKey(
  store: OutboundKeyStore,
  input: { firmId: string; idempotencyKey: string; createdAt: number }
): Promise<void> {
  const keyHash = outboundKeyHash(input.firmId, input.idempotencyKey)
  await store.runTransaction(async (tx) => {
    const existing = await tx.get(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash)
    if (existing && existing.state === "pending" && existing.createdAt === input.createdAt) {
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

/** Record acceptance. A stolen lease (a different createdAt) is left alone. */
export async function markWhatsAppOutboundKeySent(
  store: OutboundKeyStore,
  input: { firmId: string; idempotencyKey: string; createdAt: number }
): Promise<void> {
  const keyHash = outboundKeyHash(input.firmId, input.idempotencyKey)
  await store.runTransaction(async (tx) => {
    const existing = await tx.get(WHATSAPP_OUTBOUND_KEYS_COLLECTION, keyHash)
    if (!existing || existing.state !== "pending" || existing.createdAt !== input.createdAt) return
    tx.set(
      WHATSAPP_OUTBOUND_KEYS_COLLECTION,
      keyHash,
      outboundKeyDocument({ ...existing, state: "sent", leaseUntil: existing.expiresAt })
    )
  })
}

export type OnceSend =
  | { status: "sent"; result: WhatsAppSendResult }
  | { status: "accepted"; result: WhatsAppSendResult }
  | { status: "inFlight"; retryAfterMs: number }

/**
 * Claim the durable key, then send. A sent key does not call the transport.
 * A pending key whose lease is live does not call onAccepted. A throw before
 * acceptance releases the key. The transport's own key handling is not the
 * once-only guarantee.
 */
export async function sendWhatsAppOnce(
  transport: WhatsAppTransport,
  message: OutboundWhatsApp,
  options: WhatsAppSendOptions & { firmId: string; keys: OutboundKeyStore; leaseMs?: number }
): Promise<OnceSend> {
  const key = options.idempotencyKey
  if (key === undefined) return { status: "sent", result: await transport.send(message, options) }
  const now = options.now ?? Date.now()
  // A missing TTL does not expire. A finite horizon keeps the stored expiresAt a number.
  const ttlMs = options.idempotencyTtlMs ?? 100 * 365 * 24 * 60 * 60 * 1000
  const claim = await claimWhatsAppOutboundKey(options.keys, {
    firmId: options.firmId,
    idempotencyKey: key,
    now,
    ttlMs,
    leaseMs: options.leaseMs,
  })
  if (claim.status === "accepted") {
    options.onAccepted?.()
    return { status: "accepted", result: { delivered: false, transport: "stub" } }
  }
  if (claim.status === "inFlight") return { status: "inFlight", retryAfterMs: claim.retryAfterMs }
  let accepted = false
  let marked: Promise<void> = Promise.resolve()
  const owned = { firmId: options.firmId, idempotencyKey: key, createdAt: claim.createdAt }
  const releaseIfUnsent = () => {
    if (accepted) return Promise.resolve()
    return releaseWhatsAppOutboundKey(options.keys, owned)
  }
  // The webhook aborts at its deadline. A send that has not been accepted must
  // drop the pending row then, even if the transport promise is still hung.
  if (options.signal?.aborted) {
    await releaseIfUnsent()
    throw new Error("whatsapp_send_aborted")
  }
  options.signal?.addEventListener("abort", () => {
    void releaseIfUnsent()
  }, { once: true })
  try {
    const result = await transport.send(message, {
      ...options,
      onAccepted: () => {
        accepted = true
        options.onAccepted?.()
        marked = markWhatsAppOutboundKeySent(options.keys, owned)
      },
    })
    accepted = true
    await marked
    await markWhatsAppOutboundKeySent(options.keys, owned)
    return { status: "sent", result }
  } catch (err) {
    await marked
    await releaseIfUnsent()
    throw err
  }
}
