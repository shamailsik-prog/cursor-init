import { NextResponse } from "next/server"
import { parseLimit, parseCursor } from "@/platform/http/pagination"
import { fingerprintOf } from "@/platform/http/validation"
import { PublicError } from "@/platform/http/publicError"
import { withSession, type HandlerSession } from "@/platform/http/withSession"
import { REQUEST_FAILED_CODE, publicErrorMessage } from "@/platform/http/errors"
import { isClassification, type Classification } from "@/platform/p1/types"
import { callCommitteeBrain } from "@/platform/p1/internalAICaller"
import {
  FUNCTIONS_NOT_CONFIGURED_ALERT,
  forwardCommitteeBrain,
  functionsP1BaseUrl,
} from "@/platform/p1/functionsCommitteeBrain"
import { checkProviderKeys, providerKeysPresent } from "@/platform/p1/providerKeyGuard"
import { rankOf, rankOfStoredOrMax, type CommitteeBrainOutput } from "@/platform/spine/store"
import {
  CommitteeScopeError,
  canAccessMatter,
  resolveCommitteeScope,
  strictestClassification,
} from "@/platform/p5/committeeScope"
import { syncFirmMatters, syncFirmMembers } from "@/platform/persistence/memberSync"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import {
  IdempotencyError,
  beginIdempotentRequest,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"

/**
 * Audit F18: a Firebase forward can wait on Cloud Functions for at most FORWARD_TIMEOUT_MS
 * (125 s; platform/p1/functionsCommitteeBrain.ts). The platform limit sits above that so the
 * forward's own deadline, not a platform kill, ends a hanging call. A literal: Next reads it statically.
 * Order (PR #88 review round 1): Functions `api` timeout 120 s < FORWARD_TIMEOUT_MS 125 s < 130 s here <= 300 s, the
 * smallest Vercel plan's maximum (Hobby, Fluid compute). Pinned by tests/f18-functions-forward.test.ts and
 * tests/f18-legacy-ai-path.e2e.firestore.test.ts.
 */
export const maxDuration = 130

/** Allowed `purpose` values (I1); anything else is 400 invalid_purpose. */
const COMMITTEE_PURPOSES = ["committee-brain", "summarise", "research", "translate", "ops-audit"] as const
type CommitteePurpose = (typeof COMMITTEE_PURPOSES)[number]
const COMMITTEE_PURPOSE_SET: ReadonlySet<string> = new Set(COMMITTEE_PURPOSES)
function isCommitteePurpose(value: unknown): value is CommitteePurpose {
  return typeof value === "string" && COMMITTEE_PURPOSE_SET.has(value)
}

/** Minimum classification for caller-supplied free text (N1). */
const FREE_TEXT_FLOOR: Classification = "internal"

type Body = {
  actorId?: string
  body?: string
  /**
   * Optional caller label. It can only RAISE the classification derived from
   * the referenced matter/documents, never lower it (H1).
   */
  classification?: string
  /** REQUIRED. Matter the text belongs to; with documentIds, the classification source. */
  matterId?: string
  documentIds?: string[]
  purpose?: string
  /** Extra names to mask, added to the names derived from the matter. */
  partyNames?: string[]
}

function requireActor(actorId: string) {
  const store = getRuntimeStore()
  const actor = store.users.get(actorId)
  if (!actor) throw new PublicError("unknown actor")
  if (actor.role === "client" || actor.role === "intern" || actor.role === "accounts") {
    throw new PublicError("actor role not allowed for committee brain operations")
  }
  return actor
}

export async function GET(request: Request) {
  return withSession(request, handleGet)
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const actorId = url.searchParams.get("actorId")
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  const blockedParam = url.searchParams.get("blocked")

  if (!actorId) {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }

  try {
    const actor = requireActor(actorId)
    const blockedFilter =
      blockedParam === "true" ? true : blockedParam === "false" ? false : undefined
    const cleared = (await repos.committeeOutputs.listByFirm(actor.firmId))
      .filter((row) => rankOf(actor.clearanceLevel) >= rankOfStoredOrMax(row.classification))
      .filter((row) => (blockedFilter === undefined ? true : row.blocked === blockedFilter))
    // M4: outputs are visible only on matters the caller may access (P5
    // checkPermission: same firm + membership + clearance). Every new output
    // has a matterId, and all its documents belong to that matter. Legacy rows
    // written before matterId was required stay readable by their author only.
    if (cleared.some((row) => row.matterId)) {
      await syncFirmMembers(store, repos, actor.firmId)
      // Audit F14 R2-D1: each output's matter is judged at its current label.
      await syncFirmMatters(store, repos, actor.firmId)
    }
    const matterAccess = new Map<string, boolean>()
    const visible: CommitteeBrainOutput[] = []
    for (const row of cleared) {
      if (!row.matterId) {
        if (row.actorId === actor.id) visible.push(row)
        continue
      }
      let allowed = matterAccess.get(row.matterId)
      if (allowed === undefined) {
        allowed = (await canAccessMatter(store, repos, actor, row.matterId, "committee_brain_read"))
          .allow
        matterAccess.set(row.matterId, allowed)
      }
      if (allowed) visible.push(row)
    }
    const all = visible
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    const items = all.slice(cursor, cursor + limit)
    const nextCursor = cursor + items.length < all.length ? String(cursor + items.length) : null

    return NextResponse.json({
      items,
      total: all.length,
      limit,
      cursor,
      nextCursor,
    })
  } catch (err) {
    const message = publicErrorMessage(err, "committee brain read failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}

export async function POST(request: Request) {
  return withSession(request, handlePost)
}

type Dispatch = { kind: "functions"; baseUrl: string; authorization: string } | { kind: "local" }

/**
 * Audit F18 (spec docs/superpowers/specs/2026-10-18-f18-legacy-ai-path-closed-design.md, R1, R3, R4, R5): where the
 * committee call runs. A Firebase session is forwarded, with the caller's own token, to the canonical Cloud Functions P1
 * route, where the kill switches, the budget and the cost log apply. Everything else runs the local P1 pipeline, which
 * has no provider transport and so records a blocked row:
 *   - an insecure-dev session (local and tests only; it has no ID token to forward);
 *   - no usable Functions base URL (an alert line in production);
 *   - a provider key in this runtime under NODE_ENV=production (callCommitteeBrain refuses it with its alert line).
 */
function chooseDispatch(request: Request, session: HandlerSession | null): Dispatch {
  if (session?.mode !== "firebase") return { kind: "local" }
  const authorization = request.headers.get("authorization")
  if (!authorization) return { kind: "local" }
  if (process.env.NODE_ENV === "production" && providerKeysPresent().length > 0) return { kind: "local" }
  const baseUrl = functionsP1BaseUrl()
  if (!baseUrl) {
    if (process.env.NODE_ENV === "production") {
      console.error(`[p1] ALERT ${FUNCTIONS_NOT_CONFIGURED_ALERT}`, { route: "/api/p1/committee-brain" })
    }
    return { kind: "local" }
  }
  // Outside production a key is not refused (no paid path exists here), but its alert line is still logged.
  checkProviderKeys("next")
  return { kind: "functions", baseUrl, authorization }
}

const FORWARD_FAILURE_MESSAGES: Record<string, string> = {
  p1_functions_unavailable: "Cloud Functions P1 did not answer; retry with the same Idempotency-Key",
  p1_functions_timeout: "Cloud Functions P1 did not answer in time; retry with the same Idempotency-Key",
  p1_functions_bad_answer: "Cloud Functions P1 answered with something that is not a committee answer",
}

async function handlePost(request: Request, session: HandlerSession | null) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message =
      err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }
  let parsed: Body
  try {
    parsed = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!parsed.actorId || typeof parsed.actorId !== "string") {
    return NextResponse.json({ error: "actorId is required" }, { status: 400 })
  }
  if (!parsed.body || typeof parsed.body !== "string") {
    return NextResponse.json({ error: "body is required" }, { status: 400 })
  }
  if (parsed.classification !== undefined && !isClassification(parsed.classification)) {
    return NextResponse.json(
      { error: "classification must be a rank-0–4 label" },
      { status: 400 }
    )
  }
  const requestedClassification: Classification | undefined = parsed.classification
  // H1: free text has no trustworthy label of its own, so every request must
  // name the matter it belongs to; the text inherits that matter's (and its
  // documents') classification.
  if (typeof parsed.matterId !== "string" || !parsed.matterId) {
    return NextResponse.json(
      { error: "matterId is required", code: "matter_required" },
      { status: 400 }
    )
  }
  const matterId: string = parsed.matterId
  if (
    parsed.documentIds !== undefined &&
    (!Array.isArray(parsed.documentIds) ||
      !parsed.documentIds.every((id) => typeof id === "string" && id.length > 0))
  ) {
    return NextResponse.json({ error: "documentIds must be an array of ids" }, { status: 400 })
  }
  const requestedPartyNames = Array.isArray(parsed.partyNames)
    ? parsed.partyNames.filter((n) => typeof n === "string" && n.length > 0)
    : []
  // I1: purpose travels to the provider in metadata, so it is a fixed
  // server-side value, never caller free text.
  if (parsed.purpose !== undefined && !isCommitteePurpose(parsed.purpose)) {
    return NextResponse.json(
      { error: "purpose must be one of: " + COMMITTEE_PURPOSES.join(", "), code: "invalid_purpose" },
      { status: 400 }
    )
  }
  const purpose: CommitteePurpose = isCommitteePurpose(parsed.purpose) ? parsed.purpose : "committee-brain"
  const fingerprint = fingerprintOf({
    route: "/api/p1/committee-brain",
    actorId: parsed.actorId,
    body: parsed.body,
    classification: requestedClassification ?? null,
    matterId,
    documentIds: parsed.documentIds ?? [],
    purpose,
    partyNames: requestedPartyNames,
  })
  // Final audit F4: check-and-reserve the key in one synchronous step (no await in between).
  const idem = await beginIdempotentRequest(request, key, fingerprint)
  if (idem.response) return idem.response
  const claim = idem.claim

  try {
    const actor = requireActor(parsed.actorId)
    // Audit F14 R2-D1: the scope (permission and the classification that drives provider policy) is decided on the
    // matter's current label and the caller's current membership, as persisted.
    await syncFirmMembers(store, repos, actor.firmId)
    await syncFirmMatters(store, repos, actor.firmId)
    let scope
    try {
      scope = await resolveCommitteeScope(store, repos, actor, {
        matterId,
        documentIds: parsed.documentIds,
      })
    } catch (err) {
      if (err instanceof CommitteeScopeError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status }
        )
      }
      throw err
    }
    // H1: the derived classification is authoritative; a caller label may
    // only make it stricter. N1: caller-authored free text is never rank 0 —
    // anyone can create a "public" matter, so text the server did not build
    // from referenced records is floored at internal. The P1 provider table
    // (L18 §4.6) then decides where each rank may go.
    const labels: Classification[] = [scope.classification]
    if (requestedClassification) labels.push(requestedClassification)
    labels.push(FREE_TEXT_FLOOR) // `body` is required, so it is always caller text
    const classification: Classification = strictestClassification(labels) ?? scope.classification
    const partyNames = [...new Set([...scope.partyNames, ...requestedPartyNames])]
    if (rankOf(actor.clearanceLevel) < rankOf(classification)) {
      return NextResponse.json(
        { error: "actor clearance is below requested committee classification" },
        { status: 403 }
      )
    }

    const dispatch = chooseDispatch(request, session)
    if (dispatch.kind === "functions") {
      // R7: the strictest derived label travels as the caller's label (Functions takes the strictest again, so it is
      // never lower); documents are not forwarded (Functions refuses them; their one effect is that label). R6: Next
      // marks no effect of its own and writes nothing here, so a same-key retry reaches Functions' own fence (F09).
      const forwarded = await forwardCommitteeBrain(dispatch.baseUrl, {
        authorization: dispatch.authorization,
        firmId: actor.firmId,
        idempotencyKey: key,
        payload: {
          matterId: scope.matterId ?? matterId,
          body: parsed.body,
          purpose,
          classification,
          partyNames: [...new Set(partyNames.map((name) => name.trim()).filter((name) => name !== ""))],
        },
      })
      if (forwarded.kind === "answer") {
        const payload = { ...forwarded.body, agent: "sikander-ai" }
        claim.complete(payload)
        return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
      }
      if (forwarded.kind === "refused") {
        return NextResponse.json(
          { error: forwarded.code, code: forwarded.code },
          { status: forwarded.status, headers: forwarded.retryAfter ? { "Retry-After": forwarded.retryAfter } : undefined }
        )
      }
      return NextResponse.json(
        { error: FORWARD_FAILURE_MESSAGES[forwarded.code] ?? forwarded.code, code: forwarded.code },
        { status: forwarded.status }
      )
    }

    const result = await callCommitteeBrain({
      body: parsed.body,
      classification,
      provider: "ai-gateway",
      purpose,
      partyNames: partyNames.length > 0 ? partyNames : undefined,
    })
    const output: CommitteeBrainOutput = {
      id: store.id("cbo"),
      firmId: actor.firmId,
      actorId: actor.id,
      classification,
      matterId: scope.matterId,
      documentIds: scope.documentIds,
      purpose,
      blocked: result.blocked,
      reason: result.reason,
      text: result.text,
      outbound: result.outbound,
      createdAt: Date.now(),
    }
    await repos.committeeOutputs.create(output)
    store.committeeOutputs.set(output.id, output)

    const payload = {
      outputId: output.id,
      blocked: result.blocked,
      reason: result.reason,
      text: result.text,
      outbound: result.outbound,
      agent: "sikander-ai",
    }
    claim.complete(payload)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = publicErrorMessage(err, "committee brain write failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
