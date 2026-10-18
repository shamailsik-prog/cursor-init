import { NextResponse } from "next/server"
import { parseLimit, parseCursor } from "@/platform/http/pagination"
import { BodySchema, DOCUMENTS_SURFACE } from "./surface"
import { z } from "zod"
import { PublicError } from "@/platform/http/publicError"
import { actionOf, getQuery, refuseUndeclaredBody } from "@/platform/http/surface"
import { withSession, type SessionRouteOptions } from "@/platform/http/withSession"
import { REQUEST_FAILED_CODE, publicErrorMessage } from "@/platform/http/errors"
import {
  beginIdempotentRequest,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import {
  base64DecodedLength,
  maxUploadBytes,
  maxUploadRequestBytes,
  fingerprintOf,
  parseBody,
  payloadTooLarge,
  readJsonLimited,
} from "@/platform/http/validation"
import { rankOf, rankOfStoredOrMax, type DocumentRecord, type SpineStore } from "@/platform/spine/store"
import { isClassification, type Classification } from "@/platform/p1/types"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMatters, syncFirmMembers } from "@/platform/persistence/memberSync"
import {
  assertDocumentObjectIngestAllowed,
  DocumentObjectConfigurationError,
  getImmutableDocumentObject,
} from "@/platform/documents/documentObjectStore"
import type { SpineRepositories } from "@/platform/persistence/spineRepositories"
import { rollbackDocumentIngest, uploadDocument } from "@/services/d1-6/uploadDocument"
import { canReadDocument, canUseLooseVault } from "@/platform/p5/documentAccess"



type Body = z.infer<typeof BodySchema>

function requireActor(actorId: string, firmId?: string) {
  const store = getRuntimeStore()
  const actor = store.users.get(actorId)
  if (!actor) throw new PublicError("unknown actor")
  if (firmId && actor.firmId !== firmId) throw new PublicError("cross-firm actor denied")
  if (actor.role === "client" || actor.role === "intern" || actor.role === "accounts") {
    throw new PublicError("actor role not allowed for document ingest")
  }
  return actor
}

const DEFAULT_INGEST_CLASSIFICATION: Classification = "privileged"

/**
 * Client-sourced ingest channels (L17.3 "default privileged for client-sourced material").
 * Review R1 #9: these are floored at privileged even when the uploader labels them lower.
 * The spec's client portal was dropped in favour of L8.1 WhatsApp self-service and §4 lists no
 * email intake channel, so WhatsApp is the only one today; team_portal is the staff upload
 * portal (L18 §10.1 "Team Upload Portal"). Add any new client-facing channel here.
 */
const CLIENT_SOURCED_CHANNELS: ReadonlySet<string> = new Set(["whatsapp"])

/** max(privileged, matter classification); an unreadable matter label floors at the most restrictive. */
function defaultIngestClassification(matterClassification: unknown): Classification {
  if (matterClassification === undefined) return DEFAULT_INGEST_CLASSIFICATION
  if (!isClassification(matterClassification)) return "privileged-restricted"
  return rankOf(matterClassification) > rankOf(DEFAULT_INGEST_CLASSIFICATION)
    ? matterClassification
    : DEFAULT_INGEST_CLASSIFICATION
}

async function rollbackFailedIngest(
  store: SpineStore,
  repos: SpineRepositories,
  docId: string,
  reused: boolean
): Promise<void> {
  if (reused) return
  await rollbackDocumentIngest(store, docId)
  await repos.documents.delete(docId)
}

function canViewDocument(
  store: SpineStore,
  userId: string,
  doc: Pick<DocumentRecord, "firmId" | "classification" | "matterId">
): boolean {
  const user = store.users.get(userId)
  if (!user) return false
  return canReadDocument(store, user, doc)
}

export async function GET(request: Request) {
  return withSession(request, handleGet, { surface: DOCUMENTS_SURFACE })
}

async function handleGet(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const userId = getQuery(DOCUMENTS_SURFACE, url, "userId")
  const matterId = getQuery(DOCUMENTS_SURFACE, url, "matterId")
  const docId = getQuery(DOCUMENTS_SURFACE, url, "docId")
  const includeContent = getQuery(DOCUMENTS_SURFACE, url, "includeContent")
  const limit = parseLimit(getQuery(DOCUMENTS_SURFACE, url, "limit"))
  const cursor = parseCursor(getQuery(DOCUMENTS_SURFACE, url, "cursor"))

  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  const user = store.users.get(userId)
  if (!user) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 })
  }
  await syncFirmMembers(store, repos, user.firmId)
  // Audit F14 / O-76: the read, the download and the list (with its OCR job counts) are judged at each matter's current label.
  await syncFirmMatters(store, repos, user.firmId)

  if (docId) {
    const doc = (await repos.documents.get(docId)) ?? store.documents.get(docId) ?? null
    if (!doc || doc.firmId !== user.firmId) {
      return NextResponse.json({ error: "unknown document" }, { status: 404 })
    }
    if (!canViewDocument(store, userId, doc)) {
      return NextResponse.json({ error: "document access denied" }, { status: 403 })
    }
    if (includeContent !== "true") {
      return NextResponse.json({ error: "includeContent=true is required to read object bytes" }, { status: 400 })
    }
    if (!doc.storagePath || doc.objectBytesStatus === "missing") {
      return NextResponse.json({ error: "document bytes unavailable" }, { status: 500 })
    }
    try {
      const bytes = await getImmutableDocumentObject(store, doc.firmId, doc.storagePath, doc.contentHash)
      return NextResponse.json({
        doc,
        contentBase64: bytes.toString("base64"),
        byteSize: bytes.length,
        contentHash: doc.contentHash,
      })
    } catch {
      return NextResponse.json({ error: "document bytes unavailable" }, { status: 500 })
    }
  }

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

