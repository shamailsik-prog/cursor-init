import { FieldValue, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { applyMap, assertPseudonymised, pseudonymise, type PseudonymMap } from "@/platform/p1/pseudonymiseOutboundPII"
import { assertMinimised, providerAllowedFor } from "@/platform/p1/providerPolicy"
import { isClassification, type Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { isContentionAbort } from "../d1/contention"
import { FUNCTION_TIMEOUT_SECONDS } from "../health"
import { errorCode } from "../log"
import { stageAudit } from "../p5/audit"
import { THRESHOLDS, alertRef, budgetOf, firmConfigRef, killSwitchBlocks, monthRef, pkrRateOf, platformConfigRef, spentOf } from "./config"
import { MAX_OUTPUT_TOKENS, PROVIDER_ID, TASK_MODEL, costMicroUsd, estimateTokens } from "./costTable"
import { monthKeyPkt } from "./month"
import { OPIK_TIMEOUT_MS, exportTrace } from "./opik"
import { P1TransportError, TRANSPORT_TIMEOUT_MS, activeTransport, isTransportCode, type TransportCode } from "./transport"
import { TRANSPORT_ERROR, type BlockReason, type P1Outcome, type TaskType } from "./types"
import { uuidv7 } from "./uuidv7"

/**
 * `callP1`, the single chokepoint for every AI call (spec P3-61). It decides in this order, and the first
 * refusal wins: classification guard, kill switch (platform, then firm), route, outbound mask, provider
 * policy, price, budget, credentials; then the transport call and the response mask; then the trace; then
 * one transaction writing the usage row, the month total, any threshold alerts, the audit row and the event.
 *
 * No raw body, purpose or response text reaches the transport, the trace, a row, an event, an audit row or a
 * log line, and no provider error text is returned, stored or logged.
 *
 * A request with `pseudonymise` swaps the lossy mask of the body and of the answer for the indexed pseudonymiser
 * (E-52(c); P4B-6): the transport, the trace and every row carry tokens only, and the map from token to value is
 * returned on an `ok` result, to the in-process caller only. It is never stored, traced, logged or put in an error.
 */

export type P1Request = {
  firmId: string
  actorId: string
  matterId: string | null
  jobId: string | null
  taskType: TaskType
  classification: Classification
  body: string
  purpose: string
  partyNames?: string[]
  /**
   * Present: the body and the answer go through the indexed pseudonymiser instead of the lossy mask, with these
   * strings (exact match) pseudonymised first. The purpose keeps the lossy mask; it is never sent.
   */
  pseudonymise?: { verbatim: readonly string[] }
}

export type P1Result = {
  outcome: P1Outcome
  blockReason: BlockReason | null
  /** The masked response; present only when the outcome is `ok`. With `pseudonymise`, it holds tokens, not values. */
  text?: string
  /**
   * True when the call is `ok` and the provider's finish reason is anything but "stop" (an absent one included): the
   * answer may be cut short (P4B-5). False on a blocked or failed call. Charging, rows, events and traces do not change.
   */
  truncated: boolean
  /**
   * The token map of a pseudonymised request, present only on its `ok` result. It holds the caller's own values: use
   * it in process, with `rehydrate`, and never store, trace, log or return it.
   */
  pseudonyms?: PseudonymMap
  usageLogId: string
  traceId: string
  model: string
  classification: Classification
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  /** What was (or would have been) sent: the masked body and purpose, and the body's redaction counts (a pseudonymised body's include `verbatim`). */
  outbound: { body: string; purpose: string; redactionCounts: Record<string, number> }
}

/**
 * Test seam only; production code never sets it, and it is inert when `NODE_ENV` is "production".
 * `beforeCommit` runs after the trace and before the commit transaction; `failCommit` makes that transaction
 * fail; `modelOverride` routes the call to that model id (ruling R2). `wallClock` replaces `Date.now` as the
 * commit deadline's clock; `commitAttemptFailures` is a queue: each commit transaction attempt takes the next
 * error from it and throws it before staging anything; `lostCommitAnswers` is a queue too: each commit attempt
 * whose transaction committed takes the next error from it and throws it, as if the commit's answer were lost.
 */
export const p1TestSeam: {
  beforeCommit?: () => Promise<void>
  failCommit?: boolean
  modelOverride?: string
  wallClock?: () => number
  commitAttemptFailures?: Error[]
  lostCommitAnswers?: Error[]
} = {}

function seam(): typeof p1TestSeam {
  return process.env.NODE_ENV === "production" ? {} : p1TestSeam
}

/**
 * How long the commit may go on retrying, on the real clock from the start of the commit phase (M3), like
 * `CONTENTION_DEADLINE_MS` in d1/contention.ts. Once it has passed, no new attempt starts: the commit fails
 * with `commit_deadline`, and unless the usage row turns out to exist, the call logs `p1.usage_log_failed` and
 * returns its result.
 *
 * P1 paces the retries itself: each attempt is one SDK transaction (`maxAttempts: 1`), so the SDK never waits
 * before a retry. Its own back-off waits up to about 25 s before a tenth attempt and resets to 60 s (±50 %) after
 * RESOURCE_EXHAUSTED, either of which would carry a commit past any deadline and, after a 60 s transport call
 * and a 2 s trace export, past the 120 s function timeout with no record at all. P1's waits never run past the
 * deadline, so the worst case is the deadline plus one attempt in flight (COMMIT_ATTEMPT_SLACK_MS).
 */
export const COMMIT_DEADLINE_MS = 30_000
/** The longest one commit attempt (two reads and a commit) is allowed for in the timeout budget. */
export const COMMIT_ATTEMPT_SLACK_MS = 10_000
/** Back-off between attempts: 100 ms doubling to this cap, with ±50 % jitter, and never past the deadline. */
export const COMMIT_BACKOFF_CAP_MS = 2_000
const COMMIT_BACKOFF_BASE_MS = 100
/** Parallel calls in one firm contend on the month total; the deadline, not this count, normally ends a retry run. */
const COMMIT_MAX_ATTEMPTS = 30

if (!(TRANSPORT_TIMEOUT_MS + OPIK_TIMEOUT_MS + COMMIT_DEADLINE_MS + COMMIT_ATTEMPT_SLACK_MS < FUNCTION_TIMEOUT_SECONDS * 1000)) {
  throw new Error(
    `transport (${TRANSPORT_TIMEOUT_MS} ms), trace (${OPIK_TIMEOUT_MS} ms), commit (${COMMIT_DEADLINE_MS} ms) and one attempt (${COMMIT_ATTEMPT_SLACK_MS} ms) must fit in the function timeout (${FUNCTION_TIMEOUT_SECONDS} s)`
  )
}

/** The codes the SDK itself retries a transaction on (ABORTED, CANCELLED, UNKNOWN, DEADLINE_EXCEEDED, INTERNAL, UNAVAILABLE, UNAUTHENTICATED, RESOURCE_EXHAUSTED), plus an expired or dead transaction. */
const RETRYABLE_COMMIT_CODES: ReadonlySet<number> = new Set([10, 1, 2, 4, 13, 14, 16, 8])

function isRetryableCommitError(err: unknown): boolean {
  if (isContentionAbort(err)) return true
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (typeof code === "number") return RETRYABLE_COMMIT_CODES.has(code) || (code === 3 && /transaction has expired/.test(err.message))
  return false
}

function commitBackoffMs(attempt: number): number {
  const base = Math.min(COMMIT_BACKOFF_BASE_MS * 2 ** (attempt - 1), COMMIT_BACKOFF_CAP_MS)
  return Math.round(base * (0.5 + Math.random()))
}

/** The commit ran out of time (COMMIT_DEADLINE_MS): logged with this fixed code. */
function commitDeadlineError(): Error {
  return Object.assign(new Error("P1 commit deadline passed"), { code: "commit_deadline" })
}

const EVENT_SUFFIX: Readonly<Record<P1Outcome, string>> = { ok: "completed", failed: "failed", blocked: "blocked" }

type Threshold = (typeof THRESHOLDS)[number]
type Crossing = { threshold: Threshold; budgetMicroUsd: number; spentMicroUsd: number }

/** A usage figure only when it is a non-negative integer; anything else is "no usage" and gets estimated (P3-62). */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** gRPC ALREADY_EXISTS (6), or its string form: a `create` found its document already there. */
export function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 6 || (typeof code === "string" && code.toLowerCase() === "already-exists")
}

/** A P1TransportError's fixed code; anything else (another transport's own error) is logged as "unknown", never its message. */
function transportCode(err: unknown): TransportCode | "unknown" {
  return err instanceof P1TransportError && isTransportCode(err.code) ? err.code : "unknown"
}

export async function callP1(req: P1Request, opts?: { now?: () => number }): Promise<P1Result> {
  // 1. Classification guard (L8473), before any read or write.
  if (!isClassification(req?.classification)) throw new Error("P1 call omitted classification")
  const { firmId, classification, taskType, partyNames } = req
  const now = opts?.now ?? Date.now
  const t = seam()
  const startMs = Math.floor(now())
  const monthKey = monthKeyPkt(startMs)
  const traceId = uuidv7(startMs)
  const db = adminDb()
  const usageRef = db.collection("ai_usage_logs").doc()
  const configRef = firmConfigRef(firmId)
  const totalRef = monthRef(firmId, monthKey)

  // Both kill switches, the firm's config and the month total, fresh on every call and outside the
  // commit transaction (P3-66: no cache, so a switch takes effect on the next call).
  const [platformSnap, configSnap, totalSnap] = await db.getAll(platformConfigRef(), configRef, totalRef)
  const config = configSnap.data()

  // 3. Route (P3-62). 4. Mask the body and the purpose with the party names; a pseudonymised body is tokenised
  // instead (P4B-6), and the purpose keeps the lossy mask.
  const model = t.modelOverride ?? (Object.hasOwn(TASK_MODEL, taskType) ? TASK_MODEL[taskType] : "")
  const pseudo = req.pseudonymise ? pseudonymise(req.body, { partyNames, verbatim: req.pseudonymise.verbatim }) : null
  let outboundBody: string
  let redactionCounts: Record<string, number>
  if (pseudo) {
    outboundBody = pseudo.text
    redactionCounts = pseudo.redactionCounts
  } else {
    const bodyMask = maskOutboundPII(req.body, { partyNames })
    outboundBody = bodyMask.masked
    redactionCounts = Object.fromEntries(bodyMask.redactions.map((r) => [r.kind, r.count]))
  }
  const outbound = {
    body: outboundBody,
    purpose: maskOutboundPII(req.purpose, { partyNames }).masked,
    redactionCounts,
  }

  /**
   * Rank 3 and above (step 5). A pseudonymised body is checked by `assertPseudonymised`, which blanks its tokens first
   * (`assertMinimised` would find `Tim` in `⟦VERBATIM_1⟧`), and its purpose, still the lossy-masked one, by `assertMinimised`
   * on its own; any other body and purpose by `assertMinimised`, as before.
   */
  const minimised = (): boolean =>
    pseudo
      ? assertPseudonymised(outbound.body, partyNames) && assertMinimised({ body: "", metadata: { purpose: outbound.purpose } }, partyNames)
      : assertMinimised({ body: outbound.body, metadata: { purpose: outbound.purpose } }, partyNames)

  /** Steps 2 and 5 to 7, in order; the first refusal wins. */
  const refusal = (): BlockReason | null => {
    if (killSwitchBlocks(platformSnap.get("killSwitch"), model)) return "kill_switch_platform"
    if (killSwitchBlocks(config?.killSwitch, model)) return "kill_switch_firm"
    const policy = providerAllowedFor(PROVIDER_ID, classification)
    if (!policy.allowed) return "policy_denied"
    if (policy.requirements && !minimised()) return "not_minimised"
    if (costMicroUsd(model, 0, 0) === null) return "model_unpriced"
    const budget = budgetOf(config)
    if (budget === null) return "budget_not_set"
    if (spentOf(totalSnap.data()) >= budget) return "budget_exhausted"
    return null
  }
  let blockReason = refusal()
  const transport = blockReason === null ? activeTransport() : null
  // 8. Credentials.
  if (blockReason === null && transport === null) blockReason = "no_credentials"

  let outcome: P1Outcome = "blocked"
  let text: string | undefined
  let finishReason: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  let tokensEstimated = false
  let cost = 0
  if (blockReason === null && transport !== null) {
    // 9. The transport call, then the response mask (P3-68).
    try {
      const res = await transport.send({ model, body: outbound.body, maxTokens: MAX_OUTPUT_TOKENS })
      // A response came back without text: billed like the Gateway's own gateway_no_text, on the usage it reported.
      if (typeof res?.text !== "string") {
        throw new P1TransportError("gateway_no_text", { billable: true, inputTokens: tokenCount(res?.inputTokens), outputTokens: tokenCount(res?.outputTokens) })
      }
      // A pseudonymised answer keeps the tokens it holds, maps a value it spells out to its token, and turns any other
      // pattern match into a lossy token; otherwise the lossy mask.
      const masked = pseudo ? applyMap(res.text, pseudo.map, { partyNames }) : maskOutboundPII(res.text, { partyNames }).masked
      const reportedIn = tokenCount(res.inputTokens)
      const reportedOut = tokenCount(res.outputTokens)
      // Each side is estimated from what was billed: the input from the masked body that was sent, the output from
      // the raw response the provider produced (masking shortens it). The raw text is used for this count only; the
      // masked text is the only one returned, stored, traced or logged.
      inputTokens = reportedIn ?? estimateTokens(outbound.body)
      outputTokens = reportedOut ?? estimateTokens(res.text)
      tokensEstimated = reportedIn === null || reportedOut === null
      cost = costMicroUsd(model, inputTokens, outputTokens)! // step 6 refused an unpriced model
      text = masked
      finishReason = typeof res.finishReason === "string" ? res.finishReason : null
      outcome = "ok"
    } catch (err) {
      outcome = "failed"
      // I1: a failure the provider may have billed is charged, conservatively: the reported usage where the
      // response gave a valid count, else the estimated input and the MAX_OUTPUT_TOKENS ceiling. A failure that
      // cannot have been billed (a non-2xx, a request that never left, any error that is not a billable
      // P1TransportError) is charged 0.
      if (err instanceof P1TransportError && err.billable) {
        const reportedIn = tokenCount(err.inputTokens)
        const reportedOut = tokenCount(err.outputTokens)
        inputTokens = reportedIn ?? estimateTokens(outbound.body)
        outputTokens = reportedOut ?? MAX_OUTPUT_TOKENS
        tokensEstimated = reportedIn === null || reportedOut === null
        cost = costMicroUsd(model, inputTokens, outputTokens)! // step 6 refused an unpriced model
      } else {
        inputTokens = 0
        outputTokens = 0
        tokensEstimated = false
        cost = 0
      }
      logger.warn("p1.transport_failed", { firmId, usageLogId: usageRef.id, traceId, code: transportCode(err) })
    }
  }

  // 10. Trace (P3-67): fail-open; the masked text rides along only where buildTrace allows it.
  const status = await exportTrace({
    traceId,
    startMs,
    endMs: Math.max(startMs, Math.floor(now())),
    taskType,
    classification,
    outcome,
    blockReason,
    model,
    provider: PROVIDER_ID,
    inputTokens,
    outputTokens,
    costMicroUsd: cost,
    firmId,
    matterId: req.matterId ?? null,
    usageLogId: usageRef.id,
    maskedBody: outcome === "blocked" ? null : outbound.body,
    maskedResponse: text ?? null,
  })
  if (status === "failed") logger.warn("p1.trace_export_failed", { firmId, usageLogId: usageRef.id, traceId })

  // 11. One transaction: the usage row, the month total, any threshold alerts, the audit row and the event.
  const rate = pkrRateOf(config)
  const record = {
    firmId,
    actorId: req.actorId,
    matterId: req.matterId ?? null,
    jobId: req.jobId ?? null,
    taskType,
    provider: PROVIDER_ID,
    model,
    classification,
    outcome,
    blockReason,
    inputTokens,
    outputTokens,
    tokensEstimated,
    costMicroUsd: cost,
    fxPkrPerUsd: rate,
    costPkr: rate === null ? null : Math.round((cost * rate) / 10_000) / 100,
    monthKey,
    trace: { id: traceId, status },
  }
  let crossings: Crossing[] = []
  try {
    await t.beforeCommit?.()
    crossings = await commit(db, { usageRef, configRef, totalRef, record, traceId, failCommit: t.failCommit === true, seam: t })
  } catch (err) {
    // The spend has happened: the result is still returned, and the log keeps the record (P3-63).
    logger.error("p1.usage_log_failed", { usageLogId: usageRef.id, ...record, code: errorCode(err) })
  }
  for (const c of crossings) logger.warn("p1.budget_threshold", { firmId, monthKey, ...c })

  return {
    outcome,
    blockReason,
    ...(outcome === "ok" ? { text } : {}),
    truncated: outcome === "ok" && finishReason !== "stop",
    ...(outcome === "ok" && pseudo ? { pseudonyms: pseudo.map } : {}),
    usageLogId: usageRef.id,
    traceId,
    model,
    classification,
    inputTokens,
    outputTokens,
    costMicroUsd: cost,
    outbound,
  }
}

type UsageRecord = {
  firmId: string
  actorId: string
  taskType: TaskType
  model: string
  classification: Classification
  outcome: P1Outcome
  blockReason: BlockReason | null
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  monthKey: string
} & Record<string, unknown>

type CommitArgs = {
  usageRef: DocumentReference
  configRef: DocumentReference
  totalRef: DocumentReference
  record: UsageRecord
  traceId: string
  failCommit: boolean
  seam: typeof p1TestSeam
}

/**
 * Writes one decision in one transaction (P3-63, P3-65, P3-69) and returns the thresholds it crossed. The
 * transaction reads the month total and the firm's config to decide crossings on its own budget and spend
 * (`before*100 < t*budget <= after*100`), and skips a threshold whose alert already exists, so each fires
 * once per firm per month and a raised budget never re-arms one. A retryable failure is retried on P1's own
 * back-off (see COMMIT_DEADLINE_MS) until COMMIT_MAX_ATTEMPTS or the deadline. The usage row's `tx.create`
 * makes a retry after an unseen commit fail with ALREADY_EXISTS rather than double-count. Before any failure
 * is reported, the usage row is read: a commit found done returns the crossings its alert docs record, so an
 * unseen commit is never logged as a failure.
 */
async function commit(db: Firestore, args: CommitArgs): Promise<Crossing[]> {
  const clock = args.seam.wallClock ?? Date.now
  const started = clock()
  const remaining = () => COMMIT_DEADLINE_MS - (clock() - started)
  let failure: unknown = commitDeadlineError()
  for (let attempt = 1; attempt <= COMMIT_MAX_ATTEMPTS; attempt++) {
    if (remaining() <= 0) {
      failure = commitDeadlineError()
      break
    }
    try {
      const crossings = await db.runTransaction(
        (tx) => {
          const injected = args.seam.commitAttemptFailures?.shift()
          if (injected) throw injected
          return stage(db, tx, args)
        },
        { maxAttempts: 1 }
      )
      const lost = args.seam.lostCommitAnswers?.shift()
      if (lost) throw lost
      return crossings
    } catch (err) {
      failure = err
      if (isAlreadyExists(err) || !isRetryableCommitError(err)) break
      const wait = Math.min(commitBackoffMs(attempt), remaining())
      if (wait <= 0) {
        failure = commitDeadlineError()
        break
      }
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  const done = await committedCrossings(db, args)
  if (done !== null) return done
  throw failure
}

/**
 * After an ALREADY_EXISTS: null unless this call's usage row is there (an earlier attempt's commit landed and
 * its answer was lost); otherwise the thresholds that commit crossed, read back from the alert docs it wrote.
 */
async function committedCrossings(db: Firestore, a: CommitArgs): Promise<Crossing[] | null> {
  try {
    const { firmId, monthKey } = a.record
    const [usage, ...alerts] = await db.getAll(a.usageRef, ...THRESHOLDS.map((t) => alertRef(firmId, monthKey, t)))
    if (!usage!.exists || usage!.get("trace.id") !== a.traceId) return null
    return alerts.flatMap((snap, i) =>
      snap.exists && snap.get("usageLogId") === a.usageRef.id
        ? [{ threshold: THRESHOLDS[i]!, budgetMicroUsd: snap.get("budgetMicroUsd") as number, spentMicroUsd: snap.get("spentMicroUsd") as number }]
        : []
    )
  } catch {
    return null
  }
}

async function stage(db: Firestore, tx: Transaction, a: CommitArgs): Promise<Crossing[]> {
  const { record: r, usageRef } = a
  const [totalSnap, configSnap] = await tx.getAll(a.totalRef, a.configRef)
  const before = spentOf(totalSnap.data())
  const after = before + r.costMicroUsd
  const budget = budgetOf(configSnap.data())
  const candidates = budget === null ? [] : THRESHOLDS.filter((t) => before * 100 < t * budget && t * budget <= after * 100)
  const alertSnaps = candidates.length > 0 ? await tx.getAll(...candidates.map((t) => alertRef(r.firmId, r.monthKey, t))) : []
  const crossed = candidates.filter((_t, i) => !alertSnaps[i]!.exists)
  if (a.failCommit) throw new Error("p1TestSeam.failCommit")

  const now = FieldValue.serverTimestamp()
  const inc = (n: number) => FieldValue.increment(n)
  tx.create(usageRef, { ...r, createdAt: now })
  // Spend and tokens move by the record's own figures, by one rule for every outcome: an ok call and a billed
  // failure add their charge (I1); a blocked call and an unbilled failure add 0, so only their `calls` counter moves.
  tx.set(
    a.totalRef,
    {
      firmId: r.firmId,
      monthKey: r.monthKey,
      spentMicroUsd: inc(r.costMicroUsd),
      inputTokens: inc(r.inputTokens),
      outputTokens: inc(r.outputTokens),
      calls: { ok: inc(r.outcome === "ok" ? 1 : 0), failed: inc(r.outcome === "failed" ? 1 : 0), blocked: inc(r.outcome === "blocked" ? 1 : 0) },
      updatedAt: now,
    },
    { merge: true }
  )
  stageAudit(
    {
      firmId: r.firmId,
      actorId: r.actorId,
      action: "ai.gateway.decision",
      target: `ai_usage_logs/${usageRef.id}`,
      classification: r.classification,
      decision: r.outcome === "ok" ? "allow" : "deny",
      reason: r.outcome === "ok" ? "ok" : r.outcome === "failed" ? TRANSPORT_ERROR : (r.blockReason ?? TRANSPORT_ERROR),
    },
    tx
  )
  const suffix = EVENT_SUFFIX[r.outcome]
  tx.create(db.collection("events").doc(`${usageRef.id}_${suffix}`), {
    name: `ai.call.${suffix}`,
    firmId: r.firmId,
    payload: {
      traceId: a.traceId,
      task: r.taskType,
      model: r.model,
      classification: r.classification,
      costMicroUsd: r.costMicroUsd,
      ...(r.blockReason === null ? {} : { blockReason: r.blockReason }),
    },
    classification: r.classification,
    occurredAt: now,
    idempotencyKey: `${usageRef.id}:${suffix}`,
  })

  return crossed.map((threshold) => {
    const ref = alertRef(r.firmId, r.monthKey, threshold)
    const crossing: Crossing = { threshold, budgetMicroUsd: budget!, spentMicroUsd: after }
    tx.create(ref, { firmId: r.firmId, monthKey: r.monthKey, ...crossing, usageLogId: usageRef.id, createdAt: now })
    stageAudit(
      { firmId: r.firmId, actorId: "system", action: "ai.budget.threshold", target: `ai_budget_alerts/${ref.id}`, classification: "internal", decision: "allow", reason: String(threshold) },
      tx
    )
    const key = `threshold_${threshold}`
    tx.create(db.collection("events").doc(`${usageRef.id}_${key}`), {
      name: "ai.budget.threshold_crossed",
      firmId: r.firmId,
      payload: { monthKey: r.monthKey, threshold, budgetMicroUsd: crossing.budgetMicroUsd, spentMicroUsd: after },
      classification: "internal",
      occurredAt: now,
      idempotencyKey: `${usageRef.id}:${key}`,
    })
    return crossing
  })
}
