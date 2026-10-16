// Audit F10: the durable Next idempotency store on the Firestore emulator. Two independent store instances over two
// firebase-admin apps stand for two Next instances sharing one database; a third instance stands for a restart.
// Spec: docs/superpowers/specs/2026-10-16-f10-durable-next-idempotency-design.md (§2.2-§2.5, §5).
import { randomUUID } from "node:crypto"
import { deleteApp, initializeApp, type App } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DURABLE_MAX_RESPONSE_BYTES,
  DurableIdempotencyStore,
  IdempotencyFenceError,
  durableDocId,
  durableIdempotencyTestSeam,
  type DurableBegin,
  type DurableClaimRef,
  type DurableScope,
} from "@/platform/http/durableIdempotency"
import {
  IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_TTL_MS,
  beginIdempotentRequest,
  recordExternalEffect,
  runWithIdempotencyScope,
} from "@/platform/http/idempotency"
import { doc, runTransaction, setDoc } from "@/platform/persistence/firestoreDbModular"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"

const PROJECT = process.env.FIREBASE_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "demo-sikander"
const apps: App[] = []
/** A Next instance's own Firestore client (its own firebase-admin app) on the shared emulator database. */
function instance(): Firestore {
  const app = initializeApp({ projectId: PROJECT }, `f10-store-${randomUUID()}`)
  apps.push(app)
  return getFirestore(app)
}
const storeOn = (db: Firestore) => new DurableIdempotencyStore(db as never, { ttlMs: IDEMPOTENCY_TTL_MS, leaseMs: IDEMPOTENCY_LEASE_MS })

const env = process.env as Record<string, string | undefined>
const savedMode = env.SIKANDER_PERSISTENCE_MODE

beforeEach(() => {
  for (const k of Object.keys(durableIdempotencyTestSeam)) delete (durableIdempotencyTestSeam as Record<string, unknown>)[k]
})
afterEach(() => {
  for (const k of Object.keys(durableIdempotencyTestSeam)) delete (durableIdempotencyTestSeam as Record<string, unknown>)[k]
  if (savedMode === undefined) delete env.SIKANDER_PERSISTENCE_MODE
  else env.SIKANDER_PERSISTENCE_MODE = savedMode
  setFirestorePersistenceForTests(null)
})
afterAll(async () => {
  await Promise.all(apps.map((a) => deleteApp(a)))
})

const scopeOf = (over: Partial<DurableScope> = {}): DurableScope => ({
  firmId: "firmF10",
  userId: "partner_f10",
  route: "POST /api/f10/thing",
  key: randomUUID(),
  requestHash: "fp-1",
  ...over,
})
const claimOf = (b: DurableBegin): DurableClaimRef => {
  if (b.kind !== "claimed") throw new Error(`expected a claim, got ${b.kind}`)
  return b.claim
}
const recordOf = (db: Firestore, s: DurableScope) => db.collection("idempotency_keys").doc(durableDocId(s.firmId, s.userId, s.route, s.key)).get()
const markerOf = (db: Firestore, s: DurableScope) => db.collection("idempotency_effects").doc(durableDocId(s.firmId, s.userId, s.route, s.key)).get()
const later = (ms: number) => () => Date.now() + ms

describe("F10: two instances and a restart share one durable store", () => {
  it("a key completed on instance A replays on instance B and on a restarted instance; it never claims again", async () => {
    const A = storeOn(instance())
    const B = storeOn(instance())
    const s = scopeOf()
    const claim = claimOf(await A.begin(s))
    expect(await A.settle(claim, { completed: true, json: JSON.stringify({ id: "ent_1" }) })).toBe("stored")
    expect(await B.begin(s)).toEqual({ kind: "replay", body: { id: "ent_1" } })
    const restarted = storeOn(instance())
    expect(await restarted.begin(s)).toEqual({ kind: "replay", body: { id: "ent_1" } })
  })

  it("load: 40 keys, each sent 4 times concurrently across two instances, claim exactly once each; after a restart every key replays and every record is kept", async () => {
    const A = storeOn(instance())
    const B = storeOn(instance())
    const scopes = Array.from({ length: 40 }, () => scopeOf())
    const begun = await Promise.all(scopes.flatMap((s) => [A.begin(s), B.begin(s), A.begin(s), B.begin(s)]))
    const claims = begun.filter((b) => b.kind === "claimed").map(claimOf)
    expect(claims).toHaveLength(40)
    expect(new Set(claims.map((c) => c.docId)).size).toBe(40)
    for (const other of begun.filter((b) => b.kind !== "claimed")) expect(other).toEqual({ kind: "in_progress" })
    await Promise.all(claims.map((c, i) => (i % 2 === 0 ? A : B).settle(c, { completed: true, json: JSON.stringify({ n: c.docId }) })))
    const restarted = storeOn(instance())
    const replays = await Promise.all(scopes.map((s) => restarted.begin(s)))
    for (const [i, r] of replays.entries()) {
      const docId = durableDocId(scopes[i]!.firmId, scopes[i]!.userId, scopes[i]!.route, scopes[i]!.key)
      expect(r).toEqual({ kind: "replay", body: { n: docId } })
    }
    const db = instance()
    const records = await Promise.all(scopes.map((s) => recordOf(db, s)))
    expect(records.every((r) => r.exists && r.data()!.status === "done")).toBe(true)
  })
})

