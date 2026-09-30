import { rankOf, rankOfStoredOrMax, type FilingPackage, type SpineStore } from "@/platform/spine/store"
import { PublicError } from "@/platform/http/publicError"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  runDraftPreflight,
  type DraftPreflightInput,
} from "@/services/d4-1/drafts"
import { extractCitations } from "@/services/d4-2/citations"
import { verifyCitations } from "@/services/d4-2/draftingIntelligence"
import type { PartnerOverride } from "@/services/d4-2/partnerOverride"

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
  // Module 33: the gate reads the draft being filed, not only the ids the caller lists.
  const gate = runDraftPreflight(store, { ...input.preflight, draftBody: draft.body })
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
    /** Draft text when the caller loaded it outside the store; defaults to the stored draft. */
    draftBody?: string
    /** The approving partner's own override of a non-VERIFIED gate result (resolved from the session). */
    partnerOverride?: PartnerOverride
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
  if (input.decision === "approve") {
    // E-22: approval is blocked on any non-VERIFIED result, re-checked now (treatments can
    // change between package creation and approval). Fails closed without the draft text.
    const draftBody = input.draftBody ?? store.drafts.get(filingPackage.draftId)?.body
    if (typeof draftBody !== "string") {
      throw new PublicError("preflight blocked approval: draft unavailable for the citation gate")
    }
    const gate = verifyCitations(store, extractCitations(draftBody), input.partnerOverride, {
      actorId: actor.id,
      firmId: filingPackage.firmId,
    })
    if (gate.blocked) {
      throw new PublicError(`preflight blocked approval: citation gate ${gate.status}`)
    }
    if (gate.overridden && input.partnerOverride) {
      store.audit.push({
        action: "citation_gate_override",
        actorId: actor.id,
        target: filingPackage.matterId,
        classification: filingPackage.classification,
        reason: input.partnerOverride.reason.trim(),
      })
    }
  }
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
