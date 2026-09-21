import { afterEach, describe, expect, it } from "vitest"
import { GET as clientsGet, POST as clientsPost } from "@/app/api/d1/clients/route"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { GET as reportingGet, POST as reportingPost } from "@/app/api/d1/reporting/route"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

afterEach(() => {
  resetRuntimeStoreForTests()
})

function postClient(body: unknown, key: string) {
  return clientsPost(
    new Request("http://127.0.0.1/api/d1/clients", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

function postMatter(body: unknown, key: string) {
  return mattersPost(
    new Request("http://127.0.0.1/api/d1/matters", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

function getReport(params: URLSearchParams) {
  return reportingGet(new Request(`http://127.0.0.1/api/d1/reporting?${params.toString()}`))
}

function postReport(body: unknown, key: string) {
  return reportingPost(
    new Request("http://127.0.0.1/api/d1/reporting", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    })
  )
}

describe("GET /api/d1/reporting", () => {
  it("returns paginated matter/client rows with rowType and term filtering", async () => {
    await postClient(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "Ali Raza",
        cnic: "4220112345601",
        phone: "+923001112201",
        classification: "internal",
      },
      "f100fefe-a236-4a45-a584-612f6d8df786"
    )
    await postClient(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "Sara Khan",
        cnic: "4220112345602",
        phone: "+923001112202",
        classification: "internal",
      },
      "1135d66d-18cb-4726-b50f-8319b712901e"
    )
    await postMatter(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Ali Raza v. State",
        courtId: "SHC",
        classification: "internal",
      },
      "bb379fcb-cf09-4814-b626-09ca3044bf0e"
    )

    const search = await getReport(
      new URLSearchParams({
        actorId: "partner_a",
        rowType: "client",
        q: "ali",
        limit: "10",
        cursor: "0",
      })
    )
    expect(search.status).toBe(200)
    const searchJson = (await search.json()) as { items: Array<{ rowType: string; label: string }> }
    expect(searchJson.items).toHaveLength(1)
    expect(searchJson.items[0]?.rowType).toBe("client")
    expect(searchJson.items[0]?.label).toBe("Ali Raza")

    const paged = await getReport(
      new URLSearchParams({
        actorId: "partner_a",
        limit: "1",
        cursor: "0",
      })
    )
    expect(paged.status).toBe(200)
    const pagedJson = (await paged.json()) as {
      items: Array<{ id: string }>
      total: number
      nextCursor: string | null
    }
    expect(pagedJson.total).toBe(3)
    expect(pagedJson.items).toHaveLength(1)
    expect(pagedJson.nextCursor).toBe("1")
  })

  it("applies clearance filters for privileged rows", async () => {
    await postClient(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        canonicalName: "Privileged Client",
        cnic: "4220112345603",
        phone: "+923001112203",
        classification: "privileged",
      },
      "0dd4d6bd-2032-45ea-b95d-ec94535d7a90"
    )

    const clerkView = await getReport(
      new URLSearchParams({
        actorId: "clerk_a",
        rowType: "client",
        limit: "10",
        cursor: "0",
      })
    )
    expect(clerkView.status).toBe(200)
    const clerkJson = (await clerkView.json()) as { total: number }
    expect(clerkJson.total).toBe(0)

    const partnerView = await getReport(
      new URLSearchParams({
        actorId: "partner_a",
        rowType: "client",
        limit: "10",
        cursor: "0",
      })
    )
    const partnerJson = (await partnerView.json()) as { total: number }
    expect(partnerJson.total).toBe(1)
  })

  it("rejects unauthorized roles and unknown actors", async () => {
    const unknown = await getReport(new URLSearchParams({ actorId: "ghost", limit: "10", cursor: "0" }))
    expect(unknown.status).toBe(404)

    const clientDenied = await getReport(
      new URLSearchParams({ actorId: "client_a", limit: "10", cursor: "0" })
    )
    expect(clientDenied.status).toBe(403)

    const clientsListStillWorks = await clientsGet(
      new Request("http://127.0.0.1/api/d1/clients?userId=partner_a&limit=10&cursor=0")
    )
    expect(clientsListStillWorks.status).toBe(200)

    const mattersListStillWorks = await mattersGet(
      new Request("http://127.0.0.1/api/d1/matters?userId=partner_a&limit=10&cursor=0")
    )
    expect(mattersListStillWorks.status).toBe(200)
  })

  it("tracks report export analytics and relevance recompute with partner governance", async () => {
    const createdMatter = await postMatter(
      {
        action: "create",
        actorId: "partner_a",
        firmId: "firmA",
        clientId: "client_a",
        title: "Export Governance Matter",
        courtId: "SHC",
        classification: "internal",
      },
      "e10f3d9c-5e4d-43ff-a9e6-6d5f60799489"
    )
    expect(createdMatter.status).toBe(200)
    const createdJson = (await createdMatter.json()) as { result: { matter: { id: string } } }
    const matterId = createdJson.result.matter.id

    const denied = await postReport(
      {
        action: "record_matter_report_export",
        actorId: "associate_a",
        matterId,
        exportFormat: "csv",
        exportScope: "summary",
      },
      "ffbad764-1df6-40ef-892f-cbbd6760621d"
    )
    expect(denied.status).toBe(403)

    const exportRes = await postReport(
      {
        action: "record_matter_report_export",
        actorId: "partner_a",
        matterId,
        exportFormat: "csv",
        exportScope: "summary",
        reason: "weekly governance packet",
      },
      "148fe9a4-b108-4ae8-b1d4-2efbf65dad35"
    )
    expect(exportRes.status).toBe(200)
    const exportJson = (await exportRes.json()) as {
      result: {
        exportAnalytics: { exportCount: number; lastExportFormat: string | null }
      }
      reused: boolean
    }
    expect(exportJson.reused).toBe(false)
    expect(exportJson.result.exportAnalytics.exportCount).toBe(1)
    expect(exportJson.result.exportAnalytics.lastExportFormat).toBe("csv")

    const recomputeRes = await postReport(
      {
        action: "recompute_matter_report_relevance",
        actorId: "partner_a",
        matterId,
        reason: "post-export relevance pass",
        provenanceTags: ["manual_override", "matter:priority"],
      },
      "dff91741-a0a2-4ab4-a761-b42cdc58eb06"
    )
    expect(recomputeRes.status).toBe(200)
    const recomputeJson = (await recomputeRes.json()) as {
      result: {
        relevanceSnapshot: { scoreBand: string; freshnessStatus: string; provenanceTags: string[] }
      }
    }
    expect(["low", "medium", "high"]).toContain(recomputeJson.result.relevanceSnapshot.scoreBand)
    expect(recomputeJson.result.relevanceSnapshot.freshnessStatus).toBe("fresh")
    expect(recomputeJson.result.relevanceSnapshot.provenanceTags).toContain("manual_override")

    const exportView = await getReport(
      new URLSearchParams({
        view: "matter_report_export_analytics",
        actorId: "partner_a",
        matterId,
        scoreBand: recomputeJson.result.relevanceSnapshot.scoreBand,
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(exportView.status).toBe(200)
    const exportViewJson = (await exportView.json()) as {
      items: Array<{ matterId: string; relevance: { freshnessStatus: string } | null }>
    }
    expect(exportViewJson.items.some((row) => row.matterId === matterId)).toBe(true)
    expect(exportViewJson.items[0]?.relevance?.freshnessStatus).toBe("fresh")

    const relevanceView = await getReport(
      new URLSearchParams({
        view: "matter_report_relevance_snapshots",
        actorId: "partner_a",
        matterId,
        scoreBand: recomputeJson.result.relevanceSnapshot.scoreBand,
        freshnessStatus: "fresh",
        limit: "10",
        cursor: "0",
      })
    )
    expect(relevanceView.status).toBe(200)
    const relevanceViewJson = (await relevanceView.json()) as {
      items: Array<{ matterId: string; freshnessStatus: string }>
    }
    expect(relevanceViewJson.items.some((row) => row.matterId === matterId)).toBe(true)
    expect(relevanceViewJson.items[0]?.freshnessStatus).toBe("fresh")
  })
})
