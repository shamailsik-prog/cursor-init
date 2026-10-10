import { Timestamp } from "firebase-admin/firestore"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import { isSafeDocId, type FirmOperation } from "../../p5/common"
import { enqueueJobs, jobIdFor, type JobSpec } from "../../p2/enqueue"
import { bumpRegistryVersion } from "../registryVersion"
import { parseBody } from "./ops"
import { isUnmergeInProgress } from "./linkState"
import { gate } from "./read"
import { readPair } from "./pair"
import { UNMERGE_COLLECTIONS, UNMERGE_JOB_TYPES, type UnmergeCollection } from "./unmergeJobs"

export type UnmergeResult = {
  pairId: string
  linkIds: string[]
  mergeEventId: string
  status: "in_progress"
  jobIds: Record<UnmergeCollection, string>
  classification: string
}

/**
 * unmergeEntity({ linkId, note }) → UnmergeResult (spec P3-25..P3-27, L18 §7.5; partner only by the
 * permission table). Permission → L17.2 gate → body → one transaction: readPair (the 404 gate),
 * then every row of the pair must be `confirmed` by one merge event that exists, is this firm's
 * and is not yet reverted (409 `link_not_confirmed`), with no saga already running (409
 * `unmerge_in_progress`). It writes `reverted: true` and the saga record on the event, marks every
 * row `unmerge.status: "in_progress"` (the pair reads as unresolved identity from now on), and
 * enqueues one saga job per referencing collection in this same transaction, keyed
 * `${mergeEventId}:${collection}`. The jobs do the rest (unmergeJobs.ts).
 */
export const unmergeEntityOp: FirmOperation<UnmergeResult> = {
  auth: "firm",
  kind: "general",
  action: "entity.unmerge",
  target: "entity_links",
  run: async ({ caller, now: clock }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await gate(caller, "entity.unmerge")
    const { linkId, note } = parseBody(data)
    audit.target = `entity_links/${linkId}`
    const nowMs = clock ?? Date.now()
    const at = Timestamp.fromMillis(nowMs)
    const db = adminDb()

    const result = await db.runTransaction(async (tx) => {
      const pair = await readPair(tx, caller, linkId)
      if (pair.rows.some((r) => isUnmergeInProgress(r.data))) throw new HttpError(409, "unmerge_in_progress")
      const eventIds = new Set(pair.rows.map((r) => (r.data.state === "confirmed" ? (r.data.confirmation as { mergeEventId?: unknown } | undefined)?.mergeEventId : undefined)))
      const [mergeEventId] = [...eventIds]
      if (eventIds.size !== 1 || !isSafeDocId(mergeEventId)) throw new HttpError(409, "link_not_confirmed")
      const eventRef = db.collection("merge_events").doc(mergeEventId)
      const event = (await tx.get(eventRef)).data()
      if (!event || event.firmId !== caller.firmId || event.kind !== "link_confirmed" || event.reverted !== false || event.pairId !== pair.pairId) {
        throw new HttpError(409, "link_not_confirmed")
      }

      const linkIds = pair.rows.map((r) => r.ref.id).sort()
      const payload = { mergeEventId, pairId: pair.pairId, leftId: pair.a, rightId: pair.b, linkIds }
      const specs: JobSpec[] = UNMERGE_COLLECTIONS.map((collection) => ({
        firmId: caller.firmId,
        jobType: UNMERGE_JOB_TYPES[collection],
        classification: pair.label,
        matterId: null,
        payload,
        idempotencyKey: `${mergeEventId}:${collection}`,
        createdBy: caller.uid,
      }))
      await enqueueJobs(tx, specs, { now: nowMs })

      const jobs: Record<string, string> = {}
      for (const c of UNMERGE_COLLECTIONS) jobs[c] = "pending"
      tx.update(eventRef, {
        reverted: true,
        revertedAt: at,
        revertedBy: caller.uid,
        revertedByRole: caller.role,
        revertNote: note,
        unmerge: { status: "in_progress", startedAt: at, jobs },
      })
      const unmerge = { status: "in_progress", mergeEventId, by: caller.uid, role: caller.role, at, note }
      for (const r of pair.rows) tx.update(r.ref, { unmerge, classification: pair.label })
      bumpRegistryVersion(tx, caller.firmId)
      await audit.stage(tx, "allow", "ok")

      const jobIds = Object.fromEntries(UNMERGE_COLLECTIONS.map((c) => [c, jobIdFor(caller.firmId, UNMERGE_JOB_TYPES[c], `${mergeEventId}:${c}`)])) as Record<UnmergeCollection, string>
      return { pairId: pair.pairId, linkIds, mergeEventId, status: "in_progress" as const, jobIds, classification: pair.label }
    })
    audit.committed()
    return result
  },
}
