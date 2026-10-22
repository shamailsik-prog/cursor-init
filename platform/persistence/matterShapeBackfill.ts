import { isClassification } from "@/platform/p1/types"
import { matterMemberDocId, readMatterDocument } from "@/platform/d1/matterDocument"

/**
 * FA-F13-003: one-off backfill of legacy `matters` and `matter_members` rows into the canonical shape
 * (platform/d1/matterDocument.ts). Both stacks already read legacy rows with defaults; this writes those defaults down
 * so a legacy Next matter carries its `stage` and a legacy member its `createdAt` (Cloud Functions orders listMatters
 * by it), `addedBy` and `classification`.
 *
 * - The plan is pure: the caller supplies the rows. It only ever ADDS fields a row lacks; a stored value is never
 *   replaced (a wrong-typed value makes the row malformed, and a malformed row is reported, not written).
 * - A member is only completed from a well-formed matter of its own firm whose id matches the row's own
 *   (`{matterId}_{userId}`); anything else is an orphan and is left as it is.
 * - `applyMatterShapeBackfill` writes each patch through a check-and-set that re-reads the row in one transaction and
 *   adds only the fields still absent (a value written between plan and apply wins).
 * - Every applied run appends one summary audit row (`matter_shape_backfill`).
 */

export type BackfillRow = { id: string; data: Record<string, unknown> }

/** A marker the store adapter turns into the writer's server timestamp. */
export const SERVER_TIMESTAMP = "__server_timestamp__" as const
/** FA-F13-018: a marker the apply step replaces with the member's matter's classification read in its transaction. */
export const MATTER_CLASSIFICATION = "__matter_classification__" as const

export type FieldPatch = Record<string, unknown>

export type MatterShapeBackfillPlan = {
  matters: Array<{ id: string; patch: FieldPatch }>
  /** `matterId` / `firmId` / `userId`: what the member named at plan time; apply skips it if any has changed. */
  members: Array<{ id: string; patch: FieldPatch; matterId: string; firmId: string; userId: string }>
  /** Rows already canonical. */
  complete: string[]
  /** Matter rows that fail the canonical validator: reported, never written. */
  malformed: string[]
  /** Member rows with no well-formed same-firm matter, or whose id does not match their fields. */
  orphans: string[]
}

const MATTER_FIELDS = ["stage", "caseNumberStatus", "matterNo", "courtId", "caseNumber", "conflictCheckId", "createdBy"] as const

export function planMatterShapeBackfill(matters: readonly BackfillRow[], members: readonly BackfillRow[]): MatterShapeBackfillPlan {
  const plan: MatterShapeBackfillPlan = { matters: [], members: [], complete: [], malformed: [], orphans: [] }
  const wellFormed = new Map<string, ReturnType<typeof readMatterDocument> & object>()
  for (const row of matters) {
    const canonical = readMatterDocument(row.data)
    if (!canonical) {
      plan.malformed.push(`matters/${row.id}`)
      continue
    }
    wellFormed.set(row.id, canonical)
    const patch: FieldPatch = {}
    for (const field of MATTER_FIELDS) if (row.data[field] === undefined) patch[field] = canonical[field]
    if (Object.keys(patch).length) plan.matters.push({ id: row.id, patch })
    else plan.complete.push(`matters/${row.id}`)
  }
  for (const row of members) {
    const d = row.data
    const matter = typeof d.matterId === "string" ? wellFormed.get(d.matterId) : undefined
    if (
      !matter ||
      typeof d.userId !== "string" ||
      d.firmId !== matter.firmId ||
      row.id !== matterMemberDocId(d.matterId as string, d.userId) ||
      (d.classification !== undefined && !isClassification(d.classification)) ||
      (d.addedBy !== undefined && d.addedBy !== null && typeof d.addedBy !== "string")
    ) {
      plan.orphans.push(`matter_members/${row.id}`)
      continue
    }
    const patch: FieldPatch = {}
    if (d.classification === undefined) patch.classification = MATTER_CLASSIFICATION
    if (d.addedBy === undefined) patch.addedBy = null
    if (d.createdAt === undefined || d.createdAt === null) patch.createdAt = SERVER_TIMESTAMP
    if (Object.keys(patch).length) plan.members.push({ id: row.id, patch, matterId: d.matterId as string, firmId: matter.firmId, userId: d.userId })
    else plan.complete.push(`matter_members/${row.id}`)
  }
  return plan
}

