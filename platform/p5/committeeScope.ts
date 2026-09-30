/**
 * Server-side scope for Committee Brain requests (Layer 18 §4.5 / §4.6).
 *
 * The classification that drives P1 provider policy is derived from the
 * records the request references — never from a caller-supplied label:
 *   aggregate = max rank over the referenced matter and documents;
 *   nothing referenced → privileged-restricted (most restrictive).
 * Access to every referenced matter goes through P5 `checkPermission`.
 */
import { checkPermission } from "@/platform/p5/checkPermission"
import { classificationRank, type Classification } from "@/platform/p1/types"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { Matter, SpineStore, User } from "@/platform/spine/store"

export const MOST_RESTRICTIVE: Classification = "privileged-restricted"

export class CommitteeScopeError extends Error {
  readonly status: 403 | 404
  constructor(status: 403 | 404, message: string) {
    super(message)
    this.name = "CommitteeScopeError"
    this.status = status
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

async function loadMatter(
  store: SpineStore,
  repos: SpineRepositories,
  matterId: string
): Promise<Matter | null> {
  const matter = store.matters.get(matterId) ?? (await repos.matters.get(matterId))
  if (matter) store.matters.set(matter.id, matter)
  return matter ?? null
}

/** Hydrates the matter + membership row, then defers to P5 checkPermission. */
export async function canAccessMatter(
  store: SpineStore,
  repos: SpineRepositories,
  actor: User,
  matterId: string,
  action = "committee_brain"
): Promise<{ allow: boolean; reason: string; matter: Matter | null }> {
  const matter = await loadMatter(store, repos, matterId)
  if (!matter) return { allow: false, reason: "unknown-matter", matter: null }
  const key = store.memberKey(matterId, actor.id)
  if (!store.members.has(key)) {
    const member = await repos.members.get(matterId, actor.id)
    if (member) store.members.set(key, member)
  }
  const decision = checkPermission(store, actor.id, action, matterId)
  return { ...decision, matter }
}

export async function resolveCommitteeScope(
  store: SpineStore,
  repos: SpineRepositories,
  actor: User,
  input: { matterId?: string; documentIds?: string[] }
): Promise<CommitteeScope> {
  const labels: Classification[] = []
  const partyNames = new Set<string>()
  const checkedMatters = new Set<string>()

  const requireMatter = async (matterId: string) => {
    if (checkedMatters.has(matterId)) return
    const decision = await canAccessMatter(store, repos, actor, matterId)
    if (!decision.matter) throw new CommitteeScopeError(404, "unknown matter")
    if (!decision.allow) {
      throw new CommitteeScopeError(403, `permission denied: ${decision.reason}`)
    }
    checkedMatters.add(matterId)
    labels.push(decision.matter.classification)
    const client =
      store.entities.get(decision.matter.clientId) ??
      (await repos.entities.get(decision.matter.clientId))
    if (client && client.firmId === actor.firmId && client.canonicalName) {
      partyNames.add(client.canonicalName)
    }
  }

  if (input.matterId) await requireMatter(input.matterId)

  const documentIds = [...new Set(input.documentIds ?? [])]
  for (const documentId of documentIds) {
    const doc = store.documents.get(documentId) ?? (await repos.documents.get(documentId))
    // Cross-firm documents are reported as unknown: no existence oracle.
    if (!doc || doc.firmId !== actor.firmId) {
      throw new CommitteeScopeError(404, "unknown document")
    }
    if (doc.matterId) {
      await requireMatter(doc.matterId)
    } else if (classificationRank(actor.clearanceLevel) < classificationRank(doc.classification)) {
      throw new CommitteeScopeError(403, "permission denied: clearance")
    }
    labels.push(doc.classification)
  }

  return {
    classification: strictestClassification(labels) ?? MOST_RESTRICTIVE,
    matterId: input.matterId ?? null,
    documentIds,
    partyNames: [...partyNames],
  }
}
