/**
 * Layer 18 §4.2: every POST/PUT requires an Idempotency-Key (UUID v4).
 *
 * One replay store for every Next route (final audit F4 + SEC-4). Audit F10 makes it survive instances and restarts.
 *
 * - **Scope.** The key is scoped `firm|user|METHOD path|Idempotency-Key`, so a key never replays across tenants,
 *   callers or routes.
 * - **Fingerprint.** The request is identified by the route's fixed-size sha256 fingerprint (`fingerprintOf`). The store
 *   keeps only that hash and the completed answer, never the request payload.
 * - **Answers.** `await beginIdempotentRequest(...)` reserves the key or answers it:
 *     same key, other fingerprint      -> 422 idempotency_key_reused
 *     same key, first still running    -> 409 idempotency_in_progress
 *     same key, first finished         -> the stored response, `reused: true`
 *     same key, its effect committed but its answer was never stored -> 409 idempotency_effect_committed (+ operationId)
 * - **Completion.** The route stores its success payload with `claim.complete(payload)`. withSession settles every
 *   claim at the end of the request, after the audit flush (final audit F6: a completed claim stays stored even when the
 *   flush fails). A claim that did not complete is released so a retry runs again, unless its effect committed.
 *
 * Backends (audit F10), selected by SIKANDER_PERSISTENCE_MODE exactly as the repositories are (`resolvePersistenceMode`):
 *
 * - **`firestore`: the durable store** (platform/http/durableIdempotency.ts), in the repositories' own database.
 *   - It uses the F09 operation record (`idempotency_keys`) and effect marker (`idempotency_effects`), so a key
 *     completed on one instance replays on every other instance and after a restart.
 *   - While a request holds a durable claim, every Firestore write it makes through
 *     platform/persistence/firestoreDbModular.ts goes through the write fence. One transaction reads the claim, refuses
 *     an attempt whose claim was taken over (409 idempotency_claim_lost), and creates the operation's marker with the
 *     write.
 *   - A committed effect therefore never runs again for its key: a throw after it, a lost settle or a crash all leave
 *     the marker, and the key answers 409 idempotency_effect_committed.
 *   - A provider dispatch is marked first (`recordExternalEffect`).
 *   - There is no fallback to memory: an unreachable store answers 503 idempotency_store_unavailable, and a missing
 *     database is PersistenceConfigurationError (503 PERSISTENCE_NOT_CONFIGURED).
 * - **`memory`** (refused in production; the default only under the test runner): the in-process Map below.
 *   - It is bounded by IDEMPOTENCY_MAX_ENTRIES and IDEMPOTENCY_MAX_BYTES, each firm by a quarter of both (re-audit N-1).
 *   - It never evicts an unexpired operation (audit F10). Only expired entries are pruned. A new claim beyond an
 *     entry bound is refused (503 idempotency_capacity_exhausted).
 *   - A completed answer that does not fit the byte budget is kept without its body: its key replays as 409
 *     idempotency_replay_unavailable and never runs again within its TTL.
 *
 * Spec: docs/superpowers/specs/2026-10-16-f10-durable-next-idempotency-design.md.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { NextResponse } from "next/server"
import { errorResponse } from "@/platform/http/errors"
import {
  CLAIM_LOST,
  DURABLE_MAX_RESPONSE_BYTES,
  DurableIdempotencyStore,
  EFFECT_COMMITTED,
  durableIdempotencyTestSeam,
  type DurableClaimRef,
  type SettleOutcome,
} from "@/platform/http/durableIdempotency"
import {
  installWriteFence,
  outboxForExternalEffect,
  type OutboxStage,
  type WriteFence,
} from "@/platform/persistence/firestoreDbModular"
import { getRuntimeFirestore, resolvePersistenceMode } from "@/platform/persistence/runtimeRepositories"

export type { SettleOutcome } from "@/platform/http/durableIdempotency"

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
/** Re-audit N-1: one firm's share of the store, a quarter of each global bound. */
export const IDEMPOTENCY_FIRM_MAX_ENTRIES = IDEMPOTENCY_MAX_ENTRIES / 4
export const IDEMPOTENCY_FIRM_MAX_BYTES = IDEMPOTENCY_MAX_BYTES / 4
/**
 * An in-progress claim may be taken over by the same request after this long (a crashed or hung attempt), like the
 * functions lease. In the durable store a takeover never repeats a committed effect: the marker answers it.
 */
