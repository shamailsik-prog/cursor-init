import { FieldPath, FieldValue, Timestamp, type DocumentData, type Query } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import { isKnownClassification, rankOf } from "../../p5/classification"
import { isSafeDocId, type Data, type FirmOperation } from "../../p5/common"
import { requirePermission } from "../../p5/permission"
import { normalisePhone } from "../conflict/normalise"
import { allocateNumber, formatClientCode, karachiYear, readPrefixes } from "../numbering"
import { decodeCursor, encodeCursor, parsePage, type Page } from "../pagination"
import { parseKeys, parseName, type Keys } from "../validate"

const clients = () => adminDb().collection("clients")
const entities = () => adminDb().collection("entities")

const CLIENT_TYPES = ["individual", "company", "government"] as const
type ClientType = (typeof CLIENT_TYPES)[number]
type KeyName = keyof Keys
/** Entity field holding each key. */
const ENTITY_FIELD: Record<KeyName, string> = { cnic: "cnic", ntn: "ntn", secp: "secpNumber", phone: "phone" }
const KEY_ORDER: readonly KeyName[] = ["cnic", "ntn", "secp", "phone"]

const invalid = () => new HttpError(400, "invalid_subjects")

/** An optional free-text field: absent or blank is omitted; otherwise a trimmed string of at most `max` characters. */
function optionalText(value: unknown, max = 500): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw invalid()
  const text = value.trim()
  if (text === "") return undefined
  if (text.length > max) throw invalid()
  return text
}

function parseType(value: unknown): ClientType {
  if (typeof value !== "string" || !(CLIENT_TYPES as readonly string[]).includes(value)) throw invalid()
  return value as ClientType
}

/** The classification a client is registered at: a known label no higher than the caller's clearance. */
function parseClassification(value: unknown, clearance: Classification): Classification {
  if (!isKnownClassification(value)) throw invalid()
  if (rankOf(value) > rankOf(clearance)) throw new HttpError(403, "exceeds_own_clearance")
  return value
}

const withinClearance = (raw: unknown, clearance: Classification): boolean =>
  isKnownClassification(raw) && rankOf(raw) <= rankOf(clearance)

const iso = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null)

/** The client document as returned by the read routes. */
function present(id: string, doc: DocumentData): Record<string, unknown> {
  const { createdAt, ...rest } = doc
  return { clientId: id, ...rest, createdAt: iso(createdAt) }
}

export type RegisterResult = {
  clientId: string
  clientCode: string
  entityId: string
  possibleDuplicates: Array<{ clientId: string; clientCode: string; key: KeyName }>
}

/**
 * registerClient({ name, type, primaryMobile, classification, companyName?, reference?, alternateMobile?,
 * concernedPersonName?, email?, cnic?, ntn?, secpNumber?, address?, corporateGroup? }). One transaction
 * allocates the client code, writes the `entities` and `clients` rows and, for every other firm entity
 * sharing an exact normalised key, a candidate `entity_links` row per matching key (L18 §7.1).
 */
export const registerClientOp: FirmOperation<RegisterResult> = {
  auth: "firm",
  kind: "general",
  action: "client.register",
  target: "clients",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "client.register")

    const classification = parseClassification(data.classification, caller.clearanceLevel)
    const canonicalName = parseName(data.name)
    const type = parseType(data.type)
    const companyName = optionalText(data.companyName, 200)
    if (type === "company" && companyName === undefined) throw invalid()
    const keys = parseKeys({ cnic: data.cnic, ntn: data.ntn, secp: data.secpNumber, phone: data.primaryMobile })
    if (keys.phone === undefined) throw invalid() // primaryMobile is required
    const alternateRaw = optionalText(data.alternateMobile, 50)
    const alternateMobile = alternateRaw === undefined ? undefined : normalisePhone(alternateRaw)
    if (alternateRaw !== undefined && alternateMobile === null) throw invalid()
    const email = optionalText(data.email, 254)
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid()
    const optional = {
      companyName,
      reference: optionalText(data.reference),
      alternateMobile: alternateMobile ?? undefined,
      concernedPersonName: optionalText(data.concernedPersonName, 200),
      email,
      address: optionalText(data.address),
      corporateGroup: optionalText(data.corporateGroup, 200),
    }

    const now = new Date()
    const db = adminDb()
    const entityRef = entities().doc()
    const clientRef = clients().doc()
    audit.target = `clients/${clientRef.id}`

    const result = await db.runTransaction(async (tx) => {
      // Reads first: prefixes, entities sharing a key, the clients of those entities, then the counter.
      const { clientPrefix } = await readPrefixes(tx, caller.firmId)
      const matched = new Map<string, KeyName[]>()
      const matchedClass = new Map<string, Classification>()
      for (const key of KEY_ORDER) {
        const value = keys[key]
        if (value === undefined) continue
        const snap = await tx.get(entities().where("firmId", "==", caller.firmId).where(ENTITY_FIELD[key], "==", value))
        for (const doc of snap.docs) {
          matched.set(doc.id, [...(matched.get(doc.id) ?? []), key])
          // Monotonic classification (P2-13): an unreadable label counts as the highest rank.
          const raw = doc.data().classification
          matchedClass.set(doc.id, isKnownClassification(raw) ? raw : "privileged-restricted")
        }
      }
      const duplicates: RegisterResult["possibleDuplicates"] = []
      for (const [entityId, matchedKeys] of matched) {
        const owner = await tx.get(clients().where("firmId", "==", caller.firmId).where("entityId", "==", entityId).limit(1))
        const row = owner.docs[0]
        // A duplicate is reported only for a client the caller is cleared to see; the link is written regardless.
        if (!row || !withinClearance(row.data().classification, caller.clearanceLevel)) continue
        for (const key of matchedKeys) duplicates.push({ clientId: row.id, clientCode: String(row.data().clientCode), key })
      }
      const n = await allocateNumber(tx, caller.firmId, "client", now)
      const clientCode = formatClientCode(clientPrefix, karachiYear(now), n)

      await audit.stage(tx, "allow", "ok")
      tx.create(entityRef, {
        firmId: caller.firmId,
        canonicalName,
        ...(keys.cnic !== undefined ? { cnic: keys.cnic } : {}),
        ...(keys.ntn !== undefined ? { ntn: keys.ntn } : {}),
        ...(keys.secp !== undefined ? { secpNumber: keys.secp } : {}),
        phone: keys.phone,
        classification,
        createdAt: FieldValue.serverTimestamp(),
      })
      tx.create(clientRef, {
        firmId: caller.firmId,
        clientCode,
        entityId: entityRef.id,
        canonicalName,
        type,
        primaryMobile: keys.phone,
        ...(keys.cnic !== undefined ? { cnic: keys.cnic } : {}),
        ...(keys.ntn !== undefined ? { ntn: keys.ntn } : {}),
        ...(keys.secp !== undefined ? { secpNumber: keys.secp } : {}),
        ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
        classification,
        createdBy: caller.uid,
        createdAt: FieldValue.serverTimestamp(),
      })
      for (const [otherId, matchedKeys] of matched) {
        const [a, b] = [entityRef.id, otherId].sort()
        const existing = matchedClass.get(otherId) ?? "privileged-restricted"
        const linkClassification = rankOf(existing) > rankOf(classification) ? existing : classification
        for (const key of matchedKeys) {
          tx.create(db.collection("entity_links").doc(`${caller.firmId}_${a}_${b}_${key}`), {
            firmId: caller.firmId,
            leftId: a,
            rightId: b,
            key,
            state: "candidate",
            disputed: false,
            classification: linkClassification,
            createdAt: FieldValue.serverTimestamp(),
          })
        }
      }
      return { clientId: clientRef.id, clientCode, entityId: entityRef.id, possibleDuplicates: duplicates }
    })
    audit.committed()
    return result
  },
}

