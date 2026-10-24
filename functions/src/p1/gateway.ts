import { FieldValue, Timestamp, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { buildOutbound, residualCountsOfMessages, verifySystemMessage, type OutboundMessage, type SystemRecord } from "@/platform/p1/outboundPrompt"
import { assertMinimised, providerAllowedFor } from "@/platform/p1/providerPolicy"
import { isClassification, type Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { isContentionAbort } from "../d1/contention"
import { FUNCTION_TIMEOUT_SECONDS } from "../health"
import { errorCode } from "../log"
import { stageAudit } from "../p5/audit"
import {
  THRESHOLDS,
  alertRef,
  budgetOf,
  firmConfigRef,
  killSwitchBlocks,
  learnedOverheadOf,
  maxConcurrentOf,
  modelOverheadKey,
  monthRef,
  overheadRef,
  pkrRateOf,
  platformConfigRef,
  reservationRef,
  reservedOf,
  spentOf,
} from "./config"
import { MAX_OUTPUT_TOKENS, PROVIDER_ID, TASK_MODEL, costMicroUsd, estimateRequestTokens, estimateTokens, learnedOverheadCap, requestTokenCeiling, reservationOverheadTokens } from "./costTable"
import { monthKeyPkt } from "./month"
import { OPIK_TIMEOUT_MS, exportTrace } from "./opik"
import { P1TransportError, TRANSPORT_TIMEOUT_MS, activeTransport, isTransportCode, modelId, plainId, type TransportCode } from "./transport"
import { TRANSPORT_ERROR, type BlockReason, type LedgerTaskType, type P1Accounting, type P1Outcome, type ReservationState, type TaskType, type UsageOutcome } from "./types"
import { uuidv7 } from "./uuidv7"

/**
 * `callP1`, the single chokepoint for every AI call (spec P3-61). It decides in this order, and the first
 * refusal wins: classification guard, kill switch (platform, then firm), route, outbound request (audit F16: the
 * registry's system message and the user's body as a separate user message, the body masked; review round R3a: the
 * system message is immutable platform text, verified before anything else is decided about it), provider
 * policy, price, budget, credentials; then the reservation and the provider-attempt record (audit F07, F08);
 * then the transport call and the response mask; then the trace; then one transaction writing the usage row,
 * the month total, any threshold alerts, the audit row and the event, and settling the reservation.
 *
 * Spend is a limit, not a report (F07). Before the provider is called, one transaction re-reads both kill switches,
 * the month total, the firm's config and the learned request overhead, and creates `ai_reservations/{usageLogId}`
 * holding the call's worst case (the input ceiling of the masked messages, one token per UTF-8 byte of each one's largest
 * Unicode normal form plus a per-message overhead (audit F16), plus the model's request overhead, and the 4,096-token
 * output ceiling: re-audit R1-D1, R2-D3), refusing
 * unless no switch blocks the model, spent + reserved + the new reservation fits the budget and the firm holds fewer
 * than its maximum of live reservations. Spent stays within budget unless a provider bills more input than bytes +
 * overhead; any such breach is recorded, raises an event, and raises the overhead for later calls of that model
 * (`ai.reservation.exceeded`, `p1.reservation_exceeded`, `platform/p1Overhead`). The provider is
 * called only after that commits, and only after a second small transaction has recorded the provider attempt
 * on the reservation. The commit adds the actual cost to `spent`, takes the hold off `reserved` and settles the
 * reservation. If the commit fails for good, the reservation keeps its hold and its attempt (F08), the result
 * says `accounting: "pending"`, and once its lease lapses the firm is refused `accounting_indeterminate` until
 * the lease reconciler (`reconciler.ts`) settles it.
 *
 * No raw body, purpose or response text reaches the transport, the trace, a row, an event, an audit row or a
 * log line, and no provider error text is returned, stored or logged. The transport receives the role-separated
 * messages only (audit F16): no caller can supply or change system text, which comes from platform/p1/systemPolicy.ts by
 * purpose and is recorded by reference, never by its text (review round R4a).
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
   * The `idempotency_keys` doc id whose stored answer will carry this call's result, when the call is made for an
   * HTTP request (committeeBrain). Kept on the reservation so the lease reconciler can mark that answer settled
   * (Codex P2 on PR #40): a same-key replay then reports the books as they are.
   */
  idempotencyDoc?: string | null
  /**
   * The HTTP operation this call is made for (audit F09), when there is one: its effect marker is created with the
   * provider-attempt record (step 8c), so the operation dispatches at most once, and the provider's answer is recorded
   * on it (step 9b), so a same-key retry can publish that answer without a second provider call.
   */
  operation?: P1Operation
  /**
   * Audit F17 (spec ruling 6, refinement R6a): called once, synchronously, with the masked answer as soon as the provider
   * has answered `ok` and the answer is masked, before the attempt outcome, the trace and the commit, so the caller can
   * start work on it (committeeBrain grounds it) while those run. Never called for a blocked or failed call, and never
   * with unmasked text. It must not throw; a throw is caught and logged by its code (`p1.on_answer_failed`), and the
   * call goes on.
   */
  onAnswer?: (maskedText: string) => void
}

/**
 * An HTTP operation's effect marker as P1 records it (audit F09): `markerRef` is `idempotency_effects/{id}` and
 * `fields` the operation's identity it is created with (IdempotentOperation.markerFields in http/idempotency.ts).
 */
export type P1Operation = { markerRef: DocumentReference; fields: Record<string, unknown> }

/**
 * The attempt receipt (audit F09): what the provider answered for an operation's one call, recorded on its marker as soon
 * as the answer is in. The masked text and the masked outbound only, like the stored answer and the output row; never
 * on the reservation or the usage row, which hold no prompt or response text.
 */
export type P1Receipt = {
  outcome: Exclude<P1Outcome, "blocked">
  text?: string
  inputTokens: number
  outputTokens: number
  tokensEstimated: boolean
  costMicroUsd: number
  model: string
  /** Audit F17 (ruling 4): the model the provider reported, when it reported a model id; absent on a receipt recorded before F17. */
  modelReported?: string
  classification: Classification
  outbound: P1Result["outbound"]
}

export type P1Result = {
  outcome: P1Outcome
  blockReason: BlockReason | null
  /** The masked response; present only when the outcome is `ok`. */
  text?: string
  usageLogId: string
  traceId: string
  /** The configured model the call was routed to (P3-62). */
  model: string
  /**
   * Audit F17 (ruling 4): the model the provider reported having used (`P1TransportReply.model`), when the call was
   * answered and the answer named a model id; null otherwise. Recorded beside `model`, never assumed equal to it.
   */
  modelReported: string | null
  classification: Classification
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  /**
   * What was (or would have been) sent, recorded as the system message's reference plus the body (audit F16, spec ruling
   * 4, review round R4a): the request is exactly `[{ role: "system", content: <registry text of system> }, { role:
   * "user", content: body }]`. `body` is the masked user message as sent (tag look-alikes neutralised); `system` names the
   * registry policy by id and version, never its text (`systemPolicyText` re-derives it); the masked purpose (metadata,
   * never sent to the model); the redaction counts and the residual detector's counts (audit F15) over the body, the user
   * data (the system message is platform text, R3a). `callP1` always sets `residualCounts` and `system`; an attempt
   * receipt recorded before F15 has no `residualCounts`, and one recorded before F16 has no `system`.
   */
  outbound: { body: string; purpose: string; redactionCounts: Record<string, number>; residualCounts?: Record<string, number>; system?: SystemRecord }
  /** Whether this call's books are complete, apart from whether its result is available (F08; see P1Accounting). */
  accounting: P1Accounting
}

/**
 * Test seam only; production code never sets it, and it is inert when `NODE_ENV` is "production".
 * `beforeCommit` runs after the trace and before the commit transaction; `failCommit` makes that transaction
 * fail; `modelOverride` routes the call to that model id (ruling R2). `wallClock` replaces `Date.now` as the
 * commit deadline's clock; `commitAttemptFailures` is a queue: each commit transaction attempt takes the next
 * error from it and throws it before staging anything; `lostCommitAnswers` is a queue too: each commit attempt
 * whose transaction committed takes the next error from it and throws it, as if the commit's answer were lost.
 * `reserveAttemptFailures` and `attemptMarkFailures` are queues the same way for the reservation transaction's
 * attempts and for the provider-attempt record. `crashAt` makes the call throw at that point, leaving what an
 * instance that died there leaves: `reserved` after the reservation commits, `dispatched` after the provider answers,
 * `recorded` after the provider's answer is recorded (step 9b, audit F09).
 * `unqueued` runs ledger transactions outside the per-firm queue, as calls on separate instances do: "all" of them, or
 * only the commits ("commit"), so that commits race as they would from separate instances. `beforeReserve` runs after
 * the call's first reads and first look, just before its reservation transaction (step 8b), so a test can hold calls
 * there and let their reservations run in an order it chooses (re-audit R4-D1).
 */
export const p1TestSeam: {
  beforeCommit?: () => Promise<void>
  beforeReserve?: () => Promise<void>
  failCommit?: boolean
  modelOverride?: string
  wallClock?: () => number
  commitAttemptFailures?: Error[]
  lostCommitAnswers?: Error[]
  reserveAttemptFailures?: Error[]
  attemptMarkFailures?: Error[]
  crashAt?: "reserved" | "dispatched" | "recorded"
  unqueued?: "all" | "commit"
  /** Audit F16 review round (R3a): replaces the built system message's text, so a test can show the send-time check. */
  systemOverride?: string
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
 *
 * 20 s (Codex P1 on PR #40, down from 30 s): the whole HTTP request must fit the function timeout, the handler's own
 * work included (`assertOperationTimeBudget`). A commit that runs out is not lost: the reservation keeps the hold
 * and the provider attempt, and the lease reconciler settles it (F08).
 */
export const COMMIT_DEADLINE_MS = 20_000
/** The longest one commit attempt (four reads, a query-free commit) is allowed for in the timeout budget (5 s, from 10 s). */
export const COMMIT_ATTEMPT_SLACK_MS = 5_000
/** Back-off between attempts: 100 ms doubling to this cap, with ±50 % jitter, and never past the deadline. */
export const COMMIT_BACKOFF_CAP_MS = 2_000
const COMMIT_BACKOFF_BASE_MS = 100
/** Parallel calls in one firm contend on the month total; the deadline, not this count, normally ends a retry run. */
const COMMIT_MAX_ATTEMPTS = 30

/**
 * The reservation's own share of the time budget (F07), paced like the commit (one SDK attempt each, P1's own
 * back-off, no attempt started after the deadline), on the real clock. Past the deadline the call is refused
 * `reservation_failed` and nothing is sent.
 */
export const RESERVE_DEADLINE_MS = 5_000
/** The longest one reservation attempt (five reads, the firm's open-reservation query and a commit) is allowed for (3 s, from 5 s). */
export const RESERVE_ATTEMPT_SLACK_MS = 3_000
/**
 * Each of the two writes of the provider attempt on the reservation (F08) is cut off after this: the record before
 * dispatch (a cut-off one means nothing is sent) and the outcome after the provider answers (fail-open).
 */
export const ATTEMPT_RECORD_TIMEOUT_MS = 2_000
/**
 * A reservation's lease, from its creation on the call's clock. It outlives the function timeout by 60 s (the P2
 * job lease rule, `assertJobTimings`), so the reconciler never acts on a reservation whose call can still settle it.
 */
export const RESERVATION_LEASE_MS = FUNCTION_TIMEOUT_SECONDS * 1000 + 60_000

/** Every phase of a call that can take time after its first reads, in the order they run. */
const CALL_PHASES_MS = {
  reservation: RESERVE_DEADLINE_MS,
  reservationAttempt: RESERVE_ATTEMPT_SLACK_MS,
  attemptRecord: ATTEMPT_RECORD_TIMEOUT_MS,
  transport: TRANSPORT_TIMEOUT_MS,
  attemptOutcome: ATTEMPT_RECORD_TIMEOUT_MS,
  trace: OPIK_TIMEOUT_MS,
  commit: COMMIT_DEADLINE_MS,
  commitAttempt: COMMIT_ATTEMPT_SLACK_MS,
}

/**
 * The sum of every phase's share: what a call can take after its first reads. 99 s: reservation 5 + 3, attempt
 * record 2, transport 60, attempt outcome 2, trace 2, commit 20 + 5.
 */
export const CALL_WORST_CASE_MS = Object.values(CALL_PHASES_MS).reduce((a, b) => a + b, 0)

/**
 * The phases a call can still take after the provider has answered (audit F17, refinement R6a): the attempt outcome, the
 * trace and the commit, 29 s. Work the caller starts from `onAnswer` runs beside them; ops.ts holds committeeBrain's
 * grounding budget within this at import, so grounding adds nothing to the operation's worst case.
 */
export const CALL_PHASES_AFTER_ANSWER_MS = CALL_PHASES_MS.attemptOutcome + CALL_PHASES_MS.trace + CALL_PHASES_MS.commit + CALL_PHASES_MS.commitAttempt

/**
 * The import-time check that a whole HTTP operation fits its function's timeout (Codex P1 on PR #40): the call's
 * phases (`callMs`, CALL_WORST_CASE_MS), the handler's own work before and after the call (`handlerMs`) and a margin
 * (`marginMs`) must not exceed `timeoutMs`. Throws, naming every figure, when they do; `ops.ts` runs it at import for
 * committeeBrain, so a share that grows past the budget fails the deploy bundle's first import and the test suite.
 */
export function assertOperationTimeBudget(b: { callMs: number; handlerMs: number; marginMs: number; timeoutMs: number }): void {
  if (!(b.callMs + b.handlerMs <= b.timeoutMs - b.marginMs)) {
    throw new Error(
      `the call's phases (${b.callMs} ms), the handler's own work (${b.handlerMs} ms) and the margin (${b.marginMs} ms) must fit in the function timeout (${b.timeoutMs} ms)`
    )
  }
}

assertOperationTimeBudget({ callMs: CALL_WORST_CASE_MS, handlerMs: 0, marginMs: 0, timeoutMs: FUNCTION_TIMEOUT_SECONDS * 1000 })
if (!(RESERVATION_LEASE_MS >= FUNCTION_TIMEOUT_SECONDS * 1000 + 60_000)) {
  throw new Error(`reservation lease (${RESERVATION_LEASE_MS} ms) must outlive the function timeout (${FUNCTION_TIMEOUT_SECONDS} s) by at least 60 s`)
}

/** The codes the SDK itself retries a transaction on (ABORTED, CANCELLED, UNKNOWN, DEADLINE_EXCEEDED, INTERNAL, UNAVAILABLE, UNAUTHENTICATED, RESOURCE_EXHAUSTED), plus an expired or dead transaction. */
const RETRYABLE_COMMIT_CODES: ReadonlySet<number> = new Set([10, 1, 2, 4, 13, 14, 16, 8])

/**
 * A store fault that a later attempt may not meet: contention, an expired transaction, or one of the codes above.
 * The lease reconciler uses it too (re-audit R2-D1): such a failure is retried on a later run and never counted
 * toward quarantine.
 */
export function isRetryableCommitError(err: unknown): boolean {
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

/** The reservation ran out of time (RESERVE_DEADLINE_MS). */
function reserveDeadlineError(): Error {
  return Object.assign(new Error("P1 reservation deadline passed"), { code: "reserve_deadline" })
}

/** The reservation is no longer held (the reconciler settled or released it): nothing may move its hold again. */
function reservationNotLiveError(): Error {
  return Object.assign(new Error("P1 reservation is not live"), { code: "reservation_not_live" })
}

/**
 * The call's HTTP operation already dispatched under another attempt (audit F09): its effect marker carries another
 * call's trace id. Nothing is sent.
 */
function operationFencedError(): Error {
  return Object.assign(new Error("P1 operation already dispatched"), { code: "operation_fenced" })
}

/** `p1TestSeam.crashAt`: the call stops here as if its instance died. */
function simulatedCrash(): Error {
  return new Error("p1TestSeam.crashAt")
}

/** Rejects with `code` when `p` has not settled within `ms`; `p` keeps running, and its later result is ignored. */
function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`P1 ${code}`), { code })), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

const EVENT_SUFFIX: Readonly<Record<UsageOutcome, string>> = { ok: "completed", failed: "failed", blocked: "blocked", reconciled: "reconciled" }

/**
 * The tail of each firm's ledger queue in this instance. Within one instance a firm's ledger transactions (the
 * reservation and the commit, which both read and write the firm's month total) run one at a time, in arrival
 * order. Overlapping transactions on one document can only abort each other: Firestore aborts the younger, and the
 * emulator holds both until a lock timeout of about 2 s and then aborts all but one, so ten overlapping ones take
 * about 20 s there. Queuing them locally costs no throughput and saves those rounds. This is contention control, not
 * the guarantee: across instances the transactions still contend, and each transaction's own re-read and the retry
 * loop around it keep spent + reserved within the budget whatever the interleaving. Entries are removed when idle.
 *
 * The queue never costs liveness: an operation holds it for at most LEDGER_QUEUE_HOLD_MS (after that the next one
 * runs beside it and merely contends), and a waiter whose own deadline passes before its turn leaves the queue with
 * its deadline error and never runs. So a hung transaction cannot stall the firm's other calls.
 */
const ledgerQueues = new Map<string, Promise<void>>()

/** How long one ledger operation may hold its firm's queue before the next is let through beside it. */
export const LEDGER_QUEUE_HOLD_MS = 5_000

/**
 * Runs `fn` once the operations of `key` queued before it have settled, or have each held the queue for `holdMs`.
 * A caller not let through within `maxWaitMs` is rejected with `timeoutError()`, and its `fn` never runs. Exported
 * for its own tests; callP1 reaches it through `inLedgerQueue`.
 */
export function ledgerQueue<T>(key: string, maxWaitMs: number, holdMs: number, timeoutError: () => Error, fn: () => Promise<T>): Promise<T> {
  const previous = ledgerQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const turnOver = new Promise<void>((resolve) => (release = resolve))
  let started = false
  let abandoned = false
  const run = previous.then(() => {
    if (abandoned) {
      release()
      throw timeoutError()
    }
    started = true
    const work = Promise.resolve().then(fn)
    const hold = setTimeout(release, holdMs)
    hold.unref?.()
    const done = () => {
      clearTimeout(hold)
      release()
    }
    work.then(done, done)
    return work
  })
  ledgerQueues.set(key, turnOver)
  void turnOver.then(() => {
    if (ledgerQueues.get(key) === turnOver) ledgerQueues.delete(key)
  })
  return new Promise<T>((resolve, reject) => {
    const wait = setTimeout(
      () => {
        if (started) return
        abandoned = true
        reject(timeoutError())
      },
      Math.max(0, maxWaitMs)
    )
    wait.unref?.()
    run.then(
      (value) => {
        clearTimeout(wait)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(wait)
        reject(err)
      }
    )
  })
}

/** callP1's use of the firm's ledger queue; the `unqueued` test seam runs the operation directly, as another instance would. */
function inLedgerQueue<T>(firmId: string, kind: "reserve" | "commit", s: typeof p1TestSeam, maxWaitMs: number, timeoutError: () => Error, fn: () => Promise<T>): Promise<T> {
  if (s.unqueued === "all" || (s.unqueued === "commit" && kind === "commit")) return fn()
  return ledgerQueue(firmId, maxWaitMs, LEDGER_QUEUE_HOLD_MS, timeoutError, fn)
}

/**
 * The reservation states that still hold money and still count against the firm: `reserved`, and `reconcile_failed`
 * (quarantined by the reconciler, re-audit R1-D2), which blocks the firm `accounting_indeterminate` until an operator
 * settles it (README runbook).
 */
export const OPEN_RESERVATION_STATES: ReservationState[] = ["reserved", "reconcile_failed"]

/**
 * A reservation's lease end in epoch milliseconds: a Timestamp, or a finite number of milliseconds (a malformed record,
 * re-audit R1-D2); null for anything else, which every reader treats as lapsed (fail closed: the gateway always writes
 * a Timestamp, so no live call can own such a record).
 */
export function leaseMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis()
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** The states a call or the reconciler closes a reservation with. */
export type ClosedState = Extract<ReservationState, "settled" | "released">

/** The state a reservation settles to: `settled` when the provider was called and charged (or answered), else `released` at 0. */
export function settledState(dispatched: boolean, outcome: UsageOutcome, costMicroUsd: number): ClosedState {
  return dispatched && (outcome === "ok" || costMicroUsd > 0) ? "settled" : "released"
}

type Threshold = (typeof THRESHOLDS)[number]
export type Crossing = { threshold: Threshold; budgetMicroUsd: number; spentMicroUsd: number }

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

/**
 * The call's pre-call work ran past the deadline its caller gave (re-audit R3-D2): nothing was reserved, sent or
 * written. `retryable`: the same request may be made again (committeeBrain answers 503 `precall_deadline`).
 */
export class P1PreCallDeadlineError extends Error {
  readonly code = "precall_deadline"
  readonly retryable = true

  constructor() {
    super("P1 pre-call deadline passed")
    this.name = "P1PreCallDeadlineError"
  }
}

/**
 * Options for one call. `now` is the call's clock (month, trace id, lease). `preCallDeadline` (re-audit R3-D2) is the
 * caller's deadline for the work before the reservation: if `clock()` is past `atMs` once this call's first reads are
 * done, it throws P1PreCallDeadlineError before anything is reserved or sent.
 */
export type CallP1Options = { now?: () => number; preCallDeadline?: { atMs: number; clock: () => number } }

export async function callP1(req: P1Request, opts?: CallP1Options): Promise<P1Result> {
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

  // Both kill switches, the firm's config, the month total and the learned request overhead, fresh on every call and
  // outside the commit transaction (P3-66: no cache, so a switch takes effect on the next call).
  const [platformSnap, configSnap, totalSnap, overheadSnap] = await db.getAll(platformConfigRef(), configRef, totalRef, overheadRef())
  const config = configSnap.data()

  // 3. Route (P3-62). 4. The role-separated request (audit F16, spec rulings 1 to 3): the registry's system message for
  // the purpose, then the body as the user's own turn, masked with the party names and its envelope tag look-alikes
  // neutralised. The system message is immutable platform text (review round R3a): never masked, so no party name can
  // change it, and verified at step 4a. The purpose is masked too (it is metadata, never sent). The independent residual
  // detector's counts over the body (audit F15): counts by kind only, recorded on every call, blocked or not.
  const model = t.modelOverride ?? (Object.hasOwn(TASK_MODEL, taskType) ? TASK_MODEL[taskType] : "")
  const built = buildOutbound({ purpose: req.purpose, turns: [{ role: "user", segments: [{ kind: "text", text: req.body }] }], partyNames })
  const messages: OutboundMessage[] =
    t.systemOverride === undefined ? built.messages : [{ role: "system", content: t.systemOverride }, ...built.messages.slice(1)]
  const outbound: P1Result["outbound"] = {
    body: messages[1]!.content,
    purpose: maskOutboundPII(req.purpose, { partyNames }).masked,
    redactionCounts: built.redactionCounts,
    residualCounts: residualCountsOfMessages(messages),
    system: built.system,
  }
  // The call's worst case (F07, re-audit R1-D1, R2-D3, audit F16): the input ceiling of the masked messages that are
  // sent (for each, one token per UTF-8 byte of its largest normal form plus a per-message overhead; then the model's
  // request overhead or the larger overhead learned from a breach, counted only up to the clamp: re-audit R3-D1), plus
  // the output ceiling sent as max_tokens, at the model's price. This is the first look; the reservation transaction
  // recomputes it on the overhead it reads. Null for a model with no price or no overhead in the cost table, which is
  // never dispatched (step 6, fail closed).
  const bodyTokens = requestTokenCeiling(messages)
  const firstLookOverhead = reservationOverheadTokens(model, learnedOverheadOf(overheadSnap.data(), model))
  const worstCase = firstLookOverhead === null ? null : costMicroUsd(model, bodyTokens + firstLookOverhead, MAX_OUTPUT_TOKENS)

  /** Steps 2 and 5 to 7, in order; the first refusal wins. */
  const refusal = (): BlockReason | null => {
    if (killSwitchBlocks(platformSnap.get("killSwitch"), model)) return "kill_switch_platform"
    if (killSwitchBlocks(config?.killSwitch, model)) return "kill_switch_firm"
    // 4a. Review round (R3a): the system message is exactly the registry text its record names, or nothing is sent.
    if (!verifySystemMessage(messages, built.system)) return "system_unverified"
    const policy = providerAllowedFor(PROVIDER_ID, classification)
    if (!policy.allowed) return "policy_denied"
    // Every user message that would be sent (audit F16) and the purpose; the verified system message is platform text.
    if (policy.requirements && !assertMinimised({ messages, metadata: { purpose: outbound.purpose } }, partyNames)) return "not_minimised"
    if (worstCase === null) return "model_unpriced"
    const budget = budgetOf(config)
    if (budget === null) return "budget_not_set"
    // A first look on the pre-call read (F07): the worst case must fit beside what is spent and held. The
    // reservation transaction (step 8b) decides again on the figures it reads.
    if (spentOf(totalSnap.data()) + reservedOf(totalSnap.data()) + worstCase > budget) return "budget_exhausted"
    return null
  }
  let blockReason = refusal()
  const transport = blockReason === null ? activeTransport() : null
  // 8. Credentials.
  if (blockReason === null && transport === null) blockReason = "no_credentials"

  // 8a. The caller's pre-call deadline (re-audit R3-D2): when the work before this point (the caller's own reads and
  // this call's first reads) ran past the allowance the caller gives, nothing is reserved or sent, and nothing is
  // written: the call fails with a retryable error, so no paid work starts that could outlive the request's timeout.
  if (blockReason === null && opts?.preCallDeadline !== undefined && opts.preCallDeadline.clock() > opts.preCallDeadline.atMs) {
    throw new P1PreCallDeadlineError()
  }

  // 8b. The reservation (F07): one transaction re-reads the month total and the config, refuses unless the
  // worst case fits and the firm holds fewer live reservations than its maximum (and has no lapsed provider
  // attempt, F08), and holds the worst case. No reservation, no provider call (a failure is reservation_failed).
  const resRef = reservationRef(usageRef.id)
  let reservation: CommitArgs["reservation"] = null
  if (blockReason === null) {
    await t.beforeReserve?.()
    const reserveArgs: ReserveArgs = {
      firmId,
      monthKey,
      nowMs: Math.floor(now()),
      bodyTokens,
      reservationRef: resRef,
      configRef,
      totalRef,
      seam: t,
      fields: {
        actorId: req.actorId,
        matterId: req.matterId ?? null,
        jobId: req.jobId ?? null,
        taskType,
        model,
        classification,
        traceId,
        ...(typeof req.idempotencyDoc === "string" && req.idempotencyDoc !== "" ? { idempotencyDoc: req.idempotencyDoc } : {}),
      },
    }
    try {
      const decision = await reserve(db, reserveArgs)
      if (decision === "reserved") reservation = { ref: resRef, state: "released", mustBeLive: false }
      else blockReason = decision
    } catch (err) {
      blockReason = "reservation_failed"
      // A reservation that landed unseen is released by this call's commit, or else by the reconciler.
      reservation = { ref: resRef, state: "released", mustBeLive: false }
      logger.warn("p1.reservation_failed", { firmId, usageLogId: usageRef.id, code: errorCode(err) })
    }
  }
  if (reservation !== null && blockReason === null && t.crashAt === "reserved") throw simulatedCrash()

  // 8c. The provider attempt is recorded on the reservation before dispatch (F08): once this lands, a call
  // that never settles is charged by the reconciler, never forgotten. Unrecorded, nothing is sent. For an HTTP
  // operation the same transaction creates the operation's effect marker (audit F09): one dispatch per operation.
  const operation = req.operation ? { operation: req.operation, usageLogId: usageRef.id, traceId } : undefined
  if (reservation !== null && blockReason === null) {
    try {
      await markAttempt(db, resRef, t, operation)
    } catch (err) {
      blockReason = "reservation_failed"
      logger.warn("p1.attempt_record_failed", { firmId, usageLogId: usageRef.id, code: errorCode(err) })
    }
  }

  let outcome: P1Outcome = "blocked"
  let text: string | undefined
  let inputTokens = 0
  let outputTokens = 0
  let tokensEstimated = false
  let cost = 0
  let dispatched = false
  // The provider's own ids for this call, when its answer carried plain ones (re-audit R1-D5).
  let providerIds: { responseId?: string; requestId?: string } = {}
  // Audit F17 (ruling 4): the model the provider reported, when its answer named a model id.
  let modelReported: string | null = null
  if (blockReason === null && transport !== null) {
    dispatched = true
    // 9. The transport call, then the response mask (P3-68).
    try {
      const res = await transport.send({ model, messages, maxTokens: MAX_OUTPUT_TOKENS })
      // A response came back without text: billed like the Gateway's own gateway_no_text, on the usage it reported.
      if (typeof res?.text !== "string") {
        throw new P1TransportError("gateway_no_text", {
          billable: true,
          inputTokens: tokenCount(res?.inputTokens),
          outputTokens: tokenCount(res?.outputTokens),
          responseId: res?.responseId,
          requestId: res?.requestId,
        })
      }
      const [responseId, requestId] = [plainId(res.responseId), plainId(res.requestId)]
      providerIds = { ...(responseId === undefined ? {} : { responseId }), ...(requestId === undefined ? {} : { requestId }) }
      const masked = maskOutboundPII(res.text, { partyNames }).masked
      const reportedIn = tokenCount(res.inputTokens)
      const reportedOut = tokenCount(res.outputTokens)
      // Each side is estimated from what was billed: the input from every masked message that was sent, the system
      // message included (audit F16), the output from the raw response the provider produced (masking shortens it).
      // The raw text is used for this count only; the masked text is the only one returned, stored, traced or logged.
      inputTokens = reportedIn ?? estimateRequestTokens(messages)
      outputTokens = reportedOut ?? estimateTokens(res.text)
      tokensEstimated = reportedIn === null || reportedOut === null
      cost = costMicroUsd(model, inputTokens, outputTokens)! // step 6 refused an unpriced model
      text = masked
      outcome = "ok"
      // Any transport may answer; only a model id is kept (the Gateway transport checks it too).
      modelReported = modelId(res.model) ?? null
    } catch (err) {
      outcome = "failed"
      // I1: a failure the provider may have billed is charged, conservatively: the reported usage where the
      // response gave a valid count, else the estimated input and the MAX_OUTPUT_TOKENS ceiling. A failure that
      // cannot have been billed (a non-2xx, a request that never left, any error that is not a billable
      // P1TransportError) is charged 0.
      if (err instanceof P1TransportError && err.billable) {
        const reportedIn = tokenCount(err.inputTokens)
        const reportedOut = tokenCount(err.outputTokens)
        inputTokens = reportedIn ?? estimateRequestTokens(messages)
        outputTokens = reportedOut ?? MAX_OUTPUT_TOKENS
        tokensEstimated = reportedIn === null || reportedOut === null
        cost = costMicroUsd(model, inputTokens, outputTokens)! // step 6 refused an unpriced model
        // A billed failure keeps the provider's ids like an answer does (Codex P2 on PR #40), so its charge can be found.
        const [responseId, requestId] = [plainId(err.responseId), plainId(err.requestId)]
        providerIds = { ...(responseId === undefined ? {} : { responseId }), ...(requestId === undefined ? {} : { requestId }) }
      } else {
        inputTokens = 0
        outputTokens = 0
        tokensEstimated = false
        cost = 0
      }
      logger.warn("p1.transport_failed", { firmId, usageLogId: usageRef.id, traceId, code: transportCode(err) })
    }
  }
  // Audit F17 (ruling 6, R6a): the masked answer goes to the caller now, so its own work on it (grounding) runs beside
  // steps 9b to 11 instead of after them. Outside the transport's try: a hook that throws is never a transport failure.
  if (outcome === "ok" && text !== undefined && req.onAnswer !== undefined) {
    try {
      req.onAnswer(text)
    } catch (err) {
      logger.warn("p1.on_answer_failed", { firmId, usageLogId: usageRef.id, traceId, code: errorCode(err) })
    }
  }
  if (dispatched && t.crashAt === "dispatched") throw simulatedCrash()
  // 9b. What the provider answered goes on the reservation's attempt (F08), fail-open: should the commit fail for
  // good, the reconciler settles at this charge instead of the worst case. For an HTTP operation the same transaction
  // records the attempt receipt on its marker (audit F09), so a same-key retry can publish the answer with no second call.
  if (dispatched) {
    const receipt: P1Receipt = {
      outcome: outcome === "ok" ? "ok" : "failed",
      ...(outcome === "ok" && text !== undefined ? { text } : {}),
      inputTokens,
      outputTokens,
      tokensEstimated,
      costMicroUsd: cost,
      model,
      ...(modelReported === null ? {} : { modelReported }),
      classification,
      outbound,
    }
    await recordAttemptOutcomeRetrying(
      db,
      resRef,
      { result: outcome, inputTokens, outputTokens, tokensEstimated, costMicroUsd: cost, ...providerIds, ...(modelReported === null ? {} : { modelReported }) },
      operation ? { operation: operation.operation, traceId, receipt } : undefined
    ).catch((err: unknown) => {
      logger.warn("p1.attempt_outcome_failed", { firmId, usageLogId: usageRef.id, code: errorCode(err) })
      // Re-audit LOW-2: the operation's receipt is lost. A same-key retry answers 409 idempotency_effect_committed for
      // this charged call (never a second one); this line names what an operator needs to find it.
      if (operation) {
        logger.error("p1.receipt_record_failed", {
          firmId,
          usageLogId: usageRef.id,
          operationId: operation.operation.fields.operationId ?? null,
          traceId,
          code: errorCode(err),
        })
      }
    })
    reservation = { ref: resRef, state: settledState(true, outcome, cost), mustBeLive: true }
  }
  if (dispatched && t.crashAt === "recorded") throw simulatedCrash()

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
    system: outcome === "blocked" ? null : built.system,
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
    // Audit F17 (ruling 4): beside the configured model, what the provider reported (null when it named none).
    modelReported,
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
  let staged: StageResult = { ...NOTHING_STAGED, crossings: [] }
  let accounting: P1Accounting = "pending"
  try {
    await t.beforeCommit?.()
    staged = await commit(db, { usageRef, configRef, totalRef, record, traceId, failCommit: t.failCommit === true, seam: t, reservation })
    accounting = "settled"
  } catch (err) {
    // The result is still returned (P3-63) and the log keeps the record; the reservation, when there is one, keeps
    // holding the worst case with its provider attempt, so the spend is never lost from the books (F08).
    logger.error("p1.usage_log_failed", { usageLogId: usageRef.id, ...record, accounting, code: errorCode(err) })
  }
  for (const c of staged.crossings) logger.warn("p1.budget_threshold", { firmId, monthKey, ...c })
  if (staged.exceeded !== null) logger.error("p1.reservation_exceeded", { firmId, usageLogId: usageRef.id, monthKey, ...staged.exceeded })
  logLearning(usageRef.id, firmId, staged)

  return {
    outcome,
    blockReason,
    ...(outcome === "ok" ? { text } : {}),
    usageLogId: usageRef.id,
    traceId,
    model,
    modelReported,
    classification,
    inputTokens,
    outputTokens,
    costMicroUsd: cost,
    outbound,
    accounting,
  }
}

export type ReserveArgs = {
  firmId: string
  monthKey: string
  /** The call's clock when it reserves: the lease runs from it, and a live reservation is one whose lease is later. */
  nowMs: number
  /**
   * The masked request's content ceiling (`requestTokenCeiling` over its messages, audit F16), stored as
   * `reservedBodyTokens`; the transaction adds the overhead it reads (`reservationOverheadTokens`).
   */
  bodyTokens: number
  /**
   * FA-D3C-002: the output ceiling the reservation holds, in tokens: MAX_OUTPUT_TOKENS when absent (every chat call). An
   * embedding call has no output side and passes 0.
   */
  outputTokens?: number
  reservationRef: DocumentReference
  configRef: DocumentReference
  totalRef: DocumentReference
  seam: typeof p1TestSeam
  fields: {
    actorId: string
    matterId: string | null
    jobId: string | null
    taskType: LedgerTaskType
    model: string
    classification: Classification
    traceId: string
    idempotencyDoc?: string
  }
}

/**
 * The reservation transaction (F07), retried on P1's own back-off like the commit until RESERVE_DEADLINE_MS. Returns
 * "reserved", or the refusal it decided. A failure is thrown, unless a reservation of this call turns out to exist
 * (an attempt that committed and lost its answer), which is "reserved". Exported for `callP1Embedding` (FA-D3C-002).
 */
export async function reserve(db: Firestore, a: ReserveArgs): Promise<"reserved" | BlockReason> {
  const started = Date.now()
  const remaining = () => RESERVE_DEADLINE_MS - (Date.now() - started)
  let failure: unknown = reserveDeadlineError()
  for (let attempt = 1; attempt <= COMMIT_MAX_ATTEMPTS; attempt++) {
    const left = remaining()
    if (left <= 0) {
      failure = reserveDeadlineError()
      break
    }
    try {
      // Waiting in the firm's ledger queue counts against the deadline: at most `left`, then the deadline error.
      return await inLedgerQueue(a.firmId, "reserve", a.seam, left, reserveDeadlineError, () => {
        if (remaining() <= 0) throw reserveDeadlineError()
        return db.runTransaction(
          (tx) => {
            const injected = a.seam.reserveAttemptFailures?.shift()
            if (injected) throw injected
            return stageReservation(db, tx, a)
          },
          { maxAttempts: 1 }
        )
      })
    } catch (err) {
      failure = err
      if (isAlreadyExists(err) || !isRetryableCommitError(err)) break
      const wait = Math.min(commitBackoffMs(attempt), remaining())
      if (wait <= 0) {
        failure = reserveDeadlineError()
        break
      }
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  try {
    const snap = await a.reservationRef.get()
    if (snap.exists && snap.get("traceId") === a.fields.traceId && snap.get("state") === "reserved") return "reserved"
  } catch {
    // Unknown: reported as the failure below; the call's commit or the reconciler releases a reservation that landed.
  }
  throw failure
}

/**
 * One reservation attempt. Reads the platform's and the firm's kill switches, the month total, the firm's config, the
 * learned request overhead and the firm's open reservations. The worst case is decided here, on the overhead it reads:
 * the body's ceiling plus the larger of the cost table's overhead and the one learned for the model (Copilot finding on
 * PR #40), with the 4,096-token output ceiling. Then it refuses, in this order: a kill switch that blocks the routed model
 * (`kill_switch_platform`, `kill_switch_firm`: a switch set after the call's first read still stops it here, re-audit
 * R1-D3); no valid budget (`budget_not_set`, the budget may have changed since the first read); unresolved accounting
 * (`accounting_indeterminate`, F08: a provider attempt whose lease lapsed unsettled, or a reservation the reconciler
 * quarantined); a worst case that does not fit beside what is spent and held (`budget_exhausted`); and as many live
 * reservations as the firm may hold (`concurrency_exhausted`). Otherwise creates the reservation and adds its hold to
 * the month's `reservedMicroUsd`. A reservation whose lease lapsed with no attempt holds budget but no slot: nothing
 * was sent, and the reconciler releases it.
 */
async function stageReservation(db: Firestore, tx: Transaction, a: ReserveArgs): Promise<"reserved" | BlockReason> {
  const [totalSnap, configSnap, ownSnap, platformSnap, overheadSnap] = await tx.getAll(a.totalRef, a.configRef, a.reservationRef, platformConfigRef(), overheadRef())
  // An earlier attempt of this call committed and lost its answer: its reservation already holds the worst case.
  if (ownSnap!.exists && ownSnap!.get("traceId") === a.fields.traceId) return ownSnap!.get("state") === "reserved" ? "reserved" : "reservation_failed"
  const open = await tx.get(db.collection("ai_reservations").where("firmId", "==", a.firmId).where("state", "in", OPEN_RESERVATION_STATES))
  const overheadTokens = reservationOverheadTokens(a.fields.model, learnedOverheadOf(overheadSnap!.data(), a.fields.model))
  if (overheadTokens === null) return "model_unpriced"
  const reservedInputTokens = a.bodyTokens + overheadTokens
  const reservedOutputTokens = a.outputTokens ?? MAX_OUTPUT_TOKENS
  const worstCase = costMicroUsd(a.fields.model, reservedInputTokens, reservedOutputTokens)
  if (worstCase === null) return "model_unpriced"
  const config = configSnap!.data()
  if (killSwitchBlocks(platformSnap!.get("killSwitch"), a.fields.model)) return "kill_switch_platform"
  if (killSwitchBlocks(config?.killSwitch, a.fields.model)) return "kill_switch_firm"
  const budget = budgetOf(config)
  if (budget === null) return "budget_not_set"
  let active = 0
  let indeterminate = false
  for (const doc of open.docs) {
    if (doc.get("state") === "reconcile_failed") {
      indeterminate = true
      continue
    }
    const lease = leaseMillis(doc.get("leaseUntil"))
    const lapsed = lease === null || lease <= a.nowMs
    if (!lapsed) active += 1
    else if (doc.get("providerAttempt") != null) indeterminate = true
  }
  if (indeterminate) return "accounting_indeterminate"
  const total = totalSnap.data()
  if (spentOf(total) + reservedOf(total) + worstCase > budget) return "budget_exhausted"
  if (active >= maxConcurrentOf(config)) return "concurrency_exhausted"

  const now = FieldValue.serverTimestamp()
  tx.create(a.reservationRef, {
    firmId: a.firmId,
    ...a.fields,
    provider: PROVIDER_ID,
    usageLogId: a.reservationRef.id,
    monthKey: a.monthKey,
    // The input ceiling is the body's plus the overhead it was reserved with; a settlement that bills more input than
    // this learns the model's overhead from the difference (`stage`).
    reservedInputTokens,
    reservedBodyTokens: a.bodyTokens,
    reservedOverheadTokens: overheadTokens,
    reservedOutputTokens,
    reservedMicroUsd: worstCase,
    state: "reserved",
    leaseUntil: Timestamp.fromMillis(a.nowMs + RESERVATION_LEASE_MS),
    createdAt: now,
  })
  tx.set(a.totalRef, { firmId: a.firmId, monthKey: a.monthKey, reservedMicroUsd: FieldValue.increment(worstCase), updatedAt: now }, { merge: true })
  return "reserved"
}

/**
 * Records the provider attempt on the reservation, before dispatch (F08): `{ attemptedAt, outcome: "pending" }`,
 * only while the reservation is still held. Cut off after ATTEMPT_RECORD_TIMEOUT_MS; a failure means no dispatch.
 *
 * For an HTTP operation (audit F09) the same transaction is the dispatch fence: it reads the operation's effect marker
 * and creates it (`kind: "p1_dispatch"`, this call's usage row id and trace id) when it is absent. A marker carrying
 * this call's trace id is an earlier attempt of this transaction that committed and lost its answer, and the call goes
 * on; any other marker means the operation already dispatched (or committed another effect), and nothing is sent.
 * Exported for `callP1Embedding` (FA-D3C-002), which records its attempt the same way, with no operation.
 */
export async function markAttempt(
  db: Firestore,
  ref: DocumentReference,
  s: typeof p1TestSeam,
  op?: { operation: P1Operation; usageLogId: string; traceId: string }
): Promise<void> {
  const injected = s.attemptMarkFailures?.shift()
  if (injected) throw injected
  await withTimeout(
    db.runTransaction(
      async (tx) => {
        const [snap, marker] = op ? await tx.getAll(ref, op.operation.markerRef) : [await tx.get(ref)]
        if (!snap!.exists || snap!.get("state") !== "reserved") throw reservationNotLiveError()
        if (op) {
          if (marker!.exists) {
            if (marker!.get("traceId") !== op.traceId) throw operationFencedError()
          } else {
            tx.create(op.operation.markerRef, { ...op.operation.fields, kind: "p1_dispatch", usageLogId: op.usageLogId, traceId: op.traceId })
          }
        }
        tx.update(ref, { providerAttempt: { attemptedAt: FieldValue.serverTimestamp(), outcome: "pending" } })
      },
      { maxAttempts: 3 }
    ),
    ATTEMPT_RECORD_TIMEOUT_MS,
    "attempt_record_timeout"
  )
}

/**
 * After the provider answers: what it answered, what the call is charged and the provider's own ids, on the attempt
 * (F08, re-audit R1-D5). Only while the reservation is still held (re-audit INFO): once the reconciler has settled it,
 * the attempt keeps saying what that settlement was based on. For an HTTP operation (audit F09) the same transaction
 * records the attempt receipt on the operation's marker, only while the marker carries this call's trace id. Cut off
 * like the mark.
 */
export type AttemptOutcome = {
  result: P1Outcome
  inputTokens: number
  outputTokens: number
  tokensEstimated: boolean
  costMicroUsd: number
  responseId?: string
  requestId?: string
  /**
   * Audit F17 review round (Codex P2 on PR #63): the model the provider reported, a model id (`modelId`), so the lease
   * reconciler can carry it into a usage row it rebuilds from this attempt. Absent when none was reported.
   */
  modelReported?: string
}
type ReceiptArgs = { operation: P1Operation; traceId: string; receipt: P1Receipt }

/** Attempts at the attempt-outcome write (step 9b); after a failed one the wait is 100 ms, then 200 ms (re-audit LOW-2). */
export const ATTEMPT_OUTCOME_ATTEMPTS = 3
const ATTEMPT_OUTCOME_BACKOFF_MS = 100

/**
 * Step 9b with bounded retries (re-audit LOW-2). For an HTTP operation it carries the attempt receipt, so a lost write
 * would turn a later resume into a terminal 409 for a charged call. Up to ATTEMPT_OUTCOME_ATTEMPTS attempts, waits of
 * 100 then 200 ms between them, all inside the step's one ATTEMPT_RECORD_TIMEOUT_MS share of the time budget (no attempt
 * or wait starts past it, and each attempt is cut off at what is left), so CALL_WORST_CASE_MS is unchanged. Each
 * attempt rewrites the same values, so a retry after an attempt whose commit landed unseen changes nothing. The last
 * failure is rethrown; the call stays fail-open on it. Exported for `callP1Embedding` (FA-D3C-002).
 */
export async function recordAttemptOutcomeRetrying(db: Firestore, ref: DocumentReference, r: AttemptOutcome, op?: ReceiptArgs): Promise<void> {
  const started = Date.now()
  const remaining = () => ATTEMPT_RECORD_TIMEOUT_MS - (Date.now() - started)
  let failure: unknown = Object.assign(new Error("P1 attempt_outcome_timeout"), { code: "attempt_outcome_timeout" })
  for (let attempt = 1; attempt <= ATTEMPT_OUTCOME_ATTEMPTS; attempt++) {
    const left = remaining()
    if (left <= 0) break
    try {
      await recordAttemptOutcome(db, ref, r, op, left)
      return
    } catch (err) {
      failure = err
      const wait = ATTEMPT_OUTCOME_BACKOFF_MS * 2 ** (attempt - 1)
      if (attempt >= ATTEMPT_OUTCOME_ATTEMPTS || remaining() - wait <= 0) break
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw failure
}

async function recordAttemptOutcome(db: Firestore, ref: DocumentReference, r: AttemptOutcome, op: ReceiptArgs | undefined, timeoutMs: number): Promise<void> {
  await withTimeout(
    db.runTransaction(
      async (tx) => {
        const [snap, marker] = op ? await tx.getAll(ref, op.operation.markerRef) : [await tx.get(ref)]
        if (op && marker!.exists && marker!.get("traceId") === op.traceId) {
          // JSON round trip: the receipt holds no undefined value Firestore would reject.
          tx.update(op.operation.markerRef, { result: JSON.parse(JSON.stringify(op.receipt)) as P1Receipt, resultAt: FieldValue.serverTimestamp() })
        }
        if (snap!.get("state") !== "reserved") return
        tx.update(ref, {
          "providerAttempt.outcome": "returned",
          "providerAttempt.returnedAt": FieldValue.serverTimestamp(),
          "providerAttempt.result": r.result,
          "providerAttempt.inputTokens": r.inputTokens,
          "providerAttempt.outputTokens": r.outputTokens,
          "providerAttempt.tokensEstimated": r.tokensEstimated,
          "providerAttempt.costMicroUsd": r.costMicroUsd,
          ...(r.responseId === undefined ? {} : { "providerAttempt.responseId": r.responseId }),
          ...(r.requestId === undefined ? {} : { "providerAttempt.requestId": r.requestId }),
          ...(r.modelReported === undefined ? {} : { "providerAttempt.modelReported": r.modelReported }),
        })
      },
      { maxAttempts: 3 }
    ),
    timeoutMs,
    "attempt_outcome_timeout"
  )
}

export type UsageRecord = {
  firmId: string
  actorId: string
  taskType: LedgerTaskType
  model: string
  classification: Classification
  outcome: UsageOutcome
  blockReason: BlockReason | null
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  monthKey: string
} & Record<string, unknown>

export type CommitArgs = {
  usageRef: DocumentReference
  configRef: DocumentReference
  totalRef: DocumentReference
  record: UsageRecord
  /** The call's trace id; null only for a reconciled record whose reservation lost it (re-audit R1-D2). */
  traceId: string | null
  failCommit: boolean
  seam: typeof p1TestSeam
  /**
   * The call's reservation (F07, F08), settled in the same transaction: its hold leaves the month's
   * `reservedMicroUsd` and it takes `state` with `actualMicroUsd` (the record's cost). `mustBeLive`: the provider
   * was called, so a reservation no longer held (the reconciler settled it) fails the commit instead of being
   * counted twice; otherwise one that is absent or no longer held is left as it is.
   */
  reservation: { ref: DocumentReference; state: ClosedState; mustBeLive: boolean } | null
  /** Who settles the reservation; the reconciler's own transaction passes "reconciler". */
  settledBy?: "gateway" | "reconciler"
}

/**
 * Writes one decision in one transaction (P3-63, P3-65, P3-69) and returns the thresholds it crossed. The
 * transaction reads the month total and the firm's config to decide crossings on its own budget and spend
 * (`before*100 < t*budget <= after*100`), and skips a threshold whose alert already exists, so each fires
 * once per firm per month and a raised budget never re-arms one. A retryable failure is retried on P1's own
 * back-off (see COMMIT_DEADLINE_MS) until COMMIT_MAX_ATTEMPTS or the deadline. The usage row's `tx.create`
 * makes a retry after an unseen commit fail with ALREADY_EXISTS rather than double-count. Before any failure
 * is reported, the usage row is read: a commit found done returns the crossings its alert docs record, so an
 * unseen commit is never logged as a failure. Exported for `callP1Embedding` (FA-D3C-002).
 */
export async function commit(db: Firestore, args: CommitArgs): Promise<StageResult> {
  const clock = args.seam.wallClock ?? Date.now
  const started = clock()
  const remaining = () => COMMIT_DEADLINE_MS - (clock() - started)
  let failure: unknown = commitDeadlineError()
  for (let attempt = 1; attempt <= COMMIT_MAX_ATTEMPTS; attempt++) {
    const left = remaining()
    if (left <= 0) {
      failure = commitDeadlineError()
      break
    }
    try {
      // Waiting in the firm's ledger queue counts against the deadline: at most `left`, then the deadline error; the
      // deadline is checked again when the attempt leaves the queue.
      const staged = await inLedgerQueue(args.record.firmId, "commit", args.seam, left, commitDeadlineError, () => {
        if (remaining() <= 0) throw commitDeadlineError()
        return db.runTransaction(
          (tx) => {
            const injected = args.seam.commitAttemptFailures?.shift()
            if (injected) throw injected
            return stage(db, tx, args)
          },
          { maxAttempts: 1 }
        )
      })
      const lost = args.seam.lostCommitAnswers?.shift()
      if (lost) throw lost
      return staged
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
async function committedCrossings(db: Firestore, a: CommitArgs): Promise<StageResult | null> {
  try {
    const { firmId, monthKey } = a.record
    const [usage, ...alerts] = await db.getAll(a.usageRef, ...THRESHOLDS.map((t) => alertRef(firmId, monthKey, t)))
    if (!usage!.exists || usage!.get("trace.id") !== a.traceId) return null
    // An excess is durable on the reservation and in its event; only the after-commit log line is not repeated here.
    return {
      crossings: alerts.flatMap((snap, i) =>
        snap.exists && snap.get("usageLogId") === a.usageRef.id
          ? [{ threshold: THRESHOLDS[i]!, budgetMicroUsd: snap.get("budgetMicroUsd") as number, spentMicroUsd: snap.get("spentMicroUsd") as number }]
          : []
      ),
      exceeded: null,
      learnedOverhead: null,
      anomaly: null,
    }
  } catch {
    return null
  }
}

/**
 * Stages one decision in `tx` and returns the thresholds it crossed: the usage row, the month total, the
 * reservation's settlement, the audit row, the event and any alerts. Shared by the call's commit and by the
 * reconciler, which stages a `reconciled` record for a reservation whose call never settled it (F08).
 */
/**
 * A settlement above the reservation (re-audit R1-D1): the provider billed more than the call's ceiling. The charge is
 * still recorded in full, because it is owed; the excess is recorded on the reservation, raised as the event
 * `ai.reservation.exceeded`, and logged `p1.reservation_exceeded` after commit.
 */
export type Exceeded = { reservedMicroUsd: number; actualMicroUsd: number; excessMicroUsd: number }

/**
 * A request overhead learned from a settlement whose input tokens went past the reservation's input ceiling (Copilot
 * finding on PR #40): the input tokens billed less the body's ceiling, counted only up to the clamp (re-audit R3-D1),
 * now the model's overhead in `platform/p1Overhead`.
 */
export type LearnedOverhead = { model: string; inputTokens: number; exceededInputTokens: number }

/**
 * A breach that shows more overhead than the clamp allows (re-audit R3-D1): `overheadTokens` (input billed less the
 * body's ceiling) is above `clampTokens` (LEARNED_OVERHEAD_MAX_FACTOR times the table's overhead), so it counts only as
 * `learnedTokens`, the clamp. Recorded on the reservation (`usageAnomaly: true`), as the event `ai.usage.anomaly` and
 * logged `p1.overhead_anomaly` at ERROR: a provider report that implausible needs a person to look at it.
 */
export type UsageAnomaly = {
  monthKey: string
  model: string
  inputTokens: number
  bodyTokens: number
  overheadTokens: number
  learnedTokens: number
  clampTokens: number
}

/**
 * What one staged decision crossed: its threshold alerts, an excess over its reservation (or null), an overhead it
 * taught (or null), and an anomaly it showed (or null).
 */
export type StageResult = { crossings: Crossing[]; exceeded: Exceeded | null; learnedOverhead: LearnedOverhead | null; anomaly: UsageAnomaly | null }

/**
 * After a commit: every raise of a learned overhead is logged `p1.overhead_learned` at ERROR, so an operator sees each
 * one, and an anomaly is logged `p1.overhead_anomaly` at ERROR (re-audit R3-D1). Shared by the call and the reconciler.
 */
export function logLearning(usageLogId: string, firmId: string, staged: StageResult): void {
  if (staged.learnedOverhead !== null) logger.error("p1.overhead_learned", { usageLogId, ...staged.learnedOverhead })
  if (staged.anomaly !== null) logger.error("p1.overhead_anomaly", { firmId, usageLogId, ...staged.anomaly })
}

/** A stage that crossed nothing, exceeded nothing, taught nothing and showed no anomaly. */
export const NOTHING_STAGED: Readonly<StageResult> = Object.freeze({ crossings: [], exceeded: null, learnedOverhead: null, anomaly: null })

/** A count, when it is a non-negative integer. */
function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export async function stage(db: Firestore, tx: Transaction, a: CommitArgs): Promise<StageResult> {
  const { record: r, usageRef } = a
  const [totalSnap, configSnap, reservationSnap] = await tx.getAll(a.totalRef, a.configRef, ...(a.reservation ? [a.reservation.ref] : []))
  const live = reservationSnap?.exists === true && reservationSnap.get("state") === "reserved"
  if (a.reservation?.mustBeLive && !live) throw reservationNotLiveError()
  const held = live ? reservedOf({ reservedMicroUsd: reservationSnap!.get("reservedMicroUsd") }) : 0
  const before = spentOf(totalSnap!.data())
  const after = before + r.costMicroUsd
  const budget = budgetOf(configSnap!.data())
  const candidates = budget === null ? [] : THRESHOLDS.filter((t) => before * 100 < t * budget && t * budget <= after * 100)
  const alertSnaps = candidates.length > 0 ? await tx.getAll(...candidates.map((t) => alertRef(r.firmId, r.monthKey, t))) : []
  const crossed = candidates.filter((_t, i) => !alertSnaps[i]!.exists)
  const exceeded: Exceeded | null = live && r.costMicroUsd > held ? { reservedMicroUsd: held, actualMicroUsd: r.costMicroUsd, excessMicroUsd: r.costMicroUsd - held } : null
  // A breach on the input side (Copilot finding on PR #40): the provider billed more input than the body's ceiling plus
  // the overhead reserved. The overhead it shows (input billed less the body's ceiling) becomes the model's, counted
  // only up to the clamp (re-audit R3-D1: the learned overhead is platform-wide, so one report must not be able to
  // price every firm out), when that is larger than the one already learned: read here, before any write, and raised in
  // this transaction. More than the clamp is an anomaly, recorded and raised in this transaction too.
  const reservedIn = exceeded === null ? null : countOf(reservationSnap!.get("reservedInputTokens"))
  const bodyIn = exceeded === null ? null : countOf(reservationSnap!.get("reservedBodyTokens"))
  const exceededInputTokens = reservedIn !== null && r.inputTokens > reservedIn ? r.inputTokens - reservedIn : 0
  const clamp = learnedOverheadCap(r.model)
  let learnedOverhead: LearnedOverhead | null = null
  let anomaly: UsageAnomaly | null = null
  if (exceededInputTokens > 0 && bodyIn !== null && clamp !== null) {
    const shown = r.inputTokens - bodyIn
    const counted = Math.min(shown, clamp)
    if (shown > clamp) {
      anomaly = { monthKey: r.monthKey, model: r.model, inputTokens: r.inputTokens, bodyTokens: bodyIn, overheadTokens: shown, learnedTokens: counted, clampTokens: clamp }
    }
    if (counted > learnedOverheadOf((await tx.get(overheadRef())).data(), r.model)) learnedOverhead = { model: r.model, inputTokens: counted, exceededInputTokens }
  }
  if (a.failCommit) throw new Error("p1TestSeam.failCommit")

  const now = FieldValue.serverTimestamp()
  const inc = (n: number) => FieldValue.increment(n)
  tx.create(usageRef, { ...r, createdAt: now })
  // Spend and tokens move by the record's own figures, by one rule for every outcome: an ok call and a billed
  // failure add their charge (I1); a blocked call and an unbilled failure add 0, so only their `calls` counter moves.
  // A settled reservation's hold leaves `reservedMicroUsd` in the same write (F07).
  tx.set(
    a.totalRef,
    {
      firmId: r.firmId,
      monthKey: r.monthKey,
      spentMicroUsd: inc(r.costMicroUsd),
      inputTokens: inc(r.inputTokens),
      outputTokens: inc(r.outputTokens),
      calls: {
        ok: inc(r.outcome === "ok" ? 1 : 0),
        failed: inc(r.outcome === "failed" ? 1 : 0),
        blocked: inc(r.outcome === "blocked" ? 1 : 0),
        ...(r.outcome === "reconciled" ? { reconciled: inc(1) } : {}),
      },
      ...(live ? { reservedMicroUsd: inc(-held) } : {}),
      updatedAt: now,
    },
    { merge: true }
  )
  if (live) {
    tx.update(a.reservation!.ref, {
      state: a.reservation!.state,
      actualMicroUsd: r.costMicroUsd,
      ...(exceeded === null ? {} : { exceededMicroUsd: exceeded.excessMicroUsd }),
      ...(exceededInputTokens > 0 ? { exceededInputTokens } : {}),
      ...(anomaly === null ? {} : { usageAnomaly: true }),
      settledAt: now,
      settledBy: a.settledBy ?? "gateway",
    })
  }
  if (anomaly !== null) {
    tx.create(db.collection("events").doc(`${usageRef.id}_usage_anomaly`), {
      name: "ai.usage.anomaly",
      firmId: r.firmId,
      payload: anomaly,
      classification: "internal",
      occurredAt: now,
      idempotencyKey: `${usageRef.id}:usage_anomaly`,
    })
  }
  if (learnedOverhead !== null) {
    tx.set(
      overheadRef(),
      { models: { [modelOverheadKey(learnedOverhead.model)]: { model: learnedOverhead.model, inputTokens: learnedOverhead.inputTokens, usageLogId: usageRef.id, learnedAt: now } }, updatedAt: now },
      { merge: true }
    )
  }
  if (exceeded !== null) {
    tx.create(db.collection("events").doc(`${usageRef.id}_reservation_exceeded`), {
      name: "ai.reservation.exceeded",
      firmId: r.firmId,
      payload: { monthKey: r.monthKey, ...exceeded },
      classification: "internal",
      occurredAt: now,
      idempotencyKey: `${usageRef.id}:reservation_exceeded`,
    })
  }
  stageAudit(
    r.outcome === "reconciled"
      ? {
          firmId: r.firmId,
          actorId: "system",
          action: "ai.gateway.reconciled",
          target: `ai_usage_logs/${usageRef.id}`,
          classification: r.classification,
          decision: "allow",
          reason: String(r.reconciledFrom),
        }
      : {
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

  const crossings = crossed.map((threshold) => {
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
  return { crossings, exceeded, learnedOverhead, anomaly }
}
