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
import { GET as opsReportingGet } from "@/app/api/d2/ops-reporting/route"
import { GET as tenancyGet, POST as tenancyPost } from "@/app/api/p5/tenancy/route"
import { GET as clientsGet, POST as clientsPost } from "@/app/api/d1/clients/route"
import { GET as reportingGet } from "@/app/api/d1/reporting/route"
import { GET as committeeGet, POST as committeePost } from "@/app/api/p1/committee-brain/route"
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

  it("persists draft template analytics and rehydrates discovery ordering after reset", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted draft analytics matter",
        "5ef90e29-122d-4ba0-967d-278a11ba9a86"
      )
      const templates = getDocumentTypes()
      const primary = templates[0]
      const secondary = templates[1]
      if (!primary || !secondary) throw new Error("missing template seeds")

      const composePayload = (templateId: string, title: string, key: string) =>
        draftsPost(
          new Request("http://127.0.0.1/api/d4/drafts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": key,
            },
            body: JSON.stringify({
              action: "compose",
              actorId: "associate_a",
              matterId,
              templateId,
              title,
              body: "Body",
              classification: "internal",
              citedJudgmentIds: [],
              temporalCitations: [],
            }),
          })
        )

      expect(
        (
          await composePayload(
            primary.id,
            "Analytics draft A",
            "3d9f28e1-ed4f-4db4-bf1c-987ff869ec97"
          )
        ).status
      ).toBe(200)
      expect(
        (
          await composePayload(
            secondary.id,
            "Analytics draft B",
            "86f756ce-df6f-4ad0-b5dc-59e1e446f2c4"
          )
        ).status
      ).toBe(200)
      expect(
        (
          await composePayload(
            primary.id,
            "Analytics draft C",
            "6ac14923-7eff-4e4d-8a6e-f450e6c7dba4"
          )
        ).status
      ).toBe(200)

      const searchRes = await draftsGet(
        new Request(
          `http://127.0.0.1/api/d4/drafts?view=templates&actorId=associate_a&q=${encodeURIComponent(primary.id)}&limit=10&cursor=0`
        )
      )
      expect(searchRes.status).toBe(200)

      getRuntimeStore().draftTemplateAnalytics = new Map()

      const templateView = await draftsGet(
        new Request(
          `http://127.0.0.1/api/d4/drafts?view=templates&actorId=associate_a&q=${encodeURIComponent(primary.id)}&limit=10&cursor=0`
        )
      )
      expect(templateView.status).toBe(200)
      const templateJson = (await templateView.json()) as {
        items: Array<{
          id: string
          analytics: { composeCount: number; templateSearchCount: number }
        }>
      }
      const primaryRow = templateJson.items.find((item) => item.id === primary.id)
      expect((primaryRow?.analytics.composeCount ?? 0) >= 2).toBe(true)
      expect((primaryRow?.analytics.templateSearchCount ?? 0) >= 1).toBe(true)

      const draftsView = await draftsGet(
        new Request(
          `http://127.0.0.1/api/d4/drafts?view=drafts&userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(draftsView.status).toBe(200)
      const draftsJson = (await draftsView.json()) as {
        items: Array<{ templateId: string }>
      }
      expect(draftsJson.items[0]?.templateId).toBe(primary.id)

      const persistedAnalytics = await getDocs(collection(ctx.firestore(), "draft_template_analytics"))
      expect(
        persistedAnalytics.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.templateId === primary.id &&
            entry.data()?.composeCount >= 2 &&
            entry.data()?.templateSearchCount >= 1
        )
      ).toBe(true)
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

  it("persists workflow/court-ops activity index and rehydrates reporting after reset", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted ops reporting matter",
        "5ff4fa50-12e1-41e8-9f58-b848f78d04cb"
      )

      const ingestRes = await documentsPost(
        new Request("http://127.0.0.1/api/d1/documents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8db3378c-65f5-4c32-97f8-c2e89cff3f78",
          },
          body: JSON.stringify({
            action: "ingest",
            actorId: "partner_a",
            firmId: "firmA",
            matterId,
            contentBase64: Buffer.from("%PDF-ops-reporting-doc%").toString("base64"),
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

      const transition = await workflowPost(
        new Request("http://127.0.0.1/api/d1/document-workflow", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "3f7366c2-a19a-4b34-af66-0f90f94c5fc8",
          },
          body: JSON.stringify({
            action: "transition",
            actorId: "associate_a",
            documentId: docId,
            nextStatus: "processing",
          }),
        })
      )
      expect(transition.status).toBe(200)

      const rejectCaseNumberRes = await mattersPost(
        new Request("http://127.0.0.1/api/d1/matters", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "4ff7c4ce-18f7-4f4d-84d7-c1c7049c8ff7",
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
      expect(rejectCaseNumberRes.status).toBe(200)

      const queue = await courtOpsGet(
        new Request(
          `http://127.0.0.1/api/d2/court-ops?userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(queue.status).toBe(200)
      const queueJson = (await queue.json()) as {
        items: Array<{ queueType: string; id: string }>
      }
      const followUp = queueJson.items.find((row) => row.queueType === "follow_up")
      if (!followUp) throw new Error("expected follow_up queue item")

      const resolve = await courtOpsPost(
        new Request("http://127.0.0.1/api/d2/court-ops", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c54621c1-7f89-4ac7-a666-c5ce7896c693",
          },
          body: JSON.stringify({
            action: "resolve_follow_up",
            actorId: "partner_a",
            followUpId: followUp.id,
            reason: "Resolved for ops reporting",
          }),
        })
      )
      expect(resolve.status).toBe(200)

      getRuntimeStore().workflowOpsActivity = new Map()

      const reporting = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?actorId=associate_a&matterId=${matterId}&limit=20&cursor=0`
        )
      )
      expect(reporting.status).toBe(200)
      const reportingJson = (await reporting.json()) as {
        items: Array<{ source: string; action: string; documentId: string | null }>
        total: number
      }
      expect(reportingJson.total).toBeGreaterThanOrEqual(2)
      expect(
        reportingJson.items.some(
          (row) =>
            row.source === "workflow_event" &&
            row.action === "workflow_transition" &&
            row.documentId === docId
        )
      ).toBe(true)
      expect(
        reportingJson.items.some(
          (row) =>
            row.source === "court_ops" && row.action === "court_ops_resolve_follow_up"
        )
      ).toBe(true)

      const persistedOps = await getDocs(collection(ctx.firestore(), "workflow_ops_activity"))
      expect(
        persistedOps.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.source === "workflow_event" &&
            entry.data()?.documentId === docId
        )
      ).toBe(true)
      expect(
        persistedOps.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.source === "court_ops" &&
            entry.data()?.action === "court_ops_resolve_follow_up"
        )
      ).toBe(true)
    })
  })

  it("persists follow-up and intimation creation at source through matters route", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted source follow-up matter",
        "c80ce346-af03-4e18-8d29-8a179fd95bd3"
      )

      const confirmRes = await mattersPost(
        new Request("http://127.0.0.1/api/d1/matters", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "7c7f14a6-499d-49f0-b6dc-2868e812f9ab",
          },
          body: JSON.stringify({
            action: "confirm_engagement",
            actorId: "partner_a",
            matterId,
          }),
        })
      )
      expect(confirmRes.status).toBe(200)

      const rejectCaseNumberRes = await mattersPost(
        new Request("http://127.0.0.1/api/d1/matters", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b14a8ce0-7909-4729-8fef-3e066fd093f3",
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
      expect(rejectCaseNumberRes.status).toBe(200)

      const followUpsBeforeQueue = await getDocs(collection(ctx.firestore(), "follow_ups"))
      const followUpRow = followUpsBeforeQueue.docs.find(
        (entry) => entry.data()?.matterId === matterId && entry.data()?.kind === "case_number_reject"
      )
      expect(followUpRow?.id).toBeTruthy()

      const intimationRows = await getDocs(collection(ctx.firestore(), "intimation_register"))
      expect(intimationRows.docs.some((entry) => entry.data()?.matterId === matterId)).toBe(true)

      // Clear in-memory follow ups to prove court-ops can hydrate from persistent source.
      getRuntimeStore().followUps = []
      const queueRes = await courtOpsGet(
        new Request(
          `http://127.0.0.1/api/d2/court-ops?userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(queueRes.status).toBe(200)
      const queueJson = (await queueRes.json()) as {
        items: Array<{ queueType: string; id: string }>
      }
      expect(
        queueJson.items.some(
          (item) => item.queueType === "follow_up" && item.id === followUpRow?.id
        )
      ).toBe(true)
    })
  })

  it("hydrates permission checks from persisted matter memberships after in-memory reset", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted membership matter",
        "60c99e85-5d41-4edc-abca-af5631d2557d"
      )

      // Simulate fresh request cycle where in-memory membership map is empty.
      getRuntimeStore().members = new Map()

      const mattersList = await mattersGet(
        new Request("http://127.0.0.1/api/d1/matters?userId=associate_a&limit=10&cursor=0")
      )
      expect(mattersList.status).toBe(200)
      const mattersJson = (await mattersList.json()) as { items: Array<{ id: string }> }
      expect(mattersJson.items.some((item) => item.id === matterId)).toBe(true)

      const draftTemplate = getDocumentTypes()[0]
      if (!draftTemplate) throw new Error("missing template seed")
      const draftRes = await draftsPost(
        new Request("http://127.0.0.1/api/d4/drafts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8ce2f6f2-eb6f-44c3-8f7a-03691a6de4a2",
          },
          body: JSON.stringify({
            action: "compose",
            actorId: "associate_a",
            matterId,
            templateId: draftTemplate.id,
            title: "Membership hydrated draft",
            body: "Body",
            classification: "internal",
            citedJudgmentIds: [],
            temporalCitations: [],
          }),
        })
      )
      expect(draftRes.status).toBe(200)

      const ingestRes = await documentsPost(
        new Request("http://127.0.0.1/api/d1/documents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "aa3400ce-7214-4302-b6c9-a4425f894666",
          },
          body: JSON.stringify({
            action: "ingest",
            actorId: "associate_a",
            firmId: "firmA",
            matterId,
            contentBase64: Buffer.from("%PDF-membership-check%").toString("base64"),
            sourceChannel: "web",
            classification: "internal",
          }),
        })
      )
      expect(ingestRes.status).toBe(200)
    })
  })

  it("persists and rehydrates entity/client registry data after in-memory reset", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const createOne = await clientsPost(
        new Request("http://127.0.0.1/api/d1/clients", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "4de4ff5f-1387-48a7-b0cc-af4e1f9a8d11",
          },
          body: JSON.stringify({
            action: "create",
            actorId: "partner_a",
            firmId: "firmA",
            canonicalName: "Persisted Entity A",
            cnic: "4220112345601",
            phone: "+923001110001",
            classification: "internal",
          }),
        })
      )
      expect(createOne.status).toBe(200)
      const createOneJson = (await createOne.json()) as {
        result: { entity: { id: string } }
      }

      const createTwo = await clientsPost(
        new Request("http://127.0.0.1/api/d1/clients", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "87d4f9aa-a0d2-48c1-9885-85881c1a2f47",
          },
          body: JSON.stringify({
            action: "create",
            actorId: "partner_a",
            firmId: "firmA",
            canonicalName: "Persisted Entity B",
            cnic: "4220112345601",
            phone: "+923001110002",
            classification: "internal",
          }),
        })
      )
      expect(createTwo.status).toBe(200)

      // Simulate a fresh cycle where in-memory entities and links are dropped.
      getRuntimeStore().entities = new Map()
      getRuntimeStore().links = []

      const listRes = await clientsGet(
        new Request("http://127.0.0.1/api/d1/clients?userId=associate_a&limit=10&cursor=0")
      )
      expect(listRes.status).toBe(200)
      const listJson = (await listRes.json()) as { items: Array<{ id: string }> }
      expect(listJson.items.some((item) => item.id === createOneJson.result.entity.id)).toBe(true)

      const conflictRes = await clientsPost(
        new Request("http://127.0.0.1/api/d1/clients", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "17bb9f7f-d3ec-4f0e-8b1f-194d974c9f45",
          },
          body: JSON.stringify({
            action: "conflict_check",
            actorId: "partner_a",
            firmId: "firmA",
            entityId: createOneJson.result.entity.id,
          }),
        })
      )
      expect(conflictRes.status).toBe(200)
      const conflictJson = (await conflictRes.json()) as {
        result: { result: { status: string; identityBasis?: string } }
      }
      expect(conflictJson.result.result.status).toBe("POSSIBLE_CANDIDATE_REVIEW")
      expect(conflictJson.result.result.identityBasis).toBe("cnic")

      const persistedEntities = await getDocs(collection(ctx.firestore(), "entities"))
      expect(
        persistedEntities.docs.some(
          (entry) => entry.data()?.id === createOneJson.result.entity.id && entry.data()?.firmId === "firmA"
        )
      ).toBe(true)
      const persistedLinks = await getDocs(collection(ctx.firestore(), "merge_events"))
      expect(
        persistedLinks.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.identityBasis === "cnic" &&
            entry.data()?.band === "confirmed-candidate"
        )
      ).toBe(true)
    })
  })

  it("persists matter/client search index rows and rehydrates reporting after reset", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())

      const clientCreate = await clientsPost(
        new Request("http://127.0.0.1/api/d1/clients", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f22a7038-fdbf-4976-b637-cb1ef4b15c47",
          },
          body: JSON.stringify({
            action: "create",
            actorId: "partner_a",
            firmId: "firmA",
            canonicalName: "Indexed Client",
            cnic: "4220112345619",
            phone: "+923001110019",
            classification: "internal",
          }),
        })
      )
      expect(clientCreate.status).toBe(200)

      const matterId = await createMatterViaRoute(
        "Indexed Matter Search Row",
        "f6a5f9cb-0efe-4f5e-8c65-17f9f7ac8aa0"
      )
      const privilegedMatter = await mattersPost(
        new Request("http://127.0.0.1/api/d1/matters", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8ca96f83-d575-4dae-bd80-b0a7ecdfe198",
          },
          body: JSON.stringify({
            action: "create",
            actorId: "partner_a",
            firmId: "firmA",
            clientId: "client_a",
            title: "Privileged Indexed Matter",
            courtId: "SHC",
            classification: "privileged",
          }),
        })
      )
      expect(privilegedMatter.status).toBe(200)

      getRuntimeStore().matterClientSearchIndex = new Map()

      const partnerList = await reportingGet(
        new Request("http://127.0.0.1/api/d1/reporting?actorId=partner_a&q=indexed&limit=20&cursor=0")
      )
      expect(partnerList.status).toBe(200)
      const partnerJson = (await partnerList.json()) as {
        items: Array<{ rowType: string; linkedMatterId: string | null; label: string }>
      }
      expect(partnerJson.items.some((row) => row.rowType === "client" && row.label === "Indexed Client")).toBe(
        true
      )
      expect(
        partnerJson.items.some((row) => row.rowType === "matter" && row.linkedMatterId === matterId)
      ).toBe(true)

      const clerkList = await reportingGet(
        new Request("http://127.0.0.1/api/d1/reporting?actorId=clerk_a&q=privileged&limit=20&cursor=0")
      )
      expect(clerkList.status).toBe(200)
      const clerkJson = (await clerkList.json()) as { total: number }
      expect(clerkJson.total).toBe(0)

      const persistedIndex = await getDocs(collection(ctx.firestore(), "matter_client_search_index"))
      expect(
        persistedIndex.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.rowType === "matter" &&
            entry.data()?.referenceId === matterId
        )
      ).toBe(true)
      expect(
        persistedIndex.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.rowType === "client" &&
            entry.data()?.label === "Indexed Client"
        )
      ).toBe(true)
    })
  })

  it("persists non-tenancy audit actions and rehydrates them through tenancy audit view", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted audit parity matter",
        "eb14e3d6-c2dc-4c38-8bc7-e97f6bc22009"
      )

      const ingestRes = await documentsPost(
        new Request("http://127.0.0.1/api/d1/documents", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "9a67f7a3-3e58-4ae6-b3ff-4af127d59f0a",
          },
          body: JSON.stringify({
            action: "ingest",
            actorId: "partner_a",
            firmId: "firmA",
            matterId,
            contentBase64: Buffer.from("%PDF-audit-parity%").toString("base64"),
            sourceChannel: "web",
            classification: "internal",
          }),
        })
      )
      expect(ingestRes.status).toBe(200)
      const ingestJson = (await ingestRes.json()) as { result: { doc: { id: string } } }

      const template = getDocumentTypes()[0]
      if (!template) throw new Error("missing template seed")
      const composeRes = await draftsPost(
        new Request("http://127.0.0.1/api/d4/drafts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "5936b7f9-5f28-40e1-bf43-b98dc4e4e47b",
          },
          body: JSON.stringify({
            action: "compose",
            actorId: "associate_a",
            matterId,
            templateId: template.id,
            title: "Audit parity draft",
            body: "Body",
            classification: "internal",
            citedJudgmentIds: [],
            temporalCitations: [],
          }),
        })
      )
      expect(composeRes.status).toBe(200)
      const composeJson = (await composeRes.json()) as { result: { draft: { id: string } } }

      const createPkgRes = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f91fd182-2edf-42f2-abdb-7550fb9a58bf",
          },
          body: JSON.stringify({
            action: "create_package",
            actorId: "associate_a",
            matterId,
            draftId: composeJson.result.draft.id,
            classification: "internal",
            citedJudgmentIds: [],
            temporalCitations: [],
          }),
        })
      )
      expect(createPkgRes.status).toBe(200)

      const caseRejectRes = await mattersPost(
        new Request("http://127.0.0.1/api/d1/matters", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "832e2b95-5f33-4744-af4f-f393d4ca95c4",
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
      expect(caseRejectRes.status).toBe(200)

      const queueRes = await courtOpsGet(
        new Request(
          `http://127.0.0.1/api/d2/court-ops?userId=associate_a&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(queueRes.status).toBe(200)
      const queueJson = (await queueRes.json()) as {
        items: Array<{ queueType: string; id: string }>
      }
      const followUpItem = queueJson.items.find((item) => item.queueType === "follow_up")
      if (!followUpItem) throw new Error("expected follow_up queue item")

      const resolveRes = await courtOpsPost(
        new Request("http://127.0.0.1/api/d2/court-ops", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c5ddcfcb-8538-4be0-ba90-11c0de5c8f42",
          },
          body: JSON.stringify({
            action: "resolve_follow_up",
            actorId: "partner_a",
            followUpId: followUpItem.id,
            reason: "Audit parity resolution",
          }),
        })
      )
      expect(resolveRes.status).toBe(200)

      // Simulate fresh runtime cycle without in-memory audit cache.
      getRuntimeStore().audit = []
      const auditViewRes = await tenancyGet(
        new Request(
          "http://127.0.0.1/api/p5/tenancy?view=audit&actorId=partner_a&firmId=firmA&limit=100&cursor=0"
        )
      )
      expect(auditViewRes.status).toBe(200)
      const auditJson = (await auditViewRes.json()) as {
        items: Array<{ action: string; target: string }>
      }
      const actions = new Set(auditJson.items.map((row) => row.action))
      expect(actions.has("matter_create")).toBe(true)
      expect(actions.has("document_ingest")).toBe(true)
      expect(actions.has("draft_compose")).toBe(true)
      expect(actions.has("filing_package_create")).toBe(true)
      expect(actions.has("court_ops_resolve_follow_up")).toBe(true)

      const persistedAudit = await getDocs(collection(ctx.firestore(), "audit_log"))
      expect(
        persistedAudit.docs.some(
          (entry) =>
            entry.data()?.action === "document_ingest" &&
            entry.data()?.target === ingestJson.result.doc.id &&
            entry.data()?.firmId === "firmA"
        )
      ).toBe(true)
    })
  })

  it("persists committee-brain outputs and rehydrates listing after in-memory reset", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const first = await committeePost(
        new Request("http://127.0.0.1/api/p1/committee-brain", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b1fca58a-f8e1-4d5d-856b-a7e5c65db4ca",
          },
          body: JSON.stringify({
            actorId: "partner_a",
            body: "Partner committee summary",
            classification: "privileged",
            purpose: "committee-brain",
          }),
        })
      )
      expect(first.status).toBe(200)

      const second = await committeePost(
        new Request("http://127.0.0.1/api/p1/committee-brain", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "4e53441b-40bb-4f43-9b6c-9f6f3f90f28f",
          },
          body: JSON.stringify({
            actorId: "associate_a",
            body: "Associate committee summary",
            classification: "internal",
            purpose: "summarise",
          }),
        })
      )
      expect(second.status).toBe(200)

      // Simulate stateless request cycle.
      getRuntimeStore().committeeOutputs = new Map()

      const partnerList = await committeeGet(
        new Request("http://127.0.0.1/api/p1/committee-brain?actorId=partner_a&limit=10&cursor=0")
      )
      expect(partnerList.status).toBe(200)
      const partnerJson = (await partnerList.json()) as {
        items: Array<{ id: string; classification: string }>
        total: number
      }
      expect(partnerJson.total).toBe(2)
      expect(partnerJson.items.some((row) => row.classification === "privileged")).toBe(true)

      const clerkList = await committeeGet(
        new Request("http://127.0.0.1/api/p1/committee-brain?actorId=clerk_a&limit=10&cursor=0")
      )
      expect(clerkList.status).toBe(200)
      const clerkJson = (await clerkList.json()) as {
        items: Array<{ classification: string }>
        total: number
      }
      expect(clerkJson.total).toBe(1)
      expect(clerkJson.items[0]?.classification).toBe("internal")

      const persisted = await getDocs(collection(ctx.firestore(), "committee_outputs"))
      expect(
        persisted.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.actorId === "partner_a" &&
            entry.data()?.classification === "privileged"
        )
      ).toBe(true)
    })
  })

  it("hydrates tenancy membership, roles, and audit views from persisted repositories after reset", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      const matterId = await createMatterViaRoute(
        "Persisted tenancy membership matter",
        "fdccf93b-c5d5-43fe-9445-3573b526c5a6"
      )

      const roleUpdate = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "76804e1d-bce0-412a-8524-c7eb27dfaec3",
          },
          body: JSON.stringify({
            action: "update_role",
            actorId: "partner_a",
            firmId: "firmA",
            targetUserId: "clerk_a",
            nextRole: "clerk",
            nextClearance: "internal",
            reason: "Tenancy parity persistence check",
          }),
        })
      )
      expect(roleUpdate.status).toBe(200)

      // Simulate a fresh cycle with stale in-memory role + memberships.
      const staleUser = getRuntimeStore().users.get("clerk_a")
      if (!staleUser) throw new Error("expected clerk seed")
      getRuntimeStore().users.set("clerk_a", {
        ...staleUser,
        role: "clerk",
        clearanceLevel: "confidential",
      })
      getRuntimeStore().members = new Map()
      getRuntimeStore().audit = []

      const sessionRes = await tenancyGet(
        new Request("http://127.0.0.1/api/p5/tenancy?view=session&userId=associate_a&firmId=firmA")
      )
      expect(sessionRes.status).toBe(200)
      const sessionJson = (await sessionRes.json()) as {
        session: { accessibleMatterIds: string[] }
      }
      expect(sessionJson.session.accessibleMatterIds).toContain(matterId)

      const usersRes = await tenancyGet(
        new Request(
          "http://127.0.0.1/api/p5/tenancy?view=users&actorId=partner_a&firmId=firmA&limit=10&cursor=0"
        )
      )
      expect(usersRes.status).toBe(200)
      const usersJson = (await usersRes.json()) as {
        items: Array<{ id: string; clearanceLevel: string }>
      }
      const clerk = usersJson.items.find((row) => row.id === "clerk_a")
      expect(clerk?.clearanceLevel).toBe("internal")

      const membershipsRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=memberships&actorId=partner_a&firmId=firmA&matterId=${matterId}&limit=10&cursor=0`
        )
      )
      expect(membershipsRes.status).toBe(200)
      const membershipsJson = (await membershipsRes.json()) as {
        items: Array<{ matterId: string; userId: string }>
      }
      expect(
        membershipsJson.items.some(
          (row) => row.matterId === matterId && row.userId === "associate_a"
        )
      ).toBe(true)

      const auditRes = await tenancyGet(
        new Request(
          "http://127.0.0.1/api/p5/tenancy?view=audit&actorId=partner_a&firmId=firmA&limit=10&cursor=0"
        )
      )
      expect(auditRes.status).toBe(200)
      const auditJson = (await auditRes.json()) as {
        items: Array<{ action: string; target: string }>
      }
      expect(
        auditJson.items.some(
          (row) => row.action === "tenant_update_role" && row.target === "clerk_a"
        )
      ).toBe(true)

      const persistedClerk = await getDoc(doc(ctx.firestore(), "users", "clerk_a"))
      expect(persistedClerk.exists()).toBe(true)
      expect(persistedClerk.data()?.clearanceLevel).toBe("internal")

      const persistedAudit = await getDocs(collection(ctx.firestore(), "audit_log"))
      expect(
        persistedAudit.docs.some(
          (entry) =>
            entry.data()?.action === "tenant_update_role" &&
            entry.data()?.target === "clerk_a" &&
            entry.data()?.firmId === "firmA"
        )
      ).toBe(true)
    })
  })
})
