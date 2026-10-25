import { logger } from "firebase-functions"
import { MASK_POLICY_VERSION, maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { assertMinimised, providerAllowedFor } from "@/platform/p1/providerPolicy"
import { residualPII } from "@/platform/p1/residualPII"
import { classificationRank, isClassification, type Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { errorCode, logRegisteredError } from "../log"
import { budgetOf, firmConfigRef, killSwitchBlocks, learnedOverheadOf, monthRef, overheadRef, pkrRateOf, platformConfigRef, reservationRef, reservedOf, spentOf } from "./config"
import { PROVIDER_ID, bodyTokenCeiling, costMicroUsd, estimateTokens, reservationOverheadTokens } from "./costTable"
import { DECISION_RECORD_VERSION, EMBEDDING_INPUT_HASH_ALGORITHM, embeddingInputHash, exportAfterCall, exportFields } from "./decisionRecord"
import { EMBEDDING_TRANSPORT_TIMEOUT_MS, P1EmbeddingTransportError, activeEmbeddingTransport } from "./embeddingTransport"
import {
  ATTEMPT_RECORD_TIMEOUT_MS,
  COMMIT_ATTEMPT_SLACK_MS,
  COMMIT_DEADLINE_MS,
  NOTHING_STAGED,
  P1_GATEWAY_VERSION,
  RESERVE_ATTEMPT_SLACK_MS,
  RESERVE_DEADLINE_MS,
  commit,
  logLearning,
  markAttempt,
  p1TestSeam,
  recordAttemptOutcomeRetrying,
  reserve,
  settledState,
  type CommitArgs,
  type StageResult,
} from "./gateway"
import { monthKeyPkt } from "./month"
import { OPIK_TIMEOUT_MS, exportTrace, opikConfig, opikDisabledReason } from "./opik"
import { modelId, plainId } from "./transport"
import { type BlockReason, type P1Accounting, type P1Outcome } from "./types"
import { uuidv7 } from "./uuidv7"

/**
 * `callP1Embedding`: P1 for one paid embedding call from the corpus service (FA-D3C-002, spec
 * docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md, rulings R5 to R8 and R12). The corpus never
 * calls a provider itself (Layer 18 §9 rule 6); it calls `p1CorpusEmbedding` (corpusEmbedding.ts), which calls this.
 *
 * The order is callP1's (P3-61), first refusal wins: classification guard (throws); kill switch, platform then firm, on
 * the routed model; route (the corpus model name to a Gateway model, EMBEDDING_ROUTES); the outbound mask (the input,
 * `maskOutboundPII` with no party names: the corpus has no matter); provider policy (`providerAllowedFor("ai-gateway",
 * classification)`, and at rank 3 and above `assertMinimised`); price; the budget's first look; credentials. Then the
 * shared ledger code of gateway.ts: the reservation (`reserve`, with an output ceiling of 0 tokens), the provider-attempt
 * record (`markAttempt`), the transport, the attempt outcome (`recordAttemptOutcomeRetrying`), the trace (fail-open)
 * and the commit (`commit`: the usage row, the month total, threshold alerts, the audit row, the event and the
 * reservation's settlement, in one transaction). A lapsed reservation is settled by the lease reconciler like any other.
 *
 * Only the masked input reaches the transport, the trace and nothing else: no row holds input text or the vector.
 *
 * Audit F34 re-audit R1-002 (spec docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md, ruling
 * R16): every call, whatever its outcome, leaves a `p1_decisions/{usageLogId}` record staged in the same commit, as
 * `callP1` does: the hash of the masked input (`sha256/p1-embedding-input-v1`), the model and transport, the verdicts, the
 * phase timings, the cost, the caller and the corpus operation, and the trace export's state, so a failed export is
 * retried by the export reconciler. The reservation carries the record's seed, so a call that dies after dispatch gets a
 * record from the lease reconciler that matches it. Tracking the verdicts changes nothing FA-D3C decides.
 */

/** Milliseconds since `start` on the process's monotonic clock (audit F34 R7: phase timings, independent of the call's clock). */
const since = (start: number): number => Math.max(0, Math.round((performance.now() - start) * 1000) / 1000)

/** The ledger's task type for this call. */
export const EMBEDDING_TASK = "embedding" as const

/** The corpus model names P1 routes, to the Gateway model and the vector size the corpus stores (vector(1536), L17.12 #70). */
export const EMBEDDING_ROUTES: Readonly<Record<string, Readonly<{ model: string; dimensions: number }>>> = Object.freeze({
  "text-embedding-3-small": Object.freeze({ model: "openai/text-embedding-3-small", dimensions: 1536 }),
})

/** The longest input accepted, in characters: the corpus sends a title, a label and at most 2,000 body characters. */
export const MAX_EMBEDDING_INPUT_CHARS = 8000

/** The purpose recorded for the minimisation check; metadata, never sent. */
export const EMBEDDING_PURPOSE = "corpus-embedding"

/** The phases of one call after its first reads (the chat call's, with the embedding transport's 20 s): 59 s. */
export const EMBEDDING_CALL_WORST_CASE_MS =
  RESERVE_DEADLINE_MS + RESERVE_ATTEMPT_SLACK_MS + ATTEMPT_RECORD_TIMEOUT_MS + EMBEDDING_TRANSPORT_TIMEOUT_MS + ATTEMPT_RECORD_TIMEOUT_MS + OPIK_TIMEOUT_MS + COMMIT_DEADLINE_MS + COMMIT_ATTEMPT_SLACK_MS

/** A request P1 cannot route or bound (the handler answers 400): an unknown model, the wrong size, an empty or long input. */
export class P1EmbeddingRequestError extends Error {
  readonly code: "unsupported_model" | "unsupported_dimensions" | "invalid_input"

  constructor(code: P1EmbeddingRequestError["code"]) {
    super(code)
    this.name = "P1EmbeddingRequestError"
    this.code = code
  }
}

export type P1EmbeddingRequest = {
  /** The firm whose P1 ledger, budget and kill switch govern the call: server configuration, never the caller's (R6). */
  firmId: string
  /** The verified caller (a service account email), recorded on the usage row (R7). */
  caller: string
  /** F27's operation id for the embedding (64 lowercase hex), recorded on the usage row. */
  operationId: string
  /** The corpus's model name (`embedding_queue.embedding_model`). */
  corpusModel: string
  dimensions: number
  input: string
  classification: Classification
}

export type P1EmbeddingResult = {
  outcome: P1Outcome
  blockReason: BlockReason | null
  /** The vector; present only when the outcome is `ok`. */
  embedding?: number[]
  dimensions: number
  model: string
  modelReported: string | null
  inputTokens: number
  tokensEstimated: boolean
  costMicroUsd: number
  usageLogId: string
  traceId: string
  accounting: P1Accounting
  /** Counts only, by kind: what the mask redacted, and what the residual detector found in the masked input (audit F15). */
  redactionCounts: Record<string, number>
  residualCounts: Record<string, number>
}

/**
 * Test seam only, inert when `NODE_ENV` is "production": the same commit and reservation hooks gateway.ts honours
 * (`commitAttemptFailures`, `wallClock`, `unqueued`, ...), and `crashAt: "reserved" | "dispatched"`, where the call stops
 * as if its instance died, leaving the reservation for the lease reconciler.
 */
export const p1EmbeddingTestSeam: typeof p1TestSeam = {}

function seam(): typeof p1TestSeam {
  return process.env.NODE_ENV === "production" ? {} : p1EmbeddingTestSeam
}

function simulatedCrash(): Error {
  return new Error("p1EmbeddingTestSeam.crashAt")
}

/** The route for a corpus model and size, or a P1EmbeddingRequestError. Own keys only: "constructor" is not a model. */
export function routeOf(corpusModel: string, dimensions: number): { model: string; dimensions: number } {
  const route = Object.hasOwn(EMBEDDING_ROUTES, corpusModel) ? EMBEDDING_ROUTES[corpusModel] : undefined
  if (route === undefined) throw new P1EmbeddingRequestError("unsupported_model")
  if (dimensions !== route.dimensions) throw new P1EmbeddingRequestError("unsupported_dimensions")
  return route
}

/** A usage figure only when it is a non-negative integer. */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export async function callP1Embedding(req: P1EmbeddingRequest, opts?: { now?: () => number }): Promise<P1EmbeddingResult> {
  // 1. Classification guard, before any read or write.
  if (!isClassification(req?.classification)) throw new Error("P1 call omitted classification")
  const route = routeOf(req.corpusModel, req.dimensions)
  if (typeof req.input !== "string" || req.input.length === 0 || req.input.length > MAX_EMBEDDING_INPUT_CHARS) throw new P1EmbeddingRequestError("invalid_input")
  const { firmId, classification } = req
  const model = route.model
  const now = opts?.now ?? Date.now
  const t = seam()
  const startMs = Math.floor(now())
  const monthKey = monthKeyPkt(startMs)
  const traceId = uuidv7(startMs)
  const db = adminDb()
  const usageRef = db.collection("ai_usage_logs").doc()
  const configRef = firmConfigRef(firmId)
  const totalRef = monthRef(firmId, monthKey)
  const callStarted = performance.now()
  const [platformSnap, configSnap, totalSnap, overheadSnap] = await db.getAll(platformConfigRef(), configRef, totalRef, overheadRef())
  const config = configSnap.data()
  const firstReadsMs = since(callStarted)
  const maskStarted = performance.now()

  // 4. The outbound mask (R8): only the masked input is ever sent or traced.
  const mask = maskOutboundPII(req.input, { partyNames: [] })
  const maskedInput = mask.masked
  const redactionCounts = Object.fromEntries(mask.redactions.filter((r) => r.count > 0).map((r) => [r.kind, r.count]))
  const residualCounts: Record<string, number> = { ...residualPII(maskedInput) }
  // The worst case (F07): the masked input's ceiling plus the model's overhead (or a larger learned one, clamped), and no
  // output side. Null for a model without a price or overhead, which is never dispatched.
  const bodyTokens = bodyTokenCeiling(maskedInput)
  const firstLookOverhead = reservationOverheadTokens(model, learnedOverheadOf(overheadSnap.data(), model))
  const worstCase = firstLookOverhead === null ? null : costMicroUsd(model, bodyTokens + firstLookOverhead, 0)
  // Audit F34 re-audit R1-002 (R16): the hash of the masked input as sent, for the decision record; never the text.
  const inputHash = embeddingInputHash(maskedInput)
  const maskMs = since(maskStarted)

  // Audit F34 (R6, R16): each verdict the refusal below reaches, as a fixed token, for the decision record. The order and
  // the outcomes are FA-D3C's: tracking them changes nothing that is decided.
  const verdicts = {
    killSwitch: {
      platform: killSwitchBlocks(platformSnap.get("killSwitch"), model) ? ("blocks" as const) : ("clear" as const),
      firm: killSwitchBlocks(config?.killSwitch, model) ? ("blocks" as const) : ("clear" as const),
    },
    policy: providerAllowedFor(PROVIDER_ID, classification),
    minimised: null as boolean | null,
    firstLook: "not_reached" as "fits" | "exhausted" | "not_set" | "unpriced" | "not_reached",
  }
  const refusal = (): BlockReason | null => {
    if (verdicts.killSwitch.platform === "blocks") return "kill_switch_platform"
    if (verdicts.killSwitch.firm === "blocks") return "kill_switch_firm"
    const policy = verdicts.policy
    if (!policy.allowed) return "policy_denied"
    if (policy.requirements) {
      verdicts.minimised = assertMinimised({ body: maskedInput, metadata: { purpose: EMBEDDING_PURPOSE } }, [])
      if (!verdicts.minimised) return "not_minimised"
    }
    if (worstCase === null) {
      verdicts.firstLook = "unpriced"
      return "model_unpriced"
    }
    const budget = budgetOf(config)
    if (budget === null) {
      verdicts.firstLook = "not_set"
      return "budget_not_set"
    }
    if (spentOf(totalSnap.data()) + reservedOf(totalSnap.data()) + worstCase > budget) {
      verdicts.firstLook = "exhausted"
      return "budget_exhausted"
    }
    verdicts.firstLook = "fits"
    return null
  }
  let blockReason = refusal()
  const transport = blockReason === null ? activeEmbeddingTransport() : null
  // 8. Credentials.
  if (blockReason === null && transport === null) blockReason = "no_credentials"
  const credentials = transport !== null ? "present" : verdicts.firstLook === "fits" ? "absent" : "not_checked"

  // Audit F34 re-audit R1-002 (R16): what the decision record needs from before dispatch, also kept on the reservation as
  // its seed, so the lease reconciler writes a record consistent with it. No text: ids, hashes, tokens and counts. An
  // embedding has no template (no system message) and no HTTP operation; the corpus's operation is `corpusOperationId`.
  const promptRecord = {
    templateId: null,
    templateVersion: null,
    templateSha256: null,
    agentInstructionsSha256: null,
    hash: inputHash,
    hashAlgorithm: EMBEDDING_INPUT_HASH_ALGORITHM,
    messageCount: 1,
  }
  const transportId = transport === null ? null : (transport.id ?? "unidentified")
  const decisionsRecord = (reservationVerdict: string, attemptRecord: string) => ({
    killSwitch: verdicts.killSwitch,
    systemVerified: null,
    route: {
      classification,
      rank: classificationRank(classification),
      provider: PROVIDER_ID,
      allowed: verdicts.policy.allowed,
      minimisationRequired: verdicts.policy.allowed && verdicts.policy.requirements !== undefined,
      minimised: verdicts.minimised,
    },
    mask: { redactionCounts, residualCounts, partyNames: 0, policyVersion: MASK_POLICY_VERSION },
    budget: { firstLook: verdicts.firstLook, worstCaseMicroUsd: worstCase, reservation: reservationVerdict },
    credentials,
    attemptRecord,
  })
  const seedOf = () => ({
    recordVersion: DECISION_RECORD_VERSION,
    operationId: null,
    startedAtMs: startMs,
    prompt: promptRecord,
    model: { configured: model, provider: PROVIDER_ID, transport: transportId, gatewayVersion: P1_GATEWAY_VERSION },
    retrieval: { context: { state: "none", anchors: [] } },
    decisions: decisionsRecord("reserved", "not_attempted"),
    phases: { firstReadsMs, maskMs },
  })

  // 8b. The reservation (F07), on gateway.ts's own transaction: kill switches and budget re-read, the hold taken.
  const resRef = reservationRef(usageRef.id)
  let reservation: CommitArgs["reservation"] = null
  // Audit F34 (R6, R7, R16): the reservation's and the attempt record's verdicts, and each phase's time once it runs.
  let reservationVerdict = "not_attempted"
  let attemptRecord = "not_attempted"
  const phases: Record<"reserveMs" | "attemptRecordMs" | "transportMs" | "attemptOutcomeMs" | "traceMs", number | null> = {
    reserveMs: null,
    attemptRecordMs: null,
    transportMs: null,
    attemptOutcomeMs: null,
    traceMs: null,
  }
  if (blockReason === null) {
    await t.beforeReserve?.()
    const reserveStarted = performance.now()
    try {
      const decision = await reserve(db, {
        firmId,
        monthKey,
        nowMs: Math.floor(now()),
        bodyTokens,
        outputTokens: 0,
        reservationRef: resRef,
        configRef,
        totalRef,
        seam: t,
        // The caller and the corpus operation ride on the reservation, so a row the lease reconciler writes for a call
        // that died keeps them, as this call's own row does (Codex P2 on PR #118).
        fields: {
          actorId: "system",
          matterId: null,
          jobId: null,
          taskType: EMBEDDING_TASK,
          model,
          classification,
          traceId,
          caller: req.caller,
          corpusOperationId: req.operationId,
          // Audit F34 re-audit R1-002 (R16): the decision record's seed, for the lease reconciler.
          decisionSeed: seedOf(),
        },
      })
      if (decision === "reserved") reservation = { ref: resRef, state: "released", mustBeLive: false }
      else blockReason = decision
      reservationVerdict = decision
    } catch (err) {
      blockReason = "reservation_failed"
      reservationVerdict = "failed"
      reservation = { ref: resRef, state: "released", mustBeLive: false }
      logger.warn("p1.reservation_failed", { firmId, usageLogId: usageRef.id, code: errorCode(err) })
    }
    phases.reserveMs = since(reserveStarted)
  }
  if (reservation !== null && blockReason === null && t.crashAt === "reserved") throw simulatedCrash()

  // 8c. The provider attempt, recorded on the reservation before dispatch (F08): unrecorded, nothing is sent.
  if (reservation !== null && blockReason === null) {
    const markStarted = performance.now()
    try {
      await markAttempt(db, resRef, t)
      attemptRecord = "recorded"
    } catch (err) {
      blockReason = "reservation_failed"
      attemptRecord = "failed"
      logger.warn("p1.attempt_record_failed", { firmId, usageLogId: usageRef.id, code: errorCode(err) })
    }
    phases.attemptRecordMs = since(markStarted)
  }

  let outcome: P1Outcome = "blocked"
  let embedding: number[] | undefined
  let inputTokens = 0
  let tokensEstimated = false
  let cost = 0
  let dispatched = false
  let modelReported: string | null = null
  let requestId: string | undefined
  if (blockReason === null && transport !== null) {
    dispatched = true
    const sendStarted = performance.now()
    try {
      const res = await transport.embed({ model, input: maskedInput })
      phases.transportMs = since(sendStarted)
      requestId = plainId(res?.requestId)
      const reported = tokenCount(res?.inputTokens)
      inputTokens = reported ?? estimateTokens(maskedInput)
      tokensEstimated = reported === null
      cost = costMicroUsd(model, inputTokens, 0)! // step 6 refused an unpriced model
      modelReported = modelId(res?.model) ?? null
      const vector = res?.embedding
      // The provider answered, so a vector of the wrong size is a billed failure, never stored.
      if (!Array.isArray(vector) || vector.length !== route.dimensions || !vector.every((v) => typeof v === "number" && Number.isFinite(v))) {
        throw new P1EmbeddingTransportError("gateway_no_embedding", { billable: true, inputTokens: reported, requestId })
      }
      embedding = vector
      outcome = "ok"
    } catch (err) {
      outcome = "failed"
      embedding = undefined
      if (err instanceof P1EmbeddingTransportError && err.billable) {
        const reported = tokenCount(err.inputTokens)
        inputTokens = reported ?? estimateTokens(maskedInput)
        tokensEstimated = reported === null
        cost = costMicroUsd(model, inputTokens, 0)!
        requestId = plainId(err.requestId) ?? requestId
      } else {
        inputTokens = 0
        tokensEstimated = false
        cost = 0
        requestId = undefined
        modelReported = null
      }
      logger.warn("p1.transport_failed", { firmId, usageLogId: usageRef.id, traceId, code: err instanceof P1EmbeddingTransportError ? err.code : "unknown" })
    }
    if (phases.transportMs === null) phases.transportMs = since(sendStarted)
  }
  if (dispatched && t.crashAt === "dispatched") throw simulatedCrash()
  // 9b. What the provider answered and what the call is charged, on the reservation's attempt (fail-open).
  if (dispatched) {
    const outcomeStarted = performance.now()
    await recordAttemptOutcomeRetrying(db, resRef, {
      result: outcome,
      inputTokens,
      outputTokens: 0,
      tokensEstimated,
      costMicroUsd: cost,
      ...(requestId === undefined ? {} : { requestId }),
      ...(modelReported === null ? {} : { modelReported }),
      // Audit F34 re-audit R1-002 (R16): the transport's time, for a decision record the lease reconciler writes.
      ...(phases.transportMs === null ? {} : { transportMs: phases.transportMs }),
    }).catch((err: unknown) => logger.warn("p1.attempt_outcome_failed", { firmId, usageLogId: usageRef.id, code: errorCode(err) }))
    phases.attemptOutcomeMs = since(outcomeStarted)
    reservation = { ref: resRef, state: settledState(true, outcome, cost), mustBeLive: true }
  }

  // 10. The trace (P3-67), fail-open: the masked input only, never the vector. The input's hash rides only where the
  // input itself may (buildTrace, re-audit R1-001, R15).
  const traceStarted = performance.now()
  const endMs = Math.max(startMs, Math.floor(now()))
  // Re-audit R1-009 (R23): read once, so the record can say why a disabled export was disabled.
  const opik = opikConfig()
  const status = await exportTrace({
    traceId,
    startMs,
    endMs,
    taskType: EMBEDDING_TASK,
    classification,
    outcome,
    blockReason,
    model,
    provider: PROVIDER_ID,
    inputTokens,
    outputTokens: 0,
    costMicroUsd: cost,
    firmId,
    matterId: null,
    usageLogId: usageRef.id,
    maskedBody: outcome === "blocked" ? null : maskedInput,
    system: null,
    maskedResponse: null,
    promptHash: inputHash,
    promptTemplateId: null,
    promptTemplateVersion: null,
    modelReported,
  }, opik)
  phases.traceMs = since(traceStarted)
  if (status === "failed") logger.warn("p1.trace_export_failed", { firmId, usageLogId: usageRef.id, traceId })

  // 11. One transaction: the usage row, the month total, alerts, the audit row, the event, the reservation's settlement.
  const rate = pkrRateOf(config)
  const record = {
    firmId,
    actorId: "system",
    matterId: null,
    jobId: null,
    taskType: EMBEDDING_TASK,
    provider: PROVIDER_ID,
    model,
    modelReported,
    classification,
    outcome,
    blockReason,
    inputTokens,
    outputTokens: 0,
    tokensEstimated,
    costMicroUsd: cost,
    fxPkrPerUsd: rate,
    costPkr: rate === null ? null : Math.round((cost * rate) / 10_000) / 100,
    monthKey,
    trace: { id: traceId, status },
    // FA-D3C-002 (R7): who called, and the corpus operation the charge belongs to (its F27 receipt carries the same id).
    caller: req.caller,
    corpusOperationId: req.operationId,
  }
  // Audit F34 re-audit R1-002 (R1, R2, R16): the decision record, staged in the commit transaction beside the usage row it
  // explains, for every outcome (ok, failed and every block). No text and no vector.
  const decision: Record<string, unknown> = {
    recordVersion: DECISION_RECORD_VERSION,
    traceId,
    usageLogId: usageRef.id,
    firmId,
    actorId: "system",
    matterId: null,
    jobId: null,
    taskType: EMBEDDING_TASK,
    classification,
    operationId: null,
    caller: req.caller,
    corpusOperationId: req.operationId,
    outcome,
    blockReason,
    startedAtMs: startMs,
    endedAtMs: endMs,
    prompt: promptRecord,
    model: {
      configured: model,
      reported: modelReported,
      revisionStatus: modelReported === null ? "unreported" : "reported",
      provider: PROVIDER_ID,
      transport: transportId,
      gatewayVersion: P1_GATEWAY_VERSION,
      responseId: null,
      requestId: requestId ?? null,
    },
    retrieval: { context: { state: "none", anchors: [] } },
    decisions: decisionsRecord(reservationVerdict, attemptRecord),
    phases: { firstReadsMs, maskMs, ...phases, settleStartedAtMs: Date.now() },
    cost: {
      inputTokens,
      outputTokens: 0,
      tokensEstimated,
      costMicroUsd: cost,
      monthKey,
      spendRecord: `ai_usage_months/${firmId}_${monthKey}`,
      reservation: reservationVerdict === "not_attempted" ? null : `ai_reservations/${usageRef.id}`,
    },
    export: exportFields(exportAfterCall(status, endMs, opikDisabledReason(opik))),
    settledBy: "gateway",
  }
  let staged: StageResult = { ...NOTHING_STAGED, crossings: [] }
  let accounting: P1Accounting = "pending"
  try {
    staged = await commit(db, { usageRef, configRef, totalRef, record, traceId, failCommit: t.failCommit === true, seam: t, reservation, decision })
    accounting = "settled"
  } catch (err) {
    logRegisteredError("p1.usage_log_failed", { usageLogId: usageRef.id, ...record, accounting, code: errorCode(err) })
  }
  for (const c of staged.crossings) logger.warn("p1.budget_threshold", { firmId, monthKey, ...c })
  if (staged.exceeded !== null) logRegisteredError("p1.reservation_exceeded", { firmId, usageLogId: usageRef.id, monthKey, ...staged.exceeded })
  logLearning(usageRef.id, firmId, staged)

  return {
    outcome,
    blockReason,
    ...(outcome === "ok" && embedding !== undefined ? { embedding } : {}),
    dimensions: route.dimensions,
    model,
    modelReported,
    inputTokens,
    tokensEstimated,
    costMicroUsd: cost,
    usageLogId: usageRef.id,
    traceId,
    accounting,
    redactionCounts,
    residualCounts,
  }
}
