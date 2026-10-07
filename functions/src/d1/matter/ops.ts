import { FieldPath, FieldValue, Timestamp, type DocumentData, type Query, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { decide } from "@/platform/p5/permissionDecision"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { isKnownClassification, rankOf } from "../../p5/classification"
import { isSafeDocId, type Data, type FirmOperation } from "../../p5/common"
import { checkPermission, requirePermission } from "../../p5/permission"
import { nameForms } from "../conflict/normalise"
import type { Subject } from "../conflict/match"
import { allocateNumber, formatMatterNo, karachiYear, readPrefixes } from "../numbering"
import { decodeCursor, encodeCursor, parsePage, type Page } from "../pagination"
import { parseKeys, type Keys } from "../validate"

/**
 * Matters (spec P2-6, P2-11..P2-14, R-2). A matter is opened only on a cleared Module 6 conflict
 * check, which it binds (single use); its number comes from the firm's atomic per-year counter;
 * its stage moves one step at a time and every transition is an immutable `matter_events` row.
 * Membership (`matter_members/{matterId}_{uid}`) is the single source of matter access.
 */

const matters = () => adminDb().collection("matters")
const members = () => adminDb().collection("matter_members")
const parties = () => adminDb().collection("matter_parties")
const checks = () => adminDb().collection("conflict_checks")

export const STAGES = ["pre_filing", "filed", "hearing", "reserved", "decided", "archived"] as const
export type Stage = (typeof STAGES)[number]

/** A check may open a matter for 30 days from its stored (server) createdAt (P2-6). */
export const CHECK_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_TITLE = 300
export const MAX_MEMBERS = 20
export const MIN_CLOSE_REASON = 20
/** Counter contention under parallel opens: more retries than the SDK default of 5. */
const OPEN_TX_ATTEMPTS = 10

const STAFF_ROLES: ReadonlySet<string> = new Set(["partner", "associate", "clerk", "intern"])

const badQuery = () => new HttpError(400, "invalid_query")
const mismatch = () => new HttpError(409, "subjects_mismatch")

const iso = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null)

/** The matter document as the routes return it. */
function present(id: string, doc: DocumentData): Record<string, unknown> {
  const { createdAt, closedAt, ...rest } = doc
  return { matterId: id, ...rest, createdAt: iso(createdAt), ...(closedAt !== undefined ? { closedAt: iso(closedAt) } : {}) }
}

function parseTitle(value: unknown): string {
  if (typeof value !== "string") throw badQuery()
  const title = value.trim()
  if (title.length < 1 || title.length > MAX_TITLE) throw badQuery()
  return title
}

function parseCourtId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw badQuery()
  const courtId = value.trim()
  if (courtId === "") return undefined
  if (courtId.length > 100) throw badQuery()
  return courtId
}

/** A known label no higher than the caller's clearance (P2-13: required, no default). */
function parseClassification(value: unknown, clearance: Classification): Classification {
  if (!isKnownClassification(value)) throw badQuery()
  if (rankOf(value) > rankOf(clearance)) throw new HttpError(403, "exceeds_own_clearance")
  return value
}

/** Up to 20 distinct user ids other than the caller (the caller is always a member). */
function parseMemberIds(value: unknown, callerUid: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_MEMBERS) throw new HttpError(400, "invalid_member")
  const ids = new Set<string>()
  for (const uid of value) {
    if (!isSafeDocId(uid)) throw new HttpError(400, "invalid_member")
    if (uid !== callerUid) ids.add(uid)
  }
  return [...ids]
}

/** A stored check is cleared: CLEAR (outright or once every review item is resolved), or FLAG with a partner waiver. */
function isCleared(row: DocumentData): boolean {
  if (row.decision !== "cleared") return false
  if (row.result === "CLEAR") return true
  return row.result === "FLAG" && row.waiver !== null && typeof row.waiver === "object"
}

/** The stored subject keys re-normalised exactly as parseKeys does; a key that no longer normalises is a mismatch. */
function normalisedKeys(raw: unknown): Keys {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== "object" || Array.isArray(raw)) throw mismatch()
  try {
    return parseKeys(raw as Record<string, unknown>)
  } catch {
    throw mismatch()
  }
}

