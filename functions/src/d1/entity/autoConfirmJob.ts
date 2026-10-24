import { createHash } from "node:crypto"
import { logger } from "firebase-functions"
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../../admin"
import { logFailure } from "../../log"
import { stageAudit } from "../../p5/audit"
import { isSafeDocId } from "../../p5/common"
import { MAX_FENCED_STEPS } from "../../p2/constants"
import type { JobSpec } from "../../p2/enqueue"
import { JobError } from "../../p2/errors"
import type { JobContext, JobHandler, JobResult } from "../../p2/registry"
import { l17_2Enabled, maxLabel } from "../conflict/engine"
import { bumpRegistryVersion } from "../registryVersion"
import { AUTO_CONFIRM_DEFERRALS, AUTO_CONFIRM_RECHECK_MS, deferralIdOf, deferralRecord, deferralRefOf, inBacklog, judgeRows, type DeferralReason } from "./autoConfirmDeferral"
import { autoConfirmProgressRef, cursorOf, FrontierScan, type Cursor, type FrontierPair } from "./autoConfirmFrontier"
import { DETERMINISTIC_KEY_SCORE, LINK_AUTO_CONFIRM_MS } from "./linkState"
import { snapOf } from "./ops"
import { entityKeys, type EntityKeys } from "./summary"

/**
 * `d1.autoconfirm` (spec P3-42..P3-58, O-28, L17.2 #16; audit F38): the daily job that materialises the
 * 30-day auto-confirm. For each firm pair whose key rows are all undisputed candidates created at
 * least 30 days ago, it writes the immutable `merge_events` row a human confirmation would write
 * (actor `system`), sets every row `confirmed`, emits `entity.confirmed` and stages the
 * `entity.confirm` audit row, so the pair can be un-merged (E-43) and a late dispute is no longer
 * possible (a partner un-merges instead).
 *
 * Exactly once per pair, by state: a step re-reads each of its pairs in the step's transaction and
 * confirms only a pair that is still an auto-confirmed candidate on every row, and whose merge event
 * does not exist yet (the id is derived from the pair, P3-57; the skip is logged, O-52). A step commits
 * at most once per job (`runFenced`) and is named by its position (`autoconfirm-<n>`, P3-53), so a
 * job never records more than 48 step ids. Each step re-reads the L17.2 flag; once it reads off, that
 * step and the rest of the run write nothing (P3-56).
 *
 * Progress (audit F38; spec `docs/superpowers/specs/2026-10-18-f38-auto-confirm-progress-design.md`):
 * - the run walks the frontier (`autoConfirmFrontier.ts`) from the firm's cursor, so a pair it cannot
 *   confirm is passed once and never holds back the pairs behind it; each step moves the cursor in its
 *   own transaction;
 * - a pair it cannot confirm gets a deferral record with its reason and due time
 *   (`autoConfirmDeferral.ts`); once the frontier is drained, the run re-checks the records that are due;
 * - a position an earlier attempt recorded is spent, and its chunk goes to the next position (R8);
 * - after its steps the run checkpoints (one transaction, the claim's fence and the flag re-read): it enqueues the next continuation
 *   while work remains (at most `AUTO_CONFIRM_MAX_CONTINUATIONS` per period) and records the cursor, the
 *   run and the backlog age, which raises `autoconfirm.backlog_stale` past `AUTO_CONFIRM_STALE_MS`.
 */

export const AUTO_CONFIRM_JOB_TYPE = "d1.autoconfirm"
export const AUTO_CONFIRM_SPEC = { jobType: AUTO_CONFIRM_JOB_TYPE, cron: "15 2 * * *", period: "day" } as const

