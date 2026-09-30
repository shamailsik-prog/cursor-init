// Regression tests for security review round 3 (approved with Low follow-ups).
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET as clientsGet } from "@/app/api/d1/clients/route"
import { GET as documentsGet } from "@/app/api/d1/documents/route"
import { GET as filingsGet, POST as filingsPost } from "@/app/api/d4/filings/route"
import { POST as committeePost } from "@/app/api/p1/committee-brain/route"
import { GET as tenancyGet, POST as tenancyPost } from "@/app/api/p5/tenancy/route"
import { setTransportForTests } from "@/platform/p1/internalAICaller"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import { getDocumentTypes } from "@/lib/foundation-data"

let k = 0
const key = () => `ffffffff-ffff-4fff-8fff-${String(++k).padStart(12, "0")}`
const post = (h: (r: Request) => Promise<Response>, url: string, body: unknown) =>
  h(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )

beforeEach(() => {
  resetRuntimeStoreForTests()
  setTransportForTests({
    async send() {
      return { text: "ok" }
    },
  })
})
afterEach(() => {
  setTransportForTests(null)
  resetRuntimeStoreForTests()
})

describe("R2 not-found and other-firm answer identically", () => {
  it("update_role: another firm's user looks like an unknown user", async () => {
    const attempt = (targetUserId: string) =>
      post(tenancyPost, "http://127.0.0.1/api/p5/tenancy", {
        action: "update_role",
        actorId: "partner_b",
        firmId: "firmB",
        targetUserId,
        nextRole: "associate",
        nextClearance: "internal",
      })
    const foreign = await attempt("associate_a")
    const unknown = await attempt("nobody_x")
    expect(foreign.status).toBe(unknown.status)
    const body = await foreign.json()
    expect(body).toEqual(await unknown.json())
    expect(JSON.stringify(body)).not.toContain("associate_a")
  })

  it("session_lineage: another firm's root looks like an unknown root", async () => {
    const minted = await tenancyGet(
      new Request("http://127.0.0.1/api/p5/tenancy?view=session&userId=partner_a&limit=10&cursor=0")
    )
    const refId = ((await minted.json()) as { sessionReference: { id: string } }).sessionReference.id
    const lineage = (root: string) =>
      tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage&actorId=partner_b&firmId=firmB&rootSessionRefId=${root}&limit=10&cursor=0`
        )
      )
    const foreign = await lineage(refId)
    const unknown = await lineage("tsr_nope")
    expect(foreign.status).toBe(unknown.status)
    expect(await foreign.json()).toEqual(await unknown.json())
  })
})

describe("R3 a legacy 'bogus' stored label never breaks a listing", () => {
  it("clients", async () => {
    getRuntimeStore().entities.set("ent_bogus", {
      id: "ent_bogus",
      firmId: "firmA",
      canonicalName: "Legacy",
      cnic: "42101-0000000-1",
      phone: "0300",
      classification: "bogus" as never,
    })
    const res = await clientsGet(
      new Request("http://127.0.0.1/api/d1/clients?userId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((i) => i.id)).not.toContain("ent_bogus")
  })

  it("documents", async () => {
    getRuntimeStore().documents.set("doc_bogus", {
      id: "doc_bogus",
      firmId: "firmA",
      matterId: null,
      contentHash: "h",
      sourceChannel: "web",
      classification: "bogus" as never,
    })
    const res = await documentsGet(
      new Request("http://127.0.0.1/api/d1/documents?userId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((i) => i.id)).not.toContain("doc_bogus")
  })

  it("filings", async () => {
    const store = getRuntimeStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client_a",
      title: "Filing matter",
      courtId: "SHC",
      classification: "internal",
    })
    for (const u of ["partner_a", "associate_a"]) addMember(store, matter.id, u, "firmA")
    const template = getDocumentTypes()[0]!
    const draft = composeDraft(store, {
      actorId: "associate_a",
      matterId: matter.id,
      templateId: template.id,
      title: "Draft",
      body: "Body",
      classification: "internal",
      preflight: {
        actorId: "associate_a",
        matterId: matter.id,
        classification: "internal",
        citedJudgmentIds: [],
        temporalCitations: [],
      },
    })
    const created = await post(filingsPost, "http://127.0.0.1/api/d4/filings", {
      action: "create_package",
      actorId: "associate_a",
      matterId: matter.id,
      draftId: draft.id,
      classification: "internal",
      citedJudgmentIds: [],
      temporalCitations: [],
    })
    expect(created.status).toBe(200)
    const pkgId = ((await created.json()) as { result: { filingPackage: { id: string } } }).result
      .filingPackage.id
    const pkg = store.filingPackages.get(pkgId)!
    store.filingPackages.set(pkgId, { ...pkg, classification: "bogus" as never })
    const res = await filingsGet(
      new Request("http://127.0.0.1/api/d4/filings?userId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((i) => i.id)).not.toContain(pkgId)
  })
})

describe("I1 committee-brain purpose is a fixed server-side value", () => {
  function seed() {
    const store = getRuntimeStore()
    store.matters.set("mat_x", {
      id: "mat_x",
      firmId: "firmA",
      clientId: "client_a",
      title: "x",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "live",
      classification: "internal",
    })
    store.members.set(store.memberKey("mat_x", "partner_a"), {
      matterId: "mat_x",
      userId: "partner_a",
      firmId: "firmA",
    })
  }

  it.each(["PRIVILEGED strategy in purpose", "", "Summarise", { a: 1 }])(
    "rejects purpose %j with 400 invalid_purpose",
    async (purpose) => {
      seed()
      const res = await post(committeePost, "http://127.0.0.1/api/p1/committee-brain", {
        actorId: "partner_a",
        matterId: "mat_x",
        body: "x",
        purpose,
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe("invalid_purpose")
    }
  )

  it.each(["committee-brain", "summarise", "research", "translate", "ops-audit"])(
    "accepts purpose %s",
    async (purpose) => {
      seed()
      const res = await post(committeePost, "http://127.0.0.1/api/p1/committee-brain", {
        actorId: "partner_a",
        matterId: "mat_x",
        body: "x",
        purpose,
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as { result: { outbound: { metadata: { purpose: string } } } }
      expect(json.result.outbound.metadata.purpose).toBe(purpose)
    }
  )
})
