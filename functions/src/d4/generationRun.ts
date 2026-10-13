import { randomUUID } from "node:crypto"
import { Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { isContentionAbort } from "../d1/contention"
import { FUNCTION_TIMEOUT_SECONDS } from "../health"
import { HttpError } from "../http/errors"
import { errorCode } from "../log"
import { COMMIT_ATTEMPT_SLACK_MS, COMMIT_DEADLINE_MS, callP1, type P1Result } from "../p1/gateway"
import { OPIK_TIMEOUT_MS } from "../p1/opik"
import { partyNamesFor } from "../p1/ops"
import { TRANSPORT_TIMEOUT_MS } from "../p1/transport"
import { TRANSPORT_ERROR } from "../p1/types"
import type { Caller } from "../p5/auth"
import type { CallAudit } from "../p5/common"
import { requireStillPermitted } from "./drafts"
import { PROMPT_VERSION } from "./generationPrompt"
import { d4Now, generationLabel, generationSeam, liveLease, type Stage, type StepOutcome, type VerbatimField } from "./generations"
import { MAX_UNSUPPORTED_REFS, type Guarded } from "./guardrails"

/**
 * One P1 step of a generation, as both P1 routes run it (spec "Order in the P1 routes", steps 9 to 12; P4B-14, P4B-17;
 * plan D19, D20, D23, D24, D27): the lease, the time budget, the P1 call, the verdict and the outcome write.
 *
 * - `claimLease` takes the brief's 180 s lease (`inFlight`) in one transaction, within the pre-call budget.
 * - `callDrafting` makes the one `callP1` call of the request (`taskType: "drafting"`, the generation's label, the
 *   matter's party names read fresh, the verbatim values pseudonymised).
 * - `outcomeOf` turns P1's result and the guardrails' verdict into the step's outcome.
 * - `writeOutcome` records it in one transaction (totals, `lastAttempt`, the lease released, the call's audit row, and
 *   the outline or section when stored), retried to the write deadline.
 * - `releaseLease` frees the lease when anything throws between the lease and the outcome write (D27).
 *
 * The budgets run on the op's own clock (`d4Now`) from the op's entry, never the router's `session.now` (D23).
 */

export { d4GenerationTestSeam, d4Now } from "./generations"

/** Up to the lease commit (D20): past it, 503 `generation_busy` with no call made. */
export const D4_PRECALL_BUDGET_MS = 5_000
/** After `callP1` returns, for the outcome write and the assembly (P4B-17). */
export const D4_WRITE_DEADLINE_MS = 10_000
/**
 * The last part of the write deadline, kept for the attempt in flight (D24), as P1 keeps `COMMIT_ATTEMPT_SLACK_MS`: no
 * write attempt starts later than `D4_WRITE_DEADLINE_MS − D4_ATTEMPT_SLACK_MS` after `callP1` returns.
 */
export const D4_ATTEMPT_SLACK_MS = 4_000
/** The lease on a brief (P4B-14): longer than the function timeout, so a live request never loses it. */
export const GENERATION_LEASE_MS = 180_000

// P1's worst case (transport, trace, commit and one commit attempt) plus D4's two budgets must end inside the function
// timeout; the slack is part of the write deadline; and the lease outlives the timeout. Checked at import, as P1 checks
// its own budget (gateway.ts), so a change that breaks it fails the deploy bundle's first import.
if (
  !(TRANSPORT_TIMEOUT_MS + OPIK_TIMEOUT_MS + COMMIT_DEADLINE_MS + COMMIT_ATTEMPT_SLACK_MS + D4_PRECALL_BUDGET_MS + D4_WRITE_DEADLINE_MS < FUNCTION_TIMEOUT_SECONDS * 1000) ||
  !(D4_ATTEMPT_SLACK_MS < D4_WRITE_DEADLINE_MS) ||
  !(GENERATION_LEASE_MS > FUNCTION_TIMEOUT_SECONDS * 1000)
) {
  throw new Error(
    `P1 (${TRANSPORT_TIMEOUT_MS + OPIK_TIMEOUT_MS + COMMIT_DEADLINE_MS + COMMIT_ATTEMPT_SLACK_MS} ms), the D4 pre-call budget (${D4_PRECALL_BUDGET_MS} ms) and write deadline (${D4_WRITE_DEADLINE_MS} ms, slack ${D4_ATTEMPT_SLACK_MS} ms) must fit in the function timeout (${FUNCTION_TIMEOUT_SECONDS} s), and the lease (${GENERATION_LEASE_MS} ms) must outlive it`
  )
}

/** The first wait between outcome-write attempts; it doubles after each failed attempt. */
const WRITE_BACKOFF_MS = 100

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const busy = () => new HttpError(503, "generation_busy")

/** What a P1 step answers (OutlineStepResult; SectionStepResult adds its fields). It never carries text (P4B-14). */
export type StepResult = {
  generationId: string
  stage: Stage
  step: "outline" | "section"
  outlineVersion: number
  called: boolean
  outcome: StepOutcome
  reason: string | null
  path: string | null
  model: string | null
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number }
  usageLogId: string | null
  traceId: string | null
}

