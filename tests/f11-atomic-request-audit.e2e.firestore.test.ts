// Audit F11 (HIGH): Next effects and audit publication are not atomic. withSession ran the handler, whose effect writes
// each committed on their own, and only then flushed the request's audit rows; a process that died in between left the
// effect with no audit row, and nothing ever published one (the retry queue lives in the dead process; F10 never runs
// the request again).
//
// These tests drive the real POST /api/d1/clients `create` through withSession in production mode: NODE_ENV=production,
// Firebase auth with Auth-emulator ID tokens, SIKANDER_PERSISTENCE_MODE=firestore on the Firestore emulator. "The
// instance dies" is simulated here, in the test process only: firebase-admin's own prototypes are spied so that, for
// instance A's Firestore client, the call after a chosen commit never returns (and neither does any later call). Then
// instance B (a second firebase-admin app) takes over with fresh process state, and every recovery this codebase has
// runs after the outbox grace: on main there is none; on the branch, the audit-outbox reconciler.
// Spec: docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md.
import { createHash, randomInt, randomUUID } from "node:crypto"
import { deleteApp, getApps, initializeApp, type App } from "firebase-admin/app"
import {
  DocumentReference,
  Firestore,
  Query,
  Transaction,
  WriteBatch,
  getFirestore,
  type Firestore as FirestoreType,
} from "firebase-admin/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as clientsPost } from "@/app/api/d1/clients/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import * as session from "@/platform/p5/session"
import { resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { adminAuth, adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS, requireAuthFirestoreEmulators } from "@/tests/helpers/emulator-require"

requireAuthFirestoreEmulators("F11 atomic request audit e2e")

/** First ID-token verification resolves firebase-admin credentials (a metadata probe) and can be slow under load. */
const E2E_TIMEOUT_MS = 180_000
/** The outbox grace of the spec (ruling 5), written out so this file also runs against main. */
const GRACE_MS = 10 * 60_000
const LEASE_MS = 5 * 60_000
/** Collections that record a decision or F10/F11 bookkeeping, not an effect (spec §2.2). */
const NOT_EFFECTS = ["audit_log", "audit_dead_letter", "audit_outbox", "idempotency_keys", "idempotency_effects"]
const COMMITTED_HEADER = "Idempotency-Effect-Committed"

type Row = Record<string, unknown> & { id: string }

// ---------------------------------------------------------------------------------------------------------------------
// Process state: instance A (the default firebase-admin app) and instance B (a second app, the same database).
// ---------------------------------------------------------------------------------------------------------------------
let appB: App | undefined
function instanceB(): FirestoreType {
  const projectId = process.env.GCLOUD_PROJECT ?? "demo-sikander"
  appB ??= getApps().find((a) => a.name === "f11-instance-b") ?? initializeApp({ projectId }, "f11-instance-b")
  return getFirestore(appB)
}

type Verifier = (token: string) => Promise<{ uid: string } & Record<string, unknown>>
type SessionSeams = { setIdTokenVerifierForTests?: (verifier: Verifier | null) => void }
function useEmulatorVerifier(on: boolean): void {
  const seam = (session as unknown as SessionSeams).setIdTokenVerifierForTests
  seam?.(on ? async (token) => (await adminAuth().verifyIdToken(token, true)) as Awaited<ReturnType<Verifier>> : null)
}

/** Everything a Next process holds in memory is gone; Firestore is not. */
function forgetProcessState(): void {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  session.resetSessionStateForTests()
  resetProductionFirestoreForTests()
}

/** Instance B starts: a fresh process on its own Firestore client. */
function startInstanceB(): FirestoreType {
  forgetProcessState()
  const db = instanceB()
  setFirestorePersistenceForTests(db)
  return db
}

// ---------------------------------------------------------------------------------------------------------------------
// The crash: instance A's Firestore client stops answering after a chosen commit.
// ---------------------------------------------------------------------------------------------------------------------
type Death = {
  /** Resolves when instance A has died. */
  died: Promise<void>
  /** Every commit instance A made (transactions, batches, single writes): the paths each one wrote. */
  commits: string[][]
}

/**
 * What happens at a commit of instance A, decided from the paths it writes:
 * - after it commits: `die` (the instance is gone from here on) or `freeze` (this caller never gets the answer; the
 *   instance lives on for its other requests);
 * - instead of committing: `die`, or `refuse` (the database refuses the commit; the caller gets the error).
 */
type At = {
  after?: (paths: string[]) => "die" | "freeze" | undefined
  before?: (paths: string[]) => "die" | "refuse" | undefined
}

const restorers: Array<() => void> = []
const KILLED = Symbol("instance killed")
const hang = <T>() => new Promise<T>(() => undefined)
const refused = () => new Error("the database refused the commit")

/**
 * Instance A (`dbA`) dies, or one of its commits is frozen or refused, as `at` decides. Once it is dead, every call it
 * makes to Firestore (transactions, batch commits, document writes and reads, queries) never settles, as in a process
 * that is gone. Other Firestore clients are untouched.
 */
function instanceDies(dbA: FirestoreType, at: At): Death {
  let dead = false
  let markDead!: () => void
  const died = new Promise<void>((resolve) => (markDead = resolve))
  const die = () => {
    if (!dead) {
      dead = true
      markDead()
    }
  }
  const commits: string[][] = []
  const txPaths = new WeakMap<object, string[]>()
  const batchPaths = new WeakMap<object, string[]>()
  const batchDb = new WeakMap<object, unknown>()
  const isA = (db: unknown) => db === dbA

  /** Runs `commit` for a write of `paths`, applying `at`. */
  const commitOf = async <T>(paths: string[], commit: () => Promise<T>): Promise<T> => {
    const before = at.before?.(paths)
    if (before === "die") {
      die()
      return hang()
    }
    if (before === "refuse") throw refused()
    const out = await commit()
    commits.push(paths)
    const after = at.after?.(paths)
    if (after === "die") die()
    if (after === "freeze") return hang()
    return out
  }

  const spy = <T extends object, K extends keyof T & string>(proto: T, name: K, impl: (original: (...a: unknown[]) => unknown) => (this: unknown, ...a: unknown[]) => unknown) => {
    const original = proto[name] as unknown as (...a: unknown[]) => unknown
    const s = vi.spyOn(proto as never, name as never).mockImplementation(impl(original) as never)
    restorers.push(() => s.mockRestore())
  }

  spy(Firestore.prototype, "runTransaction", (original) =>
    async function (this: unknown, ...args: unknown[]) {
      if (!isA(this)) return original.apply(this, args)
      if (dead) return hang()
      const [update, options] = args as [(tx: Transaction) => Promise<unknown>, unknown]
      let paths: string[] = []
      let after: "die" | "freeze" | undefined
      try {
        const out = await original.call(
          this,
          async (tx: Transaction) => {
            paths = []
            txPaths.set(tx, paths)
            const result = await update(tx)
            const before = at.before?.(paths)
            if (before === "die") throw KILLED
            if (before === "refuse") throw refused()
            return result
          },
          options
        )
        commits.push(paths)
        after = at.after?.(paths)
        if (after === "die") die()
        if (after === "freeze") return hang()
        return out
      } catch (err) {
        if (err === KILLED) {
          die()
          return hang()
        }
        throw err
      }
    }
  )
  for (const op of ["set", "create", "update", "delete"] as const) {
    spy(Transaction.prototype, op, (original) =>
      function (this: unknown, ...args: unknown[]) {
        txPaths.get(this as object)?.push((args[0] as DocumentReference).path)
        return original.apply(this, args)
      }
    )
    spy(WriteBatch.prototype, op, (original) =>
      function (this: unknown, ...args: unknown[]) {
        const list = batchPaths.get(this as object) ?? []
        list.push((args[0] as DocumentReference).path)
        batchPaths.set(this as object, list)
        return original.apply(this, args)
      }
    )
    spy(DocumentReference.prototype, op, (original) =>
      async function (this: unknown, ...args: unknown[]) {
        const ref = this as DocumentReference
        if (!isA(ref.firestore)) return original.apply(this, args)
        if (dead) return hang()
        return commitOf([ref.path], async () => original.apply(this, args))
      }
    )
  }
  spy(Firestore.prototype, "batch", (original) =>
    function (this: unknown, ...args: unknown[]) {
      const batch = original.apply(this, args) as object
      batchDb.set(batch, this)
      return batch
    }
  )
  spy(WriteBatch.prototype, "commit", (original) =>
    async function (this: unknown, ...args: unknown[]) {
      if (!isA(batchDb.get(this as object))) return original.apply(this, args)
      if (dead) return hang()
      return commitOf(batchPaths.get(this as object) ?? [], async () => original.apply(this, args))
    }
  )
  for (const [proto, name] of [
    [DocumentReference.prototype, "get"],
    [Query.prototype, "get"],
    [Firestore.prototype, "getAll"],
  ] as const) {
    spy(proto as object, name as never, (original) =>
      function (this: unknown, ...args: unknown[]) {
        const db = this instanceof Firestore ? this : (this as { firestore?: unknown }).firestore
        if (isA(db) && dead) return hang()
        return original.apply(this, args)
      }
    )
  }
  return { died, commits }
}

function restoreFirestore(): void {
  while (restorers.length > 0) restorers.pop()!()
}

/** The effect paths among a set of commits (spec §2.2: the audit log, the outbox and F10's records are not effects). */
function effectPathsOf(commits: string[][]): string[] {
  return [...new Set(commits.flat().filter((path) => !NOT_EFFECTS.includes(path.split("/")[0] ?? "")))]
}

// ---------------------------------------------------------------------------------------------------------------------
// Recovery: everything this codebase runs after a crash, after the outbox grace.
// ---------------------------------------------------------------------------------------------------------------------
type Reconcile = (deps: { db: unknown; now?: () => number }) => Promise<unknown>
async function reconcilerOrNull(): Promise<Reconcile | null> {
  try {
    const mod = (await import("@/functions/src/p5/auditOutbox")) as { reconcileAuditOutbox?: Reconcile }
    return mod.reconcileAuditOutbox ?? null
  } catch {
    return null
  }
}

/** Runs the reconciler (when the codebase has one) with its clock past the grace; returns whether one ran. */
async function recoverAfterGrace(db: FirestoreType): Promise<boolean> {
  const reconcile = await reconcilerOrNull()
  if (!reconcile) return false
  await reconcile({ db, now: () => Date.now() + GRACE_MS + 60_000 })
  return true
}

// ---------------------------------------------------------------------------------------------------------------------
// Firms, users, requests and reads. Every document a test creates is deleted in afterEach.
// ---------------------------------------------------------------------------------------------------------------------
type Provisioned = { firmId: string; uid: string; token: string }
const createdFirms: string[] = []
const createdUids: string[] = []

async function provisionFirm(): Promise<string> {
  const id = `f11-firm-${randomUUID().slice(0, 8)}`
  await adminDb().collection("firms").doc(id).create({ name: `F11 firm ${id}`, dataResidency: "PK", plan: "internal" })
  createdFirms.push(id)
  return id
}

async function provisionUser(firmId: string): Promise<Provisioned> {
  const uid = `f11-${randomUUID().slice(0, 12)}`
  const email = `${uid}@example.test`
  const password = "emulator-pass-123"
  await adminAuth().createUser({ uid, email, password })
  createdUids.push(uid)
  await adminAuth().setCustomUserClaims(uid, { firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  // The Functions writer's shape (createFirmUserOp): no `id` field.
  await adminDb().collection("users").doc(uid).set({ firmId, role: "partner", clearanceLevel: "privileged-restricted", active: true })
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST
  if (!host) throw new Error("FIREBASE_AUTH_EMULATOR_HOST is required")
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  })
  if (!res.ok) throw new Error(`emulator sign-in failed: ${res.status} ${await res.text()}`)
  const { idToken } = (await res.json()) as { idToken: string }
  return { firmId, uid, token: idToken }
}

type ClientBody = { action: "create"; firmId: string; canonicalName: string; cnic: string; phone: string; classification: "internal" }
function clientBody(user: Provisioned): ClientBody {
  return {
    action: "create",
    firmId: user.firmId,
    canonicalName: `F11 client ${randomUUID()}`,
    cnic: String(randomInt(10 ** 12, 10 ** 13 - 1)),
    phone: "03001234567",
    classification: "internal",
  }
}

function clientRequest(user: Provisioned, body: ClientBody, key: string): Request {
  return new Request("http://127.0.0.1/api/d1/clients", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${user.token}`,
      "X-Firm-Id": user.firmId,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  })
}

type Answer = { status: number; json: Record<string, unknown>; committed: string | null }
async function send(user: Provisioned, body: ClientBody, key: string): Promise<Answer> {
  const res = await clientsPost(clientRequest(user, body, key))
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, committed: res.headers.get(COMMITTED_HEADER) }
}

async function rowsWhere(db: FirestoreType, collection: string, firmId: string): Promise<Row[]> {
  const snap = await db.collection(collection).where("firmId", "==", firmId).get()
  return snap.docs.map((d) => ({ ...(d.data() as Record<string, unknown>), id: d.id }))
}

async function entitiesNamed(db: FirestoreType, firmId: string, name: string): Promise<Row[]> {
  return (await rowsWhere(db, "entities", firmId)).filter((row) => row.canonicalName === name)
}

/** Audit rows that name an effect path: in their effect paths, as their target, or by the document id as target. */
function naming(rows: Row[], path: string): Row[] {
  const docId = path.split("/").slice(1).join("/")
  return rows.filter(
    (row) => (Array.isArray(row.effectPaths) && row.effectPaths.includes(path)) || row.target === path || row.target === docId
  )
}

/** The durable F10 record id of a request (spec F10 §2.2), computed here so this file runs on main. */
const durableDocId = (firmId: string, userId: string, route: string, key: string) =>
  "n_" + createHash("sha256").update([firmId, userId, route, key.toLowerCase()].join("|")).digest("hex")

async function deleteWhereFirm(db: FirestoreType, collection: string, firmId: string): Promise<void> {
  const snap = await db.collection(collection).where("firmId", "==", firmId).get()
  await Promise.all(snap.docs.map((d) => d.ref.delete()))
}

async function cleanUp(): Promise<void> {
  const db = instanceB()
  const collections = [
    "entities",
    "entity_links",
    "matter_client_search_index",
    "audit_log",
    "audit_outbox",
    "audit_dead_letter",
    "idempotency_keys",
    "idempotency_effects",
  ]
  for (const firmId of createdFirms.splice(0)) {
    await Promise.all(collections.map((c) => deleteWhereFirm(db, c, firmId)))
    await db.collection("firms").doc(firmId).delete()
  }
  for (const uid of createdUids.splice(0)) {
    await db.collection("users").doc(uid).delete()
    await adminAuth().deleteUser(uid).catch(() => undefined)
  }
}

/** One line of evidence per scenario, picked up by the run log. */
function evidence(label: string, data: Record<string, unknown>): void {
  console.log(`[F11 evidence] ${label} ${JSON.stringify(data)}`)
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F11: a crashed request's committed effect gets its audit row (production mode)", { timeout: E2E_TIMEOUT_MS }, () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander")
    vi.stubEnv("GCLOUD_PROJECT", process.env.GCLOUD_PROJECT ?? "demo-sikander")
    forgetProcessState()
    setFirestorePersistenceForTests(adminDb())
    useEmulatorVerifier(true)
  })

  afterEach(async () => {
    restoreFirestore()
    useEmulatorVerifier(false)
    setFirestorePersistenceForTests(null)
    vi.unstubAllEnvs()
    forgetProcessState()
    await cleanUp()
  })

  afterAll(async () => {
    // The reconciler's backlog state (spec ruling 9), written by the runs above.
    await instanceB().collection("platform").doc("auditOutboxBacklog").delete()
    if (appB && getApps().includes(appB)) await deleteApp(appB)
  })

  it("the instance dies right after the entity commits: the effect gets exactly one audit row (main: none, ever)", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId)
    const body = clientBody(partner)
    const death = instanceDies(adminDb(), { after: (paths) => (paths.some((p) => p.startsWith("entities/")) ? "die" : undefined) })
    void clientsPost(clientRequest(partner, body, randomUUID()))
    await death.died

    const db = startInstanceB()
    const effects = effectPathsOf(death.commits)
    expect(effects.filter((p) => p.startsWith("entities/"))).toHaveLength(1)
    expect((await entitiesNamed(db, firmId, body.canonicalName)).length).toBe(1)

    const recovered = await recoverAfterGrace(db)
    await recoverAfterGrace(db)
    const rows = await rowsWhere(db, "audit_log", firmId)
    const withoutAudit = effects.filter((p) => naming(rows, p).length === 0)
    evidence("crash-after-entity", { reconciler: recovered, effects: effects.length, effectsWithoutAudit: withoutAudit.length, auditRows: rows.length })
    expect(withoutAudit).toEqual([])
    for (const path of effects) expect(naming(rows, path)).toHaveLength(1)
  })

  it("the instance dies after every effect write, before the audit flush: each committed effect gets exactly one audit row (main: none)", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId)
    const body = clientBody(partner)
    const death = instanceDies(adminDb(), { before: (paths) => (paths.some((p) => p.startsWith("audit_log/")) ? "die" : undefined) })
    void clientsPost(clientRequest(partner, body, randomUUID()))
    await death.died

    const db = startInstanceB()
    const effects = effectPathsOf(death.commits)
    expect(effects.some((p) => p.startsWith("entities/"))).toBe(true)
    expect(effects.some((p) => p.startsWith("matter_client_search_index/"))).toBe(true)

    // Two reconciler runs at once, then a third: still one row per effect.
    const reconcile = await reconcilerOrNull()
    if (reconcile) {
      const now = () => Date.now() + GRACE_MS + 60_000
      await Promise.all([reconcile({ db, now }), reconcile({ db, now })])
    }
    await recoverAfterGrace(db)
    const rows = await rowsWhere(db, "audit_log", firmId)
    const withoutAudit = effects.filter((p) => naming(rows, p).length === 0)
    evidence("crash-before-flush", { reconciler: reconcile !== null, effects: effects.length, effectsWithoutAudit: withoutAudit.length, auditRows: rows.length })
    expect(withoutAudit).toEqual([])
    for (const path of effects) expect(naming(rows, path)).toHaveLength(1)
    // Nothing is left to publish.
    expect(await rowsWhere(db, "audit_outbox", firmId)).toEqual([])
  })

  it("the effect and its staged audit entry are one commit; a commit that fails carries neither", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId)

    // The entity's own commit carries the outbox entry that names it.
    const body = clientBody(partner)
    const death = instanceDies(adminDb(), { after: (paths) => (paths.some((p) => p.startsWith("entities/")) ? "die" : undefined) })
    void clientsPost(clientRequest(partner, body, randomUUID()))
    await death.died
    const entityCommit = death.commits.find((paths) => paths.some((p) => p.startsWith("entities/")))!
    const db = startInstanceB()
    const staged = await rowsWhere(db, "audit_outbox", firmId)
    const entityPath = entityCommit.find((p) => p.startsWith("entities/"))!
    evidence("same-commit", { entityCommit, stagedEntries: staged.length })
    expect(entityCommit.filter((p) => p.startsWith("audit_outbox/"))).toHaveLength(1)
    const entryId = entityCommit.find((p) => p.startsWith("audit_outbox/"))!.split("/")[1]
    const entry = staged.find((row) => row.id === entryId)
    expect(entry?.effectPaths).toEqual([entityPath])
    expect([entry?.firmId, entry?.actorId, entry?.route, entry?.requestAction]).toEqual([firmId, partner.uid, "POST /api/d1/clients", "create"])
    restoreFirestore()

    // A commit refused by the database: neither the entity nor an entry.
    forgetProcessState()
    setFirestorePersistenceForTests(adminDb())
    const failing = clientBody(partner)
    instanceDies(adminDb(), { before: (paths) => (paths.some((p) => p.startsWith("entities/")) ? "refuse" : undefined) })
    const answer = await send(partner, failing, randomUUID())
    restoreFirestore()
    const outbox = await rowsWhere(db, "audit_outbox", firmId)
    evidence("failed-commit", { status: answer.status, entities: (await entitiesNamed(db, firmId, failing.canonicalName)).length, outbox: outbox.length - staged.length })
    expect(answer.status).toBeGreaterThanOrEqual(400)
    expect(await entitiesNamed(db, firmId, failing.canonicalName)).toEqual([])
    expect(outbox.filter((row) => !staged.some((s) => s.id === row.id))).toEqual([])
  })

  it("a same-key retry on another instance repeats neither the effect nor its audit row", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId)
    const body = clientBody(partner)
    const key = randomUUID()
    const death = instanceDies(adminDb(), { after: (paths) => (paths.some((p) => p.startsWith("entities/")) ? "die" : undefined) })
    void clientsPost(clientRequest(partner, body, key))
    await death.died
    const db = startInstanceB()
    const effects = effectPathsOf(death.commits)

    // Within instance A's lease the key is in progress; after it, the operation's committed effect answers.
    const during = await send(partner, body, key)
    expect([during.status, during.json.code]).toEqual([409, "idempotency_in_progress"])
    const recordId = durableDocId(firmId, partner.uid, "POST /api/d1/clients", key)
    await db.collection("idempotency_keys").doc(recordId).update({ claimedAt: new Date(Date.now() - LEASE_MS - 60_000) })
    const after = await send(partner, body, key)
    expect([after.status, after.json.code]).toEqual([409, "idempotency_effect_committed"])
    expect(after.committed).toEqual(expect.any(String))

    await recoverAfterGrace(db)
    const again = await send(partner, body, key)
    expect([again.status, again.json.code]).toEqual([409, "idempotency_effect_committed"])
    await recoverAfterGrace(db)

    const rows = await rowsWhere(db, "audit_log", firmId)
    const entities = await entitiesNamed(db, firmId, body.canonicalName)
    const entityPath = effects.find((p) => p.startsWith("entities/"))!
    const named = naming(rows, entityPath)
    evidence("retry-instance-b", { entities: entities.length, auditRowsNamingEntity: named.length, operationId: after.committed })
    expect(entities).toHaveLength(1)
    expect(named).toHaveLength(1)
    expect(named[0]?.operationId).toBe(after.committed)
    expect(await rowsWhere(db, "audit_outbox", firmId)).toEqual([])
  })

  it("control: a request that completes leaves no outbox entry and its own audit row once", async () => {
    const firmId = await provisionFirm()
    const partner = await provisionUser(firmId)
    const body = clientBody(partner)
    const answer = await send(partner, body, randomUUID())
    expect(answer.status).toBe(200)
    const db = adminDb()
    const entity = (await entitiesNamed(db, firmId, body.canonicalName))[0]!
    const rows = await rowsWhere(db, "audit_log", firmId)
    expect(rows.filter((row) => row.action === "client_create" && row.target === entity.id)).toHaveLength(1)
    expect(await rowsWhere(db, "audit_outbox", firmId)).toEqual([])
    await recoverAfterGrace(db)
    expect(naming(await rowsWhere(db, "audit_log", firmId), `entities/${entity.id}`)).toHaveLength(1)
  })

  it("two firms crash together: each firm's staged entries hold only its own rows, and each effect is audited in its own firm only", async () => {
    const [firmA, firmB] = [await provisionFirm(), await provisionFirm()]
    const [userA, userB] = [await provisionUser(firmA), await provisionUser(firmB)]
    const [bodyA, bodyB] = [clientBody(userA), clientBody(userB)]
    // The first entity commit never answers its request (frozen); the second kills the instance. Both effects are
    // committed and neither request reaches its flush.
    let entityCommits = 0
    const death = instanceDies(adminDb(), {
      after: (paths) => (paths.some((p) => p.startsWith("entities/")) ? (++entityCommits === 2 ? "die" : "freeze") : undefined),
    })
    void clientsPost(clientRequest(userA, bodyA, randomUUID()))
    void clientsPost(clientRequest(userB, bodyB, randomUUID()))
    await death.died
    const db = startInstanceB()

    const stagedA = await rowsWhere(db, "audit_outbox", firmA)
    const stagedB = await rowsWhere(db, "audit_outbox", firmB)
    evidence("two-firms-staged", { stagedA: stagedA.length, stagedB: stagedB.length })
    expect(stagedA.length).toBeGreaterThan(0)
    expect(stagedB.length).toBeGreaterThan(0)
    for (const [entries, firmId, uid] of [[stagedA, firmA, userA.uid], [stagedB, firmB, userB.uid]] as const) {
      for (const entry of entries) {
        expect([entry.firmId, entry.actorId]).toEqual([firmId, uid])
        for (const row of (entry.rows as Row[]) ?? []) expect(row.firmId).toBe(firmId)
      }
    }

    await recoverAfterGrace(db)
    const [rowsA, rowsB] = [await rowsWhere(db, "audit_log", firmA), await rowsWhere(db, "audit_log", firmB)]
    const [entityA, entityB] = [(await entitiesNamed(db, firmA, bodyA.canonicalName))[0]!, (await entitiesNamed(db, firmB, bodyB.canonicalName))[0]!]
    expect(naming(rowsA, `entities/${entityA.id}`)).toHaveLength(1)
    expect(naming(rowsB, `entities/${entityB.id}`)).toHaveLength(1)
    expect(naming(rowsA, `entities/${entityB.id}`)).toEqual([])
    expect(naming(rowsB, `entities/${entityA.id}`)).toEqual([])
    for (const row of naming(rowsA, `entities/${entityA.id}`)) expect(row.onBehalfOf).toBe(userA.uid)
  })
})
