import { logger } from "firebase-functions"
import { FieldPath, Timestamp, type DocumentData, type DocumentSnapshot, type Query } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { rankOf } from "../../p5/classification"
import { isSafeDocId, type Data, type FirmOperation } from "../../p5/common"
import { requirePermission } from "../../p5/permission"
import { knownOrHighest, maxLabel } from "../conflict/engine"
import { decodeCursor, encodeCursor, parsePage, type Page } from "../pagination"
import { requireL17_2 } from "./flag"
import { LINK_AUTO_CONFIRM_MS, autoConfirmAt, effectiveLinkState, isConfirmedState, pairIdOf, type EffectiveLinkState } from "./linkState"
import { clientOfEntity, entityKeys, entitySummary, type ClientRef, type EntitySummary } from "./summary"

/**
 * The read routes of the L17.2 entity review (spec P2-31, P2-32, P2-34): listReviewQueue,
 * getEntity, listAliases. All three are `entity.review` (partner, associate), then the L17.2 gate
 * (404 feature_disabled). A row or entity above the caller's clearance is omitted (lists) or
 * 404 not_found (the addressed entity), as is a missing or other-firm one: existence is never revealed.
 */

const entities = () => adminDb().collection("entities")
const links = () => adminDb().collection("entity_links")

export type QueueItem = {
  pairId: string
  linkIds: string[]
  keys: string[]
  effectiveState: "candidate" | "disputed"
  createdAt: string
  autoConfirmAt: string | null
  classification: string
  dispute?: { by: string; at: string; note: string }
  left: EntitySummary
  right: EntitySummary
}

export type EntityLinkView = {
  pairId: string
  linkIds: string[]
  otherEntityId: string
  otherCanonicalName: string
  keys: string[]
  effectiveState: EffectiveLinkState
  autoConfirmAt: string | null
  mergeEventId: string | null
}

export type EntityView = EntitySummary & { classification: string; createdAt: string | null; links: EntityLinkView[] }

export type Alias = { kind: string; value: string; source: "entity" | "client" | "alias" | "confirmed_link"; entityId: string }

/** listAliases returns at most this many variants (P2-32). */
export const MAX_ALIASES = 200

const KEY_ORDER = ["cnic", "ntn", "secp", "phone"]
const SCAN_BATCH = 100

/** An unknown label counts as the highest rank (fail closed). */
const withinClearance = (raw: unknown, clearance: Classification): boolean => rankOf(knownOrHighest(raw)) <= rankOf(clearance)

const iso = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null)

const sortKeys = (keys: Iterable<string>): string[] =>
  [...new Set(keys)].sort((x, y) => {
    const [i, j] = [KEY_ORDER.indexOf(x), KEY_ORDER.indexOf(y)]
    return i === j ? (x < y ? -1 : x > y ? 1 : 0) : (i === -1 ? KEY_ORDER.length : i) - (j === -1 ? KEY_ORDER.length : j)
  })

/** The permission and layer gates every entity read starts with. */
async function gate(caller: Caller): Promise<void> {
  await requirePermission(caller, "entity.review")
  await requireL17_2(caller.firmId)
}

function parseEntityId(value: unknown): string {
  if (!isSafeDocId(value)) throw new HttpError(400, "invalid_query")
  return value
}

/** An entity of the caller's firm within the caller's clearance, or undefined. */
async function readableEntity(caller: Caller, entityId: string): Promise<DocumentData | undefined> {
  const row = (await entities().doc(entityId).get()).data()
  if (!row || row.firmId !== caller.firmId || !withinClearance(row.classification, caller.clearanceLevel)) return undefined
  return row
}

/** The client of an entity if the caller is cleared to see it (a hidden client reads as none). */
async function readableClient(caller: Caller, entityId: string): Promise<ClientRef | undefined> {
  const client = await clientOfEntity(caller.firmId, entityId)
  return client && withinClearance(client.row.classification, caller.clearanceLevel) ? client : undefined
}

/**
 * The summary of an entity for a list, or null when the entity or its client is missing from
 * the caller's view (unreadable, other firm or above clearance): the whole pair is then skipped.
 */
async function summaryFor(caller: Caller, entityId: string, cache: Map<string, { summary: EntitySummary; label: Classification } | null>) {
  if (cache.has(entityId)) return cache.get(entityId)!
  let result: { summary: EntitySummary; label: Classification } | null = null
  const row = isSafeDocId(entityId) ? await readableEntity(caller, entityId) : undefined
  if (row) {
    const client = await clientOfEntity(caller.firmId, entityId)
    if (!client || withinClearance(client.row.classification, caller.clearanceLevel)) {
      result = { summary: entitySummary(entityId, row, client), label: client ? maxLabel(row.classification, client.row.classification) : knownOrHighest(row.classification) }
    }
  }
  cache.set(entityId, result)
  return result
}