/** A lease this request holds: its id, the brief and the matter as the lease transaction read them, the step's label, and the op's start. */
export type StepClaim = { claimId: string; brief: DocumentData; matter: DocumentData; label: Classification; startedMs: number }

/** The verbatim values of a brief as stored, in order. */
export function verbatimOf(brief: DocumentData): VerbatimField[] {
  return Array.isArray(brief.verbatim) ? (brief.verbatim as VerbatimField[]).map((v) => ({ field: v.field, text: v.text })) : []
}

/**
 * Takes the brief's lease for one step (spec step 9; D20). Past the pre-call budget before the transaction, it is 503
 * `generation_busy` with nothing written. One transaction, in order: re-reads the brief (404 if it is gone), decides
 * `draft.generate` again on its matter (`requireStillPermitted`, R12), refuses a closed matter (409 `matter_closed`),
 * runs the step's own `recheck` of the brief, refuses a live lease (409 `generation_in_progress`), takes the label
 * (`generationLabel`), and writes `inFlight` (a new claim id, the step, `by`, and `leaseUntil` GENERATION_LEASE_MS
 * from now), the label and `updatedAt`. A run of the transaction that finds this claim's lease already there (an
 * earlier run committed and its answer was lost) takes it as held. Any failure that is not an HttpError releases the
 * lease if it is this claim's, then is rethrown; one that gives up under contention is 503 `generation_busy`. Past the
 * budget once it has committed, the lease is released in its own transaction and the answer is 503 `generation_busy`.
 */