export const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000
export { DURABLE_MAX_RESPONSE_BYTES }

/** Test seam of the durable store (claim and settle failures, the clock, a stall before a fenced write). */
export const idempotencyTestSeam = durableIdempotencyTestSeam

type Entry =
  | { state: "in_progress"; firm: string; fingerprint: string; at: number; claimId: number }
  | { state: "done"; firm: string; fingerprint: string; at: number; json: string | null; bytes: number }

export type IdempotencyLimits = {
  ttlMs: number
  maxEntries: number
  maxBytes: number
  maxEntryBytes: number
  leaseMs: number
  /** Per-firm bounds (re-audit N-1); omitted means no per-firm quota. */
  firmMaxEntries?: number
  firmMaxBytes?: number
}

type Begin =
  | { kind: "claimed"; claimId: number }
  | { kind: "replay"; body: unknown }
  | { kind: "reused" }
  | { kind: "in_progress" }
  | { kind: "unavailable" }
  | { kind: "capacity" }

/**
 * The bounded in-process store of the memory mode. Exported for tests; routes use the module functions. It never
 * evicts an unexpired entry (audit F10): a new claim beyond an entry bound is refused (`capacity`), and a completed
 * answer beyond the byte budget is kept without its body (`unavailable` on replay).
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>()
  private bytes = 0
  private readonly firmUsage = new Map<string, { count: number; bytes: number }>()
  private nextClaimId = 1

  constructor(private readonly limits: IdempotencyLimits) {}

  get size(): number {
    return this.entries.size
  }

  get storedBytes(): number {
    return this.bytes
  }

  /** Check-and-reserve in one synchronous step. `firm` names the quota the key counts against. */
  begin(scopedKey: string, fingerprint: string, now: number = Date.now(), firm = ""): Begin {
    this.pruneExpiredHead(now)
    const hit = this.entries.get(scopedKey)
    if (hit && now - hit.at < this.limits.ttlMs) {
      if (hit.fingerprint !== fingerprint) return { kind: "reused" }
      if (hit.state === "done") {
        this.touch(scopedKey, hit)
        return hit.json === null ? { kind: "unavailable" } : { kind: "replay", body: JSON.parse(hit.json) }
      }
      if (now - hit.at <= this.limits.leaseMs) return { kind: "in_progress" }
      // A stale in-progress lease: the same request takes it over in place (no new entry).
      this.remove(scopedKey, hit)
      return this.claim(scopedKey, fingerprint, now, hit.firm)
    }
    if (hit) this.remove(scopedKey, hit)
    if (this.full(firm)) {
      this.pruneExpired(now)
      if (this.full(firm)) return { kind: "capacity" }
    }
    return this.claim(scopedKey, fingerprint, now, firm)
  }

  /** Stores the response of the claim that holds the key (a no-op for a lost claim). */
  complete(scopedKey: string, claimId: number, body: unknown, now: number = Date.now()): void {
    const hit = this.entries.get(scopedKey)
    if (!hit || hit.state !== "in_progress" || hit.claimId !== claimId) return
    this.pruneExpiredHead(now)
    // A claim older than the TTL was pruned with the rest: it has nothing left to complete.
    if (this.entries.get(scopedKey) !== hit) return
    const json = JSON.stringify(body ?? null)
    // UTF-16 code units: the string's in-memory size.
    const bytes = json.length * 2
    this.remove(scopedKey, hit)
    if (!this.fits(hit.firm, bytes)) this.pruneExpired(now)
    const kept = this.fits(hit.firm, bytes) ? json : null
    this.add(scopedKey, {
      state: "done",
      firm: hit.firm,
      fingerprint: hit.fingerprint,
      at: now,
      json: kept,
      bytes: kept === null ? 0 : bytes,
    })
  }

  /** Frees the key of a claim that did not complete, so a retry runs again. */
  release(scopedKey: string, claimId: number): void {
    const hit = this.entries.get(scopedKey)
    if (hit && hit.state === "in_progress" && hit.claimId === claimId) this.remove(scopedKey, hit)
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
    this.firmUsage.clear()
  }

  private claim(scopedKey: string, fingerprint: string, now: number, firm: string): Begin {
    const claimId = this.nextClaimId++
    this.add(scopedKey, { state: "in_progress", firm, fingerprint, at: now, claimId })
    return { kind: "claimed", claimId }
  }

  /** Whether one more entry would pass the global or `firm`'s entry bound. */
  private full(firm: string): boolean {
    if (this.entries.size >= this.limits.maxEntries) return true
    const max = this.limits.firmMaxEntries
    return max !== undefined && (this.firmUsage.get(firm)?.count ?? 0) >= max
  }

  /** Whether an answer of `bytes` fits the per-entry cap and the global and `firm`'s byte budgets. */
  private fits(firm: string, bytes: number): boolean {
    if (bytes > this.limits.maxEntryBytes || this.bytes + bytes > this.limits.maxBytes) return false
    const max = this.limits.firmMaxBytes
    return max === undefined || (this.firmUsage.get(firm)?.bytes ?? 0) + bytes <= max
  }

  private touch(scopedKey: string, entry: Entry): void {
    this.entries.delete(scopedKey)
    this.entries.set(scopedKey, entry)
  }

  private add(scopedKey: string, entry: Entry): void {
    this.entries.set(scopedKey, entry)
    const stored = entry.state === "done" ? entry.bytes : 0
    this.bytes += stored
    const usage = this.firmUsage.get(entry.firm) ?? { count: 0, bytes: 0 }
    usage.count += 1
    usage.bytes += stored
    this.firmUsage.set(entry.firm, usage)
  }

  private remove(scopedKey: string, entry: Entry): void {
    this.entries.delete(scopedKey)
    const stored = entry.state === "done" ? entry.bytes : 0
    this.bytes -= stored
    const usage = this.firmUsage.get(entry.firm)
    if (!usage) return
    usage.count -= 1
    usage.bytes -= stored
    if (usage.count <= 0) this.firmUsage.delete(entry.firm)
  }

  /** Drops expired entries from the head (the least recently used end), stopping at the first live one. */
  private pruneExpiredHead(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at < this.limits.ttlMs) break
      this.remove(key, entry)
    }
  }

  /** Drops every expired entry, wherever it sits. Run only when a bound is reached. */
  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.limits.ttlMs) this.remove(key, entry)
    }
  }
}