const earliest = (rows: DocumentData[]): Timestamp | null =>
  rows.reduce<Timestamp | null>((min, r) => (r.createdAt instanceof Timestamp && (min === null || r.createdAt.toMillis() < min.toMillis()) ? r.createdAt : min), null)

function earliestAutoConfirm(rows: DocumentData[]): string | null {
  const times = rows.map((r) => autoConfirmAt(r)).filter((d): d is Date => d !== null)
  if (times.length === 0) return null
  return new Date(Math.min(...times.map((d) => d.getTime()))).toISOString()
}

function disputeOf(rows: DocumentData[]): QueueItem["dispute"] | undefined {
  for (const r of rows) {
    const d: unknown = r.dispute
    if (d !== null && typeof d === "object") {
      const { by, at, note } = d as Record<string, unknown>
      return { by: typeof by === "string" ? by : "", at: iso(at) ?? "", note: typeof note === "string" ? note : "" }
    }
  }
  return undefined
}

function parseQueueCursor(cursor: string | null): { createdAt: Timestamp; id: string } | null {
  if (cursor === null) return null
  const { sortKey, id } = decodeCursor(cursor)
  const [seconds, nanos] = sortKey.split(".").map(Number)
  if (!Number.isInteger(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9 || !isSafeDocId(id)) {
    throw new HttpError(400, "invalid_cursor")
  }
  return { createdAt: new Timestamp(seconds, nanos), id }
}

type Group = { pairId: string; leftId: string; rightId: string; ids: string[]; rows: DocumentData[] }

/**
 * listReviewQueue(?view=pending|disputed&limit=&cursor=) → { items, nextCursor } (P2-31): one item
 * per entity pair of undecided candidate links, oldest first (createdAt asc, then doc id asc).
 * `pending` (default): undisputed candidates younger than 30 days (auto-confirmed rows are never
 * scanned); `disputed`: disputed candidates. Rows above the caller's clearance are skipped, and a
 * pair with such a row, or whose entity or client the caller cannot see, is left out. A page holds
 * `limit` pairs and finishes the last pair's adjacent rows; the cursor is the last row consumed.
 */
export const listReviewQueueOp: FirmOperation<Page<QueueItem>> = {
  auth: "firm",
  kind: "general",
  action: "entity.review",
  target: "entity_links",
  run: async ({ caller, now: clock }, data: Data, audit) => {
    audit.firmId = caller.firmId
    // The call's own row names the firm's link collection (the permission decision row names the firm).
    audit.target = `firms/${caller.firmId}/entity_links`
    await gate(caller)
    const view = data.view === undefined ? "pending" : data.view
    if (view !== "pending" && view !== "disputed") throw new HttpError(400, "invalid_query")
    const { limit, cursor } = parsePage(data)
    const start = parseQueueCursor(cursor)
    const nowMs = clock ?? Date.now()
    const disputed = view === "disputed"

    const groups = new Map<string, Group>()
    const hidden = new Set<string>()
    const cache = new Map<string, { summary: EntitySummary; label: Classification } | null>()
    const items = new Map<string, Omit<QueueItem, "pairId" | "linkIds" | "keys" | "createdAt" | "autoConfirmAt" | "classification" | "dispute">>()
    let lastConsumed: { createdAt: Timestamp; id: string } | null = null
    let after: DocumentSnapshot | null = null
    let more = false
    for (;;) {
      let q: Query = links().where("firmId", "==", caller.firmId).where("state", "==", "candidate").where("disputed", "==", disputed)
      if (!disputed) q = q.where("createdAt", ">", Timestamp.fromMillis(nowMs - LINK_AUTO_CONFIRM_MS))
      q = q.orderBy("createdAt", "asc").orderBy(FieldPath.documentId(), "asc")
      if (after) q = q.startAfter(after)
      else if (start) q = q.startAfter(start.createdAt, start.id)
      const snap = await q.limit(SCAN_BATCH).get()
      for (const doc of snap.docs) {
        const row = doc.data()
        const pairId = pairIdOf(row)
        const known = groups.has(pairId) || hidden.has(pairId)
        // A new pair after `limit` pairs ends the page; rows of pairs already met are consumed.
        if (!known && groups.size === limit) {
          more = true
          break
        }
        if (row.createdAt instanceof Timestamp) lastConsumed = { createdAt: row.createdAt, id: doc.id }
        if (hidden.has(pairId)) continue
        if (!withinClearance(row.classification, caller.clearanceLevel) || !(row.createdAt instanceof Timestamp)) {
          hidden.add(pairId)
          groups.delete(pairId)
          items.delete(pairId)
          continue
        }
        const group = groups.get(pairId)
        if (group) {
          group.ids.push(doc.id)
          group.rows.push(row)
          continue
        }
        const leftId = String(row.leftId)
        const rightId = String(row.rightId)
        const [left, right] = [await summaryFor(caller, leftId, cache), await summaryFor(caller, rightId, cache)]
        if (!left || !right) {
          hidden.add(pairId)
          continue
        }
        groups.set(pairId, { pairId, leftId, rightId, ids: [doc.id], rows: [row] })
        items.set(pairId, { effectiveState: disputed ? "disputed" : "candidate", left: left.summary, right: right.summary })
      }
      if (more || snap.size < SCAN_BATCH) break
      after = snap.docs[snap.docs.length - 1]
    }

    await audit.allow()
    const out: QueueItem[] = []
    for (const group of groups.values()) {
      const base = items.get(group.pairId)!
      const label = [cache.get(group.leftId)?.label, cache.get(group.rightId)?.label, ...group.rows.map((r) => r.classification)].reduce<Classification>(
        (acc, l) => maxLabel(acc, l),
        "public"
      )
      const dispute = disputeOf(group.rows)
      out.push({
        pairId: group.pairId,
        linkIds: [...group.ids].sort(),
        keys: sortKeys(group.rows.map((r) => String(r.key))),
        effectiveState: base.effectiveState,
        createdAt: iso(earliest(group.rows)) ?? "",
        autoConfirmAt: disputed ? null : earliestAutoConfirm(group.rows),
        classification: label,
        ...(dispute ? { dispute } : {}),
        left: base.left,
        right: base.right,
      })
    }
    return {
      items: out,
      nextCursor: more && lastConsumed ? encodeCursor(`${lastConsumed.createdAt.seconds}.${lastConsumed.createdAt.nanoseconds}`, lastConsumed.id) : null,
    }
  },
}

/** Unresolved states win when a pair's rows disagree (fail toward review). */
const PAIR_STATE_PRECEDENCE: readonly EffectiveLinkState[] = ["disputed", "candidate", "rejected", "auto_confirmed", "confirmed"]

type PairView = EntityLinkView & { otherRow: DocumentData }

/**
 * The pairs `entityId` belongs to, as the caller may see them: every `entity_links` row with
 * leftId or rightId = entityId (two queries), grouped by pair. A pair is left out when any of its
 * rows, or the other entity, is above the caller's clearance (or the other entity is missing or in
 * another firm). Sorted by pairId.
 */
async function pairsOf(caller: Caller, entityId: string, nowMs: number): Promise<PairView[]> {
  const byFirm = links().where("firmId", "==", caller.firmId)
  const [asLeft, asRight] = await Promise.all([byFirm.where("leftId", "==", entityId).get(), byFirm.where("rightId", "==", entityId).get()])
  const groups = new Map<string, Array<{ id: string; row: DocumentData }>>()
  for (const doc of [...asLeft.docs, ...asRight.docs]) {
    const row = doc.data()
    const pairId = pairIdOf(row)
    const list = groups.get(pairId) ?? []
    if (!list.some((r) => r.id === doc.id)) list.push({ id: doc.id, row })
    groups.set(pairId, list)
  }
  const out: PairView[] = []
  for (const [pairId, rows] of [...groups.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (!rows.every(({ row }) => withinClearance(row.classification, caller.clearanceLevel))) continue
    const first = rows[0].row
    const otherEntityId = first.leftId === entityId ? first.rightId : first.leftId
    if (!isSafeDocId(otherEntityId)) continue
    const otherRow = await readableEntity(caller, otherEntityId)
    if (!otherRow) continue
    const states = new Set(rows.map(({ row }) => effectiveLinkState(row, nowMs, true)))
    const effectiveState = PAIR_STATE_PRECEDENCE.find((s) => states.has(s)) ?? "candidate"
    const mergeEventId = rows
      .map(({ row }) => (row.confirmation !== null && typeof row.confirmation === "object" ? (row.confirmation as Record<string, unknown>).mergeEventId : undefined))
      .find((m): m is string => typeof m === "string")
    out.push({
      pairId,
      linkIds: rows.map((r) => r.id).sort(),
      otherEntityId,
      otherCanonicalName: typeof otherRow.canonicalName === "string" ? otherRow.canonicalName : "",
      keys: sortKeys(rows.map(({ row }) => String(row.key))),
      effectiveState,
      autoConfirmAt: effectiveState === "candidate" || effectiveState === "auto_confirmed" ? earliestAutoConfirm(rows.map((r) => r.row)) : null,
      mergeEventId: mergeEventId ?? null,
      otherRow,
    })
  }
  return out
}

/** The addressed entity in the caller's firm and clearance, else 404 not_found. */
async function addressedEntity(caller: Caller, entityId: string): Promise<DocumentData> {
  const row = await readableEntity(caller, entityId)
  if (!row) throw new HttpError(404, "not_found")
  return row
}

/**
 * getEntity(?entityId=) → the entity (summary, classification, createdAt) with its links (P2-32):
 * one EntityLinkView per pair, state from effectiveLinkState, links above clearance omitted.
 */
export const getEntityOp: FirmOperation<EntityView> = {
  auth: "firm",
  kind: "general",
  action: "entity.review",
  target: "entities",
  run: async ({ caller, now: clock }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await gate(caller)
    const entityId = parseEntityId(data.entityId)
    audit.target = `entities/${entityId}`
    const row = await addressedEntity(caller, entityId)
    const client = await readableClient(caller, entityId)
    const pairs = await pairsOf(caller, entityId, clock ?? Date.now())
    await audit.allow()
    return {
      ...entitySummary(entityId, row, client),
      classification: knownOrHighest(row.classification),
      createdAt: iso(row.createdAt),
      links: pairs.map(({ otherRow: _other, ...view }) => view),
    }
  },
}

const keyAliases = (row: DocumentData, source: Alias["source"], entityId: string): Alias[] => {
  const keys = entityKeys(row)
  const out: Alias[] = []
  if (typeof row.canonicalName === "string" && row.canonicalName !== "") out.push({ kind: "name", value: row.canonicalName, source, entityId })
  for (const key of KEY_ORDER) {
    const value = keys[key as keyof typeof keys]
    if (value !== undefined) out.push({ kind: key, value, source, entityId })
  }
  return out
}

/**
 * listAliases(?entityId=) → { items, nextCursor: null } (P2-32, L6957 "all known variants"): the
 * entity's name and keys, its client's alternateMobile, its `entity_aliases` rows within
 * clearance, then the names and keys of the entities joined by an effectively confirmed link
 * (confirmed or auto-confirmed; candidate, disputed and rejected links are never aliases).
 * Deduplicated on (kind, value), first occurrence kept; at most 200.
 */
export const listAliasesOp: FirmOperation<{ items: Alias[]; nextCursor: null }> = {
  auth: "firm",
  kind: "general",
  action: "entity.review",
  target: "entities",
  run: async ({ caller, now: clock }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await gate(caller)
    const entityId = parseEntityId(data.entityId)
    audit.target = `entities/${entityId}`
    const row = await addressedEntity(caller, entityId)
    const client = await readableClient(caller, entityId)
    const aliasSnap = await adminDb().collection("entity_aliases").where("firmId", "==", caller.firmId).where("entityId", "==", entityId).get()
    const pairs = await pairsOf(caller, entityId, clock ?? Date.now())

    const candidates: Alias[] = [...keyAliases(row, "entity", entityId)]
    const alternate: unknown = client?.row.alternateMobile
    if (typeof alternate === "string" && alternate !== "") candidates.push({ kind: "phone", value: alternate, source: "client", entityId })
    for (const doc of [...aliasSnap.docs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
      const a = doc.data()
      if (!withinClearance(a.classification, caller.clearanceLevel)) continue
      if (typeof a.kind !== "string" || a.kind === "" || typeof a.value !== "string" || a.value === "") continue
      candidates.push({ kind: a.kind, value: a.value, source: "alias", entityId })
    }
    for (const pair of pairs) {
      if (!isConfirmedState(pair.effectiveState)) continue
      candidates.push(...keyAliases(pair.otherRow, "confirmed_link", pair.otherEntityId))
    }

    const seen = new Set<string>()
    const items: Alias[] = []
    for (const alias of candidates) {
      const k = `${alias.kind}\u0000${alias.value}`
      if (seen.has(k)) continue
      seen.add(k)
      if (items.length === MAX_ALIASES) {
        // P2-32: a pathological entity truncates at 200 (ids only, no alias values in the log).
        logger.warn("listAliases truncated", { firmId: caller.firmId, entityId, max: MAX_ALIASES })
        break
      }
      items.push(alias)
    }
    await audit.allow()
    return { items, nextCursor: null }
  },
}
