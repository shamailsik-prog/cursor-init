import { NextResponse } from "next/server"
import { parseLimit, parseCursor } from "@/platform/http/pagination"
import { fingerprintOf } from "@/platform/http/validation"
import { BodySchema, MATTERS_SURFACE } from "./surface"
import { z } from "zod"
import { PublicError } from "@/platform/http/publicError"
import { actionOf, getQuery, isAction, refuseUndeclaredBody } from "@/platform/http/surface"
import { withSession } from "@/platform/http/withSession"
import { allPostActionsExcept, gateByFlag } from "@/platform/flags/routeGate"
import { REQUEST_FAILED_CODE, publicErrorMessage } from "@/platform/http/errors"
import { isClassification, type Classification } from "@/platform/p1/types"
import {
  beginIdempotentRequest,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { checkPermission } from "@/platform/p5/checkPermission"
import { DEFAULT_JSON_BODY_BYTES, parseBody, readJsonLimited } from "@/platform/http/validation"
import { rankOf, rankOfStoredOrMax } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMatters, syncFirmMembers } from "@/platform/persistence/memberSync"
import { buildMatterSearchIndexRow } from "@/platform/persistence/matterClientSearchIndex"
import {
  cacheMember,
  confirmEngagement,
  MembershipAssignmentError,
  recordMatterMemberAdd,
  validateMatterAssignee,
  validateMatterAssignment,
} from "@/services/d1-2/matters"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"



type Body = z.infer<typeof BodySchema>

function deny(message: string, status = 403) {
  return NextResponse.json({ error: message }, { status })
}

function ensureActor(actorId: string, firmId?: string) {
  const store = getRuntimeStore()
  const actor = store.users.get(actorId)
  if (!actor) throw new PublicError("unknown actor")
  if (firmId && actor.firmId !== firmId) throw new PublicError("cross-firm actor denied")
  if (actor.role === "client" || actor.role === "intern" || actor.role === "accounts") {
    throw new PublicError("actor role not allowed for matter operations")
  }
  return actor
}

function ensureClientIdentityInFirm(clientId: string, firmId: string) {
  const store = getRuntimeStore()
  const client = store.users.get(clientId)
  if (!client) throw new PublicError("unknown client")
  if (client.firmId !== firmId) {
    throw new PublicError("cross-firm client denied")
  }
  if (client.role !== "client") {
    throw new PublicError("clientId must reference a client user")
  }
}

async function ensureMatterAccess(
  repos: SpineRepositories,
  actorId: string,
  matterId: string
) {
  const store = getRuntimeStore()
  const actor = ensureActor(actorId)
  const matter = store.matters.get(matterId) ?? (await repos.matters.get(matterId, actor.firmId))
  if (!matter) throw new PublicError("unknown matter")
  store.matters.set(matter.id, matter)
  if (matter.firmId !== actor.firmId) throw new PublicError("cross-firm access denied")
  if (!store.members.has(store.memberKey(matterId, actorId))) {
    throw new PublicError("actor is not a member of this matter")
  }
  if (rankOf(actor.clearanceLevel) < rankOfStoredOrMax(matter.classification)) {
    throw new PublicError("actor clearance is below matter classification")
  }
  return { actor, matter }
}

