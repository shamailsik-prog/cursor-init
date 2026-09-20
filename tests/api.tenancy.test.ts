import { afterEach, describe, expect, it } from "vitest"
import { GET, POST } from "@/app/api/p5/tenancy/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function post(body: unknown, key: string) {
  return POST(
    new Request("http://127.0.0.1/api/p5/tenancy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

function get(params: URLSearchParams) {
  return GET(new Request(`http://127.0.0.1/api/p5/tenancy?${params.toString()}`))
}

function seedMatterMembership() {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Membership matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  return matter.id
}

describe("GET/POST /api/p5/tenancy", () => {
  it("builds session context and enforces firm scoping", async () => {
    const matterId = seedMatterMembership()
    const ok = await get(
      new URLSearchParams({
        view: "session",
        userId: "associate_a",
        firmId: "firmA",
        authBoundary: "external_session_hint",
        externalSessionId: "ext-session-a1",
      })
    )
    expect(ok.status).toBe(200)
    const okJson = (await ok.json()) as {
      session: { user: { id: string }; accessibleMatterIds: string[] }
      sessionReference: { id: string; authBoundary: string; externalSessionId: string | null }
    }
    expect(okJson.session.user.id).toBe("associate_a")
    expect(okJson.session.accessibleMatterIds).toContain(matterId)
    expect(okJson.sessionReference.authBoundary).toBe("external_session_hint")
    expect(okJson.sessionReference.externalSessionId).toBe("ext-session-a1")

    const replay = await get(
      new URLSearchParams({
        view: "session",
        sessionRefId: okJson.sessionReference.id,
      })
    )
    expect(replay.status).toBe(200)
    const replayJson = (await replay.json()) as {
      session: { user: { id: string }; accessibleMatterIds: string[] }
      sessionReference: { id: string }
    }
    expect(replayJson.session.user.id).toBe("associate_a")
    expect(replayJson.session.accessibleMatterIds).toContain(matterId)
    expect(replayJson.sessionReference.id).toBe(okJson.sessionReference.id)

    const denied = await get(
      new URLSearchParams({
        view: "session",
        userId: "associate_a",
        firmId: "firmB",
      })
    )
    expect(denied.status).toBe(400)

    const crossFirmRefDenied = await get(
      new URLSearchParams({
        view: "session",
        sessionRefId: okJson.sessionReference.id,
        firmId: "firmB",
      })
    )
    expect(crossFirmRefDenied.status).toBe(400)
  })

  it("lists users and memberships for partner admins with pagination", async () => {
    const matterId = seedMatterMembership()
    const users = await get(
      new URLSearchParams({
        view: "users",
        actorId: "partner_a",
        firmId: "firmA",
        limit: "2",
        cursor: "0",
      })
    )
    expect(users.status).toBe(200)
    const usersJson = (await users.json()) as {
      items: Array<{ id: string }>
      total: number
      nextCursor: string | null
    }
    expect(usersJson.total).toBeGreaterThan(0)
    expect(usersJson.items.length).toBeLessThanOrEqual(2)

    const memberships = await get(
      new URLSearchParams({
        view: "memberships",
        actorId: "partner_a",
        firmId: "firmA",
        matterId,
        limit: "10",
        cursor: "0",
      })
    )
    expect(memberships.status).toBe(200)
    const m = (await memberships.json()) as { items: Array<{ matterId: string }> }
    expect(m.items.some((row) => row.matterId === matterId)).toBe(true)
  })

  it("denies non-partner admin reads", async () => {
    seedMatterMembership()
    const denied = await get(
      new URLSearchParams({
        view: "users",
        actorId: "associate_a",
        firmId: "firmA",
        limit: "10",
        cursor: "0",
      })
    )
    expect(denied.status).toBe(400)

    const deniedRefs = await get(
      new URLSearchParams({
        view: "session_refs",
        actorId: "associate_a",
        firmId: "firmA",
        limit: "10",
        cursor: "0",
      })
    )
    expect(deniedRefs.status).toBe(400)
  })

  it("lists partner-admin audit entries and denies non-partner audit reads", async () => {
    const sessionRes = await get(
      new URLSearchParams({
        view: "session",
        userId: "partner_a",
        firmId: "firmA",
        authBoundary: "external_session_hint",
        externalSessionId: "ext-audit-actor",
      })
    )
    expect(sessionRes.status).toBe(200)
    const sessionJson = (await sessionRes.json()) as {
      sessionReference: { id: string }
    }

    const writeRes = await post(
      {
        action: "update_role",
        actorId: "partner_a",
        firmId: "firmA",
        targetUserId: "clerk_a",
        nextRole: "clerk",
        nextClearance: "internal",
        reason: "Audit list verification",
        sessionReferenceId: sessionJson.sessionReference.id,
        authBoundary: "external_session_hint",
        externalSessionId: "ext-audit-actor",
      },
      "bf379f5f-5e99-4f3b-9617-72d3f3c10f2d"
    )
    expect(writeRes.status).toBe(200)

    const auditRes = await get(
      new URLSearchParams({
        view: "audit",
        actorId: "partner_a",
        firmId: "firmA",
        limit: "10",
        cursor: "0",
      })
    )
    expect(auditRes.status).toBe(200)
    const auditJson = (await auditRes.json()) as {
      items: Array<{
        action: string
        target: string
        authBoundary?: string
        sessionReferenceId?: string | null
        externalSessionId?: string | null
      }>
      total: number
    }
    expect(auditJson.total).toBeGreaterThan(0)
    expect(
      auditJson.items.some(
        (row) => row.action === "tenant_update_role" && row.target === "clerk_a"
      )
    ).toBe(true)
    const roleAudit = auditJson.items.find(
      (row) => row.action === "tenant_update_role" && row.target === "clerk_a"
    )
    expect(roleAudit?.authBoundary).toBe("external_session_hint")
    expect(roleAudit?.sessionReferenceId).toBe(sessionJson.sessionReference.id)
    expect(roleAudit?.externalSessionId).toBe("ext-audit-actor")

    const refsRes = await get(
      new URLSearchParams({
        view: "session_refs",
        actorId: "partner_a",
        firmId: "firmA",
        userId: "partner_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(refsRes.status).toBe(200)
    const refsJson = (await refsRes.json()) as {
      items: Array<{ id: string; userId: string; authBoundary: string }>
    }
    expect(
      refsJson.items.some(
        (row) => row.id === sessionJson.sessionReference.id && row.userId === "partner_a"
      )
    ).toBe(true)

    const deniedAudit = await get(
      new URLSearchParams({
        view: "audit",
        actorId: "associate_a",
        firmId: "firmA",
        limit: "10",
        cursor: "0",
      })
    )
    expect(deniedAudit.status).toBe(400)
  })

  it("revokes session references and blocks stale replay after privilege drift", async () => {
    const clerkSession = await get(
      new URLSearchParams({
        view: "session",
        userId: "clerk_a",
        firmId: "firmA",
        authBoundary: "external_session_hint",
        externalSessionId: "ext-clerk-session",
      })
    )
    expect(clerkSession.status).toBe(200)
    const clerkSessionJson = (await clerkSession.json()) as {
      sessionReference: { id: string }
    }

    const actorSession = await get(
      new URLSearchParams({
        view: "session",
        userId: "partner_a",
        firmId: "firmA",
      })
    )
    expect(actorSession.status).toBe(200)
    const actorSessionJson = (await actorSession.json()) as {
      sessionReference: { id: string }
    }

    const driftUpdate = await post(
      {
        action: "update_role",
        actorId: "partner_a",
        firmId: "firmA",
        targetUserId: "clerk_a",
        nextRole: "clerk",
        nextClearance: "internal",
        reason: "Privilege drift invalidation check",
        sessionReferenceId: actorSessionJson.sessionReference.id,
      },
      "556fcac3-ebf8-4474-92a9-583003648f18"
    )
    expect(driftUpdate.status).toBe(200)
    const driftJson = (await driftUpdate.json()) as {
      result: {
        privilegedBoundaryDriftCount: number
        privilegedBoundaryDriftSessionReferenceIds: string[]
      }
    }
    expect(driftJson.result.privilegedBoundaryDriftCount).toBeGreaterThanOrEqual(1)
    expect(driftJson.result.privilegedBoundaryDriftSessionReferenceIds).toContain(
      clerkSessionJson.sessionReference.id
    )

    const staleReplay = await get(
      new URLSearchParams({
        view: "session",
        sessionRefId: clerkSessionJson.sessionReference.id,
      })
    )
    expect(staleReplay.status).toBe(410)
    const staleReplayJson = (await staleReplay.json()) as { error: string }
    expect(staleReplayJson.error).toContain("revoked")

    const associateSession = await get(
      new URLSearchParams({
        view: "session",
        userId: "associate_a",
        firmId: "firmA",
      })
    )
    expect(associateSession.status).toBe(200)
    const associateSessionJson = (await associateSession.json()) as {
      sessionReference: { id: string }
    }

    const revokePayload = {
      action: "revoke_session_reference",
      actorId: "partner_a",
      firmId: "firmA",
      sessionReferenceId: associateSessionJson.sessionReference.id,
      reason: "Manual revocation check",
    }
    const revokeFirst = await post(revokePayload, "180cc68b-bf6a-41ec-aef5-e9a3d5239651")
    const revokeReplay = await post(revokePayload, "180cc68b-bf6a-41ec-aef5-e9a3d5239651")
    expect(revokeFirst.status).toBe(200)
    expect(revokeReplay.status).toBe(200)
    const revokeFirstJson = (await revokeFirst.json()) as { reused: boolean }
    const revokeReplayJson = (await revokeReplay.json()) as { reused: boolean }
    expect(revokeFirstJson.reused).toBe(false)
    expect(revokeReplayJson.reused).toBe(true)

    const revokeCrossFirm = await post(
      { ...revokePayload, firmId: "firmB" },
      "f9e349fc-65e2-4299-8f8e-ae8d9ca56046"
    )
    expect(revokeCrossFirm.status).toBe(400)

    const revokedReplay = await get(
      new URLSearchParams({
        view: "session",
        sessionRefId: associateSessionJson.sessionReference.id,
      })
    )
    expect(revokedReplay.status).toBe(410)

    const auditRes = await get(
      new URLSearchParams({
        view: "audit",
        actorId: "partner_a",
        firmId: "firmA",
        limit: "25",
        cursor: "0",
      })
    )
    expect(auditRes.status).toBe(200)
    const auditJson = (await auditRes.json()) as {
      items: Array<{
        action: string
        target: string
        sessionReferenceId?: string | null
        privilegedBoundaryDriftCount?: number
        privilegedBoundaryDriftSessionReferenceIds?: string[]
      }>
    }
    const driftAudit = auditJson.items.find(
      (row) => row.action === "tenant_update_role" && row.target === "clerk_a"
    )
    expect(driftAudit?.privilegedBoundaryDriftCount).toBeGreaterThanOrEqual(1)
    expect(driftAudit?.privilegedBoundaryDriftSessionReferenceIds).toContain(
      clerkSessionJson.sessionReference.id
    )
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_revoke_session_reference" &&
          row.sessionReferenceId === associateSessionJson.sessionReference.id
      )
    ).toBe(true)
  })

  it("blocks role escalation and cross-firm role changes", async () => {
    const promotePartner = await post(
      {
        action: "update_role",
        actorId: "partner_a",
        firmId: "firmA",
        targetUserId: "associate_a",
        nextRole: "partner",
        nextClearance: "privileged",
      },
      "24bfadbe-492f-42d6-aef6-8e9f30a140e8"
    )
    expect(promotePartner.status).toBe(400)

    const crossFirm = await post(
      {
        action: "update_role",
        actorId: "partner_a",
        firmId: "firmA",
        targetUserId: "partner_b",
        nextRole: "associate",
        nextClearance: "internal",
      },
      "8f7d3cff-979a-4f4d-b24f-11c1069f4208"
    )
    expect(crossFirm.status).toBe(400)
  })

  it("supports idempotent role updates and writes audit entries", async () => {
    const sessionRes = await get(
      new URLSearchParams({
        view: "session",
        userId: "partner_a",
        firmId: "firmA",
      })
    )
    expect(sessionRes.status).toBe(200)
    const sessionJson = (await sessionRes.json()) as { sessionReference: { id: string } }
    const key = "fdf53787-4239-4cb4-ab6e-328eceb06484"
    const payload = {
      action: "update_role",
      actorId: "partner_a",
      firmId: "firmA",
      targetUserId: "clerk_a",
      nextRole: "clerk",
      nextClearance: "internal",
      reason: "Temporary reduced clearance",
      sessionReferenceId: sessionJson.sessionReference.id,
    }
    const first = await post(payload, key)
    const second = await post(payload, key)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { reused: boolean; result: { user: { id: string } } }
    const b = (await second.json()) as { reused: boolean; result: { user: { id: string } } }
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(true)
    expect(a.result.user.id).toBe("clerk_a")

    const conflict = await post({ ...payload, nextClearance: "confidential" }, key)
    expect(conflict.status).toBe(409)

    const audit = getRuntimeStore().audit
    expect(audit.some((row) => row.action === "tenant_update_role" && row.target === "clerk_a")).toBe(
      true
    )
  })
})