// The boundary reads the (large) upload body once, under the same wire cap as the
// handler. Getters so SIKANDER_MAX_UPLOAD_BYTES is read per request, as the handler does.
const uploadBodyLimits: SessionRouteOptions = {
  get maxBodyBytes() {
    return maxUploadRequestBytes()
  },
  get reportedBodyLimit() {
    return maxUploadBytes()
  },
}

export async function POST(request: Request) {
  return withSession(request, handlePost, { ...uploadBodyLimits, surface: DOCUMENTS_SURFACE })
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

  const uploadLimit = maxUploadBytes()
  const raw = await readJsonLimited(request, maxUploadRequestBytes(), uploadLimit)
  if (!raw.ok) return raw.response
  const undeclared = refuseUndeclaredBody(DOCUMENTS_SURFACE, raw.data)
  if (undeclared) return undeclared
  const body = parseBody(BodySchema, raw.data)
  if (!body.ok) return body.response
  const parsed: Body = body.data
  if (base64DecodedLength(parsed.contentBase64) > uploadLimit) {
    return payloadTooLarge(uploadLimit)
  }

  const fingerprint = fingerprintOf({
    route: "/api/d1/documents",
    action: actionOf(DOCUMENTS_SURFACE, parsed),
    body: parsed,
  })
  // Final audit F4: check-and-reserve the key in one synchronous step (no await in between).
  const idem = await beginIdempotentRequest(request, key, fingerprint)
  if (idem.response) return idem.response
  const claim = idem.claim

  try {
    const actor = requireActor(parsed.actorId, parsed.firmId)
    await syncFirmMembers(store, repos, actor.firmId)
    // Audit F14 R2-D1: the matter checks below (member, floor) and the ingest default use its current label.
    await syncFirmMatters(store, repos, actor.firmId)
    const matterId = parsed.matterId ?? null
    const matterForDefault = matterId ? store.matters.get(matterId) : undefined
    // L17.3 Human control: "Initial classification set at ingest (default privileged for
    // client-sourced material)". Material arriving without a label is treated as
    // client-sourced; the default is floored at the matter's classification.
    let classification: Classification =
      parsed.classification ?? defaultIngestClassification(matterForDefault?.classification)
    if (
      CLIENT_SOURCED_CHANNELS.has(parsed.sourceChannel) &&
      rankOf(classification) < rankOf(DEFAULT_INGEST_CLASSIFICATION)
    ) {
      classification = DEFAULT_INGEST_CLASSIFICATION
    }
    if (rankOf(actor.clearanceLevel) < rankOf(classification)) {
      return NextResponse.json(
        { error: "actor clearance is below requested document classification" },
        { status: 403 }
      )
    }
    if (!matterId && !canUseLooseVault(actor)) {
      // E-18: loose vault is clerk/partner with clearance >= confidential (as the rules' authorNew()).
      return NextResponse.json(
        { error: "loose vault is limited to clerk and partner roles with confidential clearance" },
        { status: 403 }
      )
    }
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
      if (rankOf(classification) < rankOfStoredOrMax(matter.classification)) {
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
    try {
      assertDocumentObjectIngestAllowed()
    } catch (err) {
      if (err instanceof DocumentObjectConfigurationError) {
        return NextResponse.json({ error: err.message }, { status: 503 })
      }
      throw err
    }
    const write = await uploadDocument(store, {
      firmId: parsed.firmId,
      matterId,
      bytes,
      sourceChannel: parsed.sourceChannel,
      classification,
      idempotencyKey: key,
      callerClearance: actor.clearanceLevel,
      uploadedBy: actor.id,
      mimeType: parsed.mimeType,
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
        storagePath: inMemoryDoc.storagePath,
        isImmutable: inMemoryDoc.isImmutable,
        byteSize: inMemoryDoc.byteSize,
        mimeType: inMemoryDoc.mimeType,
        objectVersion: inMemoryDoc.objectVersion,
        uploadedBy: inMemoryDoc.uploadedBy,
        objectBytesStatus: inMemoryDoc.objectBytesStatus,
      })
    } else {
      try {
        await repos.documents.create(inMemoryDoc)
      } catch (persistErr) {
        await rollbackFailedIngest(store, repos, write.docId, write.reused)
        throw persistErr
      }
    }
    const jobsForDocument = store.jobs.filter((job) => job.documentId === write.docId)
    try {
      for (const job of jobsForDocument) {
        await repos.jobs.create(job)
      }
    } catch (persistErr) {
      await rollbackFailedIngest(store, repos, write.docId, write.reused)
      throw persistErr
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

    const payload = {
      action: "ingest",
      doc,
      reused: write.reused,
      ocrJobs: (await repos.jobs.listByDocument(doc.id)).filter((job) => job.jobType === "ocr")
        .length,
    }
    claim.complete(payload)
    return NextResponse.json({ result: payload, idempotencyKey: key, reused: write.reused })
  } catch (err) {
    if (err instanceof DocumentObjectConfigurationError) {
      return NextResponse.json({ error: err.message }, { status: 503 })
    }
    const message = publicErrorMessage(err, "document ingest failed")
    return NextResponse.json({ error: message, code: REQUEST_FAILED_CODE }, { status: 400 })
  }
}
