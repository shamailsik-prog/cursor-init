// Audit FA-D4-001-FU1 (MEDIUM): the court-ops acknowledgement row `workflow_ops_activity/ops:court_ops:ack:${queueType}:${id}`
// took both parts of its id from the request body and was written blind. Firm B acknowledges item X; firm A sends the
// same id, gets 200, and B's row now holds firm A (the FA-D4-001 re-audit reproduced it). FU1b: an id with `/` wrote a
// nested document no rule matches, and any queueType was stored.
//
// These tests drive the real POST /api/d2/court-ops in production mode: firebase auth with emulator ID tokens,
// SIKANDER_PERSISTENCE_MODE=firestore and the configured Firestore (the emulator), so every request goes through
// withSession, the F02 Functions router (asserted by its x-authority-path header) and then the Next core. Items are
// seeded through the Admin SDK as the repositories read them: follow_ups, document_workflow and documents rows of
// the actor's own firm and matter. Spec: docs/superpowers/specs/2026-10-24-fa-d4-001-fu1-firm-qualified-court-ops-acks-design.md.
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { F02_AUTHORITY_HEADER } from "@/platform/authority/f02Routes"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"
import { deleteFirmRows } from "@/tests/helpers/firm-cleanup"

requireAuthFirestoreEmulators("FA-D4-001-FU1 court-ops acknowledgement e2e")

const E2E_TIMEOUT_MS = 180_000
const COLL = "workflow_ops_activity"

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }

function useEmulatorVerifier(on: boolean): void {
  const seam = (session as unknown as SessionSeams).setIdTokenVerifierForTests
  seam?.(on ? async (token) => (await adminAuth().verifyIdToken(token, true)) as Awaited<ReturnType<Verifier>> : null)
}

function restart(): void {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  session.resetSessionStateForTests()
  resetProductionFirestoreForTests()
}

type Actor = { firmId: string; uid: string; token: string; matterId: string }
/** The firms and auth users this suite creates; afterAll deletes them (audit F42: an emulator e2e cleans up its firms). */
const created = { firmIds: new Set<string>(), uids: new Set<string>() }
const short = () => randomUUID().replaceAll("-", "").slice(0, 10)

/** A partner of a new firm, signed in on the Auth emulator, and a matter of that firm the partner is a member of. */
async function provisionActor(): Promise<Actor> {
  const ref = adminDb().collection("firms").doc()
  await ref.create({ name: `FU1 firm ${ref.id}`, dataResidency: "PK", plan: "internal" })
  const firmId = ref.id
  created.firmIds.add(firmId)
  const uid = adminDb().collection("users").doc().id
  created.uids.add(uid)
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  await adminAuth().setCustomUserClaims(uid, { firmId, role: "partner", clearanceLevel: "internal" })
  await adminDb().collection("users").doc(uid).set({ id: uid, firmId, role: "partner", clearanceLevel: "internal", active: true })
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is required")
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status} ${await res.text()}`)
  const { idToken } = (await res.json()) as { idToken: string }
  const matterId = `fu1-${short()}`
  const batch = adminDb().batch()
  batch.set(adminDb().collection("matters").doc(matterId), {
    id: matterId,
    firmId,
    clientId: `fu1-client-${firmId}`,
    title: `FU1 matter ${matterId}`,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification: "internal",
  })
  batch.set(adminDb().collection("matter_members").doc(`${matterId}_${uid}`), { matterId, userId: uid, firmId })
  await batch.commit()
  return { firmId, uid, token: idToken, matterId }
}

/** An open follow-up of the actor's firm and matter (the shape `store.id("fu")` gives: `fu_<uuid>`). */
async function seedFollowUp(a: Actor): Promise<string> {
  const id = `fu_${randomUUID()}`
  await adminDb().collection("follow_ups").doc(id).set({
    id, firmId: a.firmId, matterId: a.matterId, courtId: "SHC", raw: "CP ???", kind: "case_number_reject",
    status: "open", resolvedBy: null, resolvedAt: null,
  })
  return id
}

/** A document of the actor's matter in review_required: the workflow queue item is keyed by its document id. */
async function seedWorkflowItem(a: Actor): Promise<string> {
  const id = `doc_${randomUUID()}`
  await adminDb().collection("documents").doc(id).set({
    firmId: a.firmId, matterId: a.matterId, contentHash: "sha256:ab", sourceChannel: "web", classification: "internal",
    storagePath: `${a.firmId}/obj-${id}`, isImmutable: true, byteSize: 12, mimeType: "application/pdf", objectVersion: 1,
    uploadedBy: a.uid, objectBytesStatus: "available",
  })
  await adminDb().collection("document_workflow").doc(id).set({
    documentId: id, firmId: a.firmId, matterId: a.matterId, status: "review_required", reviewerId: null, updatedAt: Date.now(),
  })
  return id
}

type Answer = { status: number; body: Record<string, unknown> | null; authority: string | null }

async function ack(a: Actor, body: Record<string, unknown>): Promise<Answer> {
  const res = await courtOpsPost(
    new Request("http://127.0.0.1/api/d2/court-ops", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${a.token}`,
        "X-Firm-Id": a.firmId,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ action: "acknowledge_item", actorId: a.uid, ...body }),
    })
  )
  return { status: res.status, body: await res.json().catch(() => null), authority: res.headers.get(F02_AUTHORITY_HEADER) }
}