export async function claimLease(
  caller: Caller,
  ref: DocumentReference,
  step: { step: "outline" | "section"; outlineVersion: number; section: number | null },
  recheck: (brief: DocumentData) => void,
  startedMs: number
): Promise<StepClaim> {
  const pastBudget = () => d4Now() - startedMs > D4_PRECALL_BUDGET_MS
  if (pastBudget()) throw busy()
  const claimId = randomUUID()
  let claim: StepClaim
  try {
    claim = await adminDb().runTransaction(async (tx) => {
      const brief = (await tx.get(ref)).data()
      if (!brief || brief.firmId !== caller.firmId) throw new HttpError(404, "not_found")
      // This request's own lease is there already: an earlier run of this transaction committed and its answer was lost,
      // and the SDK runs it again. That run judged and wrote everything; the lease is held, so nothing is judged again.
      if ((brief.inFlight as { claimId?: unknown } | null | undefined)?.claimId === claimId) {
        const matter = (await tx.get(adminDb().collection("matters").doc(brief.matterId as string))).data() ?? {}
        return { claimId, brief, matter, label: brief.classification as Classification, startedMs }
      }
      const matter = await requireStillPermitted(tx, caller, "draft.generate", brief.matterId as string)
      if (matter.status === "closed") throw new HttpError(409, "matter_closed")
      recheck(brief)
      const nowMs = d4Now()
      if (liveLease(brief, nowMs)) throw new HttpError(409, "generation_in_progress")
      const label = generationLabel(caller, brief, matter)
      const inFlight = { claimId, step: step.step, outlineVersion: step.outlineVersion, section: step.section, by: caller.uid, leaseUntil: Timestamp.fromMillis(nowMs + GENERATION_LEASE_MS) }
      tx.update(ref, { inFlight, classification: label, updatedAt: Timestamp.now() })
      return { claimId, brief: { ...brief, inFlight, classification: label }, matter, label, startedMs }
    })
  } catch (err) {
    // A failure that is not a decision may follow a run whose commit landed and whose answer was lost (contention among
    // them): release the lease if it is this claim's (releaseLease is fenced by the claim id, and does nothing otherwise).
    if (!(err instanceof HttpError)) await releaseLease(ref, claimId)
    // The attempts ran out against another writer on this brief.
    if (isContentionAbort(err)) throw busy()
    throw err
  }
  if (pastBudget()) {
    await releaseLease(ref, claimId)
    throw busy()
  }
  return claim
}

/**
 * The step's one `callP1` call (spec step 10): `taskType: "drafting"`, the claim's label as `classification`, no job,
 * the matter's party names (its `matter_parties` names and the brief's, longest first, read fresh: `partyNamesFor`),
 * and the brief's verbatim values to pseudonymise. `body` is the prompt; `purpose` is the step's fixed purpose. The
 * month and the trace id run on the router's clock, as committeeBrain's do; P1's own deadlines run on the real clock.
 * The `beforeCall` seam runs just before `callP1`, and then the pre-call budget is judged again from `claim.startedMs`:
 * past it, 503 `generation_busy` with no call (the caller releases the lease, D27).
 */
export async function callDrafting(caller: Caller, claim: StepClaim, purpose: string, body: string, routerNow: number | undefined): Promise<P1Result> {
  const { brief } = claim
  const matterId = brief.matterId as string
  const supplied = Array.isArray(brief.partyNames) ? (brief.partyNames as unknown[]).filter((n): n is string => typeof n === "string") : []
  const partyNames = await partyNamesFor(caller.firmId, matterId, supplied)
  const verbatim = verbatimOf(brief).map((v) => v.text)
  await generationSeam().beforeCall?.()
  // The pre-call budget once more (D20), after the work between the lease and the call: the party names and the prompt.
  // Past it, no call is made; the caller releases the lease on the throw (D27).
  if (d4Now() - claim.startedMs > D4_PRECALL_BUDGET_MS) throw busy()
  // The router's clock for the month and the trace id, plus real elapsed time so the trace has a duration.
  const t0 = Date.now()
  const clock = () => (routerNow ?? t0) + (Date.now() - t0)
  return callP1(
    { firmId: caller.firmId, actorId: caller.uid, matterId, jobId: null, taskType: "drafting", classification: claim.label, body, purpose, partyNames, pseudonymise: { verbatim } },
    { now: clock }
  )
}

/**
 * Frees the lease `claimId` after a throw between the lease and the outcome write (D27), or a pre-call budget past
 * once the lease committed (D20). Its own transaction clears `inFlight` only while it is still this claim's. It never
 * throws: it logs `d4.lease_released_after_error` with the ids and a code only (`released`, `not_held`, or the error
 * code of its own failure, after which the lease runs out at `leaseUntil`).
 */
export async function releaseLease(ref: DocumentReference, claimId: string): Promise<void> {
  let code: string
  try {
    code = await adminDb().runTransaction(async (tx) => {
      const lease: unknown = (await tx.get(ref)).data()?.inFlight
      if (lease === null || typeof lease !== "object" || (lease as { claimId?: unknown }).claimId !== claimId) return "not_held"
      tx.update(ref, { inFlight: null })
      return "released"
    })
  } catch (err) {
    code = errorCode(err)
  }
  logger.warn("d4.lease_released_after_error", { generationId: ref.id, claimId, code })
}

