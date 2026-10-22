import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { SpineStore } from "@/platform/spine/store"

/**
 * FA-F13-001: the users a request names (a new matter's client and members, an added member) are resolved through the
 * firm-scoped users repository on a cache miss, not only from the process's session cache. A record of another firm,
 * or one the identity policy would refuse (not `active: true`), is not cached, so the route's checks refuse it as before.
 * The `row.firmId === firmId` check is kept even though the lookup is firm-scoped: the repository trims the firm it is
 * given, so a padded firmId would otherwise cache the trimmed firm's users (S4-001d).
 */
export async function primeFirmUsers(store: SpineStore, repo: Pick<SpineRepositories, "users">, firmId: string, ids: Iterable<string>) {
  for (const id of ids) {
    if (!id || store.users.has(id)) continue
    const row = await repo.users.get(id, firmId)
    if (row && row.firmId === firmId && row.active === true) store.users.set(id, row.id === id ? row : { ...row, id })
  }
}
