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

export async function syncFirmTenancyLineageClosureAdjudications(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancyLineageClosureAdjudications.listByFirm(firmId)
  for (const row of rows) {
    store.tenancyLineageClosureAdjudications.set(row.id, row)
  }
}

export async function syncFirmTenancyLineageArbitrationDebtRetirementLedgers(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancyLineageArbitrationDebtRetirementLedgers.listByFirm(firmId)
  for (const row of rows) {
    store.tenancyLineageArbitrationDebtRetirementLedgers.set(row.id, row)
  }
}

export async function syncFirmTenancyLineageClosureAdjudicationSettlements(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancyLineageClosureAdjudicationSettlements.listByFirm(firmId)
  for (const row of rows) {
    store.tenancyLineageClosureAdjudicationSettlements.set(row.id, row)
  }
}

export async function syncFirmTenancyLineageArbitrationDebtRetirementDisputeLedgers(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancyLineageArbitrationDebtRetirementDisputeLedgers.listByFirm(firmId)
  for (const row of rows) {
    store.tenancyLineageArbitrationDebtRetirementDisputeLedgers.set(row.id, row)
  }
}

export async function syncFirmTenancyExternalSessionIdentityBridges(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.tenancyExternalSessionIdentityBridges.listByFirm(firmId)
  for (const row of rows) {
    store.tenancyExternalSessionIdentityBridges.set(row.id, row)
  }
}
