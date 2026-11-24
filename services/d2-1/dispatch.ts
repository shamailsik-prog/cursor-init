import { isClassification, type Classification } from "@/platform/p1/types"
import { checkPermission } from "@/platform/p5/checkPermission"
import { decide, type PermissionDecision } from "@/platform/p5/permissionDecision"
import { recordOperationMatter } from "@/platform/retention/operationMatters"
import { syncFirmMatters, syncFirmMembers } from "@/platform/persistence/memberSync"
import { listMattersForUser } from "@/services/d1-2/matters"
import {
  rankOf,
  rankOfStoredOrMax,
  type DraftRecord,
  type Matter,
  type MatterMember,
  type SpineStore,
} from "@/platform/spine/store"
import {
  INCLUDED_WHATSAPP_COMMANDS,
  commandUsage,
  parseWhatsAppMessage,
  type IncludedCommand,
} from "./grammar"

/**
 * PARITY-006, the web route's authority before the decision. The webhook is
 * still unbound, so this is not a bearer withF02Authority wrap. It is the same
 * sync and the same one permission_check row the web route writes.
 *
 * | Command | Sync, then one audited decision |
 * |---|---|
 * | matters, hearings, intake, help | syncFirmMembers, syncFirmMatters, checkPermission(list_matters) |
 * | clients | those syncs, then the web intern denial or checkPermission(client.read) |
 * | drafts | those syncs plus the firm's drafts, one checkPermission(draft); each draft is decide() only |
 * | research, presence | those syncs, one checkPermission |
 * | open | those syncs, drafts when the list was drafts, one row, title read now |
 *
 * A missing, other-firm, tombstoned or above-clearance open replies "not found".
 * A decide() denial such as not-member stays "permission denied".
 */

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
 * so a client may ask and an accounts user stays denied. Hearings do not read
 * D6-1 in this slice, so the reply says the list is not available yet.
 * presence has no web decide() call; it reuses
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

export type WhatsAppSyncRepos = {
  members: { listByFirm(firmId: string): Promise<readonly MatterMember[]> }
  matters: { listByFirm(firmId: string): Promise<readonly Matter[]> }
  drafts?: { listByFirm(firmId: string): Promise<readonly DraftRecord[]> }
}

export function permitWhatsApp(store: SpineStore, userId: string, action: string, matterId?: string) {
  return checkPermission(store, userId, action, matterId)
}

/** The store itself, which is what memory-mode repositories list. */
function storeRepos(store: SpineStore): WhatsAppSyncRepos {
  return {
    members: {
      async listByFirm(firmId) {
        return [...store.members.values()].filter((row) => row.firmId === firmId)
      },
    },
    matters: {
      async listByFirm(firmId) {
        return [...store.matters.values()].filter((row) => row.firmId === firmId)
      },
    },
    drafts: {
      async listByFirm(firmId) {
        return [...store.drafts.values()].filter((row) => row.firmId === firmId)
      },
    },
  }
}

function reposFor(store: SpineStore, override?: WhatsAppSyncRepos): WhatsAppSyncRepos {
  if (!override) return storeRepos(store)
  return { ...storeRepos(store), ...override, drafts: override.drafts ?? storeRepos(store).drafts }
}

/** Same drop rule as syncFirmMatters: only a row cached before the listing, and still the same object, is removed. */
async function syncFirmDrafts(store: SpineStore, repos: WhatsAppSyncRepos, firmId: string): Promise<void> {
  if (!repos.drafts) return
  const before = new Map([...store.drafts.entries()].filter(([, row]) => row.firmId === firmId))
  const rows = (await repos.drafts.listByFirm(firmId)).filter((row) => typeof row.id === "string" && row.id !== "")
  const listed = new Set(rows.map((row) => row.id))
  for (const [key, row] of before) {
    if (!listed.has(key) && store.drafts.get(key) === row) store.drafts.delete(key)
  }
  for (const row of rows) store.drafts.set(row.id, row)
}

async function syncBeforeDecision(store: SpineStore, repos: WhatsAppSyncRepos, userId: string, needsDrafts: boolean): Promise<void> {
  const user = store.users.get(userId)
  if (!user) return
  await syncFirmMembers(store, repos, user.firmId)
  await syncFirmMatters(store, repos, user.firmId)
  if (needsDrafts) await syncFirmDrafts(store, repos, user.firmId)
}

/** decide() without an audit row. Per-item filters use this so a command writes one row. */
function judge(store: SpineStore, userId: string, action: string, matterId?: string): PermissionDecision {
  if (matterId !== undefined) recordOperationMatter(matterId)
  const user = store.users.get(userId) ?? null
  const matter = matterId ? (store.matters.get(matterId) ?? null) : undefined
  const isMember = matterId ? store.members.has(store.memberKey(matterId, userId)) : false
  return decide(user, action, matter, isMember)
}

