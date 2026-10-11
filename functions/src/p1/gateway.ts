import { FieldValue, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised, providerAllowedFor } from "@/platform/p1/providerPolicy"
import { isClassification, type Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { isContentionAbort } from "../d1/contention"
import { errorCode } from "../log"
import { stageAudit } from "../p5/audit"
import { THRESHOLDS, alertRef, budgetOf, firmConfigRef, killSwitchBlocks, monthRef, pkrRateOf, platformConfigRef, spentOf } from "./config"
import { MAX_OUTPUT_TOKENS, PROVIDER_ID, TASK_MODEL, costMicroUsd, estimateTokens } from "./costTable"
import { monthKeyPkt } from "./month"
import { exportTrace } from "./opik"
import { activeTransport } from "./transport"
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
}

export type P1Result = {
  outcome: P1Outcome
  blockReason: BlockReason | null
  /** The masked response; present only when the outcome is `ok`. */
  text?: string
  usageLogId: string
  traceId: string
  model: string
  classification: Classification
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  /** What was (or would have been) sent: the masked body and purpose, and the body's redaction counts. */
  outbound: { body: string; purpose: string; redactionCounts: Record<string, number> }
}

/**
 * Test seam only; production code never sets it, and it is inert when `NODE_ENV` is "production".
 * `beforeCommit` runs after the trace and before the commit transaction; `failCommit` makes that transaction
 * fail; `modelOverride` routes the call to that model id (ruling R2).
 */
export const p1TestSeam: { beforeCommit?: () => Promise<void>; failCommit?: boolean; modelOverride?: string } = {}

function seam(): typeof p1TestSeam {
  return process.env.NODE_ENV === "production" ? {} : p1TestSeam
}

/** Parallel calls in one firm contend on the month total: more attempts than the SDK default of 5, like registerClient. */
const COMMIT_TX_ATTEMPTS = 10
/** Fresh transactions after one gives up under contention; the usage row's fixed id makes a re-run safe. */
const COMMIT_ROUNDS = 3

/** The fixed messages `transport.ts` throws carry no provider text; they are logged as a code, anything else as "unknown". */
const TRANSPORT_CODES = /^gateway (?:status \d{3}|timeout|request failed|response is not JSON|response has no message content)$/

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

function transportCode(err: unknown): string {
  const message = err instanceof Error ? err.message : ""
  return TRANSPORT_CODES.test(message) ? message : "unknown"
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

  // 3. Route (P3-62). 4. Mask the body and the purpose with the party names.
  const model = t.modelOverride ?? (Object.hasOwn(TASK_MODEL, taskType) ? TASK_MODEL[taskType] : "")
  const bodyMask = maskOutboundPII(req.body, { partyNames })
  const outbound = {
    body: bodyMask.masked,
    purpose: maskOutboundPII(req.purpose, { partyNames }).masked,
    redactionCounts: Object.fromEntries(bodyMask.redactions.map((r) => [r.kind, r.count])),
  }

  /** Steps 2 and 5 to 7, in order; the first refusal wins. */
  const refusal = (): BlockReason | null => {
    if (killSwitchBlocks(platformSnap.get("killSwitch"), model)) return "kill_switch_platform"
    if (killSwitchBlocks(config?.killSwitch, model)) return "kill_switch_firm"
    const policy = providerAllowedFor(PROVIDER_ID, classification)
    if (!policy.allowed) return "policy_denied"
    if (policy.requirements && !assertMinimised({ body: outbound.body, metadata: { purpose: outbound.purpose } }, partyNames)) return "not_minimised"
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
  let inputTokens = 0
  let outputTokens = 0
  let tokensEstimated = false
  let cost = 0
  if (blockReason === null && transport !== null) {
    // 9. The transport call, then the response mask (P3-68).
    try {
      const res = await transport.send({ model, body: outbound.body, maxTokens: MAX_OUTPUT_TOKENS })
      if (typeof res?.text !== "string") throw new Error("transport returned no text")
      const masked = maskOutboundPII(res.text, { partyNames }).masked
      const reportedIn = tokenCount(res.inputTokens)
      const reportedOut = tokenCount(res.outputTokens)
      inputTokens = reportedIn ?? estimateTokens(outbound.body)
      outputTokens = reportedOut ?? estimateTokens(masked)
      tokensEstimated = reportedIn === null || reportedOut === null
      cost = costMicroUsd(model, inputTokens, outputTokens)! // step 6 refused an unpriced model
      text = masked
      outcome = "ok"
    } catch (err) {
      outcome = "failed"
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
    crossings = await commit(db, { usageRef, configRef, totalRef, record, traceId, failCommit: t.failCommit === true })
  } catch (err) {
    // The spend has happened: the result is still returned, and the log keeps the record (P3-63).
    logger.error("p1.usage_log_failed", { usageLogId: usageRef.id, ...record, code: errorCode(err) })
  }
  for (const c of crossings) logger.warn("p1.budget_threshold", { firmId, monthKey, ...c })

  return {
    outcome,
    blockReason,
    ...(outcome === "ok" ? { text } : {}),
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
}

/**
 * Writes one decision in one transaction (P3-63, P3-65, P3-69) and returns the thresholds it crossed. The
 * transaction reads the month total and the firm's config to decide crossings on its own budget and spend
 * (`before*100 < t*budget <= after*100`), and skips a threshold whose alert already exists, so each fires
 * once per firm per month and a raised budget never re-arms one. A round that gives up under contention is
 * re-run; the usage row's `tx.create` makes a re-run after an unseen commit fail rather than double-count.
 */
async function commit(db: Firestore, args: CommitArgs): Promise<Crossing[]> {
  for (let round = 1; ; round++) {
    try {
      return await db.runTransaction((tx) => stage(db, tx, args), { maxAttempts: COMMIT_TX_ATTEMPTS })
    } catch (err) {
      if (round >= COMMIT_ROUNDS || !isContentionAbort(err)) throw err
    }
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
  // A blocked or failed call adds 0 to spend and tokens: only its `calls` counter moves.
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
