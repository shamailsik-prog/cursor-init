import { FieldValue, Timestamp, type DocumentData, type DocumentReference } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { FUNCTION_TIMEOUT_SECONDS } from "../health"
import { HttpError } from "../http/errors"
import { CLAIM_LOST, EFFECT_COMMITTED, idempotencyDocId, isUuidV4, type IdempotentOperation } from "../http/idempotency"
import type { Caller } from "../p5/auth"
import { isKnownClassification, rankOf } from "../p5/classification"
import type { CallAudit, Data, FirmOperation, FirmlessOperation } from "../p5/common"
import { requirePermission } from "../p5/permission"
import { THRESHOLDS, alertRef, budgetOf, firmConfigRef, monthRef, pkrRateOf, platformConfigRef, reservationRef, spentOf } from "./config"
import { PROVIDER_ID } from "./costTable"
import { CALL_WORST_CASE_MS, P1PreCallDeadlineError, assertOperationTimeBudget, callP1, isAlreadyExists, type P1Receipt, type P1Result } from "./gateway"
import { isMonthKey, monthKeyPkt } from "./month"
import { TRANSPORT_ERROR, type P1Accounting } from "./types"

/**
 * The five P1 operations behind `/api/platform/brain/` (spec P3-60, P3-66, P3-70..P3-72): `committeeBrain`,
 * `getAiUsage`, `setBudgetAlerts`, `setAiKillSwitch` (firm operations) and `setPlatformAiKillSwitch`
 * (firmless, `platformAdmin` claim). They are the HTTP face of `callP1` and of the server-only P1 documents
 * (`ai_config/{firmId}`, `platform/p1`, `ai_usage_months/*`, `ai_budget_alerts/*`); no client reads or
 * writes those directly (firestore.rules).
 */

/** The Next.js route's fixed purpose list (I1): the purpose travels to the provider, so it is never free text. */
const COMMITTEE_PURPOSES: ReadonlySet<string> = new Set(["committee-brain", "summarise", "research", "translate", "ops-audit"])
const DEFAULT_PURPOSE = "committee-brain"
/** Caller-authored free text is never rank 0: anyone can create a "public" matter (N1). */
const FREE_TEXT_FLOOR: Classification = "internal"
/** UTF-16 code units, like `String.length`. */
const MAX_BODY_CHARS = 100_000
const MAX_PARTY_NAMES = 50

const MAX_BUDGET_USD = 1_000_000
const MAX_PKR_PER_USD = 10_000
const MAX_DISABLED_MODELS = 20
const MAX_MODEL_ID_CHARS = 200
const MAX_REASON_CHARS = 500

const badRequest = (code: string) => new HttpError(400, code)

/** Attempts at the `committee_outputs` write; after a failed attempt the wait is 100 ms, then 200 ms (doubling). */
const OUTPUT_WRITE_ATTEMPTS = 3
const OUTPUT_WRITE_BACKOFF_MS = 100
/**
 * The output write's deadline (Codex P1 on PR #40), from its first attempt: no attempt, and no wait, starts once it
 * would run past it. Each attempt is one SDK transaction attempt (`maxAttempts: 1`), so the SDK adds no retries or
 * back-off of its own: the write takes at most this plus one attempt in flight.
 */
export const OUTPUT_WRITE_DEADLINE_MS = 3_000

/**
 * The time committeeBrain allows before paid work starts (re-audit R3-D2): eight store or Auth round trips at 1 s each
 * (the ID token's verification and the session binding, the rate limit, the Idempotency-Key claim, the `ai.call`
 * permission check, the matter read, the party-name query and the call's first reads), measured on the real clock from
 * when the router received the request (`session.startedAtMs`). It is enforced: once the call's first reads are done,
 * `callP1` reserves nothing and sends nothing if this has passed, and the request answers 503 `precall_deadline`
 * (retryable; the Idempotency-Key is released). A read that hangs is still not cut off, but it costs nothing, and no
 * paid work starts that could outlive the request's timeout.
 */
export const PRE_CALL_ALLOWANCE_MS = 8_000
/**
 * The time committeeBrain allows after the call: the `committee_outputs` write with the route's audit row
 * (OUTPUT_WRITE_DEADLINE_MS, 3 s, plus 2 s for the one attempt in flight) and the Idempotency-Key completion (3 s: up
 * to four short transactions with 0.7 s of back-off between them, `settle` in http/idempotency.ts).
 */