/**
 * FA-F13-018: the member patch to write, resolved against the rows read in the apply transaction. Null (skip) when the
 * member no longer names the planned matter, firm or user, or its matter is gone, malformed or in another firm; the
 * classification marker becomes the matter's CURRENT classification.
 */
/** Why a planned member was not written at apply time (null when the row is still eligible to complete). */
export type MemberApplyRejectionReason =
  | "member_gone"
  | "member_identity_changed"
  | "member_id_mismatch"
  | "matter_gone"
  | "matter_malformed"
  | "matter_firm_mismatch"

export function memberApplyRejectionReason(
  member: Record<string, unknown> | null,
  matterRow: unknown,
  planned: { id: string; patch: FieldPatch; matterId: string; firmId: string; userId: string }
): MemberApplyRejectionReason | null {
  if (!member) return "member_gone"
  if (member.matterId !== planned.matterId || member.firmId !== planned.firmId || member.userId !== planned.userId) {
    return "member_identity_changed"
  }
  if (planned.id !== matterMemberDocId(planned.matterId, planned.userId)) return "member_id_mismatch"
  const matter = readMatterDocument(matterRow)
  if (!matter) return matterRow == null ? "matter_gone" : "matter_malformed"
  if (matter.firmId !== planned.firmId) return "matter_firm_mismatch"
  return null
}

export function resolveMemberPatch(
  member: Record<string, unknown> | null,
  matterRow: unknown,
  planned: { id: string; patch: FieldPatch; matterId: string; firmId: string; userId: string }
): FieldPatch | null {
  if (memberApplyRejectionReason(member, matterRow, planned)) return null
  const matter = readMatterDocument(matterRow)!
  const out: FieldPatch = {}
  for (const [k, v] of Object.entries(planned.patch)) out[k] = v === MATTER_CLASSIFICATION ? matter.classification : v
  return out
}

export type CompleteMemberResult =
  | { status: "written" }
  | { status: "skipped" }
  | { status: "rejected"; reason: MemberApplyRejectionReason }

/** The fields of `patch` the stored row still lacks (createdAt also counts as lacking when null). */
export function stillMissing(stored: Record<string, unknown>, patch: FieldPatch): FieldPatch {
  const out: FieldPatch = {}
  for (const [k, v] of Object.entries(patch)) {
    if (stored[k] === undefined || (k === "createdAt" && stored[k] === null)) out[k] = v
  }
  return out
}

/**
 * One audit row. Rows are bounded: a row lists at most MATTER_BACKFILL_AUDIT_BATCH paths (Firestore caps a document at
 * 1 MiB, and a run-wide list of every path could pass it). A run writes, under `aud_matter_shape_backfill_{runId}`:
 * - `_b{k}_planned` (the batch's paths) BEFORE that batch's writes, and `_b{k}_done` (applied / skipped) after them;
 * - `_malformed_{k}` / `_orphans_{k}` chunks of the rows it left untouched;
 * - the summary row (counts only, no paths) last.
 */
export type MatterShapeBackfillAuditRow = {
  id: string
  firmId: string
  action: "matter_shape_backfill"
  actorId: string
  target: string
  classification: "internal"
  reason: string
  at: number
  runId: string
  planned?: string[]
  applied?: string[]
  skipped?: string[]
  rejected?: Array<{ path: string; reason: MemberApplyRejectionReason }>
  malformed?: string[]
  orphans?: string[]
  appliedCount?: number
  skippedCount?: number
  rejectedCount?: number
  malformedCount?: number
  orphanCount?: number
  completeCount?: number
  batches?: number
}

export type MatterShapeBackfillStore = {
  /** In one transaction: re-reads `matters/id` and writes only `stillMissing(stored, patch)`. Returns whether it wrote. */
  addMissingFields(collection: "matters", id: string, patch: FieldPatch): Promise<boolean>
  /**
   * FA-F13-018: in one transaction, re-reads the member AND its matter, resolves the patch with `resolveMemberPatch`
   * (skip when it moved or the matter is malformed), then writes only `stillMissing(stored, resolved)`.
   */
  completeMember(planned: MatterShapeBackfillPlan["members"][number]): Promise<CompleteMemberResult>
  /** Creates one audit row; never overwrites one. */
  appendAudit(row: MatterShapeBackfillAuditRow): Promise<void>
}