/**
 * The step's outcome (spec "Outcomes and errors"): P1 `blocked` is `blocked` with P1's reason (a block without one
 * throws: it is a P1 fault), P1 `failed` is `failed` with `transport_error`, an `ok` answer a guardrail refused is
 * `refused` with the guardrail's reason and at most MAX_UNSUPPORTED_REFS new authorities, and anything else is `stored`.
 * The P1 routes call it between the lease and the outcome write, where a throw releases the lease (D27).
 */
export function outcomeOf(result: P1Result, guard: Guarded<unknown> | null): { outcome: StepOutcome; reason: string | null; unsupportedRefs: string[] } {
  if (result.outcome === "blocked") {
    // P1 names the reason of every block; one without is a P1 fault, never recorded under another outcome's reason.
    if (result.blockReason === null) throw new Error("P1 blocked without a reason")
    return { outcome: "blocked", reason: result.blockReason, unsupportedRefs: [] }
  }
  if (result.outcome === "failed") return { outcome: "failed", reason: TRANSPORT_ERROR, unsupportedRefs: [] }
  if (guard !== null && !guard.ok) return { outcome: "refused", reason: guard.reason, unsupportedRefs: guard.unsupportedRefs.slice(0, MAX_UNSUPPORTED_REFS) }
  return { outcome: "stored", reason: null, unsupportedRefs: [] }
}

/** The write deadline of a step whose `callP1` call has just returned: `d4Now()` plus D4_WRITE_DEADLINE_MS. */
export function writeDeadline(): number {
  return d4Now() + D4_WRITE_DEADLINE_MS
}

export type WriteOutcomeArgs = {
  caller: Caller
  audit: CallAudit
  ref: DocumentReference
  claim: StepClaim
  result: P1Result
  verdict: ReturnType<typeof outcomeOf>
  step: "outline" | "section"
  outlineVersion: number
  section: number | null
  /** The write deadline (`writeDeadline()` when `callP1` returned); no attempt after the first starts later than it less D4_ATTEMPT_SLACK_MS. */
  deadlineMs: number
  /** For a `stored` outcome: stages the stored document in `tx` and returns the brief's further fields. */
  onStored?: (tx: Transaction, brief: DocumentData, label: Classification, at: Timestamp) => Record<string, unknown>
}

/** The brief, when it already holds this call's outcome: a write whose answer was lost has committed (3d R10). */
async function outcomeCommitted(ref: DocumentReference, usageLogId: string): Promise<DocumentData | null> {
  try {
    const brief = (await ref.get()).data()
    return brief !== undefined && (brief.lastAttempt as { usageLogId?: unknown } | null | undefined)?.usageLogId === usageLogId ? brief : null
  } catch {
    return null
  }
}

/**
 * The call's audit row (D5): allow/ok for a stored outcome, otherwise a deny with the outcome's reason. outcomeOf names a
 * reason for every outcome but `stored`; one without is a programming fault, refused before any write.
 */
function auditRowOf(verdict: ReturnType<typeof outcomeOf>): { decision: "allow" | "deny"; reason: string } {
  if (verdict.outcome === "stored") return { decision: "allow", reason: "ok" }
  if (verdict.reason === null) throw new Error(`a ${verdict.outcome} step outcome without its reason`)
  return { decision: "deny", reason: verdict.reason }
}