export const POST_CALL_ALLOWANCE_MS = 8_000
/**
 * committeeBrain's own work around `callP1`, as a share of the api function's timeout (Codex P1 on PR #40): the
 * pre-call allowance (enforced, re-audit R3-D2) and the post-call allowance (the output write is bounded by its
 * deadline). The import-time check below keeps the call's phases (CALL_WORST_CASE_MS, 99 s), this share (16 s) and
 * REQUEST_TIMEOUT_MARGIN_MS within the 120 s timeout.
 */
export const COMMITTEE_HANDLER_OVERHEAD_MS = PRE_CALL_ALLOWANCE_MS + POST_CALL_ALLOWANCE_MS
/** Kept free at the end of the request: the response itself, and the clock drift between the shares. */
export const REQUEST_TIMEOUT_MARGIN_MS = 5_000

assertOperationTimeBudget({
  callMs: CALL_WORST_CASE_MS,
  handlerMs: COMMITTEE_HANDLER_OVERHEAD_MS,
  marginMs: REQUEST_TIMEOUT_MARGIN_MS,
  timeoutMs: FUNCTION_TIMEOUT_SECONDS * 1000,
})

/**
 * Test seam only; production code never sets it, and it is inert when `NODE_ENV` is "production".
 * `outputWriteFailures` is a queue: each attempt at the `committee_outputs` write takes the next error from it
 * and throws it instead of writing. `lostCommitAnswers` is a queue too: each attempt whose write committed takes
 * the next error from it and throws it, as if the commit had landed but its answer was lost (an ambiguous
 * commit). `sleep` replaces the back-off wait. `wallClock` replaces `Date.now` as the output write's deadline clock.
 * `preCallClock` replaces `Date.now` as the clock the pre-call deadline is checked on (re-audit R3-D2). `beforePublish`
 * runs after the call and before the publication transaction (audit F09): a test holds it to stand for an instance
 * that died between the provider call and output persistence.
 */
export const p1OpsTestSeam: {
  outputWriteFailures?: Error[]
  lostCommitAnswers?: Error[]
  sleep?: (ms: number) => Promise<void>
  wallClock?: () => number
  preCallClock?: () => number
  beforePublish?: () => Promise<void>
} = {}

function seam(): typeof p1OpsTestSeam {
  return process.env.NODE_ENV === "production" ? {} : p1OpsTestSeam
}

/** True when `outputRef` holds this call's row: the write being retried has in fact committed. */
async function outputCommitted(outputRef: DocumentReference, usageLogId: string): Promise<boolean> {
  try {
    const snap = await outputRef.get()
    return snap.exists && snap.get("usageLogId") === usageLogId
  } catch {
    return false
  }
}

/**
 * Runs `write` up to OUTPUT_WRITE_ATTEMPTS times. The provider call and its usage row are already committed
 * by then, so a transient failure of the output row's transaction is retried rather than lost; an HttpError
 * (e.g. 503 audit_unavailable) is a decision, not a transient fault, and is never retried. An attempt that
 * fails with ALREADY_EXISTS after an earlier attempt's commit was lost (an ambiguous commit) finds the row:
 * when `outputRef` exists with this call's `usageLogId` the write is done, and it returns normally, so the
 * route's allow row (committed with that row) stands and no deny row is written. Any other ALREADY_EXISTS is
 * handled like any other failure. No wait or attempt starts once it would end past OUTPUT_WRITE_DEADLINE_MS from the
 * first attempt (Codex P1 on PR #40). The last failure is rethrown as it was.
 */
