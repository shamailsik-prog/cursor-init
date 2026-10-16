import { createHash, randomUUID } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { FUNCTION_TIMEOUT_SECONDS } from "../health"
import { logFailure } from "../log"
import { HttpError } from "./errors"

/**
 * Idempotency-Key handling for POST/PUT (L18 §4.2), made atomic with the effects it guards (audit F09; spec
 * docs/superpowers/specs/2026-10-16-f09-atomic-idempotency-design.md).
 *
 * Two server-only documents per operation (no rules match; a Firestore TTL policy on `expiresAt` purges both, and until
 * it runs an expired one is treated as absent):
 *
 * - The operation record `idempotency_keys/{firmId}_{key}` = { firmId, uid, route, requestHash, operationId,
 *   status: "in_progress" | "done", claimId, claimedAt, claims, resumable?, released?, response?: { status, body },
 *   createdAt, expiresAt (+24 h from the first claim) }. `operationId` names the operation and survives every
 *   takeover; `claimId` names the attempt that holds it. An `in_progress` claim is a lease: once its `claimedAt` is more
 *   than IDEMPOTENCY_LEASE_MS old (the request died, or its result could not be stored), or once its holder set
 *   `resumable` (ended after its effect) or `released` (a taken-over claim that ended without one: the key's tombstone,
 *   kept because an older holder may still commit), the same request may take it over. The old holder can no longer
 *   store or release it (claimId check).
 * - The effect marker `idempotency_effects/{same id}` = { operationId, claimId, firmId, route, kind, expiresAt, ... },
 *   created with `tx.create` inside the effect's own transaction (CallAudit.stage of the allow row, or committeeBrain's
 *   provider-attempt record). It exists exactly when the operation's effect committed, and a second effect of the same
 *   operation cannot commit: its `create` fails the whole transaction (a write-only fence). Until it expires it is the
 *   key's committed effect whatever the record says, so it is never deleted early and a lost record cannot reopen the key
 *   (Codex P1 on PR #58).
 *
 * A route's mode says what a same-key request gets once an effect committed and no answer was stored: `once` (the
 * default) answers 409 `idempotency_effect_committed`, stored; `resume` takes the operation over and runs the handler
 * with the marker as `prior` (committeeBrain publishes the recorded answer); `rerun` routes stage no marker and keep the
 * released-claim behaviour, because each is idempotent by construction (spec §4).
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
/** How long an in_progress claim holds its key before the same request may take it over. */
export const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000

// A live request must never be taken over: the lease has to outlive the function timeout.
if (!(IDEMPOTENCY_LEASE_MS > FUNCTION_TIMEOUT_SECONDS * 1000)) {
  throw new Error(`idempotency lease (${IDEMPOTENCY_LEASE_MS} ms) must exceed the function timeout (${FUNCTION_TIMEOUT_SECONDS} s)`)
}

/** The operation's effect committed and its answer was not stored: the stored answer of the key from then on (audit F09). */
export const EFFECT_COMMITTED = "idempotency_effect_committed"
/** This attempt no longer holds the operation (it was taken over), or another attempt holds its effect: nothing it writes may land. */
export const CLAIM_LOST = "idempotency_claim_lost"

/**
 * 409 codes that are business conflicts: the request is refused by the
 * state it names and a same-key retry should get the same answer. Other 409s
 * are contention (claims_sync_failed, idempotency_in_progress, idempotency_claim_lost) or
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
  // Audit F09: the operation's effect committed; repeating it is the defect, so this answer is final for the key.
  EFFECT_COMMITTED,
])

/**
 * Which results are stored and replayed for their key (an explicit allowlist):
 * 2xx; the deterministic client errors 400, 404 and 422; and 409 business
 * conflicts (STORED_409_CODES). Everything else releases the claim so a
 * same-key retry runs again: 401/403 (session-dependent: a refreshed token or
 * a step-up may succeed), 409 contention codes, 429 and 5xx. A claim whose
 * operation already committed an effect is never released (see withIdempotency).
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

/**
 * The terminal answer of an operation whose effect committed without a stored answer (audit F09); a fresh object each
 * call. It names the operation (re-audit LOW-1), so a client can correlate the answer with the effect it stands for.
 */
export function effectCommittedResult(operationId: string): HttpResult {
  return { status: 409, body: { error: { code: EFFECT_COMMITTED, operationId } } }
}

