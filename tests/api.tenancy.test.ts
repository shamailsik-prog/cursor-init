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
    // Foreign / cross-firm references answer like unknown ones (no existence oracle).
    expect(crossFirmRefDenied.status).toBe(404)
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

    const lineageAligned = await post(
      {
        action: "reissue_session_reference",
        actorId: "partner_a",
        firmId: "firmA",
        sessionReferenceId: actorSessionJson.sessionReference.id,
      },
      "45ad2f5e-bd4e-401f-9018-b99a46f41489"
    )
    expect(lineageAligned.status).toBe(200)
    const lineageAlignedJson = (await lineageAligned.json()) as {
      result: {
        sessionReference: {
          id: string
          lineageRootSessionReferenceId: string
          lineageDepth: number
          delegatedBoundaryReconciliationStatus: string
        }
      }
    }
    expect(lineageAlignedJson.result.sessionReference.lineageRootSessionReferenceId).toBe(
      actorSessionJson.sessionReference.id
    )
    expect(lineageAlignedJson.result.sessionReference.lineageDepth).toBe(1)
    expect(lineageAlignedJson.result.sessionReference.delegatedBoundaryReconciliationStatus).toBe(
      "aligned"
    )

    const lineageDiverged = await post(
      {
        action: "reissue_session_reference",
        actorId: "partner_a",
        firmId: "firmA",
        sessionReferenceId: lineageAlignedJson.result.sessionReference.id,
        authBoundary: "external_session_hint",
        externalSessionId: "ext-lineage-diverged",
      },
      "0569db7a-e67b-4649-8be5-a98d41baa611"
    )
    expect(lineageDiverged.status).toBe(200)
    const lineageDivergedJson = (await lineageDiverged.json()) as {
      result: {
        sessionReference: {
          id: string
          lineageDepth: number
          delegatedBoundaryReconciliationStatus: string
          delegatedBoundaryDivergenceReasons: string[]
        }
      }
    }
    expect(lineageDivergedJson.result.sessionReference.lineageDepth).toBe(2)
    expect(lineageDivergedJson.result.sessionReference.delegatedBoundaryReconciliationStatus).toBe(
      "diverged"
    )
    expect(lineageDivergedJson.result.sessionReference.delegatedBoundaryDivergenceReasons).toContain(
      "auth_boundary_changed"
    )

    const lineageViewFirst = await get(
      new URLSearchParams({
        view: "session_lineage",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        limit: "2",
        cursor: "0",
      })
    )
    expect(lineageViewFirst.status).toBe(200)
    const lineageFirstJson = (await lineageViewFirst.json()) as {
      items: Array<{ id: string; lineageDepth: number }>
      nextCursor: string | null
      total: number
    }
    expect(lineageFirstJson.total).toBeGreaterThanOrEqual(3)
    expect(lineageFirstJson.items.length).toBe(2)
    expect(lineageFirstJson.nextCursor).not.toBeNull()

    const lineageViewSecond = await get(
      new URLSearchParams({
        view: "session_lineage",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        limit: "2",
        cursor: lineageFirstJson.nextCursor ?? "0",
      })
    )
    expect(lineageViewSecond.status).toBe(200)
    const lineageSecondJson = (await lineageViewSecond.json()) as {
      items: Array<{
        id: string
        delegatedBoundaryReconciliationStatus: string
        delegatedBoundaryDivergenceReasons: string[]
      }>
    }
    expect(
      lineageSecondJson.items.some(
        (row) =>
          row.id === lineageDivergedJson.result.sessionReference.id &&
          row.delegatedBoundaryReconciliationStatus === "diverged"
      )
    ).toBe(true)

    const lineageDivergedOnly = await get(
      new URLSearchParams({
        view: "session_lineage",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        delegatedDivergedOnly: "true",
        limit: "10",
        cursor: "0",
      })
    )
    expect(lineageDivergedOnly.status).toBe(200)
    const divergedOnlyJson = (await lineageDivergedOnly.json()) as {
      items: Array<{ id: string }>
    }
    expect(divergedOnlyJson.items.some((row) => row.id === lineageDivergedJson.result.sessionReference.id)).toBe(true)

    const lineageCrossFirmDenied = await post(
      {
        action: "reissue_session_reference",
        actorId: "partner_a",
        firmId: "firmB",
        sessionReferenceId: actorSessionJson.sessionReference.id,
      },
      "d972db42-5a75-462f-a2b4-4e56f1f5e4da"
    )
    expect(lineageCrossFirmDenied.status).toBe(400)

    const attestIdentityBridgePayload = {
      action: "attest_external_session_identity_bridge",
      actorId: "partner_a",
      firmId: "firmA",
      sessionReferenceId: lineageDivergedJson.result.sessionReference.id,
      assertedIssuer: "idp.sandbox.local",
      assertedSubject: "partner_a:lineage-diverged",
      assertedExternalSessionId: "ext-lineage-diverged",
      note: "Initial bridge attestation for lineage divergence monitor",
    }
    const attestIdentityBridgeFirst = await post(
      attestIdentityBridgePayload,
      "3c6ac89d-5f85-4e57-8ab0-2ec1ce96f58d"
    )
    const attestIdentityBridgeReplay = await post(
      attestIdentityBridgePayload,
      "3c6ac89d-5f85-4e57-8ab0-2ec1ce96f58d"
    )
    expect(attestIdentityBridgeFirst.status).toBe(200)
    expect(attestIdentityBridgeReplay.status).toBe(200)
    const attestIdentityBridgeFirstJson = (await attestIdentityBridgeFirst.json()) as {
      reused: boolean
      result: { bridge: { status: string; mismatchStatus: string; assertedIssuer: string | null } }
    }
    const attestIdentityBridgeReplayJson = (await attestIdentityBridgeReplay.json()) as {
      reused: boolean
    }
    expect(attestIdentityBridgeFirstJson.reused).toBe(false)
    expect(attestIdentityBridgeReplayJson.reused).toBe(true)
    expect(attestIdentityBridgeFirstJson.result.bridge.status).toBe("attested")
    expect(attestIdentityBridgeFirstJson.result.bridge.mismatchStatus).toBe("aligned")
    expect(attestIdentityBridgeFirstJson.result.bridge.assertedIssuer).toBe("idp.sandbox.local")

    const attestIdentityBridgeMismatch = await post(
      {
        ...attestIdentityBridgePayload,
        assertedExternalSessionId: "ext-lineage-diverged-mismatch",
        note: "Trigger mismatch telemetry",
      },
      "5f87ae48-fd7d-47c2-bf44-b97e50db021f"
    )
    expect(attestIdentityBridgeMismatch.status).toBe(200)
    const attestIdentityBridgeMismatchJson = (await attestIdentityBridgeMismatch.json()) as {
      result: { bridge: { mismatchStatus: string; mismatchReasons: string[] } }
    }
    expect(attestIdentityBridgeMismatchJson.result.bridge.mismatchStatus).toBe("mismatch_detected")
    expect(attestIdentityBridgeMismatchJson.result.bridge.mismatchReasons).toContain(
      "asserted_external_session_id_mismatch"
    )

    const quarantineIdentityBridge = await post(
      {
        action: "quarantine_external_session_identity_bridge",
        actorId: "partner_a",
        firmId: "firmA",
        sessionReferenceId: lineageDivergedJson.result.sessionReference.id,
        quarantineReason: "issuer drift pending legal review",
        note: "Quarantine identity bridge for review",
      },
      "041c12b3-2115-4206-af10-943345f9ba7f"
    )
    expect(quarantineIdentityBridge.status).toBe(200)
    const quarantineIdentityBridgeJson = (await quarantineIdentityBridge.json()) as {
      result: { bridge: { status: string; mismatchStatus: string; quarantineReason: string | null } }
    }
    expect(quarantineIdentityBridgeJson.result.bridge.status).toBe("quarantined")
    expect(quarantineIdentityBridgeJson.result.bridge.mismatchStatus).toBe("mismatch_detected")
    expect(quarantineIdentityBridgeJson.result.bridge.quarantineReason).toBe(
      "issuer drift pending legal review"
    )

    const identityBridgeMismatchView = await get(
      new URLSearchParams({
        view: "session_external_session_identity_bridges",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "quarantined",
        mismatchStatus: "mismatch_detected",
        limit: "10",
        cursor: "0",
      })
    )
    expect(identityBridgeMismatchView.status).toBe(200)
    const identityBridgeMismatchViewJson = (await identityBridgeMismatchView.json()) as {
      items: Array<{ status: string; mismatchStatus: string; sessionReferenceId: string }>
    }
    expect(
      identityBridgeMismatchViewJson.items.some(
        (row) =>
          row.status === "quarantined" &&
          row.mismatchStatus === "mismatch_detected" &&
          row.sessionReferenceId === lineageDivergedJson.result.sessionReference.id
      )
    ).toBe(true)

    const clearIdentityBridge = await post(
      {
        action: "clear_external_session_identity_bridge",
        actorId: "partner_a",
        firmId: "firmA",
        sessionReferenceId: lineageDivergedJson.result.sessionReference.id,
        clearReason: "verified via partner reconciler override",
        note: "Clear quarantine after review",
      },
      "b1597460-8532-48dd-b232-5e2bafcf3f94"
    )
    expect(clearIdentityBridge.status).toBe(200)
    const clearIdentityBridgeJson = (await clearIdentityBridge.json()) as {
      result: { bridge: { status: string; mismatchStatus: string; clearReason: string | null } }
    }
    expect(clearIdentityBridgeJson.result.bridge.status).toBe("cleared")
    expect(clearIdentityBridgeJson.result.bridge.mismatchStatus).toBe("aligned")
    expect(clearIdentityBridgeJson.result.bridge.clearReason).toBe(
      "verified via partner reconciler override"
    )

    const identityBridgeClearedView = await get(
      new URLSearchParams({
        view: "session_external_session_identity_bridges",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "cleared",
        mismatchStatus: "aligned",
        limit: "10",
        cursor: "0",
      })
    )
    expect(identityBridgeClearedView.status).toBe(200)
    const identityBridgeClearedViewJson = (await identityBridgeClearedView.json()) as {
      items: Array<{ status: string; mismatchStatus: string }>
    }
    expect(
      identityBridgeClearedViewJson.items.some(
        (row) => row.status === "cleared" && row.mismatchStatus === "aligned"
      )
    ).toBe(true)

    const disputePayload = {
      action: "attest_session_lineage_dispute",
      actorId: "partner_a",
      firmId: "firmA",
      sessionReferenceId: lineageDivergedJson.result.sessionReference.id,
      reason: "Delegated boundary mismatch requires review",
      note: "Escalate for lineage attestation",
    }
    const disputeFirst = await post(disputePayload, "1f727de8-bf4f-4268-89fe-41363f5f8946")
    const disputeReplay = await post(disputePayload, "1f727de8-bf4f-4268-89fe-41363f5f8946")
    expect(disputeFirst.status).toBe(200)
    expect(disputeReplay.status).toBe(200)
    const disputeFirstJson = (await disputeFirst.json()) as {
      reused: boolean
      result: {
        dispute: { id: string; status: string; lineageRootSessionReferenceId: string }
        digest: {
          openDisputeCount: number
          status: string
          reasons: string[]
        }
      }
    }
    const disputeReplayJson = (await disputeReplay.json()) as { reused: boolean }
    expect(disputeFirstJson.reused).toBe(false)
    expect(disputeReplayJson.reused).toBe(true)
    expect(disputeFirstJson.result.dispute.status).toBe("open")
    expect(disputeFirstJson.result.digest.openDisputeCount).toBeGreaterThanOrEqual(1)
    expect(disputeFirstJson.result.digest.reasons).toContain("open_lineage_dispute")

    const openDisputesView = await get(
      new URLSearchParams({
        view: "session_lineage_disputes",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "open",
        limit: "10",
        cursor: "0",
      })
    )
    expect(openDisputesView.status).toBe(200)
    const openDisputesJson = (await openDisputesView.json()) as {
      items: Array<{ id: string; status: string }>
    }
    expect(
      openDisputesJson.items.some(
        (row) => row.id === disputeFirstJson.result.dispute.id && row.status === "open"
      )
    ).toBe(true)

    const queueViewQueued = await get(
      new URLSearchParams({
        view: "session_lineage_reconciliation_queue",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "queued",
        limit: "10",
        cursor: "0",
      })
    )
    expect(queueViewQueued.status).toBe(200)
    const queueQueuedJson = (await queueViewQueued.json()) as {
      items: Array<{ id: string; status: string }>
    }
    expect(
      queueQueuedJson.items.some(
        (row) =>
          row.id === `tenancy-lineage-arbitration:${actorSessionJson.sessionReference.id}` &&
          row.status === "queued"
      )
    ).toBe(true)

    const assignQueuePayload = {
      action: "assign_lineage_reconciliation_queue",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      assignedPartnerId: "partner_a",
      slaWindowMinutes: 90,
      note: "Assign reconciliation queue for attestation follow-up",
    }
    const assignQueue = await post(assignQueuePayload, "f45e6d8f-b8ab-4ab3-a1f5-0ef4e097fb55")
    expect(assignQueue.status).toBe(200)
    const assignQueueJson = (await assignQueue.json()) as {
      result: { queue: { status: string; assignedPartnerId: string | null } }
    }
    expect(assignQueueJson.result.queue.status).toBe("assigned")
    expect(assignQueueJson.result.queue.assignedPartnerId).toBe("partner_a")

    const queueViewAssigned = await get(
      new URLSearchParams({
        view: "session_lineage_reconciliation_queue",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "assigned",
        limit: "10",
        cursor: "0",
      })
    )
    expect(queueViewAssigned.status).toBe(200)
    const queueAssignedJson = (await queueViewAssigned.json()) as {
      items: Array<{ status: string; assignedPartnerId: string | null }>
    }
    expect(
      queueAssignedJson.items.some(
        (row) => row.status === "assigned" && row.assignedPartnerId === "partner_a"
      )
    ).toBe(true)

    const arbitrateQueuePayload = {
      action: "arbitrate_lineage_reconciliation_queue",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      disposition: "confirm_needs_review",
      note: "Arbitration confirms review pressure",
    }
    const arbitrateQueue = await post(arbitrateQueuePayload, "f4d508f6-1fdf-4cd0-8f35-fd8e89e81175")
    expect(arbitrateQueue.status).toBe(200)
    const arbitrateQueueJson = (await arbitrateQueue.json()) as {
      result: { queue: { status: string; disposition: string | null } }
    }
    expect(arbitrateQueueJson.result.queue.status).toBe("arbitrated")
    expect(arbitrateQueueJson.result.queue.disposition).toBe("confirm_needs_review")

    const queueViewArbitrated = await get(
      new URLSearchParams({
        view: "session_lineage_reconciliation_queue",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "arbitrated",
        limit: "10",
        cursor: "0",
      })
    )
    expect(queueViewArbitrated.status).toBe(200)

    const closureAttestPayload = {
      action: "attest_lineage_digest_closure",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      closureReason: "Digest reconciled for closure attestation",
      note: "Checkpoint closure before reopen simulation",
    }
    const closureAttestFirst = await post(
      closureAttestPayload,
      "b9f0f0a0-70cd-4e38-bc1a-766b2e326f10"
    )
    const closureAttestReplay = await post(
      closureAttestPayload,
      "b9f0f0a0-70cd-4e38-bc1a-766b2e326f10"
    )
    expect(closureAttestFirst.status).toBe(200)
    expect(closureAttestReplay.status).toBe(200)
    const closureAttestFirstJson = (await closureAttestFirst.json()) as {
      reused: boolean
      result: { checkpoint: { status: string; attestedBy: string | null } }
    }
    const closureAttestReplayJson = (await closureAttestReplay.json()) as { reused: boolean }
    expect(closureAttestFirstJson.reused).toBe(false)
    expect(closureAttestReplayJson.reused).toBe(true)
    expect(closureAttestFirstJson.result.checkpoint.status).toBe("closed_attested")
    expect(closureAttestFirstJson.result.checkpoint.attestedBy).toBe("partner_a")

    const closureViewClosed = await get(
      new URLSearchParams({
        view: "session_lineage_digest_closure_checkpoints",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "closed_attested",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureViewClosed.status).toBe(200)

    const reopenClosurePayload = {
      action: "reopen_lineage_digest_closure",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      reopenTrigger: "new divergence signal after closure",
      note: "Reopen checkpoint for parity validation",
    }
    const reopenClosure = await post(reopenClosurePayload, "f6e10c06-94a6-4d66-9f5c-d20f7b6f1476")
    expect(reopenClosure.status).toBe(200)
    const reopenClosureJson = (await reopenClosure.json()) as {
      result: { checkpoint: { status: string; reopenTrigger: string | null } }
    }
    expect(reopenClosureJson.result.checkpoint.status).toBe("reopened")
    expect(reopenClosureJson.result.checkpoint.reopenTrigger).toBe(
      "new divergence signal after closure"
    )

    const closureViewReopened = await get(
      new URLSearchParams({
        view: "session_lineage_digest_closure_checkpoints",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "reopened",
        limit: "10",
        cursor: "0",
      })
    )
    expect(closureViewReopened.status).toBe(200)
    const closureReopenedJson = (await closureViewReopened.json()) as {
      items: Array<{ status: string; reopenTrigger: string | null }>
    }
    expect(
      closureReopenedJson.items.some(
        (row) =>
          row.status === "reopened" && row.reopenTrigger === "new divergence signal after closure"
      )
    ).toBe(true)

    const governAdjudicationPayload = {
      action: "govern_lineage_closure_adjudication",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      panelPartnerIds: ["partner_a"],
      requiredPanelQuorum: 1,
      verdictWindowMinutes: 60,
      note: "Govern reopened closure adjudication panel window",
    }
    const governAdjudication = await post(
      governAdjudicationPayload,
      "08795ae0-2bcf-42c4-a500-64af9d7960f8"
    )
    expect(governAdjudication.status).toBe(200)
    const governAdjudicationJson = (await governAdjudication.json()) as {
      result: {
        adjudication: { status: string; requiredPanelQuorum: number; confirmedPanelPartnerIds: string[] }
      }
    }
    expect(governAdjudicationJson.result.adjudication.status).toBe("verdict_window_open")
    expect(governAdjudicationJson.result.adjudication.requiredPanelQuorum).toBe(1)
    expect(governAdjudicationJson.result.adjudication.confirmedPanelPartnerIds).toContain("partner_a")

    const adjudicationViewOpen = await get(
      new URLSearchParams({
        view: "session_lineage_closure_adjudications",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "verdict_window_open",
        limit: "10",
        cursor: "0",
      })
    )
    expect(adjudicationViewOpen.status).toBe(200)

    const recordAdjudicationVerdictPayload = {
      action: "record_lineage_closure_adjudication_verdict",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      disposition: "mark_reconciled",
      dispositionDriftReasons: ["panel_alignment_confirmed"],
      note: "Record closure adjudication verdict for reopened checkpoint",
    }
    const recordAdjudicationVerdict = await post(
      recordAdjudicationVerdictPayload,
      "50ea611c-74e5-4379-b8f0-fca38755daf5"
    )
    expect(recordAdjudicationVerdict.status).toBe(200)
    const recordAdjudicationVerdictJson = (await recordAdjudicationVerdict.json()) as {
      result: { adjudication: { status: string; verdictDisposition: string | null } }
    }
    expect(recordAdjudicationVerdictJson.result.adjudication.status).toBe("verdict_recorded")
    expect(recordAdjudicationVerdictJson.result.adjudication.verdictDisposition).toBe("mark_reconciled")

    const debtLedgerViewOpen = await get(
      new URLSearchParams({
        view: "session_lineage_arbitration_debt_retirement_ledgers",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "pressure_open",
        limit: "10",
        cursor: "0",
      })
    )
    expect(debtLedgerViewOpen.status).toBe(200)

    const attestDebtRetirementPayload = {
      action: "attest_lineage_arbitration_debt_retirement",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      retirementNote: "Queue pressure retired after adjudication verdict",
      note: "Ledger attestation",
    }
    const attestDebtRetirementFirst = await post(
      attestDebtRetirementPayload,
      "729970ff-f5a1-48b0-b00e-248e2f37b53f"
    )
    const attestDebtRetirementReplay = await post(
      attestDebtRetirementPayload,
      "729970ff-f5a1-48b0-b00e-248e2f37b53f"
    )
    expect(attestDebtRetirementFirst.status).toBe(200)
    expect(attestDebtRetirementReplay.status).toBe(200)
    const attestDebtRetirementFirstJson = (await attestDebtRetirementFirst.json()) as {
      reused: boolean
      result: { debtLedger: { status: string; retirementAttestedBy: string | null } }
    }
    const attestDebtRetirementReplayJson = (await attestDebtRetirementReplay.json()) as {
      reused: boolean
    }
    expect(attestDebtRetirementFirstJson.reused).toBe(false)
    expect(attestDebtRetirementReplayJson.reused).toBe(true)
    expect(attestDebtRetirementFirstJson.result.debtLedger.status).toBe("retirement_attested")
    expect(attestDebtRetirementFirstJson.result.debtLedger.retirementAttestedBy).toBe("partner_a")

    const reopenDebtRetirementPayload = {
      action: "reopen_lineage_arbitration_debt_retirement",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      carryoverSignal: "reopened closure checkpoint demands carryover review",
      note: "Carryover reopened after attestation",
    }
    const reopenDebtRetirement = await post(
      reopenDebtRetirementPayload,
      "9566e80f-10b9-4fdd-8a3c-f5bcbe212e90"
    )
    expect(reopenDebtRetirement.status).toBe(200)
    const reopenDebtRetirementJson = (await reopenDebtRetirement.json()) as {
      result: { debtLedger: { status: string; carryoverSignals: string[] } }
    }
    expect(reopenDebtRetirementJson.result.debtLedger.status).toBe("carryover_reopened")
    expect(reopenDebtRetirementJson.result.debtLedger.carryoverSignals).toContain(
      "reopened closure checkpoint demands carryover review"
    )

    const debtLedgerViewCarryover = await get(
      new URLSearchParams({
        view: "session_lineage_arbitration_debt_retirement_ledgers",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "carryover_reopened",
        limit: "10",
        cursor: "0",
      })
    )
    expect(debtLedgerViewCarryover.status).toBe(200)
    const debtLedgerCarryoverJson = (await debtLedgerViewCarryover.json()) as {
      items: Array<{ status: string; carryoverSignals: string[] }>
    }
    expect(
      debtLedgerCarryoverJson.items.some(
        (row) =>
          row.status === "carryover_reopened" &&
          row.carryoverSignals.includes("reopened closure checkpoint demands carryover review")
      )
    ).toBe(true)

    const checkpointSettlementPublicationPayload = {
      action: "checkpoint_lineage_closure_adjudication_settlement_publication",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      publicationChannel: "partner_workboard",
      note: "Publication checkpoint registered",
    }
    const checkpointSettlementPublication = await post(
      checkpointSettlementPublicationPayload,
      "2181cb7f-29e9-4df0-bf09-e6d8c32cdd07"
    )
    expect(checkpointSettlementPublication.status).toBe(200)
    const checkpointSettlementPublicationJson = (await checkpointSettlementPublication.json()) as {
      result: { settlement: { status: string; verdictPublicationChannel: string | null } }
    }
    expect(checkpointSettlementPublicationJson.result.settlement.status).toBe(
      "publication_checkpointed"
    )
    expect(checkpointSettlementPublicationJson.result.settlement.verdictPublicationChannel).toBe(
      "partner_workboard"
    )

    const settlementCorrectionPayload = {
      action: "log_lineage_closure_adjudication_settlement_correction",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      correctionNote: "Corrected recipient roster before release",
      note: "Settlement correction trace",
    }
    const settlementCorrection = await post(
      settlementCorrectionPayload,
      "196fbf1f-d811-40a6-aa95-bf132f197670"
    )
    expect(settlementCorrection.status).toBe(200)
    const settlementCorrectionJson = (await settlementCorrection.json()) as {
      result: { settlement: { status: string; publicationCorrectionNote: string | null } }
    }
    expect(settlementCorrectionJson.result.settlement.status).toBe("correction_logged")
    expect(settlementCorrectionJson.result.settlement.publicationCorrectionNote).toBe(
      "Corrected recipient roster before release"
    )

    const settlementConfirmPayload = {
      action: "confirm_lineage_closure_adjudication_settlement_sla",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      note: "Settlement confirmation acknowledged",
    }
    const settlementConfirm = await post(
      settlementConfirmPayload,
      "8b3ce8d7-8843-491e-88cb-72e456108841"
    )
    expect(settlementConfirm.status).toBe(200)
    const settlementConfirmJson = (await settlementConfirm.json()) as {
      result: { settlement: { status: string; settlementConfirmedBy: string | null } }
    }
    expect(settlementConfirmJson.result.settlement.status).toBe("sla_confirmed")
    expect(settlementConfirmJson.result.settlement.settlementConfirmedBy).toBe("partner_a")

    const openDebtDisputePayload = {
      action: "open_lineage_arbitration_debt_retirement_dispute",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      challengeReason: "Retirement evidence packet incomplete",
      note: "Open dispute for debt retirement challenge",
    }
    const openDebtDispute = await post(
      openDebtDisputePayload,
      "7f858cc9-6ea4-45b9-a376-dd2915541e2b"
    )
    expect(openDebtDispute.status).toBe(200)
    const openDebtDisputeJson = (await openDebtDispute.json()) as {
      result: { disputeLedger: { status: string; challengeReason: string } }
    }
    expect(openDebtDisputeJson.result.disputeLedger.status).toBe("open")
    expect(openDebtDisputeJson.result.disputeLedger.challengeReason).toBe(
      "Retirement evidence packet incomplete"
    )

    const assignDebtDisputeReviewerPayload = {
      action: "assign_lineage_arbitration_debt_retirement_dispute_reviewer",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      reviewerId: "partner_a",
      note: "Assign reviewer for debt retirement dispute",
    }
    const assignDebtDisputeReviewer = await post(
      assignDebtDisputeReviewerPayload,
      "b300f1d7-57f3-4ffd-82a6-56de3567de99"
    )
    expect(assignDebtDisputeReviewer.status).toBe(200)
    const assignDebtDisputeReviewerJson = (await assignDebtDisputeReviewer.json()) as {
      result: { disputeLedger: { status: string; reviewerId: string | null } }
    }
    expect(assignDebtDisputeReviewerJson.result.disputeLedger.status).toBe("reviewer_assigned")
    expect(assignDebtDisputeReviewerJson.result.disputeLedger.reviewerId).toBe("partner_a")

    const resolveDebtDisputePayload = {
      action: "resolve_lineage_arbitration_debt_retirement_dispute",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      resolutionOutcome: "require_rollback_review",
      resolutionNote: "Challenge accepted pending rollback review",
      note: "Resolve dispute with rollback requirement",
    }
    const resolveDebtDispute = await post(
      resolveDebtDisputePayload,
      "3d5224d2-7e6d-4ac9-b917-ef208d8d3709"
    )
    expect(resolveDebtDispute.status).toBe(200)
    const resolveDebtDisputeJson = (await resolveDebtDispute.json()) as {
      result: { disputeLedger: { status: string; resolutionOutcome: string | null } }
    }
    expect(resolveDebtDisputeJson.result.disputeLedger.status).toBe("resolved")
    expect(resolveDebtDisputeJson.result.disputeLedger.resolutionOutcome).toBe(
      "require_rollback_review"
    )

    const rollbackDebtDisputePayload = {
      action: "control_lineage_arbitration_debt_retirement_dispute_rollback",
      actorId: "partner_a",
      firmId: "firmA",
      lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
      rollbackControlNote: "Rollback gated pending secondary review",
      note: "Apply rollback control",
    }
    const rollbackDebtDispute = await post(
      rollbackDebtDisputePayload,
      "4f3f7ee4-3bf6-4551-8188-2602115de4de"
    )
    expect(rollbackDebtDispute.status).toBe(200)
    const rollbackDebtDisputeJson = (await rollbackDebtDispute.json()) as {
      result: { disputeLedger: { status: string; rollbackControlNote: string | null } }
    }
    expect(rollbackDebtDisputeJson.result.disputeLedger.status).toBe("rollback_controlled")
    expect(rollbackDebtDisputeJson.result.disputeLedger.rollbackControlNote).toBe(
      "Rollback gated pending secondary review"
    )

    const settlementView = await get(
      new URLSearchParams({
        view: "session_lineage_closure_adjudication_settlements",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "sla_confirmed",
        limit: "10",
        cursor: "0",
      })
    )
    expect(settlementView.status).toBe(200)
    const settlementViewJson = (await settlementView.json()) as {
      items: Array<{ status: string; settlementConfirmedBy: string | null }>
    }
    expect(
      settlementViewJson.items.some(
        (row) => row.status === "sla_confirmed" && row.settlementConfirmedBy === "partner_a"
      )
    ).toBe(true)

    const debtDisputeView = await get(
      new URLSearchParams({
        view: "session_lineage_arbitration_debt_retirement_dispute_ledgers",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "rollback_controlled",
        limit: "10",
        cursor: "0",
      })
    )
    expect(debtDisputeView.status).toBe(200)
    const debtDisputeViewJson = (await debtDisputeView.json()) as {
      items: Array<{ status: string; rollbackControlNote: string | null }>
    }
    expect(
      debtDisputeViewJson.items.some(
        (row) =>
          row.status === "rollback_controlled" &&
          row.rollbackControlNote === "Rollback gated pending secondary review"
      )
    ).toBe(true)

    const resolvePayload = {
      action: "resolve_session_lineage_dispute",
      actorId: "partner_a",
      firmId: "firmA",
      disputeId: disputeFirstJson.result.dispute.id,
      disposition: "mark_reconciled",
      resolutionNote: "Lineage divergence reconciled after review",
    }
    const resolveRes = await post(resolvePayload, "31d2a9f6-74f4-4ac8-9347-0bc79710fece")
    expect(resolveRes.status).toBe(200)
    const resolveJson = (await resolveRes.json()) as {
      result: {
        dispute: { status: string; disposition: string }
        relatedSessionReference: {
          delegatedBoundaryReconciliationStatus: string
          delegatedBoundaryDivergenceReasons: string[]
        } | null
        digest: { openDisputeCount: number }
      }
    }
    expect(resolveJson.result.dispute.status).toBe("resolved")
    expect(resolveJson.result.dispute.disposition).toBe("mark_reconciled")
    expect(resolveJson.result.relatedSessionReference?.delegatedBoundaryReconciliationStatus).toBe(
      "aligned"
    )
    expect(resolveJson.result.relatedSessionReference?.delegatedBoundaryDivergenceReasons).toEqual([])
    expect(resolveJson.result.digest.openDisputeCount).toBe(0)

    const digestView = await get(
      new URLSearchParams({
        view: "session_lineage_reconciliation_digests",
        actorId: "partner_a",
        firmId: "firmA",
        limit: "10",
        cursor: "0",
      })
    )
    expect(digestView.status).toBe(200)
    const digestJson = (await digestView.json()) as {
      items: Array<{ lineageRootSessionReferenceId: string; status: string }>
    }
    const rootDigest = digestJson.items.find(
      (row) => row.lineageRootSessionReferenceId === actorSessionJson.sessionReference.id
    )
    expect(rootDigest).toBeDefined()
    expect(rootDigest?.status).toBe("aligned")

    const resolvedDisputesView = await get(
      new URLSearchParams({
        view: "session_lineage_disputes",
        actorId: "partner_a",
        firmId: "firmA",
        rootSessionRefId: actorSessionJson.sessionReference.id,
        status: "resolved",
        limit: "10",
        cursor: "0",
      })
    )
    expect(resolvedDisputesView.status).toBe(200)
    const resolvedDisputesJson = (await resolvedDisputesView.json()) as {
      items: Array<{ id: string; disposition: string }>
    }
    expect(
      resolvedDisputesJson.items.some(
        (row) => row.id === disputeFirstJson.result.dispute.id && row.disposition === "mark_reconciled"
      )
    ).toBe(true)

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
        limit: "50",
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
        delegatedBoundaryLineageRootSessionReferenceId?: string | null
        delegatedBoundaryComparedSessionReferenceId?: string | null
        delegatedBoundaryReconciliationStatus?: string
        delegatedBoundaryDivergenceReasons?: string[]
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
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_reissue_session_reference" &&
          row.sessionReferenceId === lineageDivergedJson.result.sessionReference.id &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id &&
          row.delegatedBoundaryComparedSessionReferenceId ===
            lineageAlignedJson.result.sessionReference.id &&
          row.delegatedBoundaryReconciliationStatus === "diverged" &&
          (row.delegatedBoundaryDivergenceReasons ?? []).includes("auth_boundary_changed")
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_attest_lineage_dispute" &&
          row.sessionReferenceId === lineageDivergedJson.result.sessionReference.id &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_resolve_lineage_dispute" &&
          row.sessionReferenceId === lineageDivergedJson.result.sessionReference.id &&
          row.delegatedBoundaryReconciliationStatus === "aligned"
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_assign_lineage_reconciliation_queue" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_arbitrate_lineage_reconciliation_queue" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_attest_lineage_digest_closure" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_reopen_lineage_digest_closure" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_govern_lineage_closure_adjudication" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_record_lineage_closure_adjudication_verdict" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_attest_lineage_arbitration_debt_retirement" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_reopen_lineage_arbitration_debt_retirement" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action ===
            "tenant_checkpoint_lineage_closure_adjudication_settlement_publication" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_log_lineage_closure_adjudication_settlement_correction" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_confirm_lineage_closure_adjudication_settlement_sla" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_open_lineage_arbitration_debt_retirement_dispute" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action ===
            "tenant_assign_lineage_arbitration_debt_retirement_dispute_reviewer" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_resolve_lineage_arbitration_debt_retirement_dispute" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_control_lineage_arbitration_debt_retirement_dispute_rollback" &&
          row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_attest_external_session_identity_bridge" &&
          row.sessionReferenceId === lineageDivergedJson.result.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_quarantine_external_session_identity_bridge" &&
          row.sessionReferenceId === lineageDivergedJson.result.sessionReference.id
      )
    ).toBe(true)
    expect(
      auditJson.items.some(
        (row) =>
          row.action === "tenant_clear_external_session_identity_bridge" &&
          row.sessionReferenceId === lineageDivergedJson.result.sessionReference.id
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

  describe("cross-firm lineage root (G-2)", () => {
    /** Firm A's lineage: partner_a's session, a diverged reissue, an open dispute (so digest and monitoring rows exist). */
    async function firmALineage(): Promise<string> {
      const session = await get(new URLSearchParams({ view: "session", userId: "partner_a", firmId: "firmA" }))
      const root = ((await session.json()) as { sessionReference: { id: string } }).sessionReference.id
      const reissued = await post(
        {
          action: "reissue_session_reference",
          actorId: "partner_a",
          firmId: "firmA",
          sessionReferenceId: root,
          authBoundary: "external_session_hint",
          externalSessionId: "ext-firm-a-g2",
        },
        crypto.randomUUID()
      )
      const child = ((await reissued.json()) as { result: { sessionReference: { id: string } } }).result.sessionReference.id
      const dispute = await post(
        { action: "attest_session_lineage_dispute", actorId: "partner_a", firmId: "firmA", sessionReferenceId: child, reason: "g2" },
        crypto.randomUUID()
      )
      expect(dispute.status).toBe(200)
      return root
    }

    /** Every firm-A row keyed by the lineage root, as (id, firmId). */
    function rootRows(root: string) {
      const store = getRuntimeStore()
      return [
        store.tenancyLineageReconciliationDigests,
        store.tenancyLineageReconciliationQueueArbitrations,
        store.tenancyLineageDigestClosureCheckpoints,
        store.tenancyLineageClosureAdjudications,
        store.tenancyLineageArbitrationDebtRetirementLedgers,
        store.tenancyLineageClosureAdjudicationSettlements,
        store.tenancyLineageArbitrationDebtRetirementDisputeLedgers,
      ].flatMap((rows) =>
        [...rows.values()]
          .filter((row) => row.lineageRootSessionReferenceId === root)
          .map((row) => JSON.stringify(row))
      )
    }

    it.each([
      ["assign_lineage_reconciliation_queue", { assignedPartnerId: "partner_b", slaWindowMinutes: 90 }],
      ["arbitrate_lineage_reconciliation_queue", { disposition: "confirm_needs_review" }],
      ["attest_lineage_digest_closure", { closureReason: "x" }],
      ["reopen_lineage_digest_closure", { reopenTrigger: "x" }],
      ["govern_lineage_closure_adjudication", { panelPartnerIds: ["partner_b"], requiredPanelQuorum: 1, verdictWindowMinutes: 60 }],
      ["record_lineage_closure_adjudication_verdict", { disposition: "mark_reconciled", dispositionDriftReasons: ["x"] }],
      ["attest_lineage_arbitration_debt_retirement", { retirementNote: "x" }],
      ["reopen_lineage_arbitration_debt_retirement", { carryoverSignal: "x" }],
      ["checkpoint_lineage_closure_adjudication_settlement_publication", { publicationChannel: "partner_workboard" }],
      ["log_lineage_closure_adjudication_settlement_correction", { correctionNote: "x" }],
      ["confirm_lineage_closure_adjudication_settlement_sla", {}],
      ["open_lineage_arbitration_debt_retirement_dispute", { challengeReason: "x" }],
      ["assign_lineage_arbitration_debt_retirement_dispute_reviewer", { reviewerId: "partner_b" }],
      ["resolve_lineage_arbitration_debt_retirement_dispute", { resolutionOutcome: "uphold_retirement" }],
      ["control_lineage_arbitration_debt_retirement_dispute_rollback", { rollbackControlNote: "x" }],
    ])("%s on another firm's lineage root: refused as unknown, firm A's rows untouched and not returned", async (action, extra) => {
      const root = await firmALineage()
      const before = rootRows(root)
      expect(before.length).toBeGreaterThan(0)
      const res = await post(
        { action, actorId: "partner_b", firmId: "firmB", lineageRootSessionReferenceId: root, ...extra },
        crypto.randomUUID()
      )
      const text = await res.text()
      expect(res.status).toBe(400)
      expect(text).toMatch(/unknown lineage root/)
      expect(text).not.toContain("firmA")
      expect(rootRows(root)).toEqual(before)
    })
  })
})
