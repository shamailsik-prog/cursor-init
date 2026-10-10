import { FieldPath, FieldValue, Timestamp, type DocumentData, type Query, type Transaction } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { decide } from "@/platform/p5/permissionDecision"
import { adminDb } from "../../admin"
import { HttpError } from "../../http/errors"
import { isContentionAbort } from "../contention"
import type { Caller } from "../../p5/auth"
import { isKnownClassification, rankOf } from "../../p5/classification"
import { isSafeDocId, type Data, type FirmOperation } from "../../p5/common"
import { checkPermission, requirePermission } from "../../p5/permission"
import { loadRegistry, maxLabel, runEngine, unseenHits } from "../conflict/engine"
import { nameForms } from "../conflict/normalise"
import type { Hit, Subject } from "../conflict/match"
import { isUnmergeInProgress } from "../entity/linkState"
import { isFirestoreDocId } from "../../p2/fanout"
import { allocateNumber, formatMatterNo, karachiYear, readPrefixes } from "../numbering"
import { decodeCursor, encodeCursor, parsePage, type Page } from "../pagination"
import { bumpRegistryVersion, readRegistryVersion, readRegistryVersionTx } from "../registryVersion"
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

/**
 * Re-screen rounds of one openMatter (Bugbot PR #8): a round whose registry version moved between its
 * pre-screen and its transaction writes nothing and is redone; after this many, 409 registry_contended.
 * Every open bumps the version, and a round fails only when another registry write commits inside it, so
 * N concurrent opens in one firm all finish within N rounds: 10, as OPEN_TX_ATTEMPTS (3 failed Review Focus 3).
 */
export const OPEN_SCREEN_ROUNDS = 10

/**
 * Test seam only (the emulator suites set it; production code never does): awaited after each round's
 * pre-screen and before its transaction, so a concurrent registry write can land there deterministically.
 */
export const openMatterTestSeam: { afterPreScreen?: (round: number) => Promise<void> } = {}

/** A round's transaction saw a registry version other than its pre-screen's: nothing written, redo. */
const REGISTRY_MOVED = Symbol("registry_moved")

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

/**
 * The checks every open applies to the stored check, in order (before any state code, the clearance
 * gate, so those are no oracle): missing or another firm's 404 check_not_found; a clearance below the
 * check's (an unknown label fails closed) 403 exceeds_own_clearance; not cleared, bound, stale,
 * expired 409; then its subjects, which must name exactly one registered client first.
 */
function gateOpen(caller: Caller, check: DocumentData | undefined, now: Date): { subjects: Subject[]; clientId: string } {
  if (!check || check.firmId !== caller.firmId) throw new HttpError(404, "check_not_found")
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
  return { subjects, clientId }
}

/**
 * The entity link ids a stored check's hits relied on (`hits[].reliedOnLinkIds`, read as the un-merge
 * checks job reads them, `checkReliesOn`), deduplicated. An entry that is not a Firestore document id
 * cannot name a link row, so skipping it skips no row.
 */
function reliedOnLinkIds(check: DocumentData | undefined): string[] {
  const hits: unknown = check?.hits
  if (!Array.isArray(hits)) return []
  const ids = new Set<string>()
  for (const h of hits) {
    const relied = (h as { reliedOnLinkIds?: unknown } | null)?.reliedOnLinkIds
    if (!Array.isArray(relied)) continue
    for (const id of relied) if (isFirestoreDocId(id)) ids.add(id)
  }
  return [...ids]
}

/**
 * P3-40 (O-46): 409 unmerge_in_progress when any link the check's hits relied on is being un-merged: the
 * check was cleared on an identity that is being reversed. One getAll in the caller's transaction, before
 * any write. The row rule is isUnmergeInProgress, the one behind the read-time `unmerging` state (E-43(c)),
 * applied whatever the L17.2 flag says (a saga started while it was on still runs): never refused for a
 * link that is merely confirmed, disputed or a candidate, or whose un-merge has completed.
 */
async function refuseUnmerging(tx: Transaction, check: DocumentData | undefined): Promise<void> {
  const ids = reliedOnLinkIds(check)
  if (ids.length === 0) return
  const links = adminDb().collection("entity_links")
  const rows = await tx.getAll(...ids.map((id) => links.doc(id)))
  if (rows.some((r) => {
    const row = r.data()
    return row !== undefined && isUnmergeInProgress(row)
  })) {
    throw new HttpError(409, "unmerge_in_progress")
  }
}

/** The check's client record in the caller's firm (else subjects_mismatch) and its entity. */
function clientOf(caller: Caller, client: DocumentData | undefined): { entityId: string | undefined; classification: unknown } {
  if (!client || client.firmId !== caller.firmId) throw mismatch()
  const entityId = typeof client.entityId === "string" && client.entityId !== "" ? client.entityId : undefined
  return { entityId, classification: client.classification }
}

