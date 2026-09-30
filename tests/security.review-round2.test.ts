// Regression tests for security re-review (round 2) of fix/auth (stream A).
// N1 turns the reviewer's probe (scratchpad/probe-r1/launder.test.ts) into
// assertions; firebase-mode items (N2, N4) live in tests/auth.session.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { GET as committeeGet, POST as committeePost } from "@/app/api/p1/committee-brain/route"
import { POST as mattersPost } from "@/app/api/d1/matters/route"
import { POST as documentsPost } from "@/app/api/d1/documents/route"
import { GET as opsGet } from "@/app/api/d2/ops-reporting/route"
import { GET as tenancyGet, POST as tenancyPost } from "@/app/api/p5/tenancy/route"
import { setTransportForTests } from "@/platform/p1/internalAICaller"
import { runWithSession } from "@/platform/p5/requestSession"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { rankOfStoredOrMax, storedUserRecord } from "@/platform/spine/store"

let sent = 0
let k = 0
const key = () => `eeeeeeee-eeee-4eee-8eee-${String(++k).padStart(12, "0")}`
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

type CbJson = {
  result: { blocked: boolean; outbound: { metadata: { classification: string } } }
}

describe("N1 caller free text is never sent at rank 0", () => {
  it.each(["clerk_a", "associate_a"])(
    "%s self-creates a public matter, then sends privileged free text under it: blocked, not sent",
    async (actorId) => {
      const m = await post(mattersPost, "http://127.0.0.1/api/d1/matters", {
        action: "create",
        actorId,
        firmId: "firmA",
        clientId: "client_a",
        title: "t",
        courtId: "SHC",
        classification: "public",
      })
      expect(m.status).toBe(200)
      const matterId = ((await m.json()) as { result: { matter: { id: string } } }).result.matter.id
      const res = await post(committeePost, "http://127.0.0.1/api/p1/committee-brain", {
        actorId,
        matterId,
        body: "PRIVILEGED strategy memo from matter X",
      })
      expect(res.status).toBe(200)
      const json = (await res.json()) as CbJson
      expect(json.result.blocked).toBe(true)
      expect(json.result.outbound.metadata.classification).toBe("internal")
      expect(sent).toBe(0)
    }
  )

  it("a body label cannot lower free text below internal", async () => {
    const m = await post(mattersPost, "http://127.0.0.1/api/d1/matters", {
      action: "create",
      actorId: "partner_a",
      firmId: "firmA",
      clientId: "client_a",
      title: "t",
      courtId: "SHC",
      classification: "public",
    })
    const matterId = ((await m.json()) as { result: { matter: { id: string } } }).result.matter.id
    const res = await post(committeePost, "http://127.0.0.1/api/p1/committee-brain", {
      actorId: "partner_a",
      matterId,
      body: "text",
      classification: "public",
    })
    const json = (await res.json()) as CbJson
    expect(json.result.outbound.metadata.classification).toBe("internal")
    expect(sent).toBe(0)
  })

  it("re-ingesting privileged bytes with a lower label keeps the higher label", async () => {
    const store = getRuntimeStore()
    store.matters.set("mat_priv", {
      id: "mat_priv",
      firmId: "firmA",
      clientId: "client_a",
      title: "p",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "live",
      classification: "privileged",
    })
    store.members.set(store.memberKey("mat_priv", "partner_a"), {
      matterId: "mat_priv",
      userId: "partner_a",
      firmId: "firmA",
    })
    const content = Buffer.from("same").toString("base64")
    const a = await post(documentsPost, "http://127.0.0.1/api/d1/documents", {
      action: "ingest",
      actorId: "partner_a",
      firmId: "firmA",
      matterId: "mat_priv",
      contentBase64: content,
      sourceChannel: "web",
      classification: "privileged",
    })
    expect(a.status).toBe(200)
    await post(documentsPost, "http://127.0.0.1/api/d1/documents", {
      action: "ingest",
      actorId: "clerk_a",
      firmId: "firmA",
      contentBase64: content,
      sourceChannel: "web",
      classification: "public",
    })
    const labels = [...store.documents.values()].map((d) => d.classification)
    expect(labels).not.toContain("public")
  })
})

