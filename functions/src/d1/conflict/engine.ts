import type { DocumentData, QuerySnapshot } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../../admin"
import { isKnownClassification, rankOf } from "../../p5/classification"
import { logFailure } from "../../log"
import { effectiveLinkState, isConfirmedState } from "../entity/linkState"
import { nameForms, usesFallback } from "./normalise"
import { screen, summarise, type Candidate, type Hit, type IdentityBasis, type Keys, type Outcome, type Subject } from "./match"

/**
 * Firestore side of the Module 6 conflict engine (spec P2-3..P2-5, P2-13, P2-18; L18 §7).
 * Loads the firm's registry (clients, opposing `matter_parties`, matters, `entity_links`,
 * `transliteration_map`), tailors each candidate's link state to the subject being screened
 * (only the link on the matched key counts), and runs the pure `screen`.
 */

/** Entity link auto-confirm window (P2-5, L18 §7.1); defined with the link state model. */
export { LINK_AUTO_CONFIRM_MS } from "../entity/linkState"

const KEY_FIELDS = ["cnic", "ntn", "secp", "phone"] as const
type KeyName = (typeof KEY_FIELDS)[number]

/** One `entity_links` row (per key), with its state resolved at read time. */
export type LinkRow = { id: string; leftId: string; rightId: string; key: KeyName; confirmed: boolean }

/** A registry row before it is tailored to a subject (link state and relied-on links depend on the subject). */
export type BaseCandidate = Omit<Candidate, "linkState" | "linkIds"> & { linkState: "none"; linkIds: [] }

export type Registry = {
  candidates: BaseCandidate[]
  links: LinkRow[]
  firmMap: Map<string, string[]>
  l17_2Enabled: boolean
}

const PRIVILEGED_RESTRICTED: Classification = "privileged-restricted"

/** An unreadable classification counts as the highest rank (monotonic, fail closed). */
export const knownOrHighest = (raw: unknown): Classification => (isKnownClassification(raw) ? raw : PRIVILEGED_RESTRICTED)

/** The higher of two labels (each read with knownOrHighest, so an unknown one wins). */
export function maxLabel(a: unknown, b: unknown): Classification {
  const x = knownOrHighest(a)
  const y = knownOrHighest(b)
  return rankOf(y) > rankOf(x) ? y : x
}

/**
 * L18 §7.1: confirmed = human-confirmed, or a candidate auto-confirmed 30 days after creation
 * without dispute (effectiveLinkState). With L17_2_ENABLED off every key link counts as a candidate (P2-18).
 */
export function linkConfirmed(row: DocumentData, nowMs: number, l17_2Enabled: boolean): boolean {
  return isConfirmedState(effectiveLinkState(row, nowMs, l17_2Enabled))
}

/**
 * Whether layer L17.2 (entity resolution) is on for the firm. Resolution order, as
 * platform/flags/featureFlags.ts: env `SIKANDER_FLAG_L17_2_ENABLED` = "true" | "false", then the
 * firm doc's `featureFlags.L17_2_ENABLED` boolean, then the registry default (on,
 * lib/foundation-data.ts). A malformed value or an unreadable firm doc fails toward off, which
 * only makes key matches candidates (more review items, never a CLEAR).
 */
export function l17_2Enabled(firm: DocumentData | undefined, readable = true): boolean {
  const env = process.env.SIKANDER_FLAG_L17_2_ENABLED?.trim().toLowerCase()
  if (env === "true") return true
  if (env === "false") return false
  if (!readable) return false
  const flags: unknown = firm?.featureFlags
  if (flags === undefined || flags === null) return true
  if (typeof flags !== "object") return false
  const value = (flags as Record<string, unknown>).L17_2_ENABLED
  if (value === undefined) return true
  return value === true
}

/** Keys of a client doc in the screening shape. */
export function clientKeys(doc: DocumentData): Keys {
  const keys: Keys = {}
  if (typeof doc.cnic === "string") keys.cnic = doc.cnic
  if (typeof doc.ntn === "string") keys.ntn = doc.ntn
  if (typeof doc.secpNumber === "string") keys.secp = doc.secpNumber
  if (typeof doc.primaryMobile === "string") keys.phone = doc.primaryMobile
  return keys
}

function partyKeys(raw: unknown): Keys {
  const keys: Keys = {}
  if (raw === null || typeof raw !== "object") return keys
  for (const k of KEY_FIELDS) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === "string" && v !== "") keys[k] = v
  }
  return keys
}

const isKeyName = (v: unknown): v is KeyName => typeof v === "string" && (KEY_FIELDS as readonly string[]).includes(v)

/** One stored row: its document id and data. */
export type Row = { id: string; data: DocumentData }

