import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore } from "firebase-admin/firestore"
import { PROMPT_TEMPLATE_PINS, promptHash, sha256Hex } from "@/platform/p1/promptTemplates"
import { systemPolicyText } from "@/platform/p1/systemPolicy"
import type { Bench, TreatmentFact } from "@/services/d4-2/citationVerdict"
import { adminDb } from "../admin"
import { plainId } from "./transport"

/**
 * The P1 decision record (audit F34; spec docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md,
 * rulings R1 to R13): one server-only document per P1 attempt, `p1_decisions/{usageLogId}`, keyed like the usage row,
 * the reservation and the events, holding what an operator needs to reconstruct the decision without any text:
 *
 * - `prompt`: the registered template (id, version, pinned SHA-256) and the hash of the masked messages as sent (R3);
 * - `model`: the configured model, the revision the provider reported (or `unreported`), the provider, the transport
 *   and the gateway version, and the provider's own ids (R4);
 * - `retrieval`: the anchors the caller put into the prompt (`context`) and the corpus judgments that graded the answer
 *   (`verification`, merged by the committee publisher), each with a hash of the facts that were read (R5);
 * - `decisions`: the kill-switch, system-message, route, mask, budget, reservation and credential verdicts (R6);
 * - `phases`: the time each stage took (R7); `cost`: the charge and the spend records it moved (R8);
 * - `approval` (R9), `output` (the committee output it was published as), `export` (R11), `settledBy`, `settledAt`.
 * - Round 2 (FA-F34-R2-003, spec R37): `prompt.hashWithholdAtMs` on a record above rank 1 until its output is published,
 *   and `prompt.hashWithheld` with `prompt.hash: null` once that time passed with no output row (`withholdUnpublishedPromptHashes`
 *   in traceExport.ts).
 *
 * It is staged in the call's commit transaction (gateway.ts `stage`), or by the lease reconciler from the reservation's
 * `decisionSeed` when the call never committed (R2); the publisher and the export reconciler merge their fields in their
 * own transactions. Every writer uses `set(..., { merge: true })` on its own fields, so their order does not matter.
 */

export const DECISIONS_COLLECTION = "p1_decisions"
/**
 * The record's own format version; also stamped on every trace (R10). f34.2 (re-audit R1 follow-up, spec section 5) adds
 * `decisions.mask.policyVersion` (R25), `export.disabledReason` (R23), `decisions.fromSeed` on a reconciled record (R21) and
 * the embedding path's records with `caller` and `corpusOperationId` (R16). f34.3 (round-2 follow-up, spec section 6, R37)
 * adds `prompt.hashWithholdAtMs` and, once withheld, `prompt.hashWithheld` with a null `prompt.hash`.
 */
export const DECISION_RECORD_VERSION = "f34.3"

/**
 * Audit F34 round 2 (FA-F34-R2-003, spec ruling R37). R15 keeps a bare SHA-256 of the masked prompt in the server-only
 * record because the masked body it hashes is stored in clear beside it: in the output row, or, while a failed publication
 * may still be retried, in the request's idempotency marker. A chat call above rank 1 (whose text never rides to Opik)
 * whose output row is never written loses both once the marker's TTL passes, and the bare hash is then the only trace of
 * a short, guessable body: a dictionary oracle. So such a record carries `prompt.hashWithholdAtMs` (its start plus this
 * much, the marker's TTL: `IDEMPOTENCY_TTL_MS`, held equal by a unit test), the publication removes it, and the export
 * reconciler's pass nulls the hash of any record still unpublished at that time (`hashWithheld: "no_output_row"`).
 */
export const PROMPT_HASH_WITHHOLD_AFTER_MS = 24 * 60 * 60 * 1000
export const HASH_WITHHELD_NO_OUTPUT_ROW = "no_output_row"

