/**
 * FA-F02-001: a Next core that commits a write and then returns 4xx attaches
 * `Idempotency-Effect-Committed` and `effectCommitted`. The Functions authority
 * response must keep both. Dropping them lets a client retry under a new
 * Idempotency-Key and duplicate the write.
 */
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

const store = new Map<string, Record<string, unknown>>()
let auto = 0

function snap(path: string) {
  const data = store.get(path)
  return {
    exists: data !== undefined,
    data: () => data,
    get: (field: string) => data?.[field],
    id: path.split("/").pop(),
  }
}

vi.mock("../functions/src/admin", () => ({
  adminDb: () => ({
    collection(name: string) {
      return {
        doc(id?: string) {
          const docId = id ?? `auto-${++auto}`
          const path = `${name}/${docId}`
          return {
            id: docId,
            path,
            create: async (data: Record<string, unknown>) => {
              store.set(path, data)
            },
          }
        },
      }
    },
    async runTransaction(fn: (tx: {
      getAll: (...refs: Array<{ path: string }>) => Promise<ReturnType<typeof snap>[]>
      set: (ref: { path: string }, data: Record<string, unknown>) => void
      update: (ref: { path: string }, data: Record<string, unknown>) => void
      delete: (ref: { path: string }) => void
      create: (ref: { path: string }, data: Record<string, unknown>) => void
    }) => Promise<unknown>) {
      return fn({
        getAll: async (...refs) => refs.map((ref) => snap(ref.path)),
        set(ref, data) {
          store.set(ref.path, { ...data })
        },
        update(ref, data) {
          store.set(ref.path, { ...(store.get(ref.path) ?? {}), ...data })
        },
        delete(ref) {
          store.delete(ref.path)
        },
        create(ref, data) {
          store.set(ref.path, { ...data })
        },
      })
    },
  }),
}))

vi.mock("../functions/src/p5/auth", () => {
  class TokenRejectedError extends Error {
    uid?: string
  }
  return {
    TokenRejectedError,
    verifyBearer: async () => ({ uid: "uid-1", firmId: "firm-1", role: "partner", clearanceLevel: "internal" }),
    bindHttpSession: async (decoded: { uid: string }) => ({
      caller: { uid: decoded.uid, firmId: "firm-1", role: "partner", clearanceLevel: "internal" },
      secondFactor: false,
      firm: {},
    }),
    firmlessFromToken: async () => {
      throw new Error("unused")
    },
  }
})

vi.mock("../functions/src/http/rateLimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../functions/src/http/rateLimit")>()
  return { ...actual, rateLimit: async () => {}, rateLimitAnonymous: async () => {} }
})

import { createRouter } from "../functions/src/http/router"
import { F02_NEXT_AUTHORITY_ROUTES } from "../functions/src/http/f02NextAuthority"
import { registerF02Core, runWithF02Pending, snapshotF02CoresForTests } from "@/platform/authority/f02Registry"
import { F02_MATTERS } from "@/platform/authority/f02Routes"

const COMMITTED_HEADER = "idempotency-effect-committed"

function collect() {
  const out = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown }
  const res = {
    status(n: number) {
      out.status = n
      return res
    },
    set(name: string, value: string) {
      out.headers[name.toLowerCase()] = value
      return res
    },
    json(body: unknown) {
      out.body = body
      return res
    },
  }
  return { res, out }
}

const mattersPost = F02_NEXT_AUTHORITY_ROUTES.find((route) => route.method === "POST" && route.path === F02_MATTERS)
if (!mattersPost) throw new Error("POST /api/d1/matters is not an F02 authority route")

function requestFor(key: string): Request {
  return new Request("http://127.0.0.1/api/d1/matters", {
    method: "POST",
    headers: {
      authorization: "Bearer token",
      "x-firm-id": "firm-1",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: "{}",
  })
}

async function post(operationId: string, key: string) {
  const { res, out } = collect()
  await runWithF02Pending(requestFor(key), null, async () => {
    const router = createRouter([mattersPost!], { now: () => Date.parse("2026-10-23T00:00:00Z") })
    await router(
      {
        method: "POST",
        path: F02_MATTERS,
        headers: {
          authorization: "Bearer token",
          "x-firm-id": "firm-1",
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: {},
        rawBody: Buffer.from("{}"),
        ip: "127.0.0.1",
      } as never,
      res as never
    )
  })
  return { out, operationId }
}

describe("F02 authority keeps a committed write's refusal signal", () => {
  let restore: () => void = () => {}

  afterEach(() => {
    restore()
    store.clear()
  })

  it("relays Idempotency-Effect-Committed and effectCommitted when the core writes and then returns 422", async () => {
    const operationId = randomUUID()
    let writes = 0
    restore = snapshotF02CoresForTests()
    registerF02Core(F02_MATTERS, "POST", async () => {
      writes += 1
      return new Response(
        JSON.stringify({
          error: "closure follow-up queue is already resolved",
          code: "already_resolved",
          effectCommitted: { operationId },
        }),
        { status: 422, headers: { "Idempotency-Effect-Committed": operationId } }
      )
    })

    const firstKey = randomUUID()
    const first = await post(operationId, firstKey)
    const body = first.out.body as { error?: { code?: string }; effectCommitted?: { operationId?: string }; reused?: boolean }

    expect(writes).toBe(1)
    expect(first.out.status).toBe(422)
    expect(first.out.headers[COMMITTED_HEADER]).toBe(operationId)
    expect(body.effectCommitted).toEqual({ operationId })
    expect(body.error).toEqual({ code: "already_resolved" })
    expect(body.reused).toBeUndefined()

    const again = await post(operationId, firstKey)
    const replay = again.out.body as { effectCommitted?: { operationId?: string }; reused?: boolean }
    expect(writes).toBe(1)
    expect(again.out.status).toBe(422)
    expect(again.out.headers[COMMITTED_HEADER]).toBe(operationId)
    expect(replay.effectCommitted).toEqual({ operationId })
    expect(replay.reused).toBe(true)

    const fresh = await post(operationId, randomUUID())
    const freshBody = fresh.out.body as { effectCommitted?: { operationId?: string } }
    expect(fresh.out.headers[COMMITTED_HEADER]).toBe(operationId)
    expect(freshBody.effectCommitted).toEqual({ operationId })
  })
})