/** The web checkPermission row (platform/p5/checkPermission.ts appendPermissionAudit). */
function recordPermissionAudit(
  store: SpineStore,
  userId: string,
  action: string,
  decision: PermissionDecision,
  matterId?: string
): void {
  const user = store.users.get(userId)
  const matter = matterId ? store.matters.get(matterId) : undefined
  const classification: Classification = matter
    ? isClassification(matter.classification)
      ? matter.classification
      : "privileged-restricted"
    : "internal"
  store.audit.push({
    id: store.id("aud"),
    firmId: user?.firmId ?? matter?.firmId ?? "_unresolved",
    at: Date.now(),
    action: "permission_check",
    actorId: userId,
    target: matterId ?? action,
    classification,
    reason: `${decision.allow ? "allow" : "deny"}:${action}:${decision.reason}`,
  })
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

function tombstoned(matter: object): boolean {
  return "deleted" in matter && (matter as { deleted?: unknown }).deleted === true
}

const HIDDEN_OPEN = new Set(["cross-firm", "matter-deleted", "clearance"])

/** The cached row is checked again against the store: membership, clearance, and the draft's own classification. No audit. */
function visibleNow(store: SpineStore, userId: string, action: string, item: Numbered): PermissionDecision {
  const user = store.users.get(userId)
  if (!user) return { allow: false, reason: "no-user" }

  if (action === "draft") {
    const draft = store.drafts.get(item.id)
    if (!draft || draft.firmId !== user.firmId) return { allow: false, reason: "cross-firm" }
    const permission = judge(store, userId, "draft", draft.matterId)
    if (!permission.allow) return permission
    if (rankOf(user.clearanceLevel) < rankOfStoredOrMax(draft.classification)) return { allow: false, reason: "clearance" }
    return permission
  }

  if (action === "list_matters") {
    const permission = judge(store, userId, action)
    if (!permission.allow) return permission
    const matter = store.matters.get(item.id)
    if (!matter || matter.firmId !== user.firmId) return { allow: false, reason: "cross-firm" }
    if (tombstoned(matter)) return { allow: false, reason: "matter-deleted" }
    if (!listMattersForUser(store, userId).some((row) => row.id === item.id)) return { allow: false, reason: "not-member" }
    if (rankOf(user.clearanceLevel) < rankOfStoredOrMax(matter.classification)) return { allow: false, reason: "clearance" }
    return permission
  }

  if (action === "client.read") {
    const permission = judge(store, userId, action)
    if (!permission.allow) return permission
    const entity = store.entities.get(item.id)
    if (!entity || entity.firmId !== user.firmId) return { allow: false, reason: "cross-firm" }
    if (rankOf(user.clearanceLevel) < rankOfStoredOrMax(entity.classification)) return { allow: false, reason: "clearance" }
    if (!listMattersForUser(store, userId).some((matter) => matter.clientId === entity.id)) {
      return { allow: false, reason: "not-member" }
    }
    return permission
  }

  return judge(store, userId, action)
}

function titleNow(store: SpineStore, action: string, item: Numbered): string | null {
  if (action === "list_matters") return store.matters.get(item.id)?.title ?? null
  if (action === "draft") return store.drafts.get(item.id)?.title ?? null
  if (action === "client.read") return store.entities.get(item.id)?.canonicalName ?? null
  return item.title
}

function openedMatterId(store: SpineStore, action: string, item: Numbered): string | undefined {
  if (action === "list_matters") return item.id
  if (action === "draft") return store.drafts.get(item.id)?.matterId
  return undefined
}

function openDenied(permission: PermissionDecision): WhatsAppDispatch {
  if (HIDDEN_OPEN.has(permission.reason)) {
    return { ok: false, denied: true, command: "open", permission: { allow: false, reason: "not-found" }, text: "not found" }
  }
  return denied("open", permission)
}

export async function dispatchWhatsApp(
  store: SpineStore,
  userId: string,
  text: string,
  options: {
    now?: number
    readResearch?: (query: string) => Promise<ResearchHit[]>
    /** Authoritative members, matters and drafts. Omitted reads the store, as memory mode does. */
    repos?: WhatsAppSyncRepos
  } = {}
): Promise<WhatsAppDispatch> {
  const now = options.now ?? Date.now()
  const parsed = parseWhatsAppMessage(text, now)
  if (parsed.kind === "cut") return { ok: false, error: "wa_31_cut", command: parsed.name, text: "command refused" }
  if (parsed.kind === "unsupported") return { ok: false, error: "unsupported", text: "unsupported command" }
  if (parsed.kind === "malformed") return { ok: false, error: "malformed", command: parsed.name, text: "unsupported command grammar" }

  const repos = reposFor(store, options.repos)

  if (parsed.kind === "reply") {
    const stored = threads.get(userId)
    const action = stored?.action ?? "research"
    await syncBeforeDecision(store, repos, userId, action === "draft")
    const item = stored?.items[parsed.n - 1]
    if (!item) {
      const permission = permitWhatsApp(store, userId, action)
      if (!permission.allow) return denied("open", permission)
      return { ok: false, error: "no_list", command: "open", permission, text: "no list" }
    }
    const permission = visibleNow(store, userId, action, item)
    const matterId = openedMatterId(store, action, item)
    if (!permission.allow) {
      recordPermissionAudit(store, userId, action, permission, matterId)
      return openDenied(permission)
    }
    const title = titleNow(store, action, item)
    if (title === null) {
      const missing = { allow: false, reason: "cross-firm" }
      recordPermissionAudit(store, userId, action, missing, matterId)
      return openDenied(missing)
    }
    recordPermissionAudit(store, userId, action, permission, matterId)
    const opened = { ...item, title }
    return { ok: true, command: "open", permission, opened, text: `${item.n}. ${title}` }
  }

  await syncBeforeDecision(store, repos, userId, parsed.name === "drafts")

  // GET /api/d1/clients denies an intern before the registry read. decide()
  // client.read allows an intern, so this route guard runs first. It writes
  // one deny row and no allow row. Presence keeps client.read.
  if (parsed.name === "clients" && store.users.get(userId)?.role === "intern") {
    const permission = { allow: false, reason: "user role not allowed for client registry reads" }
    recordPermissionAudit(store, userId, "client.read", permission)
    return denied(parsed.name, permission)
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
    return {
      ok: true,
      command: parsed.name,
      permission,
      text: "hearings not available yet",
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
      .filter((draft) => judge(store, userId, "draft", draft.matterId).allow)
      .filter((draft) => rankOf(user.clearanceLevel) >= rankOfStoredOrMax(draft.classification))
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
