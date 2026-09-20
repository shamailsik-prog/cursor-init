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

  it("supports admin-driven session revocation and denies stale replay", async () => {
    const sessionRes = await get(
      new URLSearchParams({
        view: "session",
        userId: "associate_a",
        firmId: "firmA",
      })
    )
    expect(sessionRes.status).toBe(200)
    const sessionJson = (await sessionRes.json()) as { sessionReference: { id: string } }

    const deniedNonPartner = await post(
      {
        action: "revoke_session_reference",
        actorId: "associate_a",
        firmId: "firmA",
        sessionReferenceId: sessionJson.sessionReference.id,
      },
      "5ef853aa-a2b8-4f15-9303-c87bfd0a13e6"
    )
    expect(deniedNonPartner.status).toBe(400)

    const revoked = await post(
      {
        action: "revoke_session_reference",
        actorId: "partner_a",
        firmId: "firmA",
        sessionReferenceId: sessionJson.sessionReference.id,
        reason: "manual security revoke",
      },
      "0a0ea66d-91b3-4742-a459-51fd13f4dad7"
    )
    expect(revoked.status).toBe(200)
    const revokedJson = (await revoked.json()) as {
      result: { sessionReference: { state: string; revocationReason: string | null } }
    }
    expect(revokedJson.result.sessionReference.state).toBe("revoked")
    expect(revokedJson.result.sessionReference.revocationReason).toBe("manual security revoke")

    const replayDenied = await get(
      new URLSearchParams({
        view: "session",
        sessionRefId: sessionJson.sessionReference.id,
      })
    )
    expect(replayDenied.status).toBe(400)
    const deniedJson = (await replayDenied.json()) as { error: string }
    expect(deniedJson.error).toContain("revoked session reference")
  })

  it("enforces session-reference expiry and marks rows durably", async () => {
    const sessionRes = await get(
      new URLSearchParams({
        view: "session",
        userId: "associate_a",
        firmId: "firmA",
      })
    )
    expect(sessionRes.status).toBe(200)
    const sessionJson = (await sessionRes.json()) as { sessionReference: { id: string } }
    const row = getRuntimeStore().tenancySessionReferences.get(sessionJson.sessionReference.id)
    expect(row).toBeDefined()
    if (!row) throw new Error("expected session reference")
    row.expiresAt = Date.now() - 1
    getRuntimeStore().tenancySessionReferences.set(row.id, row)

    const enforce = await post(
      {
        action: "enforce_session_expiry",
        actorId: "partner_a",
        firmId: "firmA",
      },
      "74a7af8d-c13f-4d76-b89f-5f0ce9f9e2b0"
    )
    expect(enforce.status).toBe(200)
    const enforceJson = (await enforce.json()) as {
      result: { revokedSessionReferenceIds: string[] }
    }
    expect(enforceJson.result.revokedSessionReferenceIds).toContain(sessionJson.sessionReference.id)

    const replayDenied = await get(
      new URLSearchParams({
        view: "session",
        sessionRefId: sessionJson.sessionReference.id,
      })
    )
    expect(replayDenied.status).toBe(400)
    const deniedJson = (await replayDenied.json()) as { error: string }
    expect(deniedJson.error).toContain("expired session reference")

    const refsRes = await get(
      new URLSearchParams({
        view: "session_refs",
        actorId: "partner_a",
        firmId: "firmA",
        userId: "associate_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(refsRes.status).toBe(200)
    const refsJson = (await refsRes.json()) as {
      items: Array<{ id: string; state: string; revocationReason: string | null }>
    }
    const expired = refsJson.items.find((item) => item.id === sessionJson.sessionReference.id)
    expect(expired?.state).toBe("expired")
    expect(expired?.revocationReason).toBe("expired_enforced")
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

  it("invalidates target-user session refs on privileged-boundary drift", async () => {
    const targetSession = await get(
      new URLSearchParams({
        view: "session",
        userId: "clerk_a",
        firmId: "firmA",
      })
    )
    expect(targetSession.status).toBe(200)
    const targetSessionJson = (await targetSession.json()) as { sessionReference: { id: string } }

    const actorSession = await get(
      new URLSearchParams({
        view: "session",
        userId: "partner_a",
        firmId: "firmA",
      })
    )
    expect(actorSession.status).toBe(200)
    const actorSessionJson = (await actorSession.json()) as { sessionReference: { id: string } }

    const roleUpdate = await post(
      {
        action: "update_role",
        actorId: "partner_a",
        firmId: "firmA",
        targetUserId: "clerk_a",
        nextRole: "clerk",
        nextClearance: "public",
        reason: "drift invalidation check",
        sessionReferenceId: actorSessionJson.sessionReference.id,
      },
      "ff3c87c3-c8bb-49f8-8db3-311dc6f1f442"
    )
    expect(roleUpdate.status).toBe(200)
    const updateJson = (await roleUpdate.json()) as {
      result: {
        driftInvalidations: Array<{ id: string; driftReason: string }>
      }
    }
    expect(
      updateJson.result.driftInvalidations.some(
        (item) => item.id === targetSessionJson.sessionReference.id
      )
    ).toBe(true)

    const replayDenied = await get(
      new URLSearchParams({
        view: "session",
        sessionRefId: targetSessionJson.sessionReference.id,
      })
    )
    expect(replayDenied.status).toBe(400)
    const deniedJson = (await replayDenied.json()) as { error: string }
    expect(deniedJson.error).toContain("privileged-boundary drift")

    const refs = await get(
      new URLSearchParams({
        view: "session_refs",
        actorId: "partner_a",
        firmId: "firmA",
        userId: "clerk_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(refs.status).toBe(200)
    const refsJson = (await refs.json()) as {
      items: Array<{
        id: string
        state: string
        driftReason: string | null
        driftToClearance: string | null
      }>
    }
    const drifted = refsJson.items.find((item) => item.id === targetSessionJson.sessionReference.id)
    expect(drifted?.state).toBe("drifted")
    expect(drifted?.driftReason).toBe("clearance_changed")
    expect(drifted?.driftToClearance).toBe("public")
  })

  it("acknowledges drift telemetry and exposes a drift report view", async () => {
    const targetSession = await get(
      new URLSearchParams({
        view: "session",
        userId: "associate_a",
        firmId: "firmA",
      })
    )
    expect(targetSession.status).toBe(200)
    const targetSessionJson = (await targetSession.json()) as { sessionReference: { id: string } }

    const actorSession = await get(
      new URLSearchParams({
        view: "session",
        userId: "partner_a",
        firmId: "firmA",
      })
    )
    expect(actorSession.status).toBe(200)
    const actorSessionJson = (await actorSession.json()) as { sessionReference: { id: string } }

    const roleUpdate = await post(
      {
        action: "update_role",
        actorId: "partner_a",
        firmId: "firmA",
        targetUserId: "associate_a",
        nextRole: "associate",
        nextClearance: "public",
        reason: "drift report check",
        sessionReferenceId: actorSessionJson.sessionReference.id,
      },
      "95d5c935-bfd8-49c9-b138-aa86a762f738"
    )
    expect(roleUpdate.status).toBe(200)

    const acknowledge = await post(
      {
        action: "acknowledge_session_drift",
        actorId: "partner_a",
        firmId: "firmA",
        sessionReferenceId: targetSessionJson.sessionReference.id,
        note: "reviewed and accepted",
      },
      "67095a4a-e596-4df4-9ce9-daf34064f1d8"
    )
    expect(acknowledge.status).toBe(200)
    const acknowledgeJson = (await acknowledge.json()) as {
      result: {
        sessionReference: {
          state: string
          driftAcknowledgedBy: string | null
          driftAcknowledgedNote: string | null
        }
      }
    }
    expect(acknowledgeJson.result.sessionReference.state).toBe("drifted")
    expect(acknowledgeJson.result.sessionReference.driftAcknowledgedBy).toBe("partner_a")
    expect(acknowledgeJson.result.sessionReference.driftAcknowledgedNote).toBe(
      "reviewed and accepted"
    )

    const report = await get(
      new URLSearchParams({
        view: "session_drift_report",
        actorId: "partner_a",
        firmId: "firmA",
        userId: "associate_a",
        limit: "10",
        cursor: "0",
      })
    )
    expect(report.status).toBe(200)
    const reportJson = (await report.json()) as {
      summary: { driftedTotal: number; acknowledged: number; unacknowledged: number }
      items: Array<{ id: string; driftAcknowledgedBy: string | null }>
    }
    expect(reportJson.summary.driftedTotal).toBeGreaterThan(0)
    expect(reportJson.summary.acknowledged).toBeGreaterThan(0)
    const acknowledgedRow = reportJson.items.find((item) => item.id === targetSessionJson.sessionReference.id)
    expect(acknowledgedRow?.driftAcknowledgedBy).toBe("partner_a")
  })
})