export const MATTER_BACKFILL_AUDIT_FIRM_ID = "_platform"
export const MATTER_BACKFILL_ACTOR_ID = "system:backfill-matter-shapes"
/** The most paths one audit row (and one batch of writes) carries: well under 1 MiB at Firestore's 1500-byte path cap. */
export const MATTER_BACKFILL_AUDIT_BATCH = 200

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function applyMatterShapeBackfill(
  store: MatterShapeBackfillStore,
  plan: MatterShapeBackfillPlan,
  meta: { runId: string; now: number }
): Promise<{ applied: string[]; skipped: string[]; rejected: Array<{ path: string; reason: MemberApplyRejectionReason }> }> {
  const base = `aud_matter_shape_backfill_${meta.runId}`
  const row = (id: string, reason: string, extra: Partial<MatterShapeBackfillAuditRow>): MatterShapeBackfillAuditRow => ({
    id,
    firmId: MATTER_BACKFILL_AUDIT_FIRM_ID,
    action: "matter_shape_backfill",
    actorId: MATTER_BACKFILL_ACTOR_ID,
    target: "matters,matter_members",
    classification: "internal",
    reason,
    at: meta.now,
    runId: meta.runId,
    ...extra,
  })
  const applied: string[] = []
  const skipped: string[] = []
  const rejected: Array<{ path: string; reason: MemberApplyRejectionReason }> = []
  type Work = readonly ["matters", MatterShapeBackfillPlan["matters"][number]] | readonly ["matter_members", MatterShapeBackfillPlan["members"][number]]
  const work: Work[] = [
    ...plan.matters.map((u) => ["matters", u] as const),
    ...plan.members.map((u) => ["matter_members", u] as const),
  ]
  const batches = chunks(work, MATTER_BACKFILL_AUDIT_BATCH)
  for (const [k, batch] of batches.entries()) {
    const keys = batch.map(([collection, u]) => `${collection}/${u.id}`)
    // Recorded before the writes: a run that dies inside this batch still names what it was about to change.
    await store.appendAudit(row(`${base}_b${k}_planned`, `batch ${k}: ${keys.length} planned`, { planned: keys }))
    const batchApplied: string[] = []
    const batchSkipped: string[] = []
    const batchRejected: Array<{ path: string; reason: MemberApplyRejectionReason }> = []
    for (const [i, item] of batch.entries()) {
      if (item[0] === "matters") {
        const wrote = await store.addMissingFields("matters", item[1].id, item[1].patch)
        if (wrote) batchApplied.push(keys[i])
        else batchSkipped.push(keys[i])
      } else {
        const outcome = await store.completeMember(item[1])
        if (outcome.status === "written") batchApplied.push(keys[i])
        else if (outcome.status === "skipped") batchSkipped.push(keys[i])
        else batchRejected.push({ path: keys[i], reason: outcome.reason })
      }
    }
    await store.appendAudit(
      row(
        `${base}_b${k}_done`,
        `batch ${k}: ${batchApplied.length} applied, ${batchSkipped.length} skipped, ${batchRejected.length} rejected at apply`,
        {
          applied: batchApplied,
          skipped: batchSkipped,
          ...(batchRejected.length ? { rejected: batchRejected } : {}),
        }
      )
    )
    applied.push(...batchApplied)
    skipped.push(...batchSkipped)
    rejected.push(...batchRejected)
  }
  for (const [k, part] of chunks(plan.malformed, MATTER_BACKFILL_AUDIT_BATCH).entries()) {
    await store.appendAudit(row(`${base}_malformed_${k}`, `${part.length} malformed (not written)`, { malformed: part }))
  }
  for (const [k, part] of chunks(plan.orphans, MATTER_BACKFILL_AUDIT_BATCH).entries()) {
    await store.appendAudit(row(`${base}_orphans_${k}`, `${part.length} orphaned (not written)`, { orphans: part }))
  }
  await store.appendAudit(
    row(
      base,
      `${applied.length} applied, ${skipped.length} skipped (completed since planning), ${rejected.length} rejected at apply, ` +
        `${plan.malformed.length} malformed (at plan), ${plan.orphans.length} orphaned (at plan), ${plan.complete.length} already complete at plan`,
      {
        appliedCount: applied.length,
        skippedCount: skipped.length,
        rejectedCount: rejected.length,
        malformedCount: plan.malformed.length,
        orphanCount: plan.orphans.length,
        completeCount: plan.complete.length,
        batches: batches.length,
      }
    )
  )
  return { applied, skipped, rejected }
}
