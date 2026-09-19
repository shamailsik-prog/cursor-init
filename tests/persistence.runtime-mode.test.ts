import { readFileSync } from "node:fs"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import { collection, doc, getDoc, getDocs } from "firebase/firestore"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { GET as documentsGet, POST as documentsPost } from "@/app/api/d1/documents/route"
import {
  GET as workflowGet,
  POST as workflowPost,
} from "@/app/api/d1/document-workflow/route"
import { GET as filingsGet, POST as filingsPost } from "@/app/api/d4/filings/route"
import { GET as draftsGet, POST as draftsPost } from "@/app/api/d4/drafts/route"
import { GET as courtOpsGet, POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { composeDraft } from "@/services/d4-1/drafts"
import { getDocumentTypes } from "@/lib/foundation-data"

const RULES = readFileSync("firestore.rules", "utf8")

let env: RulesTestEnvironment

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "sikander-runtime-persistence",
    firestore: { rules: RULES },
  })
})

beforeEach(() => {
  resetRuntimeStoreForTests()
  process.env.SIKANDER_PERSISTENCE_MODE = "firestore"
})

afterEach(() => {
  delete process.env.SIKANDER_PERSISTENCE_MODE
  setFirestorePersistenceForTests(null)
})

afterAll(async () => {
  await env.cleanup()
})