/** A handler's own 409 idempotency_effect_committed (committeeBrain's resume with no receipt), whatever its body says. */
function isEffectCommitted(result: HttpResult): boolean {
  return result.status === 409 && (result.body.error as { code?: unknown } | undefined)?.code === EFFECT_COMMITTED
}

/**
 * What a same-key request gets after an effect committed without a stored answer (spec §2.2): `once` 409
 * idempotency_effect_committed (the default); `resume` a takeover that runs the handler with the marker as `prior`;
 * `rerun` no marker at all, and the released-claim behaviour of a route that is idempotent by construction.
 */
export type IdempotencyMode = "once" | "rerun" | "resume"

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
  /** The route's mode (default `once`). */
  mode?: IdempotencyMode
}

/**
 * The `idempotency_keys` doc id of a key in a firm: `{firmId}_{key}` with the key in lower case, `_nofirm` for a
 * firmless route. Exported so an operation can name the answer its request will store (the P1 lease reconciler marks a
 * committeeBrain answer settled, Codex P2 on PR #40). The operation's effect marker has the same id.
 */
export function idempotencyDocId(firmId: string, key: string): string {
  return `${firmId || "_nofirm"}_${key.toLowerCase()}`
}

/** The effect marker of the operation whose record is `idempotency_keys/{docId}` (audit F09). */
export function effectMarkerRef(docId: string): DocumentReference {
  return adminDb().collection("idempotency_effects").doc(docId)
}

/**
 * Test seam only; production code never sets it, and it is inert when `NODE_ENV` is "production". `settleFailures` is
 * a queue: each settle attempt takes the next error from it and throws it instead of running (a store that cannot take
 * the result). `beforeSettle` runs once before the settle, after the handler returned: a test holds it to stand for an
 * instance that died between its effect and its settlement.
 */
export const idempotencyTestSeam: { settleFailures?: Error[]; beforeSettle?: () => Promise<void> } = {}

function seam(): typeof idempotencyTestSeam {
  return process.env.NODE_ENV === "production" ? {} : idempotencyTestSeam
}

/** The stored form of a result: status and the JSON round trip of its body (redacted for a secret-bearing 2xx). */
function storedForm(result: HttpResult, redact: boolean | undefined): HttpResult {
  const body = redact && result.status < 300 ? { redacted: true } : result.body
  // JSON round trip: drops undefined values Firestore would reject; the client got the same JSON.
  return { status: result.status, body: JSON.parse(JSON.stringify(body)) as Record<string, unknown> }
}

/**
 * The operation a request runs as (audit F09), handed to the handler by withIdempotency. An effect transaction stages
 * the marker (`stageEffect`, a `create`, so it needs no read and fits any transaction); a handler that can also store
 * its answer there reads the claim first (`read`, the fence) and stages it (`stageAnswer`).
 */
export class IdempotentOperation {
  readonly ref: DocumentReference
  readonly markerRef: DocumentReference

  constructor(
    readonly docId: string,
    readonly mode: IdempotencyMode,
    readonly operationId: string,
    readonly claimId: string,
    readonly scope: { firmId: string; route: string; redact?: boolean; expiresAt: Timestamp; now: number },
    /** `resume` mode: the marker an earlier attempt of this operation committed; null when none did. */
    readonly prior: DocumentData | null
  ) {
    this.ref = adminDb().collection("idempotency_keys").doc(docId)
    this.markerRef = effectMarkerRef(docId)
  }

  /** The fields every marker of this operation is created with. */
  markerFields(): Record<string, unknown> {
    return {
      operationId: this.operationId,
      claimId: this.claimId,
      firmId: this.scope.firmId,
      route: this.scope.route,
      expiresAt: this.scope.expiresAt,
      createdAt: FieldValue.serverTimestamp(),
    }
  }

  /**
   * Stages the operation's effect marker in `tx`. The effect and the "effect committed" state commit together, and if
   * any attempt of this operation already committed an effect, the `create` fails the transaction with ALREADY_EXISTS:
   * the second effect never lands.
   */
  stageEffect(tx: Transaction, fields: Record<string, unknown> = {}): void {
    tx.create(this.markerRef, { ...this.markerFields(), kind: "transaction", ...fields })
  }