async function withOutputWriteRetry(write: () => Promise<void>, row: { outputRef: DocumentReference; usageLogId: string }): Promise<void> {
  const t = seam()
  const clock = t.wallClock ?? Date.now
  const started = clock()
  for (let attempt = 1; ; attempt++) {
    try {
      const injected = t.outputWriteFailures?.shift()
      if (injected) throw injected
      await write()
      const lost = t.lostCommitAnswers?.shift()
      if (lost) throw lost
      return
    } catch (err) {
      if (err instanceof HttpError) throw err
      if (isAlreadyExists(err) && (await outputCommitted(row.outputRef, row.usageLogId))) return
      if (attempt >= OUTPUT_WRITE_ATTEMPTS) throw err
      const wait = OUTPUT_WRITE_BACKOFF_MS * 2 ** (attempt - 1)
      if (clock() - started + wait >= OUTPUT_WRITE_DEADLINE_MS) throw err
      await (t.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(wait)
    }
  }
}

// ---------------------------------------------------------------------------
// committeeBrain
// ---------------------------------------------------------------------------

type CommitteeInput = {
  matterId: string
  body: string
  purpose: string
  classification: Classification | undefined
  partyNames: string[]
}

/** The request checks, in the order the spec states them; the first failure wins. */
function parseCommitteeInput(data: Data): CommitteeInput {
  const { matterId, body, purpose, classification, documentIds, partyNames } = data
  if (typeof matterId !== "string" || matterId === "") throw badRequest("matter_required")
  if (typeof body !== "string" || body === "" || body.length > MAX_BODY_CHARS) throw badRequest("invalid_body")
  if (purpose !== undefined && !(typeof purpose === "string" && COMMITTEE_PURPOSES.has(purpose))) throw badRequest("invalid_purpose")
  if (classification !== undefined && !isKnownClassification(classification)) throw badRequest("invalid_classification")
  // Documents are not in Cloud Functions yet: any presence of the field is refused.
  if (documentIds !== undefined) throw badRequest("documents_not_supported")
  if (
    partyNames !== undefined &&
    !(Array.isArray(partyNames) && partyNames.length <= MAX_PARTY_NAMES && partyNames.every((n) => typeof n === "string" && n.trim() !== ""))
  ) {
    throw badRequest("invalid_party_names")
  }
  return {
    matterId,
    body,
    purpose: purpose === undefined ? DEFAULT_PURPOSE : (purpose as string),
    classification: classification as Classification | undefined,
    partyNames: (partyNames as string[] | undefined) ?? [],
  }
}

/**
 * `ai.call` on the matter, with the same answer for an absent and another firm's matter as `getMatter`:
 * 404 `not_found`, so existence never leaks. Any other refusal is requirePermission's 403 (role_not_permitted,
 * not_member, clearance, ...); an audit failure is 503.
 */
async function gateAiCall(caller: Caller, matterId: string): Promise<void> {
  try {
    await requirePermission(caller, "ai.call", matterId)
  } catch (err) {
    if (err instanceof HttpError && err.status === 403 && err.code === "cross_firm") throw new HttpError(404, "not_found")
    throw err
  }
}

/** The strictest label by rank, never by string comparison. */
function strictest(labels: Classification[]): Classification {
  return labels.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a))
}

/**
 * Every `name` and `names` entry of this firm's `matter_parties` rows for the matter, plus the supplied names,
 * de-duplicated. Longest first, so "Ali Raza Khan" is masked whole before "Ali Raza" can leave "Khan" behind.
 */
async function partyNamesFor(firmId: string, matterId: string, supplied: string[]): Promise<string[]> {
  const rows = await adminDb().collection("matter_parties").where("firmId", "==", firmId).where("matterId", "==", matterId).get()
  const names = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() !== "") names.add(value.trim())
  }
  for (const row of rows.docs) {
    const party = row.data()
    add(party.name)
    if (Array.isArray(party.names)) party.names.forEach(add)
  }
  supplied.forEach(add)
  return [...names].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
}

export type CommitteeBrainResponse = {
  outputId: string
  blocked: boolean
  reason?: string
  text?: string
  classification: Classification
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number }
  traceId: string
  /** Whether the call's books are complete, apart from whether its text is available (audit F08; see P1Accounting). */
  accounting: P1Accounting
}

type CommitteeOutputRow = Record<string, unknown>

/**
 * The publication (audit F09): one transaction writes the route's allow row, the `committee_outputs` row and, for an
 * HTTP operation, the request's stored answer, so the answer commits with the output and no window lies between them.
 * The operation's fence is read first: this attempt must still hold the claim (else 409 idempotency_claim_lost), and its
 * effect marker must be this call's dispatch (else another attempt of the operation holds its effect: 409
 * idempotency_claim_lost too); a call that never dispatched (blocked) creates the marker here. An attempt that finds
 * its answer already stored is an earlier attempt of this transaction whose commit landed and whose reply was lost: done.
 * Retried by withOutputWriteRetry like the output write before it.
 */
