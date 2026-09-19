import { describe, expect, it, vi } from "vitest"

const baseStore = {
  users: new Map([
    [
      "associate_a",
      {
        id: "associate_a",
        firmId: "firmA",
        role: "associate",
        clearanceLevel: "privileged",
      },
    ],
  ]),
  matters: new Map([
    [
      "mat_1",
      {
        id: "mat_1",
        firmId: "firmA",
        clientId: "client_a",
        title: "Matter",
        courtId: "SHC",
        caseNumber: null,
        caseNumberStatus: "pending",
        status: "engagement_unconfirmed",
        classification: "internal",
      },
    ],
  ]),
  entities: new Map(),
  links: [],
  members: new Map([["mat_1_associate_a", { matterId: "mat_1", userId: "associate_a", firmId: "firmA" }]]),
  jobs: [],
  documents: new Map(),
  filingPackages: new Map(),
  filingPacketArtifacts: new Map(),
  filingDispatchQueue: new Map(),
  filingAnnexures: new Map(),
  filingSubmissionReceipts: new Map(),
  filingSubmissionReconciliation: new Map(),
  filingSubmissionExceptions: new Map(),
  matterClientSearchIndex: new Map(),
  draftTemplateAnalytics: new Map(),
  workflowOpsActivity: new Map(),
  memberKey(matterId: string, userId: string) {
    return `${matterId}_${userId}`
  },
}

vi.mock("@/platform/spine/runtimeStore", () => ({
  getRuntimeStore: () => baseStore,
}))

vi.mock("@/platform/persistence/runtimeRepositories", () => ({
  getRuntimeRepositories: vi.fn(async () => ({
    matters: {
      listByFirm: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
    },
    users: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    entities: {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "ent_repo",
          firmId: "firmA",
          canonicalName: "Repo Entity",
          cnic: "4220112345678",
          phone: "+923001112233",
          classification: "internal",
        },
      ]),
    },
    entityLinks: {
      upsert: vi.fn(),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    members: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        { matterId: "mat_1", userId: "associate_a", firmId: "firmA" },
      ]),
      listByMatter: vi.fn().mockResolvedValue([
        { matterId: "mat_1", userId: "associate_a", firmId: "firmA" },
      ]),
    },
    documents: {
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "doc_repo",
          firmId: "firmA",
          matterId: "mat_1",
          contentHash: "repo-hash",
          sourceChannel: "web",
          classification: "internal",
        },
      ]),
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
    },
    drafts: {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    workflow: {
      createOrUpdate: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    filings: {
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "pkg_repo",
          firmId: "firmA",
          matterId: "mat_1",
          draftId: "drf_1",
          classification: "internal",
          citationStatus: "OK",
          temporalAllOk: true,
          status: "pending_partner_approval",
          createdBy: "associate_a",
          createdAt: 1,
          approvedBy: null,
          approvalReason: null,
        },
      ]),
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
    },
    filingPacketArtifacts: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "packet:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          draftId: "drf_1",
          classification: "internal",
          readiness: "blocked",
          blockedReasons: ["partner_approval_pending"],
          components: [
            {
              componentId: "draft_body",
              label: "Draft body",
              required: true,
              status: "ready",
              sourceRef: "drf_1",
            },
          ],
          updatedAt: 1,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingDispatchQueue: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "dispatch:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "queued",
          assigneeId: "clerk_a",
          retryCount: 0,
          lastAttemptAt: null,
          operatorNotes: ["queued for handoff"],
          externalDispatchState: "blocked_todo_firm",
          updatedAt: 2,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingAnnexures: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "annexure:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          generationStatus: "pending",
          manifest: [
            {
              artifactId: "annexure_draft_pdf",
              label: "Final draft PDF",
              required: true,
              status: "ready",
              sourceRef: "drf_1",
            },
          ],
          signerRequirements: {
            partnerSignoffBy: null,
            partnerSignoffAt: null,
            clerkVerificationBy: null,
            clerkVerificationAt: null,
          },
          operatorNotes: ["repo annexure row"],
          submissionTransportBoundary: "todo_firm_external_transport_blocked",
          updatedAt: 3,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingSubmissionReceipts: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "receipt:pkg_repo:1",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          attemptNo: 1,
          courtChannel: "efiling_portal_stub",
          dispatchOutcome: "retry_scheduled",
          submissionReference: "ref-repo-1",
          failureReason: "gateway timeout",
          retryHint: "retry after review",
          recordedBy: "clerk_a",
          recordedAt: 4,
          submissionTransportBoundary: "todo_firm_external_transport_blocked",
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingSubmissionReconciliation: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "reconcile:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          totalAttempts: 1,
          latestReceiptId: "receipt:pkg_repo:1",
          latestSubmissionReference: "ref-repo-1",
          latestDispatchOutcome: "retry_scheduled",
          status: "open",
          notes: ["repo reconciliation row"],
          updatedAt: 5,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingSubmissionExceptions: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "exception:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "open",
          severity: "high",
          source: "reconciliation_needs_retry",
          latestReceiptId: "receipt:pkg_repo:1",
          latestReconciliationId: "reconcile:pkg_repo",
          escalationOwnerId: "partner_a",
          firstRaisedAt: 6,
          lastRaisedAt: 7,
          slaTargetAt: 8,
          claimedBy: null,
          claimedAt: null,
          escalatedBy: null,
          escalatedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: ["repo exception row"],
          updatedAt: 9,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    jobs: {
      create: vi.fn(),
      listByFirm: vi.fn().mockResolvedValue([]),
      listByDocument: vi.fn().mockResolvedValue([]),
    },
    workflowEvents: {
      append: vi.fn(),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    followUps: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    intimations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    audit: {
      append: vi.fn(),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    committeeOutputs: {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "cbo_repo",
          firmId: "firmA",
          actorId: "associate_a",
          classification: "internal",
          purpose: "committee-brain",
          blocked: true,
          reason: "phase0-no-credentials",
          outbound: {
            body: "[REDACTED]",
            metadata: {
              classification: "internal",
              provider: "ai-gateway",
              purpose: "committee-brain",
              redactionCounts: {},
            },
          },
          createdAt: 1,
        },
      ]),
    },
    reportingIndex: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "idx_repo",
          firmId: "firmA",
          rowType: "matter",
          referenceId: "mat_1",
          classification: "internal",
          label: "Repo Indexed Matter",
          detail: "SHC",
          linkedMatterId: "mat_1",
          linkedClientId: "client_a",
          status: "engagement_unconfirmed:pending",
          tags: ["repo", "indexed", "matter"],
          updatedAt: 1,
        },
      ]),
    },
    draftTemplateAnalytics: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "template:constitutional_petition_199",
          firmId: "firmA",
          templateId: "constitutional_petition_199",
          templateName: "Constitutional Petition (Art. 199)",
          templatePosture: "writ",
          templateCategory: "constitutional",
          composeCount: 2,
          templateSearchCount: 5,
          lastComposedAt: 10,
          lastTemplateSearchAt: 11,
          lastTemplateSearchQuery: "petition",
          updatedAt: 12,
        },
      ]),
    },
    workflowOpsActivity: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "ops_repo",
          firmId: "firmA",
          source: "workflow_event",
          action: "workflow_transition",
          actorId: "associate_a",
          classification: "internal",
          matterId: "mat_1",
          documentId: "doc_repo",
          followUpId: null,
          queueType: null,
          status: "processing",
          detail: "repo transition",
          tags: ["repo", "workflow"],
          createdAt: 3,
        },
      ]),
    },
  })),
}))

