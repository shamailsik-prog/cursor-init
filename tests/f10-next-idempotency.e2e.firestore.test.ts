// Audit F10 (HIGH): Next.js idempotency disappeared across instances and restarts. The store was a per-process Map, so a
// key completed on instance A was claimed afresh on instance B (or after a restart), and a throw after a committed effect
// released the key so a retry repeated the effect. These tests drive real Next route handlers on Admin Firestore (the
// emulator) with SIKANDER_PERSISTENCE_MODE=firestore, through routes that are live by default: /api/d1/clients `create`
// (a client entity, its search-index row and its links) and /api/p1/committee-brain (a provider call, then the output).
// "Restart" forgets everything the Next process holds in memory (the runtime store and the idempotency Map); "instance B"
// is a second firebase-admin app, with its own Firestore client.
// Spec: docs/superpowers/specs/2026-10-16-f10-durable-next-idempotency-design.md.
import { createHash, randomInt, randomUUID } from "node:crypto"
import { deleteApp, getApps, initializeApp, type App } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import { POST as clientsPost } from "@/app/api/d1/clients/route"
import { POST as documentsPost } from "@/app/api/d1/documents/route"
import { POST as committeePost } from "@/app/api/p1/committee-brain/route"
import * as idempotency from "@/platform/http/idempotency"
import { getProductionFirestore, resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { setTransportForTests } from "@/platform/p1/internalAICaller"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import type { AuditEntry } from "@/platform/spine/store"
import { seedFirmARuntimeRecords } from "@/tests/helpers/firestore-runtime-seed"

const env = process.env as Record<string, string | undefined>
const savedMode = env.SIKANDER_PERSISTENCE_MODE
const LEASE_MS = 5 * 60 * 1000

/** The durable store's test seam, read loosely so this file also runs against main (where it does not exist). */
type Seam = {
  settleFailures?: Error[]
  claimFailures?: Error[]
  now?: () => number
  beforeFencedWrite?: (path: string) => Promise<void>
}
const seam = (): Seam => ((idempotency as unknown as { idempotencyTestSeam?: Seam }).idempotencyTestSeam ?? {}) as Seam
function resetSeam() {
  const s = (idempotency as unknown as { idempotencyTestSeam?: Record<string, unknown> }).idempotencyTestSeam
  if (s) for (const k of Object.keys(s)) delete s[k]
}

/** Everything a Next process holds in memory is gone; Firestore is not. */
function restart() {
  resetRuntimeStoreForTests()
  idempotency.resetIdempotencyForTests()
  resetProductionFirestoreForTests()
  setFirestorePersistenceForTests(null)
}

let appB: App | undefined
/** A second Next instance: its own firebase-admin app and Firestore client, the same database. */
function instanceB(): Firestore {
  appB ??= initializeApp({ projectId: env.FIREBASE_PROJECT_ID ?? env.GCLOUD_PROJECT ?? "demo-sikander" }, "f10-instance-b")
  return getFirestore(appB)
}

beforeEach(async () => {
  env.GCLOUD_PROJECT ??= "demo-sikander"
  env.FIREBASE_PROJECT_ID ??= "demo-sikander"
  restart()
  resetSeam()
  env.SIKANDER_PERSISTENCE_MODE = "firestore"
  await seedFirmARuntimeRecords()
})

afterEach(() => {
  if (savedMode === undefined) delete env.SIKANDER_PERSISTENCE_MODE
  else env.SIKANDER_PERSISTENCE_MODE = savedMode
  setTransportForTests(null)
  resetSeam()
  restart()
})

afterAll(async () => {
  if (appB && getApps().includes(appB)) await deleteApp(appB)
})

type Json = Record<string, unknown> & {
  result?: Record<string, unknown>
  reused?: boolean
  code?: string
  operationId?: string
  effectCommitted?: { operationId?: string }
}
type Answer = { status: number; json: Json; committed: string | null }

/** Re-audit MEDIUM-1 (spec ruling 15): the header that tells a caller its key's effect committed. */
const COMMITTED_HEADER = "Idempotency-Effect-Committed"

async function send(handler: (r: Request) => Promise<Response>, url: string, body: unknown, key: string): Promise<Answer> {
  const res = await handler(
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) })
  )
  return { status: res.status, json: (await res.json()) as Json, committed: res.headers.get(COMMITTED_HEADER) }
}

