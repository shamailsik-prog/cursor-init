import { createHash } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Transaction } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { logFailure } from "../../log"
import { isSafeDocId } from "../../p5/common"
import { JobError } from "../../p2/errors"
import type { JobContext, JobHandler, JobResult } from "../../p2/registry"
import { l17_2Enabled, maxLabel } from "../conflict/engine"
import { bumpRegistryVersion } from "../registryVersion"
import { DETERMINISTIC_KEY_SCORE, effectiveLinkState, LINK_AUTO_CONFIRM_MS } from "./linkState"
import { snapOf } from "./ops"
import { entityKeys, type EntityKeys } from "./summary"

/**
 * `d1.autoconfirm` (spec P3-42..P3-50, O-28, L17.2 #16): the daily job that materialises the
 * 30-day auto-confirm. For each firm pair whose key rows are all undisputed candidates created at
 * least 30 days ago, it writes the immutable `merge_events` row a human confirmation would write
 * (actor `system`), sets every row `confirmed`, and emits `entity.confirmed`, so the pair can be
 * un-merged (E-43) and a late dispute is no longer possible (a partner un-merges instead).
 *
 * Idempotent by state: a step re-reads each pair in its own transaction and skips one that is no
 * longer an auto-confirmed candidate (disputed, rejected, confirmed, un-merging, or not yet aged
 * on every row). A step commits at most once per job (`runFenced`).
 */

export const AUTO_CONFIRM_JOB_TYPE = "d1.autoconfirm"
export const AUTO_CONFIRM_SPEC = { jobType: AUTO_CONFIRM_JOB_TYPE, cron: "15 2 * * *", period: "day" } as const

/** Pairs materialised per fenced step (one transaction). */
export const AUTO_CONFIRM_STEP_PAIRS = 10
/** A job may record 50 fenced steps (MAX_FENCED_STEPS); this leaves room for none else. */
export const AUTO_CONFIRM_MAX_STEPS = 48
/** Candidate link rows one run reads; rows beyond it wait for the next day's run. */
export const AUTO_CONFIRM_ROW_LIMIT = 2000
export const AUTO_CONFIRM_NOTE = "Auto-confirmed: undisputed for 30 days (L18 section 7.1)."

type Payload = { period: string }

const invalid = () => new JobError("invalid_payload", { permanent: true })

function parse(payload: unknown): Payload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid()
  const raw = payload as Record<string, unknown>
  if (Object.keys(raw).length !== 1 || typeof raw.period !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.period)) throw invalid()
  return { period: raw.period }
}

type PairRead = {
  a: string
  b: string
  pairId: string
  rows: Array<{ ref: DocumentReference; data: DocumentData }>
  left: DocumentData
  right: DocumentData
  label: string
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
  const label = [...rows.map((r) => r.data.classification), left.classification, right.classification, ...clientLabels].reduce<string>((acc, l) => maxLabel(acc, l), "public")
  return { a, b, pairId: `${a}_${b}`, rows, left, right, label }
}

/** Stages the materialisation of one pair: the merge event, every row confirmed, `entity.confirmed`. */
function stageMaterialisation(tx: Transaction, firmId: string, pair: PairRead, atMs: number): void {
  const db = adminDb()
  const at = Timestamp.fromMillis(atMs)
  const effectiveAt = Timestamp.fromMillis(Math.max(...pair.rows.map((r) => (r.data.createdAt as Timestamp).toMillis())) + LINK_AUTO_CONFIRM_MS)
  const mergeRef = db.collection("merge_events").doc()
  const keys = [...new Set(pair.rows.map((r) => String(r.data.key)))].sort()
  const leftKeys = entityKeys(pair.left)
  const keyValues: Record<string, string> = {}
  for (const key of keys) {
    const value = leftKeys[key as keyof EntityKeys]
    if (value !== undefined) keyValues[key] = value
  }
  const linkIds = pair.rows.map((r) => r.ref.id).sort()
  tx.create(mergeRef, {
    firmId,
    kind: "link_confirmed",
    leftId: pair.a,
    rightId: pair.b,
    pairId: pair.pairId,
    linkIds,
    keys,
    evidence: { note: AUTO_CONFIRM_NOTE, keyValues },
    score: DETERMINISTIC_KEY_SCORE,
    basis: "auto_confirm",
    priorState: "candidate",
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
}

const stepIdOf = (pairs: readonly string[]): string => `autoconfirm-${createHash("sha256").update(pairs.join("\0")).digest("hex").slice(0, 24)}`

async function run(ctx: JobContext<Payload>): Promise<JobResult> {
  const { firmId } = ctx.job
  const nowMs = ctx.now()
  const firm = await adminDb()
    .collection("firms")
    .doc(firmId)
    .get()
    .then((s) => ({ ok: true as const, data: s.data() }))
    .catch((err: unknown) => {
      logFailure("autoconfirm flag read failed", err)
      return { ok: false as const, data: undefined }
    })
  // L17.2 off (or unreadable): every row reads as a candidate (P2-18), so nothing is confirmed.
  if (!l17_2Enabled(firm.data, firm.ok)) return {}

  const snap = await adminDb()
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
  for (let i = 0; i < ordered.length; i += AUTO_CONFIRM_STEP_PAIRS) {
    const chunk = ordered.slice(i, i + AUTO_CONFIRM_STEP_PAIRS)
    await ctx.runFenced(stepIdOf(chunk), async (tx) => {
      const reads: PairRead[] = []
      for (const key of chunk) {
        const [a, b] = pairs.get(key)!
        const pair = await readPair(tx, firmId, a, b)
        // The same rule the read-time state uses: every row an auto-confirmed candidate.
        if (pair && pair.rows.every((r) => effectiveLinkState(r.data, nowMs, true) === "auto_confirmed")) reads.push(pair)
      }
      if (reads.length === 0) return
      for (const pair of reads) stageMaterialisation(tx, firmId, pair, nowMs)
      bumpRegistryVersion(tx, firmId)
    })
  }
  return {}
}

export const autoConfirmHandler: JobHandler<Payload> = {
  jobType: AUTO_CONFIRM_JOB_TYPE,
  saga: false,
  errorCodes: {},
  parse,
  run,
}