describe("Route wiring uses repository adapters", () => {
  it("documents route GET uses repository listByFirm", async () => {
    const { GET } = await import("@/app/api/d1/documents/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d1/documents?userId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("doc_repo")
  })

  it("filings route GET uses repository listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d4/filings?userId=associate_a&matterId=mat_1&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; packetArtifact: { packageId: string } | null }>
    }
    expect(json.items.map((item) => item.id)).toContain("pkg_repo")
    expect(json.items.some((item) => item.packetArtifact?.packageId === "pkg_repo")).toBe(true)
  })

  it("filings dispatch view GET uses repository dispatch queue listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=dispatch&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("dispatch:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings annexures view GET uses repository filingAnnexures listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=annexures&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("annexure:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings submission receipts view GET uses repository filingSubmissionReceipts listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=submission_receipts&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("receipt:pkg_repo:1")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings submission reconciliation view GET uses repository filingSubmissionReconciliation listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=submission_reconciliation&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("reconcile:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings submission exceptions view GET uses repository filingSubmissionExceptions listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=submission_exceptions&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("exception:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("clients route GET uses repository entities listByFirm", async () => {
    const { GET } = await import("@/app/api/d1/clients/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d1/clients?userId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("ent_repo")
  })

  it("committee route GET uses repository committeeOutputs listByFirm", async () => {
    const { GET } = await import("@/app/api/p1/committee-brain/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("cbo_repo")
  })

  it("reporting route GET uses repository reportingIndex listByFirm", async () => {
    const { GET } = await import("@/app/api/d1/reporting/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d1/reporting?actorId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("idx_repo")
  })

  it("draft templates route GET uses repository draftTemplateAnalytics listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/drafts/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/drafts?view=templates&actorId=associate_a&q=petition&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ analytics?: { templateSearchCount?: number } }>
    }
    expect(json.items.some((item) => (item.analytics?.templateSearchCount ?? 0) >= 5)).toBe(true)
  })

  it("ops reporting route GET uses repository workflowOpsActivity listByFirm", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d2/ops-reporting?actorId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("ops_repo")
  })
})