const store = new IdempotencyStore({
  ttlMs: IDEMPOTENCY_TTL_MS,
  maxEntries: IDEMPOTENCY_MAX_ENTRIES,
  maxBytes: IDEMPOTENCY_MAX_BYTES,
  maxEntryBytes: IDEMPOTENCY_MAX_ENTRY_BYTES,
  leaseMs: IDEMPOTENCY_LEASE_MS,
  firmMaxEntries: IDEMPOTENCY_FIRM_MAX_ENTRIES,
  firmMaxBytes: IDEMPOTENCY_FIRM_MAX_BYTES,
})

/** The durable store of each Firestore instance (one per database client). */
const durableStores = new WeakMap<object, DurableIdempotencyStore>()

async function durableStore(): Promise<DurableIdempotencyStore> {
  const db = (await getRuntimeFirestore()) as object
  let found = durableStores.get(db)
  if (!found) {
    found = new DurableIdempotencyStore(db as ConstructorParameters<typeof DurableIdempotencyStore>[0], {
      ttlMs: IDEMPOTENCY_TTL_MS,
      leaseMs: IDEMPOTENCY_LEASE_MS,
    })
    durableStores.set(db, found)
  }
  return found
}

/** Test hook: the memory-mode store (size and byte accounting). */
export function idempotencyStoreForTests(): IdempotencyStore {
  return store
}

/** Test hook: forget every key this process holds in memory (a restart). The durable store keeps its records. */
export function resetIdempotencyForTests(): void {
  store.clear()
}

/** The caller a request's keys are scoped to; set by withSession for the whole request. */
export type IdempotencyScope = { firmId: string; userId: string }

type RequestClaims = { scope: IdempotencyScope; claims: IdempotencyClaim[] }

const requestClaims = new AsyncLocalStorage<RequestClaims>()

/** Claims taken during the current request (empty outside `runWithIdempotencyScope`). */
export function currentIdempotencyClaims(): readonly IdempotencyClaim[] {
  return requestClaims.getStore()?.claims ?? []
}

/** A refusal the route answered itself (status and JSON body), kept when the attempt's effect committed. */
export type StorableRefusal = { status: number; json: string }

/** A durable claim's write fence; `markEffect` stages the request's audit-outbox entry with the marker (audit F11). */
type ClaimFence = WriteFence & { markEffect(kind: string, outbox?: OutboxStage | null): Promise<void> }

