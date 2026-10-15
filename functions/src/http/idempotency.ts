import { createHash, randomUUID } from "node:crypto"
import { Timestamp, type DocumentReference } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { FUNCTION_TIMEOUT_SECONDS } from "../health"
import { logFailure } from "../log"
import { HttpError } from "./errors"

/**
 * Idempotency-Key handling for POST/PUT (L18 §4.2). A key is claimed in
 * `idempotency_keys/{firmId}_{key}` = { firmId, uid, route, requestHash,
 * status: "in_progress" | "done", claimId, claimedAt, response?: { status, body },
 * createdAt, expiresAt (+24 h) } with one transaction. An `in_progress` claim
 * is a lease: once its `claimedAt` is more than IDEMPOTENCY_LEASE_MS old (the
 * request died, or its result could not be stored) the same request may take
 * it over. The old holder can no longer complete or release it (claimId check). The collection is
 * server-only (no rules match); a Firestore TTL policy on `expiresAt` purges
 * old keys, and until it runs an expired key is treated as absent.
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
/** How long an in_progress claim holds its key before the same request may take it over. */
export const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000

// A live request must never be taken over: the lease has to outlive the function timeout.
if (!(IDEMPOTENCY_LEASE_MS > FUNCTION_TIMEOUT_SECONDS * 1000)) {
  throw new Error(`idempotency lease (${IDEMPOTENCY_LEASE_MS} ms) must exceed the function timeout (${FUNCTION_TIMEOUT_SECONDS} s)`)
}

/**
 * 409 codes that are business conflicts: the request is refused by the
 * state it names and a same-key retry should get the same answer. Other 409s
 * are contention (claims_sync_failed, idempotency_in_progress) or
 * configuration (bootstrap_not_configured) and are released. New 409 codes are
 * released until they are added here.
 */
const STORED_409_CODES: ReadonlySet<string> = new Set([
  "already_exists",
  "already_onboarded",
  "last_partner",
  "code_used",
  // approveDraft (D4, P4-8): the refusal commits the fresh gate result first (R1), so a same-key retry must replay it,
  // not run again against a result whose resultId the first run replaced (PR #25 review).
  "gate_blocked",
])

/**
 * Which results are stored and replayed for their key (an explicit allowlist):
 * 2xx; the deterministic client errors 400, 404 and 422; and 409 business
 * conflicts (STORED_409_CODES). Everything else releases the claim so a
 * same-key retry runs again: 401/403 (session-dependent: a refreshed token or
 * a step-up may succeed), 409 contention codes, 429 and 5xx.
 */
export function isStorableResult(result: HttpResult): boolean {
  const { status } = result
  if (status >= 200 && status < 300) return true
  if (status === 400 || status === 404 || status === 422) return true
  if (status === 409) {
    const code = (result.body.error as { code?: unknown } | undefined)?.code
    return typeof code === "string" && STORED_409_CODES.has(code)
  }
  return false
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** A UUID v4: version nibble 4, variant 8-b. Either case. */
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_RE.test(value)
}

/** JSON with object keys sorted at every level (array order kept), so equal bodies hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    const entries = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function requestHash(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex")
}

/**
 * An HTTP response as stored and replayed: status + JSON object body. `headers` (e.g. a 429's
 * Retry-After) are sent but never stored: only storable results are kept, and those carry none.
 */
export type HttpResult = { status: number; body: Record<string, unknown>; headers?: Record<string, string> }

export type IdempotencyScope = {
  /** The caller's firm; "" for firmless routes (stored under the `_nofirm` prefix). */
  firmId: string
  uid: string
  /** `METHOD /path`, so a key cannot be replayed on another route. */
  route: string
  /** The raw `Idempotency-Key` header. */
  key: string | undefined
  body: unknown
  now: number
  /** Store a 2xx body as `{ redacted: true }` (responses carrying secrets, e.g. recovery codes). */
  redact?: boolean
}

/**
 * The `idempotency_keys` doc id of a key in a firm: `{firmId}_{key}` with the key in lower case, `_nofirm` for a
 * firmless route. Exported so an operation can name the answer its request will store (the P1 lease reconciler marks a
 * committeeBrain answer settled, Codex P2 on PR #40).
 */
export function idempotencyDocId(firmId: string, key: string): string {
  return `${firmId || "_nofirm"}_${key.toLowerCase()}`
}

type Claim = { kind: "claimed" } | { kind: "replay"; response: HttpResult } | { kind: "in_progress" } | { kind: "reused" }

