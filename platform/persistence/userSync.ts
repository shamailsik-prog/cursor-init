import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { SpineStore } from "@/platform/spine/store"

export async function syncFirmUsers(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.users.listByFirm(firmId)
  for (const row of rows) {
    store.users.set(row.id, row)
  }
}