describe("F10: the claim state machine (shared with F09)", () => {
  it("another fingerprint is 422 reused; a duplicate while running is in_progress", async () => {
    const S = storeOn(instance())
    const s = scopeOf()
    claimOf(await S.begin(s))
    expect(await S.begin({ ...s, requestHash: "fp-other" })).toEqual({ kind: "reused" })
    expect(await S.begin(s)).toEqual({ kind: "in_progress" })
  })

  it("a lapsed lease is taken over by the same request, keeping the operation; a taken-over attempt that ends without an effect leaves a released tombstone", async () => {
    const db = instance()
    const S = storeOn(db)
    const s = scopeOf()
    const first = claimOf(await S.begin(s))
    durableIdempotencyTestSeam.now = later(IDEMPOTENCY_LEASE_MS + 1_000)
    const second = claimOf(await S.begin(s))
    expect(second.operationId).toBe(first.operationId)
    expect(second.claimId).not.toBe(first.claimId)
    // The stale first attempt can no longer settle anything.
    expect(await S.settle(first, { completed: true, json: "1" })).toBe("lost")
    expect(await S.settle(second, { completed: false })).toBe("released")
    expect((await recordOf(db, s)).data()).toMatchObject({ status: "in_progress", released: true, claims: 2, operationId: first.operationId })
    // The tombstone keeps the key bound to its body, and the same request runs again at once.
    expect(await S.begin({ ...s, requestHash: "fp-other" })).toEqual({ kind: "reused" })
    expect(claimOf(await S.begin(s)).operationId).toBe(first.operationId)
  })

  it("a first claim that ends without an effect is deleted, so a corrected retry runs", async () => {
    const db = instance()
    const S = storeOn(db)
    const s = scopeOf()
    expect(await S.settle(claimOf(await S.begin(s)), { completed: false })).toBe("released")
    expect((await recordOf(db, s)).exists).toBe(false)
    claimOf(await S.begin({ ...s, requestHash: "fp-corrected" }))
  })

  it("a lapsed claim whose operation committed an effect answers the terminal 409 and stores it; it is never claimed again", async () => {
    const db = instance()
    const S = storeOn(db)
    const s = scopeOf()
    const claim = claimOf(await S.begin(s))
    await S.fence(claim, () => undefined).markEffect("transaction")
    durableIdempotencyTestSeam.now = later(IDEMPOTENCY_LEASE_MS + 1_000)
    expect(await S.begin(s)).toEqual({ kind: "terminal", operationId: claim.operationId })
    delete durableIdempotencyTestSeam.now
    expect(await S.begin(s)).toEqual({ kind: "terminal", operationId: claim.operationId })
    expect((await recordOf(db, s)).data()).toMatchObject({ status: "done", response: { status: 409, code: "idempotency_effect_committed" } })
  })

  it("not completed after an effect: settle stores the terminal 409", async () => {
    const S = storeOn(instance())
    const s = scopeOf()
    const claim = claimOf(await S.begin(s))
    await S.fence(claim, () => undefined).markEffect("transaction")
    expect(await S.settle(claim, { completed: false })).toBe("terminal")
    expect(await S.begin(s)).toEqual({ kind: "terminal", operationId: claim.operationId })
  })

  it("an orphan marker (its record lost) answers only the request that made it: another body or user is 422 with nothing written; the same request gets the terminal 409", async () => {
    const db = instance()
    const S = storeOn(db)
    const s = scopeOf()
    const claim = claimOf(await S.begin(s))
    await S.fence(claim, () => undefined).markEffect("transaction")
    await db.collection("idempotency_keys").doc(claim.docId).delete()
    expect(await S.begin({ ...s, requestHash: "fp-other" })).toEqual({ kind: "reused" })
    expect((await recordOf(db, s)).exists).toBe(false)
    expect((await markerOf(db, s)).exists).toBe(true)
    expect(await S.begin(s)).toEqual({ kind: "terminal", operationId: claim.operationId })
  })

  it("an expired operation's marker is deleted by the next fresh claim", async () => {
    const db = instance()
    const S = storeOn(db)
    const s = scopeOf()
    const claim = claimOf(await S.begin(s))
    await S.fence(claim, () => undefined).markEffect("transaction")
    durableIdempotencyTestSeam.now = later(IDEMPOTENCY_TTL_MS + 1_000)
    const fresh = claimOf(await S.begin(s))
    expect(fresh.operationId).not.toBe(claim.operationId)
    expect((await markerOf(db, s)).exists).toBe(false)
  })

  it("an answer over the durable cap is kept as omitted (replay unavailable); nested arrays and undefined replay as JSON", async () => {
    const S = storeOn(instance())
    const big = scopeOf()
    const json = JSON.stringify("x".repeat(DURABLE_MAX_RESPONSE_BYTES))
    expect(await S.settle(claimOf(await S.begin(big)), { completed: true, json: Buffer.byteLength(json) <= DURABLE_MAX_RESPONSE_BYTES ? json : null })).toBe("stored")
    expect(await S.begin(big)).toEqual({ kind: "unavailable" })
    const nested = scopeOf()
    const payload = { matrix: [[1, 2], [3, [4]]], gone: undefined, n: null }
    await S.settle(claimOf(await S.begin(nested)), { completed: true, json: JSON.stringify(payload) })
    expect(await S.begin(nested)).toEqual({ kind: "replay", body: { matrix: [[1, 2], [3, [4]]], n: null } })
  })
})