/** `entity_links` rows for screening, resolved at `nowMs`, in the order given. */
export function linkRowsOf(rows: readonly Row[], nowMs: number, enabled: boolean): LinkRow[] {
  const links: LinkRow[] = []
  for (const { id, data: row } of rows) {
    if (typeof row.leftId !== "string" || typeof row.rightId !== "string" || !isKeyName(row.key)) continue
    const state = effectiveLinkState(row, nowMs, enabled)
    // P2-29: a rejected pair is neither relied on nor unresolved (with the flag off nothing reads as rejected).
    if (state === "rejected") continue
    links.push({ id, leftId: row.leftId, rightId: row.rightId, key: row.key, confirmed: isConfirmedState(state) })
  }
  return links
}

const rowsOf = (snap: QuerySnapshot): Row[] => snap.docs.map((d) => ({ id: d.id, data: d.data() }))

/** `entity_links` rows for screening, resolved at `nowMs` (shared by loadRegistry and transactional re-reads). */
export function linkRowsFromSnap(linkSnap: QuerySnapshot, nowMs: number, enabled: boolean): LinkRow[] {
  return linkRowsOf(rowsOf(linkSnap), nowMs, enabled)
}

/** The firm's transliteration map (`transliteration_map` rows): script → Roman spellings, rows merged in the order given. */
export function firmMapOf(rows: readonly Row[]): Map<string, string[]> {
  const firmMap = new Map<string, string[]>()
  for (const { data } of rows) {
    const { script, roman } = data
    if (typeof script !== "string" || script === "" || !Array.isArray(roman)) continue
    const spellings = roman.filter((r): r is string => typeof r === "string" && r.trim() !== "")
    if (spellings.length > 0) firmMap.set(script, [...(firmMap.get(script) ?? []), ...spellings])
  }
  return firmMap
}

/** The firm doc read for the L17.2 flag: `ok: false` when the read failed (the flag then fails toward off). */
export type FirmRead = { ok: boolean; data: DocumentData | undefined }

/** The firm doc for the L17.2 flag; a failed read is logged and returned as `ok: false`, never thrown. */
export async function readFirmForFlag(firmId: string): Promise<FirmRead> {
  return adminDb()
    .collection("firms")
    .doc(firmId)
    .get()
    .then((s): FirmRead => ({ ok: true, data: s.data() }))
    .catch((err: unknown): FirmRead => {
      logFailure("conflict flag read failed", err)
      return { ok: false, data: undefined }
    })
}

/**
 * The rows a registry is built from. Each list must be in document-id order (the order a Firestore query
 * with equality filters only returns), so candidates, links and therefore hits keep one order whether the
 * rows came from the full scan or from the candidate loader (F37). `parties` are opposing parties only.
 */
export type RegistryRows = {
  firm: FirmRead
  clients: readonly Row[]
  matters: readonly Row[]
  parties: readonly Row[]
  links: readonly Row[]
  maps: readonly Row[]
}

/**
 * The firm's whole registry for screening, read at `now`: every client, matter, opposing party, entity
 * link and transliteration row. Since F37 no production path calls it (screens use the candidate loader,
 * `candidates.ts`); it is the full-scan oracle the recall tests compare against, and the reference for
 * what a screen reads (`REGISTRY_SCOPE`).
 */
export async function loadRegistry(firmId: string, now: Date): Promise<Registry> {
  const db = adminDb()
  const byFirm = (name: string) => db.collection(name).where("firmId", "==", firmId).get()
  const [firm, clientSnap, matterSnap, partySnap, linkSnap, mapSnap] = await Promise.all([
    readFirmForFlag(firmId),
    byFirm("clients"),
    byFirm("matters"),
    db.collection("matter_parties").where("firmId", "==", firmId).where("role", "==", "opposing").get(),
    byFirm("entity_links"),
    byFirm("transliteration_map"),
  ])
  return buildRegistry(
    { firm, clients: rowsOf(clientSnap), matters: rowsOf(matterSnap), parties: rowsOf(partySnap), links: rowsOf(linkSnap), maps: rowsOf(mapSnap) },
    now
  )
}

/**
 * Builds the screening registry from its rows (pure). One candidate per (client, matter), or per client
 * with no matter, and one per opposing party; each candidate's link state starts at "none" (tailor decides
 * it per subject). A candidate needs only its own rows: a client's matters, a party's matter, and the
 * links touching its entity, so a subset of the firm's rows that holds those for every candidate it
 * contains builds exactly those candidates of the full registry, in the same order.
 */