function storedSubjects(raw: unknown): Subject[] {
  if (!Array.isArray(raw) || raw.length < 2) throw mismatch()
  return raw.map((s): Subject => {
    if (s === null || typeof s !== "object") throw mismatch()
    const { role, name, clientId } = s as Record<string, unknown>
    if ((role !== "client" && role !== "opposing") || typeof name !== "string" || name.trim() === "") throw mismatch()
    return { role, name, keys: normalisedKeys((s as Record<string, unknown>).keys), ...(typeof clientId === "string" ? { clientId } : {}) }
  })
}

/** The firm's transliteration additions (read by nameForms for the parties' normalised names). */
async function firmMap(firmId: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  const snap = await adminDb().collection("transliteration_map").where("firmId", "==", firmId).get()
  for (const d of snap.docs) {
    const { script, roman } = d.data()
    if (typeof script !== "string" || script === "" || !Array.isArray(roman)) continue
    const spellings = roman.filter((r): r is string => typeof r === "string" && r.trim() !== "")
    if (spellings.length > 0) map.set(script, [...(map.get(script) ?? []), ...spellings])
  }
  return map
}

/**
 * openMatter({ conflictCheckId, title (1-300), courtId?, classification, memberUserIds?: string[] (≤ 20) })
 * → the new matter. Partner or associate (matter.open). One transaction (≤ 10 attempts) re-reads the
 * check and refuses: missing or another firm's 404 check_not_found; not cleared 409 check_not_cleared;
 * already bound 409 check_already_bound; stale 409 check_stale; older than 30 days by its stored
 * createdAt 409 check_expired; a client subject that is not an existing client of the firm 409
 * subjects_mismatch; a listed member who is not an active same-firm staff user 400 invalid_member.
 * Then it allocates `{matterPrefix}/{YYYY}/{NNNN}` and writes the matter, the members (caller and
 * listed), one `matter_parties` row per check subject, the `opened` event, the binding with its
 * `bound` trail row, `matter.created` and the call's audit row.
 */
