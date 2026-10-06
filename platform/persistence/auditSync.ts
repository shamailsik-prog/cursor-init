import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import { isAuditRowPersisted, markAuditRowPersisted } from "@/platform/audit/requestAudit"
import type { SpineStore } from "@/platform/spine/store"

/**
 * Refresh this firm's rows of the in-memory audit log from the audit repository, in place
 * (review R2 N2: the AuditLog object must survive, or per-request persistence and the bound are
 * lost). Other firms' rows are kept, and so are this firm's local rows that are not persisted
 * yet (they are still owed to the repository by their request's flush or the retry queue).
 */
export async function syncFirmAudit(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.audit.listByFirm(firmId)
  for (const row of rows) markAuditRowPersisted(row)
  const repoIds = new Set(rows.map((row) => row.id).filter((id): id is string => typeof id === "string"))
  const kept = store.audit.filter(
    (row) =>
      row.firmId !== firmId ||
      (!isAuditRowPersisted(row) && !(row.id !== undefined && repoIds.has(row.id)))
  )
  store.audit.replaceAll([...kept, ...rows])
}