/** Pairs materialised per fenced step (one transaction). */
export const AUTO_CONFIRM_STEP_PAIRS = 10
/** Positional steps per run (P3-53): ids are reused on a retry, so a job never records more than 48 of its MAX_FENCED_STEPS; the two spare are headroom. */
export const AUTO_CONFIRM_MAX_STEPS = MAX_FENCED_STEPS - 2
export { AUTO_CONFIRM_PAGE_ROWS, AUTO_CONFIRM_ROW_LIMIT } from "./autoConfirmFrontier"
/** Continuation runs one period may enqueue after its scheduled run (F38 R6): at most 24 runs per firm per day. */
export const AUTO_CONFIRM_MAX_CONTINUATIONS = 23
/** The backlog is stale when its oldest pending work has been due this long (F38 R11): the daily cadence plus the scheduler's retries. */
export const AUTO_CONFIRM_STALE_MS = 36 * 60 * 60 * 1000
export const AUTO_CONFIRM_NOTE = "Auto-confirmed: undisputed for 30 days (L18 section 7.1)."

type Payload = { period: string; continuation: number }
type Phase = "frontier" | "recheck"

/** Test hooks (spec P3-56, P3-58; F38), set in a test and cleared after it. Never set in production code. */
export const autoConfirmTestSeam: {
  /** Before the run's flag read: a throw stands in for that read failing. */
  beforeFlagRead?: () => Promise<void>
  /** Before fenced step `index` of attempt `attempt`, with the pair ids it is given; a throw fails the attempt there. */
  beforeStep?: (step: { attempt: number; index: number; pairIds: readonly string[]; continuation: number; phase: Phase }) => Promise<void>
  /** Before the run's checkpoint transaction; a throw fails the attempt after its steps. */
  beforeCheckpoint?: (run: { attempt: number; continuation: number }) => Promise<void>
} = {}

/** The handler's own codes (P3-9): `flag_read_failed` is retryable (P3-56). */
const errorCodes = {
  flag_read_failed: "The firm's feature flags could not be read.",
} as const

const invalid = () => new JobError("invalid_payload", { permanent: true })

/** `{ period }` (the scheduled run, continuation 0) or `{ period, continuation }` with continuation 1..23 (F38 R6); nothing else. */
function parse(payload: unknown): Payload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid()
  const raw = payload as Record<string, unknown>
  if (!Object.keys(raw).every((key) => key === "period" || key === "continuation")) throw invalid()
  if (typeof raw.period !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.period)) throw invalid()
  if (!Object.hasOwn(raw, "continuation")) return { period: raw.period, continuation: 0 }
  const n = raw.continuation
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > AUTO_CONFIRM_MAX_CONTINUATIONS) throw invalid()
  return { period: raw.period, continuation: n }
}

/** The run key (and idempotency key) of the period's run `n`: the scheduled run's key for 0 (P3-16), `:c<n>` after it. */
export function autoConfirmRunKey(period: string, n: number): string {
  return n === 0 ? `${AUTO_CONFIRM_JOB_TYPE}:${period}` : `${AUTO_CONFIRM_JOB_TYPE}:${period}:c${n}`
}

/** The continuation `n` of the period's run for the firm (F38 R6): the scheduled run's shape, its own key. */
function continuationSpec(firmId: string, period: string, n: number): JobSpec {
  const key = autoConfirmRunKey(period, n)
  return { firmId, jobType: AUTO_CONFIRM_JOB_TYPE, classification: "internal", matterId: null, payload: { period, continuation: n }, idempotencyKey: key, runKey: key, createdBy: "system" }
}

/**
 * The pair's merge event id (P3-57): `auto_` and the first 32 hex characters of
 * SHA-256(firmId NUL pairId NUL the sorted link ids joined by commas).
 */
export function mergeEventIdOf(firmId: string, pairId: string, linkIds: readonly string[]): string {
  const digest = createHash("sha256").update(`${firmId}\0${pairId}\0${[...linkIds].sort().join(",")}`).digest("hex")
  return `auto_${digest.slice(0, 32)}`
}

type Row = { ref: DocumentReference; data: DocumentData }

type Pair = {
  a: string
  b: string
  pairId: string
  rows: Row[]
  /** The rows' ids, sorted. */
  linkIds: string[]
  mergeEventId: string
  left: DocumentData
  right: DocumentData
  label: Classification
}

