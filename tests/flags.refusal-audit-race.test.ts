// Final audit F5: a refusal deduped while the covering feature_disabled write is in flight
// awaits that write; if it fails, the deduped caller writes its own row (or fails). No 404
// refusal is ever answered without a durable feature_disabled row covering it.
import { afterEach, describe, expect, it, vi } from "vitest"

let failures = 0
let hold = false
let release: () => void = () => {}
vi.mock("@/platform/persistence/runtimeRepositories", async (orig) => {
  const real = (await orig()) as typeof import("@/platform/persistence/runtimeRepositories")
  return {
    ...real,
    getRuntimeRepositories: async (store: never) => {
      const repos = await real.getRuntimeRepositories(store)
      return {
        ...repos,
        audit: {
          ...repos.audit,
          append: async (row: never) => {
            if (hold) {
              hold = false
              await new Promise<void>((r) => (release = r))
            }
            if (failures > 0) {
              failures -= 1
              throw new Error("audit store down")
            }
            return repos.audit.append(row)
          },
        },
      }
    },
  }
})

import { gateByFlag, resetRefusalAuditDedupeForTests } from "@/platform/flags/routeGate"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

afterEach(() => {
  failures = 0
  hold = false
  resetRefusalAuditDedupeForTests()
  resetRuntimeStoreForTests()
})

const session = { userId: "partner_a", firmId: "firmA", role: "partner", clearance: "privileged-restricted", mode: "firebase" } as const
const mk = () => new Request("http://127.0.0.1/api/d4/filings?view=dispatch_queue")
const rows = () => getRuntimeStore().audit.filter((r) => r.action === "feature_disabled")
const tick = () => new Promise((r) => setTimeout(r, 10))

describe("refusal-audit dedupe race (final audit F5)", () => {
  it("a deduped refusal waits for the in-flight write and writes its own row when that fails", async () => {
    const handler = gateByFlag("LEGACY_GOVERNANCE_CHAINS", async () => new Response("live"))
    hold = true
    failures = 1
    const first = Promise.resolve(handler(mk(), session)).then((r) => r.status, () => "threw")
    await tick()
    let secondDone = false
    const second = Promise.resolve(handler(mk(), session)).then((r) => {
      secondDone = true
      return r.status
    })
    await tick()
    // the deduped refusal is not answered while the covering write is still in flight
    expect(secondDone).toBe(false)
    release()
    expect(await first).toBe("threw")
    expect(await second).toBe(404)
    expect(rows()).toHaveLength(1)
  })

  it("a deduped refusal whose covering write succeeded adds no row", async () => {
    const handler = gateByFlag("LEGACY_GOVERNANCE_CHAINS", async () => new Response("live"))
    hold = true
    const first = Promise.resolve(handler(mk(), session)).then((r) => r.status)
    await tick()
    const second = Promise.resolve(handler(mk(), session)).then((r) => r.status)
    await tick()
    release()
    expect(await first).toBe(404)
    expect(await second).toBe(404)
    expect(rows()).toHaveLength(1)
  })

  it("fails (no 404) when neither the covering write nor its own retry can be stored", async () => {
    const handler = gateByFlag("LEGACY_GOVERNANCE_CHAINS", async () => new Response("live"))
    hold = true
    failures = 2
    const first = Promise.resolve(handler(mk(), session)).then((r) => r.status, () => "threw")
    await tick()
    const second = Promise.resolve(handler(mk(), session)).then((r) => r.status, () => "threw")
    await tick()
    release()
    expect(await first).toBe("threw")
    expect(await second).toBe("threw")
    expect(rows()).toHaveLength(0)
  })
})
