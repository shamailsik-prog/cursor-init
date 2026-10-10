import { createHash } from "node:crypto"
import { logger } from "firebase-functions"
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../../admin"
import { logFailure } from "../../log"
import { stageAudit } from "../../p5/audit"
import { isSafeDocId } from "../../p5/common"
import { MAX_FENCED_STEPS } from "../../p2/constants"
import { JobError } from "../../p2/errors"
import type { JobContext, JobHandler, JobResult } from "../../p2/registry"
import { l17_2Enabled, maxLabel } from "../conflict/engine"
import { bumpRegistryVersion } from "../registryVersion"
import { DETERMINISTIC_KEY_SCORE, effectiveLinkState, LINK_AUTO_CONFIRM_MS } from "./linkState"
import { snapOf } from "./ops"
import { entityKeys, type EntityKeys } from "./summary"

/**
 * `d1.autoconfirm` (spec P3-42..P3-58, O-28, L17.2 #16): the daily job that materialises the
 * 30-day auto-confirm. For each firm pair whose key rows are all undisputed candidates created at
 * least 30 days ago, it writes the immutable `merge_events` row a human confirmation would write
 * (actor `system`), sets every row `confirmed`, emits `entity.confirmed` and stages the
 * `entity.confirm` audit row, so the pair can be un-merged (E-43) and a late dispute is no longer
 * possible (a partner un-merges instead).
 *
 * Exactly once per pair, by state: a step re-reads each of its pairs in the step's transaction and
 * skips one that is no longer an auto-confirmed candidate (disputed, rejected, confirmed, un-merging,
 * or not yet aged on every row), or whose merge event already exists (the id is derived from the
 * pair, P3-57; the skip is logged, O-52). A step commits at most once per job (`runFenced`) and
 * is named by its position (`autoconfirm-<n>`, P3-53), so a retry reuses the same ids: a position
 * an earlier attempt committed is skipped, and the pairs that now sit there wait for the next day's
 * run. Each step re-reads the L17.2 flag; once it reads off, that step and the rest of the run
 * write nothing (P3-56).
 */

export const AUTO_CONFIRM_JOB_TYPE = "d1.autoconfirm"
export const AUTO_CONFIRM_SPEC = { jobType: AUTO_CONFIRM_JOB_TYPE, cron: "15 2 * * *", period: "day" } as const

/** Pairs materialised per fenced step (one transaction). */
export const AUTO_CONFIRM_STEP_PAIRS = 10
/** Positional steps per run (P3-53): ids are reused on a retry, so a job never records more than 48 of its MAX_FENCED_STEPS; the two spare are headroom. */
export const AUTO_CONFIRM_MAX_STEPS = MAX_FENCED_STEPS - 2
/** Candidate link rows one run reads; rows beyond it wait for the next day's run. */
export const AUTO_CONFIRM_ROW_LIMIT = 2000
export const AUTO_CONFIRM_NOTE = "Auto-confirmed: undisputed for 30 days (L18 section 7.1)."

type Payload = { period: string }

/** Test hooks (spec P3-56, P3-58), set in a test and cleared after it. Never set in production code. */
export const autoConfirmTestSeam: {
  /** Before the run's flag read: a throw stands in for that read failing. */
  beforeFlagRead?: () => Promise<void>
  /** Before fenced step `index` of attempt `attempt`, with the pair ids the scan put in it; a throw fails the attempt there. */
  beforeStep?: (step: { attempt: number; index: number; pairIds: readonly string[] }) => Promise<void>
} = {}

/** The handler's own codes (P3-9): `flag_read_failed` is retryable (P3-56). */
const errorCodes = {
  flag_read_failed: "The firm's feature flags could not be read.",
} as const

const invalid = () => new JobError("invalid_payload", { permanent: true })

function parse(payload: unknown): Payload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid()
  const raw = payload as Record<string, unknown>
  if (Object.keys(raw).length !== 1 || typeof raw.period !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.period)) throw invalid()
  return { period: raw.period }
}

/**
 * The pair's merge event id (P3-57): `auto_` and the first 32 hex characters of
 * SHA-256(firmId NUL pairId NUL the sorted link ids joined by commas).
 */
export function mergeEventIdOf(firmId: string, pairId: string, linkIds: readonly string[]): string {
  const digest = createHash("sha256").update(`${firmId}\0${pairId}\0${[...linkIds].sort().join(",")}`).digest("hex")
  return `auto_${digest.slice(0, 32)}`
}

type PairRead = {
  a: string
  b: string
  pairId: string
  rows: Array<{ ref: DocumentReference; data: DocumentData }>
  /** The rows' ids, sorted. */
  linkIds: string[]
  mergeEventId: string
  left: DocumentData
  right: DocumentData
  label: Classification
}