/**
 * PR #132 review, Codex P1 (thread 4369851302; spec ruling R42). The reservation's `decisionSeed` carries a copy of the
 * prompt record, hash included, so the lease reconciler can write the record of a call that never commits (R2, R16). That
 * copy is needed only while the reservation is open. Every transition out of `reserved` clears it in the same transaction:
 * a settlement that writes or follows the decision record (the call's commit, the embedding's, the lease reconciler's)
 * records `hashWithheld: "in_record"`; the lease reconciler's release, which writes no record and after which nothing was
 * sent, records `"released"`; and the export reconciler's withholding (R37) records `"no_output_row"` on the seed too.
 */
export const SEED_HASH_IN_RECORD = "in_record"
export const SEED_HASH_RELEASED = "released"

/** The fields that clear a reservation's seed hash (`seedPrompt`: its `decisionSeed.prompt`); none when it holds no seed. */
export function seedHashScrub(seedPrompt: unknown, reason: string): Record<string, unknown> {
  return seedPrompt !== null && typeof seedPrompt === "object" ? { "decisionSeed.prompt.hash": null, "decisionSeed.prompt.hashWithheld": reason } : {}
}

/**
 * The hash an embedding's record keeps of what was sent (re-audit R1-002, spec ruling R16): the SHA-256 of the masked input
 * string, UTF-8. Never the text; server-only like every record (R15: never exported above rank 1 or on a blocked call).
 */
export const EMBEDDING_INPUT_HASH_ALGORITHM = "sha256/p1-embedding-input-v1"

export function embeddingInputHash(maskedInput: string): string {
  return sha256Hex(maskedInput)
}

export function decisionRef(usageLogId: string, db: Firestore = adminDb()): DocumentReference {
  return db.collection(DECISIONS_COLLECTION).doc(usageLogId)
}

/** A plain object (a map), or null. */
function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** A count, when it is a non-negative integer; 0 otherwise. */
function countOr0(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

// ---------------------------------------------------------------------------
// Retrieval anchors (R5)
// ---------------------------------------------------------------------------

/**
 * One retrieved authority: its source (`judgment:<id>`), the canonical citation as masked, the status it was given, and
 * the SHA-256 of the facts that were read about it (null when they could not be read).
 */
export type RetrievalAnchor = { sourceId: string; ref: string; status: string; factsSha256: string | null }

/**
 * The SHA-256 of what a verdict read about one judgment: its id, its bench and every treatment (kind, treating bench,
 * recorded bench), the treatments in a fixed order. A change in the corpus that changes any of them changes the hash.
 */
export function authorityFactsSha256(judgmentId: string, benchType: Bench, treatments: readonly TreatmentFact[]): string {
  const facts = treatments.map((t) => JSON.stringify([t.kind, t.treatingJudgmentBench ?? null, t.recordedTreatingBench ?? null])).sort()
  return sha256Hex(JSON.stringify({ judgmentId, benchType, treatments: facts }))
}

/** Anchors as a caller supplied them, reduced to their four fields, strings only; anything else is dropped. */
export function anchorsOf(value: unknown): RetrievalAnchor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((a) => {
    if (a === null || typeof a !== "object") return []
    const r = a as Record<string, unknown>
    if (typeof r.sourceId !== "string" || typeof r.ref !== "string" || typeof r.status !== "string") return []
    return [{ sourceId: r.sourceId, ref: r.ref, status: r.status, factsSha256: typeof r.factsSha256 === "string" ? r.factsSha256 : null }]
  })
}

// ---------------------------------------------------------------------------
// The export state machine (R11)
// ---------------------------------------------------------------------------

/** Attempts at a trace export, the call's own included, before it is recorded `failed`. */
export const TRACE_EXPORT_MAX_ATTEMPTS = 5
/** The wait after the first failed attempt; it doubles after each further one (5, 10, 20, 40 minutes). */
export const TRACE_EXPORT_BACKOFF_MS = 5 * 60_000

