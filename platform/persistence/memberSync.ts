import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { Matter, SpineStore } from "@/platform/spine/store"

/**
 * The firm's cached entries as they stand before a sync awaits its listing (audit F14 R5-D1). The process-wide store is
 * shared by concurrent requests, so a listing can be older than a row another request cached while the listing was in
 * flight (a matter or membership created through a route, persisted before it was cached). Only a snapshot entry that
 * the listing lacks AND that is still the same cached object is dropped; a row cached or replaced during the await is
 * left for the next sync, which reads it from the repository.
 */
function snapshotOfFirm<V extends { firmId: string }>(map: Map<string, V>, firmId: string): Map<string, V> {
  return new Map([...map.entries()].filter(([, row]) => row.firmId === firmId))
}

function dropUnlisted<V>(map: Map<string, V>, before: Map<string, V>, listed: ReadonlySet<string>): void {
  for (const [key, row] of before) {
    if (!listed.has(key) && map.get(key) === row) map.delete(key)
  }
}

/**
 * Reconciles the store's copy of the firm's memberships with the persisted rows: a membership revoked elsewhere is
 * dropped, and every listed one is cached. Audit F14 R5-D1: a membership another request caches while this listing is
 * in flight is kept (`dropUnlisted`), where the earlier version dropped every cached membership of the firm first.
 */
export async function syncFirmMembers(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const before = snapshotOfFirm(store.members, firmId)
  const rows = await repos.members.listByFirm(firmId)
  dropUnlisted(store.members, before, new Set(rows.map((row) => store.memberKey(row.matterId, row.userId))))
  for (const row of rows) {
    store.members.set(store.memberKey(row.matterId, row.userId), row)
  }
}

/**
 * Audit F14 / O-76: reconciles the store's copy of the firm's matters with the persisted rows, as
 * `syncFirmMembers` does for memberships, so an access check reads each matter's CURRENT label and
 * firm (a matter raised by another process or client, e.g. Cloud Functions or a partner's monotonic
 * update under firestore.rules, binds this process's next read). Copilot C3: a cached matter of this
 * firm that the repository no longer returns (deleted, or moved to another firm, by an operator or
 * another process) is removed, so later checks deny it as unknown instead of authorising against a
 * stale label or firm; a moved matter is cached again under its new firm when that firm syncs.
 * Audit F14 R5-D1: only a matter cached before the listing was awaited, and still the same cached
 * object, is dropped, so a matter another request creates while this listing is in flight (persisted,
 * then cached) is kept. Returns the firm's matters as listed, the request's one listing of them (C4).
 * In memory mode the repository is the store itself, so this changes nothing.
 */
export async function syncFirmMatters(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<Matter[]> {
  const before = snapshotOfFirm(store.matters, firmId)
  const rows = await repos.matters.listByFirm(firmId)
  dropUnlisted(store.matters, before, new Set(rows.map((row) => row.id)))
  for (const row of rows) {
    store.matters.set(row.id, row)
  }
  return rows
}
