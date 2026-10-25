/**
 * Audit F10: the durable Next.js idempotency store, used when SIKANDER_PERSISTENCE_MODE=firestore. It keeps the F09
 * operation model (functions/src/http/idempotency.ts) in the same collections:
 *
 * - `idempotency_keys/{id}`: the operation record. Its binding is `firmId`, `uid`, `route` and `requestHash`. It also
 *   holds `operationId` (kept across takeovers), the current attempt (`claimId`, `claims`, `claimedAt`, a 5-minute
 *   lease), `status` (`in_progress` / `done`), the stored `response`, the `released` tombstone, and the 24 h window
 *   (`createdAt`, `expiresAt`).
 * - `idempotency_effects/{id}`: the effect marker. The write fence (`fence`) creates it in the same transaction as the
 *   operation's first effect write, so it exists exactly when an effect committed. An unexpired marker is the key's
 *   committed effect: a lapsed or orphaned attempt is never run again; the key answers 409 idempotency_effect_committed.
 *
 * What differs from F09, and why (spec §2.2):
 * - The document id is `n_` + sha256(firm|user|METHOD path|key). Next scopes a key to the firm, caller and route.
 * - `requestHash` is the route's own fingerprint.
 * - The completed answer is stored as JSON text, at most DURABLE_MAX_RESPONSE_BYTES.
 * - Times are written as JS Dates (Firestore timestamps on every SDK) and read through `toMillis`.
 *
 * Spec: docs/superpowers/specs/2026-10-16-f10-durable-next-idempotency-design.md.
 */
import { createHash, randomUUID } from "node:crypto"
import { AUDIT_OUTBOX_COLLECTION } from "@/platform/persistence/auditOutboxContract"
import { matterIdsToCheck, recordedMatterFields } from "@/platform/retention/operationMatters"
import { MATTER_TOMBSTONES, isTombstoneFor } from "@/platform/retention/tombstone"
import type { FenceTransaction, OutboxStage, WriteFence } from "@/platform/persistence/firestoreDbModular"

export const KEYS_COLLECTION = "idempotency_keys"
export const EFFECTS_COLLECTION = "idempotency_effects"
/** A Firestore document holds at most 1 MiB; a larger completed answer is kept as `omitted` (replay unavailable). */
export const DURABLE_MAX_RESPONSE_BYTES = 900_000
/**
 * Collections the fence does not cover: audit rows record a decision (a refusal writes them too), not an effect. The F11
 * audit outbox is the audit of an effect, staged inside that effect's own transaction and released after the flush.
 */
export const UNFENCED_COLLECTIONS: readonly string[] = [
  "audit_log",
  "audit_dead_letter",
  AUDIT_OUTBOX_COLLECTION,
  KEYS_COLLECTION,
  EFFECTS_COLLECTION,
]
/** Settle retries after the first attempt, waiting 100, 200 then 400 ms (as F09). */
const SETTLE_RETRIES = 3

export const EFFECT_COMMITTED = "idempotency_effect_committed"
export const CLAIM_LOST = "idempotency_claim_lost"

/**
 * Test seam only; production code never sets it, and it is inert when NODE_ENV is "production".
 * - `claimFailures` and `settleFailures` are queues: each claim or settle attempt takes the next error and throws it.
 * - `now` replaces the clock.
 * - `beforeFencedWrite` runs before each fenced transaction (a test holds it to stall an attempt before its effect).
 */
export const durableIdempotencyTestSeam: {
  claimFailures?: Error[]
  settleFailures?: Error[]
  now?: () => number
  beforeFencedWrite?: (docId: string) => Promise<void>
} = {}

function seam(): typeof durableIdempotencyTestSeam {
  return process.env.NODE_ENV === "production" ? {} : durableIdempotencyTestSeam
}

/** A fenced write refused: this attempt lost its claim, or another attempt of the operation committed an effect. */
export class IdempotencyFenceError extends Error {
  constructor(readonly code: typeof CLAIM_LOST | typeof EFFECT_COMMITTED) {
    super(code === CLAIM_LOST ? "idempotency claim lost to a later attempt" : "the operation already committed its effect")
    this.name = "IdempotencyFenceError"
  }
}

export function durableDocId(firmId: string, userId: string, route: string, key: string): string {
  return "n_" + createHash("sha256").update([firmId, userId, route, key.toLowerCase()].join("|")).digest("hex")
}

export type DurableScope = { firmId: string; userId: string; route: string; key: string; requestHash: string }

export type DurableClaimRef = {
  docId: string
  claimId: string
  operationId: string
  expiresAtMs: number
  scope: DurableScope
}

export type DurableBegin =
  | { kind: "claimed"; claim: DurableClaimRef }
  | { kind: "replay"; body: unknown }
  | { kind: "refusal"; status: number; body: unknown; operationId: string }
  | { kind: "unavailable" }
  | { kind: "terminal"; operationId: string }
  | { kind: "reused" }
  | { kind: "in_progress" }
  | { kind: "matter_deleted" }

