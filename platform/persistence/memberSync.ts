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