export type ExportState = "exported" | "disabled" | "pending" | "failed"
export type ExportCode = "export_failed" | "export_disabled"
/** One state of a record's export, with epoch milliseconds; `exportFields` turns it into the stored map. */
export type ExportStep = {
  state: ExportState
  attempts: number
  lastCode?: ExportCode
  nextAttemptAtMs?: number
  exportedAtMs?: number
  abandonedAtMs?: number
  /**
   * Re-audit R1-009 (spec ruling R23): on a `disabled` export, why tracing was off (`opikConfig().reason`: `unset`, or a
   * set but rejected `invalid_url`, `unconfirmed`, `third_party_host`), so turned off is told apart from misconfigured.
   */
  disabledReason?: string
}

function failedAttempt(attempts: number, code: ExportCode, nowMs: number): ExportStep {
  if (attempts >= TRACE_EXPORT_MAX_ATTEMPTS) return { state: "failed", attempts, lastCode: code, abandonedAtMs: nowMs }
  return { state: "pending", attempts, lastCode: code, nextAttemptAtMs: nowMs + TRACE_EXPORT_BACKOFF_MS * 2 ** (attempts - 1) }
}

/**
 * The export after the call's own attempt (step 10): exported, disabled (nothing to retry, with why tracing was off when
 * the caller says, R23), or pending after a failure.
 */
export function exportAfterCall(status: "exported" | "failed" | "disabled", nowMs: number, disabledReason?: string): ExportStep {
  if (status === "exported") return { state: "exported", attempts: 1, exportedAtMs: nowMs }
  if (status === "disabled") return { state: "disabled", attempts: 0, ...(disabledReason === undefined ? {} : { disabledReason }) }
  return failedAttempt(1, "export_failed", nowMs)
}

/**
 * The export after one more attempt by the reconciler. Tracing turned off since the record was written counts as a
 * failed attempt with its own code: a record that can never be exported ends `failed`, never pending for ever.
 */
export function nextExport(prev: { attempts: unknown }, outcome: "exported" | "failed" | "disabled", nowMs: number): ExportStep {
  const attempts = countOr0(prev.attempts) + 1
  if (outcome === "exported") return { state: "exported", attempts, exportedAtMs: nowMs }
  return failedAttempt(attempts, outcome === "disabled" ? "export_disabled" : "export_failed", nowMs)
}

/** The stored `export` map of a step: Timestamps for its times, and no lease (a step always ends any lease). */
export function exportFields(step: ExportStep): Record<string, unknown> {
  return {
    state: step.state,
    attempts: step.attempts,
    ...(step.lastCode === undefined ? {} : { lastCode: step.lastCode }),
    ...(step.nextAttemptAtMs === undefined ? {} : { nextAttemptAt: Timestamp.fromMillis(step.nextAttemptAtMs) }),
    ...(step.exportedAtMs === undefined ? {} : { exportedAt: Timestamp.fromMillis(step.exportedAtMs) }),
    ...(step.abandonedAtMs === undefined ? {} : { abandonedAt: Timestamp.fromMillis(step.abandonedAtMs) }),
    ...(step.disabledReason === undefined ? {} : { disabledReason: step.disabledReason }),
  }
}

// ---------------------------------------------------------------------------
// The record a reconciled reservation gets (R2)
// ---------------------------------------------------------------------------

/**
 * The decision record of a reservation the lease reconciler settled: the seed the call left on the reservation before it
 * dispatched (`decisionSeed`), the provider attempt's ids and transport time, the reconciled usage record's figures, and
 * the export state the reconciler can give it (`pending` with nothing tried, or `disabled` with why tracing is off, R23). A
 * reservation made before F34 has no seed: the record says so (`seedMissing: true`) and carries what the reservation and
 * the attempt hold.
 *
 * Re-audit R1-007 (spec ruling R21): the seed's verdicts are the ones known before dispatch, when no provider attempt had
 * been recorded yet. A reservation the reconciler settles holds one, so `decisions.attemptRecord` is `"recorded"`, and
 * `decisions.fromSeed: true` says the other verdicts are the seed's. Re-audit R1-002 (R16): an embedding's reconciled
 * usage record carries the verified `caller` and the corpus's `corpusOperationId`, and so does its decision record; a chat
 * call's record gains neither.
 */