/** One attempt at the outcome transaction. Returns the brief as it stands once the attempt commits. */
async function stageOutcome(tx: Transaction, a: WriteOutcomeArgs): Promise<DocumentData> {
  // The stamp is taken in the attempt that commits, so updatedAt, lastAttempt.at and the stored document share it.
  const stamp = Timestamp.now()
  const brief = (await tx.get(a.ref)).data()
  // This call's outcome is there already: an earlier attempt committed and its answer was lost. Nothing more to write.
  if (brief !== undefined && (brief.lastAttempt as { usageLogId?: unknown } | null | undefined)?.usageLogId === a.result.usageLogId) return brief
  if (brief === undefined || (brief.inFlight as { claimId?: unknown } | null | undefined)?.claimId !== a.claim.claimId) throw new HttpError(409, "generation_changed")
  const matter = await requireStillPermitted(tx, a.caller, "draft.generate", brief.matterId as string)
  const label = generationLabel(a.caller, brief, matter)
  const stored = a.verdict.outcome === "stored"
  // The call's own row (D5): allow when the outcome is stored, otherwise a deny with the outcome's reason.
  const row = auditRowOf(a.verdict)
  await a.audit.stage(tx, row.decision, row.reason)
  const extra = stored && a.onStored ? a.onStored(tx, brief, label, stamp) : {}
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  const update: Record<string, unknown> = {
    calls: count(brief.calls) + 1,
    costMicroUsd: count(brief.costMicroUsd) + a.result.costMicroUsd,
    path: "ai",
    model: a.result.model,
    promptVersion: PROMPT_VERSION,
    classification: label,
    lastAttempt: {
      step: a.step,
      outlineVersion: a.outlineVersion,
      section: a.section,
      outcome: a.verdict.outcome,
      reason: a.verdict.reason,
      unsupportedRefs: a.verdict.unsupportedRefs.slice(0, MAX_UNSUPPORTED_REFS),
      usageLogId: a.result.usageLogId,
      traceId: a.result.traceId,
      costMicroUsd: a.result.costMicroUsd,
      at: stamp,
      by: a.caller.uid,
    },
    inFlight: null,
    updatedAt: stamp,
    ...extra,
  }
  tx.update(a.ref, update)
  return { ...brief, ...update }
}

/**
 * The outcome transaction (spec step 12; P4B-14). `beforeOutcomeWrite` runs once. Each attempt is one transaction:
 * it re-reads the brief (a lease that is no longer this claim's is 409 `generation_changed`), decides `draft.generate`
 * again (R12), takes the label, stages the call's audit row (D5), and adds 1 to `calls` and the call's cost to
 * `costMicroUsd`, with `path`, `model`, `promptVersion`, the label, `lastAttempt` and `inFlight: null`, plus
 * `onStored`'s fields (and document) when the outcome is stored. A refusal there writes nothing (D12): the lease runs
 * out at `leaseUntil`.
 *
 * An HttpError is never retried. After any other failure, a brief whose `lastAttempt.usageLogId` is this call's means
 * the write is done; otherwise the next attempt follows after 100 ms, doubling, unless it would start later than the
 * start-by time (`deadlineMs − D4_ATTEMPT_SLACK_MS`, D24), and then the last failure is rethrown (500, O-85). Returns the
 * brief as written.
 */
export async function writeOutcome(a: WriteOutcomeArgs): Promise<DocumentData> {
  const t = generationSeam()
  const startBy = a.deadlineMs - D4_ATTEMPT_SLACK_MS
  auditRowOf(a.verdict)
  await t.beforeOutcomeWrite?.()
  for (let attempt = 1; ; attempt++) {
    try {
      const injected = t.outcomeWriteFailures?.shift()
      if (injected) throw injected
      const brief = await adminDb().runTransaction((tx) => stageOutcome(tx, a), { maxAttempts: 1 })
      const lost = t.lostCommitAnswers?.shift()
      if (lost) throw lost
      a.audit.committed()
      return brief
    } catch (err) {
      if (err instanceof HttpError) throw err
      const done = await outcomeCommitted(a.ref, a.result.usageLogId)
      if (done !== null) {
        a.audit.committed()
        return done
      }
      const wait = WRITE_BACKOFF_MS * 2 ** (attempt - 1)
      if (d4Now() + wait > startBy) throw err
      await sleep(wait)
    }
  }
}
