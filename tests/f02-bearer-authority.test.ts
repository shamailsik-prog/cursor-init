/**
 * A missing bearer must not be a way around the Functions authority check for a
 * privileged write once production Firestore dispatch is on.
 *
 * Firebase mode (the only mode production can run) refuses before the core.
 * insecure-dev still serves the Next handler: that mode is local/tests only and
 * resolveAuthMode rejects it in production and on a hosted runtime. Those two
 * refusals are what make the no-bearer path safe.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { withF02Authority } from "@/platform/authority/f02Gate"
import { snapshotF02CoresForTests } from "@/platform/authority/f02Registry"
import { F02_MATTERS } from "@/platform/authority/f02Routes"
import type { HandlerSession } from "@/platform/http/withSession"

const session: HandlerSession = {
  userId: "user-1",
  firmId: "firm-1",
  role: "associate",
  clearance: "internal",
  mode: "firebase",
}

function privilegedWrite(): Request {
  return new Request("http://127.0.0.1/api/d1/matters", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "create",
      classification: "privileged-restricted",
      title: "sealed advice",
    }),
  })
}

describe("F02 privileged writes without a bearer", () => {
  let restore: () => void = () => {}

  afterEach(() => {
    restore()
    vi.unstubAllEnvs()
  })

  it("does not enter the core in firebase mode when Firestore authority is on", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    let calls = 0
    restore = snapshotF02CoresForTests()
    const handler = withF02Authority(F02_MATTERS, "POST", async () => {
      calls += 1
      return Response.json({ wrote: true })
    })
    const res = await handler(privilegedWrite(), session)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: "AUTH_REQUIRED" })
    expect(calls).toBe(0)
  })

  it("does not enter the core when insecure-dev is selected on a hosted runtime", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("SIKANDER_AUTH_MODE", "insecure-dev")
    vi.stubEnv("K_SERVICE", "sikander")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/f02-not-read.json")
    let calls = 0
    restore = snapshotF02CoresForTests()
    const handler = withF02Authority(F02_MATTERS, "POST", async () => {
      calls += 1
      return Response.json({ wrote: true })
    })
    const res = await handler(privilegedWrite(), { ...session, mode: "insecure-dev" })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: "AUTH_MISCONFIGURED" })
    expect(calls).toBe(0)
  })

  it("keeps the Next handler for a local insecure-dev call with no bearer", async () => {
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("SIKANDER_AUTH_MODE", "insecure-dev")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", "firestore")
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/f02-not-read.json")
    let calls = 0
    restore = snapshotF02CoresForTests()
    const handler = withF02Authority(F02_MATTERS, "POST", async () => {
      calls += 1
      return Response.json({ wrote: true })
    })
    const res = await handler(privilegedWrite(), { ...session, mode: "insecure-dev" })
    expect(res.status).toBe(200)
    expect(calls).toBe(1)
  })
})
