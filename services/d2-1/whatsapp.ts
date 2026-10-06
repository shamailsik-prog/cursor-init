import { checkPermission } from "@/platform/p5/checkPermission"
import { listMattersForUser } from "@/services/d1-2/matters"
import type { SpineStore } from "@/platform/spine/store"

/**
 * The D2-1 WhatsApp command grammar: every command the channel accepts, one row
 * each. The court-ops route validates and dispatches through this table, and
 * Gate G-2 (tests/g2.cross-firm.test.ts) reads it to inventory the channel's
 * read commands, so a command cannot be added without the gate seeing it.
 */
export const WHATSAPP_COMMANDS = [
  { name: "matters", usage: "/matters", pattern: /^\/matters$/i },
  { name: "research", usage: "/research <query>", pattern: /^\/research\s+.+/i },
  { name: "ops", usage: "/ops queue", pattern: /^\/ops\s+queue$/i },
] as const

type WhatsAppCommandRow = (typeof WHATSAPP_COMMANDS)[number]
export type WhatsAppCommandName = WhatsAppCommandRow extends { name: infer N } ? N : never

export const WHATSAPP_GRAMMAR_HELP = `unsupported command grammar; allowed: ${WHATSAPP_COMMANDS.map((c) => c.usage).join(", ")}`

/** The table row a command text matches (trimmed), or undefined when it is outside the grammar. */
export function whatsAppCommandName(command: string): WhatsAppCommandName | undefined {
  const text = command.trim()
  return WHATSAPP_COMMANDS.find((c) => c.pattern.test(text))?.name
}

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
  const name = whatsAppCommandName(command)
  if (name === "matters") {
    const perm = checkPermission(store, userId, "list_matters")
    if (!perm.allow) return { ok: false, denied: true }
    const matters = listMattersForUser(store, userId).map((m) => ({
      id: m.id,
      title: m.title,
    }))
    return { ok: true, matters }
  }
  if (name === "research") {
    const perm = checkPermission(store, userId, "research")
    if (!perm.allow) return { ok: false, denied: true }
    return { ok: true, research: [] }
  }
  return { ok: false, denied: true }
}
