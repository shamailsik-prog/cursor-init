/**
 * FA-F42-R1-006-003-001-002: explicit `independentPartner` on legacy partner docs that relied on
 * absent lineage (interpreted as independent). Idempotent; skips rows that already carry the flag.
 */

export type BootstrapMarker = {
  founderUid?: unknown
  firstFirmId?: unknown
}

function safeDocId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("/")
}

function isActivePartner(data: Record<string, unknown>): boolean {
  return data.role === "partner" && data.active !== false
}

function isBootstrapFounder(uid: string, data: Record<string, unknown>, bootstrap: BootstrapMarker): boolean {
  return (
    safeDocId(bootstrap.founderUid) &&
    safeDocId(bootstrap.firstFirmId) &&
    bootstrap.founderUid === uid &&
    data.firmId === bootstrap.firstFirmId
  )
}

function hasExplicitAttestation(data: Record<string, unknown>): boolean {
  return safeDocId(data.partnerAttestedBy)
}

export type LegacyPartnerIndependenceBackfillPlan = {
  /** Partners still missing `independentPartner`; value is the explicit register entry to write. */
  stamp: Array<{ id: string; patch: { independentPartner: boolean } }>
  /** Non-partners, inactive partners, or partners that already have an explicit flag. */
  complete: string[]
}

export function planLegacyPartnerIndependenceBackfill(
  rows: readonly { id: string; data: unknown }[],
  bootstrap: BootstrapMarker = {}
): LegacyPartnerIndependenceBackfillPlan {
  const plan: LegacyPartnerIndependenceBackfillPlan = { stamp: [], complete: [] }
  for (const row of rows) {
    const path = `users/${row.id}`
    const data = row.data
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      plan.complete.push(path)
      continue
    }
    const record = data as Record<string, unknown>
    if (!isActivePartner(record)) {
      plan.complete.push(path)
      continue
    }
    if (Object.hasOwn(record, "independentPartner")) {
      plan.complete.push(path)
      continue
    }
    const independentPartner =
      hasExplicitAttestation(record) || isBootstrapFounder(row.id, record, bootstrap)
    plan.stamp.push({ id: row.id, patch: { independentPartner } })
  }
  return plan
}

export type LegacyPartnerIndependenceStampResult = { status: "written" } | { status: "skipped" }

export type LegacyPartnerIndependenceBackfillStore = {
  /** Re-reads `users/id` and writes the patch only while `independentPartner` is still absent. */
  stamp(id: string, patch: { independentPartner: boolean }): Promise<LegacyPartnerIndependenceStampResult>
}

export async function applyLegacyPartnerIndependenceBackfill(
  store: LegacyPartnerIndependenceBackfillStore,
  plan: LegacyPartnerIndependenceBackfillPlan
): Promise<{ applied: string[]; skipped: string[]; failed: { path: string; message: string }[] }> {
  const applied: string[] = []
  const skipped: string[] = []
  const failed: { path: string; message: string }[] = []
  for (const row of plan.stamp) {
    const path = `users/${row.id}`
    try {
      const outcome = await store.stamp(row.id, row.patch)
      if (outcome.status === "written") applied.push(path)
      else skipped.push(path)
    } catch (err) {
      failed.push({ path, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { applied, skipped, failed }
}