export const openMatterOp: FirmOperation<Record<string, unknown>> = {
  auth: "firm",
  kind: "general",
  action: "matter.open",
  target: "matters",
  run: async ({ caller, now: clock }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "matter.open")
    const now = new Date(clock ?? Date.now())

    const checkId = data.conflictCheckId
    if (!isSafeDocId(checkId)) throw badQuery()
    const title = parseTitle(data.title)
    const courtId = parseCourtId(data.courtId)
    const classification = parseClassification(data.classification, caller.clearanceLevel)
    const memberIds = parseMemberIds(data.memberUserIds, caller.uid)
    const map = await firmMap(caller.firmId)

    const db = adminDb()
    const matterRef = matters().doc()
    const matterId = matterRef.id
    audit.target = `matters/${matterId}`

    const row = await db.runTransaction(
      async (tx) => {
        // Reads first: the check, its client, the listed members, the prefixes, then the counter.
        const checkRef = checks().doc(checkId)
        const check = (await tx.get(checkRef)).data()
        if (!check || check.firmId !== caller.firmId) throw new HttpError(404, "check_not_found")
        // The clearance gate every check-consuming route applies (conflict/ops.ts gateCheck), before any
        // state code so those are no oracle; an unknown label fails closed.
        if (!isKnownClassification(check.classification) || rankOf(check.classification) > rankOf(caller.clearanceLevel)) {
          throw new HttpError(403, "exceeds_own_clearance")
        }
        if (!isCleared(check)) throw new HttpError(409, "check_not_cleared")
        if (check.boundMatterId !== null && check.boundMatterId !== undefined) throw new HttpError(409, "check_already_bound")
        if (check.stale === true) throw new HttpError(409, "check_stale")
        // P2-6: the stored server timestamp, never a client value; an unreadable one fails closed.
        if (!(check.createdAt instanceof Timestamp) || now.getTime() - check.createdAt.toMillis() > CHECK_VALIDITY_MS) {
          throw new HttpError(409, "check_expired")
        }
        const subjects = storedSubjects(check.subjects)
        const clientSubjects = subjects.filter((s) => s.role === "client")
        if (clientSubjects.length !== 1 || subjects[0].role !== "client") throw mismatch()
        const clientId = clientSubjects[0].clientId
        if (!isSafeDocId(clientId)) throw mismatch()
        const client = (await tx.get(db.collection("clients").doc(clientId))).data()
        if (!client || client.firmId !== caller.firmId) throw mismatch()
        const entityId = typeof client.entityId === "string" && client.entityId !== "" ? client.entityId : undefined

        const users = memberIds.length > 0 ? await tx.getAll(...memberIds.map((uid) => db.collection("users").doc(uid))) : []
        for (const u of users) {
          const d = u.data()
          if (!d || d.firmId !== caller.firmId || d.active !== true || !STAFF_ROLES.has(d.role)) throw new HttpError(400, "invalid_member")
        }

        const { matterPrefix } = await readPrefixes(tx, caller.firmId)
        const n = await allocateNumber(tx, caller.firmId, "matter", now)
        const matterNo = formatMatterNo(matterPrefix, karachiYear(now), n)
        const checkClass: Classification = check.classification

        const matter = {
          firmId: caller.firmId,
          matterNo,
          stage: "pre_filing" as Stage,
          status: "engagement_unconfirmed",
          clientId,
          conflictCheckId: checkId,
          title,
          ...(courtId !== undefined ? { courtId } : {}),
          classification,
          createdBy: caller.uid,
        }
        await audit.stage(tx, "allow", "ok")
        tx.create(matterRef, { ...matter, createdAt: FieldValue.serverTimestamp() })
        for (const uid of [caller.uid, ...memberIds]) {
          tx.create(members().doc(`${matterId}_${uid}`), {
            firmId: caller.firmId,
            matterId,
            userId: uid,
            addedBy: caller.uid,
            classification,
            createdAt: FieldValue.serverTimestamp(),
          })
        }
        for (const s of subjects) {
          tx.create(parties().doc(), {
            firmId: caller.firmId,
            matterId,
            role: s.role,
            name: s.name,
            names: nameForms(s.name, map).map((tokens) => tokens.join(" ")),
            keys: s.keys,
            ...(s.role === "client" ? { clientId, ...(entityId ? { entityId } : {}) } : {}),
            matterClassification: classification,
            matterStatus: "live",
            classification,
            createdAt: FieldValue.serverTimestamp(),
          })
        }
        tx.create(db.collection("matter_events").doc(), {
          firmId: caller.firmId,
          matterId,
          kind: "opened",
          to: "pre_filing",
          actorId: caller.uid,
          classification,
          createdAt: FieldValue.serverTimestamp(),
        })
        tx.update(checkRef, { boundMatterId: matterId })
        tx.create(db.collection("conflict_events").doc(), {
          firmId: caller.firmId,
          checkId,
          kind: "bound",
          actorId: caller.uid,
          detail: { matterId },
          classification: checkClass,
          createdAt: FieldValue.serverTimestamp(),
        })
        tx.create(db.collection("events").doc(`${matterId}_created`), {
          name: "matter.created",
          firmId: caller.firmId,
          payload: { matterId, clientId, ...(courtId !== undefined ? { courtId } : {}), caseNumber: null, relevant_law_dates: [] },
          classification,
          occurredAt: FieldValue.serverTimestamp(),
          idempotencyKey: `${matterId}:created`,
        })
        return matter
      },
      { maxAttempts: OPEN_TX_ATTEMPTS }
    )
    audit.committed()
    return present(matterId, { ...row, createdAt: Timestamp.fromDate(now) })
  },
}

/**
 * A D1-2 matter event row (the matter.created payload shape), written in the caller's transaction
 * under a doc id derived from its idempotency key.
 */
function matterEvent(
  tx: Transaction,
  name: "matter.updated" | "matter.closed",
  matterId: string,
  matter: DocumentData,
  idempotencyKey: string
): void {
  const courtId = typeof matter.courtId === "string" ? matter.courtId : undefined
  tx.create(adminDb().collection("events").doc(idempotencyKey.replaceAll(":", "_")), {
    name,
    firmId: matter.firmId,
    payload: { matterId, clientId: matter.clientId ?? null, ...(courtId !== undefined ? { courtId } : {}), caseNumber: null, relevant_law_dates: [] },
    classification: matter.classification,
    occurredAt: FieldValue.serverTimestamp(),
    idempotencyKey,
  })
}

/**
 * The matter-level permission decision (shared table, audited by checkPermission). A missing or
 * another firm's matter is 404 not_found, so existence never leaks; any other deny is 403 with the
 * decision's reason (not_member, clearance, role_not_permitted, ...); an audit failure is 503.
 */