async function publish(a: {
  operation: IdempotentOperation | undefined
  audit: CallAudit
  outputRef: DocumentReference
  row: CommitteeOutputRow
  response: CommitteeBrainResponse
  usageLogId: string
  traceId: string
}): Promise<void> {
  await seam().beforePublish?.()
  // One SDK attempt per try (Codex P1 on PR #40): the retries and their deadline are withOutputWriteRetry's alone.
  await withOutputWriteRetry(
    () =>
      adminDb().runTransaction(
        async (tx) => {
          let effect = true
          if (a.operation !== undefined) {
            const { answered, marker } = await a.operation.read(tx)
            if (answered) return
            if (marker !== null) {
              if (marker.kind !== "p1_dispatch" || marker.traceId !== a.traceId) throw new HttpError(409, CLAIM_LOST)
              effect = false
            }
          }
          await a.audit.stage(tx, "allow", "ok", { effect })
          tx.create(a.outputRef, a.row)
          a.operation?.stageAnswer(tx, { status: 200, body: a.response })
        },
        { maxAttempts: 1 }
      ),
    { outputRef: a.outputRef, usageLogId: a.usageLogId }
  )
  a.audit.committed()
}

/** The output row in the Next.js shape (CommitteeBrainOutput): `id` in the row, `createdAt` in epoch milliseconds from the op's clock. */
function outputRow(o: {
  outputRef: DocumentReference
  caller: Caller
  matterId: string
  classification: Classification
  purpose: string
  blocked: boolean
  reason: string | undefined
  text: string | undefined
  outbound: P1Result["outbound"]
  usageLogId: string
  traceId: string
  accounting: P1Accounting
  createdAt: number
}): CommitteeOutputRow {
  return {
    id: o.outputRef.id,
    firmId: o.caller.firmId,
    actorId: o.caller.uid,
    matterId: o.matterId,
    documentIds: [],
    classification: o.classification,
    purpose: o.purpose,
    blocked: o.blocked,
    ...(o.reason === undefined ? {} : { reason: o.reason }),
    ...(o.text === undefined ? {} : { text: o.text }),
    outbound: {
      body: o.outbound.body,
      metadata: { classification: o.classification, provider: PROVIDER_ID, purpose: o.outbound.purpose, redactionCounts: o.outbound.redactionCounts },
    },
    usageLogId: o.usageLogId,
    traceId: o.traceId,
    // The accounting state when the call returned; the lease reconciler sets it to settled when it settles or
    // releases the call's reservation (Codex P2 on PR #40), and the usage row (usageLogId) is the authority.
    accounting: o.accounting,
    createdAt: o.createdAt,
  }
}

/** A count, when it is a non-negative integer. */
const countOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null)

/** The attempt receipt on a marker, when it is complete and well formed; null otherwise (then the answer is lost). */
function receiptOf(value: unknown): P1Receipt | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  const outbound = r.outbound as Record<string, unknown> | undefined
  const inputTokens = countOf(r.inputTokens)
  const outputTokens = countOf(r.outputTokens)
  const costMicroUsd = countOf(r.costMicroUsd)
  if (r.outcome !== "ok" && r.outcome !== "failed") return null
  if (r.outcome === "ok" && typeof r.text !== "string") return null
  if (inputTokens === null || outputTokens === null || costMicroUsd === null || typeof r.tokensEstimated !== "boolean") return null
  if (typeof r.model !== "string" || !isKnownClassification(r.classification)) return null
  if (outbound === null || typeof outbound !== "object" || typeof outbound.body !== "string" || typeof outbound.purpose !== "string") return null
  const counts = outbound.redactionCounts
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) return null
  return {
    outcome: r.outcome,
    ...(r.outcome === "ok" ? { text: r.text as string } : {}),
    inputTokens,
    outputTokens,
    tokensEstimated: r.tokensEstimated,
    costMicroUsd,
    model: r.model,
    classification: r.classification,
    outbound: { body: outbound.body, purpose: outbound.purpose, redactionCounts: counts as Record<string, number> },
  }
}

/**
 * The resume path (audit F09): an earlier attempt of this operation dispatched its one provider call (the marker,
 * `prior`) and never stored its answer. The answer is published from the attempt receipt, with the call's own usage
 * row id and trace id, and no provider call. The caller must still be cleared for the label the call was made at, and
 * the row takes the stricter of that and the current one. `accounting` is `settled` once the call's reservation is
 * closed, else `pending` (the lease reconciler later settles it and refreshes the row and the stored answer by
 * `usageLogId` and trace id). With no receipt the answer is gone: 409 idempotency_effect_committed, stored for the key.
 */