/** How a claim is held: in the memory Map, or in the durable store. */
type ClaimBackend = {
  complete(payload: unknown): void
  settle(completed: boolean, payload: unknown, refusal: StorableRefusal | undefined): Promise<SettleOutcome>
  fence(): ClaimFence | null
  operationId?: string
}

/** A reserved key. The route calls `complete(payload)` once its effect has succeeded. */
export class IdempotencyClaim {
  private completed = false
  private payload: unknown = undefined
  private settled = false
  /** Set when a fenced write of this attempt was refused (its claim was taken over, or the operation already acted). */
  fenceRefusal: typeof CLAIM_LOST | typeof EFFECT_COMMITTED | undefined

  constructor(private readonly backend: ClaimBackend) {}

  get isCompleted(): boolean {
    return this.completed
  }

  /** The operation this claim belongs to (durable store only). */
  get operationId(): string | undefined {
    return this.backend.operationId
  }

  /** Stores `payload` as the replayed `result` for this key. */
  complete(payload: unknown): void {
    if (this.completed) return
    this.completed = true
    this.payload = payload
    this.backend.complete(payload)
  }

  /** The claim's write fence while it is open (durable store only). */
  fence(): ClaimFence | null {
    return this.settled ? null : this.backend.fence()
  }

  /**
   * Ends the claim (called by withSession at the end): stores, releases or answers it (spec §2.4). `refusal` is the
   * route's own storable refusal, kept as the key's answer if the attempt's effect committed.
   */
  async settle(refusal?: StorableRefusal): Promise<SettleOutcome> {
    if (this.settled) return "lost"
    this.settled = true
    return this.backend.settle(this.completed, this.payload, refusal)
  }
}

/**
 * A refusal the route decided: any 4xx but 429 (a rate limit is not an answer to the request). The request was refused
 * for its own reasons (validation, permission, a cross-firm denial, a business conflict) after writes of its own, such
 * as a recomputed digest; that refusal is the key's answer.
 */
const isDecidedRefusalStatus = (status: number) => status >= 400 && status < 500 && status !== 429
/** Codes that mean the request failed (the routes' catch-alls) or are idempotency answers, never a stored refusal. */
const FAILURE_CODES = new Set(["REQUEST_FAILED", "INTERNAL_ERROR"])

/** The route's answer as a storable refusal, or undefined (a success, a failure, or a body that is not JSON). */
async function storableRefusalOf(response: Response): Promise<StorableRefusal | undefined> {
  if (!isDecidedRefusalStatus(response.status)) return undefined
  try {
    const body = (await response.clone().json()) as unknown
    const code = (body as { code?: unknown } | null)?.code
    if (typeof code === "string" && (FAILURE_CODES.has(code) || code.startsWith("idempotency_"))) return undefined
    const json = JSON.stringify(body)
    return Buffer.byteLength(json, "utf8") <= DURABLE_MAX_RESPONSE_BYTES ? { status: response.status, json } : undefined
  } catch {
    return undefined
  }
}

/**
 * Re-audit MEDIUM-1 (spec ruling 15): the signal that a key's effect committed. Every answer for such a key other than
 * its completed 2xx replay carries it: the original request's own 4xx, every replay of a stored refusal, and the
 * terminal 409. It appears both as this response header (its value is the operationId) and as the body field
 * `effectCommitted: { operationId }`. A caller told "failed" must never be left to resubmit an effect that landed under
 * a new key.
 */
export const EFFECT_COMMITTED_HEADER = "Idempotency-Effect-Committed"

function effectCommittedResponse(operationId: string | undefined): NextResponse {
  return NextResponse.json(
    {
      error: "this Idempotency-Key's operation already committed its effect; its response is not available",
      code: EFFECT_COMMITTED,
      ...(operationId === undefined ? {} : { operationId, effectCommitted: { operationId } }),
    },
    { status: 409, ...(operationId === undefined ? {} : { headers: { [EFFECT_COMMITTED_HEADER]: operationId } }) }
  )
}

