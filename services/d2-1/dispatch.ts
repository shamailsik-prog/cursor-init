import { checkPermission } from "@/platform/p5/checkPermission"
import { listMattersForUser } from "@/services/d1-2/matters"
import { rankOf, rankOfStoredOrMax, type SpineStore } from "@/platform/spine/store"
import {
  INCLUDED_WHATSAPP_COMMANDS,
  commandUsage,
  parseHearingDate,
  parseWhatsAppMessage,
  type IncludedCommand,
} from "./grammar"

/**
 * Permission parity with the web. Every included command calls checkPermission,
 * which calls decide() in platform/p5/permissionDecision.ts. There is no second
 * allow table.
 *
 * Web call sites:
 * - list_matters: app/api/d1/matters/route.ts (GET)
 * - client.read: functions/src/d1/client/ops.ts
 * - draft: app/api/d4/drafts/route.ts (per draft)
 * - research: the action already passed to checkPermission for /research
 *
 * hearings, intake and help have no web decide() call. They reuse list_matters
 * so a client can see own hearings (L8.1), start intake, and read help, and an
 * accounts user stays denied. presence has no web decide() call; it reuses
 * client.read so a client is denied and staff, including an intern, are not.
 * Adding a new action string would be a separate allow path.
 */
export const WHATSAPP_WEB_ACTION = {
  matters: "list_matters",
  hearings: "list_matters",
  clients: "client.read",
  drafts: "draft",
  research: "research",
  presence: "client.read",
  intake: "list_matters",
  help: "list_matters",
} as const satisfies Record<IncludedCommand, string>

const PAGE = 10

export type ResearchHit = { title: string }

export type Numbered = { n: number; id: string; title: string }

export type WhatsAppDispatch = {
  ok: boolean
  denied?: boolean
  permission?: { allow: boolean; reason: string }
  command?: string
  error?: string
  text: string
  matters?: Numbered[]
  hearings?: { date: string; items: Numbered[] }
  clients?: { n: number; id: string; name: string }[]
  drafts?: { n: number; id: string; title: string; matterId: string }[]
  research?: Numbered[]
  presence?: { direction: "in" | "out" | null; recorded: false }
  intake?: { accepted: true; persisted: false }
  help?: { language: "en" | "ur"; commands: string[] }
  opened?: Numbered
}

type Thread = { action: string; items: Numbered[] }

const threads = new Map<string, Thread>()

export function resetD2WhatsAppThreadsForTests(): void {
  threads.clear()
}

export function permitWhatsApp(store: SpineStore, userId: string, action: string, matterId?: string) {
  return checkPermission(store, userId, action, matterId)
}

function denied(command: string | undefined, permission: { allow: boolean; reason: string }): WhatsAppDispatch {
  return { ok: false, denied: true, command, permission, text: "permission denied" }
}

function numbered(rows: { id: string; title: string }[]): Numbered[] {
  return rows.slice(0, PAGE).map((row, index) => ({ n: index + 1, id: row.id, title: row.title }))
}

function remember(userId: string, action: string, items: Numbered[]) {
  if (items.length > 0) threads.set(userId, { action, items })
}