async function resumeCommittee(a: {
  operation: IdempotentOperation
  prior: DocumentData
  audit: CallAudit
  caller: Caller
  matterId: string
  purpose: string
  classification: Classification
  createdAt: number
}): Promise<CommitteeBrainResponse> {
  if (a.prior.kind !== "p1_dispatch") throw new HttpError(409, EFFECT_COMMITTED)
  // The freshest marker: its receipt may have landed after the claim read it.
  const marker = (await a.operation.markerRef.get()).data()
  // Re-audit MEDIUM-1: a receipt is published only to the request that made it, on its own matter. The claim admits only
  // that request already; this holds it here too, where the answer is about to leave: the same user, route and body, and
  // the matter the call was made on, which is the request's matter, the one gateAiCall has just cleared this caller for.
  // A marker missing any of these (fail closed) publishes nothing.
  if (marker !== undefined && (!a.operation.answersThisRequest(marker) || marker.matterId !== a.matterId)) {
    throw new HttpError(422, "idempotency_key_reused")
  }
  const usageLogId = marker?.usageLogId
  const traceId = marker?.traceId
  const receipt = marker?.kind === "p1_dispatch" && marker.operationId === a.operation.operationId ? receiptOf(marker.result) : null
  if (receipt === null || typeof usageLogId !== "string" || typeof traceId !== "string") throw new HttpError(409, EFFECT_COMMITTED)
  if (rankOf(a.caller.clearanceLevel) < rankOf(receipt.classification)) throw new HttpError(403, "clearance")
  const classification = strictest([a.classification, receipt.classification])
  const state = (await reservationRef(usageLogId).get()).get("state")
  const accounting: P1Accounting = state === "settled" || state === "released" ? "settled" : "pending"
  const blocked = receipt.outcome !== "ok"
  const reason = blocked ? TRANSPORT_ERROR : undefined
  const outputRef = adminDb().collection("committee_outputs").doc()
  const response: CommitteeBrainResponse = {
    outputId: outputRef.id,
    blocked,
    ...(reason === undefined ? {} : { reason }),
    ...(receipt.text === undefined ? {} : { text: receipt.text }),
    classification,
    usage: { inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, costMicroUsd: receipt.costMicroUsd },
    traceId,
    accounting,
  }
  const row = outputRow({
    outputRef,
    caller: a.caller,
    matterId: a.matterId,
    classification,
    purpose: a.purpose,
    blocked,
    reason,
    text: receipt.text,
    outbound: receipt.outbound,
    usageLogId,
    traceId,
    accounting,
    createdAt: a.createdAt,
  })
  await publish({ operation: a.operation, audit: a.audit, outputRef, row, response, usageLogId, traceId })
  return response
}

/**
 * committeeBrain({ matterId, body, purpose?, classification?, partyNames?, documentIds? }) (P3-70). Checks the
 * request, then `ai.call` on the matter (same firm, member, cleared; partner, associate, clerk), derives the
 * classification (the strictest of the matter's label, the caller's label and the `internal` floor; the caller's
 * clearance must reach it), masks with the matter's party names, calls `callP1` and writes one `committee_outputs`
 * row. A blocked or failed call is stored and returned like an ok one, with its reason and no text. The response
 * and the row carry `accounting` (audit F08): `pending` when the call's usage could not be committed, so its spend
 * is still held by its reservation until the lease reconciler settles it.
 *
 * Audit F09: for an HTTP operation (`session.operation`, route mode `resume`) the call records the operation's effect
 * marker with its provider attempt and its receipt when the provider answers (callP1), and the output row commits with
 * the request's stored answer (publish). A same-key request after a dispatch whose answer was never stored resumes
 * from the receipt (resumeCommittee): at most one provider call per operation.
 */