  /**
   * The fence, read in an effect transaction before any write: throws 409 idempotency_claim_lost when this attempt no
   * longer holds the claim. `answered`: this attempt's answer is already stored (an earlier attempt of the same
   * transaction committed and lost its reply). `marker`: the operation's effect marker, or null.
   */
  async read(tx: Transaction): Promise<{ answered: boolean; marker: DocumentData | null }> {
    const [record, marker] = await tx.getAll(this.ref, this.markerRef)
    if (!record!.exists || record!.get("claimId") !== this.claimId) throw new HttpError(409, CLAIM_LOST)
    return { answered: record!.get("status") === "done", marker: marker!.exists ? marker!.data()! : null }
  }

  /** Stages the stored answer in `tx` (after `read` in the same transaction): the answer commits with the effect. */
  stageAnswer(tx: Transaction, result: HttpResult): void {
    tx.update(this.ref, { status: "done", response: storedForm(result, this.scope.redact), answeredAt: FieldValue.serverTimestamp() })
  }
}

type Claim =
  | { kind: "claimed"; operationId: string; prior: DocumentData | null; expiresAt: Timestamp }
  | { kind: "replay"; response: HttpResult }
  | { kind: "in_progress" }
  | { kind: "reused" }

function isHttpResult(value: unknown): value is HttpResult {
  const r = value as HttpResult | undefined
  return typeof r?.status === "number" && r.body !== null && typeof r.body === "object" && !Array.isArray(r.body)
}