/** The answer carries the effect-committed signal for `operationId`, in its header and in its body. */
function expectSignalled(a: Answer, operationId?: string) {
  expect(a.committed).toEqual(operationId ?? expect.any(String))
  expect(a.json.effectCommitted).toEqual({ operationId: a.committed })
}

/** The durable record's id (spec §2.2), computed here so this file also runs against main. */
const durableDocId = (firmId: string, userId: string, route: string, key: string) =>
  "n_" + createHash("sha256").update([firmId, userId, route, key.toLowerCase()].join("|")).digest("hex")

async function recordsOf(userId: string, route: string, key: string) {
  const db = await getProductionFirestore()
  const id = durableDocId("firmA", userId, route, key)
  const record = await db.collection("idempotency_keys").doc(id).get()
  const marker = await db.collection("idempotency_effects").doc(id).get()
  return { id, record: record.exists ? record.data() : undefined, marker: marker.exists ? marker.data() : undefined }
}
const ms = (v: unknown) => (v as { toMillis(): number }).toMillis()

async function seedMatter(): Promise<string> {
  const db = await getProductionFirestore()
  const matterId = `mat_f10_${randomUUID()}`
  await db.collection("matters").doc(matterId).set({
    id: matterId,
    firmId: "firmA",
    clientId: "client_a",
    title: "F10 matter",
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "engagement_unconfirmed",
    classification: "internal",
  })
  await db.collection("matter_members").doc(`${matterId}_partner_a`).set({ matterId, userId: "partner_a", firmId: "firmA" })
  return matterId
}

/** A client of firm A with a fresh name and CNIC, so no other test's rows link to it. */
function clientBody(name: string) {
  return {
    action: "create",
    actorId: "partner_a",
    firmId: "firmA",
    canonicalName: name,
    cnic: String(randomInt(10 ** 12, 10 ** 13 - 1)),
    phone: "03001234567",
    classification: "internal",
  }
}
const createClient = (body: ReturnType<typeof clientBody>, key: string) => send(clientsPost, "http://127.0.0.1/api/d1/clients", body, key)
const entityIdOf = (r: { json: Json }) => (r.json.result?.entity as { id: string } | undefined)?.id

async function entitiesNamed(name: string): Promise<number> {
  const db = await getProductionFirestore()
  return (await db.collection("entities").where("canonicalName", "==", name).get()).size
}

/** Makes the runtime store's audit log throw once when the route records `action`: every effect write before it has committed. */
function throwOnceOnAudit(action: string): () => boolean {
  const log = getRuntimeStore().audit
  const original = log.push.bind(log)
  let thrown = false
  log.push = (...rows: AuditEntry[]) => {
    if (!thrown && rows.some((r) => r.action === action)) {
      thrown = true
      throw new Error("instance died after the effect")
    }
    return original(...rows)
  }
  return () => thrown
}

/** Same, for a runtime-store map the route caches into after its writes. */
function throwOnceOnCache<V>(map: Map<string, V>): () => boolean {
  const original = map.set.bind(map)
  let thrown = false
  map.set = (k: string, v: V) => {
    if (!thrown) {
      thrown = true
      throw new Error("instance died after the effect")
    }
    return original(k, v)
  }
  return () => thrown
}