export const committeeBrainOp: FirmOperation<CommitteeBrainResponse> = {
  auth: "firm",
  kind: "p1",
  action: "ai.call",
  target: "matters",
  run: async ({ caller, now: routerNow, idempotencyKey, startedAtMs, operation }, data, audit) => {
    // The pre-call deadline (re-audit R3-D2), on the real clock from when the router received the request.
    const preCallClock = seam().preCallClock ?? Date.now
    const preCallDeadline = { atMs: (startedAtMs ?? Date.now()) + PRE_CALL_ALLOWANCE_MS, clock: preCallClock }
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const input = parseCommitteeInput(data)
    const { matterId } = input
    audit.target = `matters/${matterId}`
    await gateAiCall(caller, matterId)

    const matter = (await adminDb().collection("matters").doc(matterId).get()).data()
    if (!matter || matter.firmId !== caller.firmId) throw new HttpError(404, "not_found")
    // requirePermission refused an unreadable label already; this keeps the derivation fail-closed on its own.
    if (!isKnownClassification(matter.classification)) throw new HttpError(403, "clearance")
    const labels: Classification[] = [matter.classification, FREE_TEXT_FLOOR]
    if (input.classification !== undefined) labels.push(input.classification)
    const classification = strictest(labels)
    if (rankOf(caller.clearanceLevel) < rankOf(classification)) throw new HttpError(403, "clearance")

    // Audit F09: an earlier attempt of this operation dispatched its one provider call; publish its answer, call nothing.
    if (operation?.prior != null) {
      return resumeCommittee({
        operation,
        prior: operation.prior,
        audit,
        caller,
        matterId,
        purpose: input.purpose,
        classification,
        createdAt: Math.floor(routerNow ?? Date.now()),
      })
    }

    const partyNames = await partyNamesFor(caller.firmId, matterId, input.partyNames)
    // The router's clock for the month and the trace id, plus real elapsed time so the trace has a duration.
    const t0 = Date.now()
    const clock = () => (routerNow ?? t0) + (Date.now() - t0)
    // The request's stored answer goes on the reservation, so the lease reconciler can mark it settled (Codex P2 on PR #40).
    const idempotencyDoc = isUuidV4(idempotencyKey) ? idempotencyDocId(caller.firmId, idempotencyKey) : null
    let result: P1Result
    try {
      result = await callP1(
        {
          firmId: caller.firmId,
          actorId: caller.uid,
          matterId,
          jobId: null,
          taskType: "committee",
          classification,
          body: input.body,
          purpose: input.purpose,
          partyNames,
          idempotencyDoc,
          // Audit F09: the operation's marker is created with the provider attempt, and the receipt recorded on it.
          // Its matter too (re-audit MEDIUM-1): resumeCommittee publishes the receipt only on that matter.
          ...(operation === undefined ? {} : { operation: { markerRef: operation.markerRef, fields: { ...operation.markerFields(), matterId } } }),
        },
        { now: clock, preCallDeadline }
      )
    } catch (err) {
      // Nothing was reserved, sent or written: a 503 releases the Idempotency-Key, so the same request may be retried.
      if (err instanceof P1PreCallDeadlineError) throw new HttpError(503, err.code)
      throw err
    }

    const blocked = result.outcome !== "ok"
    const reason = result.blockReason ?? (result.outcome === "failed" ? TRANSPORT_ERROR : undefined)
    const outputRef = adminDb().collection("committee_outputs").doc()
    const text = result.outcome === "ok" ? result.text : undefined
    const response: CommitteeBrainResponse = {
      outputId: outputRef.id,
      blocked,
      ...(reason === undefined ? {} : { reason }),
      ...(text === undefined ? {} : { text }),
      classification,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costMicroUsd: result.costMicroUsd },
      traceId: result.traceId,
      accounting: result.accounting,
    }
    const row = outputRow({
      outputRef,
      caller,
      matterId,
      classification,
      purpose: input.purpose,
      blocked,
      reason,
      text,
      outbound: result.outbound,
      usageLogId: result.usageLogId,
      traceId: result.traceId,
      accounting: result.accounting,
      createdAt: Math.floor(clock()),
    })
    await publish({ operation, audit, outputRef, row, response, usageLogId: result.usageLogId, traceId: result.traceId })
    return response
  },
}

// ---------------------------------------------------------------------------
// getAiUsage
// ---------------------------------------------------------------------------

/** A stored kill switch as the partner sees it. `setAt` is null only for a malformed stored doc. */
export type KillSwitchView = { disableAll: boolean; disabledModels: string[]; reason: string; setBy: string; setAt: string | null }

export type AiUsageResponse = {
  month: string
  budgetMicroUsd: number | null
  spentMicroUsd: number
  spentPkr: number | null
  pkrPerUsd: number | null
  percentUsed: number | null
  /** `reconciled`: calls whose usage the lease reconciler recorded because the call's own commit never did (Codex P2 on PR #40). */
  calls: { ok: number; failed: number; blocked: number; reconciled: number }
  inputTokens: number
  outputTokens: number
  alerts: Array<{ threshold: number; at: string }>
  killSwitch: { firm: KillSwitchView | null; platform: KillSwitchView | null }
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)
const isoOf = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null)

