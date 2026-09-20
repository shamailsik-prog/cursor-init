import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { SpineStore } from "@/platform/spine/store"

export async function syncFirmTenancyLineageReconciliationDigests(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancyLineageReconciliationDigests.listByFirm(firmId)
  for (const row of rows) {
    store.tenancyLineageReconciliationDigests.set(row.id, row)
  }
}
