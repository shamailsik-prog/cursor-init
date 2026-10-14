import type { FirmBoundSpineRepositories } from "@/platform/persistence/firmBoundRepositories"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { SpineStore, User } from "@/platform/spine/store"

type UserSyncRepos = {
  users: {
    listByFirm(firmId: string): Promise<readonly User[]>
  }
}

export async function syncFirmUsers(
  store: SpineStore,
  repos: SpineRepositories | FirmBoundSpineRepositories | UserSyncRepos,
  firmId: string
): Promise<void> {
  const rows = await repos.users.listByFirm(firmId)
  for (const row of rows) {
    store.users.set(row.id, row)
  }
}
