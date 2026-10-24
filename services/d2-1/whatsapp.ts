import { checkPermission } from "@/platform/p5/checkPermission"
import { listMattersForUser } from "@/services/d1-2/matters"
import type { CitationVerdict } from "@/services/d4-2/citationVerdict"
import { searchResearch, type ResearchSource } from "@/services/d5-1/research"
import { activeResearchSource } from "@/services/d5-1/researchCorpus"
import type { SpineStore } from "@/platform/spine/store"

/**
 * The D2-1 WhatsApp command grammar: every command the channel accepts, one row
 * each. The court-ops route validates and dispatches through this table, and
 * Gate G-2 (tests/g2.cross-firm.test.ts) reads it to inventory the channel's
 * read commands, so a command cannot be added without the gate seeing it.
 * A row whose pattern has a capture group takes an argument (the `/research`
 * query); `whatsAppCommandArgument` reads it through the table.
 */
export const WHATSAPP_COMMANDS = [
  { name: "matters", usage: "/matters", pattern: /^\/matters$/i },
  { name: "research", usage: "/research <query>", pattern: /^\/research\s+([\s\S]+)/i },
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

/** The argument a command carries (its pattern's capture group, trimmed), or "" when it carries none. */
export function whatsAppCommandArgument(command: string): string {
  const text = command.trim()
  const row = WHATSAPP_COMMANDS.find((c) => c.pattern.test(text))
  return row?.pattern.exec(text)?.[1]?.trim() ?? ""
}

/** One line of the `/research` reply: a numbered list (L18 §8), each authority with its Module 33 treatment. */
export type WhatsAppResearchItem = {
  n: number
  entityId: string
  title: string
  citation: string | null
  treatment: CitationVerdict
  score: number
}

export type WhatsAppResult = {
  ok: boolean
  denied?: boolean
  matters?: { id: string; title: string }[]
  research?: WhatsAppResearchItem[]
}

/**
 * Runs one command. `/research` reads its corpus through `researchSource` (audit FA-D5-003, spec R14): by default the source
 * the environment selects (the published Annex A corpus in production; the in-app read model only when explicitly
 * selected outside a hosted runtime). A corpus it cannot read throws CorpusUnavailableError, which the court-ops route
 * answers as 503 `corpus_unavailable`, never as an empty list.
 */
export async function handleWhatsApp(
  store: SpineStore,
  userId: string,
  command: string,
  researchSource?: ResearchSource
): Promise<WhatsAppResult> {
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
    // P5 first (R-1, L19.10), before the query or the corpus is read: a denied caller learns nothing, whatever it sent.
    const perm = checkPermission(store, userId, "research")
    if (!perm.allow) return { ok: false, denied: true }
    // D5-1 search (audit FA-D2WA-001, FA-D5-003): the query and the published corpus decide the reply. A refused query
    // or corpus throws a PublicError, which the court-ops route answers with a 400 carrying the fixed message; a corpus
    // that cannot be read throws CorpusUnavailableError (503).
    const query = whatsAppCommandArgument(command)
    const found = await searchResearch(researchSource ?? activeResearchSource(store), { text: query })
    const research = found.items.map((hit, i) => ({
      n: i + 1,
      entityId: hit.entityId,
      title: hit.title,
      citation: hit.citation,
      treatment: hit.treatment,
      score: hit.score,
    }))
    return { ok: true, research }
  }
  return { ok: false, denied: true }
}