export function buildRegistry(rows: RegistryRows, now: Date): Registry {
  const enabled = l17_2Enabled(rows.firm.data, rows.firm.ok)
  const nowMs = now.getTime()
  const firmMap = firmMapOf(rows.maps)

  const links = linkRowsOf(rows.links, nowMs, enabled)
  const unresolvedByEntity = new Map<string, string[]>()
  for (const l of links) {
    if (l.confirmed) continue
    for (const e of [l.leftId, l.rightId]) unresolvedByEntity.set(e, [...(unresolvedByEntity.get(e) ?? []), l.id])
  }
  const unresolvedOf = (entityId: string | undefined) => (entityId ? [...new Set(unresolvedByEntity.get(entityId) ?? [])] : [])

  type MatterInfo = { matterNo: string | null; classification: string; status: "live" | "closed"; clientId: unknown }
  const matters = new Map<string, MatterInfo>()
  for (const d of rows.matters) {
    const m = d.data
    matters.set(d.id, {
      matterNo: typeof m.matterNo === "string" ? m.matterNo : null,
      classification: knownOrHighest(m.classification),
      // engagement_unconfirmed and live are both open matters; only "closed" is closed.
      status: m.status === "closed" ? "closed" : "live",
      clientId: m.clientId,
    })
  }

  // Each client's matters, grouped once (not a scan of every matter per client).
  const mattersByClient = new Map<string, Array<[string, MatterInfo]>>()
  for (const entry of matters.entries()) {
    const clientId = entry[1].clientId
    if (typeof clientId !== "string") continue
    const list = mattersByClient.get(clientId)
    if (list) list.push(entry)
    else mattersByClient.set(clientId, [entry])
  }

  const candidates: BaseCandidate[] = []
  for (const d of rows.clients) {
    const c = d.data
    if (typeof c.canonicalName !== "string") continue
    const own = mattersByClient.get(d.id) ?? []
    const clientClass = knownOrHighest(c.classification)
    const base = {
      candidateId: `client:${d.id}`,
      role: "client" as const,
      name: c.canonicalName,
      forms: nameForms(c.canonicalName, firmMap),
      keys: clientKeys(c),
      ...(typeof c.entityId === "string" && c.entityId !== "" ? { entityId: c.entityId } : {}),
      clientHasLiveMatter: own.some(([, m]) => m.status !== "closed"),
      linkState: "none" as const,
      linkIds: [] as [],
      unresolvedLinkIds: unresolvedOf(c.entityId),
    }
    if (own.length === 0) {
      // A client with no matter yet: the hit names no matter; the client's own label stands in.
      candidates.push({ ...base, matterId: null, matterNo: null, matterClassification: clientClass, matterStatus: null })
      continue
    }
    // One candidate per matter, so every matter the hit touches is reported (and classifies the check).
    // The hit is classified at the higher of the matter's and the client record's label (L17.3 #20, monotonic).
    for (const [matterId, m] of own) {
      candidates.push({ ...base, matterId, matterNo: m.matterNo, matterClassification: maxLabel(m.classification, clientClass), matterStatus: m.status })
    }
  }

  for (const d of rows.parties) {
    const p = d.data
    if (typeof p.name !== "string") continue
    const matterId = typeof p.matterId === "string" && p.matterId !== "" ? p.matterId : null
    const matter = matterId ? matters.get(matterId) : undefined
    const entityId = typeof p.entityId === "string" && p.entityId !== "" ? p.entityId : undefined
    candidates.push({
      candidateId: `party:${d.id}`,
      role: "opposing",
      name: p.name,
      forms: nameForms(p.name, firmMap),
      keys: partyKeys(p.keys),
      ...(entityId ? { entityId } : {}),
      matterId,
      matterNo: matter?.matterNo ?? null,
      // O-27 (P2-37): the higher of the matter's and the party row's label, as client candidates are;
      // an absent or unknown label reads as privileged-restricted (fail closed).
      matterClassification: matter ? maxLabel(matter.classification, p.classification) : maxLabel(p.matterClassification, p.classification),
      matterStatus: matter ? matter.status : p.matterStatus === "closed" ? "closed" : matterId ? "live" : null,
      clientHasLiveMatter: false,
      linkState: "none",
      linkIds: [],
      unresolvedLinkIds: unresolvedOf(entityId),
    })
  }

  return { candidates, links, firmMap, l17_2Enabled: enabled }
}

/**
 * The candidates as seen from one subject. For each candidate, the keys equal to the subject's
 * decide which links count: a link on a matched key K between the candidate's entity and the
 * subject's entity. linkState is "confirmed" iff one of those links is confirmed (only when the
 * subject has an entity id: a confirmed link between other entities does not confirm an unnamed
 * opposing party), else "candidate" (an equal key without any link row is still a candidate identity);
 * "none" when no key is equal. Unresolved links of the subject's own entity whose other end is
 * the candidate's entity are attached to that candidate (P2-5, forensic test 3).
 */
