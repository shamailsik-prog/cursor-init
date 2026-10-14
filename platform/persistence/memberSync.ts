import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { Matter, SpineStore } from "@/platform/spine/store"

export async function syncFirmMembers(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.members.listByFirm(firmId)
  for (const [key, row] of store.members.entries()) {
    if (row.firmId === firmId) {
      store.members.delete(key)
    }
  }
  for (const row of rows) {
    store.members.set(store.memberKey(row.matterId, row.userId), row)
  }
}

/**
 * Audit F14 / O-76: reconciles the store's copy of the firm's matters with the persisted rows, as
 * `syncFirmMembers` does for memberships, so an access check reads each matter's CURRENT label and
 * firm (a matter raised by another process or client, e.g. Cloud Functions or a partner's monotonic
 * update under firestore.rules, binds this process's next read). Copilot C3: a cached matter of this
 * firm that the repository no longer returns (deleted, or moved to another firm, by an operator or
 * another process) is removed, so later checks deny it as unknown instead of authorising against a
 * stale label or firm; a moved matter is cached again under its new firm when that firm syncs.
 * Returns the firm's matters as listed, the request's one listing of them (C4). In memory mode the
 * repository is the store itself, so this changes nothing.
 */
export async function syncFirmMatters(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<Matter[]> {
  const rows = await repos.matters.listByFirm(firmId)
  const current = new Set(rows.map((row) => row.id))
  for (const [id, row] of store.matters.entries()) {
    if (row.firmId === firmId && !current.has(id)) {
      store.matters.delete(id)
    }
  }
  for (const row of rows) {
    store.matters.set(row.id, row)
  }
  return rows
}
