import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { AuditEntry, SpineStore } from "@/platform/spine/store"

function normalizeAuditEntry(store: SpineStore, row: AuditEntry): AuditEntry {
  const actorFirmId = store.users.get(row.actorId)?.firmId
  return {
    ...row,
    id: row.id ?? store.id("aud"),
    firmId: row.firmId ?? actorFirmId,
    at: row.at ?? Date.now(),
  }
}

export async function persistAuditEntriesSince(
  store: SpineStore,
  repos: SpineRepositories,
  startIndex: number
): Promise<void> {
  for (let index = startIndex; index < store.audit.length; index += 1) {
    const current = store.audit[index]
    if (!current) continue
    const normalized = normalizeAuditEntry(store, current)
    if (!normalized.firmId) {
      throw new Error(`unable to resolve audit firm for action ${normalized.action}`)
    }
    store.audit[index] = normalized
    await repos.audit.append(normalized)
  }
}