export function reconciledDecision(a: {
  usageLogId: string
  traceId: string | null
  seed: unknown
  attempt: Record<string, unknown> | null
  record: Record<string, unknown> & { firmId: string; monthKey: string; model: string }
  nowMs: number
  tracing: boolean
  /** Why tracing is off (`opikConfig().reason`), recorded on a `disabled` export (R23). */
  disabledReason?: string
}): Record<string, unknown> {
  const seed = objectOf(a.seed)
  const seedModel = objectOf(seed?.model) ?? {}
  const seedPhases = objectOf(seed?.phases) ?? {}
  const seedDecisions = objectOf(seed?.decisions)
  const reported = typeof a.record.modelReported === "string" ? a.record.modelReported : null
  const transportMs = a.attempt !== null && typeof a.attempt.transportMs === "number" && a.attempt.transportMs >= 0 ? a.attempt.transportMs : null
  const r = a.record
  return {
    recordVersion: DECISION_RECORD_VERSION,
    traceId: a.traceId,
    usageLogId: a.usageLogId,
    firmId: r.firmId,
    actorId: r.actorId ?? null,
    matterId: r.matterId ?? null,
    jobId: r.jobId ?? null,
    taskType: r.taskType ?? null,
    classification: r.classification ?? null,
    operationId: seed !== null && typeof seed.operationId === "string" ? seed.operationId : null,
    outcome: r.outcome ?? null,
    blockReason: null,
    startedAtMs: seed !== null && typeof seed.startedAtMs === "number" ? seed.startedAtMs : null,
    endedAtMs: a.nowMs,
    prompt: seed?.prompt ?? null,
    model: {
      configured: r.model,
      reported,
      revisionStatus: reported === null ? "unreported" : "reported",
      provider: typeof seedModel.provider === "string" ? seedModel.provider : (r.provider ?? null),
      transport: typeof seedModel.transport === "string" ? seedModel.transport : null,
      gatewayVersion: typeof seedModel.gatewayVersion === "string" ? seedModel.gatewayVersion : null,
      responseId: plainId(a.attempt?.responseId) ?? null,
      requestId: plainId(a.attempt?.requestId) ?? null,
    },
    retrieval: { context: objectOf(seed?.retrieval)?.context ?? null },
    decisions: seedDecisions === null ? null : { ...seedDecisions, ...(a.attempt === null ? {} : { attemptRecord: "recorded" }), fromSeed: true },
    ...(typeof r.caller === "string" ? { caller: r.caller } : {}),
    ...(typeof r.corpusOperationId === "string" ? { corpusOperationId: r.corpusOperationId } : {}),
    phases: {
      firstReadsMs: typeof seedPhases.firstReadsMs === "number" ? seedPhases.firstReadsMs : null,
      maskMs: typeof seedPhases.maskMs === "number" ? seedPhases.maskMs : null,
      reserveMs: typeof seedPhases.reserveMs === "number" ? seedPhases.reserveMs : null,
      attemptRecordMs: null,
      transportMs,
      attemptOutcomeMs: null,
      traceMs: null,
      settleStartedAtMs: a.nowMs,
    },
    cost: {
      inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null,
      tokensEstimated: r.tokensEstimated ?? null,
      costMicroUsd: r.costMicroUsd ?? null,
      monthKey: r.monthKey,
      spendRecord: `ai_usage_months/${r.firmId}_${r.monthKey}`,
      reservation: `ai_reservations/${a.usageLogId}`,
      reconciledFrom: r.reconciledFrom ?? null,
    },
    export: exportFields(
      a.tracing ? { state: "pending", attempts: 0, nextAttemptAtMs: a.nowMs } : { state: "disabled", attempts: 0, ...(a.disabledReason === undefined ? {} : { disabledReason: a.disabledReason }) }
    ),
    ...(seed === null ? { seedMissing: true } : {}),
    settledBy: "reconciler",
  }
}