describe("F10: the write fence (through firestoreDbModular, inside an idempotent request)", () => {
  /** Runs `body` as an idempotent request in firestore mode on `db`; returns the claim's docId and the scope's result. */
  async function inRequest<T>(db: Firestore, body: () => Promise<T>, key = randomUUID()) {
    env.SIKANDER_PERSISTENCE_MODE = "firestore"
    setFirestorePersistenceForTests(db)
    const scope = { firmId: "firmF10", userId: "partner_f10" }
    const request = new Request("http://127.0.0.1/api/f10/thing", { method: "POST" })
    let docId = ""
    let out: T | undefined
    const result = await runWithIdempotencyScope(scope, async () => {
      const begun = await beginIdempotentRequest(request, key, "fp-fence")
      if (!begun.claim) return begun.response
      docId = durableDocId(scope.firmId, scope.userId, "POST /api/f10/thing", key)
      out = await body()
      begun.claim.complete({ ok: true })
      return Response.json({ ok: true })
    })
    return { docId, out, result, key }
  }

  it("an effect write commits the operation's marker with it; two writes in parallel make one marker", async () => {
    const db = instance()
    const id = randomUUID()
    const { docId } = await inRequest(db, () =>
      Promise.all([setDoc(doc(db as never, "f10_things", `${id}_a`), { n: 1 }), setDoc(doc(db as never, "f10_things", `${id}_b`), { n: 2 })])
    )
    const marker = await db.collection("idempotency_effects").doc(docId).get()
    expect(marker.data()).toMatchObject({ kind: "transaction", surface: "next", uid: "partner_f10", route: "POST /api/f10/thing", requestHash: "fp-fence" })
    expect((await db.collection("f10_things").doc(`${id}_a`).get()).data()).toEqual({ n: 1 })
    expect((await db.collection("f10_things").doc(`${id}_b`).get()).data()).toEqual({ n: 2 })
  })

  it("a repository transaction that reads before it writes still works under the fence, and commits the marker", async () => {
    const db = instance()
    const ref = doc(db as never, "f10_things", randomUUID())
    const { docId, out } = await inRequest(db, () =>
      runTransaction(db as never, async (tx) => {
        const snap = await tx.get(ref)
        tx.set(ref, { seen: snap.exists() })
        return "done"
      })
    )
    expect(out).toBe("done")
    expect((await (ref as unknown as { get(): Promise<{ data(): unknown }> }).get()).data()).toEqual({ seen: false })
    expect((await db.collection("idempotency_effects").doc(docId).get()).exists).toBe(true)
  })

  it("an audit row is not an effect: writing one creates no marker", async () => {
    const db = instance()
    const auditId = `aud_f10_${randomUUID()}`
    const { docId } = await inRequest(db, () => setDoc(doc(db as never, "audit_log", auditId), { action: "f10", firmId: "firmF10" }))
    expect((await db.collection("audit_log").doc(auditId).get()).exists).toBe(true)
    expect((await db.collection("idempotency_effects").doc(docId).get()).exists).toBe(false)
  })

  it("an attempt whose claim was taken over is refused at its write (idempotency_claim_lost), and nothing is written", async () => {
    const db = instance()
    const thing = `${randomUUID()}`
    const key = randomUUID()
    let refused: unknown
    const { result } = await inRequest(
      db,
      async () => {
        // Another attempt takes the claim over while this one is between its claim and its write.
        const docId = durableDocId("firmF10", "partner_f10", "POST /api/f10/thing", key)
        await db.collection("idempotency_keys").doc(docId).update({ claimId: "someone-else" })
        try {
          await setDoc(doc(db as never, "f10_things", thing), { n: 1 })
        } catch (err) {
          refused = err
          throw err
        }
      },
      key
    )
    expect(refused).toBeInstanceOf(IdempotencyFenceError)
    expect((refused as IdempotencyFenceError).code).toBe("idempotency_claim_lost")
    expect((result as Response).status).toBe(409)
    expect(((await (result as Response).json()) as { code: string }).code).toBe("idempotency_claim_lost")
    expect((await db.collection("f10_things").doc(thing).get()).exists).toBe(false)
  })

  /** One request that writes `thing` and then answers `answer` without completing its claim. */
  async function writeThenAnswer(db: Firestore, key: string, thing: string, answer: () => Response): Promise<{ status: number; json: Record<string, unknown> }> {
    env.SIKANDER_PERSISTENCE_MODE = "firestore"
    setFirestorePersistenceForTests(db)
    const res = await runWithIdempotencyScope({ firmId: "firmF10", userId: "partner_f10" }, async () => {
      const begun = await beginIdempotentRequest(new Request("http://127.0.0.1/api/f10/thing", { method: "POST" }), key, "fp-refusal")
      if (!begun.claim) return begun.response
      const ref = doc(db as never, "f10_things", thing)
      const snap = await (ref as unknown as { get(): Promise<{ data(): { n?: number } | undefined }> }).get()
      await setDoc(ref, { n: (snap.data()?.n ?? 0) + 1 })
      return answer()
    })
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }

  it("a refusal the route answers after a write of its own (for example a recomputed digest) is kept and replayed as itself; the write is not repeated", async () => {
    const db = instance()
    const key = randomUUID()
    const thing = randomUUID()
    const refuse = () => Response.json({ error: "closure follow-up queue is already resolved" }, { status: 422 })
    const first = await writeThenAnswer(db, key, thing, refuse)
    expect(first).toEqual({ status: 422, json: { error: "closure follow-up queue is already resolved" } })
    const again = await writeThenAnswer(db, key, thing, refuse)
    expect(again).toEqual({ status: 422, json: { error: "closure follow-up queue is already resolved", reused: true } })
    expect((await db.collection("f10_things").doc(thing).get()).data()).toEqual({ n: 1 })
  })

  it("a 5xx after a write answers 409 idempotency_effect_committed, now and on retry; the write is not repeated", async () => {
    const db = instance()
    const key = randomUUID()
    const thing = randomUUID()
    const answer = () => Response.json({ error: "internal error", code: "INTERNAL_ERROR" }, { status: 500 })
    const first = await writeThenAnswer(db, key, thing, answer)
    expect([first.status, first.json.code]).toEqual([409, "idempotency_effect_committed"])
    const again = await writeThenAnswer(db, key, thing, answer)
    expect([again.status, again.json.code, again.json.operationId]).toEqual([409, "idempotency_effect_committed", first.json.operationId])
    expect((await db.collection("f10_things").doc(thing).get()).data()).toEqual({ n: 1 })
  })

  it("a route's catch-all 400 REQUEST_FAILED after a write (a public refusal or a masked failure) is left as this request's answer; its retry gets 409 idempotency_effect_committed; the write is not repeated", async () => {
    const db = instance()
    const key = randomUUID()
    const thing = randomUUID()
    const answer = () => Response.json({ error: "cross-firm actor denied", code: "REQUEST_FAILED" }, { status: 400 })
    const first = await writeThenAnswer(db, key, thing, answer)
    expect(first).toEqual({ status: 400, json: { error: "cross-firm actor denied", code: "REQUEST_FAILED" } })
    const again = await writeThenAnswer(db, key, thing, answer)
    expect([again.status, again.json.code]).toEqual([409, "idempotency_effect_committed"])
    expect((await db.collection("f10_things").doc(thing).get()).data()).toEqual({ n: 1 })
  })

  it("recordExternalEffect marks a provider dispatch before it happens (kind external)", async () => {
    const db = instance()
    const { docId } = await inRequest(db, () => recordExternalEffect("p1_dispatch"))
    expect((await db.collection("idempotency_effects").doc(docId).get()).data()).toMatchObject({ kind: "p1_dispatch" })
  })

  it("outside an idempotent request the helpers write as before: no fence, no marker", async () => {
    const db = instance()
    const thing = randomUUID()
    await setDoc(doc(db as never, "f10_things", thing), { n: 9 })
    expect((await db.collection("f10_things").doc(thing).get()).data()).toEqual({ n: 9 })
  })
})