async function gateMatter(caller: Caller, action: "matter.read" | "matter.advance_stage" | "matter.close", matterId: string): Promise<void> {
  const decision = await checkPermission(caller, action, matterId)
  if (decision.allow) return
  if (decision.reason === "audit_unavailable") throw new HttpError(503, "audit_unavailable")
  if (decision.reason === "cross-firm") throw new HttpError(404, "not_found")
  throw new HttpError(403, decision.reason.replaceAll("-", "_"))
}

function parseMatterId(value: unknown): string {
  if (!isSafeDocId(value)) throw badQuery()
  return value
}

/** getMatter(?matterId=) → the matter, for a cleared same-firm member (matter.read). */
export const getMatterOp: FirmOperation<Record<string, unknown>> = {
  auth: "firm",
  kind: "general",
  action: "matter.read",
  target: "matters",
  run: async ({ caller }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const matterId = parseMatterId(data.matterId)
    audit.target = `matters/${matterId}`
    await gateMatter(caller, "matter.read", matterId)
    const row = (await matters().doc(matterId).get()).data()
    if (!row || row.firmId !== caller.firmId) throw new HttpError(404, "not_found")
    await audit.allow()
    return present(matterId, row)
  },
}

const SCAN_BATCH = 100

/**
 * listMatters(?limit=&cursor=) → { items, nextCursor }: the matters the caller is a member of
 * (R-2: membership is the access source, no role exempt) and cleared for, most recently joined
 * first (membership createdAt desc, then id desc). Each matter passes the shared decision table.
 */
export const listMattersOp: FirmOperation<Page<Record<string, unknown>>> = {
  auth: "firm",
  kind: "general",
  action: "matter.read",
  target: "matters",
  run: async ({ caller }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    // The role rows of the table (client, accounts, non-staff) refuse before any membership is read.
    const roleCheck = decide(caller, "matter.read", { firmId: caller.firmId, classification: "public" }, true)
    if (!roleCheck.allow) throw new HttpError(403, roleCheck.reason.replaceAll("-", "_"))
    const { limit, cursor } = parsePage(data)
    let after: { createdAt: Timestamp; id: string } | null = null
    if (cursor !== null) {
      const { sortKey, id } = decodeCursor(cursor)
      const [seconds, nanos] = sortKey.split(".").map(Number)
      if (!Number.isInteger(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9 || !isSafeDocId(id)) {
        throw new HttpError(400, "invalid_cursor")
      }
      after = { createdAt: new Timestamp(seconds, nanos), id }
    }

    const items: Array<{ memberId: string; memberCreatedAt: Timestamp; matterId: string; row: DocumentData }> = []
    let more = false
    for (;;) {
      let q: Query = members()
        .where("firmId", "==", caller.firmId)
        .where("userId", "==", caller.uid)
        .orderBy("createdAt", "desc")
        .orderBy(FieldPath.documentId(), "desc")
      if (after) q = q.startAfter(after.createdAt, after.id)
      const snap = await q.limit(SCAN_BATCH).get()
      const ids = snap.docs.map((d) => d.data().matterId).filter((id): id is string => isSafeDocId(id))
      const docs = ids.length > 0 ? await adminDb().getAll(...ids.map((id) => matters().doc(id))) : []
      const byId = new Map(docs.map((d) => [d.id, d.data()]))
      for (const m of snap.docs) {
        const matterId = m.data().matterId
        const row = typeof matterId === "string" ? byId.get(matterId) : undefined
        if (!row || !decide(caller, "matter.read", { firmId: row.firmId, classification: row.classification }, true).allow) continue
        if (items.length === limit) {
          more = true
          break
        }
        items.push({ memberId: m.id, memberCreatedAt: m.data().createdAt as Timestamp, matterId, row })
      }
      if (more || snap.size < SCAN_BATCH) break
      const last = snap.docs[snap.docs.length - 1]
      after = { createdAt: last.data().createdAt as Timestamp, id: last.id }
    }

    await audit.allow()
    const last = items[items.length - 1]
    return {
      items: items.map(({ matterId, row }) => present(matterId, row)),
      nextCursor: more && last ? encodeCursor(`${last.memberCreatedAt.seconds}.${last.memberCreatedAt.nanoseconds}`, last.memberId) : null,
    }
  },
}

const isStage = (v: unknown): v is Stage => typeof v === "string" && (STAGES as readonly string[]).includes(v)

/**
 * advanceStage({ matterId, to }) → the matter. A partner or associate member (matter.advance_stage)
 * moves an open matter exactly one stage forward (P2-12); anything else is 409
 * invalid_stage_transition. Writes the stage, a `stage_advanced` event and the audit row in one transaction.
 */
export const advanceStageOp: FirmOperation<Record<string, unknown>> = {
  auth: "firm",
  kind: "general",
  action: "matter.advance_stage",
  target: "matters",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const matterId = parseMatterId(data.matterId)
    audit.target = `matters/${matterId}`
    await gateMatter(caller, "matter.advance_stage", matterId)
    const to = data.to
    if (!isStage(to)) throw badQuery()

    const db = adminDb()
    const row = await db.runTransaction(async (tx) => {
      const ref = matters().doc(matterId)
      const matter = (await tx.get(ref)).data()
      if (!matter || matter.firmId !== caller.firmId) throw new HttpError(404, "not_found")
      const from = matter.stage
      const index = STAGES.indexOf(from as Stage)
      if (matter.status === "closed" || index < 0 || STAGES[index + 1] !== to) throw new HttpError(409, "invalid_stage_transition")
      await audit.stage(tx, "allow", "ok")
      tx.update(ref, { stage: to })
      tx.create(db.collection("matter_events").doc(), {
        firmId: caller.firmId,
        matterId,
        kind: "stage_advanced",
        from,
        to,
        actorId: caller.uid,
        classification: matter.classification,
        createdAt: FieldValue.serverTimestamp(),
      })
      matterEvent(tx, "matter.updated", matterId, matter, `${matterId}:stage:${to}`)
      return { ...matter, stage: to }
    })
    audit.committed()
    return present(matterId, row)
  },
}

