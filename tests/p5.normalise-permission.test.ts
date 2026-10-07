// Re-audit N-2: POST /api/g0/normalise had no permission check, so a client got 200. It is now
// the staff action "normalise_case_number" in the shared permission table (platform/p5/
// permissionDecision.ts): partner, associate, clerk and intern may use it; a client (or an
// own-matters scope) is refused "staff-only", and accounts keep their register-only rule.
import { afterEach, describe, expect, it } from "vitest"
import { POST } from "@/app/api/g0/normalise/route"
import { decide, STAFF_ONLY_ACTIONS } from "@/platform/p5/permissionDecision"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

afterEach(() => resetRuntimeStoreForTests())

let n = 0
const key = () => `0a0a0a0a-0000-4000-8000-${String(++n).padStart(12, "0")}`
const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://127.0.0.1/api/g0/normalise", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )
const CASE = { raw: "C.P. No. D-1234 of 2025", courtId: "SHC" }

describe("normalise_case_number in the shared permission table", () => {
  const caller = (role: string) => ({ role, firmId: "f", clearanceLevel: "internal" as const })

  it("is a declared staff-only action", () => {
    expect(STAFF_ONLY_ACTIONS.has("normalise_case_number")).toBe(true)
  })

  it("allows the staff roles and refuses a client, or an own-matters scope, with staff-only", () => {
    for (const role of ["partner", "associate", "clerk", "intern"]) {
      expect(decide(caller(role), "normalise_case_number", undefined, false)).toEqual({ allow: true, reason: "ok" })
    }
    expect(decide(caller("client"), "normalise_case_number", undefined, false)).toEqual({ allow: false, reason: "staff-only" })
    expect(decide(caller("associate"), "normalise_case_number", undefined, false, { scope: "own_matters" })).toEqual({
      allow: false,
      reason: "staff-only",
    })
    expect(decide(caller("accounts"), "normalise_case_number", undefined, false)).toEqual({
      allow: false,
      reason: "accounts-register-only",
    })
  })
})

describe("POST /api/g0/normalise authorises through checkPermission", () => {
  it("a client gets 403 and the refusal is audited; nothing is normalised", async () => {
    const res = await post({ actorId: "client_a", ...CASE })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toEqual({ error: "permission denied: staff-only" })
    const row = getRuntimeStore().audit.find((r) => r.actorId === "client_a" && r.action === "permission_check")
    expect(row).toMatchObject({ target: "normalise_case_number", reason: "deny:normalise_case_number:staff-only" })
  })

  it("staff get 200 with the normalised number", async () => {
    for (const actorId of ["partner_a", "associate_a", "clerk_a"]) {
      const res = await post({ actorId, ...CASE })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { result: { canonical: string } }).result.canonical).toBe("CP D-1234/2025")
    }
  })

  it("a request without an actor is 400, and an unknown actor is 403", async () => {
    expect((await post(CASE)).status).toBe(400)
    expect((await post({ actorId: "nobody", ...CASE })).status).toBe(403)
  })
})