describe("audit F10: the audit's scenarios through the real Next routes (RED on main)", () => {
  it("a client created before a restart: the same request after the restart replays it, and the client exists once", async () => {
    const body = clientBody(`F10 restart ${randomUUID()}`)
    const key = randomUUID()
    const first = await createClient(body, key)
    expect([first.status, first.json.reused]).toEqual([200, false])
    restart()
    const again = await createClient(body, key)
    expect(await entitiesNamed(body.canonicalName)).toBe(1)
    expect([again.status, again.json.reused, entityIdOf(again)]).toEqual([200, true, entityIdOf(first)])
  })

  it("a client created on instance A: the same request on instance B (its own Firestore client) replays it, and the client exists once", async () => {
    const body = clientBody(`F10 instance B ${randomUUID()}`)
    const key = randomUUID()
    const onA = await createClient(body, key)
    expect(onA.status).toBe(200)
    // Instance B: another process (no memory of A) with its own Firestore client on the same database.
    restart()
    setFirestorePersistenceForTests(instanceB())
    const onB = await createClient(body, key)
    expect(await entitiesNamed(body.canonicalName)).toBe(1)
    expect([onB.status, onB.json.reused, entityIdOf(onB)]).toEqual([200, true, entityIdOf(onA)])
  })

  it("a throw after the effect committed: the same-key retry answers 409 idempotency_effect_committed, and the client is not created twice", async () => {
    const body = clientBody(`F10 throw after effect ${randomUUID()}`)
    const key = randomUUID()
    const thrown = throwOnceOnAudit("client_create")
    const first = await createClient(body, key)
    expect(thrown()).toBe(true)
    expect(await entitiesNamed(body.canonicalName)).toBe(1)
    const retry = await createClient(body, key)
    expect(await entitiesNamed(body.canonicalName)).toBe(1)
    // The request keeps the route's own catch-all answer (spec ruling 9), and both it and its retry carry the
    // effect-committed signal (ruling 15, re-audit MEDIUM-1): a caller is never told only "failed" for an effect that landed.
    expect([first.status, first.json.code]).toEqual([400, "REQUEST_FAILED"])
    expectSignalled(first)
    expect([retry.status, retry.json.code, retry.json.operationId]).toEqual([409, "idempotency_effect_committed", first.committed])
    expectSignalled(retry, first.committed!)
  })

  it("committee-brain: the provider answered and the output committed, then the request failed; the same-key retry makes no second provider call", async () => {
    // A matter of firm A with partner_a as a member, as the repositories store it.
    const matterId = await seedMatter()
    let calls = 0
    setTransportForTests({
      async send() {
        calls += 1
        return { text: "Drafted reply" }
      },
    })
    const key = randomUUID()
    const body = { actorId: "partner_a", body: "Draft a reply to the notice.", matterId, classification: "internal" }
    const thrown = throwOnceOnCache(getRuntimeStore().committeeOutputs)
    const first = await send(committeePost, "http://127.0.0.1/api/p1/committee-brain", body, key)
    expect(thrown()).toBe(true)
    expect(first.status).not.toBe(200)
    const retry = await send(committeePost, "http://127.0.0.1/api/p1/committee-brain", body, key)
    expect(calls).toBe(1)
    expect([retry.status, retry.json.code]).toEqual([409, "idempotency_effect_committed"])
    expectSignalled(first)
    expectSignalled(retry, first.committed!)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Re-audit of 08c0990 (PASS 7.5), MEDIUM-2: the auditor's attacks, adopted so that each load-bearing claim has a test
// that a mutant of it fails (spec §7, the mutant table in the plan's execution record).
// ---------------------------------------------------------------------------------------------------------------------
describe("re-audit attacks: the effect fence's load-bearing claims", () => {
  it("ATK-9b: a fenced write commits but its acknowledgement is lost; the marker committed in the same transaction, so the answer says so and the retry is 409, never a re-run", async () => {
    const body = clientBody(`F10 ATK-9b ${randomUUID()}`)
    const key = randomUUID()
    const db = await getProductionFirestore()
    const original = db.runTransaction.bind(db)
    let armed = false
    let fired = false
    seam().beforeFencedWrite = async () => {
      if (!fired) armed = true
    }
    ;(db as unknown as { runTransaction: unknown }).runTransaction = async (fn: never, opts?: never) => {
      const out = await original(fn, opts)
      if (armed && !fired) {
        fired = true
        armed = false
        throw new Error("DEADLINE_EXCEEDED: commit acknowledgement lost")
      }
      return out
    }
    try {
      const first = await createClient(body, key)
      const after = await recordsOf("partner_a", "POST /api/d1/clients", key)
      const retry = await createClient(body, key)
      expect(fired).toBe(true)
      expect(await entitiesNamed(body.canonicalName)).toBe(1)
      expect(after.marker).toMatchObject({ kind: "transaction" })
      expect([first.status, first.json.code]).toEqual([400, "REQUEST_FAILED"])
      expectSignalled(first, after.marker!.operationId as string)
      expect([retry.status, retry.json.code]).toEqual([409, "idempotency_effect_committed"])
    } finally {
      ;(db as unknown as { runTransaction: unknown }).runTransaction = original
    }
  })

  it("ATK-14: committee-brain, the provider answered and the output write failed before committing; the dispatch was marked first, so the retry pays nothing", async () => {
    const matterId = await seedMatter()
    let calls = 0
    let dispatched = false
    let thrown = false
    setTransportForTests({
      async send() {
        calls += 1
        dispatched = true
        return { text: "paid answer" }
      },
    })
    seam().beforeFencedWrite = async () => {
      if (dispatched && !thrown) {
        thrown = true
        throw new Error("UNAVAILABLE: output write failed")
      }
    }
    const key = randomUUID()
    const body = { actorId: "partner_a", body: "Draft a reply.", matterId, classification: "internal" }
    const first = await send(committeePost, "http://127.0.0.1/api/p1/committee-brain", body, key)
    const retry = await send(committeePost, "http://127.0.0.1/api/p1/committee-brain", body, key)
    expect(thrown).toBe(true)
    expect(calls).toBe(1)
    expect((await recordsOf("partner_a", "POST /api/p1/committee-brain", key)).marker).toMatchObject({ kind: "p1_dispatch" })
    expectSignalled(first)
    expect([retry.status, retry.json.code]).toEqual([409, "idempotency_effect_committed"])
  })

  it("ATK-15: a decided refusal before any effect (403, clearance) releases the key: no record is kept, and the same key is evaluated afresh, never a stored refusal replayed", async () => {
    const db = await getProductionFirestore()
    const body = { ...clientBody(`F10 ATK-15 ${randomUUID()}`), actorId: "associate_a", classification: "privileged-restricted" }
    const key = randomUUID()
    const first = await createClient(body, key)
    expect(first.status).toBe(403)
    expect(first.committed).toBeNull()
    const docId = durableDocId("firmA", "associate_a", "POST /api/d1/clients", key)
    expect((await db.collection("idempotency_keys").doc(docId).get()).exists).toBe(false)
    restart()
    const retry = await createClient(body, key)
    // A replay would carry `reused: true`; a fresh evaluation does not.
    expect([retry.status, retry.json.reused, retry.committed]).toEqual([403, undefined, null])
    expect((await db.collection("idempotency_keys").doc(docId).get()).exists).toBe(false)
    expect(await entitiesNamed(body.canonicalName)).toBe(0)
  })

  it("ATK-11: the marker and the record share one window (24 h from the first claim); an adopted orphan keeps it; after it the key is a new operation", async () => {
    const body = clientBody(`F10 ATK-11 ${randomUUID()}`)
    const key = randomUUID()
    expect((await createClient(body, key)).status).toBe(200)
    const { id, record, marker } = await recordsOf("partner_a", "POST /api/d1/clients", key)
    expect(ms(marker?.expiresAt)).toBe(ms(record?.expiresAt))
    expect(ms(record?.expiresAt) - ms(record?.createdAt)).toBe(24 * 60 * 60 * 1000)
    // The record is lost; instance B adopts the orphan marker within its window and keeps that window.
    const db = await getProductionFirestore()
    await db.collection("idempotency_keys").doc(id).delete()
    restart()
    setFirestorePersistenceForTests(instanceB())
    const adopted = await createClient(body, key)
    expect([adopted.status, adopted.json.code]).toEqual([409, "idempotency_effect_committed"])
    const after = await recordsOf("partner_a", "POST /api/d1/clients", key)
    expect(ms(after.record?.expiresAt)).toBe(ms(marker?.expiresAt))
    // One second past the window: the key is a new operation, by design (24 h keys, spec §8).
    seam().now = () => Date.now() + 24 * 60 * 60 * 1000 + 1_000
    const late = await createClient(body, key)
    expect([late.status, late.json.reused]).toEqual([200, false])
  })

  it("ATK-8a: production refuses memory and unset modes, and the durable store's test seam is inert in production", async () => {
    const req = () => new Request("http://127.0.0.1/api/f10/thing", { method: "POST" })
    const saved = { NODE_ENV: env.NODE_ENV, mode: env.SIKANDER_PERSISTENCE_MODE }
    const outcome = (p: Promise<{ response?: Response }>) =>
      p.then(
        (r) => `resolved ${r.response?.status ?? "claim"}`,
        (e: Error) => `threw ${e.name}`
      )
    const out: Record<string, string> = {}
    try {
      env.NODE_ENV = "production"
      env.SIKANDER_PERSISTENCE_MODE = "memory"
      out.memory = await outcome(idempotency.beginIdempotentRequest(req(), randomUUID(), "fp"))
      delete env.SIKANDER_PERSISTENCE_MODE
      out.unset = await outcome(idempotency.beginIdempotentRequest(req(), randomUUID(), "fp"))
      env.SIKANDER_PERSISTENCE_MODE = "firestore"
      seam().claimFailures = [new Error("the seam must be inert in production")]
      out.seam = await idempotency.runWithIdempotencyScope({ firmId: "firmA", userId: "partner_a" }, async () => {
        const r = await idempotency.beginIdempotentRequest(req(), randomUUID(), "fp")
        return r.claim ? "claimed (seam inert)" : `answered ${r.response.status}`
      })
    } finally {
      env.NODE_ENV = saved.NODE_ENV
      env.SIKANDER_PERSISTENCE_MODE = saved.mode
    }
    expect(out).toEqual({ memory: "threw PersistenceConfigurationError", unset: "threw PersistenceConfigurationError", seam: "claimed (seam inert)" })
  })

  it("ATK-13 (re-audit LOW-4, recorded): a document ingest whose second write fails is rolled back by the route, yet its key still answers that an effect committed", async () => {
    const matterId = await seedMatter()
    const db = await getProductionFirestore()
    const body = {
      action: "ingest",
      actorId: "partner_a",
      firmId: "firmA",
      matterId,
      contentBase64: Buffer.from(`F10 ATK-13 ${randomUUID()}`).toString("base64"),
      sourceChannel: "web",
      mimeType: "text/plain",
    }
    let n = 0
    seam().beforeFencedWrite = async () => {
      n += 1
      if (n === 2) throw new Error("UNAVAILABLE: jobs write failed")
    }
    const key = randomUUID()
    const first = await send(documentsPost, "http://127.0.0.1/api/d1/documents", body, key)
    delete seam().beforeFencedWrite
    expect(first.status).toBe(400)
    expect((await db.collection("documents").where("matterId", "==", matterId).get()).size).toBe(0)
    // Conservative: the compensated write still counts, so the caller is told, and the key is spent (spec §8, LOW-4).
    expectSignalled(first)
    const retry = await send(documentsPost, "http://127.0.0.1/api/d1/documents", body, key)
    expect([retry.status, retry.json.code]).toEqual([409, "idempotency_effect_committed"])
  })
})

describe("audit F10: the effect/settlement boundaries through the real route (durable store)", () => {
  it("concurrent duplicates: exactly one runs; the other gets 409 idempotency_in_progress, or the replay if its claim transaction retried after the first finished; one client", async () => {
    const body = clientBody(`F10 concurrent ${randomUUID()}`)
    const key = randomUUID()
    const rs = await Promise.all([createClient(body, key), createClient(body, key), createClient(body, key)])
    const ran = rs.filter((r) => r.status === 200 && r.json.reused === false)
    expect(ran).toHaveLength(1)
    for (const r of rs.filter((x) => x !== ran[0])) {
      const answer = r.status === 200 ? { status: 200, reused: r.json.reused, id: entityIdOf(r) } : { status: r.status, code: r.json.code }
      expect([{ status: 200, reused: true, id: entityIdOf(ran[0]!) }, { status: 409, code: "idempotency_in_progress" }]).toContainEqual(answer)
    }
    expect(await entitiesNamed(body.canonicalName)).toBe(1)
    const replay = await createClient(body, key)
    expect([replay.status, replay.json.reused]).toEqual([200, true])
  })

  it("a refusal before any effect releases the key: a corrected retry with the same key runs", async () => {
    const body = clientBody(`F10 refusal ${randomUUID()}`)
    const key = randomUUID()
    const bad = await createClient({ ...body, cnic: "123" }, key)
    expect(bad.status).toBe(400)
    expect(await entitiesNamed(body.canonicalName)).toBe(0)
    const good = await createClient(body, key)
    expect([good.status, good.json.reused]).toEqual([200, false])
    expect(await entitiesNamed(body.canonicalName)).toBe(1)
  })

  it("the settle write fails for good after a 2xx: the key holds 409 in_progress during the lease, then answers 409 idempotency_effect_committed; one client", async () => {
    const body = clientBody(`F10 settle failure ${randomUUID()}`)
    const key = randomUUID()
    seam().settleFailures = [new Error("down"), new Error("down"), new Error("down"), new Error("down")]
    const first = await createClient(body, key)
    expect(first.status).toBe(200)
    restart()
    const during = await createClient(body, key)
    expect([during.status, during.json.code]).toEqual([409, "idempotency_in_progress"])
    seam().now = () => Date.now() + LEASE_MS + 1_000
    const after = await createClient(body, key)
    expect([after.status, after.json.code]).toEqual([409, "idempotency_effect_committed"])
    expect(after.json.operationId).toEqual(expect.any(String))
    expect(await entitiesNamed(body.canonicalName)).toBe(1)
  })

  it("takeover after the lease: B runs; the stale holder A, resumed, is fenced at its first write (409 idempotency_claim_lost); one client", async () => {
    const body = clientBody(`F10 stale holder ${randomUUID()}`)
    const key = randomUUID()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reached!: () => void
    const atWrite = new Promise<void>((r) => (reached = r))
    let first = true
    seam().beforeFencedWrite = async () => {
      if (!first) return
      first = false
      reached()
      await held
    }
    const a = createClient(body, key)
    await atWrite
    // A is stalled before its first effect write. Its lease lapses; B (the same request) takes over and runs.
    seam().now = () => Date.now() + LEASE_MS + 1_000
    const b = await createClient(body, key)
    expect([b.status, b.json.reused]).toEqual([200, false])
    release()
    const resultA = await a
    expect([resultA.status, resultA.json.code]).toEqual([409, "idempotency_claim_lost"])
    expect(await entitiesNamed(body.canonicalName)).toBe(1)
  })

  it("the durable store cannot be reached at claim: 503 idempotency_store_unavailable, and nothing runs", async () => {
    const body = clientBody(`F10 store down ${randomUUID()}`)
    seam().claimFailures = [new Error("unavailable")]
    const r = await createClient(body, randomUUID())
    expect([r.status, r.json.code]).toEqual([503, "idempotency_store_unavailable"])
    expect(await entitiesNamed(body.canonicalName)).toBe(0)
  })
})