/**
 * closeMatter({ matterId, reason? }) → the matter. A partner member (matter.close) closes an open
 * matter at stage `decided`, or at any stage with a reason of at least 20 characters; otherwise 409
 * invalid_stage_transition (P2-12). Sets `status: closed`, marks the matter's parties closed (so a
 * later check reads its client as a former client) and writes a `closed` event, in one transaction.
 */
export const closeMatterOp: FirmOperation<Record<string, unknown>> = {
  auth: "firm",
  kind: "general",
  action: "matter.close",
  target: "matters",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const matterId = parseMatterId(data.matterId)
    audit.target = `matters/${matterId}`
    await gateMatter(caller, "matter.close", matterId)
    if (data.reason !== undefined && data.reason !== null && typeof data.reason !== "string") throw badQuery()
    const reason = typeof data.reason === "string" ? data.reason.trim() : ""
    if (reason.length > 2000) throw badQuery()

    const db = adminDb()
    const row = await db.runTransaction(async (tx) => {
      const ref = matters().doc(matterId)
      const matter = (await tx.get(ref)).data()
      if (!matter || matter.firmId !== caller.firmId) throw new HttpError(404, "not_found")
      if (matter.status === "closed") throw new HttpError(409, "invalid_stage_transition")
      if (matter.stage !== "decided" && reason.length < MIN_CLOSE_REASON) throw new HttpError(409, "invalid_stage_transition")
      const partySnap = await tx.get(parties().where("firmId", "==", caller.firmId).where("matterId", "==", matterId))

      await audit.stage(tx, "allow", "ok")
      tx.update(ref, { status: "closed", closedBy: caller.uid, closedAt: FieldValue.serverTimestamp() })
      for (const p of partySnap.docs) tx.update(p.ref, { matterStatus: "closed" })
      tx.create(db.collection("matter_events").doc(), {
        firmId: caller.firmId,
        matterId,
        kind: "closed",
        from: matter.stage,
        actorId: caller.uid,
        ...(reason !== "" ? { reason } : {}),
        classification: matter.classification,
        createdAt: FieldValue.serverTimestamp(),
      })
      matterEvent(tx, "matter.closed", matterId, matter, `${matterId}:closed`)
      return { ...matter, status: "closed", closedBy: caller.uid }
    })
    audit.committed()
    return present(matterId, row)
  },
}
