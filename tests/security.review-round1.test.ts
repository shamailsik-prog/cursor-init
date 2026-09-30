// Regression tests for security review round 1 of fix/auth (stream A).
// The first describe block turns the reviewer's probes (scratchpad/probe) into
// assertions: privileged free text must never reach the external transport.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as committeePost } from "@/app/api/p1/committee-brain/route"
import { POST as documentsPost } from "@/app/api/d1/documents/route"
import { POST as filingsPost } from "@/app/api/d4/filings/route"
import { GET as tenancyGet } from "@/app/api/p5/tenancy/route"
import { callCommitteeBrain, setTransportForTests } from "@/platform/p1/internalAICaller"
import { providerAllowedFor } from "@/platform/p1/providerPolicy"
import { classificationRank, isClassification } from "@/platform/p1/types"
import { PublicError, publicErrorMessage } from "@/platform/http/errors"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import type { Classification } from "@/platform/spine/store"

const PROTOTYPE_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]

let k = 0
const key = () => `cccccccc-cccc-4ccc-8ccc-${String(++k).padStart(12, "0")}`

function jsonPost(handler: (r: Request) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )
}

const cb = (body: Record<string, unknown>) =>
  jsonPost(committeePost, "http://127.0.0.1/api/p1/committee-brain", body)

const ingest = (body: Record<string, unknown>) =>
  jsonPost(documentsPost, "http://127.0.0.1/api/d1/documents", {
    action: "ingest",
    contentBase64: Buffer.from(`content-${k}`).toString("base64"),
    sourceChannel: "web",
    ...body,
  })

function seedMatter(id: string, classification: Classification, members: string[]) {
  const store = getRuntimeStore()
  store.matters.set(id, {
    id,
    firmId: "firmA",
    clientId: "client_a",
    title: `Matter ${id}`,
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "live",
    classification,
  })
  for (const userId of members) {
    store.members.set(store.memberKey(id, userId), { matterId: id, userId, firmId: "firmA" })
  }
}

let sent = 0
beforeEach(() => {
  resetRuntimeStoreForTests()
  sent = 0
  setTransportForTests({
    async send() {
      sent += 1
      return { text: "ok" }
    },
  })
})
afterEach(() => {
  setTransportForTests(null)
  resetRuntimeStoreForTests()
})

describe("#1 classification labels are own keys only and ranks fail closed", () => {
  it.each(PROTOTYPE_KEYS)("rejects %s as a classification", (label) => {
    expect(isClassification(label)).toBe(false)
    expect(() => classificationRank(label as Classification)).toThrow()
    expect(providerAllowedFor("ai-gateway", label).allowed).toBe(false)
  })

  it("L18 §4.6 default table (no DPA, not in region): ranks 0-1 leave, ranks 2-4 are blocked", () => {
    for (const label of ["public", "internal"]) {
      expect(providerAllowedFor("ai-gateway", label).allowed).toBe(true)
    }
    for (const label of ["confidential", "privileged", "privileged-restricted"]) {
      expect(providerAllowedFor("ai-gateway", label).allowed).toBe(false)
    }
  })

  it.each(PROTOTYPE_KEYS)("document ingest refuses classification %s", async (label) => {
    const res = await ingest({ actorId: "clerk_a", firmId: "firmA", classification: label })
    expect(res.status).toBe(400)
    expect(getRuntimeStore().documents.size).toBe(0)
  })

  it.each(PROTOTYPE_KEYS)("committee-brain refuses a body label %s", async (label) => {
    seedMatter("mat_pub", "public", ["clerk_a"])
    const res = await cb({ actorId: "clerk_a", matterId: "mat_pub", body: "x", classification: label })
    expect(res.status).toBe(400)
    expect(sent).toBe(0)
  })

  it("callCommitteeBrain refuses a prototype-key classification", async () => {
    await expect(
      callCommitteeBrain({
        body: "memo",
        classification: "constructor" as Classification,
        provider: "ai-gateway",
        purpose: "x",
      })
    ).rejects.toThrow()
    expect(sent).toBe(0)
  })
})

