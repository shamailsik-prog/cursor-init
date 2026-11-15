// FA-D4-001-FU1-002 emulator cases. Loaded by tests/fa-d4-001-fu1-court-ops-acks.e2e.firestore.test.ts
// so `npm run test:rules` runs them (that script names the parent file; package.json is not edited).
// The route is the real POST /api/d2/court-ops against the Auth and Firestore emulators.
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { F02_AUTHORITY_HEADER } from "@/platform/authority/f02Routes"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import type { FollowUp } from "@/platform/spine/store"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"
import { deleteFirmRows } from "@/tests/helpers/firm-cleanup"

requireAuthFirestoreEmulators("FA-D4-001-FU1-002 resolve_follow_up e2e")

const E2E_TIMEOUT_MS = 180_000
const ACTIVITY = "workflow_ops_activity"

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
const created = { firmIds: new Set<string>(), uids: new Set<string>() }
const short = () => randomUUID().replaceAll("-", "").slice(0, 10)

async function provisionActor(): Promise<Actor> {
  const ref = adminDb().collection("firms").doc()
  await ref.create({ name: `FU1-002 firm ${ref.id}`, dataResidency: "PK", plan: "internal" })
  const firmId = ref.id
  created.firmIds.add(firmId)
  const uid = adminDb().collection("users").doc().id
  created.uids.add(uid)
  const email = `${uid.toLowerCase()}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  await adminAuth().setCustomUserClaims(uid, { firmId, role: "partner", clearanceLevel: "internal" })
  await adminDb().collection("users").doc(uid).set({
    id: uid, firmId, role: "partner", clearanceLevel: "internal", active: true,
  })
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is required")
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status} ${await res.text()}`)
  const { idToken } = (await res.json()) as { idToken: string }
  const matterId = `fu1002-${short()}`
  const batch = adminDb().batch()
  batch.set(adminDb().collection("matters").doc(matterId), {
    id: matterId,
    firmId,
    clientId: `fu1002-client-${firmId}`,
    title: `FU1-002 matter ${matterId}`,
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

function followUpDoc(id: string, fields: Record<string, unknown>) {
  return adminDb().collection("follow_ups").doc(id).set({ id, ...fields })
}

async function storedFollowUp(id: string): Promise<Record<string, unknown> | undefined> {
  const snap = await adminDb().collection("follow_ups").doc(id).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

async function activityOf(id: string): Promise<Record<string, unknown> | undefined> {
  const snap = await adminDb().collection(ACTIVITY).doc(`ops:court_ops:follow_up:${id}`).get()
  return snap.exists ? (snap.data() as Record<string, unknown>) : undefined
}

async function resolveAudits(uid: string) {
  const snap = await adminDb().collection("audit_log").where("actorId", "==", uid).get()
  return snap.docs.map((doc) => doc.data()).filter((row) => row.action === "court_ops_resolve_follow_up")
}

type Answer = { status: number; body: Record<string, unknown> | null; authority: string | null }

/** The Next core puts `code` on the body; the F02 router nests it under `error` and drops every other field. */
function refusalCode(body: Record<string, unknown> | null): unknown {
  const error = body?.error
  if (error && typeof error === "object" && "code" in error) return (error as { code?: unknown }).code
  return body?.code
}

async function resolve(a: Actor, followUpId: string, reason?: string): Promise<Answer> {
  const res = await courtOpsPost(
    new Request("http://127.0.0.1/api/d2/court-ops", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${a.token}`,
        "X-Firm-Id": a.firmId,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({
        action: "resolve_follow_up",
        actorId: a.uid,
        followUpId,
        ...(reason === undefined ? {} : { reason }),
      }),
    })
  )
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    authority: res.headers.get(F02_AUTHORITY_HEADER),
  }
}

function plantMemory(row: FollowUp): void {
  getRuntimeStore().followUps.push(row)
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("FA-D4-001-FU1-002 resolve_follow_up persistence", { timeout: E2E_TIMEOUT_MS }, () => {
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
    if (created.firmIds.size === 0) return
    const left = await deleteFirmRows({ firmIds: created.firmIds, uids: created.uids })
    expect(left.remaining, "rows of this suite's firms left after cleanup").toBe(0)
  }, E2E_TIMEOUT_MS)

  it("resolves an open follow-up and leaves every other stored field as it was", async () => {
    const a = await provisionActor()
    const id = `fu_${randomUUID()}`
    const row = {
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "CP ???",
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      marker: "keep",
    }
    await followUpDoc(id, row)
    const res = await resolve(a, id, "cleared on the desk")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.authority).toBe("functions")
    expect(res.body).toMatchObject({
      result: { action: "resolve_follow_up", followUpId: id },
      reused: false,
    })
    const stored = await storedFollowUp(id)
    expect(stored).toMatchObject({
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "CP ???",
      kind: "case_number_reject",
      status: "resolved",
      resolvedBy: a.uid,
      marker: "keep",
    })
    expect(typeof stored?.resolvedAt).toBe("number")
    expect(await activityOf(id)).toMatchObject({
      action: "court_ops_resolve_follow_up",
      followUpId: id,
      firmId: a.firmId,
      matterId: a.matterId,
      detail: "cleared on the desk",
    })
    expect(await resolveAudits(a.uid)).toHaveLength(1)
  })

  it("does not create a follow-up that exists only in the process cache", async () => {
    const a = await provisionActor()
    const id = `fu_${randomUUID()}`
    expect(await storedFollowUp(id)).toBeUndefined()
    plantMemory({
      id,
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "phantom",
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
    })
    const res = await resolve(a, id, "invent")
    expect(res.status, JSON.stringify(res.body)).toBe(404)
    expect(refusalCode(res.body)).toBe("follow_up_not_found")
    expect(await storedFollowUp(id)).toBeUndefined()
    expect(await activityOf(id)).toBeUndefined()
    expect(await resolveAudits(a.uid)).toHaveLength(0)
  })

  it("does not overwrite another firm's follow-up when the cache carries the same id", async () => {
    const [a, b] = [await provisionActor(), await provisionActor()]
    const id = `fu_${randomUUID()}`
    // The stored matter is one A can access, so only the firm check can refuse. A matter check would hide a missing firm check.
    const original = {
      firmId: b.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "B-SECRET",
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      marker: "b-keep",
    }
    await followUpDoc(id, original)
    plantMemory({
      id,
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "LHC",
      raw: "A-TAMPER",
      kind: "l4_10_silence",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
    })
    const res = await resolve(a, id, "take B")
    expect(res.status, JSON.stringify(res.body)).toBe(404)
    expect(refusalCode(res.body)).toBe("follow_up_not_found")
    expect(await storedFollowUp(id)).toEqual({ id, ...original })
    expect(await activityOf(id)).toBeUndefined()
    expect(await resolveAudits(a.uid)).toHaveLength(0)
  })

  it("does not resolve a follow-up whose matter the caller cannot access", async () => {
    const a = await provisionActor()
    const hidden = `fu1002-hidden-${short()}`
    await adminDb().collection("matters").doc(hidden).set({
      id: hidden,
      firmId: a.firmId,
      clientId: "other",
      title: "hidden",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "live",
      classification: "internal",
    })
    const id = `fu_${randomUUID()}`
    const original = {
      firmId: a.firmId,
      matterId: hidden,
      courtId: "SHC",
      raw: "hidden-raw",
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      marker: "matter-keep",
    }
    await followUpDoc(id, original)
    const res = await resolve(a, id, "no membership")
    expect(res.status, JSON.stringify(res.body)).toBe(404)
    expect(refusalCode(res.body)).toBe("follow_up_not_found")
    expect(await storedFollowUp(id)).toEqual({ id, ...original })
    expect(await activityOf(id)).toBeUndefined()
    expect(await resolveAudits(a.uid)).toHaveLength(0)
  })

  it("does not rewrite an already-resolved follow-up", async () => {
    const a = await provisionActor()
    const id = `fu_${randomUUID()}`
    const original = {
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "already done",
      kind: "case_number_reject",
      status: "resolved",
      resolvedBy: "earlier-actor",
      resolvedAt: 111,
      marker: "resolved-keep",
    }
    await followUpDoc(id, original)
    const res = await resolve(a, id, "again")
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusalCode(res.body)).toBe("follow_up_already_resolved")
    expect(await storedFollowUp(id)).toEqual({ id, ...original })
    expect(await activityOf(id)).toBeUndefined()
    expect(await resolveAudits(a.uid)).toHaveLength(0)
  })

  it("does not rewrite a follow-up that is not in a resolvable state", async () => {
    const a = await provisionActor()
    const id = `fu_${randomUUID()}`
    const original = {
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "held",
      kind: "case_number_reject",
      status: "hold",
      resolvedBy: null,
      resolvedAt: null,
      marker: "hold-keep",
    }
    await followUpDoc(id, original)
    const res = await resolve(a, id, "force")
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusalCode(res.body)).toBe("follow_up_not_resolvable")
    expect(await storedFollowUp(id)).toEqual({ id, ...original })
    expect(await activityOf(id)).toBeUndefined()
    expect(await resolveAudits(a.uid)).toHaveLength(0)
  })

  it("lets only one of two concurrent resolves commit", async () => {
    const a = await provisionActor()
    const id = `fu_${randomUUID()}`
    await followUpDoc(id, {
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "race",
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      marker: "race-keep",
    })
    const [left, right] = await Promise.all([resolve(a, id, "left"), resolve(a, id, "right")])
    const statuses = [left.status, right.status].sort((x, y) => x - y)
    expect(statuses, JSON.stringify([left.body, right.body])).toEqual([200, 409])
    const stored = await storedFollowUp(id)
    expect(stored).toMatchObject({
      firmId: a.firmId,
      matterId: a.matterId,
      raw: "race",
      kind: "case_number_reject",
      courtId: "SHC",
      status: "resolved",
      resolvedBy: a.uid,
      marker: "race-keep",
    })
    expect(typeof stored?.resolvedAt).toBe("number")
    const activity = await activityOf(id)
    expect(activity?.detail === "left" || activity?.detail === "right").toBe(true)
    expect(await resolveAudits(a.uid)).toHaveLength(1)
    const loser = left.status === 409 ? left : right
    expect(refusalCode(loser.body)).toBe("follow_up_already_resolved")
  })

  it("answers a missing row, another firm, a hidden matter, and a hidden resolved row with one body", async () => {
    const [a, b] = [await provisionActor(), await provisionActor()]
    const foreignId = `fu_${randomUUID()}`
    await followUpDoc(foreignId, {
      firmId: b.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "B-SECRET",
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
    })
    const hiddenMatter = `fu1002-hidden-${short()}`
    await adminDb().collection("matters").doc(hiddenMatter).set({
      id: hiddenMatter,
      firmId: a.firmId,
      clientId: "other",
      title: "hidden",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "live",
      classification: "internal",
    })
    const hiddenId = `fu_${randomUUID()}`
    const hiddenResolvedId = `fu_${randomUUID()}`
    await followUpDoc(hiddenId, {
      firmId: a.firmId,
      matterId: hiddenMatter,
      courtId: "SHC",
      raw: "hidden-open",
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
    })
    const hiddenResolved = {
      firmId: a.firmId,
      matterId: hiddenMatter,
      courtId: "SHC",
      raw: "hidden-resolved",
      kind: "case_number_reject",
      status: "resolved",
      resolvedBy: "earlier-actor",
      resolvedAt: 111,
      marker: "hidden-resolved-keep",
    }
    await followUpDoc(hiddenResolvedId, hiddenResolved)
    const missing = await resolve(a, `fu_${randomUUID()}`, "missing")
    const foreign = await resolve(a, foreignId, "foreign")
    const hidden = await resolve(a, hiddenId, "hidden")
    const hiddenDone = await resolve(a, hiddenResolvedId, "leak")
    for (const res of [missing, foreign, hidden, hiddenDone]) {
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(res.body).toEqual(missing.body)
      expect(refusalCode(res.body)).toBe("follow_up_not_found")
    }
    expect(await storedFollowUp(hiddenResolvedId)).toEqual({ id: hiddenResolvedId, ...hiddenResolved })
    expect(await activityOf(hiddenResolvedId)).toBeUndefined()
    expect(await resolveAudits(a.uid)).toHaveLength(0)
  })

  it("resolves a legacy follow-up that has no status", async () => {
    const a = await provisionActor()
    const id = `fu_${randomUUID()}`
    await followUpDoc(id, {
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "legacy",
      kind: "l4_10_silence",
      marker: "legacy-keep",
    })
    const res = await resolve(a, id, "open the legacy row")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await storedFollowUp(id)).toMatchObject({
      status: "resolved",
      resolvedBy: a.uid,
      marker: "legacy-keep",
      raw: "legacy",
      kind: "l4_10_silence",
    })
    expect(await activityOf(id)).toMatchObject({ detail: "open the legacy row" })
  })

  it("does not resolve a follow-up whose stored id is not the document id", async () => {
    const a = await provisionActor()
    const id = `fu_${randomUUID()}`
    const original = {
      id: `${id}-other`,
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "mismatch",
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      marker: "id-keep",
    }
    await adminDb().collection("follow_ups").doc(id).set(original)
    const res = await resolve(a, id, "rename")
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusalCode(res.body)).toBe("follow_up_not_resolvable")
    expect(await storedFollowUp(id)).toEqual(original)
    expect(await activityOf(id)).toBeUndefined()
  })

  it("does not resolve a follow-up of an unknown kind", async () => {
    const a = await provisionActor()
    const id = `fu_${randomUUID()}`
    const original = {
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "odd",
      kind: "not_a_kind",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      marker: "kind-keep",
    }
    await followUpDoc(id, original)
    const res = await resolve(a, id, "force")
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusalCode(res.body)).toBe("follow_up_not_resolvable")
    expect(await storedFollowUp(id)).toEqual({ id, ...original })
    expect(await activityOf(id)).toBeUndefined()
  })

  it("writes the missing activity row when the same resolver retries", async () => {
    const a = await provisionActor()
    const id = `fu_${randomUUID()}`
    await followUpDoc(id, {
      firmId: a.firmId,
      matterId: a.matterId,
      courtId: "SHC",
      raw: "retry",
      kind: "limitation_alert",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      marker: "retry-keep",
    })
    const first = await resolve(a, id, "first")
    expect(first.status).toBe(200)
    const resolvedAt = (await storedFollowUp(id))?.resolvedAt
    await adminDb().collection(ACTIVITY).doc(`ops:court_ops:follow_up:${id}`).delete()
    const retry = await resolve(a, id, "again")
    expect(retry.status, JSON.stringify(retry.body)).toBe(200)
    expect(await storedFollowUp(id)).toMatchObject({
      status: "resolved",
      resolvedBy: a.uid,
      resolvedAt,
      marker: "retry-keep",
    })
    expect(await activityOf(id)).toMatchObject({ detail: "again", actorId: a.uid })
    expect(await resolveAudits(a.uid)).toHaveLength(1)
  })
})