describe("Runtime persistence mode", () => {
  async function createMatterViaRoute(
    title: string,
    idempotencyKey: string
  ): Promise<string> {
    const createRes = await mattersPost(
      new Request("http://127.0.0.1/api/d1/matters", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          action: "create",
          actorId: "partner_a",
          firmId: "firmA",
          clientId: "client_a",
          title,
          courtId: "SHC",
          classification: "internal",
          memberUserIds: ["associate_a", "clerk_a"],
        }),
      })
    )
    expect(createRes.status).toBe(200)
    const created = (await createRes.json()) as {
      result: { matter: { id: string } }
    }
    return created.result.matter.id
  }

  it("routes matters create/list through Firestore adapter mode in emulator", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())

      const matterId = await createMatterViaRoute(
        "Persisted runtime matter",
        "2387510e-e8e7-4a4f-b31d-5cee051f6f07"
      )

      const listRes = await mattersGet(
        new Request("http://127.0.0.1/api/d1/matters?userId=partner_a&limit=10&cursor=0")
      )
      expect(listRes.status).toBe(200)
      const listed = (await listRes.json()) as { items: Array<{ id: string }> }
      expect(listed.items.some((row) => row.id === matterId)).toBe(true)

      const dbMatter = await getDoc(doc(ctx.firestore(), "matters", matterId))
      expect(dbMatter.exists()).toBe(true)
      expect(dbMatter.data()?.title).toBe("Persisted runtime matter")
    })
  })

  it("persists document ingest and workflow transitions in Firestore mode", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted document matter",
        "8effb371-c5d4-4aae-8f0d-c2ae801f9e72"
      )

      const ingestRes = await documentsPost(
        new Request("http://127.0.0.1/api/d1/documents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b9036fa8-4842-4bf9-8998-a2af67cc58f5",
          },
          body: JSON.stringify({
            action: "ingest",
            actorId: "partner_a",
            firmId: "firmA",
            matterId,
            contentBase64: Buffer.from("%PDF-runtime-doc%").toString("base64"),
            sourceChannel: "web",
            classification: "internal",
          }),
        })
      )
      expect(ingestRes.status).toBe(200)
      const ingestJson = (await ingestRes.json()) as {
        result: { doc: { id: string } }
      }
      const docId = ingestJson.result.doc.id

      const docsList = await documentsGet(
        new Request(
          `http://127.0.0.1/api/d1/documents?userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(docsList.status).toBe(200)
      const docsJson = (await docsList.json()) as { items: Array<{ id: string }> }
      expect(docsJson.items.some((item) => item.id === docId)).toBe(true)

      const transitionRes = await workflowPost(
        new Request("http://127.0.0.1/api/d1/document-workflow", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "55dfc4df-a88e-4b47-a0a6-c660936f3c9a",
          },
          body: JSON.stringify({
            action: "transition",
            actorId: "associate_a",
            documentId: docId,
            nextStatus: "processing",
          }),
        })
      )
      expect(transitionRes.status).toBe(200)

      const queueRes = await workflowGet(
        new Request(
          `http://127.0.0.1/api/d1/document-workflow?view=queue&userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(queueRes.status).toBe(200)
      const queueJson = (await queueRes.json()) as {
        items: Array<{ documentId: string; status: string }>
      }
      const queueItem = queueJson.items.find((item) => item.documentId === docId)
      expect(queueItem?.status).toBe("processing")

      const timelineRes = await workflowGet(
        new Request(
          `http://127.0.0.1/api/d1/document-workflow?view=timeline&userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(timelineRes.status).toBe(200)
      const timelineJson = (await timelineRes.json()) as {
        items: Array<{ documentId: string; action: string }>
      }
      expect(
        timelineJson.items.some(
          (item) => item.documentId === docId && item.action === "status_transition"
        )
      ).toBe(true)

      const dbDoc = await getDoc(doc(ctx.firestore(), "documents", docId))
      expect(dbDoc.exists()).toBe(true)

      const dbWorkflow = await getDoc(doc(ctx.firestore(), "document_workflow", docId))
      expect(dbWorkflow.exists()).toBe(true)
      expect(dbWorkflow.data()?.status).toBe("processing")

      const dbJobs = await getDocs(collection(ctx.firestore(), "jobs"))
      expect(
        dbJobs.docs.some(
          (entry) =>
            entry.data()?.documentId === docId && entry.data()?.jobType === "ocr"
        )
      ).toBe(true)

      const dbEvents = await getDocs(collection(ctx.firestore(), "workflow_events"))
      expect(
        dbEvents.docs.some(
          (entry) =>
            entry.data()?.documentId === docId &&
            entry.data()?.action === "status_transition"
        )
      ).toBe(true)
    })
  })

  it("persists filing package create/decide through Firestore-backed routes", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted filing matter",
        "8ca5f631-e807-4d3f-a5e7-7cf89eaf3070"
      )
      const template = getDocumentTypes()[0]
      if (!template) throw new Error("missing template seed")
      const draft = composeDraft(getRuntimeStore(), {
        actorId: "associate_a",
        matterId,
        templateId: template.id,
        title: "Runtime filing draft",
        body: "Draft text",
        classification: "internal",
        preflight: {
          actorId: "associate_a",
          matterId,
          classification: "internal",
          citedJudgmentIds: [],
          temporalCitations: [],
        },
      })

      const createPkg = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "dbf2a40d-5a68-41c6-93c0-8a3df654fdbc",
          },
          body: JSON.stringify({
            action: "create_package",
            actorId: "associate_a",
            matterId,
            draftId: draft.id,
            classification: "internal",
            citedJudgmentIds: [],
            temporalCitations: [],
          }),
        })
      )
      expect(createPkg.status).toBe(200)
      const created = (await createPkg.json()) as {
        result: { filingPackage: { id: string } }
      }
      const packageId = created.result.filingPackage.id

      const approvePkg = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "53af1276-f9f7-4190-9ec8-88c2af8a1f8c",
          },
          body: JSON.stringify({
            action: "decide_package",
            actorId: "partner_a",
            packageId,
            decision: "approve",
            reason: "Partner approved runtime flow",
          }),
        })
      )
      expect(approvePkg.status).toBe(200)

      const filingsList = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(filingsList.status).toBe(200)
      const listJson = (await filingsList.json()) as {
        items: Array<{ id: string; status: string }>
      }
      const row = listJson.items.find((item) => item.id === packageId)
      expect(row?.status).toBe("approved")

      const dbPackage = await getDoc(doc(ctx.firestore(), "filing_packages", packageId))
      expect(dbPackage.exists()).toBe(true)
      expect(dbPackage.data()?.status).toBe("approved")
    })
  })

  it("persists draft compose/list through Firestore-backed route mode", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted draft matter",
        "5983eb9b-5f04-4590-a6fe-c6508862494f"
      )
      const template = getDocumentTypes()[0]
      if (!template) throw new Error("missing template seed")

      const composeRes = await draftsPost(
        new Request("http://127.0.0.1/api/d4/drafts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "29b5dd73-d75f-4cad-b838-a7a4f5db8518",
          },
          body: JSON.stringify({
            action: "compose",
            actorId: "associate_a",
            matterId,
            templateId: template.id,
            title: "Persisted runtime draft",
            body: "Draft body",
            classification: "internal",
            citedJudgmentIds: [],
            temporalCitations: [],
          }),
        })
      )
      expect(composeRes.status).toBe(200)
      const composeJson = (await composeRes.json()) as {
        result: { draft: { id: string } }
      }
      const draftId = composeJson.result.draft.id

      const listRes = await draftsGet(
        new Request(
          `http://127.0.0.1/api/d4/drafts?view=drafts&userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(listRes.status).toBe(200)
      const listJson = (await listRes.json()) as { items: Array<{ id: string }> }
      expect(listJson.items.some((item) => item.id === draftId)).toBe(true)

      const dbDraft = await getDoc(doc(ctx.firestore(), "drafts", draftId))
      expect(dbDraft.exists()).toBe(true)
      expect(dbDraft.data()?.title).toBe("Persisted runtime draft")
    })
  })

  it("persists court-ops queue resolution lifecycle in Firestore mode", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted ops matter",
        "e2e2d157-16f4-4452-ab24-d0119c5260ac"
      )

      const recordCaseRes = await mattersPost(
        new Request("http://127.0.0.1/api/d1/matters", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "92894752-d7aa-4ec7-b6a3-054fca850772",
          },
          body: JSON.stringify({
            action: "record_case_number",
            actorId: "partner_a",
            matterId,
            raw: "CP 1234",
            courtId: "SHC",
          }),
        })
      )
      expect(recordCaseRes.status).toBe(200)

      const ingestRes = await documentsPost(
        new Request("http://127.0.0.1/api/d1/documents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "7c4ca228-d862-46e2-a8fe-cf4a6901f49a",
          },
          body: JSON.stringify({
            action: "ingest",
            actorId: "partner_a",
            firmId: "firmA",
            matterId,
            contentBase64: Buffer.from("%PDF-ops-doc%").toString("base64"),
            sourceChannel: "web",
            classification: "internal",
          }),
        })
      )
      expect(ingestRes.status).toBe(200)
      const ingestJson = (await ingestRes.json()) as {
        result: { doc: { id: string } }
      }
      const docId = ingestJson.result.doc.id

      const processingRes = await workflowPost(
        new Request("http://127.0.0.1/api/d1/document-workflow", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "cad17bd4-7d80-4051-b0f0-a8a307077847",
          },
          body: JSON.stringify({
            action: "transition",
            actorId: "associate_a",
            documentId: docId,
            nextStatus: "processing",
          }),
        })
      )
      expect(processingRes.status).toBe(200)

      const reviewReqRes = await workflowPost(
        new Request("http://127.0.0.1/api/d1/document-workflow", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "843b4e8c-b8db-40ca-952f-9f1f55db262a",
          },
          body: JSON.stringify({
            action: "transition",
            actorId: "associate_a",
            documentId: docId,
            nextStatus: "review_required",
          }),
        })
      )
      expect(reviewReqRes.status).toBe(200)

      const queueRes = await courtOpsGet(
        new Request(
          `http://127.0.0.1/api/d2/court-ops?userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(queueRes.status).toBe(200)
      const queueJson = (await queueRes.json()) as {
        items: Array<{ queueType: string; id: string; documentId?: string }>
      }
      const followUpItem = queueJson.items.find((item) => item.queueType === "follow_up")
      expect(followUpItem?.id).toBeTruthy()

      const resolveFollowUpRes = await courtOpsPost(
        new Request("http://127.0.0.1/api/d2/court-ops", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "3f070548-4e2c-41a7-a080-e89c0f83b744",
          },
          body: JSON.stringify({
            action: "resolve_follow_up",
            actorId: "partner_a",
            followUpId: followUpItem?.id,
            reason: "Resolved in runtime mode",
          }),
        })
      )
      expect(resolveFollowUpRes.status).toBe(200)

      const resolveWorkflowRes = await courtOpsPost(
        new Request("http://127.0.0.1/api/d2/court-ops", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b92c4725-9185-4cf4-926e-cf0f1e8c74f6",
          },
          body: JSON.stringify({
            action: "resolve_workflow",
            actorId: "associate_a",
            documentId: docId,
            nextStatus: "complete",
            reason: "Cleared in court ops",
          }),
        })
      )
      expect(resolveWorkflowRes.status).toBe(200)

      const dbFollowUp = await getDoc(doc(ctx.firestore(), "follow_ups", followUpItem?.id ?? ""))
      expect(dbFollowUp.exists()).toBe(true)
      expect(dbFollowUp.data()?.status).toBe("resolved")

      const dbWorkflow = await getDoc(doc(ctx.firestore(), "document_workflow", docId))
      expect(dbWorkflow.exists()).toBe(true)
      expect(dbWorkflow.data()?.status).toBe("complete")
    })
  })
})