describe("#2/#4 committee-brain free text cannot be laundered through a reference", () => {
  it("probe: prototype-key document + privileged text never leaves", async () => {
    const ing = await ingest({ actorId: "clerk_a", firmId: "firmA", classification: "constructor" })
    expect(ing.status).toBe(400)
    const res = await cb({ actorId: "clerk_a", body: "PRIVILEGED strategy memo", documentIds: ["doc_x"] })
    expect(res.status).toBe(400)
    expect(sent).toBe(0)
  })

  it("probe: self-created matter-less public doc + privileged text never leaves", async () => {
    const ing = await ingest({ actorId: "clerk_a", firmId: "firmA", classification: "public" })
    expect(ing.status).toBe(200)
    const docId = [...getRuntimeStore().documents.keys()].pop()!
    const res = await cb({ actorId: "clerk_a", body: "PRIVILEGED strategy memo", documentIds: [docId] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("matter_required")
    expect(sent).toBe(0)
  })

  it("requires matterId on every POST", async () => {
    const res = await cb({ actorId: "partner_a", body: "x", classification: "public" })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("matter_required")
  })

  it("rejects a matter-less document referenced under a public matter", async () => {
    seedMatter("mat_pub", "public", ["clerk_a"])
    const ing = await ingest({ actorId: "clerk_a", firmId: "firmA", classification: "public" })
    expect(ing.status).toBe(200)
    const docId = [...getRuntimeStore().documents.keys()].pop()!
    const res = await cb({
      actorId: "clerk_a",
      matterId: "mat_pub",
      body: "PRIVILEGED strategy memo",
      documentIds: [docId],
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("document_matter_mismatch")
    expect(sent).toBe(0)
  })

  it("rejects documents from another matter, even one the caller can access (#4)", async () => {
    seedMatter("mat_a", "public", ["partner_a", "clerk_a"])
    seedMatter("mat_b", "internal", ["partner_a"])
    getRuntimeStore().documents.set("doc_b", {
      id: "doc_b",
      firmId: "firmA",
      matterId: "mat_b",
      contentHash: "h",
      sourceChannel: "web",
      classification: "internal",
    })
    const res = await cb({ actorId: "partner_a", matterId: "mat_a", body: "x", documentIds: ["doc_b"] })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("document_matter_mismatch")
    expect(getRuntimeStore().committeeOutputs.size).toBe(0)
  })

  it("free text inherits max(matter, documents, body label)", async () => {
    seedMatter("mat_pub", "public", ["partner_a"])
    getRuntimeStore().documents.set("doc_priv", {
      id: "doc_priv",
      firmId: "firmA",
      matterId: "mat_pub",
      contentHash: "h",
      sourceChannel: "web",
      classification: "privileged",
    })
    const res = await cb({
      actorId: "partner_a",
      matterId: "mat_pub",
      body: "summary",
      documentIds: ["doc_priv"],
      classification: "public",
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { result: { outbound: { metadata: { classification: string } } } }
    expect(json.result.outbound.metadata.classification).toBe("privileged")
    expect(sent).toBe(0)
  })
})

describe("#6 four-eyes approvals cannot be self-approved", () => {
  it("record_variance_remediation rejects secondApproverId === actor", async () => {
    const res = await jsonPost(filingsPost, "http://127.0.0.1/api/d4/filings", {
      action: "record_variance_remediation",
      actorId: "partner_a",
      packageId: "pkg_any",
      decision: "temporary_override",
      justification: "urgent",
      expiresInHours: 4,
      secondApproverId: "partner_a",
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("self_approval_forbidden")
  })

  it("extend_breach_waiver rejects secondApproverId === actor", async () => {
    const res = await jsonPost(filingsPost, "http://127.0.0.1/api/d4/filings", {
      action: "extend_breach_waiver",
      actorId: "partner_a",
      packageId: "pkg_any",
      extendHours: 48,
      secondApproverId: "partner_a",
      rolloverJustification: "cap",
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code: string }).code).toBe("self_approval_forbidden")
  })
})

describe("#7 only PublicError messages reach clients", () => {
  it("passes PublicError through and hides plain Errors", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(publicErrorMessage(new PublicError("unknown actor"), "fallback")).toBe("unknown actor")
    expect(publicErrorMessage(new Error("db host 10.0.0.3 refused"), "fallback")).toBe("fallback")
    spy.mockRestore()
  })

  it("keeps route rejections readable", async () => {
    const res = await cb({ actorId: "ghost", matterId: "mat_x", body: "x" })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("unknown actor")
  })

  it("does not echo transport error text as the P1 reason", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    setTransportForTests({
      async send() {
        throw new Error("gateway 401: key sk-live-abc123 rejected at https://internal.example")
      },
    })
    const result = await callCommitteeBrain({
      body: "hello",
      classification: "public",
      provider: "ai-gateway",
      purpose: "x",
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe("transport_error")
    spy.mockRestore()
  })
})

describe("#9 tenancy session reference lookups are not an existence oracle", () => {
  it("answers a foreign session reference exactly like an unknown one", async () => {
    const minted = await tenancyGet(
      new Request("http://127.0.0.1/api/p5/tenancy?view=session&userId=partner_a&limit=10&cursor=0")
    )
    expect(minted.status).toBe(200)
    const refId = ((await minted.json()) as { sessionReference: { id: string } }).sessionReference.id

    const foreign = await tenancyGet(
      new Request(
        `http://127.0.0.1/api/p5/tenancy?view=session&userId=associate_a&sessionRefId=${refId}&limit=10&cursor=0`
      )
    )
    const unknown = await tenancyGet(
      new Request(
        "http://127.0.0.1/api/p5/tenancy?view=session&userId=associate_a&sessionRefId=tsr_nope&limit=10&cursor=0"
      )
    )
    expect(foreign.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(await foreign.json()).toEqual(await unknown.json())
  })
})