// ---------------------------------------------------------------------------
// What the committee publisher adds (R5, R9)
// ---------------------------------------------------------------------------

/**
 * The fields `committeeBrain`'s publication transaction merges into the call's record: the judgments that graded the
 * answer, the grounding summary, the output the answer was published as, and the approval state (no P1 output has a human
 * approval step yet, R9). With the ids, so a record the publisher creates before the call's own (a commit that failed)
 * is still found by its trace id.
 */
export function publicationFields(p: {
  usageLogId: string
  traceId: string
  firmId: string
  outputId: string
  advisory: boolean
  grounding: { status: string; rules: string; omitted: number }
  anchors: readonly RetrievalAnchor[]
}): Record<string, unknown> {
  return {
    recordVersion: DECISION_RECORD_VERSION,
    usageLogId: p.usageLogId,
    traceId: p.traceId,
    firmId: p.firmId,
    retrieval: { verification: { anchors: p.anchors.map((x) => ({ ...x })), groundingStatus: p.grounding.status, groundingRules: p.grounding.rules, omitted: p.grounding.omitted } },
    output: { collection: "committee_outputs", outputId: p.outputId, advisory: p.advisory, groundingStatus: p.grounding.status },
    approval: { state: "no_approval_path", ref: null },
    // R37: the masked body is now stored in clear in the output row, so the hash withholds nothing and need not be withheld.
    prompt: { hashWithholdAtMs: FieldValue.delete() },
  }
}

// ---------------------------------------------------------------------------
// Reconstruction (R13)
// ---------------------------------------------------------------------------

/** A stored document's data, as the Admin SDK types it. */
type Doc = DocumentData

/** What the reconstruction reads, by the attempt's usage row id. `output` is the committee output row with its id. */
export type DecisionParts = {
  usageLogId: string
  decision: Doc | null
  usage: Doc | null
  reservation: Doc | null
  output: (Doc & { id: string }) | null
  eventNames: string[]
}

export type ReconstructionChecks = {
  decisionPresent: boolean
  usageJoined: boolean
  reservationJoined: boolean
  outputJoined: boolean
  /** The record's template hash is the pinned hash of the template it names. */
  templatePinned: boolean
  /** The messages re-derived from the output row (registry text of its system reference, then its masked body) hash to the record's prompt hash; null without a joined output. */
  promptHashMatchesOutput: boolean | null
  exportState: string | null
}

export type Reconstruction = {
  key: { usageLogId: string; traceId: string | null }
  decision: Doc | null
  usage: Doc | null
  reservation: Doc | null
  /** The output row by reference: never its text or its body. */
  output: { outputId: string; groundingStatus: string | null; advisory: boolean | null; system: unknown } | null
  events: string[]
  checks: ReconstructionChecks
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null)

