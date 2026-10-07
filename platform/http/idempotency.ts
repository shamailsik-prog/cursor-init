/**
 * Layer 18 §4.2 — every POST/PUT requires Idempotency-Key (UUID v4).
 *
 * One process-wide replay store shared by every Next route (final audit F4 + SEC-4), with the
 * semantics of the Cloud Functions store (functions/src/http/idempotency.ts):
 *
 * - The key is scoped `firm|user|METHOD path|Idempotency-Key`, so a key never replays across
 *   tenants, callers or routes.
 * - The request is identified by a fixed-size sha256 fingerprint (`fingerprintOf`); the store
 *   keeps only that hash and the serialised response, never the request payload.
 * - `beginIdempotentRequest` checks and reserves the key in one synchronous step (no await
 *   between them), so of two concurrent requests with the same key exactly one runs:
 *     same key, other fingerprint      -> 422 idempotency_key_reused
 *     same key, first still running    -> 409 idempotency_in_progress
 *     same key, first finished         -> the stored response, `reused: true`
 * - The route stores its success payload with `claim.complete(payload)`. withSession settles
 *   every claim at the end of the request: a claim that was not completed (a refusal, a
 *   validation error, a throw) is released so a retry runs again. A completed claim stays
 *   stored even when the end-of-request audit flush fails (final audit F6), so a same-key retry
 *   replays instead of re-running a committed effect.
 * - Bounded: an LRU of at most IDEMPOTENCY_MAX_ENTRIES keys and IDEMPOTENCY_MAX_BYTES of stored
 *   responses, each kept IDEMPOTENCY_TTL_MS (24 h). A response larger than
 *   IDEMPOTENCY_MAX_ENTRY_BYTES is not kept; its key still refuses to run again (409
 *   idempotency_replay_unavailable) until it expires or is evicted.
 *
 * Still process-local: lost on restart and not shared between instances. A durable store (the
 * functions `idempotency_keys` collection) is the follow-up once the Next API serves Firestore.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { NextResponse } from "next/server"
import { errorResponse } from "@/platform/http/errors"

export class IdempotencyError extends Error {
  status = 400
  constructor(message = "Idempotency-Key header required") {
    super(message)
    this.name = "IdempotencyError"
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key")
  if (!key) {
    throw new IdempotencyError()
  }
  if (!UUID_V4.test(key)) {
    throw new IdempotencyError("Idempotency-Key must be UUID v4")
  }
  return key
}

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
export const IDEMPOTENCY_MAX_ENTRIES = 10_000
export const IDEMPOTENCY_MAX_BYTES = 64 * 1024 * 1024
export const IDEMPOTENCY_MAX_ENTRY_BYTES = 4 * 1024 * 1024
/**
 * An in-progress claim outside a withSession request (nothing will settle it) may be taken over
 * after this long, like the functions lease. Inside a request the claim is settled at its end.
 */
export const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000

type Entry =
  | { state: "in_progress"; fingerprint: string; at: number; claimId: number }
  | { state: "done"; fingerprint: string; at: number; json: string | null; bytes: number }

export type IdempotencyLimits = {
  ttlMs: number
  maxEntries: number
  maxBytes: number
  maxEntryBytes: number
  leaseMs: number
}

type Begin =
  | { kind: "claimed"; claimId: number }
  | { kind: "replay"; body: unknown }
  | { kind: "reused" }
  | { kind: "in_progress" }
  | { kind: "unavailable" }

/** The bounded LRU behind every route. Exported for tests; routes use the module functions. */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>()
  private bytes = 0
  private nextClaimId = 1

  constructor(private readonly limits: IdempotencyLimits) {}

  get size(): number {
    return this.entries.size
  }

  get storedBytes(): number {
    return this.bytes
  }

  /** Check-and-reserve in one synchronous step. */
  begin(scopedKey: string, fingerprint: string, now: number = Date.now()): Begin {
    const hit = this.entries.get(scopedKey)
    if (hit && now - hit.at < this.limits.ttlMs) {
      if (hit.fingerprint !== fingerprint) return { kind: "reused" }
      if (hit.state === "done") {
        this.touch(scopedKey, hit)
        return hit.json === null ? { kind: "unavailable" } : { kind: "replay", body: JSON.parse(hit.json) }
      }
      if (now - hit.at <= this.limits.leaseMs) return { kind: "in_progress" }
      // A stale in-progress lease: take it over.
    }
    if (hit) this.remove(scopedKey, hit)
    const claimId = this.nextClaimId++
    this.entries.set(scopedKey, { state: "in_progress", fingerprint, at: now, claimId })
    this.evict(now)
    return { kind: "claimed", claimId }
  }

  /** Stores the response of the claim that holds the key (a no-op for a lost claim). */
  complete(scopedKey: string, claimId: number, body: unknown, now: number = Date.now()): void {
    const hit = this.entries.get(scopedKey)
    if (!hit || hit.state !== "in_progress" || hit.claimId !== claimId) return
    const json = JSON.stringify(body ?? null)
    // UTF-16 code units: the string's in-memory size.
    const bytes = json.length * 2
    const kept = bytes <= this.limits.maxEntryBytes ? json : null
    this.remove(scopedKey, hit)
    this.entries.set(scopedKey, {
      state: "done",
      fingerprint: hit.fingerprint,
      at: now,
      json: kept,
      bytes: kept === null ? 0 : bytes,
    })
    this.bytes += kept === null ? 0 : bytes
    this.evict(now)
  }

  /** Frees the key of a claim that did not complete, so a retry runs again. */
  release(scopedKey: string, claimId: number): void {
    const hit = this.entries.get(scopedKey)
    if (hit && hit.state === "in_progress" && hit.claimId === claimId) this.remove(scopedKey, hit)
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }

  private touch(scopedKey: string, entry: Entry): void {
    this.entries.delete(scopedKey)
    this.entries.set(scopedKey, entry)
  }

  private remove(scopedKey: string, entry: Entry): void {
    this.entries.delete(scopedKey)
    if (entry.state === "done") this.bytes -= entry.bytes
  }

  /**
   * Drops expired entries from the head, then least-recently-used ones until the store is within
   * its entry and byte bounds. An in-progress entry is skipped (dropping it would let a duplicate
   * run concurrently) unless it is past its lease.
   */
  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at < this.limits.ttlMs) break
      this.remove(key, entry)
    }
    if (this.entries.size <= this.limits.maxEntries && this.bytes <= this.limits.maxBytes) return
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.limits.maxEntries && this.bytes <= this.limits.maxBytes) return
      if (entry.state === "in_progress" && now - entry.at <= this.limits.leaseMs) continue
      this.remove(key, entry)
    }
  }
}

