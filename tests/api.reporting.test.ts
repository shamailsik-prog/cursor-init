import { afterEach, describe, expect, it } from "vitest"
import { GET as clientsGet, POST as clientsPost } from "@/app/api/d1/clients/route"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { GET as reportingGet } from "@/app/api/d1/reporting/route"
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
})