/** `response` with the effect-committed signal added: the same status, headers and body, plus the header and field. */
async function signalEffectCommitted(response: Response, operationId: string): Promise<Response> {
  const headers = new Headers(response.headers)
  headers.set(EFFECT_COMMITTED_HEADER, operationId)
  headers.delete("content-length")
  const text = await response.clone().text()
  let body = text
  try {
    const json = JSON.parse(text) as unknown
    if (json !== null && typeof json === "object" && !Array.isArray(json)) body = JSON.stringify({ ...json, effectCommitted: { operationId } })
  } catch {
    // Not a JSON object: the header alone carries the signal.
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}

function claimLostResponse(): NextResponse {
  return errorResponse(409, CLAIM_LOST, "a later attempt took over this request's Idempotency-Key")
}

/**
 * Runs a request with its idempotency scope; every claim taken during it is settled when it ends (after the audit
 * flush), whatever the outcome. Used by withSession.
 *
 * When the request did not complete but its operation's effect committed, the key is never run again (spec ruling 9):
 * - **Later same-key requests.** A refusal the route decided (a 4xx other than 429, without a catch-all code) is kept
 *   as the key's answer and replayed as itself. Anything else gets 409 idempotency_effect_committed. That includes a
 *   catch-all 400 REQUEST_FAILED, which the routes use both for a public refusal and for a masked failure.
 * - **This request.** A 4xx answer keeps its status and body. A 5xx or a throw is replaced by 409
 *   idempotency_effect_committed.
 * - **The signal (ruling 15).** Every one of those answers, here and on every retry, carries the effect-committed
 *   signal (EFFECT_COMMITTED_HEADER and `effectCommitted`).
 * - **A refused fenced write.** The attempt's claim was taken over, so any non-2xx answer becomes 409
 *   idempotency_claim_lost.
 */
export async function runWithIdempotencyScope<T>(scope: IdempotencyScope, run: () => Promise<T>): Promise<T> {
  const ctx: RequestClaims = { scope, claims: [] }
  let result: T | undefined
  let failure: { error: unknown } | undefined
  try {
    result = await requestClaims.run(ctx, run)
  } catch (error) {
    failure = { error }
  }
  const answered2xx = failure === undefined && result instanceof Response && result.status >= 200 && result.status < 300
  const failed = failure !== undefined || (result instanceof Response && result.status >= 500)
  const refusal = failure === undefined && result instanceof Response && !answered2xx ? await storableRefusalOf(result) : undefined
  let override: Response | undefined
  let committed: string | undefined
  for (const claim of ctx.claims) {
    let outcome: SettleOutcome
    try {
      outcome = await claim.settle(claim.fenceRefusal === undefined ? refusal : undefined)
    } catch (err) {
      console.error("[idempotency] settle failed", err)
      outcome = "failed"
    }
    if (answered2xx) continue
    const effectCommitted = outcome === "terminal" || outcome === "refused" || claim.fenceRefusal === EFFECT_COMMITTED
    if (claim.fenceRefusal === CLAIM_LOST) override = claimLostResponse()
    else if (failed && effectCommitted) override = effectCommittedResponse(claim.operationId)
    else if (effectCommitted && claim.operationId !== undefined) committed = claim.operationId
  }
  if (override !== undefined && (failure !== undefined || result instanceof Response)) return override as T
  if (failure !== undefined) throw failure.error
  if (committed !== undefined && result instanceof Response) return (await signalEffectCommitted(result, committed)) as T
  return result as T
}

/** The current request's open claim with a write fence (durable store), or null. */
function currentFence(): ClaimFence | null {
  const ctx = requestClaims.getStore()
  if (!ctx) return null
  for (let i = ctx.claims.length - 1; i >= 0; i--) {
    const fence = ctx.claims[i]!.fence()
    if (fence) return fence
  }
  return null
}

installWriteFence(currentFence)

/**
 * Marks an effect that is not a Firestore write (a provider dispatch) before it happens, through the request's write
 * fence: an attempt whose claim was taken over is refused, and the operation's marker is created, so a retry of the key
 * never repeats the effect. A no-op outside a durable claim.
 *
 * Audit F11: the request's audit-outbox entry (`external:<kind>`, with the rows staged so far) commits in the marker's
 * transaction, so a dispatch that is followed by a crash still leaves its audit for the reconciler.
 */
export async function recordExternalEffect(kind: string): Promise<void> {
  const fence = currentFence()
  if (fence === null) return
  await fence.markEffect(kind, outboxForExternalEffect(kind, fence.operationId))
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

function reusedResponse(): NextResponse {
  return errorResponse(422, "idempotency_key_reused", "Idempotency-Key reused with a different request payload")
}

function inProgressResponse(): NextResponse {
  return errorResponse(409, "idempotency_in_progress", "a request with this Idempotency-Key is in progress")
}

function unavailableResponse(): NextResponse {
  return errorResponse(
    409,
    "idempotency_replay_unavailable",
    "this Idempotency-Key was already used; its response is not available for replay"
  )
}

function replayResponse(body: unknown, key: string): NextResponse {
  return NextResponse.json({ result: body, idempotencyKey: key, reused: true })
}

/**
 * Reserves `key` for this request, or returns the response to send instead: the stored replay, 422
 * idempotency_key_reused, 409 idempotency_in_progress, 409 idempotency_replay_unavailable, 409
 * idempotency_effect_committed, 503 idempotency_capacity_exhausted (memory) or 503 idempotency_store_unavailable
 * (durable). Throws PersistenceConfigurationError when the persistence mode is refused or has no database.
 */
export async function beginIdempotentRequest(request: Request, key: string, fingerprint: string): Promise<IdempotentStart> {
  const ctx = requestClaims.getStore()
  const scope = ctx?.scope ?? { firmId: "_", userId: "_" }
  const route = routeOf(request)
  if (resolvePersistenceMode() === "memory") {
    // Check-and-reserve in one synchronous step: no await between the mode check and the reserve.
    const scopedKey = [scope.firmId, scope.userId, route, key.toLowerCase()].join("|")
    const begun = store.begin(scopedKey, fingerprint, Date.now(), scope.firmId)
    switch (begun.kind) {
      case "claimed": {
        const claimId = begun.claimId
        const claim = new IdempotencyClaim({
          complete: (payload) => store.complete(scopedKey, claimId, payload),
          settle: async (completed) => {
            if (completed) return "stored"
            store.release(scopedKey, claimId)
            return "released"
          },
          fence: () => null,
        })
        ctx?.claims.push(claim)
        return { claim }
      }
      case "replay":
        return { response: replayResponse(begun.body, key) }
      case "reused":
        return { response: reusedResponse() }
      case "in_progress":
        return { response: inProgressResponse() }
      case "unavailable":
        return { response: unavailableResponse() }
      case "capacity":
        return { response: errorResponse(503, "idempotency_capacity_exhausted", "the idempotency store is full; retry later") }
    }
  }

  const durable = await durableStore()
  let begun: Awaited<ReturnType<DurableIdempotencyStore["begin"]>>
  try {
    begun = await durable.begin({ firmId: scope.firmId, userId: scope.userId, route, key, requestHash: fingerprint })
  } catch (err) {
    console.error("[idempotency] durable store unavailable at claim", err)
    return { response: errorResponse(503, "idempotency_store_unavailable", "idempotency store unavailable") }
  }
  switch (begun.kind) {
    case "claimed": {
      const ref: DurableClaimRef = begun.claim
      // The fence tells the claim when one of its writes is refused; the claim exists before its first write.
      const holder: { claim?: IdempotencyClaim } = {}
      const fence = durable.fence(ref, (code) => {
        if (holder.claim) holder.claim.fenceRefusal = code
      })
      const claim = new IdempotencyClaim({
        complete: () => undefined,
        settle: (completed, payload, refusal) => {
          if (!completed) return durable.settle(ref, { completed: false, ...(refusal === undefined ? {} : { refusal }) })
          const json = JSON.stringify(payload ?? null)
          const kept = Buffer.byteLength(json, "utf8") <= DURABLE_MAX_RESPONSE_BYTES ? json : null
          return durable.settle(ref, { completed: true, json: kept })
        },
        fence: () => fence,
        operationId: ref.operationId,
      })
      holder.claim = claim
      ctx?.claims.push(claim)
      return { claim }
    }
    case "replay":
      return { response: replayResponse(begun.body, key) }
    case "reused":
      return { response: reusedResponse() }
    case "in_progress":
      return { response: inProgressResponse() }
    case "unavailable":
      return { response: unavailableResponse() }
    case "terminal":
      return { response: effectCommittedResponse(begun.operationId) }
    case "refusal": {
      // A refusal is stored only after an effect committed: its replay carries the signal too (ruling 15).
      const body = begun.body !== null && typeof begun.body === "object" && !Array.isArray(begun.body) ? begun.body : { result: begun.body }
      return {
        response: NextResponse.json(
          { ...body, reused: true, effectCommitted: { operationId: begun.operationId } },
          { status: begun.status, headers: { [EFFECT_COMMITTED_HEADER]: begun.operationId } }
        ),
      }
    }
  }
}
