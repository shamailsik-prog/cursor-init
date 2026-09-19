import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import type { SpineStore } from "@/platform/spine/store"

export async function syncFirmAudit(
  store: SpineStore,
  repos: SpineRepositories,
  firmId: string
): Promise<void> {
  const rows = await repos.audit.listByFirm(firmId)
  const localOtherFirms = store.audit.filter((row) => row.firmId !== firmId)
  store.audit = [...localOtherFirms, ...rows]
}