/** getClient(?clientId=) → the client. Missing, other firm or above the caller's clearance: 404 not_found. */
export const getClientOp: FirmOperation<Record<string, unknown>> = {
  auth: "firm",
  kind: "general",
  action: "client.read",
  target: "clients",
  run: async ({ caller }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "client.read")
    const clientId = data.clientId
    if (!isSafeDocId(clientId)) throw new HttpError(400, "invalid_query")
    audit.target = `clients/${clientId}`
    const doc = await clients().doc(clientId).get()
    const row = doc.data()
    if (!row || row.firmId !== caller.firmId || !withinClearance(row.classification, caller.clearanceLevel)) {
      throw new HttpError(404, "not_found")
    }
    await audit.allow()
    return present(doc.id, row)
  },
}

const SCAN_BATCH = 100

/**
 * listClients(?limit=&cursor=) → { items, nextCursor }: the firm's clients no higher than the caller's
 * clearance, newest first (createdAt desc, then id desc).
 */
export const listClientsOp: FirmOperation<Page<Record<string, unknown>>> = {
  auth: "firm",
  kind: "general",
  action: "client.read",
  target: "clients",
  run: async ({ caller }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "client.read")
    const { limit, cursor } = parsePage(data)
    let after: { createdAt: Timestamp; id: string } | null = null
    if (cursor !== null) {
      const { sortKey, id } = decodeCursor(cursor)
      const [seconds, nanos] = sortKey.split(".").map(Number)
      if (!Number.isInteger(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9 || !isSafeDocId(id)) {
        throw new HttpError(400, "invalid_cursor")
      }
      try {
        after = { createdAt: new Timestamp(seconds, nanos), id }
      } catch {
        // Seconds outside the Timestamp range.
        throw new HttpError(400, "invalid_cursor")
      }
    }

    const items: Array<{ id: string; row: DocumentData }> = []
    let more = false
    for (;;) {
      let q: Query = clients()
        .where("firmId", "==", caller.firmId)
        .orderBy("createdAt", "desc")
        .orderBy(FieldPath.documentId(), "desc")
      if (after) q = q.startAfter(after.createdAt, after.id)
      const snap = await q.limit(SCAN_BATCH).get()
      for (const doc of snap.docs) {
        if (!withinClearance(doc.data().classification, caller.clearanceLevel)) continue
        if (items.length === limit) {
          more = true
          break
        }
        items.push({ id: doc.id, row: doc.data() })
      }
      if (more || snap.size < SCAN_BATCH) break
      const last = snap.docs[snap.docs.length - 1]
      after = { createdAt: last.data().createdAt as Timestamp, id: last.id }
    }

    await audit.allow()
    const last = items[items.length - 1]
    const lastStamp = last?.row.createdAt as Timestamp | undefined
    return {
      items: items.map(({ id, row }) => present(id, row)),
      nextCursor: more && last && lastStamp ? encodeCursor(`${lastStamp.seconds}.${lastStamp.nanoseconds}`, last.id) : null,
    }
  },
}
