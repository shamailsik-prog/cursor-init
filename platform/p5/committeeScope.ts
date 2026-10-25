/**
 * Server-side scope for Committee Brain requests (Layer 18 §4.5 / §4.6).
 *
 * Every request names a matter (required). The classification that drives P1
 * provider policy — and that the caller's free text inherits — is
 *   max(matter, every referenced document, any caller label);
 * every referenced document must belong to that matter, and an unreadable
 * persisted label counts as privileged-restricted.
 * Access to every referenced matter goes through P5 `checkPermission`.
 */
import { checkPermission } from "@/platform/p5/checkPermission"
import type { CommitteeBrainAction } from "@/platform/p5/permissionDecision"
import { classificationRank, isClassification, type Classification } from "@/platform/p1/types"
import { resolvePersistenceMode } from "@/platform/persistence/runtimeRepositories"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { Matter, SpineStore, User } from "@/platform/spine/store"

export const MOST_RESTRICTIVE: Classification = "privileged-restricted"

export class CommitteeScopeError extends Error {
  readonly status: 403 | 404
  readonly code: string
  constructor(status: 403 | 404, message: string, code: string) {
    super(message)
    this.name = "CommitteeScopeError"
    this.status = status
    this.code = code
  }
}

export type CommitteeScope = {
  classification: Classification
  matterId: string | null
  documentIds: string[]
  /** Names the masker must redact, derived from the matter's client record. */
  partyNames: string[]
}

export function strictestClassification(labels: Classification[]): Classification | null {
  let best: Classification | null = null
  for (const label of labels) {
    if (best === null || classificationRank(label) > classificationRank(best)) best = label
  }
  return best
}

/**
 * The matter as persisted now (audit F14 R2-D1): the repository first, so a label raised by another process drives the
 * permission check and the scope's classification (P1 provider policy), not this process's cached copy. The cached copy
 * is the fallback only when the repository has no row (in memory mode they are the same). The routes reconcile the
 * cache first (`syncFirmMatters`, Copilot C3), so a matter deleted or moved elsewhere is no longer cached for the
 * caller's firm and is unknown here; a stale copy of another firm's matter fails `checkPermission`'s firm check.
 */
async function loadMatter(
  store: SpineStore,
  repos: SpineRepositories,
  matterId: string,
  firmId: string
): Promise<Matter | null> {
  const matter = (await repos.matters.get(matterId, firmId)) ?? store.matters.get(matterId)
  if (matter) store.matters.set(matter.id, matter)
  return matter ?? null
}

/**
 * Hydrates the matter + membership row, then defers to P5 checkPermission. `action` is one of the two committee rows of
 * the shared table (FA-F43-R1-P01): typed, so G-0 [23] resolves it and TypeScript holds every caller to the pair.
 */
export async function canAccessMatter(
  store: SpineStore,
  repos: SpineRepositories,
  actor: User,
  matterId: string,
  action: CommitteeBrainAction = "committee_brain"
): Promise<{ allow: boolean; reason: string; matter: Matter | null }> {
  const matter = await loadMatter(store, repos, matterId, actor.firmId)
  if (!matter) return { allow: false, reason: "unknown-matter", matter: null }
  const key = store.memberKey(matterId, actor.id)
  if (!store.members.has(key)) {
    const member = await repos.members.get(matterId, actor.id, actor.firmId)
    if (member) store.members.set(key, member)
  }
  const decision = checkPermission(store, actor.id, action, matterId)
  return { ...decision, matter }
}

/** A persisted label we cannot read is treated as the most restrictive. */
function readableLabel(value: unknown): Classification {
  return isClassification(value) ? value : MOST_RESTRICTIVE
}

export async function resolveCommitteeScope(
  store: SpineStore,
  repos: SpineRepositories,
  actor: User,
  input: { matterId: string; documentIds?: string[] }
): Promise<CommitteeScope> {
  const decision = await canAccessMatter(store, repos, actor, input.matterId)
  if (!decision.matter) throw new CommitteeScopeError(404, "unknown matter", "NOT_FOUND")
  if (!decision.allow) {
    throw new CommitteeScopeError(403, `permission denied: ${decision.reason}`, "FORBIDDEN")
  }
  const matter = decision.matter
  const labels: Classification[] = [readableLabel(matter.classification)]
  const partyNames = new Set<string>()
  const client =
    store.entities.get(matter.clientId) ?? (await repos.entities.get(matter.clientId, actor.firmId))
  if (client && client.firmId === actor.firmId && client.canonicalName) {
    partyNames.add(client.canonicalName)
  }

  const documentIds = [...new Set(input.documentIds ?? [])]
  for (const documentId of documentIds) {
    const stored = await repos.documents.get(documentId, actor.firmId)
    // FA-F13-039: same contract as documents GET (FA-F13-036) — Firestore null is authoritative.
    if (resolvePersistenceMode() === "firestore" && stored === null) {
      store.documents.delete(documentId)
    }
    const doc = stored ?? store.documents.get(documentId) ?? null
    // Cross-firm documents are reported as unknown: no existence oracle.
    if (!doc || doc.firmId !== actor.firmId) {
      throw new CommitteeScopeError(404, "unknown document", "NOT_FOUND")
    }
    // Every referenced document must belong to the request's matter. This keeps
    // the output's audience (members of that matter) equal to the audience of
    // everything it was derived from (#4), and stops a matter-less or
    // other-matter document from lowering the label (#2).
    if (doc.matterId !== matter.id) {
      throw new CommitteeScopeError(
        403,
        "document does not belong to the referenced matter",
        "document_matter_mismatch"
      )
    }
    labels.push(readableLabel(doc.classification))
  }

  return {
    // Free text in the request inherits this: max(matter, documents).
    classification: strictestClassification(labels) ?? MOST_RESTRICTIVE,
    matterId: matter.id,
    documentIds,
    partyNames: [...partyNames],
  }
}