/** What the switch enforces (`killSwitchBlocks` in config.ts: only `disableAll === true` and exact model ids count). */
function killSwitchView(raw: unknown, setBy?: string): KillSwitchView | null {
  if (raw === null || typeof raw !== "object") return null
  const ks = raw as Record<string, unknown>
  return {
    disableAll: ks.disableAll === true,
    disabledModels: Array.isArray(ks.disabledModels) ? ks.disabledModels.filter((m): m is string => typeof m === "string") : [],
    reason: typeof ks.reason === "string" ? ks.reason : "",
    setBy: setBy ?? (typeof ks.setBy === "string" ? ks.setBy : ""),
    setAt: isoOf(ks.setAt),
  }
}

/** What a firm's partner is told of who set the platform switch: never the operator's uid. */
const PLATFORM_SETTER = "platform"

/**
 * getAiUsage(?month=YYYY-MM) (P3-71), partner only (`ai.usage.read`). Reads the month total, the firm's config,
 * the platform doc and the two alert docs; never the logs. PKR and percent are rounded to 2 decimal places from
 * integer micro-USD.
 */
export const getAiUsageOp: FirmOperation<AiUsageResponse> = {
  auth: "firm",
  kind: "general",
  action: "ai.usage.read",
  target: "ai_usage_months",
  run: async ({ caller, now }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "ai.usage.read")
    if (data.month !== undefined && !isMonthKey(data.month)) throw badRequest("invalid_month")
    const month = data.month === undefined ? monthKeyPkt(now ?? Date.now()) : (data.month as string)
    audit.target = `ai_usage_months/${caller.firmId}_${month}`

    const [total, config, platform, ...alertSnaps] = await adminDb().getAll(
      monthRef(caller.firmId, month),
      firmConfigRef(caller.firmId),
      platformConfigRef(),
      ...THRESHOLDS.map((t) => alertRef(caller.firmId, month, t))
    )
    await audit.allow()

    const spent = spentOf(total.data())
    const budget = budgetOf(config.data())
    const rate = pkrRateOf(config.data())
    return {
      month,
      budgetMicroUsd: budget,
      spentMicroUsd: spent,
      spentPkr: rate === null ? null : Math.round((spent * rate) / 10_000) / 100,
      pkrPerUsd: rate,
      percentUsed: budget === null ? null : Math.round((spent * 10_000) / budget) / 100,
      calls: {
        ok: count(total.get("calls.ok")),
        failed: count(total.get("calls.failed")),
        blocked: count(total.get("calls.blocked")),
        reconciled: count(total.get("calls.reconciled")),
      },
      inputTokens: count(total.get("inputTokens")),
      outputTokens: count(total.get("outputTokens")),
      alerts: alertSnaps.flatMap((snap, i) => {
        const at = snap.exists ? isoOf(snap.get("createdAt")) ?? isoOf(snap.createTime) : null
        return at === null ? [] : [{ threshold: THRESHOLDS[i]!, at }]
      }),
      killSwitch: { firm: killSwitchView(config.get("killSwitch")), platform: killSwitchView(platform.get("killSwitch"), PLATFORM_SETTER) },
    }
  },
}

// ---------------------------------------------------------------------------
// setBudgetAlerts
// ---------------------------------------------------------------------------

/**
 * Micro-USD from a budget in USD: a number above 0 and at most 1,000,000 with at most 2 decimal places. The
 * decimal places are read off the number's shortest round-trip string (`String(1.001)` is "1.001", float noise
 * such as 0.1 + 0.2 is "0.30000000000000004", and an exponent form such as "1e-7" never matches), so there is no
 * epsilon: 1.5 and 0.01 pass, 1.001 does not.
 */
function parseBudgetUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_BUDGET_USD) throw badRequest("invalid_budget")
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw badRequest("invalid_budget")
  return Math.round(value * 1_000_000)
}

function parsePkrPerUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_PKR_PER_USD) throw badRequest("invalid_rate")
  return value
}

/**
 * setBudgetAlerts({ monthlyBudgetUsd, pkrPerUsd? }) (P3-71), partner only (`ai.budget.set`). Stores the budget as
 * integer micro-USD, and the rate when given (omitted leaves an existing rate untouched), merged into
 * `ai_config/{firmId}`. The alert thresholds are fixed at 70 and 90 (P3-65).
 */