export async function GET(request: Request) {
  return withSession(request, handleGet, { surface: MATTERS_SURFACE })
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repo = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const userId = getQuery(MATTERS_SURFACE, url, "userId")
  const limit = parseLimit(getQuery(MATTERS_SURFACE, url, "limit"))
  const cursor = parseCursor(getQuery(MATTERS_SURFACE, url, "cursor"))
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  const user = store.users.get(userId)
  if (!user) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 })
  }
  await syncFirmMembers(store, repo, user.firmId)
  // Audit F14 NEW-1: the sync's listing is the request's one listing of the firm's matters (as C4 for ops-reporting).
  const firmMatters = await syncFirmMatters(store, repo, user.firmId)
  const perm = checkPermission(store, userId, "list_matters")
  if (!perm.allow) {
    return deny(`permission denied: ${perm.reason}`)
  }
  const all = firmMatters
    .filter((matter) => {
      if (user.role === "client") return matter.clientId === user.id
      return store.members.has(store.memberKey(matter.id, user.id))
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  const items = all.slice(cursor, cursor + limit)
  const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null
  return NextResponse.json({
    items,
    total: all.length,
    cursor,
    limit,
    nextCursor,
  })
}

export async function POST(request: Request) {
  return withSession(request, handlePostGated, { maxBodyBytes: DEFAULT_JSON_BODY_BYTES, surface: MATTERS_SURFACE })
}

// Phase 2a final review I3: the check-free `create` action is frozen behind LEGACY_D1_NEXT_WRITES
// (default off; Erratum E-40). Every other action is unchanged.
const handlePostGated = gateByFlag("LEGACY_D1_NEXT_WRITES", handlePost, allPostActionsExcept(["create"]))

async function handlePost(request: Request) {
  const store = getRuntimeStore()
  const repo = await getRuntimeRepositories(store)
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message =
      err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }

  const raw = await readJsonLimited(request)
  if (!raw.ok) return raw.response
  const undeclared = refuseUndeclaredBody(MATTERS_SURFACE, raw.data)
  if (undeclared) return undeclared
  const body = parseBody(BodySchema, raw.data)
  if (!body.ok) return body.response
  const parsed: Body = body.data

  const fingerprint = fingerprintOf({
    route: "/api/d1/matters",
    action: actionOf(MATTERS_SURFACE, parsed),
    body: parsed,
  })
  // Final audit F4: check-and-reserve the key in one synchronous step (no await in between).
  const idem = await beginIdempotentRequest(request, key, fingerprint)
  if (idem.response) return idem.response
  const claim = idem.claim

  try {
    if (isAction(MATTERS_SURFACE, parsed, "create")) {
      if (!parsed.actorId || !parsed.firmId || !parsed.clientId || !parsed.title || !parsed.courtId) {
        return NextResponse.json(
          { error: "actorId, firmId, clientId, title, and courtId are required" },
          { status: 400 }
        )
      }
      if (!isClassification(parsed.classification)) {
        return NextResponse.json(
          { error: "classification must be a rank-0–4 label" },
          { status: 400 }
        )
      }
      const actor = ensureActor(parsed.actorId, parsed.firmId)
      if (rankOf(actor.clearanceLevel) < rankOf(parsed.classification as Classification)) {
        return deny("actor clearance is below requested matter classification")
      }
      ensureClientIdentityInFirm(parsed.clientId, parsed.firmId)
      // Validate every member before anything is persisted, so a bad member id cannot
      // leave an orphaned matter behind. Final audit F1: the same assignee rule as
      // add_member (same-firm staff only; client/accounts -> 403 assignee_role_forbidden).
      // The creator seats themselves (ensureActor already refused client/intern/accounts).
      const memberIds = new Set<string>([parsed.actorId, ...(parsed.memberUserIds ?? [])])
      try {
        for (const userId of memberIds) validateMatterAssignee(store, parsed.firmId, userId)
      } catch (err) {
        if (err instanceof MembershipAssignmentError) {
          return NextResponse.json({ error: err.message, code: err.code }, { status: 403 })
        }
        throw err
      }
      const matter = {
        id: store.id("mat"),
        firmId: parsed.firmId,
        clientId: parsed.clientId,
        title: parsed.title,
        courtId: parsed.courtId,
        caseNumber: null,
        caseNumberStatus: "pending" as const,
        status: "engagement_unconfirmed" as const,
        classification: parsed.classification,
        // Audit F13: the canonical shape Cloud Functions writes (no number is allocated on this check-free path).
        matterNo: null,
        stage: "pre_filing" as const,
        createdBy: parsed.actorId,
      }
      await repo.matters.create(matter)
      await repo.reportingIndex.upsert(buildMatterSearchIndexRow(matter))
      // Keep in-memory mirror in sync for flows that still read the spine directly.
      store.matters.set(matter.id, matter)
      // Audit F14 R7: each membership is persisted first and cached only once the write has succeeded, so a member sync
      // whose snapshot holds it always lists it (every member was validated above, before anything was persisted).
      for (const userId of memberIds) {
        const member = { matterId: matter.id, userId, firmId: matter.firmId, addedBy: parsed.actorId }
        await repo.members.upsert(member)
        cacheMember(store, member)
        recordMatterMemberAdd(store, parsed.actorId, matter, userId)
      }
      store.audit.push({
        action: "matter_create",
        actorId: parsed.actorId,
        target: matter.id,
        classification: matter.classification,
      })
      const payload = {
        action: "create",
        matter,
      }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (isAction(MATTERS_SURFACE, parsed, "add_member")) {
      const actor = ensureActor(parsed.actorId)
      await syncFirmMembers(store, repo, actor.firmId)
      await syncFirmMatters(store, repo, actor.firmId)
      const matter =
        store.matters.get(parsed.matterId) ??
        (await repo.matters.get(parsed.matterId, actor.firmId))
      if (matter) store.matters.set(matter.id, matter)
      let assignment: ReturnType<typeof validateMatterAssignment>
      try {
        assignment = validateMatterAssignment(store, {
          actorId: parsed.actorId,
          matterId: parsed.matterId,
          userId: parsed.memberUserId,
        })
      } catch (err) {
        if (err instanceof MembershipAssignmentError) {
          return NextResponse.json({ error: err.message, code: err.code }, { status: 403 })
        }
        throw err
      }
      // Audit F14 R7: validate, persist, then cache; a failed write leaves nothing cached and nothing audited.
      const { matter: assigned } = assignment
      const member = { ...assignment.member, addedBy: parsed.actorId }
      await repo.members.upsert(member)
      cacheMember(store, member)
      recordMatterMemberAdd(store, parsed.actorId, assigned, member.userId)
      const payload = { action: "add_member", member }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (isAction(MATTERS_SURFACE, parsed, "confirm_engagement")) {
      if (!parsed.actorId || !parsed.matterId) {
        return NextResponse.json({ error: "actorId and matterId are required" }, { status: 400 })
      }
      const actor = ensureActor(parsed.actorId)
      await syncFirmMembers(store, repo, actor.firmId)
      await syncFirmMatters(store, repo, actor.firmId)
      const { matter } = await ensureMatterAccess(repo, parsed.actorId, parsed.matterId)
      // Audit F13: closing is a Cloud Functions transition (closeMatter); Next never reopens a closed matter.
      if (matter.status === "closed") {
        return NextResponse.json({ error: "matter is closed", code: "matter_closed" }, { status: 409 })
      }
      const priorIntimationIds = new Set(store.intimations.map((row) => row.id))
      confirmEngagement(store, parsed.matterId, parsed.atMs)
      const updatedMatter = store.matters.get(parsed.matterId)
      if (updatedMatter) {
        await repo.matters.update(parsed.matterId, actor.firmId, {
          status: updatedMatter.status,
        })
        await repo.reportingIndex.upsert(buildMatterSearchIndexRow(updatedMatter))
      }
      const newIntimations = store.intimations.filter(
        (row) => row.matterId === parsed.matterId && !priorIntimationIds.has(row.id)
      )
      for (const row of newIntimations) {
        await repo.intimations.upsert(row)
      }
      store.audit.push({
        action: "matter_confirm_engagement",
        actorId: parsed.actorId,
        target: parsed.matterId,
        classification: matter.classification,
      })
      const payload = {
        action: "confirm_engagement",
        matter:
          (await repo.matters.get(parsed.matterId, actor.firmId)) ??
          store.matters.get(parsed.matterId),
      }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (isAction(MATTERS_SURFACE, parsed, "record_case_number")) {
      if (!parsed.actorId || !parsed.matterId || !parsed.raw || !parsed.courtId) {
        return NextResponse.json(
          { error: "actorId, matterId, raw, and courtId are required" },
          { status: 400 }
        )
      }
      const actor = ensureActor(parsed.actorId)
      await syncFirmMembers(store, repo, actor.firmId)
      await syncFirmMatters(store, repo, actor.firmId)
      const { matter } = await ensureMatterAccess(repo, parsed.actorId, parsed.matterId)
      // R2 N6: the case number feeds the citation gate's own-case exemption; only a partner
      // member records it (D6-1 owns it, L18 §3.2), and it is audited below.
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "only a partner records the case number", code: "partner_required" },
          { status: 403 }
        )
      }
      const priorFollowUpIds = new Set(store.followUps.map((row) => row.id))
      const result = recordCaseNumber(store, parsed.matterId, parsed.raw, parsed.courtId)
      const updatedMatter = store.matters.get(parsed.matterId)
      if (updatedMatter) {
        await repo.matters.update(parsed.matterId, actor.firmId, {
          caseNumber: updatedMatter.caseNumber,
          caseNumberStatus: updatedMatter.caseNumberStatus,
        })
        await repo.reportingIndex.upsert(buildMatterSearchIndexRow(updatedMatter))
      }
      const newFollowUps = store.followUps.filter((row) => !priorFollowUpIds.has(row.id))
      for (const row of newFollowUps) {
        await repo.followUps.upsert(row)
      }
      store.audit.push({
        action: "matter_record_case_number",
        actorId: parsed.actorId,
        target: parsed.matterId,
        classification: matter.classification,
        reason: result.status,
      })
      const payload = {
        action: "record_case_number",
        result,
        matter:
          (await repo.matters.get(parsed.matterId, actor.firmId)) ??
          store.matters.get(parsed.matterId),
      }
      claim.complete(payload)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = publicErrorMessage(err, "matter operation failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
