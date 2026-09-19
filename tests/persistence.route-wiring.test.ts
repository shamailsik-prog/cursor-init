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
  members: new Map([["mat_1_associate_a", { matterId: "mat_1", userId: "associate_a", firmId: "firmA" }]]),
  jobs: [],
  documents: new Map(),
  filingPackages: new Map(),
  memberKey(matterId: string, userId: string) {
    return `${matterId}_${userId}`
  },
}

vi.mock("@/platform/spine/runtimeStore", () => ({
  getRuntimeStore: () => baseStore,
}))

vi.mock("@/platform/persistence/spineRepositories", () => ({
  createMemoryRepositories: () => ({
    matters: {
      listByFirm: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
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
  }),
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
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("pkg_repo")
  })
})