/** When the claim was (re)taken: `claimedAt`, else `createdAt` for docs written before the lease existed. */
function claimedAtMs(doc: Record<string, unknown>): number {
  const at = doc.claimedAt instanceof Timestamp ? doc.claimedAt : doc.createdAt
  return at instanceof Timestamp ? at.toMillis() : 0
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== ""

/**
 * Whether an effect marker still counts at `nowMs` (Codex P1 on PR #58): until its `expiresAt` passes, a marker is the
 * evidence that the key's operation committed an effect, whatever record exists (or no longer exists) beside it, and
 * whatever operation id it names. Only an expired marker is ever deleted. A marker with no readable expiry counts (fail
 * closed); every marker this code writes carries its operation's expiry.
 */
function markerCounts(marker: DocumentSnapshot, nowMs: number): boolean {
  if (!marker.exists) return false
  const at = marker.get("expiresAt")
  return !(at instanceof Timestamp) || at.toMillis() >= nowMs
}

/**
 * Runs `handler` at most once per key, and never repeats a committed effect (audit F09). No UUID v4 key → 400
 * idempotency_key_required. A completed key replays its stored response with `reused: true`; the same key with another
 * body, route or user → 422 idempotency_key_reused; a duplicate while the first is running → 409
 * idempotency_in_progress, until the claim is over IDEMPOTENCY_LEASE_MS old or its holder marked it `resumable` or
 * `released`. Then: if the operation's effect committed (an unexpired marker exists), a `once` route answers 409
 * idempotency_effect_committed (stored) without running, and a `resume` route takes the claim over and runs the handler
 * with the marker as `prior`; otherwise the duplicate takes the claim over and runs. An unexpired marker with no record
 * beside it is adopted the same way. Results allowed by isStorableResult are stored (unless the handler stored its
 * answer with its effect); any other result, or a throw, releases the claim when no effect committed (a first claim is
 * deleted; a taken-over claim stays as a `released` tombstone, because an older holder may still commit), and otherwise
 * stores the terminal 409 (`once`, which this request then answers) or marks the claim `resumable`.
 */
export async function withIdempotency(scope: IdempotencyScope, handler: (op: IdempotentOperation) => Promise<HttpResult>): Promise<HttpResult> {
  if (!isUuidV4(scope.key)) throw new HttpError(400, "idempotency_key_required")
  const db = adminDb()
  const mode = scope.mode ?? "once"
  const docId = idempotencyDocId(scope.firmId, scope.key)
  const ref = db.collection("idempotency_keys").doc(docId)
  const markerRef = effectMarkerRef(docId)
  const hash = requestHash(scope.body)
  const claimId = randomUUID()
  const nowTs = Timestamp.fromMillis(scope.now)

  let claim: Claim
  try {
    claim = await db.runTransaction(async (tx): Promise<Claim> => {
      const [recordSnap, markerSnap] = await tx.getAll(ref, markerRef)
      const existing = recordSnap!.data()
      const live = existing?.expiresAt instanceof Timestamp && existing.expiresAt.toMillis() >= scope.now
      if (existing && live) {
        if (existing.uid !== scope.uid || existing.route !== scope.route || existing.requestHash !== hash) {
          return { kind: "reused" }
        }
        if (existing.status === "done" && isHttpResult(existing.response)) return { kind: "replay", response: existing.response }
        if (existing.status !== "in_progress") return { kind: "in_progress" }
        const leaseEnded = existing.resumable === true || existing.released === true
        if (!leaseEnded && scope.now - claimedAtMs(existing) <= IDEMPOTENCY_LEASE_MS) return { kind: "in_progress" }
        // A lapsed lease, a holder that ended after its effect (`resumable`), or a taken-over holder that ended without
        // one (`released`): take the claim over, keeping the operation's identity and its window (the marker carries
        // the same expiry, spec ruling 6). An unexpired marker is the operation's committed effect, whichever attempt
        // (or operation id) wrote it: it is adopted, never deleted (Codex P1 on PR #58). Only an expired one is deleted.
        const ours = markerCounts(markerSnap!, scope.now)
        if (markerSnap!.exists && !ours) tx.delete(markerRef)
        const markerOp: unknown = ours ? markerSnap!.get("operationId") : undefined
        const operationId = nonEmpty(markerOp) ? markerOp : nonEmpty(existing.operationId) ? existing.operationId : randomUUID()
        const claims = (typeof existing.claims === "number" && Number.isSafeInteger(existing.claims) ? existing.claims : 1) + 1
        if (ours && mode !== "resume") {
          // The effect committed and its answer was never stored: the answer is final, and the handler never runs again.
          tx.update(ref, {
            status: "done",
            operationId,
            claimId,
            claimedAt: nowTs,
            claims,
            response: effectCommittedResult(operationId),
            answeredAt: FieldValue.serverTimestamp(),
            resumable: FieldValue.delete(),
            released: FieldValue.delete(),
          })
          return { kind: "replay", response: effectCommittedResult(operationId) }
        }
        tx.update(ref, { operationId, claimId, claimedAt: nowTs, claims, resumable: FieldValue.delete(), released: FieldValue.delete() })
        return { kind: "claimed", operationId, prior: ours && mode === "resume" ? markerSnap!.data()! : null, expiresAt: existing.expiresAt as Timestamp }
      }
      const binding = { firmId: scope.firmId, uid: scope.uid, route: scope.route, requestHash: hash, claimId, claims: 1, claimedAt: nowTs, createdAt: nowTs }
      if (markerCounts(markerSnap!, scope.now)) {
        // No live record, but an unexpired marker (Codex P1 on PR #58): the key's operation committed an effect and its
        // record is gone. The marker's operation is adopted, in its own window: `once` answers the terminal 409 (stored),
        // `resume` runs with the marker as `prior`. The effect never runs a second time.
        const markerOp: unknown = markerSnap!.get("operationId")
        const operationId = nonEmpty(markerOp) ? markerOp : randomUUID()
        const at: unknown = markerSnap!.get("expiresAt")
        const expiresAt = at instanceof Timestamp ? at : Timestamp.fromMillis(scope.now + IDEMPOTENCY_TTL_MS)
        if (mode !== "resume") {
          tx.set(ref, { ...binding, operationId, expiresAt, status: "done", response: effectCommittedResult(operationId), answeredAt: FieldValue.serverTimestamp() })
          return { kind: "replay", response: effectCommittedResult(operationId) }
        }
        tx.set(ref, { ...binding, operationId, expiresAt, status: "in_progress" })
        return { kind: "claimed", operationId, prior: markerSnap!.data()!, expiresAt }
      }
      // No live operation under this key: a fresh one. A marker left from an expired operation is deleted with it.
      if (markerSnap!.exists) tx.delete(markerRef)
      const operationId = randomUUID()
      const expiresAt = Timestamp.fromMillis(scope.now + IDEMPOTENCY_TTL_MS)
      tx.set(ref, { ...binding, status: "in_progress", operationId, expiresAt })
      return { kind: "claimed", operationId, prior: null, expiresAt }
    })
  } catch (err) {
    logFailure("idempotency store failed", err)
    throw new HttpError(503, "store_unavailable")
  }
  if (claim.kind === "reused") throw new HttpError(422, "idempotency_key_reused")
  if (claim.kind === "in_progress") throw new HttpError(409, "idempotency_in_progress")
  if (claim.kind === "replay") return { status: claim.response.status, body: { ...claim.response.body, reused: true } }

  const op = new IdempotentOperation(
    docId,
    mode,
    claim.operationId,
    claimId,
    { firmId: scope.firmId, route: scope.route, redact: scope.redact, expiresAt: claim.expiresAt, now: scope.now },
    claim.prior
  )
  let result: HttpResult
  try {
    result = await handler(op)
  } catch (err) {
    if ((await settle(op, undefined)) === "terminal") return effectCommittedResult(op.operationId)
    throw err
  }
  // A handler's own 409 idempotency_effect_committed names the operation too (re-audit LOW-1), stored and answered alike.
  if (isEffectCommitted(result)) result = effectCommittedResult(op.operationId)
  if (!isStorableResult(result)) {
    if ((await settle(op, undefined)) === "terminal") return effectCommittedResult(op.operationId)
  } else {
    await settle(op, storedForm(result, scope.redact))
  }
  return result
}

const SETTLE_RETRIES = 3
const SETTLE_BACKOFF_MS = 100

/** What a settle did: stored the answer, found it stored, released the claim, marked it resumable, stored the terminal 409, lost the claim, or failed. */
type Settled = "stored" | "answered" | "released" | "resumable" | "terminal" | "lost" | "failed"

/**
 * Settles our claim after the handler, only while the record still holds our claimId, in one transaction that reads
 * the record and the operation's effect marker. With `response` (a storable result): `done` with it, unless the handler
 * already stored its answer with its effect. Without (a non-storable result or a throw): when no effect of this
 * operation committed (no unexpired marker), the claim is released, deleted when it was a first claim and kept as a
 * `released` tombstone when this attempt took it over; when one did, a `resume` claim is marked `resumable` and any
 * other gets the terminal 409 idempotency_effect_committed. Retried SETTLE_RETRIES times with exponential backoff
 * (100/200/400 ms); then best effort: the failure is logged, the claim answers 409 until its lease ends, and the next
 * claim decides from the marker.
 */
async function settle(op: IdempotentOperation, response: HttpResult | undefined): Promise<Settled> {
  const t = seam()
  await t.beforeSettle?.()
  for (let attempt = 0; ; attempt++) {
    try {
      const injected = t.settleFailures?.shift()
      if (injected) throw injected
      return await adminDb().runTransaction(async (tx): Promise<Settled> => {
        const [recordSnap, markerSnap] = await tx.getAll(op.ref, op.markerRef)
        if (recordSnap!.get("claimId") !== op.claimId) return "lost"
        if (recordSnap!.get("status") === "done") return "answered"
        if (response) {
          tx.update(op.ref, { status: "done", response, answeredAt: FieldValue.serverTimestamp() })
          return "stored"
        }
        // Any unexpired marker is a committed effect of the key's operation (Codex P1 on PR #58), whichever attempt wrote it.
        const effect = markerCounts(markerSnap!, op.scope.now)
        if (!effect) {
          const claims: unknown = recordSnap!.get("claims")
          if (typeof claims === "number" && claims > 1) {
            // This attempt took the claim over, so an older holder of the operation may still be alive and commit its
            // effect after this release (Codex P1 on PR #58). The record stays, `released`, as the key's tombstone: the
            // next same-key request takes it over at once (another body still gets 422), and the older holder's marker,
            // should it land, then fences the key. Only a first claim, which no other attempt ever held, is deleted.
            tx.update(op.ref, { released: true })
            return "released"
          }
          tx.delete(op.ref)
          return "released"
        }
        if (op.mode === "resume") {
          tx.update(op.ref, { resumable: true })
          return "resumable"
        }
        tx.update(op.ref, { status: "done", response: effectCommittedResult(op.operationId), answeredAt: FieldValue.serverTimestamp() })
        return "terminal"
      })
    } catch (err) {
      if (attempt >= SETTLE_RETRIES) {
        logFailure(response ? "idempotency complete failed" : "idempotency release failed", err)
        return "failed"
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_BACKOFF_MS * 2 ** attempt))
    }
  }
}