function isHttpResult(value: unknown): value is HttpResult {
  const r = value as HttpResult | undefined
  return typeof r?.status === "number" && r.body !== null && typeof r.body === "object" && !Array.isArray(r.body)
}

/** When the claim was (re)taken: `claimedAt`, else `createdAt` for docs written before the lease existed. */
function claimedAtMs(doc: Record<string, unknown>): number {
  const at = doc.claimedAt instanceof Timestamp ? doc.claimedAt : doc.createdAt
  return at instanceof Timestamp ? at.toMillis() : 0
}

/**
 * Runs `handler` at most once per key, unless a claim outlives its lease. No UUID v4 key → 400
 * idempotency_key_required. A completed key replays its stored response with
 * `reused: true`; the same key with another body, route or user → 422
 * idempotency_key_reused; a duplicate while the first is running → 409
 * idempotency_in_progress, until the claim is over IDEMPOTENCY_LEASE_MS old,
 * then the duplicate takes the claim over and runs. Results allowed by
 * isStorableResult are stored; any other result, or a throw, releases the
 * claim so a retry can run.
 */
export async function withIdempotency(scope: IdempotencyScope, handler: () => Promise<HttpResult>): Promise<HttpResult> {
  if (!isUuidV4(scope.key)) throw new HttpError(400, "idempotency_key_required")
  const db = adminDb()
  const ref = db.collection("idempotency_keys").doc(idempotencyDocId(scope.firmId, scope.key))
  const hash = requestHash(scope.body)
  const claimId = randomUUID()

  let claim: Claim
  try {
    claim = await db.runTransaction(async (tx): Promise<Claim> => {
      const existing = (await tx.get(ref)).data()
      const live = existing?.expiresAt instanceof Timestamp && existing.expiresAt.toMillis() >= scope.now
      if (existing && live) {
        if (existing.uid !== scope.uid || existing.route !== scope.route || existing.requestHash !== hash) {
          return { kind: "reused" }
        }
        if (existing.status === "done" && isHttpResult(existing.response)) return { kind: "replay", response: existing.response }
        if (existing.status !== "in_progress" || scope.now - claimedAtMs(existing) <= IDEMPOTENCY_LEASE_MS) {
          return { kind: "in_progress" }
        }
        // A stale lease: fall through and take the claim over.
      }
      tx.set(ref, {
        firmId: scope.firmId,
        uid: scope.uid,
        route: scope.route,
        requestHash: hash,
        status: "in_progress",
        claimId,
        claimedAt: Timestamp.fromMillis(scope.now),
        createdAt: Timestamp.fromMillis(scope.now),
        expiresAt: Timestamp.fromMillis(scope.now + IDEMPOTENCY_TTL_MS),
      })
      return { kind: "claimed" }
    })
  } catch (err) {
    logFailure("idempotency store failed", err)
    throw new HttpError(503, "store_unavailable")
  }
  if (claim.kind === "reused") throw new HttpError(422, "idempotency_key_reused")
  if (claim.kind === "in_progress") throw new HttpError(409, "idempotency_in_progress")
  if (claim.kind === "replay") return { status: claim.response.status, body: { ...claim.response.body, reused: true } }

  let result: HttpResult
  try {
    result = await handler()
  } catch (err) {
    await settle(ref, claimId, undefined)
    throw err
  }
  if (!isStorableResult(result)) {
    await settle(ref, claimId, undefined)
  } else {
    const stored = scope.redact && result.status < 300 ? { redacted: true } : result.body
    // JSON round trip: drops undefined values Firestore would reject; the client got the same JSON.
    await settle(ref, claimId, { status: result.status, body: JSON.parse(JSON.stringify(stored)) })
  }
  return result
}

const SETTLE_RETRIES = 3
const SETTLE_BACKOFF_MS = 100

/**
 * Completes our claim with `response`, or deletes it when `response` is
 * undefined, only while the doc still holds our claimId. Retried
 * SETTLE_RETRIES times with exponential backoff (100/200/400 ms): a lost
 * "done" write is the one path, besides a crash, to a re-run after the lease.
 * Then best effort: the failure is logged, and the claim answers 409 until its lease ends.
 */
async function settle(ref: DocumentReference, claimId: string, response: HttpResult | undefined): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await adminDb().runTransaction(async (tx) => {
        if ((await tx.get(ref)).data()?.claimId !== claimId) return
        if (response) tx.update(ref, { status: "done", response })
        else tx.delete(ref)
      })
      return
    } catch (err) {
      if (attempt >= SETTLE_RETRIES) {
        logFailure(response ? "idempotency complete failed" : "idempotency release failed", err)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_BACKOFF_MS * 2 ** attempt))
    }
  }
}
