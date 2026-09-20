import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { SpineStore } from "@/platform/spine/store"

export async function syncFirmTenancySessionReferences(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancySessionReferences.listByFirm(firmId)
  for (const row of rows) {
    store.tenancySessionReferences.set(row.id, row)
  }
}