/** A pair as read in a step: whole, or held back by an entity (missing or another firm's), with its rows either way. */
type PairRead = { kind: "pair"; pair: Pair } | { kind: "entity"; reason: "entity_missing" | "entity_other_firm"; rows: Row[] }

/** Reads a pair (rows, both entities, their clients) in `tx` without a caller, in main's order; clients only when both entities are this firm's. */
async function readPair(tx: Transaction, firmId: string, a: string, b: string): Promise<PairRead> {
  const db = adminDb()
  const snap = await tx.get(db.collection("entity_links").where("firmId", "==", firmId).where("leftId", "==", a).where("rightId", "==", b))
  const rows = snap.docs.map((d) => ({ ref: d.ref, data: d.data() }))
  const [leftSnap, rightSnap] = await tx.getAll(db.collection("entities").doc(a), db.collection("entities").doc(b))
  const left = leftSnap.data()
  const right = rightSnap.data()
  if (!left || !right) return { kind: "entity", reason: "entity_missing", rows }
  if (left.firmId !== firmId || right.firmId !== firmId) return { kind: "entity", reason: "entity_other_firm", rows }
  const clientLabels: unknown[] = []
  for (const entityId of [a, b]) {
    const owner = await tx.get(db.collection("clients").where("firmId", "==", firmId).where("entityId", "==", entityId).limit(1))
    for (const doc of owner.docs) clientLabels.push(doc.data().classification)
  }
  const label = [...rows.map((r) => r.data.classification), left.classification, right.classification, ...clientLabels].reduce<Classification>((acc, l) => maxLabel(acc, l), "public")
  const pairId = `${a}_${b}`
  const linkIds = rows.map((r) => r.ref.id).sort()
  return { kind: "pair", pair: { a, b, pairId, rows, linkIds, mergeEventId: mergeEventIdOf(firmId, pairId, linkIds), left, right, label } }
}

/**
 * Stages the materialisation of one pair, all in the step's transaction: the merge event, every
 * row confirmed, `entity.confirmed`, and the system's `entity.confirm` audit row.
 */
function stageMaterialisation(tx: Transaction, firmId: string, pair: Pair, atMs: number): void {
  const db = adminDb()
  const at = Timestamp.fromMillis(atMs)
  const effectiveAt = Timestamp.fromMillis(Math.max(...pair.rows.map((r) => (r.data.createdAt as Timestamp).toMillis())) + LINK_AUTO_CONFIRM_MS)
  const mergeRef = db.collection("merge_events").doc(pair.mergeEventId)
  const keys = [...new Set(pair.rows.map((r) => String(r.data.key)))].sort()
  const leftKeys = entityKeys(pair.left)
  const keyValues: Record<string, string> = {}
  for (const key of keys) {
    const value = leftKeys[key as keyof EntityKeys]
    if (value !== undefined) keyValues[key] = value
  }
  tx.create(mergeRef, {
    firmId,
    kind: "link_confirmed",
    leftId: pair.a,
    rightId: pair.b,
    pairId: pair.pairId,
    linkIds: pair.linkIds,
    keys,
    evidence: { note: AUTO_CONFIRM_NOTE, keyValues },
    score: DETERMINISTIC_KEY_SCORE,
    basis: "auto_confirm",
    // P3-55: the pair's prior effective state, as confirmMerge records it (ops.ts priorStateOf).
    // Every pair this job confirms has auto-confirmed, which the re-check requires.
    priorState: "auto_confirmed",
    actorId: "system",
    actorRole: "system",
    confirmedAt: at,
    effectiveAt,
    createdAt: FieldValue.serverTimestamp(),
    snapshot: { left: snapOf(pair.a, pair.left), right: snapOf(pair.b, pair.right) },
    reverted: false,
    classification: pair.label,
  })
  const confirmation = { by: "system", role: "system", at, note: AUTO_CONFIRM_NOTE, mergeEventId: mergeRef.id, auto: true, effectiveAt }
  for (const r of pair.rows) tx.update(r.ref, { state: "confirmed", confirmation, classification: pair.label })
  tx.create(db.collection("events").doc(`${mergeRef.id}_confirmed`), {
    name: "entity.confirmed",
    firmId,
    payload: { entityIds: [pair.a, pair.b], mergeEventId: mergeRef.id, score: DETERMINISTIC_KEY_SCORE },
    classification: pair.label,
    occurredAt: FieldValue.serverTimestamp(),
    idempotencyKey: `${mergeRef.id}:confirmed`,
  })
  // P3-54 (E-42(i)): the automatic confirmation is in the same audit trail as a human one.
  stageAudit(
    {
      firmId,
      actorId: "system",
      onBehalfOf: "system",
      action: "entity.confirm",
      target: `merge_events/${mergeRef.id}`,
      classification: pair.label,
      decision: "allow",
      reason: "auto_confirm",
    },
    tx
  )
}

