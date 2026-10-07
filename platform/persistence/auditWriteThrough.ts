import type { AuditEntry, SpineStore } from "@/platform/spine/store"

/*
 * Final audit F8: routes no longer write audit rows through by store index
 * (`persistAuditEntriesSince`, removed). That walked `store.audit` from an index, so it also
 * appended (and failed on) rows pushed by concurrent requests, failing this request after its
 * effect had committed. A request's rows are persisted once, by object, by the end-of-request
 * flush in withSession (platform/persistence/requestAuditFlush.ts), which answers 503
 * AUDIT_UNAVAILABLE when that fails.
 */

/**
 * Fills id / firmId / at on the row itself (the object in store.audit is the one persisted, so
 * a later request flush or retry re-appends an identical row, which is a no-op).
 */
export function normalizeAuditEntryInPlace(store: SpineStore, row: AuditEntry): AuditEntry {
  if (!row.id) row.id = store.id("aud")
  if (!row.firmId) {
    const actorFirmId = store.users.get(row.actorId)?.firmId
    if (actorFirmId) row.firmId = actorFirmId
  }
  if (!row.at) row.at = Date.now()
  if (!row.firmId) {
    throw new Error(`unable to resolve audit firm for action ${row.action}`)
  }
  return row
}