/** Reads a pair (rows, both entities, their clients) in `tx` without a caller: null when it is not wholly this firm's. */
async function readPair(tx: Transaction, firmId: string, a: string, b: string): Promise<PairRead | null> {
  const db = adminDb()
  const snap = await tx.get(db.collection("entity_links").where("firmId", "==", firmId).where("leftId", "==", a).where("rightId", "==", b))
  const rows = snap.docs.map((d) => ({ ref: d.ref, data: d.data() }))
  const [leftSnap, rightSnap] = await tx.getAll(db.collection("entities").doc(a), db.collection("entities").doc(b))
  const left = leftSnap.data()
  const right = rightSnap.data()
  if (rows.length === 0 || !left || left.firmId !== firmId || !right || right.firmId !== firmId) return null
  const clientLabels: unknown[] = []
  for (const entityId of [a, b]) {
    const owner = await tx.get(db.collection("clients").where("firmId", "==", firmId).where("entityId", "==", entityId).limit(1))
    for (const doc of owner.docs) clientLabels.push(doc.data().classification)
  }
  const label = [...rows.map((r) => r.data.classification), left.classification, right.classification, ...clientLabels].reduce<Classification>((acc, l) => maxLabel(acc, l), "public")
  const pairId = `${a}_${b}`
  const linkIds = rows.map((r) => r.ref.id).sort()
  return { a, b, pairId, rows, linkIds, mergeEventId: mergeEventIdOf(firmId, pairId, linkIds), left, right, label }
}

/**
 * Stages the materialisation of one pair, all in the step's transaction: the merge event, every
 * row confirmed, `entity.confirmed`, and the system's `entity.confirm` audit row.
 */
function stageMaterialisation(tx: Transaction, firmId: string, pair: PairRead, atMs: number): void {
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

async function run(ctx: JobContext<Payload>): Promise<JobResult> {
  const { firmId } = ctx.job
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

  const snap = await db
    .collection("entity_links")
    .where("firmId", "==", firmId)
    .where("state", "==", "candidate")
    .where("disputed", "==", false)
    .where("createdAt", "<=", Timestamp.fromMillis(nowMs - LINK_AUTO_CONFIRM_MS))
    .orderBy("createdAt")
    .limit(AUTO_CONFIRM_ROW_LIMIT)
    .get()
  const pairs = new Map<string, [string, string]>()
  for (const d of snap.docs) {
    const { leftId, rightId } = d.data()
    if (isSafeDocId(leftId) && isSafeDocId(rightId) && leftId !== rightId) pairs.set(`${leftId}_${rightId}`, [leftId, rightId])
  }
  const ordered = [...pairs.keys()].sort().slice(0, AUTO_CONFIRM_STEP_PAIRS * AUTO_CONFIRM_MAX_STEPS)
  for (let n = 0; n * AUTO_CONFIRM_STEP_PAIRS < ordered.length; n += 1) {
    const chunk = ordered.slice(n * AUTO_CONFIRM_STEP_PAIRS, (n + 1) * AUTO_CONFIRM_STEP_PAIRS)
    await autoConfirmTestSeam.beforeStep?.({ attempt: ctx.job.attempt, index: n, pairIds: chunk })
    // P3-53: named by position, not by the pairs it holds, so a retry reuses the same ids.
    const step = await ctx.runFenced(`autoconfirm-${n}`, async (tx): Promise<"flag_off" | "ran"> => {
      // P3-56: L17.2 switched off since the run began: this step writes nothing and the run stops.
      if (!l17_2Enabled((await tx.get(firmRef)).data())) return "flag_off"
      const reads: PairRead[] = []
      for (const key of chunk) {
        const [a, b] = pairs.get(key)!
        const pair = await readPair(tx, firmId, a, b)
        // The re-check (P3-44, P3-58), the rule the read-time state uses: every row an auto-confirmed candidate.
        const eligible = pair !== null && pair.rows.every((r) => effectiveLinkState(r.data, nowMs, true) === "auto_confirmed")
        if (!eligible) continue
        // P3-57: the pair's event already exists, so the pair is skipped. Normally that is a pair
        // already done; a pair whose rows still read auto-confirmed beside an existing event is an
        // inconsistent state (O-52), so the skip is logged, by code and ids only.
        if ((await tx.get(db.collection("merge_events").doc(pair.mergeEventId))).exists) {
          logger.warn("autoconfirm.event_exists_skip", { firmId, pairId: pair.pairId })
          continue
        }
        reads.push(pair)
      }
      if (reads.length === 0) return "ran"
      for (const pair of reads) stageMaterialisation(tx, firmId, pair, nowMs)
      bumpRegistryVersion(tx, firmId)
      return "ran"
    })
    if (step === "flag_off") break
  }
  return {}
}

export const autoConfirmHandler: JobHandler<Payload> = {
  jobType: AUTO_CONFIRM_JOB_TYPE,
  saga: false,
  errorCodes,
  parse,
  run,
}
