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

export async function syncFirmTenancyLineageReconciliationQueueArbitrations(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancyLineageReconciliationQueueArbitrations.listByFirm(firmId)
  for (const row of rows) {
    store.tenancyLineageReconciliationQueueArbitrations.set(row.id, row)
  }
}

export async function syncFirmTenancyLineageDigestClosureCheckpoints(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancyLineageDigestClosureCheckpoints.listByFirm(firmId)
  for (const row of rows) {
    store.tenancyLineageDigestClosureCheckpoints.set(row.id, row)
  }
}
