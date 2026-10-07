import { createHash } from "node:crypto"
import {
  rankOf,
  rankOfStoredOrMax,
  type AuditEntry,
  type FilingPackage,
  type SpineStore,
} from "@/platform/spine/store"
import { PublicError } from "@/platform/http/publicError"
import { isClassification, type Classification } from "@/platform/p1/types"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  gatedDraftText,
  ownCaseReferenceMatcher,
  runDraftPreflight,
  type DraftPreflightInput,
} from "@/services/d4-1/drafts"
import { extractCitations } from "@/services/d4-2/citations"
import { requireSupportedDraftBody, requireSupportedDraftTitle } from "@/services/d4-2/draftCharset"
import { verifyCitations } from "@/services/d4-2/draftingIntelligence"
import type { PartnerOverride } from "@/services/d4-2/partnerOverride"

/** sha256 (hex, UTF-8) of a draft body — pinned on the package at creation. */
export function draftBodySha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex")
}

/** The draft changed after the package was created (review R1 #5): approval is refused. */
export class DraftChangedError extends PublicError {
  readonly code = "draft_changed"
  constructor() {
    super("draft changed since the filing package was created; create a new package")
    this.name = "DraftChangedError"
  }
}

/**
 * The package was already approved or rejected (final audit F2): a decision is one-shot, so a
 * later or concurrent decision is refused (409 package_already_decided) and changes nothing.
 */
export class PackageAlreadyDecidedError extends PublicError {
  readonly code = "package_already_decided"
  constructor() {
    super("filing package already decided")
    this.name = "PackageAlreadyDecidedError"
  }
}

/** Override rows carry the matter's classification (review R1 #7), never a caller-supplied one. */
function overrideAuditClassification(store: SpineStore, matterId: string): Classification {
  const label = store.matters.get(matterId)?.classification
  return isClassification(label) ? label : "privileged-restricted"
}

/** A draft stays locked while any package referencing it is pending or approved. */
export function draftShouldBeLocked(store: SpineStore, draftId: string): boolean {
  for (const pkg of store.filingPackages.values()) {
    if (pkg.draftId === draftId && (pkg.status === "pending_partner_approval" || pkg.status === "approved")) {
      return true
    }
  }
  return false
}

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
  // R4-4: the stored body may be raw (a client-SDK edit of an unlocked draft): normalise it at
  // read time — refused (422 unsupported_characters) if it fails the charset check — and pin and
  // analyse the normalised form.
  const body = requireSupportedDraftBody(draft.body)
  // Module 33: the gate reads the draft being filed, not only the ids the caller lists.
  const gate = runDraftPreflight(
    store,
    { ...input.preflight, draftBody: body, draftTitle: draft.title },
    { recordOverride: true }
  )
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
    draftBodySha256: draftBodySha256(body),
    citedRefs: [
      ...new Set(
        (input.preflight.citedJudgmentIds ?? [])
          .map((ref) => (typeof ref === "string" ? ref.trim() : ""))
          .filter((ref) => ref.length > 0)
      ),
    ],
  }
  store.filingPackages.set(filingPackage.id, filingPackage)
  store.drafts.set(draft.id, { ...draft, locked: true })
  store.audit.push({
    action: "filing_package_create",
    actorId: actor.id,
    target: filingPackage.id,
    classification: filingPackage.classification,
  })
  return { filingPackage, preflight: gate }
}

export type FilingPackageDecisionInput = {
  actorId: string
  packageId: string
  decision: "approve" | "reject"
  reason: string
  /**
   * Draft text loaded from the durable repository by the caller; defaults to the stored draft.
   * Approval requires sha256(draftBody) to equal the package's pinned draftBodySha256.
   */
  draftBody?: string
  /** Draft title from the durable repository (R4-2); defaults to the stored draft's title. */
  draftTitle?: string
  /** The approving partner's own override of a non-VERIFIED gate result (resolved from the session). */
  partnerOverride?: PartnerOverride
}

/** A validated decision not yet applied: the decided package (a copy) and its audit rows. */
export type FilingPackageDecision = {
  decided: FilingPackage
  /** Pushed to the audit log only when the decision is applied (the winner's rows only). */
  auditRows: AuditEntry[]
}

/**
 * Validates a decision against the package as stored now and returns it without changing
 * anything (final audit F2). Refuses with PackageAlreadyDecidedError unless the package is
 * still pending_partner_approval. The caller applies it with `applyFilingPackageDecision`
 * once the durable conditional update (`FilingRepository.decideIfPending`) has won.
 */