/** One item of a step: a pair, or a deferral record that cannot name one (this job never writes one), which the step deletes. */
type Item = ({ kind: "pair" } & FrontierPair) | { kind: "malformed"; ref: DocumentReference }

const itemId = (item: Item): string => (item.kind === "pair" ? item.pairId : item.ref.id)

/** A due deferral record as a step item: its pair when the record is this firm's and its ids are sound, else malformed. */
function itemOf(firmId: string, ref: DocumentReference, data: DocumentData): Item {
  const { leftId: a, rightId: b, pairId } = data
  const sound = data.firmId === firmId && isSafeDocId(a) && isSafeDocId(b) && a !== b && pairId === `${a}_${b}` && ref.id === deferralIdOf(firmId, pairId)
  return sound ? { kind: "pair", a, b, pairId } : { kind: "malformed", ref }
}

/** What a step does with one pair (F38 R3): confirm it, defer it (why, which row, until when), or note that it has left the backlog. */
type Verdict = { kind: "confirm"; pair: Pair } | { kind: "gone" } | { kind: "defer"; reason: DeferralReason; rowId: string | null; recheckAtMs: number }

/** One step decision, with the pair's deferral record as read in the step (written or deleted after every read). */
type Decision =
  | { kind: "drop"; ref: DocumentReference }
  | { kind: "pair"; item: FrontierPair; linkIds: string[]; ref: DocumentReference; previous: DocumentData | undefined; verdict: Verdict }

/** Judges a pair read in the step: its rows first (has it left the backlog?), then its entities, then the re-check and the event. */
async function judgePair(tx: Transaction, firmId: string, read: PairRead, nowMs: number): Promise<Verdict> {
  const rows = read.kind === "pair" ? read.pair.rows : read.rows
  if (!rows.some((r) => inBacklog(r.data, nowMs))) return { kind: "gone" }
  if (read.kind === "entity") return { kind: "defer", reason: read.reason, rowId: null, recheckAtMs: nowMs + AUTO_CONFIRM_RECHECK_MS }
  // The re-check (P3-44, P3-58), the rule the read-time state uses: every row an auto-confirmed candidate.
  const verdict = judgeRows(rows.map((r) => ({ id: r.ref.id, data: r.data })), nowMs)
  if (verdict.kind === "gone") return verdict
  if (verdict.kind === "deferred") return { kind: "defer", reason: verdict.reason, rowId: verdict.rowId, recheckAtMs: verdict.recheckAtMs }
  if ((await tx.get(adminDb().collection("merge_events").doc(read.pair.mergeEventId))).exists) {
    // P3-57: the pair's event already exists, so the pair is skipped. Normally that is a pair
    // already done; a pair whose rows still read auto-confirmed beside an existing event is an
    // inconsistent state (O-52), so the skip is logged, by code and ids only.
    logger.warn("autoconfirm.event_exists_skip", { firmId, pairId: read.pair.pairId })
    return { kind: "defer", reason: "event_exists", rowId: null, recheckAtMs: nowMs + AUTO_CONFIRM_RECHECK_MS }
  }
  return { kind: "confirm", pair: read.pair }
}