export async function dispatchWhatsApp(
  store: SpineStore,
  userId: string,
  text: string,
  options: {
    now?: number
    readResearch?: (query: string) => Promise<ResearchHit[]>
  } = {}
): Promise<WhatsAppDispatch> {
  const now = options.now ?? Date.now()
  const parsed = parseWhatsAppMessage(text, now)
  if (parsed.kind === "cut") return { ok: false, error: "wa_31_cut", command: parsed.name, text: "command refused" }
  if (parsed.kind === "unsupported") return { ok: false, error: "unsupported", text: "unsupported command" }
  if (parsed.kind === "malformed") return { ok: false, error: "malformed", command: parsed.name, text: "unsupported command grammar" }

  if (parsed.kind === "reply") {
    const stored = threads.get(userId)
    const action = stored?.action ?? "research"
    const permission = permitWhatsApp(store, userId, action)
    if (!permission.allow) return denied("open", permission)
    const item = stored?.items[parsed.n - 1]
    if (!item) return { ok: false, error: "no_list", command: "open", permission, text: "no list" }
    return { ok: true, command: "open", permission, opened: item, text: `${item.n}. ${item.title}` }
  }

  const action = WHATSAPP_WEB_ACTION[parsed.name]
  const permission = permitWhatsApp(store, userId, action)
  if (!permission.allow) return denied(parsed.name, permission)

  const user = store.users.get(userId)
  if (!user) return denied(parsed.name, permission)

  if (parsed.name === "matters") {
    const rows = listMattersForUser(store, userId).filter((matter) => {
      if (!parsed.args) return true
      if (matter.caseNumber === parsed.args) return true
      const haystack = `${matter.title} ${matter.caseNumber ?? ""}`.toLowerCase()
      return matter.caseNumber !== parsed.args && haystack.includes(parsed.args.toLowerCase())
    })
    const exact = parsed.args ? rows.filter((matter) => matter.caseNumber === parsed.args) : []
    const matters = numbered((exact.length > 0 ? exact : rows).map((matter) => ({ id: matter.id, title: matter.title })))
    remember(userId, action, matters)
    return {
      ok: true,
      command: parsed.name,
      permission,
      matters,
      text: matters.map((row) => `${row.n}. ${row.title}`).join("\n") || "no matters",
    }
  }

  if (parsed.name === "hearings") {
    const date = parseHearingDate(parsed.args, now) ?? new Date(now).toISOString().slice(0, 10)
    return {
      ok: true,
      command: parsed.name,
      permission,
      hearings: { date, items: [] },
      text: `hearings ${date}`,
    }
  }

  if (parsed.name === "clients") {
    const linked = new Set(listMattersForUser(store, userId).map((matter) => matter.clientId))
    const clients = [...store.entities.values()]
      .filter((entity) => entity.firmId === user.firmId && linked.has(entity.id))
      .filter((entity) => rankOf(user.clearanceLevel) >= rankOfStoredOrMax(entity.classification))
      .filter((entity) => !parsed.args || entity.canonicalName.toLowerCase().includes(parsed.args.toLowerCase()))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, PAGE)
      .map((entity, index) => ({ n: index + 1, id: entity.id, name: entity.canonicalName }))
    remember(
      userId,
      action,
      clients.map((row) => ({ n: row.n, id: row.id, title: row.name }))
    )
    return {
      ok: true,
      command: parsed.name,
      permission,
      clients,
      text: clients.map((row) => `${row.n}. ${row.name}`).join("\n") || "no clients",
    }
  }

  if (parsed.name === "drafts") {
    const matters = listMattersForUser(store, userId).filter((matter) => !parsed.args || matter.caseNumber === parsed.args)
    const visible = [...store.drafts.values()]
      .filter((draft) => draft.firmId === user.firmId && matters.some((matter) => matter.id === draft.matterId))
      .filter((draft) => permitWhatsApp(store, userId, "draft", draft.matterId).allow)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, PAGE)
      .map((draft, index) => ({ n: index + 1, id: draft.id, title: draft.title, matterId: draft.matterId }))
    remember(
      userId,
      action,
      visible.map((row) => ({ n: row.n, id: row.id, title: row.title }))
    )
    return {
      ok: true,
      command: parsed.name,
      permission,
      drafts: visible,
      text: visible.map((row) => `${row.n}. ${row.title}`).join("\n") || "no drafts",
    }
  }

  if (parsed.name === "research") {
    const hits = await (options.readResearch ?? (async () => []))(parsed.args)
    const research = numbered(hits.map((hit, index) => ({ id: `r${index + 1}`, title: hit.title })))
    remember(userId, action, research)
    return {
      ok: true,
      command: parsed.name,
      permission,
      research,
      text: research.map((row) => `${row.n}. ${row.title}`).join("\n") || "no authorities",
    }
  }

  if (parsed.name === "presence") {
    const direction = parsed.args ? (parsed.args.toLowerCase() as "in" | "out") : null
    return {
      ok: true,
      command: parsed.name,
      permission,
      presence: { direction, recorded: false },
      text: direction ? `presence ${direction}` : "presence",
    }
  }

  if (parsed.name === "intake") {
    return {
      ok: true,
      command: parsed.name,
      permission,
      intake: { accepted: true, persisted: false },
      text: "intake accepted",
    }
  }

  const language = parsed.language
  const commands = INCLUDED_WHATSAPP_COMMANDS.map((row) => commandUsage(row.name, language))
  return { ok: true, command: "help", permission, help: { language, commands }, text: commands.join("\n") }
}