/** The join (pure): the records of one attempt, with what they prove about each other. */
export function joinDecision(p: DecisionParts): Reconstruction {
  const d = p.decision
  const traceId = str(d?.traceId) ?? str(p.usage?.trace?.id) ?? str(p.reservation?.traceId) ?? str(p.output?.traceId)
  const usageJoined = p.usage !== null && traceId !== null && p.usage.trace?.id === traceId
  const reservationJoined = p.reservation !== null && traceId !== null && p.reservation.traceId === traceId
  const outputJoined = p.output !== null && p.output.usageLogId === p.usageLogId && (p.output.traceId === undefined || p.output.traceId === traceId)
  const prompt = d?.prompt
  const pin = prompt ? PROMPT_TEMPLATE_PINS[`${String(prompt.templateId)}@${String(prompt.templateVersion)}`] : undefined
  const templatePinned = typeof pin === "string" && prompt?.templateSha256 === pin
  let promptHashMatchesOutput: boolean | null = null
  if (d !== null && outputJoined) {
    const system = p.output!.outbound?.system
    const text = system ? systemPolicyText(system.policyId, system.version) : null
    const body = p.output!.outbound?.body
    promptHashMatchesOutput =
      prompt?.hash === null && typeof prompt?.hashWithheld === "string"
        ? null // R37: withheld, so not checkable (not a mismatch)
        : text !== null && typeof body === "string" && typeof prompt?.hash === "string"
          ? promptHash([
              { role: "system", content: text },
              { role: "user", content: body },
            ]) === prompt.hash
          : false
  }
  return {
    key: { usageLogId: p.usageLogId, traceId },
    decision: d,
    usage: p.usage,
    reservation: p.reservation,
    output:
      p.output === null
        ? null
        : {
            outputId: p.output.id,
            groundingStatus: str(p.output.grounding?.status),
            advisory: typeof p.output.advisory === "boolean" ? p.output.advisory : null,
            system: p.output.outbound?.system ?? null,
          },
    events: [...p.eventNames],
    checks: {
      decisionPresent: d !== null,
      usageJoined,
      reservationJoined,
      outputJoined,
      templatePinned,
      promptHashMatchesOutput,
      exportState: str(d?.export?.state),
    },
  }
}

const EVENT_SUFFIXES = ["completed", "failed", "blocked", "reconciled"] as const
const DOC_ID = /^[A-Za-z0-9_-]{1,200}$/
const TRACE_ID = /^[0-9a-f-]{1,64}$/i

/**
 * The operator's reconstruction (R13): given a trace id or a usage row id, the joined record from durable data alone (the
 * decision record, the usage row, the reservation with its provider attempt, the committee output by reference, and the
 * call's event). Null when no record of the attempt exists. Reads only; never returns prompt or answer text.
 */
export async function reconstructP1Decision(db: Firestore, key: { traceId?: string; usageLogId?: string }): Promise<Reconstruction | null> {
  let usageLogId = typeof key.usageLogId === "string" && DOC_ID.test(key.usageLogId) ? key.usageLogId : null
  if (usageLogId === null && typeof key.traceId === "string" && TRACE_ID.test(key.traceId)) {
    for (const [collection, field] of [
      [DECISIONS_COLLECTION, "traceId"],
      ["ai_usage_logs", "trace.id"],
      ["ai_reservations", "traceId"],
    ] as const) {
      const hit = await db.collection(collection).where(field, "==", key.traceId).limit(1).get()
      if (!hit.empty) {
        usageLogId = hit.docs[0]!.id
        break
      }
    }
  }
  if (usageLogId === null) return null
  const [decision, usage, reservation, ...events] = await db.getAll(
    db.collection(DECISIONS_COLLECTION).doc(usageLogId),
    db.collection("ai_usage_logs").doc(usageLogId),
    db.collection("ai_reservations").doc(usageLogId),
    ...EVENT_SUFFIXES.map((s) => db.collection("events").doc(`${usageLogId}_${s}`))
  )
  if (!decision!.exists && !usage!.exists && !reservation!.exists) return null
  const outputs = await db.collection("committee_outputs").where("usageLogId", "==", usageLogId).limit(1).get()
  const output = outputs.empty ? null : { ...(outputs.docs[0]!.data() as DocumentData), id: outputs.docs[0]!.id }
  return joinDecision({
    usageLogId,
    decision: decision!.exists ? (decision!.data() as Doc) : null,
    usage: usage!.exists ? (usage!.data() as Doc) : null,
    reservation: reservation!.exists ? (reservation!.data() as Doc) : null,
    output,
    eventNames: events.filter((e) => e.exists && typeof e.get("name") === "string").map((e) => e.get("name") as string),
  })
}