type StepCounts = { confirmed: number; deferred: number; gone: number }

type StepInput = { firmId: string; jobId: string; firmRef: DocumentReference; nowMs: number; items: Item[]; cursor: Cursor | null }

/**
 * One fenced step's transaction: the flag (P3-56); then, per item, main's reads of the pair, its merge event
 * (only when its rows are all auto-confirmed, P3-57) and its deferral record; then the writes. A pair is
 * confirmed (and its record deleted), deferred (record written), or has left the backlog (record deleted).
 * The registry is bumped only when a pair is confirmed (P3-47); the cursor, when given, moves in the same commit.
 */
async function runStep(tx: Transaction, s: StepInput): Promise<StepCounts | "flag_off"> {
  if (!l17_2Enabled((await tx.get(s.firmRef)).data())) return "flag_off"
  const decisions: Decision[] = []
  for (const item of s.items) {
    if (item.kind === "malformed") {
      decisions.push({ kind: "drop", ref: item.ref })
      continue
    }
    const read = await readPair(tx, s.firmId, item.a, item.b)
    const verdict = await judgePair(tx, s.firmId, read, s.nowMs)
    const linkIds = (read.kind === "pair" ? read.pair.rows : read.rows).map((r) => r.ref.id).sort()
    const ref = deferralRefOf(s.firmId, item.pairId)
    decisions.push({ kind: "pair", item, linkIds, ref, previous: (await tx.get(ref)).data(), verdict })
  }

  const counts: StepCounts = { confirmed: 0, deferred: 0, gone: 0 }
  for (const d of decisions) {
    if (d.kind === "drop") {
      tx.delete(d.ref)
      continue
    }
    const { item, verdict } = d
    if (verdict.kind === "defer") {
      const { reason, rowId, recheckAtMs } = verdict
      tx.set(d.ref, deferralRecord({ firmId: s.firmId, pairId: item.pairId, leftId: item.a, rightId: item.b, linkIds: d.linkIds, reason, rowId, recheckAtMs, nowMs: s.nowMs, jobId: s.jobId, previous: d.previous }))
      counts.deferred += 1
      continue
    }
    if (verdict.kind === "confirm") {
      stageMaterialisation(tx, s.firmId, verdict.pair, s.nowMs)
      counts.confirmed += 1
    } else counts.gone += 1
    if (d.previous !== undefined) tx.delete(d.ref)
  }
  if (counts.confirmed > 0) bumpRegistryVersion(tx, s.firmId)
  if (s.cursor !== null) tx.set(autoConfirmProgressRef(s.firmId), { firmId: s.firmId, kind: "autoconfirm", classification: "internal", cursor: s.cursor, updatedAt: Timestamp.fromMillis(s.nowMs) }, { merge: true })
  return counts
}

/** The firm's deferral records due at `nowMs`, oldest due first. */
const dueRecords = (firmId: string, nowMs: number, limit: number) =>
  adminDb().collection(AUTO_CONFIRM_DEFERRALS).where("firmId", "==", firmId).where("recheckAt", "<=", Timestamp.fromMillis(nowMs)).orderBy("recheckAt").limit(limit).get()

type RunTotals = StepCounts & { rechecked: number }
type Pending = { ms: number; source: "frontier" | "recheck" } | null
type Outcome = "drained" | "continued" | "backlog_remaining"

type CheckpointInput = {
  firmId: string
  jobId: string
  period: string
  continuation: number
  nowMs: number
  firmRef: DocumentReference
  frontier: FrontierScan
  frontierNext: Timestamp | null
  totals: RunTotals
  /** The claim's fence check (`ctx.checkFence`), made first in the checkpoint's transaction (R7 amendment). */
  checkFence: (tx: Transaction) => Promise<void>
}

