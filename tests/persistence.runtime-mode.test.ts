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
})