/** How an attempt ended: completed with its payload, or not (with the refusal the route answered, when it is storable). */
export type SettleInput =
  | { completed: true; json: string | null; matters?: readonly string[] }
  | { completed: false; refusal?: { status: number; json: string }; matters?: readonly string[] }

/** The parsed body of a stored JSON answer, for its matter ids (null when it is not JSON). */
function bodyOf(json: string | null | undefined): unknown {
  if (typeof json !== "string") return null
  try {
    return JSON.parse(json) as unknown
  } catch {
    return null
  }
}

/**
 * How a settle ended: the completed answer `stored`; the route's refusal kept after an effect (`refused`); the terminal
 * 409 kept after an effect (`terminal`); the key `released` (no effect); the claim `lost` to another attempt; or `failed`.
 */
export type SettleOutcome = "stored" | "refused" | "terminal" | "released" | "lost" | "failed"

type Snap = { exists: boolean; data(): Record<string, unknown> | undefined }
type DocRef = { path: string }
type Db = {
  collection(path: string): { doc(id: string): DocRef }
  runTransaction<T>(fn: (tx: FenceTransaction) => Promise<T>): Promise<T>
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== ""

/** Milliseconds of a stored time (an SDK Timestamp, a Date or a number); NaN when unreadable. */
function millisOf(v: unknown): number {
  if (typeof v === "number") return v
  if (v instanceof Date) return v.getTime()
  if (v !== null && typeof v === "object" && typeof (v as { toMillis?: unknown }).toMillis === "function") {
    return (v as { toMillis(): number }).toMillis()
  }
  return Number.NaN
}

/** An unexpired marker is the operation's committed effect; one with no readable expiry counts too (fail closed). */
function markerCounts(marker: Snap, nowMs: number): boolean {
  if (!marker.exists) return false
  const at = millisOf(marker.data()?.expiresAt)
  return Number.isNaN(at) || at >= nowMs
}

/** F09 ruling 17: an orphan marker answers only the request that made it (the same user, route and fingerprint). */
function markerBoundTo(marker: Record<string, unknown>, scope: DurableScope): boolean {
  return nonEmpty(marker.uid) && marker.uid === scope.userId && nonEmpty(marker.route) && marker.route === scope.route && nonEmpty(marker.requestHash) && marker.requestHash === scope.requestHash
}

function terminalResponse(operationId: string): Record<string, unknown> {
  return { status: 409, code: EFFECT_COMMITTED, operationId }
}

/** The answer a stored `response` gives a later same-key request. */
function answerOf(response: unknown): DurableBegin {
  const r = response as { status?: unknown; json?: unknown; omitted?: unknown; code?: unknown; operationId?: unknown } | undefined
  if (r?.status === 200 && r.omitted === true) return { kind: "unavailable" }
  if (r?.status === 200 && typeof r.json === "string") return { kind: "replay", body: JSON.parse(r.json) as unknown }
  if (r?.status === 409 && r.code === EFFECT_COMMITTED && nonEmpty(r.operationId)) return { kind: "terminal", operationId: r.operationId }
  if (typeof r?.status === "number" && r.status >= 400 && r.status < 500 && typeof r.json === "string" && nonEmpty(r.operationId)) {
    return { kind: "refusal", status: r.status, body: JSON.parse(r.json) as unknown, operationId: r.operationId }
  }
  return { kind: "in_progress" }
}

function withoutReleased(record: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...record }
  delete rest.released
  return rest
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class DurableIdempotencyStore {
  constructor(
    private readonly db: Db,
    private readonly limits: { ttlMs: number; leaseMs: number }
  ) {}

  private now(): number {
    return seam().now?.() ?? Date.now()
  }

  private refs(docId: string): { record: DocRef; marker: DocRef } {
    return { record: this.db.collection(KEYS_COLLECTION).doc(docId), marker: this.db.collection(EFFECTS_COLLECTION).doc(docId) }
  }

  /** Claims the key, or answers it (spec §2.4 step 1). Throws when the store cannot be reached (the caller answers 503). */
  async begin(scope: DurableScope): Promise<DurableBegin> {
    const failure = seam().claimFailures?.shift()
    if (failure) throw failure
    const now = this.now()
    const nowDate = new Date(now)
    const docId = durableDocId(scope.firmId, scope.userId, scope.route, scope.key)
    const refs = this.refs(docId)
    const claimId = randomUUID()
    return this.db.runTransaction(async (tx): Promise<DurableBegin> => {
      const recordSnap = (await tx.get(refs.record)) as Snap
      const markerSnap = (await tx.get(refs.marker)) as Snap
      const record = recordSnap.exists ? recordSnap.data() : undefined
      const live = record !== undefined && millisOf(record.expiresAt) >= now
      const claimed = (operationId: string, expiresAtMs: number): DurableBegin => ({
        kind: "claimed",
        claim: { docId, claimId, operationId, expiresAtMs, scope },
      })
      if (record && live) {
        if (record.uid !== scope.userId || record.route !== scope.route || record.requestHash !== scope.requestHash) return { kind: "reused" }
        if (record.status === "done") {
          const answer = answerOf(record.response)
          if (answer.kind !== "replay" && answer.kind !== "refusal") return answer
          // Audit F42 (FA-F42-R1-001, spec R21): a stored answer of a matter deleted since is refused, as a fresh call is;
          // one whose matter list was cut short is never replayed (fail closed).
          const { ids, truncated } = matterIdsToCheck(record, answer.body)
          if (truncated) return { kind: "unavailable" }
          for (const id of ids) {
            const tomb = (await tx.get(this.db.collection(MATTER_TOMBSTONES).doc(id))) as Snap
            if (tomb.exists && isTombstoneFor(tomb.data(), scope.firmId, id)) return { kind: "matter_deleted" }
          }
          return answer
        }
        if (record.status !== "in_progress") return { kind: "in_progress" }
        if (record.released !== true && now - millisOf(record.claimedAt) <= this.limits.leaseMs) return { kind: "in_progress" }
        // A lapsed lease, or a taken-over attempt that ended without an effect (`released`): take the claim over,
        // keeping the operation and its window. An unexpired marker is the operation's committed effect: answer it.
        const counts = markerCounts(markerSnap, now)
        if (markerSnap.exists && !counts) tx.delete(refs.marker)
        const markerOp = counts ? markerSnap.data()?.operationId : undefined
        const operationId = nonEmpty(markerOp) ? markerOp : nonEmpty(record.operationId) ? record.operationId : randomUUID()
        const claims = (typeof record.claims === "number" && Number.isSafeInteger(record.claims) ? record.claims : 1) + 1
        const next = { ...withoutReleased(record), operationId, claimId, claimedAt: nowDate, claims }
        if (counts) {
          tx.set(refs.record, { ...next, status: "done", response: terminalResponse(operationId), answeredAt: nowDate })
          return { kind: "terminal", operationId }
        }
        tx.set(refs.record, next)
        return claimed(operationId, millisOf(record.expiresAt))
      }
      const binding = { firmId: scope.firmId, uid: scope.userId, route: scope.route, requestHash: scope.requestHash, surface: "next" }
      if (markerCounts(markerSnap, now)) {
        // No live record, but an unexpired marker: the operation committed its effect and its record is gone. Only the
        // request that made the marker may adopt it (F09 ruling 17); it is answered the terminal 409, never re-run.
        const marker = markerSnap.data() ?? {}
        if (!markerBoundTo(marker, scope)) return { kind: "reused" }
        const operationId = nonEmpty(marker.operationId) ? marker.operationId : randomUUID()
        const expiresAt = Number.isNaN(millisOf(marker.expiresAt)) ? new Date(now + this.limits.ttlMs) : marker.expiresAt
        tx.set(refs.record, {
          ...binding,
          operationId,
          claimId,
          claims: 1,
          claimedAt: nowDate,
          createdAt: nowDate,
          expiresAt,
          status: "done",
          response: terminalResponse(operationId),
          answeredAt: nowDate,
        })
        return { kind: "terminal", operationId }
      }
      // A fresh operation. A marker left by an expired one is deleted with it, so it never fences this one.
      if (markerSnap.exists) tx.delete(refs.marker)
      const operationId = randomUUID()
      const expiresAtMs = now + this.limits.ttlMs
      tx.set(refs.record, {
        ...binding,
        operationId,
        claimId,
        claims: 1,
        claimedAt: nowDate,
        createdAt: nowDate,
        expiresAt: new Date(expiresAtMs),
        status: "in_progress",
      })
      return claimed(operationId, expiresAtMs)
    })
  }

  /**
   * Settles the attempt once the request ended (spec §2.4 step 3).
   * - Completed: stores the completed answer.
   * - Not completed, and the operation's marker exists (an effect committed): stores the route's own refusal when it
   *   is a storable one (F09's storable results), else the terminal 409.
   * - Not completed, no marker: releases the key. A first claim is deleted; a taken-over one stays as the `released`
   *   tombstone.
   * Retried 3 times; a settle that cannot be written is logged and left to the lease and the marker.
   */
  async settle(claim: DurableClaimRef, outcome: SettleInput): Promise<SettleOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        const failure = seam().settleFailures?.shift()
        if (failure) throw failure
        return await this.settleOnce(claim, outcome)
      } catch (err) {
        if (attempt >= SETTLE_RETRIES) {
          console.error(`[idempotency] could not settle operation ${claim.operationId}; the lease and its effect marker decide the key`, err)
          return "failed"
        }
        await sleep(100 * 2 ** attempt)
      }
    }
  }

  private async settleOnce(claim: DurableClaimRef, outcome: SettleInput): Promise<SettleOutcome> {
    const refs = this.refs(claim.docId)
    const nowDate = new Date(this.now())
    return this.db.runTransaction(async (tx): Promise<SettleOutcome> => {
      const recordSnap = (await tx.get(refs.record)) as Snap
      const markerSnap = (await tx.get(refs.marker)) as Snap
      const record = recordSnap.exists ? recordSnap.data() : undefined
      if (!record || record.claimId !== claim.claimId || record.status !== "in_progress") return "lost"
      if (outcome.completed) {
        const response = outcome.json === null ? { status: 200, omitted: true } : { status: 200, json: outcome.json }
        tx.set(refs.record, { ...withoutReleased(record), status: "done", response, ...recordedMatterFields(outcome.matters ?? [], bodyOf(outcome.json)), answeredAt: nowDate })
        return "stored"
      }
      if (markerCounts(markerSnap, nowDate.getTime())) {
        const markerOp = markerSnap.data()?.operationId
        const operationId = nonEmpty(markerOp) ? markerOp : claim.operationId
        if (outcome.refusal !== undefined) {
          // The route refused after a write of its own (for example a recomputed digest): its refusal is the answer,
          // kept with the operation it belongs to, so every replay can say the effect committed (spec ruling 15).
          const response = { status: outcome.refusal.status, json: outcome.refusal.json, operationId }
          tx.set(refs.record, { ...withoutReleased(record), status: "done", response, ...recordedMatterFields(outcome.matters ?? [], bodyOf(outcome.refusal.json)), answeredAt: nowDate })
          return "refused"
        }
        tx.set(refs.record, { ...withoutReleased(record), status: "done", response: terminalResponse(operationId), answeredAt: nowDate })
        return "terminal"
      }
      const claims = typeof record.claims === "number" ? record.claims : 1
      if (claims > 1) tx.set(refs.record, { ...record, released: true })
      else tx.delete(refs.record)
      return "released"
    })
  }

  /**
   * The write fence of `claim` (spec §2.3). `onRefusal` is told when a fenced write is refused, so the request can be
   * answered 409 with that code.
   */
  fence(
    claim: DurableClaimRef,
    onRefusal: (code: IdempotencyFenceError["code"]) => void
  ): WriteFence & { markEffect(kind: string, outbox?: OutboxStage | null): Promise<void> } {
    const covers = (path: string) => !UNFENCED_COLLECTIONS.includes(path.split("/")[0] ?? "")
    const transact = async <T>(db: unknown, stage: (tx: FenceTransaction, note: (path: string) => void) => Promise<T>, kind = "transaction", forced = false): Promise<T> => {
      await seam().beforeFencedWrite?.(claim.docId)
      const d = db as Db
      const record = d.collection(KEYS_COLLECTION).doc(claim.docId)
      const marker = d.collection(EFFECTS_COLLECTION).doc(claim.docId)
      try {
        return await d.runTransaction(async (tx) => {
          // A transaction's reads precede its writes: the fence reads first, then the write is staged.
          const recordSnap = (await tx.get(record)) as Snap
          const markerSnap = (await tx.get(marker)) as Snap
          let effect = forced
          const out = await stage(tx, (path) => {
            if (covers(path)) effect = true
          })
          if (effect) {
            const r = recordSnap.exists ? recordSnap.data() : undefined
            if (!r || r.claimId !== claim.claimId || r.status !== "in_progress") throw new IdempotencyFenceError(CLAIM_LOST)
            if (markerSnap.exists) {
              if (markerSnap.data()?.claimId !== claim.claimId) throw new IdempotencyFenceError(EFFECT_COMMITTED)
            } else {
              tx.set(marker, {
                operationId: claim.operationId,
                claimId: claim.claimId,
                firmId: claim.scope.firmId,
                uid: claim.scope.userId,
                route: claim.scope.route,
                requestHash: claim.scope.requestHash,
                kind,
                surface: "next",
                expiresAt: new Date(claim.expiresAtMs),
                createdAt: new Date(this.now()),
              })
            }
          }
          return out
        })
      } catch (err) {
        if (err instanceof IdempotencyFenceError) onRefusal(err.code)
        throw err
      }
    }
    return {
      covers,
      operationId: claim.operationId,
      transact: (db, stage) => transact(db, stage),
      // Audit F11: the outbox entry of an external effect commits with its marker, before the effect happens.
      markEffect: async (kind, outbox) => {
        await transact(this.db, async (tx) => outbox?.stage(tx, this.db), kind, true)
        outbox?.committed()
      },
    }
  }
}