/**
 * openMatter({ conflictCheckId, title (1-300), courtId?, classification, memberUserIds?: string[] (≤ 20) })
 * → the new matter. Partner or associate (matter.open). One transaction (≤ 10 attempts) re-reads the
 * check and refuses: missing or another firm's 404 check_not_found; not cleared 409 check_not_cleared;
 * already bound 409 check_already_bound; stale 409 check_stale; older than 30 days by its stored
 * createdAt 409 check_expired; a client subject that is not an existing client of the firm 409
 * subjects_mismatch; a hit that relied on an entity link being un-merged 409 unmerge_in_progress
 * (P3-40, nothing written; a check already marked stale answers check_stale first); a listed member
 * who is not an active same-firm staff user 400 invalid_member.
 * Before the transaction the stored subjects are re-screened against the current registry (the
 * runConflictCheck engine, no daily-limit spend, no check written); a non-NONE hit the check does not
 * already hold (or hold resolved) marks the check stale in the transaction and answers 409 check_stale.
 * The screen is tied to the transaction by the firm's registry version (`counters/{firmId}_registry`,
 * registryVersion.ts; Bugbot PR #8): read before the screen and again first in the transaction. A
 * moved version (a registry write committed in between) makes the round write nothing, no audit row
 * either, and the screen and transaction are redone; after OPEN_SCREEN_ROUNDS (10) moved rounds, 409
 * registry_contended (nothing written; a retry is safe), audited as the call's one deny row. A
 * writer committing after the transaction's version read either aborts it (it retries and sees the
 * move) or commits after the matter opened, which is the correct order.
 * Then it allocates `{matterPrefix}/{YYYY}/{NNNN}` and writes the matter, the members (caller and
 * listed), one `matter_parties` row per check subject (classified at the highest of the matter, the
 * client record and the check), the `opened` event, the binding (raising the check's classification
 * to the matter's when higher) with its `bound` trail row, `matter.created`, the registry version bump and the call's audit row.
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

    const db = adminDb()
    const checkRef = checks().doc(checkId)
    const matterRef = matters().doc()
    const matterId = matterRef.id
    audit.target = `matters/${matterId}`

    for (let round = 1; round <= OPEN_SCREEN_ROUNDS; round++) {
      // Re-screen (spec P2-6, final review I5): the stored subjects against today's registry, through the
      // same engine as runConflictCheck, after the same gate the transaction applies again below. The
      // registry version is read first: a registry write the screen missed has bumped it by the transaction.
      const version = await readRegistryVersion(caller.firmId)
      const pre = gateOpen(caller, (await checkRef.get()).data(), now)
      const preClient = clientOf(caller, (await db.collection("clients").doc(pre.clientId).get()).data())
      const registry = await loadRegistry(caller.firmId, now)
      const fresh: Hit[] = runEngine(registry, pre.subjects, pre.subjects.map((_, i) => (i === 0 ? preClient.entityId : undefined))).hits
      await openMatterTestSeam.afterPreScreen?.(round)

      const runRound = () =>
        db.runTransaction(
        async (tx) => {
          // Reads first: the registry version, the check, its client, the listed members, the prefixes, then the counter.
          // A moved version means the screen above may be out of date: write nothing (no audit row) and redo the round.
          if ((await readRegistryVersionTx(tx, caller.firmId)) !== version) return REGISTRY_MOVED
          const check = (await tx.get(checkRef)).data()
          const { subjects, clientId } = gateOpen(caller, check, now)
          const client = clientOf(caller, (await tx.get(db.collection("clients").doc(clientId))).data())
          const entityId = client.entityId
          // P3-40: after gateOpen, so a check the un-merge checks job already marked stale answers check_stale;
          // before the stale write below, so the refusal writes nothing (the checks job marks the check).
          await refuseUnmerging(tx, check)
          if (unseenHits(fresh, Array.isArray(check?.hits) ? check.hits : []).length > 0) {
            // A hit the check never saw: the check no longer describes the registry. Marked stale atomically with the deny row.
            await audit.stage(tx, "deny", "check_stale")
            tx.update(checkRef, { stale: true })
            return null
          }

          const users = memberIds.length > 0 ? await tx.getAll(...memberIds.map((uid) => db.collection("users").doc(uid))) : []
          for (const u of users) {
            const d = u.data()
            if (!d || d.firmId !== caller.firmId || d.active !== true || !STAFF_ROLES.has(d.role)) throw new HttpError(400, "invalid_member")
          }

          const { matterPrefix } = await readPrefixes(tx, caller.firmId)
          const n = await allocateNumber(tx, caller.firmId, "matter", now)
          const matterNo = formatMatterNo(matterPrefix, karachiYear(now), n)
          const checkClass: Classification = check?.classification
          // L17.3 #20 (monotonic): the bound check rises to the matter's label; party rows carry the highest of all three.
          const boundClass = maxLabel(checkClass, classification)
          const partyClass = maxLabel(boundClass, client.classification)

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
          // The new matter and its parties change the registry: a concurrent open re-screens against them.
          bumpRegistryVersion(tx, caller.firmId)
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
              names: nameForms(s.name, registry.firmMap).map((tokens) => tokens.join(" ")),
              keys: s.keys,
              ...(s.role === "client" ? { clientId, ...(entityId ? { entityId } : {}) } : {}),
              matterClassification: classification,
              matterStatus: "live",
              classification: partyClass,
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
          tx.update(checkRef, { boundMatterId: matterId, classification: boundClass })
          tx.create(db.collection("conflict_events").doc(), {
            firmId: caller.firmId,
            checkId,
            kind: "bound",
            actorId: caller.uid,
            detail: { matterId },
            classification: boundClass,
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
      let row: Awaited<ReturnType<typeof runRound>>
      try {
        row = await runRound()
      } catch (err) {
        // Contention exhausted the round's transaction attempts: nothing was written, so redo the round.
        if (isContentionAbort(err)) continue
        throw err
      }
      if (row === REGISTRY_MOVED) continue
      audit.committed()
      if (row === null) throw new HttpError(409, "check_stale")
      return present(matterId, { ...row, createdAt: Timestamp.fromDate(now) })
    }
    // Every round's registry moved under it: nothing was written and a retry is safe. runAudited writes the one deny row.
    throw new HttpError(409, "registry_contended")
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
      try {
        after = { createdAt: new Timestamp(seconds, nanos), id }
      } catch {
        // Seconds outside the Timestamp range.
        throw new HttpError(400, "invalid_cursor")
      }
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
      // A closed matter turns its client and parties into former ones in the conflict screen.
      bumpRegistryVersion(tx, caller.firmId)
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