const store = new IdempotencyStore({
  ttlMs: IDEMPOTENCY_TTL_MS,
  maxEntries: IDEMPOTENCY_MAX_ENTRIES,
  maxBytes: IDEMPOTENCY_MAX_BYTES,
  maxEntryBytes: IDEMPOTENCY_MAX_ENTRY_BYTES,
  leaseMs: IDEMPOTENCY_LEASE_MS,
})

/** Test hook: the shared store (size and byte accounting). */
export function idempotencyStoreForTests(): IdempotencyStore {
  return store
}

/** Test hook: forget every key. */
export function resetIdempotencyForTests(): void {
  store.clear()
}

/** The caller a request's keys are scoped to; set by withSession for the whole request. */
export type IdempotencyScope = { firmId: string; userId: string }

type RequestClaims = { scope: IdempotencyScope; claims: IdempotencyClaim[] }

const requestClaims = new AsyncLocalStorage<RequestClaims>()

/** A reserved key. The route calls `complete(payload)` once its effect has succeeded. */
export class IdempotencyClaim {
  private completed = false

  constructor(
    private readonly scopedKey: string,
    private readonly claimId: number
  ) {}

  get isCompleted(): boolean {
    return this.completed
  }

  /** Stores `payload` as the replayed `result` for this key. */
  complete(payload: unknown): void {
    store.complete(this.scopedKey, this.claimId, payload)
    this.completed = true
  }

  /** Releases the key unless the claim completed (called by withSession at the end). */
  settle(): void {
    if (!this.completed) store.release(this.scopedKey, this.claimId)
  }
}

/**
 * Runs a request with its idempotency scope; every claim taken during it is settled when it ends
 * (after the audit flush), whatever the outcome. Used by withSession.
 */
export async function runWithIdempotencyScope<T>(scope: IdempotencyScope, run: () => Promise<T>): Promise<T> {
  const ctx: RequestClaims = { scope, claims: [] }
  try {
    return await requestClaims.run(ctx, run)
  } finally {
    for (const claim of ctx.claims) claim.settle()
  }
}

function routeOf(request: Request): string {
  try {
    return `${request.method.toUpperCase()} ${new URL(request.url).pathname}`
  } catch {
    return request.method.toUpperCase()
  }
}

export type IdempotentStart =
  | { claim: IdempotencyClaim; response?: undefined }
  | { claim?: undefined; response: Response }

/**
 * Reserves `key` for this request (synchronously: call it after the body is read and before any
 * other await). Returns the claim, or the response to send instead: the stored replay, 422
 * idempotency_key_reused, 409 idempotency_in_progress or 409 idempotency_replay_unavailable.
 */
export function beginIdempotentRequest(request: Request, key: string, fingerprint: string): IdempotentStart {
  const ctx = requestClaims.getStore()
  const scope = ctx?.scope ?? { firmId: "_", userId: "_" }
  const scopedKey = [scope.firmId, scope.userId, routeOf(request), key.toLowerCase()].join("|")
  const begun = store.begin(scopedKey, fingerprint)
  switch (begun.kind) {
    case "claimed": {
      const claim = new IdempotencyClaim(scopedKey, begun.claimId)
      ctx?.claims.push(claim)
      return { claim }
    }
    case "replay":
      return { response: NextResponse.json({ result: begun.body, idempotencyKey: key, reused: true }) }
    case "reused":
      return {
        response: errorResponse(
          422,
          "idempotency_key_reused",
          "Idempotency-Key reused with a different request payload"
        ),
      }
    case "in_progress":
      return {
        response: errorResponse(409, "idempotency_in_progress", "a request with this Idempotency-Key is in progress"),
      }
    case "unavailable":
      return {
        response: errorResponse(
          409,
          "idempotency_replay_unavailable",
          "this Idempotency-Key was already used; its response is not available for replay"
        ),
      }
  }
}
