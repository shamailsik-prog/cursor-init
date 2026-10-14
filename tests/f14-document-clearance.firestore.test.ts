import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as mattersPost } from "@/app/api/d1/matters/route"
import { GET as documentsGet, POST as documentsPost } from "@/app/api/d1/documents/route"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { GET as courtOpsGet, POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { GET as committeeGet, POST as committeePost } from "@/app/api/p1/committee-brain/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { testAdminFirestore } from "@/tests/helpers/admin-firestore"

/**
 * Audit F14 (rounds 1 and 2): in Next Firestore mode, which #37 made production-real, every route that judges matter
 * access reads the matter's CURRENT label from Firestore, not this process's cached copy. Each case caches a matter at
 * `internal` in this process (created, ingested and read through the routes), then raises it to `privileged-restricted`
 * straight in Firestore, as another process would (Cloud Functions, an operator, a partner's monotonic client update).
 *
 * The cases run on a Firestore emulator project of their own, so the rows they write never reach another suite's
 * counts (tests/persistence.runtime-mode.test.ts pages and totals the shared project's firmA rows). Run through
 * `npm run test:rules` (the emulator); skipped without one.
 */

// The first case pays for the Admin SDK's first emulator connection (about 10 s on a loaded machine), as the
// rules suites do: the same generous timeout they set.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const PROJECT = "sikander-f14-runtime"
const db = () => testAdminFirestore(PROJECT)
const B = "http://127.0.0.1"

let keySeq = 0
const idemKey = () => `f14f14f3-4f14-4f14-8f14-${String(++keySeq).padStart(12, "0")}`
const post = (handler: (r: Request) => Promise<Response>, url: string, body: unknown) =>
  handler(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idemKey() }, body: JSON.stringify(body) }))

const ingest = (actorId: string, matterId: string, bytes: string, classification: string) =>
  post(documentsPost, `${B}/api/d1/documents`, {
    action: "ingest",
    actorId,
    firmId: "firmA",
    matterId,
    contentBase64: Buffer.from(bytes).toString("base64"),
    sourceChannel: "web",
    classification,
  })

/** Another process raises the matter in Firestore; this process still holds the old label. */
async function raiseElsewhere(matterId: string): Promise<void> {
  await db().collection("matters").doc(matterId).update({ classification: "privileged-restricted" })
  expect(getRuntimeStore().matters.get(matterId)?.classification).toBe("internal")
}

/** An internal matter (partner, associate, clerk) and a plaint on it, created through the routes and cached here. */
async function seed(title: string, opts: { blockWorkflow?: boolean } = {}): Promise<{ matterId: string; docId: string; bytes: string }> {
  const created = await post(mattersPost, `${B}/api/d1/matters`, {
    action: "create",
    actorId: "partner_a",
    firmId: "firmA",
    clientId: "client_a",
    title,
    courtId: "SHC",
    classification: "internal",
    memberUserIds: ["associate_a", "clerk_a"],
  })
  expect(created.status).toBe(200)
  const matterId = ((await created.json()) as { result: { matter: { id: string } } }).result.matter.id
  const bytes = `%PDF-f14-${title}%`
  const ingested = await ingest("partner_a", matterId, bytes, "internal")
  expect(ingested.status).toBe(200)
  const docId = ((await ingested.json()) as { result: { doc: { id: string } } }).result.doc.id
  if (opts.blockWorkflow) {
    const blocked = await post(workflowPost, `${B}/api/d1/document-workflow`, { action: "transition", actorId: "partner_a", documentId: docId, nextStatus: "review_required" })
    expect(blocked.status).toBe(200)
  }
  return { matterId, docId, bytes }
}

