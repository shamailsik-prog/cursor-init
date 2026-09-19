import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { SpineStore } from "@/platform/spine/store"

export async function syncFirmEntities(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const entities = await repos.entities.listByFirm(firmId)
  for (const [id, row] of store.entities.entries()) {
    if (row.firmId === firmId) {
      store.entities.delete(id)
    }
  }
  for (const row of entities) {
    store.entities.set(row.id, row)
  }

  const links = await repos.entityLinks.listByFirm(firmId)
  const otherFirmLinks = store.links.filter((row) => row.firmId !== firmId)
  store.links = [...otherFirmLinks, ...links]
}