/** The error code, as the Next core answers it (`code`) or as the F02 Functions router relays it (`error.code`). */
const codeOf = (body: unknown): unknown => {
  const b = body as { error?: { code?: unknown } | string; code?: unknown } | null
  return (b?.error && typeof b.error === "object" ? b.error.code : undefined) ?? b?.code
}

const ackId = (firmId: string, queueType: string, itemId: string) => `ops:court_ops:ack:${firmId}:${queueType}:${itemId}`
const legacyId = (queueType: string, itemId: string) => `ops:court_ops:ack:${queueType}:${itemId}`
const rowAt = async (id: string) => (await adminDb().collection(COLL).doc(id).get()).data()

/** Every ack row of a firm, found by content (firmId + action), so the same query runs on main and on the fix. */
async function ackRowsOf(firmId: string) {
  const snap = await adminDb().collection(COLL).where("firmId", "==", firmId).get()
  return snap.docs
    .map((d): Record<string, unknown> => ({ id: d.id, ...d.data() }))
    .filter((r) => r.action === "court_ops_acknowledge")
}

async function ackAuditRowsOf(uid: string) {
  const snap = await adminDb().collection("audit_log").where("actorId", "==", uid).get()
  return snap.docs.map((d) => d.data()).filter((r) => r.action === "court_ops_acknowledge")
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("FA-D4-001-FU1: court-ops acknowledgements are firm-qualified", { timeout: E2E_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.GCLOUD_PROJECT ?? "demo-fa-d4-001-fu1")
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-fa-d4-001-fu1")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-fa-d4-001-fu1")
    restart()
    useEmulatorVerifier(true)
  })
  afterEach(() => {
    useEmulatorVerifier(false)
    vi.unstubAllEnvs()
    restart()
  })
  afterAll(async () => {
    const left = await deleteFirmRows({ firmIds: created.firmIds, uids: created.uids })
    expect(left.deleted, "the cleanup found this suite's rows").toBeGreaterThan(0)
    expect(left.remaining, "rows of this suite's firms left after cleanup").toBe(0)
  }, E2E_TIMEOUT_MS)

  it("FU1: firm A sending firm B's item id answers 404 and leaves B's acknowledgement row as it was", async () => {
    const [a, b] = [await provisionActor(), await provisionActor()]
    const x = await seedWorkflowItem(b)
    const rb = await ack(b, { queueType: "workflow", id: x, reason: "B acknowledged" })
    expect(rb.status, JSON.stringify(rb.body)).toBe(200)
    expect(rb.authority).toBe("functions")
    const bRows = await ackRowsOf(b.firmId)
    expect(bRows).toHaveLength(1)
    expect(bRows[0]).toMatchObject({ firmId: b.firmId, actorId: b.uid, documentId: x, queueType: "workflow", detail: "B acknowledged" })

    const ra = await ack(a, { queueType: "workflow", id: x, reason: "A overwrote" })
    // The finding itself first: B's acknowledgement row must survive A's request (on main A's 200 replaces it).
    expect(await ackRowsOf(b.firmId), "B's acknowledgement row was overwritten by firm A").toEqual(bRows)
    expect(await ackRowsOf(a.firmId)).toEqual([])
    expect(ra.status, JSON.stringify(ra.body)).toBe(404)
    expect(codeOf(ra.body)).toBe("court_ops_item_not_found")
    expect(ra.authority).toBe("functions")
    expect(bRows.map((r) => r.id)).toEqual([ackId(b.firmId, "workflow", x)])
    expect(await rowAt(legacyId("workflow", x))).toBeUndefined()
    expect(await rowAt(ackId(a.firmId, "workflow", x))).toBeUndefined()
    expect(await ackAuditRowsOf(a.uid)).toEqual([])
  })

  it("each firm acknowledging its own follow-up and workflow item keeps its own row at its firm-qualified id", async () => {
    const [a, b] = [await provisionActor(), await provisionActor()]
    const [fa, wa, fb, wb] = [await seedFollowUp(a), await seedWorkflowItem(a), await seedFollowUp(b), await seedWorkflowItem(b)]
    for (const [x, queueType, id] of [[a, "follow_up", fa], [a, "workflow", wa], [b, "follow_up", fb], [b, "workflow", wb]] as const) {
      const r = await ack(x, { queueType, id, reason: `${queueType} seen` })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body?.result).toMatchObject({ action: "acknowledge_item", queueType, id })
    }
    for (const [x, f, w] of [[a, fa, wa], [b, fb, wb]] as const) {
      const rows = await ackRowsOf(x.firmId)
      expect(rows.map((r) => r.id).sort()).toEqual([ackId(x.firmId, "follow_up", f), ackId(x.firmId, "workflow", w)].sort())
      const byType = Object.fromEntries(rows.map((r) => [String(r.queueType), r]))
      expect(byType.follow_up).toMatchObject({ followUpId: f, documentId: null, actorId: x.uid, source: "court_ops", status: "acknowledged" })
      expect(byType.workflow).toMatchObject({ documentId: w, followUpId: null, actorId: x.uid, source: "court_ops", status: "acknowledged" })
      expect((await ackAuditRowsOf(x.uid)).length).toBe(2)
    }
  })

  it("FU1b: an id with '/' or ':', an empty or oversized id, an unknown queueType or a non-string reason answers 400 and writes nothing", async () => {
    const a = await provisionActor()
    const f = await seedFollowUp(a)
    const tag = short()
    const crafted: Array<[Record<string, unknown>, string]> = [
      [{ queueType: "workflow", id: `p${tag}/sub/d${tag}` }, "court_ops_item_id_invalid"],
      [{ queueType: "follow_up", id: `${f}/sub/d${tag}` }, "court_ops_item_id_invalid"],
      [{ queueType: "follow_up", id: `${a.firmId}:follow_up:${f}` }, "court_ops_item_id_invalid"],
      [{ queueType: "follow_up", id: `${f}:x` }, "court_ops_item_id_invalid"],
      [{ queueType: "follow_up", id: "x".repeat(300) }, "court_ops_item_id_invalid"],
      [{ queueType: "follow_up", id: 7 }, "court_ops_item_id_invalid"],
      [{ queueType: `zz${tag}`, id: f }, "court_ops_queue_type_invalid"],
      [{ queueType: "follow_up ", id: f }, "court_ops_queue_type_invalid"],
      [{ queueType: a.firmId, id: `workflow:${f}` }, "court_ops_queue_type_invalid"],
      [{ queueType: "follow_up", id: f, reason: 42 }, "court_ops_reason_invalid"],
    ]
    for (const [body, code] of crafted) {
      const r = await ack(a, body)
      expect(r.status, `${JSON.stringify(body).slice(0, 80)} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(400)
      expect(codeOf(r.body), JSON.stringify(body).slice(0, 80)).toBe(code)
    }
    expect(await ackRowsOf(a.firmId)).toEqual([])
    expect((await adminDb().doc(`${COLL}/ops:court_ops:ack:workflow:p${tag}/sub/d${tag}`).get()).exists).toBe(false)
    expect((await adminDb().doc(`${COLL}/ops:court_ops:ack:follow_up:${f}/sub/d${tag}`).get()).exists).toBe(false)
    expect((await adminDb().collection(COLL).doc(legacyId(`zz${tag}`, f)).get()).exists).toBe(false)
    expect(await ackAuditRowsOf(a.uid)).toEqual([])
  })

  it("an id that names no item of the caller's firm answers 404 and writes nothing", async () => {
    const a = await provisionActor()
    for (const queueType of ["follow_up", "workflow"]) {
      const r = await ack(a, { queueType, id: `fu1-unknown-${short()}` })
      expect(r.status, JSON.stringify(r.body)).toBe(404)
      expect(codeOf(r.body)).toBe("court_ops_item_not_found")
    }
    expect(await ackRowsOf(a.firmId)).toEqual([])
    expect(await ackAuditRowsOf(a.uid)).toEqual([])
  })

  it("concurrent acknowledgements by two firms of their own items: every answer 200, exactly one row per firm and item", async () => {
    const [a, b] = [await provisionActor(), await provisionActor()]
    const items = new Map([[a, await seedWorkflowItem(a)], [b, await seedWorkflowItem(b)]])
    const ops: Promise<Answer>[] = []
    const reasons = new Map<Actor, string[]>([[a, []], [b, []]])
    for (let i = 0; i < 3; i++) {
      for (const x of [a, b]) {
        const reason = `ack ${i} by ${x === a ? "A" : "B"}`
        reasons.get(x)!.push(reason)
        ops.push(ack(x, { queueType: "workflow", id: items.get(x), reason }))
      }
    }
    const res = await Promise.all(ops)
    expect(res.map((r) => r.status), JSON.stringify(res.map((r) => r.body)).slice(0, 600)).toEqual(res.map(() => 200))
    for (const x of [a, b]) {
      const rows = await ackRowsOf(x.firmId)
      expect(rows.map((r) => r.id)).toEqual([ackId(x.firmId, "workflow", items.get(x)!)])
      expect(rows[0]!.firmId).toBe(x.firmId)
      expect(reasons.get(x)).toContain(rows[0]!.detail)
      expect((await ackAuditRowsOf(x.uid)).length).toBe(3)
    }
  })

  it("a row stamped with another firm at the caller's own id is refused (409) and left as it was; no audit row", async () => {
    const [a, b] = [await provisionActor(), await provisionActor()]
    const x = await seedWorkflowItem(b)
    // What main let firm A plant: queueType = B's firm id and id = "workflow:X" land on B's firm-qualified id, stamped A.
    const planted = {
      id: ackId(b.firmId, "workflow", x), firmId: a.firmId, source: "court_ops", action: "court_ops_acknowledge",
      actorId: a.uid, classification: "internal", matterId: null, documentId: null, followUpId: null,
      queueType: b.firmId, status: "acknowledged", detail: "planted by A", tags: ["court", "ops"], createdAt: 1,
    }
    await adminDb().collection(COLL).doc(planted.id).set(planted)
    const r = await ack(b, { queueType: "workflow", id: x, reason: "B acknowledged" })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(codeOf(r.body)).toBe("court_ops_ack_refused")
    expect(await rowAt(planted.id)).toEqual(planted)
    expect(await ackRowsOf(b.firmId)).toEqual([])
    expect(await ackAuditRowsOf(b.uid)).toEqual([])
  })
})