export function tailor(registry: Registry, subject: Subject, subjectEntityId: string | undefined): Candidate[] {
  const subjectUnresolved = subjectEntityId
    ? registry.links.filter((l) => !l.confirmed && (l.leftId === subjectEntityId || l.rightId === subjectEntityId))
    : []
  return registry.candidates.map((c): Candidate => {
    const matched = KEY_FIELDS.filter((k) => !!subject.keys[k] && subject.keys[k] === c.keys[k])
    const unresolved = new Set(c.unresolvedLinkIds)
    if (c.entityId) {
      for (const l of subjectUnresolved) if (l.leftId === c.entityId || l.rightId === c.entityId) unresolved.add(l.id)
    }
    if (matched.length === 0) return { ...c, linkState: "none", linkIds: [], unresolvedLinkIds: [...unresolved] }
    const relied =
      c.entityId && subjectEntityId
        ? registry.links.filter((l) => {
            if (!matched.includes(l.key)) return false
            if (l.leftId !== c.entityId && l.rightId !== c.entityId) return false
            const other = l.leftId === c.entityId ? l.rightId : l.leftId
            return other === subjectEntityId
          })
        : []
    return {
      ...c,
      linkState: relied.some((l) => l.confirmed) ? "confirmed" : "candidate",
      linkIds: relied.map((l) => l.id),
      unresolvedLinkIds: [...unresolved],
    }
  })
}

export type EngineResult = { hits: Hit[]; result: Outcome; identityBasis: IdentityBasis; classification: Classification }

/** Conflict checks are confidential unless a hit touches a higher-classified matter (P2-13, monotonic). */
export function checkClassification(hits: readonly Hit[]): Classification {
  let label: Classification = "confidential"
  // Invariant: the label is >= matterClassification of EVERY stored hit (NONE too), since stored hits keep matter ids readable by partners cleared to it.
  for (const h of hits) {
    const c = knownOrHighest(h.matterClassification)
    if (rankOf(c) > rankOf(label)) label = c
  }
  return label
}

/**
 * Screens every subject against the registry. `subjectEntityIds[i]` is the entity of a
 * `client: { clientId }` subject. Each subject is screened against its own tailored candidates;
 * the hits are merged in subject order and summarised once.
 */
export function runEngine(registry: Registry, subjects: Subject[], subjectEntityIds: (string | undefined)[]): EngineResult {
  const hits: Hit[] = []
  subjects.forEach((subject, i) => {
    const entityId = subjectEntityIds[i]
    const r = screen([subject], [nameForms(subject.name, registry.firmMap)], tailor(registry, subject, entityId), {
      subjectFallback: [usesFallback(subject.name, registry.firmMap)],
      subjectEntityIds: [entityId],
    })
    for (const h of r.hits) hits.push({ ...h, subjectIndex: i })
  })
  return { hits, ...summarise(hits), classification: checkClassification(hits) }
}

/** A hit's identity for the re-screen at open: subject, conflict type and registry candidate. */
const hitIdentity = (h: Hit): string => `${h.subjectIndex}|${h.type}|${h.candidateId ?? ""}`

/**
 * The hits of a fresh screen that a stored check does not account for (spec P2-6, final review I5):
 * non-NONE fresh hits whose (subject, type, candidate) is not among the stored non-NONE or
 * review-resolved hits. A stored hit without a candidate id matches nothing (fails toward stale).
 */
const OUTCOME_RANK: Record<Hit["outcome"], number> = { NONE: 0, POSSIBLE_CANDIDATE_REVIEW: 1, FLAG: 2 }

/** How severely a stored hit already accounts for a candidate (resolved NONE still covers review-level matches). */
const storedOutcomeRank = (h: Hit): number =>
  h.outcome === "NONE" && h.review !== undefined ? OUTCOME_RANK.POSSIBLE_CANDIDATE_REVIEW : OUTCOME_RANK[h.outcome]

export function unseenHits(fresh: readonly Hit[], stored: readonly Hit[]): Hit[] {
  const storedRank = new Map<string, number>()
  for (const h of stored) {
    if (h.outcome === "NONE" && h.review === undefined) continue
    const id = hitIdentity(h)
    storedRank.set(id, Math.max(storedRank.get(id) ?? 0, storedOutcomeRank(h)))
  }
  return fresh.filter((h) => {
    if (h.outcome === "NONE") return false
    const id = hitIdentity(h)
    const prev = storedRank.get(id)
    return prev === undefined || OUTCOME_RANK[h.outcome] > prev
  })
}
