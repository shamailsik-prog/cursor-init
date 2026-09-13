import { checkPermission } from "@/platform/p5/checkPermission"
import { listMattersForUser } from "@/services/d1-2/matters"
import type { SpineStore } from "@/platform/spine/store"

export type WhatsAppResult = {
  ok: boolean
  denied?: boolean
  matters?: { id: string; title: string }[]
  research?: string[]
}

export function handleWhatsApp(
  store: SpineStore,
  userId: string,
  command: string
): WhatsAppResult {
  const text = command.trim()
  if (text.startsWith("/matters")) {
    const perm = checkPermission(store, userId, "list_matters")
    if (!perm.allow) return { ok: false, denied: true }
    const matters = listMattersForUser(store, userId).map((m) => ({
      id: m.id,
      title: m.title,
    }))
    return { ok: true, matters }
  }
  if (text.startsWith("/research")) {
    const perm = checkPermission(store, userId, "research")
    if (!perm.allow) return { ok: false, denied: true }
    return { ok: true, research: [] }
  }
  return { ok: false, denied: true }
}