const workflowStatus = async (docId: string) => (await db().collection("document_workflow").doc(docId).get()).get("status")

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("F14: Next Firestore-mode routes judge the matter's current label (a raise written by another process)", () => {
  beforeEach(() => {
    resetRuntimeStoreForTests()
    process.env.SIKANDER_PERSISTENCE_MODE = "firestore"
    setFirestorePersistenceForTests(db())
  })
  afterEach(() => {
    delete process.env.SIKANDER_PERSISTENCE_MODE
    setFirestorePersistenceForTests(null)
  })

  it("documents GET: after a raise elsewhere the clerk's download is 403 and the list leaves the document out (round 1, O-76)", async () => {
    const { matterId, docId } = await seed("download")
    const read = (userId: string) => documentsGet(new Request(`${B}/api/d1/documents?userId=${userId}&docId=${docId}&includeContent=true`))
    expect((await read("clerk_a")).status).toBe(200)

    await raiseElsewhere(matterId)

    expect((await read("clerk_a")).status).toBe(403)
    const list = await documentsGet(new Request(`${B}/api/d1/documents?userId=clerk_a&matterId=${matterId}&limit=10&cursor=0`))
    expect(list.status).toBe(200)
    expect(JSON.stringify(await list.json())).not.toContain(docId)
    expect((await read("partner_a")).status).toBe(200)
  })

  it("documents ingest: after a raise elsewhere the clerk's dedup re-upload and a below-floor upload are refused (R2-D1)", async () => {
    const { matterId, docId, bytes } = await seed("ingest")
    await raiseElsewhere(matterId)

    // Identical bytes (the dedup path) and new bytes, both at the matter's old label: below its floor now.
    for (const content of [bytes, "%PDF-f14-new-by-clerk%"]) {
      const res = await ingest("clerk_a", matterId, content, "internal")
      const text = await res.text()
      expect([res.status, text.includes(docId)]).toEqual([400, false])
      expect(text).toContain("document classification cannot be lower than matter classification")
    }
    // At the raised label the clerk is not cleared to write.
    expect((await ingest("clerk_a", matterId, "%PDF-f14-pr-by-clerk%", "privileged-restricted")).status).toBe(403)
    // The cleared partner's upload below the new floor is refused too; at the floor it is accepted.
    expect((await ingest("partner_a", matterId, "%PDF-f14-low-by-partner%", "internal")).status).toBe(400)
    expect((await ingest("partner_a", matterId, "%PDF-f14-pr-by-partner%", "privileged-restricted")).status).toBe(200)
  })

  it("court-ops: after a raise elsewhere the clerk loses the queue row and cannot resolve it; the cleared partner still can (R2-D1)", async () => {
    const { matterId, docId } = await seed("court-ops", { blockWorkflow: true })
    const queue = async (userId: string) => {
      const res = await courtOpsGet(new Request(`${B}/api/d2/court-ops?userId=${userId}&limit=50&cursor=0`))
      expect(res.status).toBe(200)
      return res.text()
    }
    const resolve = (actorId: string) =>
      post(courtOpsPost, `${B}/api/d2/court-ops`, { action: "resolve_workflow", actorId, documentId: docId, nextStatus: "processing", reason: `f14 ${actorId}` })
    expect(await queue("clerk_a")).toContain(docId)

    await raiseElsewhere(matterId)

    expect(await queue("clerk_a")).not.toContain(docId)
    const refused = await resolve("clerk_a")
    expect(refused.status).toBe(400)
    expect(await refused.text()).not.toContain(matterId)
    expect(await workflowStatus(docId)).toBe("review_required")

    expect(await queue("partner_a")).toContain(docId)
    expect((await resolve("partner_a")).status).toBe(200)
    expect(await workflowStatus(docId)).toBe("processing")
  })

  it("court-ops resolve_workflow in a fresh process after a raise: the cleared partner resolves (200), the clerk is refused (R2-D2)", async () => {
    const { matterId, docId } = await seed("fresh-process", { blockWorkflow: true })
    await raiseElsewhere(matterId)
    // A fresh process: nothing cached but the seeded identities.
    resetRuntimeStoreForTests()
    setFirestorePersistenceForTests(db())
    expect(getRuntimeStore().matters.has(matterId)).toBe(false)

    const resolve = (actorId: string) =>
      post(courtOpsPost, `${B}/api/d2/court-ops`, { action: "resolve_workflow", actorId, documentId: docId, nextStatus: "processing", reason: `f14 fresh ${actorId}` })
    expect((await resolve("clerk_a")).status).toBe(400)
    expect((await resolve("partner_a")).status).toBe(200)
    expect(await workflowStatus(docId)).toBe("processing")
  })

  it("committee-brain: after a raise elsewhere the clerk's request is refused, the clerk's earlier output is no longer listed, and the partner's output takes the raised label (R2-D1)", async () => {
    const { matterId, docId } = await seed("committee")
    const ask = (actorId: string) =>
      post(committeePost, `${B}/api/p1/committee-brain`, {
        actorId,
        body: "Summarise the plaint for the file.",
        matterId,
        documentIds: [docId],
        classification: "internal",
        purpose: "summarise",
      })
    const listed = async (actorId: string) => {
      const res = await committeeGet(new Request(`${B}/api/p1/committee-brain?actorId=${actorId}&limit=50&cursor=0`))
      expect(res.status).toBe(200)
      return ((await res.json()) as { items: Array<{ id: string }> }).items.map((row) => row.id)
    }
    const before = await ask("clerk_a")
    expect(before.status).toBe(200)
    const clerkOutputId = ((await before.json()) as { result: { outputId: string } }).result.outputId
    expect(await listed("clerk_a")).toContain(clerkOutputId)

    await raiseElsewhere(matterId)

    expect((await ask("clerk_a")).status).toBe(403)
    expect(await listed("clerk_a")).not.toContain(clerkOutputId)
    const partner = await ask("partner_a")
    expect(partner.status).toBe(200)
    const partnerOutputId = ((await partner.json()) as { result: { outputId: string } }).result.outputId
    // The label that drives provider policy is the matter's current one, not the cached internal.
    expect((await db().collection("committee_outputs").doc(partnerOutputId).get()).get("classification")).toBe("privileged-restricted")
  })

  it("a matter deleted elsewhere leaves this process's cache: the next requests deny its document, its listed OCR jobs, ingest and committee-brain (C3)", async () => {
    const { matterId, docId } = await seed("deleted")
    const read = (userId: string) => documentsGet(new Request(`${B}/api/d1/documents?userId=${userId}&docId=${docId}&includeContent=true`))
    const listed = async (userId: string) => {
      const res = await documentsGet(new Request(`${B}/api/d1/documents?userId=${userId}&limit=100&cursor=0`))
      expect(res.status).toBe(200)
      return res.text()
    }
    expect((await read("clerk_a")).status).toBe(200)
    expect(await listed("partner_a")).toContain(docId)

    // Another process deletes the matter row; this process still holds its copy.
    await db().collection("matters").doc(matterId).delete()
    expect(getRuntimeStore().matters.has(matterId)).toBe(true)

    for (const userId of ["clerk_a", "partner_a"]) {
      expect((await read(userId)).status).toBe(403)
      // The list (each row carries its OCR job count) leaves the document out.
      expect(await listed(userId)).not.toContain(docId)
    }
    expect(getRuntimeStore().matters.has(matterId)).toBe(false)
    const ingested = await ingest("partner_a", matterId, "%PDF-f14-after-delete%", "privileged-restricted")
    expect(ingested.status).toBe(404)
    const asked = await post(committeePost, `${B}/api/p1/committee-brain`, {
      actorId: "partner_a",
      body: "Summarise the plaint for the file.",
      matterId,
      documentIds: [docId],
      classification: "internal",
      purpose: "summarise",
    })
    expect(asked.status).toBe(404)
  })

  it("a matter moved to another firm elsewhere leaves this firm's cache: its document is refused and unlisted, its ingest refused (C3)", async () => {
    const { matterId, docId } = await seed("moved")
    const read = (userId: string) => documentsGet(new Request(`${B}/api/d1/documents?userId=${userId}&docId=${docId}&includeContent=true`))
    expect((await read("partner_a")).status).toBe(200)

    await db().collection("matters").doc(matterId).update({ firmId: "firmB" })
    expect(getRuntimeStore().matters.get(matterId)?.firmId).toBe("firmA")

    expect((await read("partner_a")).status).toBe(403)
    const list = await documentsGet(new Request(`${B}/api/d1/documents?userId=partner_a&limit=100&cursor=0`))
    expect(await list.text()).not.toContain(docId)
    expect(getRuntimeStore().matters.has(matterId)).toBe(false)
    expect((await ingest("partner_a", matterId, "%PDF-f14-after-move%", "privileged-restricted")).status).toBe(404)
  })

  it("a document row whose matterId is missing or empty is not the loose vault: the clerk's download is 403 and the list leaves it out (C2)", async () => {
    // Rows no route writes (the API takes a matter id of at least one character, or null): written straight to
    // Firestore, as a malformed import or another writer could. A loose-vault row with an explicit null is the control.
    const row = (id: string) => ({
      id,
      firmId: "firmA",
      contentHash: `hash-${id}`,
      sourceChannel: "web",
      classification: "internal",
      storagePath: `fs://firmA/documents/${id}/v1`,
      isImmutable: true,
      byteSize: 1,
      mimeType: "application/pdf",
      objectVersion: 1,
      uploadedBy: "partner_a",
      objectBytesStatus: "available",
    })
    await db().collection("documents").doc("f14c2missing").set(row("f14c2missing"))
    await db().collection("documents").doc("f14c2empty").set({ ...row("f14c2empty"), matterId: "" })
    await db().collection("documents").doc("f14c2null").set({ ...row("f14c2null"), matterId: null })

    for (const docId of ["f14c2missing", "f14c2empty"]) {
      const res = await documentsGet(new Request(`${B}/api/d1/documents?userId=clerk_a&docId=${docId}&includeContent=true`))
      expect(res.status).toBe(403)
    }
    const list = await documentsGet(new Request(`${B}/api/d1/documents?userId=clerk_a&limit=100&cursor=0`))
    expect(list.status).toBe(200)
    const text = await list.text()
    expect(text).not.toContain("f14c2missing")
    expect(text).not.toContain("f14c2empty")
    expect(text).toContain("f14c2null")
  })
})
