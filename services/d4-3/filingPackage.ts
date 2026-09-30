import { rankOf, rankOfStoredOrMax, type FilingPackage, type SpineStore } from "@/platform/spine/store"
import { PublicError } from "@/platform/http/publicError"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  runDraftPreflight,
  type DraftPreflightInput,
} from "@/services/d4-1/drafts"

export function createFilingPackage(
  store: SpineStore,
  input: {
    actorId: string
    matterId: string
    draftId: string
    preflight: DraftPreflightInput
  }
): {
  filingPackage: FilingPackage
  preflight: ReturnType<typeof runDraftPreflight>
} {
  const actor = store.users.get(input.actorId)
  if (!actor) throw new PublicError("unknown actor")
  const matter = store.matters.get(input.matterId)
  if (!matter) throw new PublicError("unknown matter")
  const draft = store.drafts.get(input.draftId)
  if (!draft) throw new PublicError("unknown draft")
  if (draft.matterId !== input.matterId) throw new PublicError("draft does not belong to matter")
  const permission = checkPermission(store, actor.id, "draft", input.matterId)
  if (!permission.allow) throw new PublicError(`permission denied: ${permission.reason}`)
  if (rankOfStoredOrMax(draft.classification) < rankOfStoredOrMax(matter.classification)) {
    throw new PublicError("draft classification cannot be lower than matter classification")
  }
  const gate = runDraftPreflight(store, input.preflight)
  if (!gate.ok) throw new PublicError("preflight blocked filing package")
  const filingPackage: FilingPackage = {
    id: store.id("pkg"),
    firmId: matter.firmId,
    matterId: matter.id,
    draftId: draft.id,
    classification: draft.classification,
    citationStatus: gate.citationStatus,
    temporalAllOk: gate.temporal.every((row) => row.status === "OK"),
    status: "pending_partner_approval",
    createdBy: actor.id,
    createdAt: Date.now(),
    approvedBy: null,
    approvalReason: null,
  }
  store.filingPackages.set(filingPackage.id, filingPackage)
  store.audit.push({
    action: "filing_package_create",
    actorId: actor.id,
    target: filingPackage.id,
    classification: filingPackage.classification,
  })
  return { filingPackage, preflight: gate }
}

export function decideFilingPackage(
  store: SpineStore,
  input: {
    actorId: string
    packageId: string
    decision: "approve" | "reject"
    reason: string
  }
): FilingPackage {
  const actor = store.users.get(input.actorId)
  if (!actor) throw new PublicError("unknown actor")
  if (actor.role !== "partner") throw new PublicError("partner role required")
  if (!input.reason.trim()) throw new PublicError("reason is required")
  const filingPackage = store.filingPackages.get(input.packageId)
  if (!filingPackage) throw new PublicError("unknown filing package")
  if (filingPackage.firmId !== actor.firmId) throw new PublicError("cross-firm decision denied")
  const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
  if (!permission.allow) throw new PublicError(`permission denied: ${permission.reason}`)
  filingPackage.status =
    input.decision === "approve" ? "approved" : "rejected"
  filingPackage.approvedBy = actor.id
  filingPackage.approvalReason = input.reason
  store.audit.push({
    action:
      input.decision === "approve"
        ? "filing_package_approve"
        : "filing_package_reject",
    actorId: actor.id,
    target: filingPackage.id,
    classification: filingPackage.classification,
    reason: input.reason,
  })
  return filingPackage
}

export function listFilingPackages(
  store: SpineStore,
  input: {
    userId: string
    matterId?: string
    limit: number
    cursor: number
  }
): {
  items: FilingPackage[]
  total: number
  nextCursor: string | null
} {
  const user = store.users.get(input.userId)
  if (!user) throw new PublicError("unknown user")
  const visible = [...store.filingPackages.values()]
    .filter((row) => row.firmId === user.firmId)
    .filter((row) => (input.matterId ? row.matterId === input.matterId : true))
    .filter((row) => {
      const permission = checkPermission(store, user.id, "draft", row.matterId)
      if (!permission.allow) return false
      return rankOf(user.clearanceLevel) >= rankOfStoredOrMax(row.classification)
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  const page = visible.slice(input.cursor, input.cursor + input.limit)
  const nextCursor =
    input.cursor + page.length < visible.length
      ? String(input.cursor + page.length)
      : null
  return {
    items: page,
    total: visible.length,
    nextCursor,
  }
}