/**
 * The run's checkpoint (F38 R6, R7, R10, R11), one transaction that is not a fenced step (so it costs no step id):
 * it first checks the claim's fence with the engine's own check (`ctx.checkFence`, R7 amendment, PR #84 review),
 * so an attempt whose claim was taken, finished or dead-lettered meanwhile writes nothing and the run fails as
 * `LeaseLostError` (the worker then records nothing, `lease_lost`); it writes nothing either when the flag reads off
 * (P3-56); otherwise it enqueues the next continuation while work remains and the period has one left, and records
 * the cursor, the run and the backlog. The stale alert and its clearing are logged after it commits. Nothing here
 * needs exactly-once: the enqueue is idempotent by key, a cursor that moves back only re-scans, and the record
 * describes the latest run.
 */
async function checkpoint(c: CheckpointInput): Promise<void> {
  const db = adminDb()
  const now = Timestamp.fromMillis(c.nowMs)
  const due = await dueRecords(c.firmId, c.nowMs, 1)
  const recheckMs = due.empty ? null : (due.docs[0].get("recheckAt") as Timestamp).toMillis()
  const frontierMs = c.frontierNext === null ? null : c.frontierNext.toMillis() + LINK_AUTO_CONFIRM_MS
  let pending: Pending = null
  if (frontierMs !== null) pending = { ms: frontierMs, source: "frontier" }
  if (recheckMs !== null && (pending === null || recheckMs < pending.ms)) pending = { ms: recheckMs, source: "recheck" }
  const next = pending !== null && c.continuation < AUTO_CONFIRM_MAX_CONTINUATIONS ? c.continuation + 1 : null
  const outcome: Outcome = pending === null ? "drained" : next !== null ? "continued" : "backlog_remaining"
  const ageMs = pending === null ? null : c.nowMs - pending.ms
  const stale = ageMs !== null && ageMs > AUTO_CONFIRM_STALE_MS
  const cursor = c.frontier.cursorAfter(0)
  // p2/enqueue imports the job registry, which imports this module: loaded when needed, so the two never form a cycle at load.
  const { enqueueJob } = await import("../../p2/enqueue")
  const progressRef = autoConfirmProgressRef(c.firmId)

  const result = await db.runTransaction(async (tx) => {
    // R7 amendment: only while this attempt still holds the claim, read in this transaction (throws LeaseLostError).
    await c.checkFence(tx)
    if (!l17_2Enabled((await tx.get(c.firmRef)).data())) return null
    const previous = (await tx.get(progressRef)).data()
    const wasStale = previous?.firmId === c.firmId && previous.backlog?.alert === "stale"
    if (next !== null) await enqueueJob(tx, continuationSpec(c.firmId, c.period, next), { now: c.nowMs })
    const alertSince = !stale ? null : wasStale && previous!.backlog.alertSince instanceof Timestamp ? previous!.backlog.alertSince : now
    tx.set(
      progressRef,
      {
        firmId: c.firmId,
        kind: "autoconfirm",
        classification: "internal",
        ...(cursor === null ? {} : { cursor }),
        updatedAt: now,
        lastRun: { jobId: c.jobId, period: c.period, continuation: c.continuation, at: now, outcome, ...c.totals, skippedRows: c.frontier.skippedRows },
        backlog: { pendingSince: pending === null ? null : Timestamp.fromMillis(pending.ms), source: pending?.source ?? null, ageMs, alert: stale ? "stale" : null, alertSince },
      },
      { merge: true }
    )
    return { wasStale }
  })
  if (result === null) return
  if (stale) logger.error("autoconfirm.backlog_stale", { firmId: c.firmId, jobId: c.jobId, source: pending!.source, ageMs, event: "autoconfirm.backlog_stale" })
  else if (result.wasStale) logger.info("autoconfirm.backlog_cleared", { firmId: c.firmId, jobId: c.jobId })
  if (outcome === "backlog_remaining") logger.warn("autoconfirm.backlog_remaining", { firmId: c.firmId, jobId: c.jobId, period: c.period, continuation: c.continuation })
}

