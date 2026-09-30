import { NextResponse } from "next/server"
import { PublicError } from "@/platform/http/publicError"
import { withSession } from "@/platform/http/withSession"
import { REQUEST_FAILED_CODE, publicErrorMessage } from "@/platform/http/errors"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification } from "@/platform/p1/types"
import { rankOf, rankOfStoredOrMax, type DocumentRecord, type SpineStore } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { uploadDocument } from "@/services/d1-6/uploadDocument"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)

type SourceChannel = "web" | "team_portal" | "whatsapp" | "bulk"

type IngestBody = {
  action: "ingest"
  actorId?: string
  firmId?: string
  matterId?: string | null
  contentBase64?: string
  sourceChannel?: SourceChannel
  classification?: string
}

type Body = IngestBody

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 25
  if (!Number.isFinite(parsed) || parsed < 1) return 25
  return Math.min(parsed, 100)
}

function parseCursor(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 0
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

function isSourceChannel(value: unknown): value is SourceChannel {
  return (
    value === "web" ||
    value === "team_portal" ||
    value === "whatsapp" ||
    value === "bulk"
  )
}

function requireActor(actorId: string, firmId?: string) {
  const store = getRuntimeStore()
  const actor = store.users.get(actorId)
  if (!actor) throw new PublicError("unknown actor")
  if (firmId && actor.firmId !== firmId) throw new PublicError("cross-firm actor denied")
  if (actor.role === "client" || actor.role === "intern") {
    throw new PublicError("actor role not allowed for document ingest")
  }
  return actor
}

function canViewDocument(
  store: SpineStore,
  userId: string,
  doc: Pick<DocumentRecord, "firmId" | "classification" | "matterId">
): boolean {
  const user = store.users.get(userId)
  if (!user) return false
  if (user.firmId !== doc.firmId) return false
  if (rankOf(user.clearanceLevel) < rankOfStoredOrMax(doc.classification)) return false
  if (doc.matterId) {
    return store.members.has(store.memberKey(doc.matterId, userId))
  }
  return user.role !== "client" && user.role !== "intern"
}

export async function GET(request: Request) {
  return withSession(request, handleGet)
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const userId = url.searchParams.get("userId")
  const matterId = url.searchParams.get("matterId")
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))

  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  const user = store.users.get(userId)
  if (!user) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 })
  }
  await syncFirmMembers(store, repos, user.firmId)
  const firmDocs = await repos.documents.listByFirm(user.firmId)
  const firmJobs = await repos.jobs.listByFirm(user.firmId)
  const ocrJobCounts = new Map<string, number>()
  for (const job of firmJobs) {
    if (job.jobType !== "ocr") continue
    ocrJobCounts.set(job.documentId, (ocrJobCounts.get(job.documentId) ?? 0) + 1)
  }
  const visible = firmDocs
    .filter((doc) => (matterId ? doc.matterId === matterId : true))
    .filter((doc) => canViewDocument(store, userId, doc))
    .sort((a, b) => a.id.localeCompare(b.id))

  const items = visible.slice(cursor, cursor + limit).map((doc) => ({
    ...doc,
    ocrJobs: ocrJobCounts.get(doc.id) ?? 0,
  }))
  const nextCursor = cursor + items.length < visible.length ? String(cursor + items.length) : null

  return NextResponse.json({
    items,
    total: visible.length,
    limit,
    cursor,
    nextCursor,
  })
}

export async function POST(request: Request) {
  return withSession(request, handlePost)
}

async function handlePost(request: Request) {
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

  if (parsed.action !== "ingest") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  }
  if (!parsed.actorId || !parsed.firmId || !parsed.contentBase64) {
    return NextResponse.json(
      { error: "actorId, firmId, and contentBase64 are required" },
      { status: 400 }
    )
  }
  if (!isClassification(parsed.classification)) {
    return NextResponse.json(
      { error: "classification must be a rank-0–4 label" },
      { status: 400 }
    )
  }
  if (!isSourceChannel(parsed.sourceChannel)) {
    return NextResponse.json({ error: "sourceChannel is invalid" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d1/documents",
    action: parsed.action,
    body: parsed,
  })
  const replay = idempotency.getReplay(key, fingerprint)
  if (replay.conflict) {
    return NextResponse.json(
      { error: "Idempotency-Key reused with a different request payload" },
      { status: 409 }
    )
  }
  if (replay.body !== undefined) {
    return NextResponse.json({ result: replay.body, idempotencyKey: key, reused: true })
  }

  try {
    const priorAuditCount = store.audit.length
    const actor = requireActor(parsed.actorId, parsed.firmId)
    await syncFirmMembers(store, repos, actor.firmId)
    if (rankOf(actor.clearanceLevel) < rankOf(parsed.classification)) {
      return NextResponse.json(
        { error: "actor clearance is below requested document classification" },
        { status: 403 }
      )
    }
    const matterId = parsed.matterId ?? null
    if (matterId) {
      const matter = store.matters.get(matterId)
      if (!matter) return NextResponse.json({ error: "unknown matter" }, { status: 404 })
      if (matter.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm matter denied" }, { status: 403 })
      }
      if (!store.members.has(store.memberKey(matterId, actor.id))) {
        return NextResponse.json(
          { error: "actor is not a member of this matter" },
          { status: 403 }
        )
      }
      if (rankOf(parsed.classification) < rankOfStoredOrMax(matter.classification)) {
        return NextResponse.json(
          { error: "document classification cannot be lower than matter classification" },
          { status: 400 }
        )
      }
    }

    const bytes = Buffer.from(parsed.contentBase64, "base64")
    if (bytes.length === 0) {
      return NextResponse.json({ error: "contentBase64 decodes to empty bytes" }, { status: 400 })
    }
    const write = uploadDocument(store, {
      firmId: parsed.firmId,
      matterId,
      bytes,
      sourceChannel: parsed.sourceChannel,
      classification: parsed.classification,
      idempotencyKey: key,
    })

    const inMemoryDoc = store.documents.get(write.docId)
    if (!inMemoryDoc) {
      return NextResponse.json({ error: "document write failed" }, { status: 500 })
    }
    const persisted = await repos.documents.get(write.docId)
    if (persisted) {
      await repos.documents.update(write.docId, {
        contentHash: inMemoryDoc.contentHash,
        classification: inMemoryDoc.classification,
        sourceChannel: inMemoryDoc.sourceChannel,
        matterId: inMemoryDoc.matterId,
      })
    } else {
      await repos.documents.create(inMemoryDoc)
    }
    const jobsForDocument = store.jobs.filter((job) => job.documentId === write.docId)
    for (const job of jobsForDocument) {
      await repos.jobs.create(job)
    }
    const doc = (await repos.documents.get(write.docId)) ?? inMemoryDoc
    if (!doc) {
      return NextResponse.json({ error: "document write failed" }, { status: 500 })
    }
    store.audit.push({
      action: "document_ingest",
      actorId: actor.id,
      target: doc.id,
      classification: doc.classification,
      reason: write.reused ? "reused" : "created",
    })
    await persistAuditEntriesSince(store, repos, priorAuditCount)

    const payload = {
      action: "ingest",
      doc,
      reused: write.reused,
      ocrJobs: (await repos.jobs.listByDocument(doc.id)).filter((job) => job.jobType === "ocr")
        .length,
    }
    idempotency.set(key, payload, fingerprint)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
  } catch (err) {
    const message = publicErrorMessage(err, "document ingest failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