export const setBudgetAlertsOp: FirmOperation<{ monthlyBudgetMicroUsd: number; pkrPerUsd: number | null }> = {
  auth: "firm",
  kind: "general",
  action: "ai.budget.set",
  target: "ai_config",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `ai_config/${caller.firmId}`
    await requirePermission(caller, "ai.budget.set")
    const monthlyBudgetMicroUsd = parseBudgetUsd(data.monthlyBudgetUsd)
    const pkrPerUsd = data.pkrPerUsd === undefined ? undefined : parsePkrPerUsd(data.pkrPerUsd)

    const ref = firmConfigRef(caller.firmId)
    const effectiveRate = await adminDb().runTransaction(async (tx) => {
      const existing = (await tx.get(ref)).data()
      await audit.stage(tx, "allow", "ok")
      tx.set(ref, { monthlyBudgetMicroUsd, ...(pkrPerUsd === undefined ? {} : { pkrPerUsd }) }, { merge: true })
      return pkrPerUsd ?? pkrRateOf(existing)
    })
    audit.committed()
    return { monthlyBudgetMicroUsd, pkrPerUsd: effectiveRate }
  },
}

// ---------------------------------------------------------------------------
// setAiKillSwitch, setPlatformAiKillSwitch
// ---------------------------------------------------------------------------

type KillSwitchInput = { disableAll: boolean; disabledModels: string[]; reason: string }
type KillSwitchSet = KillSwitchInput & { setBy: string }

/** `{ disableAll: boolean, disabledModels: string[], reason }`: the shape first (`invalid_kill_switch`), then the reason (`invalid_reason`). */
function parseKillSwitch(data: Data): KillSwitchInput {
  const { disableAll, disabledModels, reason } = data
  if (typeof disableAll !== "boolean") throw badRequest("invalid_kill_switch")
  if (
    !Array.isArray(disabledModels) ||
    disabledModels.length > MAX_DISABLED_MODELS ||
    !disabledModels.every((m) => typeof m === "string" && m !== "" && m.length <= MAX_MODEL_ID_CHARS)
  ) {
    throw badRequest("invalid_kill_switch")
  }
  const trimmed = typeof reason === "string" ? reason.trim() : ""
  if (trimmed === "" || trimmed.length > MAX_REASON_CHARS) throw badRequest("invalid_reason")
  return { disableAll, disabledModels: [...(disabledModels as string[])], reason: trimmed }
}

/** Replaces the whole `killSwitch` field of `ref` (and only that field) with the request, in one transaction with the call's audit row. */
async function storeKillSwitch(ref: DocumentReference, input: KillSwitchInput, uid: string, audit: CallAudit): Promise<KillSwitchSet> {
  await adminDb().runTransaction(async (tx) => {
    await audit.stage(tx, "allow", "ok")
    tx.set(ref, { killSwitch: { ...input, setBy: uid, setAt: FieldValue.serverTimestamp() } }, { mergeFields: ["killSwitch"] })
  })
  audit.committed()
  return { ...input, setBy: uid }
}

/**
 * setAiKillSwitch({ disableAll, disabledModels, reason }) (P3-66), partner only (`ai.kill_switch.set`). A request
 * replaces the firm's whole switch in `ai_config/{firmId}.killSwitch`; `{ disableAll: false, disabledModels: [] }`
 * re-enables. P1 reads it fresh on every call, so it takes effect on the next call.
 */
export const setAiKillSwitchOp: FirmOperation<KillSwitchSet> = {
  auth: "firm",
  kind: "general",
  action: "ai.kill_switch.set",
  target: "ai_config",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `ai_config/${caller.firmId}`
    await requirePermission(caller, "ai.kill_switch.set")
    const input = parseKillSwitch(data)
    return storeKillSwitch(firmConfigRef(caller.firmId), input, caller.uid, audit)
  },
}

/**
 * setPlatformAiKillSwitch({ disableAll, disabledModels, reason }) (P3-66): the operator's switch across every
 * firm, stored at `platform/p1.killSwitch`. Platform admin only (`platformAdmin: true` in the caller's current
 * custom claims; 403 platform_admin_only otherwise), checked before the body. Firmless, like recordGatePass.
 * Its `reason` is shown to every firm's partners in `getAiUsage` (the setter is shown as "platform"), so it must
 * never name a firm or a client.
 */
export const setPlatformAiKillSwitchOp: FirmlessOperation<KillSwitchSet> = {
  auth: "firmless",
  kind: "general",
  action: "ai.platform_kill_switch.set",
  target: "platform/p1",
  run: async ({ uid, claims }, data, audit) => {
    if (claims.platformAdmin !== true) throw new HttpError(403, "platform_admin_only")
    const input = parseKillSwitch(data)
    return storeKillSwitch(platformConfigRef(), input, uid, audit)
  },
}
