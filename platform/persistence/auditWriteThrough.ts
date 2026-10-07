import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { AuditEntry, SpineStore } from "@/platform/spine/store"
import { isAuditRowPersisted, markAuditRowPersisted } from "@/platform/audit/requestAudit"

/**
 * Fills id / firmId / at on the row itself (the object in store.audit is the one persisted, so
 * a later request flush or retry re-appends an identical row, which is a no-op).
 */
export function normalizeAuditEntryInPlace(store: SpineStore, row: AuditEntry): AuditEntry {
  if (!row.id) row.id = store.id("aud")
  if (!row.firmId) {
    const actorFirmId = store.users.get(row.actorId)?.firmId
    if (actorFirmId) row.firmId = actorFirmId
  }
  if (!row.at) row.at = Date.now()
  if (!row.firmId) {
    throw new Error(`unable to resolve audit firm for action ${row.action}`)
  }
  return row
}

export async function persistAuditEntriesSince(
  store: SpineStore,
  repos: SpineRepositories,
  startIndex: number
): Promise<void> {
  for (let index = startIndex; index < store.audit.length; index += 1) {
    const current = store.audit[index]
    if (!current || isAuditRowPersisted(current)) continue
    normalizeAuditEntryInPlace(store, current)
    await repos.audit.append(current)
    markAuditRowPersisted(current)
  }
}