export function planFilingPackageDecision(
  store: SpineStore,
  input: FilingPackageDecisionInput
): FilingPackageDecision {
  const actor = store.users.get(input.actorId)
  if (!actor) throw new PublicError("unknown actor")
  if (actor.role !== "partner") throw new PublicError("partner role required")
  if (!input.reason.trim()) throw new PublicError("reason is required")
  const filingPackage = store.filingPackages.get(input.packageId)
  if (!filingPackage) throw new PublicError("unknown filing package")
  if (filingPackage.firmId !== actor.firmId) throw new PublicError("cross-firm decision denied")
  const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
  if (!permission.allow) throw new PublicError(`permission denied: ${permission.reason}`)
  if (filingPackage.status !== "pending_partner_approval") throw new PackageAlreadyDecidedError()
  const auditRows: AuditEntry[] = []
  if (input.decision === "approve") {
    // E-22: approval is blocked on any non-VERIFIED result, re-checked now (treatments can
    // change between package creation and approval). Fails closed without the draft text.
    const draftBody = input.draftBody ?? store.drafts.get(filingPackage.draftId)?.body
    if (typeof draftBody !== "string") {
      throw new PublicError("preflight blocked approval: draft unavailable for the citation gate")
    }
    // Review round 3: a body with disguising characters is refused before anything else; so is a
    // title (R4-2: client-SDK title edits are allowed on locked drafts, so it is re-read here).
    // R4-4: hash and analyse the normalised body (a raw client-SDK body is normalised here).
    const body = requireSupportedDraftBody(draftBody)
    const draftTitle = requireSupportedDraftTitle(input.draftTitle ?? store.drafts.get(filingPackage.draftId)?.title ?? "")
    // The body being approved must be the body the gate checked at creation (fails closed for
    // a legacy package without a pinned hash).
    if (!filingPackage.draftBodySha256 || draftBodySha256(body) !== filingPackage.draftBodySha256) {
      throw new DraftChangedError()
    }
    // Body citations (re-extracted) plus the refs listed at creation (review R1 #8).
    const packageMatter = store.matters.get(filingPackage.matterId)
    const refs = [
      ...extractCitations(
        gatedDraftText(draftTitle, body),
        packageMatter ? { isOwnCaseReference: ownCaseReferenceMatcher(packageMatter) } : {}
      ),
      ...(filingPackage.citedRefs ?? []),
    ]
    const gate = verifyCitations(store, refs, input.partnerOverride, {
      actorId: actor.id,
      firmId: filingPackage.firmId,
    })
    if (gate.blocked) {
      throw new PublicError(`preflight blocked approval: citation gate ${gate.status}`)
    }
    if (gate.overridden && input.partnerOverride) {
      auditRows.push({
        action: "citation_gate_override",
        actorId: actor.id,
        target: filingPackage.matterId,
        classification: overrideAuditClassification(store, filingPackage.matterId),
        reason: input.partnerOverride.reason.trim(),
        overriddenAuthorities: gate.findings
          .filter((f) => f.status !== "VERIFIED")
          .map((f) => `${f.ref}:${f.status}`),
      })
    }
  }
  const decided: FilingPackage = {
    ...filingPackage,
    status: input.decision === "approve" ? "approved" : "rejected",
    approvedBy: actor.id,
    approvalReason: input.reason,
  }
  auditRows.push({
    action:
      input.decision === "approve"
        ? "filing_package_approve"
        : "filing_package_reject",
    actorId: actor.id,
    target: filingPackage.id,
    classification: filingPackage.classification,
    reason: input.reason,
  })
  return { decided, auditRows }
}

/** The fields a decision writes (the durable conditional update's patch). */
export function filingPackageDecisionPatch(
  decided: FilingPackage
): Pick<FilingPackage, "status" | "approvedBy" | "approvalReason"> {
  return { status: decided.status, approvedBy: decided.approvedBy, approvalReason: decided.approvalReason }
}

/**
 * Applies a decision that won: the package in the spine, the draft lock (following this
 * decision only), and the decision's audit rows.
 */
export function applyFilingPackageDecision(store: SpineStore, decision: FilingPackageDecision): FilingPackage {
  const { decided } = decision
  store.filingPackages.set(decided.id, decided)
  const draft = store.drafts.get(decided.draftId)
  if (draft) store.drafts.set(draft.id, { ...draft, locked: draftShouldBeLocked(store, draft.id) })
  store.audit.push(...decision.auditRows)
  return decided
}

/**
 * Plans and applies a decision in one synchronous step (in-process callers; atomic in the
 * single-threaded spine). Routes that persist use plan + decideIfPending + apply instead.
 */
export function decideFilingPackage(store: SpineStore, input: FilingPackageDecisionInput): FilingPackage {
  return applyFilingPackageDecision(store, planFilingPackageDecision(store, input))
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
