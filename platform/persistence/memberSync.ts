import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { SpineStore } from "@/platform/spine/store"

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
 * Audit F14 / O-76: refreshes the store's copy of the firm's matters from the persisted rows, so an
 * access check reads each matter's CURRENT label and firm (a matter raised by another process or
 * client, e.g. Cloud Functions or a partner's monotonic update under firestore.rules, binds this
 * process's next read). Upsert only, as the reporting routes refresh matters: no app path deletes a
 * matter (firestore.rules has no matters delete; neither runtime deletes one), and a matter absent
 * from both the store and the repository is denied by the check. In memory mode the repository is
 * the store itself, so this changes nothing.
 */
export async function syncFirmMatters(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  for (const row of await repos.matters.listByFirm(firmId)) {
    store.matters.set(row.id, row)
  }
}
