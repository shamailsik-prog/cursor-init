import type { FirmBoundSpineRepositories } from "@/platform/persistence/firmBoundRepositories"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { MatterMember, SpineStore } from "@/platform/spine/store"

type MemberSyncRepos = {
  members: {
    listByFirm(firmId: string): Promise<readonly MatterMember[]>
  }
}

export async function syncFirmMembers(
  store: SpineStore,
  repos: SpineRepositories | FirmBoundSpineRepositories | MemberSyncRepos,
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
