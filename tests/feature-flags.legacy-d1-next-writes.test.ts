import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { POST as clientsPost } from "@/app/api/d1/clients/route"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { FEATURE_FLAGS } from "@/lib/foundation-data"
import { FLAG_REGISTRY, isFeatureEnabled } from "@/platform/flags/featureFlags"
import { resetRefusalAuditDedupeForTests } from "@/platform/flags/routeGate"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

/**
 * Phase 2a final review I3: the Next.js D1 check-free paths (matters `create`, clients
 * `conflict_check`) sit behind LEGACY_D1_NEXT_WRITES, default off. Matters open only through the
 * Cloud Functions openMatter route on a cleared Module 6 check (spec success criterion; E-38(a)).
 * This file is not opted in (tests/setup/legacy-chains.ts), so it sees the production default.
 */

const FLAG_ENV = "SIKANDER_FLAG_LEGACY_D1_NEXT_WRITES"
const DISABLED = { error: "feature_disabled", flag: "LEGACY_D1_NEXT_WRITES" }

afterEach(() => {
  vi.unstubAllEnvs()
  resetRuntimeStoreForTests()
  resetRefusalAuditDedupeForTests()
})

function post(route: typeof mattersPost, path: string, body: unknown) {
  return route(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    })
  )
}

const createMatter = {
  action: "create",
  actorId: "partner_a",
  firmId: "firmA",
  clientId: "client_a",
  title: "Check-free matter",
  courtId: "SHC",
  classification: "internal",
}

async function registerClient(): Promise<string> {
  const res = await post(clientsPost, "/api/d1/clients", {
    action: "create",
    actorId: "partner_a",
    firmId: "firmA",
    canonicalName: "Ali Raza",
    cnic: "42201-1234567-8",
    phone: "+923001112233",
    classification: "internal",
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { result: { entity: { id: string } } }).result.entity.id
}

describe("LEGACY_D1_NEXT_WRITES (final review I3)", () => {
  it("is registered off by default, in the seed DDL and foundation-data", () => {
    expect(FLAG_REGISTRY.LEGACY_D1_NEXT_WRITES.defaultEnabled).toBe(false)
    expect(isFeatureEnabled("LEGACY_D1_NEXT_WRITES")).toBe(false)
    expect(readFileSync("postgres/ddl/002_platform.sql", "utf8")).toMatch(/\('LEGACY_D1_NEXT_WRITES','[^']*',false,'[^']*'\)/)
    expect(FEATURE_FLAGS.find((f) => f.flag === "LEGACY_D1_NEXT_WRITES")?.defaultEnabled).toBe(false)
  })

  it("with the flag off, matters create and clients conflict_check are refused as feature_disabled; nothing is created", async () => {
    const entityId = await registerClient() // clients create stays live
    const before = getRuntimeStore().matters.size

    const created = await post(mattersPost, "/api/d1/matters", createMatter)
    expect(created.status).toBe(404)
    expect(await created.json()).toEqual(DISABLED)
    expect(getRuntimeStore().matters.size).toBe(before)

    const check = await post(clientsPost, "/api/d1/clients", { action: "conflict_check", actorId: "partner_a", firmId: "firmA", entityId })
    expect(check.status).toBe(404)
    expect(await check.json()).toEqual(DISABLED)

    const refusals = getRuntimeStore().audit.filter((row) => row.action === "feature_disabled")
    expect(refusals.map((row) => [row.target, row.reason])).toEqual([
      ["POST /api/d1/matters", "LEGACY_D1_NEXT_WRITES"],
      ["POST /api/d1/clients", "LEGACY_D1_NEXT_WRITES"],
    ])
  })

  it("with the flag off, the other matters actions and the GET list still run (no other behaviour changes)", async () => {
    const list = await mattersGet(new Request("http://127.0.0.1/api/d1/matters?userId=partner_a&limit=10&cursor=0"))
    expect(list.status).toBe(200)
    const addMember = await post(mattersPost, "/api/d1/matters", { action: "add_member", actorId: "partner_a", matterId: "no-such-matter", memberUserId: "clerk_a" })
    expect(await addMember.json()).not.toEqual(DISABLED)
  })

  it("with the flag on, both actions run again", async () => {
    vi.stubEnv(FLAG_ENV, "true")
    const entityId = await registerClient()
    expect((await post(mattersPost, "/api/d1/matters", createMatter)).status).toBe(200)
    expect((await post(clientsPost, "/api/d1/clients", { action: "conflict_check", actorId: "partner_a", firmId: "firmA", entityId })).status).toBe(200)
  })
})