async function run(ctx: JobContext<Payload>): Promise<JobResult> {
  const { firmId, id: jobId, attempt } = ctx.job
  const { period, continuation } = ctx.payload
  const nowMs = ctx.now()
  const db = adminDb()
  const firmRef = db.collection("firms").doc(firmId)
  let firm: DocumentData | undefined
  try {
    await autoConfirmTestSeam.beforeFlagRead?.()
    firm = (await firmRef.get()).data()
  } catch (err) {
    logFailure("autoconfirm flag read failed", err)
    // P3-56: retried, not ended as done, so a transient read failure does not silently cost a day.
    throw new JobError("flag_read_failed")
  }
  // L17.2 off: every row reads as a candidate (P2-18), so nothing is confirmed.
  if (!l17_2Enabled(firm)) return {}

  const frontier = new FrontierScan(firmId, Timestamp.fromMillis(nowMs - LINK_AUTO_CONFIRM_MS), cursorOf((await autoConfirmProgressRef(firmId).get()).data(), firmId))
  const totals: RunTotals = { confirmed: 0, deferred: 0, gone: 0, rechecked: 0 }
  let position = 0
  /**
   * Runs `items` at the next position. P3-53: steps are named by position, so a retry reuses the same ids. A
   * position an earlier attempt recorded is spent (`runFenced` skips it) and the caller gives the same items to
   * the next position (F38 R8), so no chunk is skipped behind a moving cursor.
   */
  const step = async (items: Item[], cursor: Cursor | null, phase: Phase): Promise<"spent" | "flag_off" | "ran"> => {
    const index = position
    position += 1
    await autoConfirmTestSeam.beforeStep?.({ attempt, index, pairIds: items.map(itemId), continuation, phase })
    const result = await ctx.runFenced(`autoconfirm-${index}`, (tx) => runStep(tx, { firmId, jobId, firmRef, nowMs, items, cursor }))
    if (result === undefined) return "spent"
    if (result === "flag_off") return "flag_off"
    totals.confirmed += result.confirmed
    totals.deferred += result.deferred
    totals.gone += result.gone
    return "ran"
  }

  // The frontier (R1): pairs in the order their first row ages.
  while (position < AUTO_CONFIRM_MAX_STEPS) {
    await frontier.fill(AUTO_CONFIRM_STEP_PAIRS)
    const chunk = frontier.peek(AUTO_CONFIRM_STEP_PAIRS)
    if (chunk.length === 0) break
    const outcome = await step(
      chunk.map((p) => ({ kind: "pair", ...p })),
      frontier.cursorAfter(chunk.length),
      "frontier"
    )
    // P3-56: L17.2 switched off since the run began: this step wrote nothing and the run stops.
    if (outcome === "flag_off") return {}
    if (outcome === "ran") frontier.advance(chunk.length)
  }
  const frontierNext = await frontier.nextUnhandled()

  // Due rechecks (R5), once the frontier is drained, with the positions left.
  if (frontierNext === null && position < AUTO_CONFIRM_MAX_STEPS) {
    const due = await dueRecords(firmId, nowMs, (AUTO_CONFIRM_MAX_STEPS - position) * AUTO_CONFIRM_STEP_PAIRS)
    const items = due.docs.map((d) => itemOf(firmId, d.ref, d.data()))
    let i = 0
    while (i < items.length && position < AUTO_CONFIRM_MAX_STEPS) {
      const chunk = items.slice(i, i + AUTO_CONFIRM_STEP_PAIRS)
      const outcome = await step(chunk, null, "recheck")
      if (outcome === "flag_off") return {}
      if (outcome === "ran") {
        i += chunk.length
        totals.rechecked += chunk.length
      }
    }
  }

  await autoConfirmTestSeam.beforeCheckpoint?.({ attempt, continuation })
  await checkpoint({ firmId, jobId, period, continuation, nowMs, firmRef, frontier, frontierNext, totals, checkFence: (tx) => ctx.checkFence(tx) })
  return {}
}

export const autoConfirmHandler: JobHandler<Payload> = {
  jobType: AUTO_CONFIRM_JOB_TYPE,
  saga: false,
  errorCodes,
  parse,
  run,
}
