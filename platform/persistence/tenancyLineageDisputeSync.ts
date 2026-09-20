import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { SpineStore } from "@/platform/spine/store"

export async function syncFirmTenancyLineageDisputeAttestations(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancyLineageDisputeAttestations.listByFirm(firmId)
  for (const row of rows) {
    store.tenancyLineageDisputeAttestations.set(row.id, row)
  }
}