describe("N3 the caller's record is capped on every read path", () => {
  it("get, values, entries, forEach and iteration all apply the ceiling; storage does not", () => {
    const users = getRuntimeStore().users
    runWithSession({ userId: "partner_a", firmId: "firmA", clearance: "internal" }, () => {
      const pick = (list: Array<{ id: string; clearanceLevel: string }>) =>
        list.find((u) => u.id === "partner_a")?.clearanceLevel
      expect(users.get("partner_a")?.clearanceLevel).toBe("internal")
      expect(pick([...users.values()])).toBe("internal")
      expect(pick([...users.entries()].map(([, u]) => u))).toBe("internal")
      expect(pick([...users].map(([, u]) => u))).toBe("internal")
      const viaForEach: Array<{ id: string; clearanceLevel: string }> = []
      users.forEach((u) => viaForEach.push(u))
      expect(pick(viaForEach)).toBe("internal")
      // Other users are untouched, and the stored record is never lowered.
      expect(users.get("associate_a")?.clearanceLevel).toBe("privileged")
      expect(storedUserRecord(getRuntimeStore(), "partner_a")?.clearanceLevel).toBe(
        "privileged-restricted"
      )
    })
    expect(users.get("partner_a")?.clearanceLevel).toBe("privileged-restricted")
    expect([...users.values()].find((u) => u.id === "partner_a")?.clearanceLevel).toBe(
      "privileged-restricted"
    )
  })
})

describe("N3 repository reads never persist a request-scoped ceiling", () => {
  it("syncing users inside a capped request leaves the stored clearance alone", async () => {
    const store = getRuntimeStore()
    const { getRuntimeRepositories } = await import("@/platform/persistence/runtimeRepositories")
    const { syncFirmUsers } = await import("@/platform/persistence/userSync")
    const repos = await getRuntimeRepositories(store)
    await runWithSession({ userId: "partner_a", firmId: "firmA", clearance: "internal" }, async () => {
      expect((await repos.users.get("partner_a"))?.clearanceLevel).toBe("privileged-restricted")
      await syncFirmUsers(store, repos, "firmA")
    })
    expect(storedUserRecord(store, "partner_a")?.clearanceLevel).toBe("privileged-restricted")
  })
})

describe("N5 unreadable stored labels count as privileged-restricted", () => {
  it("rankOfStoredOrMax maps unknown labels to the maximum rank", () => {
    expect(rankOfStoredOrMax("public")).toBe(0)
    expect(rankOfStoredOrMax("bogus")).toBe(4)
    expect(rankOfStoredOrMax("constructor")).toBe(4)
    expect(rankOfStoredOrMax(undefined)).toBe(4)
  })

  it("a legacy committee output labelled 'bogus' does not break the listing", async () => {
    const store = getRuntimeStore()
    store.committeeOutputs.set("cbo_bogus", {
      id: "cbo_bogus",
      firmId: "firmA",
      actorId: "associate_a",
      classification: "bogus" as never,
      purpose: "committee-brain",
      blocked: true,
      outbound: {
        body: "[masked]",
        metadata: {
          classification: "bogus" as never,
          provider: "ai-gateway",
          purpose: "committee-brain",
          redactionCounts: {},
        },
      },
      createdAt: 1,
    })
    const res = await committeeGet(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    // associate_a (privileged) is below the assumed privileged-restricted.
    expect(((await res.json()) as { total: number }).total).toBe(0)
  })

  it("a legacy ops activity row labelled 'bogus' does not break the listing", async () => {
    const store = getRuntimeStore()
    const row = {
      id: "ops_bogus",
      firmId: "firmA",
      source: "workflow_event",
      action: "workflow_transition",
      actorId: "associate_a",
      classification: "bogus",
      matterId: null,
      documentId: null,
      followUpId: null,
      queueType: null,
      status: "processing",
      detail: "legacy",
      tags: [],
      createdAt: 1,
    }
    ;(store.workflowOpsActivity as Map<string, unknown>).set(row.id, row)
    const res = await opsGet(
      new Request("http://127.0.0.1/api/d2/ops-reporting?actorId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((i) => i.id)).not.toContain("ops_bogus")
  })
})

describe("N6 unknown and cross-firm answer identically", () => {
  it("revoking another firm's session reference looks like revoking an unknown one", async () => {
    const minted = await tenancyGet(
      new Request("http://127.0.0.1/api/p5/tenancy?view=session&userId=partner_a&limit=10&cursor=0")
    )
    const refId = ((await minted.json()) as { sessionReference: { id: string } }).sessionReference.id
    const attempt = (sessionReferenceId: string) =>
      post(tenancyPost, "http://127.0.0.1/api/p5/tenancy", {
        action: "revoke_session_reference",
        actorId: "partner_b",
        firmId: "firmB",
        sessionReferenceId,
        reason: "probe",
      })
    const foreign = await attempt(refId)
    const unknown = await attempt("tsr_does_not_exist")
    expect(foreign.status).toBe(unknown.status)
    expect(await foreign.json()).toEqual(await unknown.json())
  })
})
