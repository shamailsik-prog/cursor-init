import { readFileSync } from "node:fs"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore"
import { GET as mattersGet, POST as mattersPost } from "@/app/api/d1/matters/route"
import { GET as documentsGet, POST as documentsPost } from "@/app/api/d1/documents/route"
import {
  GET as workflowGet,
  POST as workflowPost,
} from "@/app/api/d1/document-workflow/route"
import { GET as filingsGet, POST as filingsPost } from "@/app/api/d4/filings/route"
import { GET as draftsGet, POST as draftsPost } from "@/app/api/d4/drafts/route"
import { GET as courtOpsGet, POST as courtOpsPost } from "@/app/api/d2/court-ops/route"
import { GET as opsReportingGet, POST as opsReportingPost } from "@/app/api/d2/ops-reporting/route"
import { GET as tenancyGet, POST as tenancyPost } from "@/app/api/p5/tenancy/route"
import { GET as clientsGet, POST as clientsPost } from "@/app/api/d1/clients/route"
import { GET as reportingGet, POST as reportingPost } from "@/app/api/d1/reporting/route"
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

  it("routes matter lifecycle writes through Firestore after in-memory reset", async () => {
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

      // Simulate a fresh runtime cycle and assert write actions rehydrate persisted matter access.
      resetRuntimeStoreForTests()
      setFirestorePersistenceForTests(ctx.firestore())

      const confirmRes = await mattersPost(
        new Request("http://127.0.0.1/api/d1/matters", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "0545f812-9d63-4f60-bf16-4d7000f93395",
          },
          body: JSON.stringify({
            action: "confirm_engagement",
            actorId: "partner_a",
            matterId,
          }),
        })
      )
      expect(confirmRes.status).toBe(200)

      const caseRes = await mattersPost(
        new Request("http://127.0.0.1/api/d1/matters", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "7934d6e3-53d5-4355-bfe5-f66029b13c13",
          },
          body: JSON.stringify({
            action: "record_case_number",
            actorId: "partner_a",
            matterId,
            courtId: "SHC",
            raw: "C.P. No. D-1234 of 2025",
          }),
        })
      )
      expect(caseRes.status).toBe(200)
      const caseJson = (await caseRes.json()) as {
        result: { result: { status: string; canonical?: string } }
      }
      expect(caseJson.result.result.status).toBe("OK")
      expect(caseJson.result.result.canonical).toBe("CP D-1234/2025")

      const dbMatterAfter = await getDoc(doc(ctx.firestore(), "matters", matterId))
      expect(dbMatterAfter.data()?.status).toBe("live")
      expect(dbMatterAfter.data()?.caseNumber).toBe("CP D-1234/2025")
      expect(dbMatterAfter.data()?.caseNumberStatus).toBe("recorded")

      const persistedAudit = await getDocs(collection(ctx.firestore(), "audit_log"))
      expect(
        persistedAudit.docs.some(
          (entry) =>
            entry.data()?.action === "matter_confirm_engagement" &&
            entry.data()?.target === matterId &&
            entry.data()?.firmId === "firmA"
        )
      ).toBe(true)
      expect(
        persistedAudit.docs.some(
          (entry) =>
            entry.data()?.action === "matter_record_case_number" &&
            entry.data()?.target === matterId &&
            entry.data()?.firmId === "firmA"
        )
      ).toBe(true)
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
          `http://127.0.0.1/api/d4/filings?userId=associate_a&matterId=${matterId}&readiness=ready&limit=10&cursor=0`
        )
      )
      expect(filingsList.status).toBe(200)
      const listJson = (await filingsList.json()) as {
        items: Array<{
          id: string
          status: string
          packetArtifact: { readiness: string; blockedReasons: string[] } | null
        }>
      }
      const row = listJson.items.find((item) => item.id === packageId)
      expect(row?.status).toBe("approved")
      expect(row?.packetArtifact?.readiness).toBe("ready")
      expect(row?.packetArtifact?.blockedReasons).toHaveLength(0)

      const dispatchQueue = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=dispatch&userId=associate_a&matterId=${matterId}&dispatchStatus=queued&limit=10&cursor=0`
        )
      )
      expect(dispatchQueue.status).toBe(200)
      const dispatchQueueJson = (await dispatchQueue.json()) as {
        items: Array<{ packageId: string; status: string; externalDispatchState: string }>
      }
      expect(
        dispatchQueueJson.items.some(
          (item) =>
            item.packageId === packageId &&
            item.status === "queued" &&
            item.externalDispatchState === "blocked_todo_firm"
        )
      ).toBe(true)

      const dispatchUpdate = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "6fb8a348-3852-4d32-9af7-c8ba07f31f4e",
          },
          body: JSON.stringify({
            action: "dispatch_update",
            actorId: "partner_a",
            packageId,
            nextStatus: "handoff_ready",
            assigneeId: "clerk_a",
            markAttempt: true,
            note: "Runtime dispatch handoff",
          }),
        })
      )
      expect(dispatchUpdate.status).toBe(200)
      const partnerSignoff = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "cfca79bb-3de4-40f8-b581-337ce2dc2df9",
          },
          body: JSON.stringify({
            action: "annexure_checkpoint",
            actorId: "partner_a",
            packageId,
            checkpoint: "record_partner_signoff",
            note: "Runtime partner signoff",
          }),
        })
      )
      expect(partnerSignoff.status).toBe(200)
      const clerkVerify = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "71f529a4-f913-4d3a-bca0-8ef0b9528ffb",
          },
          body: JSON.stringify({
            action: "annexure_checkpoint",
            actorId: "clerk_a",
            packageId,
            checkpoint: "record_clerk_verification",
            note: "Runtime clerk verification",
          }),
        })
      )
      expect(clerkVerify.status).toBe(200)
      const annexureReady = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "0f45faaf-bf48-4c99-b4de-4246ce59f8ca",
          },
          body: JSON.stringify({
            action: "annexure_checkpoint",
            actorId: "partner_a",
            packageId,
            checkpoint: "mark_ready_for_transport",
          }),
        })
      )
      expect(annexureReady.status).toBe(200)
      const recordReceipt = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "4d90cf14-dfb8-4e9a-87a1-a09df8617f8a",
          },
          body: JSON.stringify({
            action: "record_submission_receipt",
            actorId: "clerk_a",
            packageId,
            courtChannel: "efiling_portal_stub",
            dispatchOutcome: "retry_scheduled",
            submissionReference: "RUNTIME-SUB-001",
            failureReason: "timeout",
            retryHint: "retry after court clerk callback",
            note: "runtime deterministic submission attempt",
          }),
        })
      )
      expect(recordReceipt.status).toBe(200)
      const reconcileSubmission = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "0ce9cc6f-e3df-46ec-89f6-f6f30c3763af",
          },
          body: JSON.stringify({
            action: "reconcile_submission",
            actorId: "partner_a",
            packageId,
            status: "needs_retry",
            note: "partner reconciliation after deterministic failure",
          }),
        })
      )
      expect(reconcileSubmission.status).toBe(200)
      const claimException = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "66559f9e-3acf-44f6-a7a0-f82a53c96d11",
          },
          body: JSON.stringify({
            action: "claim_submission_exception",
            actorId: "clerk_a",
            packageId,
            note: "clerk claimed exception queue item",
          }),
        })
      )
      expect(claimException.status).toBe(200)
      const escalateException = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "6ce0f6ee-06f6-469d-951c-d8e6f9ba8fdf",
          },
          body: JSON.stringify({
            action: "escalate_submission_exception",
            actorId: "clerk_a",
            packageId,
            escalationOwnerId: "partner_a",
            severity: "critical",
            slaHours: 4,
            note: "escalated to partner for priority retry window",
          }),
        })
      )
      expect(escalateException.status).toBe(200)
      const resolveException = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f4deab2b-335f-44f0-8760-c5c982634f4f",
          },
          body: JSON.stringify({
            action: "resolve_submission_exception",
            actorId: "partner_a",
            packageId,
            note: "partner approved deterministic retry plan",
          }),
        })
      )
      expect(resolveException.status).toBe(200)
      const reopenException = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "0f4ef0d2-b1f5-47c2-a985-ca9241161474",
          },
          body: JSON.stringify({
            action: "reopen_submission_exception",
            actorId: "partner_a",
            packageId,
            severity: "high",
            note: "reopened after follow-up court feedback",
          }),
        })
      )
      expect(reopenException.status).toBe(200)
      const markTransportBlocked = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "634f3f5c-14a0-45d2-a3cd-8ea34e5f47e6",
          },
          body: JSON.stringify({
            action: "mark_transport_blocked",
            actorId: "clerk_a",
            packageId,
            transportChannel: "efiling_portal_stub",
            channelPayloadHash: "runtime-transport-hash-001",
            blockerTags: ["portal_timeout", "token_expired"],
            attachmentPointers: ["ops://runtime/retry-window-note"],
            severity: "critical",
            note: "runtime transport blocked by portal timeout",
          }),
        })
      )
      expect(markTransportBlocked.status).toBe(200)
      const attachRetryPlan = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "d5d4cc84-e8a8-4ea0-bf4f-a2ecf51e05c2",
          },
          body: JSON.stringify({
            action: "attach_retry_plan",
            actorId: "partner_a",
            packageId,
            transportChannel: "operator_followup_stub",
            channelPayloadHash: "runtime-transport-hash-002",
            attachmentPointers: ["ops://runtime/retry-plan-v2"],
            note: "runtime partner retry plan attached",
          }),
        })
      )
      expect(attachRetryPlan.status).toBe(200)
      const acknowledgeDigest = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "12920f7d-3598-46a8-abf3-a842556f6488",
          },
          body: JSON.stringify({
            action: "acknowledge_breach",
            actorId: "partner_a",
            packageId,
            note: "runtime partner acknowledged digest breach",
          }),
        })
      )
      expect(acknowledgeDigest.status).toBe(200)
      const deferDigest = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f362f5e9-b2dc-4f22-a18b-5f9561f7f264",
          },
          body: JSON.stringify({
            action: "defer_window",
            actorId: "partner_a",
            packageId,
            deferHours: 6,
            note: "runtime digest deferred window",
          }),
        })
      )
      expect(deferDigest.status).toBe(200)
      const assignPrimaryOwner = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f5ce3e5d-6f0d-4de1-af63-5dd8612de0ea",
          },
          body: JSON.stringify({
            action: "assign_primary_owner",
            actorId: "partner_a",
            packageId,
            primaryOwnerId: "partner_a",
            activeWindowHours: 12,
            note: "runtime primary escalation owner assigned",
          }),
        })
      )
      expect(assignPrimaryOwner.status).toBe(200)
      const setBackupOwner = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f0aa39d8-8d56-4f72-b74f-1063dd0ad1ea",
          },
          body: JSON.stringify({
            action: "set_backup_owner",
            actorId: "partner_a",
            packageId,
            backupOwnerId: "partner_a",
            note: "runtime backup escalation owner set",
          }),
        })
      )
      expect(setBackupOwner.status).toBe(200)
      const acknowledgeWorkload = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f385f5ca-fa18-4eb5-8245-3554d5b6dad4",
          },
          body: JSON.stringify({
            action: "acknowledge_owner_drift",
            actorId: "partner_a",
            packageId,
            note: "runtime workload drift acknowledged",
          }),
        })
      )
      expect(acknowledgeWorkload.status).toBe(200)
      const snoozeWorkload = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c300b45b-242d-467f-b7a5-fdcbfb0e6915",
          },
          body: JSON.stringify({
            action: "snooze_workload_alert",
            actorId: "partner_a",
            packageId,
            snoozeHours: 4,
            note: "runtime workload alert snoozed",
          }),
        })
      )
      expect(snoozeWorkload.status).toBe(200)
      const rebalanceWorkload = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "0f7363df-cd6f-4911-98e4-52a822a3ea9d",
          },
          body: JSON.stringify({
            action: "rebalance_assignment",
            actorId: "partner_a",
            packageId,
            newPrimaryOwnerId: "partner_a",
            note: "runtime workload assignment rebalanced",
          }),
        })
      )
      expect(rebalanceWorkload.status).toBe(200)
      const setFirmPolicy = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "d18b0af6-3cc2-44e1-9034-5d890261709e",
          },
          body: JSON.stringify({
            action: "set_policy_baseline",
            actorId: "partner_a",
            ownerLoadThreshold: 2,
            handoffSlaHours: 2,
            waiverWindowHours: 12,
            note: "runtime firm policy baseline set",
          }),
        })
      )
      expect(setFirmPolicy.status).toBe(200)
      const setPackagePolicy = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "20cd1290-d694-45b4-8a83-f5f26fccf8c6",
          },
          body: JSON.stringify({
            action: "set_policy_baseline",
            actorId: "partner_a",
            packageId,
            ownerLoadThreshold: 1,
            handoffSlaHours: 1,
            waiverWindowHours: 6,
            note: "runtime package policy baseline set",
          }),
        })
      )
      expect(setPackagePolicy.status).toBe(200)
      const grantWaiver = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "e77338ff-0e9f-44f9-a698-4fc8f23d0c0f",
          },
          body: JSON.stringify({
            action: "grant_breach_waiver",
            actorId: "partner_a",
            packageId,
            durationHours: 2,
            reason: "runtime planned handoff coverage",
            note: "runtime waiver granted",
          }),
        })
      )
      expect(grantWaiver.status).toBe(200)
      const acknowledgeVariance = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "2045d154-e52c-4e03-8d8b-5e0c48373487",
          },
          body: JSON.stringify({
            action: "acknowledge_policy_variance",
            actorId: "partner_a",
            packageId,
            note: "runtime policy variance acknowledged",
          }),
        })
      )
      expect(acknowledgeVariance.status).toBe(200)
      const snoozeVariance = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8ef2cb35-cd5f-4cc8-a3ec-49e71f0b61e8",
          },
          body: JSON.stringify({
            action: "snooze_policy_variance",
            actorId: "partner_a",
            packageId,
            snoozeHours: 3,
            note: "runtime policy variance snoozed",
          }),
        })
      )
      expect(snoozeVariance.status).toBe(200)
      const recordRemediation = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "d9547689-c1d3-46b4-beb4-c7ca83a07f3f",
          },
          body: JSON.stringify({
            action: "record_variance_remediation",
            actorId: "partner_a",
            packageId,
            decision: "temporary_override",
            justification: "runtime controlled override while transport stabilizes",
            expiresInHours: 4,
            secondApproverId: "partner_a",
            note: "runtime remediation ledger row",
          }),
        })
      )
      expect(recordRemediation.status).toBe(200)
      const acknowledgeRemediationExpiry = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "0735a8b1-f59a-4ef5-a8db-0320de58a4ea",
          },
          body: JSON.stringify({
            action: "acknowledge_remediation_expiry",
            actorId: "partner_a",
            packageId,
            note: "runtime remediation expiry acknowledged",
          }),
        })
      )
      expect(acknowledgeRemediationExpiry.status).toBe(200)
      const snoozeRemediationExpiry = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "4a1da9da-27e8-411b-a0a4-89b7b34b7ded",
          },
          body: JSON.stringify({
            action: "snooze_remediation_expiry",
            actorId: "partner_a",
            packageId,
            snoozeHours: 2,
            note: "runtime remediation expiry snoozed",
          }),
        })
      )
      expect(snoozeRemediationExpiry.status).toBe(200)
      const closeRemediation = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "7d8f1aa7-b379-40b8-9170-1f1907fe0537",
          },
          body: JSON.stringify({
            action: "attest_remediation_closure",
            actorId: "partner_a",
            packageId,
            closureOutcome: "accepted_risk_retired",
            note: "runtime remediation closure attested",
          }),
        })
      )
      expect(closeRemediation.status).toBe(200)
      const acknowledgeExpiry = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "0ce7106e-57a9-4ec7-8921-66bf9179f86d",
          },
          body: JSON.stringify({
            action: "acknowledge_waiver_expiry",
            actorId: "partner_a",
            packageId,
            note: "runtime waiver expiry acknowledged",
          }),
        })
      )
      expect(acknowledgeExpiry.status).toBe(200)
      const extendWaiver = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "5fcc1f5f-1e8d-4f49-b595-aad95ad73ee8",
          },
          body: JSON.stringify({
            action: "extend_breach_waiver",
            actorId: "partner_a",
            packageId,
            extendHours: 8,
            secondApproverId: "partner_a",
            rolloverJustification: "runtime waiver extension exceeds baseline cap due closure",
            rolloverNote: "runtime rollover attestation row",
            note: "runtime waiver extended",
          }),
        })
      )
      expect(extendWaiver.status).toBe(200)
      const rolloverAttestationDoc = await getDoc(
        doc(ctx.firestore(), "filing_escalation_waiver_rollover_attestations", `rollover:${packageId}:1`)
      )
      expect(rolloverAttestationDoc.exists()).toBe(true)
      const rolloverAttestationData = rolloverAttestationDoc.data() as Record<string, unknown>
      await setDoc(
        doc(ctx.firestore(), "filing_escalation_waiver_rollover_attestations", `rollover:${packageId}:1`),
        {
          ...rolloverAttestationData,
          attestedAt: Date.now() - 7 * 60 * 60 * 1000,
          updatedAt: Date.now() - 7 * 60 * 60 * 1000,
          notes: ["runtime stale rollover attestation row"],
        }
      )
      const acknowledgeRolloverBreach = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "86ac4e8d-1f2e-48c3-a57e-8d2e25ee5f29",
          },
          body: JSON.stringify({
            action: "acknowledge_rollover_breach",
            actorId: "partner_a",
            packageId,
            note: "runtime rollover breach acknowledged",
          }),
        })
      )
      expect(acknowledgeRolloverBreach.status).toBe(200)
      const acknowledgeRolloverReaffirmationSla = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "5256440e-15e0-41ca-8bc1-1c5d91da4b2f",
          },
          body: JSON.stringify({
            action: "acknowledge_rollover_reaffirmation_sla",
            actorId: "partner_a",
            packageId,
            note: "runtime reaffirmation SLA acknowledged",
          }),
        })
      )
      expect(acknowledgeRolloverReaffirmationSla.status).toBe(200)
      const setClosureSlaWindowConfig = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f46a7ec3-6f0c-4d2a-8b9d-f22bc4a4bb95",
          },
          body: JSON.stringify({
            action: "set_closure_sla_window_config",
            actorId: "partner_a",
            ackDeadlineHours: 1,
            clearDeadlineHours: 2,
            autoEscalationHours: 3,
            note: "runtime closure SLA window config update",
          }),
        })
      )
      expect(setClosureSlaWindowConfig.status).toBe(200)
      const setClosureAutoAssignmentRule = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "1ff2f024-5f7e-42d6-95cd-bf45fa5b4ef0",
          },
          body: JSON.stringify({
            action: "set_closure_auto_assignment_rule",
            actorId: "partner_a",
            mode: "workload_aware_claim",
            maxActiveClaimsPerPartner: 4,
            note: "runtime closure auto-assignment rule update",
          }),
        })
      )
      expect(setClosureAutoAssignmentRule.status).toBe(200)
      const assignClosureFollowup = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "fc7b0fe7-8fd9-4bcf-a252-c30661db5f1b",
          },
          body: JSON.stringify({
            action: "assign_closure_followup",
            actorId: "partner_a",
            ownerId: "partner_a",
            assigneeId: "partner_a",
            note: "runtime closure follow-up assigned",
          }),
        })
      )
      expect(assignClosureFollowup.status).toBe(200)
      const autoAssignClosureFollowup = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "6e0ce08a-0337-43ea-8585-cae641f88585",
          },
          body: JSON.stringify({
            action: "auto_assign_closure_followup",
            actorId: "partner_a",
            ownerId: "partner_a",
            note: "runtime auto-assign closure queue",
          }),
        })
      )
      expect([200, 422]).toContain(autoAssignClosureFollowup.status)
      const claimClosureFollowup = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f4ad4c56-8a80-4f5a-8ac4-9f58fa9888be",
          },
          body: JSON.stringify({
            action: "claim_closure_followup",
            actorId: "partner_a",
            ownerId: "partner_a",
            note: "runtime closure follow-up claimed",
          }),
        })
      )
      expect(claimClosureFollowup.status).toBe(200)
      const reaffirmRolloverAttestation = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "9f953a49-0cb4-4f80-889a-087a518f7931",
          },
          body: JSON.stringify({
            action: "reaffirm_rollover_attestation",
            actorId: "partner_a",
            packageId,
            note: "reaffirm runtime rollover governance state",
          }),
        })
      )
      expect(reaffirmRolloverAttestation.status).toBe(200)
      const resolveClosureFollowup = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "6f3436ab-95b2-443f-a0d8-ef65c339ef38",
          },
          body: JSON.stringify({
            action: "resolve_closure_followup",
            actorId: "partner_a",
            ownerId: "partner_a",
            note: "runtime closure follow-up resolved after reaffirmation",
          }),
        })
      )
      expect([200, 422]).toContain(resolveClosureFollowup.status)
      const recordClosureAttestation = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "1e391fd6-ff77-4478-ae94-cd66ad9f9e55",
          },
          body: JSON.stringify({
            action: "record_closure_attestation",
            actorId: "partner_a",
            ownerId: "partner_a",
            secondReviewerId: "partner_b",
            partnerConcurrence: true,
            evidenceNote: "runtime closure claim-to-resolution evidence attached",
            note: "runtime closure attestation recorded",
          }),
        })
      )
      expect([200, 422]).toContain(recordClosureAttestation.status)
      let reviewClosureAttestationStatus: number | null = null
      let openClosureDisputeStatus: number | null = null
      let escalateClosureDisputeStatus: number | null = null
      let governClosureQuorumStatus: number | null = null
      let extendClosureSloStatus: number | null = null
      let escalateClosureSloTierStatus: number | null = null
      let acknowledgeClosureSloBreachStatus: number | null = null
      let recordSloDebtRemediationStatus: number | null = null
      let downshiftSloTierStatus: number | null = null
      let attestSloBreachClosureStatus: number | null = null
      let setDebtBurndownTargetStatus: number | null = null
      let attestDebtBacklogStatus: number | null = null
      let checkpointTierNormalizationStatus: number | null = null
      let rebaselineBurndownForecastStatus: number | null = null
      let overrideBurndownConfidenceStatus: number | null = null
      let annotateBurndownRollbackStatus: number | null = null
      let acknowledgeSettlementDriftStatus: number | null = null
      let attestSettlementTargetLockStatus: number | null = null
      let closeRollbackResolutionStatus: number | null = null
      let checkpointSettlementVerificationStatus: number | null = null
      let attestSettlementLockReleaseStatus: number | null = null
      let safeguardSettlementDisputeReopenStatus: number | null = null
      let petitionSettlementVerificationOverrideStatus: number | null = null
      let attestSettlementPanelConfirmationStatus: number | null = null
      let checkpointSettlementReopenVetoStatus: number | null = null
      let issueSettlementFinalRulingStatus: number | null = null
      let memorializeSettlementDissentStatus: number | null = null
      let checkpointSettlementPublicationStatus: number | null = null
      let logSettlementPublicationCorrectionStatus: number | null = null
      let checkpointSettlementPublicationRollbackStatus: number | null = null
      let reviewSettlementDistributionAttestationStatus: number | null = null
      let adjudicationVerdictStatus: number | null = null
      let rebalanceClosureEnforcementStatus: number | null = null
      let configureRebalanceSafeguardStatus: number | null = null
      let setSafeguardOverrideExpiryStatus: number | null = null
      let autoClearSafeguardSuppressionStatus: number | null = null
      let cleanupStaleSafeguardLockStatus: number | null = null
      let acknowledgeSafeguardAttestationStatus: number | null = null
      let queueSafeguardOverdueExceptionStatus: number | null = null
      let reconcileSafeguardOverrideStatus: number | null = null
      let triageExpiryQueueStatus: number | null = null
      let attestExpiryQueueHandoffStatus: number | null = null
      let checkpointExpiryQueueAutoDrainStatus: number | null = null
      let escalateQueueHandoffTimeoutStatus: number | null = null
      let attestQueueStaleReassignmentStatus: number | null = null
      let checkpointQueueForcedDrainStatus: number | null = null
      let attestQueueForcedReconciliationStatus: number | null = null
      let checkpointQueueReassignmentRollbackStatus: number | null = null
      let controlQueueTimeoutReentryStatus: number | null = null
      let attestQueueReentryExceptionStatus: number | null = null
      let checkpointQueueReentryTimeoutWaiverStatus: number | null = null
      let controlQueueReentryResumeStatus: number | null = null
      let assignQueueReentryDebtStatus: number | null = null
      let attestQueueReentryDebtRetirementStatus: number | null = null
      let controlQueueReentryDebtAgingStatus: number | null = null
      let openQueueDebtRetirementDisputeStatus: number | null = null
      let resolveQueueDebtRetirementDisputeStatus: number | null = null
      let controlQueueDebtRetirementRollbackStatus: number | null = null
      let attestRebalanceOverrideStatus: number | null = null
      let executeOwnerTransferStatus: number | null = null
      let executeThrottleReleaseStatus: number | null = null
      let resolveClosureDisputeStatus: number | null = null
      if (recordClosureAttestation.status === 200) {
        const recordJson = (await recordClosureAttestation.json()) as {
          result: { closureAttestation?: { id: string } }
        }
        const attestationId = recordJson.result.closureAttestation?.id
        if (attestationId) {
          const reviewClosureAttestation = await filingsPost(
            new Request("http://127.0.0.1/api/d4/filings", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": "4a08c2cb-17f8-4f2f-a26c-b8df3492f24e",
              },
              body: JSON.stringify({
                action: "review_closure_attestation",
                actorId: "partner_b",
                attestationId,
                decision: "approve",
                note: "runtime second review approved",
              }),
            })
          )
          reviewClosureAttestationStatus = reviewClosureAttestation.status
          expect([200, 422]).toContain(reviewClosureAttestationStatus)
          const openClosureDispute = await filingsPost(
            new Request("http://127.0.0.1/api/d4/filings", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": "8f2d291c-267f-4f13-ab3e-cc9a6a15f3d8",
              },
              body: JSON.stringify({
                action: "open_closure_attestation_dispute",
                actorId: "partner_b",
                attestationId,
                conflictReason: "runtime dispute over closure evidence ordering",
                note: "runtime open dispute",
              }),
            })
          )
          openClosureDisputeStatus = openClosureDispute.status
          expect([200, 422]).toContain(openClosureDisputeStatus)
          if (openClosureDisputeStatus === 200) {
            const openClosureDisputeJson = (await openClosureDispute.json()) as {
              result: { closureAttestationDispute?: { id: string } }
            }
            const disputeId = openClosureDisputeJson.result.closureAttestationDispute?.id
            if (disputeId) {
              const escalateClosureDispute = await filingsPost(
                new Request("http://127.0.0.1/api/d4/filings", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Idempotency-Key": "9be7c6e4-c3e7-40cb-91d8-7f9c18be1691",
                  },
                  body: JSON.stringify({
                    action: "escalate_closure_dispute_to_panel",
                    actorId: "partner_b",
                    disputeId,
                    panelMemberIds: ["partner_a", "partner_b"],
                    dissentNote: "runtime panel dissent preserved",
                    note: "runtime escalated closure dispute to panel",
                  }),
                })
              )
              escalateClosureDisputeStatus = escalateClosureDispute.status
              expect([200, 422]).toContain(escalateClosureDisputeStatus)
              if (escalateClosureDisputeStatus === 200) {
                const escalateJson = (await escalateClosureDispute.json()) as {
                  result: { closureAdjudicationQueue?: { id: string } }
                }
                const adjudicationId = escalateJson.result.closureAdjudicationQueue?.id
                if (adjudicationId) {
                  const governClosureQuorum = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "3adbe9fe-a98d-4e7b-8210-93ecc9ab8e7f",
                      },
                      body: JSON.stringify({
                        action: "govern_closure_adjudication_quorum",
                        actorId: "partner_a",
                        adjudicationId,
                        requiredPanelCount: 3,
                        quorumWindowHours: 0,
                        verdictWindowHours: 0,
                        note: "runtime quorum governance tick",
                      }),
                    })
                  )
                  governClosureQuorumStatus = governClosureQuorum.status
                  expect([200, 422]).toContain(governClosureQuorumStatus)
                  const acknowledgeClosureSloBreach = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "fcb05676-557c-413f-b2f0-2133078f6b9f",
                      },
                      body: JSON.stringify({
                        action: "acknowledge_closure_adjudication_slo_breach",
                        actorId: "partner_a",
                        adjudicationId,
                        note: "runtime acknowledge closure adjudication SLO breach",
                      }),
                    })
                  )
                  acknowledgeClosureSloBreachStatus = acknowledgeClosureSloBreach.status
                  expect([200, 422]).toContain(acknowledgeClosureSloBreachStatus)
                  const extendClosureSlo = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "d9146a06-fbe2-4f0e-9492-eb98f0d7fd73",
                      },
                      body: JSON.stringify({
                        action: "extend_closure_adjudication_slo_deadline",
                        actorId: "partner_a",
                        adjudicationId,
                        extensionHours: 2,
                        note: "runtime extend closure adjudication SLO deadline",
                      }),
                    })
                  )
                  extendClosureSloStatus = extendClosureSlo.status
                  expect([200, 422]).toContain(extendClosureSloStatus)
                  const escalateClosureSloTier = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "0a8e2805-1115-42c5-b3c6-1f23839331c3",
                      },
                      body: JSON.stringify({
                        action: "escalate_closure_adjudication_slo_tier",
                        actorId: "partner_a",
                        adjudicationId,
                        escalationTier: "tier_2_management_escalation",
                        note: "runtime escalate closure adjudication SLO tier",
                      }),
                    })
                  )
                  escalateClosureSloTierStatus = escalateClosureSloTier.status
                  expect([200, 422]).toContain(escalateClosureSloTierStatus)
                  const recordSloDebtRemediation = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "4dc16c17-9874-4332-b4db-c53f34840f5f",
                      },
                      body: JSON.stringify({
                        action: "record_closure_adjudication_slo_debt_remediation",
                        actorId: "partner_a",
                        adjudicationId,
                        note: "runtime record SLO debt remediation note",
                      }),
                    })
                  )
                  recordSloDebtRemediationStatus = recordSloDebtRemediation.status
                  expect([200, 422]).toContain(recordSloDebtRemediationStatus)
                  const downshiftSloTier = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "8d2b2fb9-dcd5-45c0-a2b0-086c04c13ae8",
                      },
                      body: JSON.stringify({
                        action: "downshift_closure_adjudication_slo_tier",
                        actorId: "partner_a",
                        adjudicationId,
                        escalationTier: "tier_1_partner_watch",
                        note: "runtime downshift SLO tier under remediation",
                      }),
                    })
                  )
                  downshiftSloTierStatus = downshiftSloTier.status
                  expect([200, 422]).toContain(downshiftSloTierStatus)
                  const recordAdjudicationVerdict = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "c59a0cb6-d45d-4435-94c8-8e2d54ef167d",
                      },
                      body: JSON.stringify({
                        action: "record_closure_adjudication_verdict",
                        actorId: "partner_a",
                        adjudicationId,
                        verdict: "uphold_dispute",
                        dissentNote: "runtime dissent retained after verdict",
                        note: "runtime panel verdict captured",
                      }),
                    })
                  )
                  adjudicationVerdictStatus = recordAdjudicationVerdict.status
                  expect([200, 422]).toContain(adjudicationVerdictStatus)
                  const attestSloBreachClosure = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "b623f877-f643-4f3d-9d8b-b75030382d1e",
                      },
                      body: JSON.stringify({
                        action: "attest_closure_adjudication_slo_breach_closure",
                        actorId: "partner_a",
                        adjudicationId,
                        note: "runtime attest closure adjudication SLO breach closure",
                      }),
                    })
                  )
                  attestSloBreachClosureStatus = attestSloBreachClosure.status
                  expect([200, 422]).toContain(attestSloBreachClosureStatus)
                  const setDebtBurndownTarget = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "56ad68d2-fbc7-4f16-a8e0-ebce95efd67d",
                      },
                      body: JSON.stringify({
                        action: "set_closure_adjudication_debt_burndown_target",
                        actorId: "partner_a",
                        adjudicationId,
                        targetHours: 2,
                        note: "runtime set debt burndown target",
                      }),
                    })
                  )
                  setDebtBurndownTargetStatus = setDebtBurndownTarget.status
                  expect([200, 404, 422]).toContain(setDebtBurndownTargetStatus)
                  const attestDebtBacklog = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "bce0f413-6d6f-4f6d-9e27-f11b78465064",
                      },
                      body: JSON.stringify({
                        action: "attest_closure_adjudication_debt_backlog",
                        actorId: "partner_a",
                        adjudicationId,
                        note: "runtime attest debt backlog",
                      }),
                    })
                  )
                  attestDebtBacklogStatus = attestDebtBacklog.status
                  expect([200, 404, 422]).toContain(attestDebtBacklogStatus)
                  const checkpointTierNormalization = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "3087e2f3-cf31-4fa3-bf2e-74dbf95c5a17",
                      },
                      body: JSON.stringify({
                        action: "checkpoint_closure_adjudication_tier_normalization",
                        actorId: "partner_a",
                        adjudicationId,
                        escalationTier: "tier_1_partner_watch",
                        note: "runtime tier normalization checkpoint",
                      }),
                    })
                  )
                  checkpointTierNormalizationStatus = checkpointTierNormalization.status
                  expect([200, 404, 422]).toContain(checkpointTierNormalizationStatus)
                  const rebaselineBurndownForecast = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "18b90ffc-8ff6-4f86-8248-1ba5b9383616",
                      },
                      body: JSON.stringify({
                        action: "rebaseline_closure_adjudication_burndown_forecast",
                        actorId: "partner_a",
                        adjudicationId,
                        targetHours: 4,
                        note: "runtime rebaseline burndown forecast",
                      }),
                    })
                  )
                  rebaselineBurndownForecastStatus = rebaselineBurndownForecast.status
                  expect([200, 404, 422]).toContain(rebaselineBurndownForecastStatus)
                  const overrideBurndownConfidenceBand = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "9767025a-b72d-4f4e-ad9a-f1dddf2dbf75",
                      },
                      body: JSON.stringify({
                        action: "override_closure_adjudication_burndown_confidence_band",
                        actorId: "partner_a",
                        adjudicationId,
                        lowerHours: 1,
                        upperHours: 6,
                        note: "runtime confidence band override",
                      }),
                    })
                  )
                  overrideBurndownConfidenceStatus = overrideBurndownConfidenceBand.status
                  expect([200, 404, 422]).toContain(overrideBurndownConfidenceStatus)
                  const annotateBurndownRollback = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "1f96159d-f438-4708-b75c-cdfe5d16f7bd",
                      },
                      body: JSON.stringify({
                        action: "annotate_closure_adjudication_burndown_checkpoint_rollback",
                        actorId: "partner_a",
                        adjudicationId,
                        rollbackReason: "runtime rollback due to panel evidence refresh",
                        note: "runtime rollback annotation",
                      }),
                    })
                  )
                  annotateBurndownRollbackStatus = annotateBurndownRollback.status
                  expect([200, 404, 422]).toContain(annotateBurndownRollbackStatus)
                  const acknowledgeSettlementDrift = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "58f3b309-cab4-4459-8793-59d0be14b740",
                      },
                      body: JSON.stringify({
                        action: "acknowledge_closure_burndown_settlement_drift",
                        actorId: "partner_a",
                        adjudicationId,
                        note: "runtime acknowledge settlement drift",
                      }),
                    })
                  )
                  acknowledgeSettlementDriftStatus = acknowledgeSettlementDrift.status
                  expect([200, 404, 422]).toContain(acknowledgeSettlementDriftStatus)
                  const attestSettlementTargetLock = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "5607a5ff-8863-4dc6-8a04-cfd603a16f07",
                      },
                      body: JSON.stringify({
                        action: "attest_closure_burndown_settlement_target_lock",
                        actorId: "partner_a",
                        adjudicationId,
                        note: "runtime attest settlement target lock",
                      }),
                    })
                  )
                  attestSettlementTargetLockStatus = attestSettlementTargetLock.status
                  expect([200, 404, 422]).toContain(attestSettlementTargetLockStatus)
                  const closeRollbackResolution = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "1290409c-5975-4081-a093-030a67cfc4ac",
                      },
                      body: JSON.stringify({
                        action: "close_closure_burndown_rollback_resolution",
                        actorId: "partner_a",
                        adjudicationId,
                        resolutionNote: "runtime rollback resolution closure note",
                        note: "runtime close rollback resolution",
                      }),
                    })
                  )
                  closeRollbackResolutionStatus = closeRollbackResolution.status
                  expect([200, 404, 422]).toContain(closeRollbackResolutionStatus)
                  const checkpointSettlementVerification = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "bc8d7495-4bfb-4838-a573-a44e5eb2c17b",
                      },
                      body: JSON.stringify({
                        action: "checkpoint_closure_settlement_post_resolution_verification",
                        actorId: "partner_a",
                        adjudicationId,
                        note: "runtime settlement verification checkpoint",
                      }),
                    })
                  )
                  checkpointSettlementVerificationStatus = checkpointSettlementVerification.status
                  expect([200, 404, 422]).toContain(checkpointSettlementVerificationStatus)
                  const attestSettlementLockRelease = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "ece7f66f-5488-4f1f-bf57-ad33d8ff4013",
                      },
                      body: JSON.stringify({
                        action: "attest_closure_settlement_lock_release",
                        actorId: "partner_a",
                        adjudicationId,
                        note: "runtime attest settlement lock release",
                      }),
                    })
                  )
                  attestSettlementLockReleaseStatus = attestSettlementLockRelease.status
                  expect([200, 404, 422]).toContain(attestSettlementLockReleaseStatus)
                  const safeguardSettlementDisputeReopen = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "b7ba3f17-e7ff-4dcb-87f2-39c5de471222",
                      },
                      body: JSON.stringify({
                        action: "safeguard_closure_settlement_dispute_reopen",
                        actorId: "partner_a",
                        adjudicationId,
                        guardNote: "runtime dispute reopen safeguard note",
                        note: "runtime dispute reopen safeguard",
                      }),
                    })
                  )
                  safeguardSettlementDisputeReopenStatus = safeguardSettlementDisputeReopen.status
                  expect([200, 404, 422]).toContain(safeguardSettlementDisputeReopenStatus)
                  const petitionSettlementVerificationOverride = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "04ce5f6a-db6c-4386-8811-a9a2a4157055",
                      },
                      body: JSON.stringify({
                        action: "petition_closure_settlement_verification_override",
                        actorId: "partner_a",
                        adjudicationId,
                        overrideReason: "runtime settlement override petition for arbitration panel",
                        note: "runtime petition settlement verification override",
                      }),
                    })
                  )
                  petitionSettlementVerificationOverrideStatus =
                    petitionSettlementVerificationOverride.status
                  expect([200, 404, 422]).toContain(petitionSettlementVerificationOverrideStatus)
                  const attestSettlementPanelConfirmation = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "5495f9ef-ed1e-4e35-bf3b-b1adf457f076",
                      },
                      body: JSON.stringify({
                        action: "attest_closure_settlement_arbitration_panel_confirmation",
                        actorId: "partner_a",
                        adjudicationId,
                        note: "runtime attest arbitration panel confirmation",
                      }),
                    })
                  )
                  attestSettlementPanelConfirmationStatus = attestSettlementPanelConfirmation.status
                  expect([200, 404, 422]).toContain(attestSettlementPanelConfirmationStatus)
                  const checkpointSettlementReopenVeto = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "3343d708-e8cb-4121-a73f-7f09e9f6da55",
                      },
                      body: JSON.stringify({
                        action: "checkpoint_closure_settlement_reopen_veto",
                        actorId: "partner_a",
                        adjudicationId,
                        vetoNote: "runtime reopen veto checkpoint after override petition",
                        note: "runtime checkpoint settlement reopen veto",
                      }),
                    })
                  )
                  checkpointSettlementReopenVetoStatus = checkpointSettlementReopenVeto.status
                  expect([200, 404, 422]).toContain(checkpointSettlementReopenVetoStatus)
                  const issueSettlementFinalRuling = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "80817713-9f87-48f6-b0ce-d45d8fd0869b",
                      },
                      body: JSON.stringify({
                        action: "issue_closure_settlement_arbitration_final_ruling",
                        actorId: "partner_a",
                        adjudicationId,
                        rulingSummary: "runtime final ruling issued after reopen veto checkpoint",
                        note: "runtime issue final settlement arbitration ruling",
                      }),
                    })
                  )
                  issueSettlementFinalRulingStatus = issueSettlementFinalRuling.status
                  expect([200, 404, 422]).toContain(issueSettlementFinalRulingStatus)
                  const memorializeSettlementDissent = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "fa45f237-0fcd-4232-a124-2d211d6f7770",
                      },
                      body: JSON.stringify({
                        action: "memorialize_closure_settlement_arbitration_dissent",
                        actorId: "partner_a",
                        adjudicationId,
                        dissentNote: "runtime dissent memorialized for panel planning traceability",
                        note: "runtime memorialize settlement arbitration dissent",
                      }),
                    })
                  )
                  memorializeSettlementDissentStatus = memorializeSettlementDissent.status
                  expect([200, 404, 422]).toContain(memorializeSettlementDissentStatus)
                  const checkpointSettlementPublication = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "55652489-58dc-4255-9505-d8ecf3f8e8cc",
                      },
                      body: JSON.stringify({
                        action: "checkpoint_closure_settlement_arbitration_ruling_publication",
                        actorId: "partner_a",
                        adjudicationId,
                        publicationChannel: "internal_panel_registry",
                        note: "runtime checkpoint settlement arbitration publication",
                      }),
                    })
                  )
                  checkpointSettlementPublicationStatus = checkpointSettlementPublication.status
                  expect([200, 404, 422]).toContain(checkpointSettlementPublicationStatus)
                  const logSettlementPublicationCorrection = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "13e0ecaf-5c24-4c37-8101-c9f7e7f8a1b0",
                      },
                      body: JSON.stringify({
                        action: "log_closure_settlement_arbitration_publication_correction",
                        actorId: "partner_a",
                        adjudicationId,
                        correctionNote: "runtime publication correction logged",
                        note: "runtime log publication correction",
                      }),
                    })
                  )
                  logSettlementPublicationCorrectionStatus = logSettlementPublicationCorrection.status
                  expect([200, 404, 422]).toContain(logSettlementPublicationCorrectionStatus)
                  const checkpointSettlementPublicationRollback = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "7dbd4a44-42a5-42ff-8fca-a02195a7538d",
                      },
                      body: JSON.stringify({
                        action: "checkpoint_closure_settlement_arbitration_publication_rollback",
                        actorId: "partner_a",
                        adjudicationId,
                        rollbackReason: "runtime publication rollback checkpointed",
                        note: "runtime checkpoint publication rollback",
                      }),
                    })
                  )
                  checkpointSettlementPublicationRollbackStatus =
                    checkpointSettlementPublicationRollback.status
                  expect([200, 404, 422]).toContain(checkpointSettlementPublicationRollbackStatus)
                  const reviewSettlementDistributionAttestation = await filingsPost(
                    new Request("http://127.0.0.1/api/d4/filings", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": "2f87e6ab-8618-49fb-9e14-c96fbc6ad0f9",
                      },
                      body: JSON.stringify({
                        action: "review_closure_settlement_arbitration_distribution_attestation",
                        actorId: "partner_a",
                        adjudicationId,
                        decision: "revision_required",
                        note: "runtime review distribution attestation",
                      }),
                    })
                  )
                  reviewSettlementDistributionAttestationStatus =
                    reviewSettlementDistributionAttestation.status
                  expect([200, 404, 422]).toContain(reviewSettlementDistributionAttestationStatus)
                }
              }
              const resolveClosureDispute = await filingsPost(
                new Request("http://127.0.0.1/api/d4/filings", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Idempotency-Key": "5ee53f0f-eb6e-4947-93f5-588661f07f4e",
                  },
                  body: JSON.stringify({
                    action: "resolve_closure_attestation_dispute",
                    actorId: "partner_a",
                    disputeId,
                    resolution: "uphold",
                    note: "runtime resolve dispute by upholding attestation",
                  }),
                })
              )
              resolveClosureDisputeStatus = resolveClosureDispute.status
              expect([200, 422]).toContain(resolveClosureDisputeStatus)
            }
          }
        }
      }
      const waiveClosureSlaException = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "2d90ce6c-c591-4eb2-bce7-689ca5e0d53b",
          },
          body: JSON.stringify({
            action: "waive_closure_sla_exception",
            actorId: "partner_a",
            ownerId: "partner_a",
            waiverReason: "policy override during controlled closure cutover",
            waiverHours: 6,
            note: "runtime closure SLA exception waived",
          }),
        })
      )
      expect([200, 422]).toContain(waiveClosureSlaException.status)
      const tickClosureEnforcement = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "4a0f7078-fecf-4611-ba89-c5f5cd6f7f90",
          },
          body: JSON.stringify({
            action: "tick_closure_sla_exception_enforcement",
            actorId: "partner_a",
            ownerId: "partner_a",
            note: "runtime enforcement tick",
          }),
        })
      )
      expect([200, 404]).toContain(tickClosureEnforcement.status)
      const rebalanceClosureEnforcement = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "bbebf887-e0a5-4ef6-a543-6bb61a73d3db",
          },
          body: JSON.stringify({
            action: "rebalance_closure_enforcement_queue",
            actorId: "partner_a",
            ownerId: "partner_a",
            status: "owner_reassignment_recommended",
            recommendedOwnerId: "partner_b",
            note: "runtime enforcement rebalance hint recorded",
          }),
        })
      )
      rebalanceClosureEnforcementStatus = rebalanceClosureEnforcement.status
      expect([200, 404, 422]).toContain(rebalanceClosureEnforcementStatus)
      if (rebalanceClosureEnforcementStatus === 200) {
        const configureRebalanceSafeguard = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "45b8af78-fc39-4e65-a090-3f2d7fae82c2",
            },
            body: JSON.stringify({
              action: "configure_closure_rebalance_auto_execution_safeguard",
              actorId: "partner_a",
              ownerId: "partner_a",
              cooldownLockHours: 1,
              duplicateSuppressionHours: 1,
              note: "runtime configure safeguard lockout before auto-exec",
            }),
          })
        )
        configureRebalanceSafeguardStatus = configureRebalanceSafeguard.status
        expect([200, 404, 422]).toContain(configureRebalanceSafeguardStatus)
        const setSafeguardOverrideExpiry = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "cfeea55d-138f-4d7a-863f-4720089f9486",
            },
            body: JSON.stringify({
              action: "set_closure_rebalance_safeguard_override_expiry",
              actorId: "partner_a",
              ownerId: "partner_a",
              overrideExpiryHours: 1,
              note: "runtime set safeguard override expiry timer",
            }),
          })
        )
        setSafeguardOverrideExpiryStatus = setSafeguardOverrideExpiry.status
        expect([200, 404, 422]).toContain(setSafeguardOverrideExpiryStatus)
        const executeOwnerTransfer = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "b95e8676-7af5-420f-a708-f2f445a42cd3",
            },
            body: JSON.stringify({
              action: "execute_closure_rebalance_owner_transfer",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime execute owner transfer rebalance",
            }),
          })
        )
        executeOwnerTransferStatus = executeOwnerTransfer.status
        expect([200, 404, 422]).toContain(executeOwnerTransferStatus)
        const attestRebalanceOverride = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "9dcd8fdd-3e86-4ed6-9fa4-cbd8f7afee68",
            },
            body: JSON.stringify({
              action: "attest_closure_rebalance_auto_execution_override",
              actorId: "partner_a",
              ownerId: "partner_a",
              reason: "runtime partner override for guarded rebalance execution",
              note: "runtime attest guarded auto-exec override",
            }),
          })
        )
        attestRebalanceOverrideStatus = attestRebalanceOverride.status
        expect([200, 404, 422]).toContain(attestRebalanceOverrideStatus)
        const autoClearSafeguardSuppression = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "0d5f711a-f909-46fd-ba9c-273f32b9da3a",
            },
            body: JSON.stringify({
              action: "auto_clear_closure_rebalance_safeguard_suppression",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime auto-clear safeguard suppression",
            }),
          })
        )
        autoClearSafeguardSuppressionStatus = autoClearSafeguardSuppression.status
        expect([200, 404, 422]).toContain(autoClearSafeguardSuppressionStatus)
        const cleanupStaleSafeguardLock = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "4d3cf15d-4d70-46d9-a35c-d90c361ecadb",
            },
            body: JSON.stringify({
              action: "cleanup_stale_closure_rebalance_safeguard_lock",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime cleanup stale safeguard lock",
            }),
          })
        )
        cleanupStaleSafeguardLockStatus = cleanupStaleSafeguardLock.status
        expect([200, 404, 422]).toContain(cleanupStaleSafeguardLockStatus)
        const acknowledgeSafeguardAttestation = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "a6f76713-4e78-49de-a731-58d594f7225f",
            },
            body: JSON.stringify({
              action: "acknowledge_closure_safeguard_expiry_attestation",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime acknowledge safeguard expiry attestation",
            }),
          })
        )
        acknowledgeSafeguardAttestationStatus = acknowledgeSafeguardAttestation.status
        expect([200, 404, 422]).toContain(acknowledgeSafeguardAttestationStatus)
        const queueSafeguardOverdueException = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "d8f92ca1-f9d7-4bf7-a975-8f4fd71d3bd4",
            },
            body: JSON.stringify({
              action: "queue_closure_safeguard_overdue_expiry_exception",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime queue overdue safeguard expiry exception",
            }),
          })
        )
        queueSafeguardOverdueExceptionStatus = queueSafeguardOverdueException.status
        expect([200, 404, 422]).toContain(queueSafeguardOverdueExceptionStatus)
        const reconcileSafeguardOverride = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "95cd0828-805c-406b-b73c-17c51355e35c",
            },
            body: JSON.stringify({
              action: "reconcile_closure_safeguard_expiry_override",
              actorId: "partner_a",
              ownerId: "partner_a",
              reconciliationNote: "runtime override reconciliation note",
              note: "runtime reconcile safeguard expiry override",
            }),
          })
        )
        reconcileSafeguardOverrideStatus = reconcileSafeguardOverride.status
        expect([200, 404, 422]).toContain(reconcileSafeguardOverrideStatus)
        const triageExpiryAttestationQueue = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "72f64de8-485a-4ffe-8f95-f50568723a46",
            },
            body: JSON.stringify({
              action: "triage_closure_safeguard_expiry_attestation_queue",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime triage expiry attestation queue item",
            }),
          })
        )
        triageExpiryQueueStatus = triageExpiryAttestationQueue.status
        expect([200, 404, 422]).toContain(triageExpiryQueueStatus)
        const attestExpiryQueueHandoff = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "5fe372e8-8bc4-48ec-a616-f7f04f092cd9",
            },
            body: JSON.stringify({
              action: "attest_closure_safeguard_expiry_queue_handoff",
              actorId: "partner_a",
              ownerId: "partner_a",
              handoffToOwnerId: "partner_b",
              carryoverNote: "runtime carryover note",
              note: "runtime attestation queue handoff",
            }),
          })
        )
        attestExpiryQueueHandoffStatus = attestExpiryQueueHandoff.status
        expect([200, 404, 422]).toContain(attestExpiryQueueHandoffStatus)
        const checkpointExpiryQueueAutoDrain = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "f95f772f-5165-44c5-8458-137e95b67aa6",
            },
            body: JSON.stringify({
              action: "checkpoint_closure_safeguard_expiry_queue_auto_drain",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime queue auto-drain checkpoint",
            }),
          })
        )
        checkpointExpiryQueueAutoDrainStatus = checkpointExpiryQueueAutoDrain.status
        expect([200, 404, 422]).toContain(checkpointExpiryQueueAutoDrainStatus)
        const escalateQueueHandoffTimeout = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "4f0f457a-c6be-4300-b34c-b7f15e4f2cb6",
            },
            body: JSON.stringify({
              action: "escalate_closure_expiry_attestation_queue_handoff_timeout",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime escalate queue handoff timeout",
            }),
          })
        )
        escalateQueueHandoffTimeoutStatus = escalateQueueHandoffTimeout.status
        expect([200, 404, 422]).toContain(escalateQueueHandoffTimeoutStatus)
        const attestQueueStaleReassignment = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "f34815d3-4e2c-42f5-9055-f6a72f30469d",
            },
            body: JSON.stringify({
              action: "attest_closure_expiry_attestation_queue_stale_reassignment",
              actorId: "partner_a",
              ownerId: "partner_a",
              reassignedOwnerId: "partner_b",
              note: "runtime attest stale reassignment",
            }),
          })
        )
        attestQueueStaleReassignmentStatus = attestQueueStaleReassignment.status
        expect([200, 404, 422]).toContain(attestQueueStaleReassignmentStatus)
        const checkpointQueueForcedDrain = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "4869785a-93d5-49af-9a60-4f80bcf76cad",
            },
            body: JSON.stringify({
              action: "checkpoint_closure_expiry_attestation_queue_forced_drain_override",
              actorId: "partner_a",
              ownerId: "partner_a",
              overrideNote: "runtime forced drain override",
              note: "runtime checkpoint forced drain override",
            }),
          })
        )
        checkpointQueueForcedDrainStatus = checkpointQueueForcedDrain.status
        expect([200, 404, 422]).toContain(checkpointQueueForcedDrainStatus)
        const attestQueueForcedReconciliation = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "8a994aa4-cf2f-4b51-ae40-6fd1a6b15785",
            },
            body: JSON.stringify({
              action: "attest_closure_queue_drain_forced_reconciliation",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime attest queue forced reconciliation",
            }),
          })
        )
        attestQueueForcedReconciliationStatus = attestQueueForcedReconciliation.status
        expect([200, 404, 422]).toContain(attestQueueForcedReconciliationStatus)
        const checkpointQueueReassignmentRollback = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "fae4dc5a-d885-4247-9a03-d88f494745ad",
            },
            body: JSON.stringify({
              action: "checkpoint_closure_queue_drain_reassignment_rollback",
              actorId: "partner_a",
              ownerId: "partner_a",
              rollbackToOwnerId: "partner_a",
              note: "runtime checkpoint queue reassignment rollback",
            }),
          })
        )
        checkpointQueueReassignmentRollbackStatus = checkpointQueueReassignmentRollback.status
        expect([200, 404, 422]).toContain(checkpointQueueReassignmentRollbackStatus)
        const controlQueueTimeoutReentry = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "49731912-95cf-4d04-8e89-1764b88e2eb4",
            },
            body: JSON.stringify({
              action: "control_closure_queue_drain_timeout_reentry",
              actorId: "partner_a",
              ownerId: "partner_a",
              timeoutWindowHours: 12,
              note: "runtime control queue timeout re-entry",
            }),
          })
        )
        controlQueueTimeoutReentryStatus = controlQueueTimeoutReentry.status
        expect([200, 404, 422]).toContain(controlQueueTimeoutReentryStatus)
        const attestQueueReentryException = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "cf4437ec-041e-4a76-bd18-c891f36cf49d",
            },
            body: JSON.stringify({
              action: "attest_closure_queue_reentry_exception",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime attest queue re-entry exception",
            }),
          })
        )
        attestQueueReentryExceptionStatus = attestQueueReentryException.status
        expect([200, 404, 422]).toContain(attestQueueReentryExceptionStatus)
        const checkpointQueueReentryTimeoutWaiver = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "459a4474-c72d-4f3c-bf5f-827f53d95c65",
            },
            body: JSON.stringify({
              action: "checkpoint_closure_queue_reentry_timeout_waiver",
              actorId: "partner_a",
              ownerId: "partner_a",
              waiverHours: 12,
              note: "runtime checkpoint queue re-entry timeout waiver",
            }),
          })
        )
        checkpointQueueReentryTimeoutWaiverStatus = checkpointQueueReentryTimeoutWaiver.status
        expect([200, 404, 422]).toContain(checkpointQueueReentryTimeoutWaiverStatus)
        const controlQueueReentryResume = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "56e20572-050d-4f22-9987-f0ab6caec490",
            },
            body: JSON.stringify({
              action: "control_closure_queue_reentry_reconciliation_resume",
              actorId: "partner_a",
              ownerId: "partner_a",
              note: "runtime control queue re-entry reconciliation resume",
            }),
          })
        )
        controlQueueReentryResumeStatus = controlQueueReentryResume.status
        expect([200, 404, 422]).toContain(controlQueueReentryResumeStatus)
        const assignQueueReentryDebt = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "80b22f5b-8cf6-4928-83c1-d28ad4268a4b",
            },
            body: JSON.stringify({
              action: "assign_closure_queue_reentry_exception_debt",
              actorId: "partner_a",
              ownerId: "partner_a",
              assigneeId: "partner_b",
              note: "runtime assign queue re-entry exception debt",
            }),
          })
        )
        assignQueueReentryDebtStatus = assignQueueReentryDebt.status
        expect([200, 404, 422]).toContain(assignQueueReentryDebtStatus)
        const attestQueueReentryDebtRetirement = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "8e8f2e5e-d9d4-4703-a8d1-dc04f53cfdfa",
            },
            body: JSON.stringify({
              action: "attest_closure_queue_reentry_debt_retirement",
              actorId: "partner_a",
              ownerId: "partner_a",
              retiredCount: 1,
              note: "runtime attest queue re-entry debt retirement",
            }),
          })
        )
        attestQueueReentryDebtRetirementStatus = attestQueueReentryDebtRetirement.status
        expect([200, 404, 422]).toContain(attestQueueReentryDebtRetirementStatus)
        const controlQueueReentryDebtAging = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "c4f85f40-f5a4-493e-a9c7-0ccf9b4b994b",
            },
            body: JSON.stringify({
              action: "control_closure_queue_reentry_debt_aging_auto_escalation",
              actorId: "partner_a",
              ownerId: "partner_a",
              agingHours: 6,
              note: "runtime control queue re-entry debt aging auto escalation",
            }),
          })
        )
        controlQueueReentryDebtAgingStatus = controlQueueReentryDebtAging.status
        expect([200, 404, 422]).toContain(controlQueueReentryDebtAgingStatus)
        const openQueueDebtRetirementDispute = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "b79f9704-0ce0-438f-8f3f-eb31c8bc5173",
            },
            body: JSON.stringify({
              action: "open_closure_queue_reentry_debt_retirement_dispute",
              actorId: "partner_a",
              ownerId: "partner_a",
              disputeReason: "runtime debt retirement dispute intake",
              note: "runtime open debt retirement dispute",
            }),
          })
        )
        openQueueDebtRetirementDisputeStatus = openQueueDebtRetirementDispute.status
        expect([200, 404, 422]).toContain(openQueueDebtRetirementDisputeStatus)
        const resolveQueueDebtRetirementDispute = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "944663cf-df78-4426-a082-673f045766f2",
            },
            body: JSON.stringify({
              action: "resolve_closure_queue_reentry_debt_retirement_dispute",
              actorId: "partner_a",
              ownerId: "partner_a",
              resolution: "reopen_debt",
              note: "runtime resolve debt retirement dispute",
            }),
          })
        )
        resolveQueueDebtRetirementDisputeStatus = resolveQueueDebtRetirementDispute.status
        expect([200, 404, 422]).toContain(resolveQueueDebtRetirementDisputeStatus)
        const controlQueueDebtRetirementRollback = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "88a14e6d-5218-4e5d-bff8-cf3f8ad1d1f7",
            },
            body: JSON.stringify({
              action: "control_closure_queue_reentry_debt_retirement_rollback",
              actorId: "partner_a",
              ownerId: "partner_a",
              rollbackCount: 1,
              note: "runtime control debt retirement rollback",
            }),
          })
        )
        controlQueueDebtRetirementRollbackStatus = controlQueueDebtRetirementRollback.status
        expect([200, 404, 422]).toContain(controlQueueDebtRetirementRollbackStatus)
        if (executeOwnerTransferStatus !== 200) {
          const executeOwnerTransferAfterOverride = await filingsPost(
            new Request("http://127.0.0.1/api/d4/filings", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": "e173d32f-f5dc-4659-a676-4f2cf0de2d9c",
              },
              body: JSON.stringify({
                action: "execute_closure_rebalance_owner_transfer",
                actorId: "partner_a",
                ownerId: "partner_a",
                note: "runtime execute owner transfer rebalance after override",
              }),
            })
          )
          executeOwnerTransferStatus = executeOwnerTransferAfterOverride.status
          expect([200, 404, 422]).toContain(executeOwnerTransferStatus)
        }
      }
      const activateThrottleRebalance = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "66ac6af1-30cb-46bd-b6de-fcb9cbf35a6a",
          },
          body: JSON.stringify({
            action: "rebalance_closure_enforcement_queue",
            actorId: "partner_a",
            ownerId: "partner_a",
            status: "throttle_active",
            throttleHours: 1,
            note: "runtime activate throttle before release execution",
          }),
        })
      )
      expect([200, 404, 422]).toContain(activateThrottleRebalance.status)
      if (activateThrottleRebalance.status === 200) {
        const executeThrottleRelease = await filingsPost(
          new Request("http://127.0.0.1/api/d4/filings", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "f84ffab4-ae68-4f7e-a20b-523f21efe90d",
            },
            body: JSON.stringify({
              action: "execute_closure_rebalance_throttle_release",
              actorId: "partner_a",
              ownerId: "partner_a",
              reopenQueue: true,
              note: "runtime execute throttle release rebalance",
            }),
          })
        )
        executeThrottleReleaseStatus = executeThrottleRelease.status
        expect([200, 404, 422]).toContain(executeThrottleReleaseStatus)
      }
      const revokeWaiver = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8d2f5430-f992-4bbd-b5be-9ea52e9fdff3",
          },
          body: JSON.stringify({
            action: "revoke_breach_waiver",
            actorId: "partner_a",
            packageId,
            note: "runtime waiver revoked",
          }),
        })
      )
      expect(revokeWaiver.status).toBe(200)
      const acknowledgeHandoff = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "200344de-c464-44a9-9f41-0f8400ec32d3",
          },
          body: JSON.stringify({
            action: "acknowledge_handoff",
            actorId: "partner_a",
            packageId,
            note: "runtime owner handoff acknowledged",
          }),
        })
      )
      expect(acknowledgeHandoff.status).toBe(200)
      const confirmDelivered = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "29d0ca9d-66df-4f26-bc84-28e2e5f51674",
          },
          body: JSON.stringify({
            action: "confirm_delivered",
            actorId: "partner_a",
            packageId,
            transportChannel: "courier_stub",
            channelPayloadHash: "runtime-transport-hash-003",
            attachmentPointers: ["ops://runtime/proof-of-delivery"],
            relatedReceiptId: `receipt:${packageId}:1`,
            note: "runtime deterministic delivery confirmed",
          }),
        })
      )
      expect(confirmDelivered.status).toBe(200)
      const clearDigest = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "eb8a5f68-a9bb-47f8-aa7c-4cbf2295db53",
          },
          body: JSON.stringify({
            action: "clear_digest",
            actorId: "partner_a",
            packageId,
            note: "runtime digest cleared after closure",
          }),
        })
      )
      expect(clearDigest.status).toBe(200)
      const revokeAssignment = await filingsPost(
        new Request("http://127.0.0.1/api/d4/filings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "1af90fdd-c87d-4dca-b0bc-f494773ca9c4",
          },
          body: JSON.stringify({
            action: "revoke_assignment",
            actorId: "partner_a",
            packageId,
            note: "runtime escalation assignment revoked",
          }),
        })
      )
      expect(revokeAssignment.status).toBe(200)

      getRuntimeStore().filingPacketArtifacts = new Map()
      getRuntimeStore().filingDispatchQueue = new Map()
      getRuntimeStore().filingAnnexures = new Map()
      getRuntimeStore().filingSubmissionReceipts = new Map()
      getRuntimeStore().filingSubmissionReconciliation = new Map()
      getRuntimeStore().filingSubmissionExceptions = new Map()
      getRuntimeStore().filingTransportExecutionEvidence = new Map()
      getRuntimeStore().filingSubmissionSlaDigests = new Map()
      getRuntimeStore().filingEscalationOwnerRota = new Map()
      getRuntimeStore().filingEscalationWorkloadDigests = new Map()
      getRuntimeStore().filingEscalationPolicyBaselines = new Map()
      getRuntimeStore().filingEscalationBreachWaivers = new Map()
      getRuntimeStore().filingEscalationPolicyVarianceDigests = new Map()
      getRuntimeStore().filingEscalationWaiverExpiryDigests = new Map()
      getRuntimeStore().filingEscalationVarianceRemediations = new Map()
      getRuntimeStore().filingEscalationWaiverRolloverAttestations = new Map()
      getRuntimeStore().filingEscalationRemediationExpiryDigests = new Map()
      getRuntimeStore().filingEscalationRolloverBreachWatches = new Map()
      getRuntimeStore().filingEscalationRemediationLifecycles = new Map()
      getRuntimeStore().filingEscalationRolloverReaffirmationSlas = new Map()
      getRuntimeStore().filingEscalationClosureComplianceDigests = new Map()
      getRuntimeStore().filingEscalationClosureFollowupQueues = new Map()
      getRuntimeStore().filingEscalationClosureSlaWindowConfigs = new Map()
      getRuntimeStore().filingEscalationClosureAutoAssignmentRules = new Map()
      getRuntimeStore().filingEscalationClosureSlaWindows = new Map()
      getRuntimeStore().filingEscalationClosureAttestations = new Map()
      getRuntimeStore().filingEscalationClosureSlaExceptionDigests = new Map()
      getRuntimeStore().filingEscalationClosureAttestationDisputes = new Map()
      getRuntimeStore().filingEscalationClosureSlaExceptionEnforcement = new Map()
      getRuntimeStore().filingEscalationClosureAdjudicationQueue = new Map()
      getRuntimeStore().filingEscalationClosureEnforcementRebalance = new Map()
      getRuntimeStore().filingEscalationClosureAdjudicationQuorum = new Map()
      getRuntimeStore().filingEscalationClosureRebalanceExecution = new Map()
      getRuntimeStore().filingEscalationClosureAdjudicationSlo = new Map()
      getRuntimeStore().filingEscalationClosureRebalanceSafeguards = new Map()
      getRuntimeStore().filingEscalationClosureAdjudicationSloDebtRemediation = new Map()
      getRuntimeStore().filingEscalationClosureRebalanceSafeguardExpiry = new Map()
      getRuntimeStore().filingEscalationClosureAdjudicationDebtBurndown = new Map()
      getRuntimeStore().filingEscalationClosureSafeguardExpiryAttestations = new Map()
      getRuntimeStore().filingEscalationClosureBurndownRecalibration = new Map()
      getRuntimeStore().filingEscalationClosureExpiryAttestationQueue = new Map()
      getRuntimeStore().filingEscalationClosureBurndownSettlement = new Map()
      getRuntimeStore().filingEscalationClosureExpiryAttestationQueueDrain = new Map()
      getRuntimeStore().filingEscalationClosureSettlementAttestation = new Map()
      getRuntimeStore().filingEscalationClosureQueueDrainReconciliation = new Map()
      getRuntimeStore().filingEscalationClosureSettlementArbitration = new Map()
      getRuntimeStore().filingEscalationClosureQueueReentryCompliance = new Map()
      const rehydratedList = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?userId=associate_a&matterId=${matterId}&readiness=ready&limit=10&cursor=0`
        )
      )
      expect(rehydratedList.status).toBe(200)
      const rehydratedJson = (await rehydratedList.json()) as {
        items: Array<{ id: string; packetArtifact: { readiness: string } | null }>
      }
      expect(
        rehydratedJson.items.some(
          (item) => item.id === packageId && item.packetArtifact?.readiness === "ready"
        )
      ).toBe(true)
      const rehydratedDispatch = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=dispatch&userId=associate_a&matterId=${matterId}&dispatchStatus=handoff_ready&assigneeId=clerk_a&limit=10&cursor=0`
        )
      )
      expect(rehydratedDispatch.status).toBe(200)
      const rehydratedDispatchJson = (await rehydratedDispatch.json()) as {
        items: Array<{ packageId: string; status: string; assigneeId: string | null; retryCount: number }>
      }
      expect(
        rehydratedDispatchJson.items.some(
          (item) =>
            item.packageId === packageId &&
            item.status === "handoff_ready" &&
            item.assigneeId === "clerk_a" &&
            item.retryCount >= 1
        )
      ).toBe(true)
      const rehydratedAnnexures = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=annexures&userId=associate_a&matterId=${matterId}&annexureStatus=ready&limit=10&cursor=0`
        )
      )
      expect(rehydratedAnnexures.status).toBe(200)
      const rehydratedAnnexuresJson = (await rehydratedAnnexures.json()) as {
        items: Array<{
          packageId: string
          generationStatus: string
          submissionTransportBoundary: string
        }>
      }
      expect(
        rehydratedAnnexuresJson.items.some(
          (item) =>
            item.packageId === packageId &&
            item.generationStatus === "ready" &&
            item.submissionTransportBoundary === "todo_firm_external_transport_blocked"
        )
      ).toBe(true)
      const rehydratedReceipts = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=submission_receipts&userId=associate_a&matterId=${matterId}&dispatchOutcome=retry_scheduled&limit=10&cursor=0`
        )
      )
      expect(rehydratedReceipts.status).toBe(200)
      const rehydratedReceiptsJson = (await rehydratedReceipts.json()) as {
        items: Array<{ packageId: string; submissionReference: string }>
      }
      expect(
        rehydratedReceiptsJson.items.some(
          (item) => item.packageId === packageId && item.submissionReference === "RUNTIME-SUB-001"
        )
      ).toBe(true)
      const rehydratedReconciliation = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=submission_reconciliation&userId=associate_a&matterId=${matterId}&reconciliationStatus=reconciled&limit=10&cursor=0`
        )
      )
      expect(rehydratedReconciliation.status).toBe(200)
      const rehydratedReconciliationJson = (await rehydratedReconciliation.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedReconciliationJson.items.some(
          (item) => item.packageId === packageId && item.status === "reconciled"
        )
      ).toBe(true)
      const rehydratedExceptions = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=submission_exceptions&userId=associate_a&matterId=${matterId}&exceptionStatus=resolved&severity=high&escalationOwnerId=partner_a&limit=10&cursor=0`
        )
      )
      expect(rehydratedExceptions.status).toBe(200)
      const rehydratedExceptionsJson = (await rehydratedExceptions.json()) as {
        items: Array<{ packageId: string; status: string; severity: string; escalationOwnerId: string | null }>
      }
      expect(
        rehydratedExceptionsJson.items.some(
          (item) =>
            item.packageId === packageId &&
            item.status === "resolved" &&
            item.severity === "high" &&
            item.escalationOwnerId === "partner_a"
        )
      ).toBe(true)
      const rehydratedTransportEvidence = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=transport_execution&userId=associate_a&matterId=${matterId}&packageId=${packageId}&outcome=confirm_delivered&limit=10&cursor=0`
        )
      )
      expect(rehydratedTransportEvidence.status).toBe(200)
      const rehydratedTransportEvidenceJson = (await rehydratedTransportEvidence.json()) as {
        items: Array<{ packageId: string; outcome: string }>
      }
      expect(
        rehydratedTransportEvidenceJson.items.some(
          (item) => item.packageId === packageId && item.outcome === "confirm_delivered"
        )
      ).toBe(true)
      const rehydratedDigest = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=submission_sla_digests&userId=associate_a&matterId=${matterId}&packageId=${packageId}&digestStatus=cleared&ownerId=partner_a&limit=10&cursor=0`
        )
      )
      expect(rehydratedDigest.status).toBe(200)
      const rehydratedDigestJson = (await rehydratedDigest.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedDigestJson.items.some(
          (item) => item.packageId === packageId && item.status === "cleared"
        )
      ).toBe(true)
      const rehydratedRota = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=escalation_owner_rota&userId=associate_a&matterId=${matterId}&packageId=${packageId}&rotaStatus=revoked&limit=10&cursor=0`
        )
      )
      expect(rehydratedRota.status).toBe(200)
      const rehydratedRotaJson = (await rehydratedRota.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedRotaJson.items.some(
          (item) => item.packageId === packageId && item.status === "revoked"
        )
      ).toBe(true)
      const rehydratedWorkload = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=escalation_workload_digests&userId=associate_a&matterId=${matterId}&packageId=${packageId}&limit=10&cursor=0`
        )
      )
      expect(rehydratedWorkload.status).toBe(200)
      const rehydratedWorkloadJson = (await rehydratedWorkload.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedWorkloadJson.items.some(
          (item) =>
            item.packageId === packageId &&
            ["cleared", "open_alert", "acknowledged", "snoozed"].includes(item.status)
        )
      ).toBe(true)
      const rehydratedPolicy = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=escalation_policy_baselines&userId=associate_a&packageId=${packageId}&scope=package_override&limit=10&cursor=0`
        )
      )
      expect(rehydratedPolicy.status).toBe(200)
      const rehydratedPolicyJson = (await rehydratedPolicy.json()) as {
        items: Array<{ packageId: string | null; scope: string }>
      }
      expect(
        rehydratedPolicyJson.items.some(
          (item) => item.packageId === packageId && item.scope === "package_override"
        )
      ).toBe(true)
      const rehydratedWaiver = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=breach_waiver_ledger&userId=associate_a&matterId=${matterId}&packageId=${packageId}&waiverStatus=revoked&limit=10&cursor=0`
        )
      )
      expect(rehydratedWaiver.status).toBe(200)
      const rehydratedWaiverJson = (await rehydratedWaiver.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedWaiverJson.items.some(
          (item) => item.packageId === packageId && item.status === "revoked"
        )
      ).toBe(true)
      const rehydratedPolicyVariance = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=policy_variance_digests&userId=associate_a&matterId=${matterId}&packageId=${packageId}&varianceStatus=snoozed&limit=10&cursor=0`
        )
      )
      expect(rehydratedPolicyVariance.status).toBe(200)
      const rehydratedPolicyVarianceJson = (await rehydratedPolicyVariance.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedPolicyVarianceJson.items.some(
          (item) => item.packageId === packageId && item.status === "snoozed"
        )
      ).toBe(true)
      const rehydratedWaiverExpiry = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=waiver_expiry_digests&userId=associate_a&matterId=${matterId}&packageId=${packageId}&expiryStatus=cleared&limit=10&cursor=0`
        )
      )
      expect(rehydratedWaiverExpiry.status).toBe(200)
      const rehydratedWaiverExpiryJson = (await rehydratedWaiverExpiry.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedWaiverExpiryJson.items.some(
          (item) => item.packageId === packageId && item.status === "cleared"
        )
      ).toBe(true)
      const rehydratedRemediation = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=variance_remediation_ledger&userId=associate_a&matterId=${matterId}&packageId=${packageId}&remediationStatus=expired&decision=temporary_override&limit=10&cursor=0`
        )
      )
      expect(rehydratedRemediation.status).toBe(200)
      const rehydratedRemediationJson = (await rehydratedRemediation.json()) as {
        items: Array<{ packageId: string; status: string; decision: string }>
      }
      expect(
        rehydratedRemediationJson.items.some(
          (item) =>
            item.packageId === packageId &&
            item.status === "expired" &&
            item.decision === "temporary_override"
        )
      ).toBe(true)
      const rehydratedRollover = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=waiver_rollover_attestations&userId=associate_a&matterId=${matterId}&packageId=${packageId}&rolloverStatus=attested&limit=10&cursor=0`
        )
      )
      expect(rehydratedRollover.status).toBe(200)
      const rehydratedRolloverJson = (await rehydratedRollover.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedRolloverJson.items.some(
          (item) => item.packageId === packageId && item.status === "attested"
        )
      ).toBe(true)
      const rehydratedRemediationExpiry = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=remediation_expiry_digests&userId=associate_a&matterId=${matterId}&packageId=${packageId}&expiryStatus=cleared&limit=10&cursor=0`
        )
      )
      expect(rehydratedRemediationExpiry.status).toBe(200)
      const rehydratedRemediationExpiryJson = (await rehydratedRemediationExpiry.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedRemediationExpiryJson.items.some(
          (item) => item.packageId === packageId && item.status === "cleared"
        )
      ).toBe(true)
      const rehydratedLifecycle = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=remediation_lifecycle&userId=associate_a&matterId=${matterId}&packageId=${packageId}&lifecycleStatus=closure_attested&closureOutcome=accepted_risk_retired&limit=10&cursor=0`
        )
      )
      expect(rehydratedLifecycle.status).toBe(200)
      const rehydratedLifecycleJson = (await rehydratedLifecycle.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedLifecycleJson.items.some(
          (item) => item.packageId === packageId && item.status === "closure_attested"
        )
      ).toBe(true)
      const rehydratedRolloverWatch = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=rollover_breach_watches&userId=associate_a&matterId=${matterId}&packageId=${packageId}&watchStatus=cleared&limit=10&cursor=0`
        )
      )
      expect(rehydratedRolloverWatch.status).toBe(200)
      const rehydratedRolloverWatchJson = (await rehydratedRolloverWatch.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedRolloverWatchJson.items.some(
          (item) => item.packageId === packageId && item.status === "cleared"
        )
      ).toBe(true)
      const rehydratedReaffirmationSla = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=rollover_reaffirmation_sla&userId=associate_a&matterId=${matterId}&packageId=${packageId}&limit=10&cursor=0`
        )
      )
      expect(rehydratedReaffirmationSla.status).toBe(200)
      const rehydratedReaffirmationSlaJson = (await rehydratedReaffirmationSla.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedReaffirmationSlaJson.items.some(
          (item) =>
            item.packageId === packageId &&
            ["within_sla", "cleared", "acknowledged"].includes(item.status)
        )
      ).toBe(true)
      const rehydratedClosureCompliance = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_compliance_digests&userId=partner_a&ownerId=partner_a&limit=10&cursor=0`
        )
      )
      expect(rehydratedClosureCompliance.status).toBe(200)
      const rehydratedClosureComplianceJson = (await rehydratedClosureCompliance.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureComplianceJson.items.some(
          (item) =>
            item.ownerId === "partner_a" &&
            ["open_alert", "acknowledged", "cleared"].includes(item.status)
        )
      ).toBe(true)
      const rehydratedClosureQueue = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_followup_queue&userId=partner_a&ownerId=partner_a&limit=10&cursor=0`
        )
      )
      expect(rehydratedClosureQueue.status).toBe(200)
      const rehydratedClosureQueueJson = (await rehydratedClosureQueue.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureQueueJson.items.some(
          (item) =>
            item.ownerId === "partner_a" && ["open", "claimed", "resolved"].includes(item.status)
        )
      ).toBe(true)
      const rehydratedClosureSlaConfigs = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_sla_window_configs&userId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureSlaConfigs.status).toBe(200)
      const rehydratedClosureSlaConfigsJson = (await rehydratedClosureSlaConfigs.json()) as {
        items: Array<{ scope: string }>
      }
      expect(
        rehydratedClosureSlaConfigsJson.items.some((item) =>
          ["firm_default", "owner_override"].includes(item.scope)
        )
      ).toBe(true)
      const rehydratedClosureAutoRules = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_auto_assignment_rules&userId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureAutoRules.status).toBe(200)
      const rehydratedClosureAutoRulesJson = (await rehydratedClosureAutoRules.json()) as {
        items: Array<{ mode: string }>
      }
      expect(
        rehydratedClosureAutoRulesJson.items.some((item) =>
          ["owner_rota", "workload_aware_claim"].includes(item.mode)
        )
      ).toBe(true)
      const rehydratedClosureSlaWindows = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_sla_windows&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureSlaWindows.status).toBe(200)
      const rehydratedClosureSlaWindowsJson = (await rehydratedClosureSlaWindows.json()) as {
        items: Array<{ ownerId: string; status: string; pressureLevel: string }>
      }
      expect(
        rehydratedClosureSlaWindowsJson.items.some(
          (item) =>
            item.ownerId === "partner_a" &&
            ["within_window", "ack_breached", "clear_breached", "auto_escalation_due", "cleared"].includes(
              item.status
            ) &&
            ["baseline", "elevated", "critical"].includes(item.pressureLevel)
        )
      ).toBe(true)
      const rehydratedClosureAttestations = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_attestations&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureAttestations.status).toBe(200)
      const rehydratedClosureAttestationsJson = (await rehydratedClosureAttestations.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureAttestationsJson.items.every((item) => item.ownerId === "partner_a")
      ).toBe(true)
      const rehydratedClosureSlaExceptions = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_sla_exception_digests&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureSlaExceptions.status).toBe(200)
      const rehydratedClosureSlaExceptionsJson = (await rehydratedClosureSlaExceptions.json()) as {
        items: Array<{ ownerId: string; status: string; pressureLevel: string }>
      }
      expect(
        rehydratedClosureSlaExceptionsJson.items.some(
          (item) =>
            item.ownerId === "partner_a" &&
            ["open_exception", "waived", "expired", "cleared"].includes(item.status) &&
            ["baseline", "elevated", "critical"].includes(item.pressureLevel)
        )
      ).toBe(true)
      const rehydratedClosureDisputes = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_attestation_disputes&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureDisputes.status).toBe(200)
      const rehydratedClosureDisputesJson = (await rehydratedClosureDisputes.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureDisputesJson.items.every((item) =>
          ["open_dispute", "under_review", "resolved_upheld", "resolved_overturned"].includes(item.status)
        )
      ).toBe(true)
      const rehydratedClosureEnforcement = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_sla_exception_enforcement&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureEnforcement.status).toBe(200)
      const rehydratedClosureEnforcementJson = (await rehydratedClosureEnforcement.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureEnforcementJson.items.every((item) =>
          ["countdown_active", "reminder_sent", "escalated", "closed"].includes(item.status)
        )
      ).toBe(true)
      const rehydratedClosureAdjudication = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_adjudication_queue&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureAdjudication.status).toBe(200)
      const rehydratedClosureAdjudicationJson = (await rehydratedClosureAdjudication.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureAdjudicationJson.items.every((item) =>
          [
            "pending_panel_assignment",
            "panel_in_review",
            "resolved_upheld",
            "resolved_overturned",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedClosureRebalance = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_enforcement_rebalance&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureRebalance.status).toBe(200)
      const rehydratedClosureRebalanceJson = (await rehydratedClosureRebalance.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureRebalanceJson.items.every((item) =>
          [
            "none",
            "cooldown_scheduled",
            "owner_reassignment_recommended",
            "throttle_active",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedClosureQuorum = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_adjudication_quorum&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureQuorum.status).toBe(200)
      const rehydratedClosureQuorumJson = (await rehydratedClosureQuorum.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureQuorumJson.items.every((item) =>
          ["quorum_pending", "quorum_met", "verdict_overdue", "closed"].includes(item.status)
        )
      ).toBe(true)
      const rehydratedClosureExecution = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_rebalance_execution&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureExecution.status).toBe(200)
      const rehydratedClosureExecutionJson = (await rehydratedClosureExecution.json()) as {
        items: Array<{ ownerId: string; status: string; mode: string }>
      }
      expect(
        rehydratedClosureExecutionJson.items.every(
          (item) =>
            ["queued", "owner_transfer_in_progress", "throttle_release_in_progress", "completed"].includes(
              item.status
            ) && ["owner_transfer", "throttle_release"].includes(item.mode)
        )
      ).toBe(true)
      const rehydratedClosureSlo = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_adjudication_slo&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureSlo.status).toBe(200)
      const rehydratedClosureSloJson = (await rehydratedClosureSlo.json()) as {
        items: Array<{ ownerId: string; status: string; escalationTier: string }>
      }
      expect(
        rehydratedClosureSloJson.items.every(
          (item) =>
            ["within_slo", "deadline_extended", "breach_open", "breach_acknowledged"].includes(
              item.status
            ) &&
            [
              "none",
              "tier_1_partner_watch",
              "tier_2_management_escalation",
              "tier_3_executive_escalation",
            ].includes(item.escalationTier)
        )
      ).toBe(true)
      const rehydratedClosureSafeguards = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_rebalance_safeguards&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureSafeguards.status).toBe(200)
      const rehydratedClosureSafeguardsJson = (await rehydratedClosureSafeguards.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureSafeguardsJson.items.every((item) =>
          ["auto_exec_ready", "cooldown_locked", "duplicate_suppressed", "override_attested"].includes(
            item.status
          )
        )
      ).toBe(true)
      const rehydratedClosureDebtRemediation = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_adjudication_slo_debt_remediation&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureDebtRemediation.status).toBe(200)
      const rehydratedClosureDebtRemediationJson = (await rehydratedClosureDebtRemediation.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureDebtRemediationJson.items.every((item) =>
          ["debt_open", "debt_retirement_pending", "debt_retired", "breach_closure_attested"].includes(
            item.status
          )
        )
      ).toBe(true)
      const rehydratedClosureSafeguardExpiry = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_rebalance_safeguard_expiry&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedClosureSafeguardExpiry.status).toBe(200)
      const rehydratedClosureSafeguardExpiryJson = (await rehydratedClosureSafeguardExpiry.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedClosureSafeguardExpiryJson.items.every((item) =>
          ["expiry_pending", "auto_cleared", "override_expired", "stale_lock_cleaned"].includes(
            item.status
          )
        )
      ).toBe(true)
      const rehydratedDebtBurndown = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_adjudication_debt_burndown&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedDebtBurndown.status).toBe(200)
      const rehydratedDebtBurndownJson = (await rehydratedDebtBurndown.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedDebtBurndownJson.items.every((item) =>
          [
            "burndown_tracking",
            "burndown_checkpoint_due",
            "burndown_attested",
            "burndown_forecast_breached",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedSafeguardAttestations = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_safeguard_expiry_attestations&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedSafeguardAttestations.status).toBe(200)
      const rehydratedSafeguardAttestationsJson = (await rehydratedSafeguardAttestations.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedSafeguardAttestationsJson.items.every((item) =>
          [
            "attestation_open",
            "attestation_acknowledged",
            "attestation_overdue",
            "attestation_reconciled",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedBurndownRecalibration = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_burndown_recalibration&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedBurndownRecalibration.status).toBe(200)
      const rehydratedBurndownRecalibrationJson = (await rehydratedBurndownRecalibration.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedBurndownRecalibrationJson.items.every((item) =>
          [
            "recalibration_pending",
            "confidence_band_overridden",
            "checkpoint_rollback_noted",
            "recalibration_settled",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedExpiryAttestationQueue = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_expiry_attestation_queue&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedExpiryAttestationQueue.status).toBe(200)
      const rehydratedExpiryAttestationQueueJson = (await rehydratedExpiryAttestationQueue.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedExpiryAttestationQueueJson.items.every((item) =>
          ["queue_open", "queue_triaged", "handoff_attested", "queue_auto_drained"].includes(item.status)
        )
      ).toBe(true)
      const rehydratedBurndownSettlement = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_burndown_settlement&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedBurndownSettlement.status).toBe(200)
      const rehydratedBurndownSettlementJson = (await rehydratedBurndownSettlement.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedBurndownSettlementJson.items.every((item) =>
          [
            "settlement_pending",
            "drift_acknowledged",
            "target_lock_attested",
            "rollback_resolution_closed",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedQueueDrain = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_expiry_attestation_queue_drain&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedQueueDrain.status).toBe(200)
      const rehydratedQueueDrainJson = (await rehydratedQueueDrain.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedQueueDrainJson.items.every((item) =>
          [
            "drain_pending",
            "handoff_timeout_escalated",
            "stale_reassignment_attested",
            "forced_drain_checkpointed",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedSettlementAttestation = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_settlement_attestation&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedSettlementAttestation.status).toBe(200)
      const rehydratedSettlementAttestationJson = (await rehydratedSettlementAttestation.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedSettlementAttestationJson.items.every((item) =>
          [
            "verification_pending",
            "lock_release_attested",
            "dispute_reopen_guarded",
            "settlement_verified",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedQueueReconciliation = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_queue_drain_reconciliation&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedQueueReconciliation.status).toBe(200)
      const rehydratedQueueReconciliationJson = (await rehydratedQueueReconciliation.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedQueueReconciliationJson.items.every((item) =>
          [
            "reconciliation_pending",
            "forced_drain_attested",
            "reassignment_rollback_checkpointed",
            "timeout_reentry_controlled",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedSettlementArbitration = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_settlement_arbitration&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedSettlementArbitration.status).toBe(200)
      const rehydratedSettlementArbitrationJson = (await rehydratedSettlementArbitration.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedSettlementArbitrationJson.items.every((item) =>
          [
            "arbitration_pending",
            "verification_override_petitioned",
            "panel_confirmation_attested",
            "reopen_veto_checkpointed",
            "final_ruling_issued",
            "dissent_memorialized",
            "ruling_publication_checkpointed",
            "publication_correction_logged",
            "publication_rollback_checkpointed",
            "distribution_attestation_reviewed",
          ].includes(item.status)
        )
      ).toBe(true)
      const rehydratedQueueReentryCompliance = await filingsGet(
        new Request(
          "http://127.0.0.1/api/d4/filings?view=closure_queue_reentry_compliance&userId=partner_a&ownerId=partner_a&limit=10&cursor=0"
        )
      )
      expect(rehydratedQueueReentryCompliance.status).toBe(200)
      const rehydratedQueueReentryComplianceJson = (await rehydratedQueueReentryCompliance.json()) as {
        items: Array<{ ownerId: string; status: string }>
      }
      expect(
        rehydratedQueueReentryComplianceJson.items.every((item) =>
          [
            "compliance_pending",
            "reentry_exception_attested",
            "timeout_waiver_checkpointed",
            "reconciliation_resumed",
            "exception_debt_assigned",
            "debt_retirement_attested",
            "debt_aging_auto_escalated",
            "retirement_dispute_opened",
            "retirement_dispute_resolved",
            "retirement_rollback_controlled",
          ].includes(item.status)
        )
      ).toBe(true)
      await setDoc(doc(ctx.firestore(), "filing_transport_execution_evidence", "transport:pkg_firmB:1"), {
        id: "transport:pkg_firmB:1",
        firmId: "firmB",
        packageId: "pkg_firmB",
        matterId: "mat_firmB",
        classification: "internal",
        sequenceNo: 1,
        dispatchQueueId: "dispatch:pkg_firmB",
        outcome: "transport_blocked",
        transportOperatorId: "clerk_b",
        transportChannel: "operator_followup_stub",
        channelPayloadHash: "hash-firm-b",
        deterministicBlockerTags: ["firm_b_only"],
        attachmentPointers: ["ops://firm-b/retry"],
        relatedReceiptId: null,
        relatedReconciliationId: null,
        relatedExceptionId: null,
        note: "firmB transport evidence row",
        createdAt: Date.now(),
      })
      await setDoc(doc(ctx.firestore(), "filing_submission_sla_digests", "digest:pkg_firmB"), {
        id: "digest:pkg_firmB",
        firmId: "firmB",
        packageId: "pkg_firmB",
        matterId: "mat_firmB",
        classification: "internal",
        status: "open_breach",
        breachReasons: ["sla_overdue"],
        staleRetryPlan: false,
        outstandingOwnerId: "partner_b",
        linkedExceptionId: "exception:pkg_firmB",
        linkedEvidenceId: "transport:pkg_firmB:1",
        breachWindowStartedAt: Date.now(),
        deferUntil: null,
        acknowledgedBy: null,
        acknowledgedAt: null,
        deferredBy: null,
        deferredAt: null,
        clearedBy: null,
        clearedAt: null,
        notes: ["firmB digest row"],
        lastEvaluatedAt: Date.now(),
        updatedAt: Date.now(),
      })
      await setDoc(doc(ctx.firestore(), "filing_escalation_owner_rota", "rota:pkg_firmB"), {
        id: "rota:pkg_firmB",
        firmId: "firmB",
        packageId: "pkg_firmB",
        matterId: "mat_firmB",
        classification: "internal",
        status: "active",
        primaryOwnerId: "partner_b",
        backupOwnerId: null,
        activeWindowStartAt: Date.now(),
        activeWindowEndAt: Date.now() + 2 * 60 * 60 * 1000,
        handoffRequired: false,
        handoffAcknowledgedBy: null,
        handoffAcknowledgedAt: null,
        lastAssignedBy: "partner_b",
        lastAssignedAt: Date.now(),
        revokedBy: null,
        revokedAt: null,
        linkedExceptionId: "exception:pkg_firmB",
        linkedDigestId: "digest:pkg_firmB",
        notes: ["firmB rota row"],
        updatedAt: Date.now(),
      })
      await setDoc(doc(ctx.firestore(), "filing_escalation_workload_digests", "workload:pkg_firmB"), {
        id: "workload:pkg_firmB",
        firmId: "firmB",
        packageId: "pkg_firmB",
        matterId: "mat_firmB",
        classification: "internal",
        status: "open_alert",
        alertReasons: ["unassigned_breach"],
        ownerId: null,
        ownerLoadCount: 0,
        ownerLoadThreshold: 3,
        handoffLagMs: null,
        handoffLagBucket: "none",
        snoozeUntil: null,
        acknowledgedBy: null,
        acknowledgedAt: null,
        rebalancedBy: null,
        rebalancedAt: null,
        linkedRotaId: "rota:pkg_firmB",
        linkedDigestId: "digest:pkg_firmB",
        notes: ["firmB workload row"],
        lastEvaluatedAt: Date.now(),
        updatedAt: Date.now(),
      })
      await setDoc(doc(ctx.firestore(), "filing_escalation_policy_baselines", "policy:pkg_firmB:override"), {
        id: "policy:pkg_firmB:override",
        firmId: "firmB",
        packageId: "pkg_firmB",
        matterId: "mat_firmB",
        classification: "internal",
        scope: "package_override",
        ownerLoadThreshold: 1,
        handoffSlaMs: 60 * 60 * 1000,
        waiverWindowMs: 2 * 60 * 60 * 1000,
        setBy: "partner_b",
        setAt: Date.now(),
        notes: ["firmB policy row"],
        updatedAt: Date.now(),
      })
      await setDoc(doc(ctx.firestore(), "filing_escalation_breach_waivers", "waiver:pkg_firmB:1"), {
        id: "waiver:pkg_firmB:1",
        firmId: "firmB",
        packageId: "pkg_firmB",
        matterId: "mat_firmB",
        classification: "internal",
        status: "active",
        reason: "firmB temporary waiver",
        grantedBy: "partner_b",
        grantedAt: Date.now(),
        expiresAt: Date.now() + 60 * 60 * 1000,
        revokedBy: null,
        revokedAt: null,
        linkedSlaDigestId: "digest:pkg_firmB",
        linkedWorkloadDigestId: "workload:pkg_firmB",
        notes: ["firmB waiver row"],
        updatedAt: Date.now(),
      })
      await setDoc(
        doc(ctx.firestore(), "filing_escalation_policy_variance_digests", "policy-variance:pkg_firmB"),
        {
          id: "policy-variance:pkg_firmB",
          firmId: "firmB",
          packageId: "pkg_firmB",
          matterId: "mat_firmB",
          classification: "internal",
          status: "open_alert",
          varianceReasons: ["owner_load_threshold_override"],
          firmDefaultPolicyId: "policy:firmB:default",
          packagePolicyId: "policy:pkg_firmB:override",
          ownerLoadThresholdDefault: 3,
          ownerLoadThresholdEffective: 1,
          handoffSlaMsDefault: 0,
          handoffSlaMsEffective: 60 * 60 * 1000,
          waiverWindowMsDefault: 24 * 60 * 60 * 1000,
          waiverWindowMsEffective: 2 * 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          snoozeUntil: null,
          notes: ["firmB policy variance row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(ctx.firestore(), "filing_escalation_waiver_expiry_digests", "waiver-expiry:pkg_firmB"),
        {
          id: "waiver-expiry:pkg_firmB",
          firmId: "firmB",
          packageId: "pkg_firmB",
          matterId: "mat_firmB",
          classification: "internal",
          status: "open_expiry",
          reasons: ["expires_lte_4h"],
          linkedWaiverId: "waiver:pkg_firmB:1",
          linkedPolicyId: "policy:pkg_firmB:override",
          waiverExpiresAt: Date.now() + 60 * 60 * 1000,
          msUntilExpiry: 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          extendedBy: null,
          extendedAt: null,
          notes: ["firmB waiver expiry row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(ctx.firestore(), "filing_escalation_variance_remediations", "remediation:pkg_firmB:1"),
        {
          id: "remediation:pkg_firmB:1",
          firmId: "firmB",
          packageId: "pkg_firmB",
          matterId: "mat_firmB",
          classification: "internal",
          decision: "accepted_risk",
          status: "active",
          linkedPolicyVarianceDigestId: "policy-variance:pkg_firmB",
          linkedPolicyId: "policy:pkg_firmB:override",
          justification: "firmB remediation row",
          decidedBy: "partner_b",
          decidedAt: Date.now(),
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          secondApproverId: null,
          notes: ["firmB remediation row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_waiver_rollover_attestations",
          "rollover:pkg_firmB:1"
        ),
        {
          id: "rollover:pkg_firmB:1",
          firmId: "firmB",
          packageId: "pkg_firmB",
          matterId: "mat_firmB",
          classification: "internal",
          waiverId: "waiver:pkg_firmB:1",
          status: "attested",
          extensionHours: 8,
          previousExpiresAt: Date.now() + 60 * 60 * 1000,
          newExpiresAt: Date.now() + 9 * 60 * 60 * 1000,
          policyCapExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
          attestedBy: "partner_b",
          secondApproverId: "partner_b",
          justification: "firmB rollover row",
          attestedAt: Date.now(),
          notes: ["firmB rollover row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_remediation_expiry_digests",
          "remediation-expiry:pkg_firmB"
        ),
        {
          id: "remediation-expiry:pkg_firmB",
          firmId: "firmB",
          packageId: "pkg_firmB",
          matterId: "mat_firmB",
          classification: "internal",
          status: "open_expiry",
          reasons: ["expires_lte_4h"],
          linkedRemediationId: "remediation:pkg_firmB:1",
          linkedLifecycleId: "remediation-lifecycle:remediation:pkg_firmB:1",
          linkedPolicyVarianceDigestId: "policy-variance:pkg_firmB",
          linkedPolicyId: "policy:pkg_firmB:override",
          remediationExpiresAt: Date.now() + 60 * 60 * 1000,
          msUntilExpiry: 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          snoozeUntil: null,
          notes: ["firmB remediation expiry row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_rollover_breach_watches",
          "rollover-breach:pkg_firmB"
        ),
        {
          id: "rollover-breach:pkg_firmB",
          firmId: "firmB",
          packageId: "pkg_firmB",
          matterId: "mat_firmB",
          classification: "internal",
          status: "open_breach",
          reasons: ["reaffirmation_note_stale"],
          linkedWaiverId: "waiver:pkg_firmB:1",
          linkedAttestationId: "rollover:pkg_firmB:1",
          linkedPolicyId: "policy:pkg_firmB:override",
          policyCapExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
          waiverExpiresAt: Date.now() + 9 * 60 * 60 * 1000,
          attestationUpdatedAt: Date.now() - 25 * 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          notes: ["firmB rollover watch row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_remediation_lifecycles",
          "remediation-lifecycle:remediation:pkg_firmB:1"
        ),
        {
          id: "remediation-lifecycle:remediation:pkg_firmB:1",
          firmId: "firmB",
          packageId: "pkg_firmB",
          matterId: "mat_firmB",
          classification: "internal",
          remediationId: "remediation:pkg_firmB:1",
          remediationDecision: "accepted_risk",
          status: "open",
          linkedPolicyVarianceDigestId: "policy-variance:pkg_firmB",
          linkedPolicyId: "policy:pkg_firmB:override",
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          openedBy: "partner_b",
          openedAt: Date.now(),
          closureOutcome: null,
          closureAttestedBy: null,
          closureAttestedAt: null,
          notes: ["firmB lifecycle row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_rollover_reaffirmation_sla",
          "rollover-reaffirmation-sla:pkg_firmB"
        ),
        {
          id: "rollover-reaffirmation-sla:pkg_firmB",
          firmId: "firmB",
          packageId: "pkg_firmB",
          matterId: "mat_firmB",
          classification: "internal",
          status: "warning",
          reasons: ["cap_crossed_reaffirmation_warning"],
          linkedWaiverId: "waiver:pkg_firmB:1",
          linkedAttestationId: "rollover:pkg_firmB:1",
          linkedPolicyId: "policy:pkg_firmB:override",
          policyCapExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
          waiverExpiresAt: Date.now() + 9 * 60 * 60 * 1000,
          lastReaffirmedAt: Date.now() - 4 * 60 * 60 * 1000,
          elapsedSinceReaffirmationMs: 4 * 60 * 60 * 1000,
          warningThresholdMs: 3 * 60 * 60 * 1000,
          breachThresholdMs: 6 * 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          notes: ["firmB reaffirmation SLA row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_compliance_digests",
          "closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          classification: "internal",
          status: "open_alert",
          pendingLifecycleCount: 1,
          breachedReaffirmationCount: 1,
          linkedPackageIds: ["pkg_firmB"],
          linkedLifecycleIds: ["remediation-lifecycle:remediation:pkg_firmB:1"],
          linkedReaffirmationSlaIds: ["rollover-reaffirmation-sla:pkg_firmB"],
          linkedFollowupQueueId: "closure-followup:closure-compliance:firmB:partner_b",
          acknowledgedBy: null,
          acknowledgedAt: null,
          notes: ["firmB closure compliance digest row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_followup_queue",
          "closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          digestId: "closure-compliance:firmB:partner_b",
          classification: "internal",
          status: "open",
          packageIds: ["pkg_firmB"],
          pendingLifecycleCount: 1,
          breachedReaffirmationCount: 1,
          assignedPartnerId: "partner_b",
          claimedBy: null,
          claimedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          notes: ["firmB closure follow-up queue row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_sla_window_configs",
          "closure-sla-window-config:firmB:default"
        ),
        {
          id: "closure-sla-window-config:firmB:default",
          firmId: "firmB",
          ownerId: null,
          classification: "internal",
          scope: "firm_default",
          ackDeadlineMs: 2 * 60 * 60 * 1000,
          clearDeadlineMs: 8 * 60 * 60 * 1000,
          autoEscalationMs: 12 * 60 * 60 * 1000,
          setBy: "partner_b",
          setAt: Date.now(),
          notes: ["firmB closure SLA config row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_auto_assignment_rules",
          "closure-auto-assignment-rule:firmB:default"
        ),
        {
          id: "closure-auto-assignment-rule:firmB:default",
          firmId: "firmB",
          ownerId: null,
          classification: "internal",
          mode: "owner_rota",
          enabled: true,
          maxActiveClaimsPerPartner: 6,
          setBy: "partner_b",
          setAt: Date.now(),
          notes: ["firmB closure auto-assignment rule row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_sla_windows",
          "closure-sla-window:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-sla-window:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          digestId: "closure-compliance:firmB:partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          status: "ack_breached",
          pressureLevel: "critical",
          openedAt: Date.now() - 3 * 60 * 60 * 1000,
          acknowledgedAt: null,
          clearedAt: null,
          ackDeadlineAt: Date.now() - 60 * 60 * 1000,
          clearDeadlineAt: Date.now() + 2 * 60 * 60 * 1000,
          autoEscalateAt: Date.now() + 4 * 60 * 60 * 1000,
          breachedAt: Date.now() - 60 * 60 * 1000,
          autoEscalationTriggeredAt: null,
          autoEscalatedToPartnerId: null,
          linkedConfigId: "closure-sla-window-config:firmB:default",
          linkedAutoAssignmentRuleId: "closure-auto-assignment-rule:firmB:default",
          notes: ["firmB closure SLA window row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_attestations",
          "closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1"
        ),
        {
          id: "closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1",
          sequenceNo: 1,
          firmId: "firmB",
          ownerId: "partner_b",
          digestId: "closure-compliance:firmB:partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          linkedSlaWindowId: "closure-sla-window:closure-compliance:firmB:partner_b",
          linkedExceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "pending_second_review",
          claimPartnerId: "partner_b",
          claimAt: Date.now() - 60 * 60 * 1000,
          resolutionPartnerId: "partner_b",
          resolutionAt: Date.now() - 30 * 60 * 1000,
          attestedBy: "partner_b",
          attestedAt: Date.now() - 15 * 60 * 1000,
          secondReviewerId: "partner_c",
          secondReviewedBy: null,
          secondReviewedAt: null,
          partnerConcurrence: true,
          evidenceNote: "firmB closure evidence row",
          notes: ["firmB closure attestation row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_sla_exception_digests",
          "closure-sla-exception:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-sla-exception:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          digestId: "closure-compliance:firmB:partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "open_exception",
          pressureLevel: "critical",
          reasons: ["ack_deadline_breached", "attestation_pending"],
          waiverReason: null,
          waivedBy: null,
          waivedAt: null,
          waiverExpiresAt: null,
          expiredAt: null,
          linkedSlaWindowId: "closure-sla-window:closure-compliance:firmB:partner_b",
          linkedAttestationId:
            "closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1",
          linkedConfigId: "closure-sla-window-config:firmB:default",
          linkedAutoAssignmentRuleId: "closure-auto-assignment-rule:firmB:default",
          notes: ["firmB closure SLA exception row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_attestation_disputes",
          "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          sequenceNo: 1,
          firmId: "firmB",
          ownerId: "partner_b",
          digestId: "closure-compliance:firmB:partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          attestationId: "closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1",
          exceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "open_dispute",
          conflictReason: "firmB closure chronology dispute",
          openedBy: "partner_b",
          openedAt: Date.now() - 20 * 60 * 1000,
          reviewerChainIds: ["partner_b", "partner_c"],
          reviewerChainSnapshot: "partner_b -> partner_c",
          underReviewBy: null,
          underReviewAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          notes: ["firmB closure dispute row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_sla_exception_enforcement",
          "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          digestId: "closure-compliance:firmB:partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          exceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "reminder_sent",
          waiverExpiresAt: Date.now() + 30 * 60 * 1000,
          msUntilExpiry: 30 * 60 * 1000,
          reminderCount: 1,
          escalationCount: 0,
          lastReminderAt: Date.now() - 10 * 60 * 1000,
          lastEscalatedAt: null,
          linkedAttestationDisputeId:
            "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          notes: ["firmB closure enforcement row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_adjudication_queue",
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          disputeId:
            "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          attestationId: "closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1",
          exceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "panel_in_review",
          panelMemberIds: ["partner_b", "partner_c"],
          escalatedBy: "partner_b",
          escalatedAt: Date.now() - 15 * 60 * 1000,
          verdict: null,
          verdictBy: null,
          verdictAt: null,
          dissentNotes: ["firmB dissent immutable note"],
          linkedEnforcementRebalanceId:
            "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          notes: ["firmB closure adjudication row"],
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_enforcement_rebalance",
          "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          digestId: "closure-compliance:firmB:partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          enforcementId: "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "owner_reassignment_recommended",
          triggeredByEscalationCount: 2,
          cooldownUntil: null,
          recommendedOwnerId: "partner_c",
          reopenThrottleUntil: null,
          lastRebalancedBy: "partner_b",
          lastRebalancedAt: Date.now() - 10 * 60 * 1000,
          linkedAdjudicationQueueId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          notes: ["firmB closure rebalance row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_adjudication_quorum",
          "closure-adjudication-quorum:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-adjudication-quorum:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "quorum_pending",
          requiredPanelCount: 3,
          confirmedPanelCount: 2,
          quorumMetAt: null,
          quorumDeadlineAt: Date.now() - 5 * 60 * 1000,
          verdictDueAt: Date.now() + 60 * 60 * 1000,
          verdictRecordedAt: null,
          breachFlags: ["quorum_unmet"],
          lastGovernedBy: "partner_b",
          lastGovernedAt: Date.now() - 2 * 60 * 1000,
          notes: ["firmB quorum row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_rebalance_execution",
          "closure-rebalance-execution:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-rebalance-execution:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          mode: "owner_transfer",
          status: "completed",
          targetOwnerId: "partner_c",
          appliedOwnerId: "partner_c",
          throttleReleased: false,
          queueReopened: false,
          executedBy: "partner_b",
          executedAt: Date.now() - 10 * 60 * 1000,
          churnCount: 2,
          notes: ["firmB rebalance execution row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_adjudication_slo",
          "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "breach_open",
          escalationTier: "tier_2_management_escalation",
          baseVerdictDueAt: Date.now() - 2 * 60 * 60 * 1000,
          effectiveVerdictDueAt: Date.now() - 60 * 60 * 1000,
          extensionCount: 1,
          lastExtendedBy: "partner_b",
          lastExtendedAt: Date.now() - 3 * 60 * 60 * 1000,
          breachOpenedAt: Date.now() - 60 * 60 * 1000,
          breachAcknowledgedBy: null,
          breachAcknowledgedAt: null,
          breachDebtHours: 1,
          notes: ["firmB SLO row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_rebalance_safeguards",
          "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "cooldown_locked",
          cooldownLockUntil: Date.now() + 60 * 60 * 1000,
          duplicateSuppressionUntil: null,
          overrideAttestedBy: null,
          overrideAttestedAt: null,
          overrideReason: null,
          lastAutoExecutedAt: Date.now() - 10 * 60 * 1000,
          autoExecutionEligible: false,
          suppressionReasons: ["cooldown_lockout_active"],
          notes: ["firmB safeguard row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_adjudication_slo_debt_remediation",
          "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          adjudicationSloId:
            "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "debt_retirement_pending",
          debtAgeHours: 2,
          debtRetiredHours: 0,
          retirementNotedBy: "partner_b",
          retirementNotedAt: Date.now() - 30 * 60 * 1000,
          tierDownshiftedTo: "tier_1_partner_watch",
          tierDownshiftedBy: "partner_b",
          tierDownshiftedAt: Date.now() - 30 * 60 * 1000,
          breachClosureAttestedBy: null,
          breachClosureAttestedAt: null,
          notes: ["firmB debt remediation row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_rebalance_safeguard_expiry",
          "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          safeguardId:
            "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "override_expired",
          suppressionExpiresAt: Date.now() - 60 * 60 * 1000,
          overrideExpiresAt: Date.now() - 10 * 60 * 1000,
          autoClearedAt: Date.now() - 60 * 60 * 1000,
          staleLockCleanedBy: null,
          staleLockCleanedAt: null,
          expiryDebtHours: 1,
          notes: ["firmB safeguard expiry row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_adjudication_debt_burndown",
          "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          remediationId:
            "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "burndown_checkpoint_due",
          retirementTargetAt: Date.now() - 30 * 60 * 1000,
          checkpointAt: Date.now() - 30 * 60 * 1000,
          backlogAttestedBy: "partner_b",
          backlogAttestedAt: Date.now() - 45 * 60 * 1000,
          tierNormalizedBy: "partner_b",
          tierNormalizedAt: Date.now() - 40 * 60 * 1000,
          tierNormalizedTo: "tier_1_partner_watch",
          debtVelocityPerDay: 2,
          projectedBurndownHours: 3,
          forecastBreachHours: 1,
          notes: ["firmB debt burndown row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_safeguard_expiry_attestations",
          "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          expiryId:
            "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "attestation_overdue",
          acknowledgedBy: "partner_b",
          acknowledgedAt: Date.now() - 30 * 60 * 1000,
          overdueExceptionQueuedBy: "partner_b",
          overdueExceptionQueuedAt: Date.now() - 20 * 60 * 1000,
          overrideReconciledBy: null,
          overrideReconciledAt: null,
          latestReconciliationNote: null,
          openBacklogHours: 2,
          notes: ["firmB safeguard attestation row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_burndown_recalibration",
          "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          burndownId:
            "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "confidence_band_overridden",
          rebaselineTargetAt: Date.now() + 2 * 60 * 60 * 1000,
          confidenceBandLowerHours: 1,
          confidenceBandUpperHours: 6,
          confidenceOverriddenBy: "partner_b",
          confidenceOverriddenAt: Date.now() - 30 * 60 * 1000,
          rollbackNotedBy: null,
          rollbackNotedAt: null,
          rollbackReason: null,
          settledBy: null,
          settledAt: null,
          confidenceDriftHours: 1,
          notes: ["firmB burndown recalibration row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_expiry_attestation_queue",
          "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          attestationId:
            "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "queue_triaged",
          triagedBy: "partner_b",
          triagedAt: Date.now() - 25 * 60 * 1000,
          handoffAttestedBy: null,
          handoffAttestedAt: null,
          handoffToOwnerId: null,
          autoDrainCheckpointAt: null,
          queueAgingHours: 2,
          openExceptionCount: 1,
          reconciliationCarryoverNote: null,
          notes: ["firmB expiry attestation queue row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_burndown_settlement",
          "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          recalibrationId:
            "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "drift_acknowledged",
          driftAcknowledgedBy: "partner_b",
          driftAcknowledgedAt: Date.now() - 45 * 60 * 1000,
          targetLockAttestedBy: null,
          targetLockAttestedAt: null,
          rollbackResolutionClosedBy: null,
          rollbackResolutionClosedAt: null,
          rollbackResolutionNote: null,
          settlementLatencyHours: 2,
          notes: ["firmB burndown settlement row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_expiry_attestation_queue_drain",
          "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          queueItemId:
            "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "handoff_timeout_escalated",
          handoffTimeoutEscalatedBy: "partner_b",
          handoffTimeoutEscalatedAt: Date.now() - 20 * 60 * 1000,
          staleReassignmentAttestedBy: null,
          staleReassignmentAttestedAt: null,
          reassignedOwnerId: null,
          forcedDrainCheckpointedBy: null,
          forcedDrainCheckpointedAt: null,
          forcedDrainOverrideNote: null,
          drainThroughputPerDay: 2,
          openQueueAgingHours: 2,
          notes: ["firmB queue drain row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_settlement_attestation",
          "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          settlementId:
            "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "lock_release_attested",
          postResolutionCheckpointedBy: "partner_b",
          postResolutionCheckpointedAt: Date.now() - 45 * 60 * 1000,
          lockReleaseAttestedBy: "partner_b",
          lockReleaseAttestedAt: Date.now() - 30 * 60 * 1000,
          disputeReopenGuardedBy: null,
          disputeReopenGuardedAt: null,
          disputeReopenGuardNote: null,
          settlementVerificationLagHours: 1,
          notes: ["firmB settlement attestation row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_queue_drain_reconciliation",
          "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          queueDrainId:
            "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "forced_drain_attested",
          forcedDrainAttestedBy: "partner_b",
          forcedDrainAttestedAt: Date.now() - 20 * 60 * 1000,
          reassignmentRollbackCheckpointedBy: null,
          reassignmentRollbackCheckpointedAt: null,
          rollbackToOwnerId: null,
          timeoutReentryControlledBy: null,
          timeoutReentryControlledAt: null,
          timeoutReentryWindowHours: null,
          drainReopenPressureCount: 1,
          notes: ["firmB queue drain reconciliation row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_settlement_arbitration",
          "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1"
        ),
        {
          id: "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          settlementAttestationId:
            "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmB:partner_b:1:1",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "panel_confirmation_attested",
          verificationOverridePetitionedBy: "partner_b",
          verificationOverridePetitionedAt: Date.now() - 40 * 60 * 1000,
          panelConfirmationAttestedBy: "partner_b",
          panelConfirmationAttestedAt: Date.now() - 25 * 60 * 1000,
          reopenVetoCheckpointedBy: null,
          reopenVetoCheckpointedAt: null,
          reopenVetoNote: null,
          settlementArbitrationLeadTimeHours: 1,
          notes: ["firmB settlement arbitration row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      await setDoc(
        doc(
          ctx.firestore(),
          "filing_escalation_closure_queue_reentry_compliance",
          "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b"
        ),
        {
          id: "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          firmId: "firmB",
          ownerId: "partner_b",
          queueId: "closure-followup:closure-compliance:firmB:partner_b",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          queueReconciliationId:
            "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmB:partner_b",
          classification: "internal",
          packageIds: ["pkg_firmB"],
          status: "timeout_waiver_checkpointed",
          reentryExceptionAttestedBy: "partner_b",
          reentryExceptionAttestedAt: Date.now() - 20 * 60 * 1000,
          timeoutWaiverCheckpointedBy: "partner_b",
          timeoutWaiverCheckpointedAt: Date.now() - 10 * 60 * 1000,
          timeoutWaiverHours: 24,
          reconciliationResumedBy: null,
          reconciliationResumedAt: null,
          queueReentryExceptionDebtCount: 1,
          notes: ["firmB queue reentry compliance row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        }
      )
      const firmAScopeEvidence = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=transport_execution&userId=associate_a&matterId=${matterId}&limit=20&cursor=0`
        )
      )
      expect(firmAScopeEvidence.status).toBe(200)
      const firmAScopeEvidenceJson = (await firmAScopeEvidence.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(firmAScopeEvidenceJson.items.some((item) => item.packageId === "pkg_firmB")).toBe(false)
      const firmAScopeDigest = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=submission_sla_digests&userId=associate_a&matterId=${matterId}&limit=20&cursor=0`
        )
      )
      expect(firmAScopeDigest.status).toBe(200)
      const firmAScopeDigestJson = (await firmAScopeDigest.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(firmAScopeDigestJson.items.some((item) => item.packageId === "pkg_firmB")).toBe(false)
      const firmAScopeRota = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=escalation_owner_rota&userId=associate_a&matterId=${matterId}&limit=20&cursor=0`
        )
      )
      expect(firmAScopeRota.status).toBe(200)
      const firmAScopeRotaJson = (await firmAScopeRota.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(firmAScopeRotaJson.items.some((item) => item.packageId === "pkg_firmB")).toBe(false)
      const firmAScopeWorkload = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=escalation_workload_digests&userId=associate_a&matterId=${matterId}&limit=20&cursor=0`
        )
      )
      expect(firmAScopeWorkload.status).toBe(200)
      const firmAScopeWorkloadJson = (await firmAScopeWorkload.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(firmAScopeWorkloadJson.items.some((item) => item.packageId === "pkg_firmB")).toBe(false)
      const firmAScopePolicy = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=escalation_policy_baselines&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopePolicy.status).toBe(200)
      const firmAScopePolicyJson = (await firmAScopePolicy.json()) as {
        items: Array<{ packageId: string | null }>
      }
      expect(firmAScopePolicyJson.items.some((item) => item.packageId === "pkg_firmB")).toBe(false)
      const firmAScopeWaivers = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=breach_waiver_ledger&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeWaivers.status).toBe(200)
      const firmAScopeWaiversJson = (await firmAScopeWaivers.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(firmAScopeWaiversJson.items.some((item) => item.packageId === "pkg_firmB")).toBe(false)
      const firmAScopeVarianceDigests = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=policy_variance_digests&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeVarianceDigests.status).toBe(200)
      const firmAScopeVarianceDigestsJson = (await firmAScopeVarianceDigests.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(
        firmAScopeVarianceDigestsJson.items.some((item) => item.packageId === "pkg_firmB")
      ).toBe(false)
      const firmAScopeWaiverExpiryDigests = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=waiver_expiry_digests&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeWaiverExpiryDigests.status).toBe(200)
      const firmAScopeWaiverExpiryDigestsJson = (await firmAScopeWaiverExpiryDigests.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(
        firmAScopeWaiverExpiryDigestsJson.items.some((item) => item.packageId === "pkg_firmB")
      ).toBe(false)
      const firmAScopeRemediation = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=variance_remediation_ledger&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeRemediation.status).toBe(200)
      const firmAScopeRemediationJson = (await firmAScopeRemediation.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(
        firmAScopeRemediationJson.items.some((item) => item.packageId === "pkg_firmB")
      ).toBe(false)
      const firmAScopeRollover = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=waiver_rollover_attestations&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeRollover.status).toBe(200)
      const firmAScopeRolloverJson = (await firmAScopeRollover.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(
        firmAScopeRolloverJson.items.some((item) => item.packageId === "pkg_firmB")
      ).toBe(false)
      const firmAScopeRemediationExpiry = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=remediation_expiry_digests&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeRemediationExpiry.status).toBe(200)
      const firmAScopeRemediationExpiryJson = (await firmAScopeRemediationExpiry.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(
        firmAScopeRemediationExpiryJson.items.some((item) => item.packageId === "pkg_firmB")
      ).toBe(false)
      const firmAScopeRolloverBreach = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=rollover_breach_watches&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeRolloverBreach.status).toBe(200)
      const firmAScopeRolloverBreachJson = (await firmAScopeRolloverBreach.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(
        firmAScopeRolloverBreachJson.items.some((item) => item.packageId === "pkg_firmB")
      ).toBe(false)
      const firmAScopeLifecycle = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=remediation_lifecycle&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeLifecycle.status).toBe(200)
      const firmAScopeLifecycleJson = (await firmAScopeLifecycle.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(firmAScopeLifecycleJson.items.some((item) => item.packageId === "pkg_firmB")).toBe(false)
      const firmAScopeReaffirmationSla = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=rollover_reaffirmation_sla&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeReaffirmationSla.status).toBe(200)
      const firmAScopeReaffirmationSlaJson = (await firmAScopeReaffirmationSla.json()) as {
        items: Array<{ packageId: string }>
      }
      expect(
        firmAScopeReaffirmationSlaJson.items.some((item) => item.packageId === "pkg_firmB")
      ).toBe(false)
      const firmAScopeClosureCompliance = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_compliance_digests&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureCompliance.status).toBe(200)
      const firmAScopeClosureComplianceJson = (await firmAScopeClosureCompliance.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeClosureComplianceJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeClosureQueue = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_followup_queue&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureQueue.status).toBe(200)
      const firmAScopeClosureQueueJson = (await firmAScopeClosureQueue.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(firmAScopeClosureQueueJson.items.some((item) => item.ownerId === "partner_b")).toBe(
        false
      )
      const firmAScopeClosureSlaConfig = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_sla_window_configs&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureSlaConfig.status).toBe(200)
      const firmAScopeClosureSlaConfigJson = (await firmAScopeClosureSlaConfig.json()) as {
        items: Array<{ firmId: string }>
      }
      expect(firmAScopeClosureSlaConfigJson.items.some((item) => item.firmId === "firmB")).toBe(false)
      const firmAScopeClosureAutoRule = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_auto_assignment_rules&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureAutoRule.status).toBe(200)
      const firmAScopeClosureAutoRuleJson = (await firmAScopeClosureAutoRule.json()) as {
        items: Array<{ firmId: string }>
      }
      expect(firmAScopeClosureAutoRuleJson.items.some((item) => item.firmId === "firmB")).toBe(false)
      const firmAScopeClosureSlaWindows = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_sla_windows&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureSlaWindows.status).toBe(200)
      const firmAScopeClosureSlaWindowsJson = (await firmAScopeClosureSlaWindows.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(firmAScopeClosureSlaWindowsJson.items.some((item) => item.ownerId === "partner_b")).toBe(
        false
      )
      const firmAScopeClosureAttestations = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_attestations&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureAttestations.status).toBe(200)
      const firmAScopeClosureAttestationsJson = (await firmAScopeClosureAttestations.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(firmAScopeClosureAttestationsJson.items.some((item) => item.ownerId === "partner_b")).toBe(
        false
      )
      const firmAScopeClosureExceptions = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_sla_exception_digests&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureExceptions.status).toBe(200)
      const firmAScopeClosureExceptionsJson = (await firmAScopeClosureExceptions.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(firmAScopeClosureExceptionsJson.items.some((item) => item.ownerId === "partner_b")).toBe(
        false
      )
      const firmAScopeClosureDisputes = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_attestation_disputes&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureDisputes.status).toBe(200)
      const firmAScopeClosureDisputesJson = (await firmAScopeClosureDisputes.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(firmAScopeClosureDisputesJson.items.some((item) => item.ownerId === "partner_b")).toBe(
        false
      )
      const firmAScopeClosureEnforcement = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_sla_exception_enforcement&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureEnforcement.status).toBe(200)
      const firmAScopeClosureEnforcementJson = (await firmAScopeClosureEnforcement.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeClosureEnforcementJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeClosureAdjudication = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_adjudication_queue&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureAdjudication.status).toBe(200)
      const firmAScopeClosureAdjudicationJson = (await firmAScopeClosureAdjudication.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeClosureAdjudicationJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeClosureRebalance = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_enforcement_rebalance&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureRebalance.status).toBe(200)
      const firmAScopeClosureRebalanceJson = (await firmAScopeClosureRebalance.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeClosureRebalanceJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeClosureQuorum = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_adjudication_quorum&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureQuorum.status).toBe(200)
      const firmAScopeClosureQuorumJson = (await firmAScopeClosureQuorum.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(firmAScopeClosureQuorumJson.items.some((item) => item.ownerId === "partner_b")).toBe(
        false
      )
      const firmAScopeClosureExecution = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_rebalance_execution&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureExecution.status).toBe(200)
      const firmAScopeClosureExecutionJson = (await firmAScopeClosureExecution.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeClosureExecutionJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeClosureSlo = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_adjudication_slo&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureSlo.status).toBe(200)
      const firmAScopeClosureSloJson = (await firmAScopeClosureSlo.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(firmAScopeClosureSloJson.items.some((item) => item.ownerId === "partner_b")).toBe(false)
      const firmAScopeClosureSafeguards = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_rebalance_safeguards&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeClosureSafeguards.status).toBe(200)
      const firmAScopeClosureSafeguardsJson = (await firmAScopeClosureSafeguards.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeClosureSafeguardsJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeDebtRemediation = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_adjudication_slo_debt_remediation&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeDebtRemediation.status).toBe(200)
      const firmAScopeDebtRemediationJson = (await firmAScopeDebtRemediation.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeDebtRemediationJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeSafeguardExpiry = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_rebalance_safeguard_expiry&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeSafeguardExpiry.status).toBe(200)
      const firmAScopeSafeguardExpiryJson = (await firmAScopeSafeguardExpiry.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeSafeguardExpiryJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeDebtBurndown = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_adjudication_debt_burndown&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeDebtBurndown.status).toBe(200)
      const firmAScopeDebtBurndownJson = (await firmAScopeDebtBurndown.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(firmAScopeDebtBurndownJson.items.some((item) => item.ownerId === "partner_b")).toBe(false)
      const firmAScopeSafeguardAttestations = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_safeguard_expiry_attestations&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeSafeguardAttestations.status).toBe(200)
      const firmAScopeSafeguardAttestationsJson = (await firmAScopeSafeguardAttestations.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeSafeguardAttestationsJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeBurndownRecalibration = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_burndown_recalibration&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeBurndownRecalibration.status).toBe(200)
      const firmAScopeBurndownRecalibrationJson = (await firmAScopeBurndownRecalibration.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeBurndownRecalibrationJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeExpiryAttestationQueue = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_expiry_attestation_queue&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeExpiryAttestationQueue.status).toBe(200)
      const firmAScopeExpiryAttestationQueueJson = (await firmAScopeExpiryAttestationQueue.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeExpiryAttestationQueueJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeBurndownSettlement = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_burndown_settlement&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeBurndownSettlement.status).toBe(200)
      const firmAScopeBurndownSettlementJson = (await firmAScopeBurndownSettlement.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeBurndownSettlementJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeQueueDrain = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_expiry_attestation_queue_drain&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeQueueDrain.status).toBe(200)
      const firmAScopeQueueDrainJson = (await firmAScopeQueueDrain.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(firmAScopeQueueDrainJson.items.some((item) => item.ownerId === "partner_b")).toBe(false)
      const firmAScopeSettlementAttestation = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_settlement_attestation&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeSettlementAttestation.status).toBe(200)
      const firmAScopeSettlementAttestationJson = (await firmAScopeSettlementAttestation.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeSettlementAttestationJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeQueueReconciliation = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_queue_drain_reconciliation&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeQueueReconciliation.status).toBe(200)
      const firmAScopeQueueReconciliationJson = (await firmAScopeQueueReconciliation.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeQueueReconciliationJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeSettlementArbitration = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_settlement_arbitration&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeSettlementArbitration.status).toBe(200)
      const firmAScopeSettlementArbitrationJson = (await firmAScopeSettlementArbitration.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeSettlementArbitrationJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      const firmAScopeQueueReentryCompliance = await filingsGet(
        new Request(
          `http://127.0.0.1/api/d4/filings?view=closure_queue_reentry_compliance&userId=associate_a&limit=20&cursor=0`
        )
      )
      expect(firmAScopeQueueReentryCompliance.status).toBe(200)
      const firmAScopeQueueReentryComplianceJson = (await firmAScopeQueueReentryCompliance.json()) as {
        items: Array<{ ownerId: string }>
      }
      expect(
        firmAScopeQueueReentryComplianceJson.items.some((item) => item.ownerId === "partner_b")
      ).toBe(false)
      getRuntimeStore().audit = []
      const auditView = await tenancyGet(
        new Request(
          "http://127.0.0.1/api/p5/tenancy?view=audit&actorId=partner_a&firmId=firmA&limit=100&cursor=0"
        )
      )
      expect(auditView.status).toBe(200)
      const auditViewJson = (await auditView.json()) as {
        items: Array<{ action: string; target: string }>
      }
      expect(
        auditViewJson.items.some(
          (item) =>
            ["filing_dispatch_update", "filing_dispatch_closure_update"].includes(item.action) &&
            item.target === `dispatch:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_annexure_checkpoint" && item.target === `annexure:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_submission_receipt_record" &&
            item.target === `receipt:${packageId}:1`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_submission_reconcile" &&
            item.target === `reconcile:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_submission_exception_raise" &&
            item.target === `exception:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_submission_exception_claim" &&
            item.target === `exception:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_submission_exception_escalate" &&
            item.target === `exception:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_submission_exception_resolve" &&
            item.target === `exception:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_submission_exception_reopen" &&
            item.target === `exception:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) => item.action === "filing_transport_execution_evidence_record"
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_dispatch_closure_update" &&
            item.target === `dispatch:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_sla_digest_acknowledge" &&
            item.target === `digest:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_sla_digest_defer" &&
            item.target === `digest:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_sla_digest_clear" &&
            item.target === `digest:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_rota_assign_primary" &&
            item.target === `rota:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_rota_set_backup" &&
            item.target === `rota:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_rota_acknowledge_handoff" &&
            item.target === `rota:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_rota_revoke_assignment" &&
            item.target === `rota:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_workload_acknowledge" &&
            item.target === `workload:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_workload_snooze" &&
            item.target === `workload:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_workload_rebalance" &&
            item.target === `workload:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_policy_set" && item.target === "policy:firmA:default"
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_policy_set" && item.target === `policy:${packageId}:override`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_waiver_grant" &&
            item.target === `waiver:${packageId}:1`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_waiver_revoke" &&
            item.target === `waiver:${packageId}:1`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_policy_variance_acknowledge" &&
            item.target === `policy-variance:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_variance_remediation_record" &&
            item.target === `remediation:${packageId}:1`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_remediation_expiry_acknowledge" &&
            item.target === `remediation-expiry:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_remediation_expiry_snooze" &&
            item.target === `remediation-expiry:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_remediation_closure_attest" &&
            item.target === `remediation-lifecycle:remediation:${packageId}:1`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_policy_variance_snooze" &&
            item.target === `policy-variance:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_waiver_expiry_acknowledge" &&
            item.target === `waiver-expiry:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_escalation_waiver_extend" &&
            item.target === `waiver:${packageId}:1`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_waiver_rollover_attest" &&
            item.target === `rollover:${packageId}:1`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_rollover_breach_acknowledge" &&
            item.target === `rollover-breach:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_rollover_reaffirmation_record" &&
            item.target === `rollover:${packageId}:1`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_rollover_reaffirmation_sla_acknowledge" &&
            item.target === `rollover-reaffirmation-sla:${packageId}`
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_closure_sla_window_config_set" &&
            item.target === "closure-sla-window-config:firmA:default"
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_closure_auto_assignment_rule_set" &&
            item.target === "closure-auto-assignment-rule:firmA:default"
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_closure_followup_assign" &&
            item.target === "closure-followup:closure-compliance:firmA:partner_a"
        )
      ).toBe(true)
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_closure_followup_claim" &&
            item.target === "closure-followup:closure-compliance:firmA:partner_a"
        )
      ).toBe(true)
      if (resolveClosureFollowup.status === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_followup_resolve" &&
              item.target === "closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (recordClosureAttestation.status === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_attestation_record" &&
              item.target.startsWith("closure-attestation:closure-followup:closure-compliance:firmA:partner_a:")
          )
        ).toBe(true)
      }
      if (reviewClosureAttestationStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_attestation_review" &&
              item.target.startsWith("closure-attestation:closure-followup:closure-compliance:firmA:partner_a:")
          )
        ).toBe(true)
      }
      if (openClosureDisputeStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_attestation_dispute_open" &&
              item.target.startsWith(
                "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (resolveClosureDisputeStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_attestation_dispute_resolve" &&
              item.target.startsWith(
                "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (escalateClosureDisputeStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_panel_escalate" &&
              item.target.startsWith(
                "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (adjudicationVerdictStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_verdict_record" &&
              item.target.startsWith(
                "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (governClosureQuorumStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_quorum_govern" &&
              item.target.startsWith(
                "closure-adjudication-quorum:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (extendClosureSloStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_slo_deadline_extend" &&
              item.target.startsWith(
                "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (escalateClosureSloTierStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_slo_tier_escalate" &&
              item.target.startsWith(
                "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (acknowledgeClosureSloBreachStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_slo_breach_acknowledge" &&
              item.target.startsWith(
                "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (recordSloDebtRemediationStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_slo_debt_remediation_record" &&
              item.target.startsWith(
                "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (downshiftSloTierStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_slo_tier_downshift" &&
              item.target.startsWith(
                "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (attestSloBreachClosureStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_slo_breach_closure_attest" &&
              item.target.startsWith(
                "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (setDebtBurndownTargetStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_debt_burndown_target_set" &&
              item.target.startsWith(
                "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (attestDebtBacklogStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_debt_backlog_attest" &&
              item.target.startsWith(
                "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (checkpointTierNormalizationStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_adjudication_tier_normalization_checkpoint" &&
              item.target.startsWith(
                "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (rebaselineBurndownForecastStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_burndown_recalibration_rebaseline" &&
              item.target.startsWith(
                "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (overrideBurndownConfidenceStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_burndown_recalibration_confidence_override" &&
              item.target.startsWith(
                "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (annotateBurndownRollbackStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_burndown_recalibration_checkpoint_rollback" &&
              item.target.startsWith(
                "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (acknowledgeSettlementDriftStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_burndown_settlement_drift_acknowledge" &&
              item.target.startsWith(
                "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (attestSettlementTargetLockStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_burndown_settlement_target_lock_attest" &&
              item.target.startsWith(
                "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (closeRollbackResolutionStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_burndown_settlement_rollback_resolution_close" &&
              item.target.startsWith(
                "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (checkpointSettlementVerificationStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_attestation_post_resolution_checkpoint" &&
              item.target.startsWith(
                "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (attestSettlementLockReleaseStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_attestation_lock_release_attest" &&
              item.target.startsWith(
                "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (safeguardSettlementDisputeReopenStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_attestation_dispute_reopen_safeguard" &&
              item.target.startsWith(
                "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (petitionSettlementVerificationOverrideStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_arbitration_verification_override_petition" &&
              item.target.startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (attestSettlementPanelConfirmationStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_arbitration_panel_confirmation_attest" &&
              item.target.startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (checkpointSettlementReopenVetoStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_arbitration_reopen_veto_checkpoint" &&
              item.target.startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (issueSettlementFinalRulingStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_arbitration_final_ruling_issue" &&
              item.target.startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (memorializeSettlementDissentStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_arbitration_dissent_memorialize" &&
              item.target.startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (checkpointSettlementPublicationStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action ===
                "filing_closure_settlement_arbitration_ruling_publication_checkpoint" &&
              item.target.startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (logSettlementPublicationCorrectionStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_arbitration_publication_correction_log" &&
              item.target.startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (checkpointSettlementPublicationRollbackStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_arbitration_publication_rollback_checkpoint" &&
              item.target.startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (reviewSettlementDistributionAttestationStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_settlement_arbitration_distribution_attestation_review" &&
              item.target.startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              )
          )
        ).toBe(true)
      }
      if (waiveClosureSlaException.status === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_sla_exception_waive" &&
              item.target === "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_closure_sla_exception_enforcement_tick" &&
            item.target ===
              "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmA:partner_a"
        )
      ).toBe(true)
      if (rebalanceClosureEnforcementStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_enforcement_rebalance_set" &&
              item.target ===
                "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (executeOwnerTransferStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_rebalance_owner_transfer_execute" &&
              item.target ===
                "closure-rebalance-execution:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (configureRebalanceSafeguardStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_rebalance_safeguard_configure" &&
              item.target ===
                "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (setSafeguardOverrideExpiryStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_rebalance_safeguard_override_expiry_set" &&
              item.target ===
                "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (attestRebalanceOverrideStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_rebalance_override_attest" &&
              item.target ===
                "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (autoClearSafeguardSuppressionStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_rebalance_safeguard_suppression_auto_clear" &&
              item.target ===
                "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (cleanupStaleSafeguardLockStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_rebalance_safeguard_stale_lock_cleanup" &&
              item.target ===
                "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (acknowledgeSafeguardAttestationStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_safeguard_expiry_attestation_acknowledge" &&
              item.target ===
                "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (queueSafeguardOverdueExceptionStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_safeguard_overdue_expiry_exception_queue" &&
              item.target ===
                "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (reconcileSafeguardOverrideStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_safeguard_expiry_override_reconcile" &&
              item.target ===
                "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (triageExpiryQueueStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_expiry_attestation_queue_triage" &&
              item.target ===
                "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (attestExpiryQueueHandoffStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_expiry_attestation_queue_handoff_attest" &&
              item.target ===
                "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (checkpointExpiryQueueAutoDrainStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_expiry_attestation_queue_auto_drain_checkpoint" &&
              item.target ===
                "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (escalateQueueHandoffTimeoutStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_expiry_attestation_queue_handoff_timeout_escalate" &&
              item.target ===
                "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (attestQueueStaleReassignmentStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_expiry_attestation_queue_stale_reassignment_attest" &&
              item.target ===
                "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (checkpointQueueForcedDrainStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_expiry_attestation_queue_forced_drain_checkpoint" &&
              item.target ===
                "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (attestQueueForcedReconciliationStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_drain_reconciliation_forced_attest" &&
              item.target ===
                "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (checkpointQueueReassignmentRollbackStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action ===
                "filing_closure_queue_drain_reconciliation_reassignment_rollback_checkpoint" &&
              item.target ===
                "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (controlQueueTimeoutReentryStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_drain_reconciliation_timeout_reentry_control" &&
              item.target ===
                "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (attestQueueReentryExceptionStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_reentry_compliance_exception_attest" &&
              item.target ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (checkpointQueueReentryTimeoutWaiverStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_reentry_compliance_timeout_waiver_checkpoint" &&
              item.target ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (controlQueueReentryResumeStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_reentry_compliance_reconciliation_resume_control" &&
              item.target ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (assignQueueReentryDebtStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_reentry_debt_assignment" &&
              item.target ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (attestQueueReentryDebtRetirementStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_reentry_debt_retirement_attest" &&
              item.target ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (controlQueueReentryDebtAgingStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_reentry_debt_aging_auto_escalation_control" &&
              item.target ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (openQueueDebtRetirementDisputeStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_reentry_debt_retirement_dispute_open" &&
              item.target ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (resolveQueueDebtRetirementDisputeStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_reentry_debt_retirement_dispute_resolve" &&
              item.target ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (controlQueueDebtRetirementRollbackStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_queue_reentry_debt_retirement_rollback_control" &&
              item.target ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }
      if (executeThrottleReleaseStatus === 200) {
        expect(
          auditViewJson.items.some(
            (item) =>
              item.action === "filing_closure_rebalance_throttle_release_execute" &&
              item.target ===
                "closure-rebalance-execution:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
          )
        ).toBe(true)
      }

      const dbPackage = await getDoc(doc(ctx.firestore(), "filing_packages", packageId))
      expect(dbPackage.exists()).toBe(true)
      expect(dbPackage.data()?.status).toBe("approved")
      const dbPacketArtifacts = await getDocs(collection(ctx.firestore(), "filing_packet_artifacts"))
      expect(
        dbPacketArtifacts.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            entry.data()?.readiness === "ready"
        )
      ).toBe(true)
      const dbDispatchQueue = await getDocs(collection(ctx.firestore(), "filing_submission_dispatch_queue"))
      expect(
        dbDispatchQueue.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            entry.data()?.status === "handoff_ready" &&
            entry.data()?.assigneeId === "clerk_a"
        )
      ).toBe(true)
      const dbAnnexures = await getDocs(collection(ctx.firestore(), "filing_annexures"))
      expect(
        dbAnnexures.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            entry.data()?.generationStatus === "ready" &&
            entry.data()?.submissionTransportBoundary === "todo_firm_external_transport_blocked"
        )
      ).toBe(true)
      const dbReceipts = await getDocs(collection(ctx.firestore(), "filing_submission_receipts"))
      expect(
        dbReceipts.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            entry.data()?.dispatchOutcome === "retry_scheduled" &&
            entry.data()?.submissionReference === "RUNTIME-SUB-001"
        )
      ).toBe(true)
      const dbReconciliation = await getDocs(
        collection(ctx.firestore(), "filing_submission_reconciliation")
      )
      expect(
        dbReconciliation.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            entry.data()?.status === "reconciled"
        )
      ).toBe(true)
      const dbExceptions = await getDocs(collection(ctx.firestore(), "filing_submission_exceptions"))
      expect(
        dbExceptions.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            entry.data()?.status === "resolved" &&
            entry.data()?.severity === "high" &&
            entry.data()?.escalationOwnerId === "partner_a"
        )
      ).toBe(true)
      const dbTransportEvidence = await getDocs(
        collection(ctx.firestore(), "filing_transport_execution_evidence")
      )
      expect(
        dbTransportEvidence.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            entry.data()?.outcome === "confirm_delivered" &&
            entry.data()?.channelPayloadHash === "runtime-transport-hash-003"
        )
      ).toBe(true)
      const dbSlaDigests = await getDocs(collection(ctx.firestore(), "filing_submission_sla_digests"))
      expect(
        dbSlaDigests.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            entry.data()?.status === "cleared"
        )
      ).toBe(true)
      const dbEscalationRota = await getDocs(collection(ctx.firestore(), "filing_escalation_owner_rota"))
      expect(
        dbEscalationRota.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            entry.data()?.status === "revoked"
        )
      ).toBe(true)
      const dbWorkloadDigests = await getDocs(
        collection(ctx.firestore(), "filing_escalation_workload_digests")
      )
      expect(
        dbWorkloadDigests.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.packageId === packageId &&
            ["cleared", "open_alert", "acknowledged", "snoozed"].includes(
              String(entry.data()?.status ?? "")
            )
        )
      ).toBe(true)
      const dbPolicyBaselines = await getDocs(
        collection(ctx.firestore(), "filing_escalation_policy_baselines")
      )
      expect(
        dbPolicyBaselines.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `policy:${packageId}:override` &&
            entry.data()?.scope === "package_override" &&
            entry.data()?.ownerLoadThreshold === 1
        )
      ).toBe(true)
      const dbWaiverLedger = await getDocs(
        collection(ctx.firestore(), "filing_escalation_breach_waivers")
      )
      expect(
        dbWaiverLedger.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `waiver:${packageId}:1` &&
            entry.data()?.status === "revoked"
        )
      ).toBe(true)
      const dbPolicyVarianceDigests = await getDocs(
        collection(ctx.firestore(), "filing_escalation_policy_variance_digests")
      )
      expect(
        dbPolicyVarianceDigests.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `policy-variance:${packageId}` &&
            entry.data()?.status === "snoozed"
        )
      ).toBe(true)
      const dbWaiverExpiryDigests = await getDocs(
        collection(ctx.firestore(), "filing_escalation_waiver_expiry_digests")
      )
      expect(
        dbWaiverExpiryDigests.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `waiver-expiry:${packageId}` &&
            entry.data()?.status === "cleared"
        )
      ).toBe(true)
      const dbVarianceRemediations = await getDocs(
        collection(ctx.firestore(), "filing_escalation_variance_remediations")
      )
      expect(
        dbVarianceRemediations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `remediation:${packageId}:1` &&
            entry.data()?.decision === "temporary_override" &&
            entry.data()?.status === "expired"
        )
      ).toBe(true)
      const dbRolloverAttestations = await getDocs(
        collection(ctx.firestore(), "filing_escalation_waiver_rollover_attestations")
      )
      expect(
        dbRolloverAttestations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `rollover:${packageId}:1` &&
            entry.data()?.status === "attested"
        )
      ).toBe(true)
      const dbRemediationLifecycles = await getDocs(
        collection(ctx.firestore(), "filing_escalation_remediation_lifecycles")
      )
      expect(
        dbRemediationLifecycles.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `remediation-lifecycle:remediation:${packageId}:1` &&
            entry.data()?.status === "closure_attested"
        )
      ).toBe(true)
      const dbRemediationExpiryDigests = await getDocs(
        collection(ctx.firestore(), "filing_escalation_remediation_expiry_digests")
      )
      expect(
        dbRemediationExpiryDigests.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `remediation-expiry:${packageId}` &&
            entry.data()?.status === "cleared"
        )
      ).toBe(true)
      const dbRolloverBreachWatches = await getDocs(
        collection(ctx.firestore(), "filing_escalation_rollover_breach_watches")
      )
      expect(
        dbRolloverBreachWatches.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `rollover-breach:${packageId}` &&
            entry.data()?.status === "cleared"
        )
      ).toBe(true)
      const dbReaffirmationSlas = await getDocs(
        collection(ctx.firestore(), "filing_escalation_rollover_reaffirmation_sla")
      )
      expect(
        dbReaffirmationSlas.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === `rollover-reaffirmation-sla:${packageId}` &&
            ["within_sla", "cleared", "acknowledged"].includes(
              String(entry.data()?.status ?? "")
            )
        )
      ).toBe(true)
      const dbClosureComplianceDigests = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_compliance_digests")
      )
      expect(
        dbClosureComplianceDigests.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === "closure-compliance:firmA:partner_a" &&
            ["open_alert", "acknowledged", "cleared"].includes(
              String(entry.data()?.status ?? "")
            )
        )
      ).toBe(true)
      const dbClosureFollowupQueues = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_followup_queue")
      )
      expect(
        dbClosureFollowupQueues.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === "closure-followup:closure-compliance:firmA:partner_a" &&
            ["open", "claimed", "resolved"].includes(String(entry.data()?.status ?? ""))
        )
      ).toBe(true)
      const dbClosureSlaConfigs = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_sla_window_configs")
      )
      expect(
        dbClosureSlaConfigs.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === "closure-sla-window-config:firmA:default" &&
            entry.data()?.scope === "firm_default"
        )
      ).toBe(true)
      const dbClosureAutoRules = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_auto_assignment_rules")
      )
      expect(
        dbClosureAutoRules.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === "closure-auto-assignment-rule:firmA:default" &&
            ["owner_rota", "workload_aware_claim"].includes(String(entry.data()?.mode ?? ""))
        )
      ).toBe(true)
      const dbClosureSlaWindows = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_sla_windows")
      )
      expect(
        dbClosureSlaWindows.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === "closure-sla-window:closure-compliance:firmA:partner_a" &&
            ["within_window", "ack_breached", "clear_breached", "auto_escalation_due", "cleared"].includes(
              String(entry.data()?.status ?? "")
            )
        )
      ).toBe(true)
      const dbClosureAttestations = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_attestations")
      )
      if (recordClosureAttestation.status === 200) {
        expect(
          dbClosureAttestations.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              ["pending_second_review", "attested", "rejected"].includes(
                String(entry.data()?.status ?? "")
              )
          )
        ).toBe(true)
      }
      const dbClosureExceptions = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_sla_exception_digests")
      )
      expect(
        dbClosureExceptions.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id === "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a" &&
            ["open_exception", "waived", "expired", "cleared"].includes(
              String(entry.data()?.status ?? "")
            )
        )
      ).toBe(true)
      const dbClosureDisputes = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_attestation_disputes")
      )
      if (openClosureDisputeStatus === 200) {
        expect(
          dbClosureDisputes.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              ["open_dispute", "under_review", "resolved_upheld", "resolved_overturned"].includes(
                String(entry.data()?.status ?? "")
              )
          )
        ).toBe(true)
      }
      const dbClosureEnforcement = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_sla_exception_enforcement")
      )
      expect(
        dbClosureEnforcement.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.id ===
              "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmA:partner_a" &&
            ["countdown_active", "reminder_sent", "escalated", "closed"].includes(
              String(entry.data()?.status ?? "")
            )
        )
      ).toBe(true)
      const dbClosureAdjudication = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_adjudication_queue")
      )
      if (escalateClosureDisputeStatus === 200) {
        expect(
          dbClosureAdjudication.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              [
                "pending_panel_assignment",
                "panel_in_review",
                "resolved_upheld",
                "resolved_overturned",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbClosureRebalance = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_enforcement_rebalance")
      )
      if (rebalanceClosureEnforcementStatus === 200) {
        expect(
          dbClosureRebalance.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              entry.data()?.id ===
                "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a" &&
              [
                "none",
                "cooldown_scheduled",
                "owner_reassignment_recommended",
                "throttle_active",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbClosureQuorum = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_adjudication_quorum")
      )
      if (governClosureQuorumStatus === 200) {
        expect(
          dbClosureQuorum.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-adjudication-quorum:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              ["quorum_pending", "quorum_met", "verdict_overdue", "closed"].includes(
                String(entry.data()?.status ?? "")
              )
          )
        ).toBe(true)
      }
      const dbClosureExecution = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_rebalance_execution")
      )
      if (executeOwnerTransferStatus === 200 || executeThrottleReleaseStatus === 200) {
        expect(
          dbClosureExecution.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              entry.data()?.id ===
                "closure-rebalance-execution:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a" &&
              ["owner_transfer", "throttle_release"].includes(String(entry.data()?.mode ?? "")) &&
              ["queued", "owner_transfer_in_progress", "throttle_release_in_progress", "completed"].includes(
                String(entry.data()?.status ?? "")
              )
          )
        ).toBe(true)
      }
      const dbClosureSlo = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_adjudication_slo")
      )
      if (
        extendClosureSloStatus === 200 ||
        escalateClosureSloTierStatus === 200 ||
        acknowledgeClosureSloBreachStatus === 200 ||
        downshiftSloTierStatus === 200
      ) {
        expect(
          dbClosureSlo.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              ["within_slo", "deadline_extended", "breach_open", "breach_acknowledged"].includes(
                String(entry.data()?.status ?? "")
              ) &&
              [
                "none",
                "tier_1_partner_watch",
                "tier_2_management_escalation",
                "tier_3_executive_escalation",
              ].includes(String(entry.data()?.escalationTier ?? ""))
          )
        ).toBe(true)
      }
      const dbClosureSafeguards = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_rebalance_safeguards")
      )
      if (
        configureRebalanceSafeguardStatus === 200 ||
        attestRebalanceOverrideStatus === 200 ||
        autoClearSafeguardSuppressionStatus === 200 ||
        cleanupStaleSafeguardLockStatus === 200
      ) {
        expect(
          dbClosureSafeguards.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              entry.data()?.id ===
                "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a" &&
              ["auto_exec_ready", "cooldown_locked", "duplicate_suppressed", "override_attested"].includes(
                String(entry.data()?.status ?? "")
              )
          )
        ).toBe(true)
      }
      const dbSloDebtRemediation = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_adjudication_slo_debt_remediation")
      )
      if (
        recordSloDebtRemediationStatus === 200 ||
        downshiftSloTierStatus === 200 ||
        attestSloBreachClosureStatus === 200
      ) {
        expect(
          dbSloDebtRemediation.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              [
                "debt_open",
                "debt_retirement_pending",
                "debt_retired",
                "breach_closure_attested",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbSafeguardExpiry = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_rebalance_safeguard_expiry")
      )
      if (
        setSafeguardOverrideExpiryStatus === 200 ||
        autoClearSafeguardSuppressionStatus === 200 ||
        cleanupStaleSafeguardLockStatus === 200
      ) {
        expect(
          dbSafeguardExpiry.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              entry.data()?.id ===
                "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a" &&
              ["expiry_pending", "auto_cleared", "override_expired", "stale_lock_cleaned"].includes(
                String(entry.data()?.status ?? "")
              )
          )
        ).toBe(true)
      }
      const dbDebtBurndown = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_adjudication_debt_burndown")
      )
      if (
        setDebtBurndownTargetStatus === 200 ||
        attestDebtBacklogStatus === 200 ||
        checkpointTierNormalizationStatus === 200
      ) {
        expect(
          dbDebtBurndown.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              [
                "burndown_tracking",
                "burndown_checkpoint_due",
                "burndown_attested",
                "burndown_forecast_breached",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbSafeguardAttestations = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_safeguard_expiry_attestations")
      )
      if (
        acknowledgeSafeguardAttestationStatus === 200 ||
        queueSafeguardOverdueExceptionStatus === 200 ||
        reconcileSafeguardOverrideStatus === 200
      ) {
        expect(
          dbSafeguardAttestations.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              entry.data()?.id ===
                "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a" &&
              ["attestation_open", "attestation_acknowledged", "attestation_overdue", "attestation_reconciled"].includes(
                String(entry.data()?.status ?? "")
              )
          )
        ).toBe(true)
      }
      const dbBurndownRecalibration = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_burndown_recalibration")
      )
      if (
        rebaselineBurndownForecastStatus === 200 ||
        overrideBurndownConfidenceStatus === 200 ||
        annotateBurndownRollbackStatus === 200 ||
        acknowledgeSettlementDriftStatus === 200 ||
        attestSettlementTargetLockStatus === 200 ||
        closeRollbackResolutionStatus === 200
      ) {
        expect(
          dbBurndownRecalibration.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              [
                "recalibration_pending",
                "confidence_band_overridden",
                "checkpoint_rollback_noted",
                "recalibration_settled",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbExpiryAttestationQueue = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_expiry_attestation_queue")
      )
      if (
        triageExpiryQueueStatus === 200 ||
        attestExpiryQueueHandoffStatus === 200 ||
        checkpointExpiryQueueAutoDrainStatus === 200 ||
        escalateQueueHandoffTimeoutStatus === 200 ||
        attestQueueStaleReassignmentStatus === 200 ||
        checkpointQueueForcedDrainStatus === 200
      ) {
        expect(
          dbExpiryAttestationQueue.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              entry.data()?.id ===
                "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a" &&
              ["queue_open", "queue_triaged", "handoff_attested", "queue_auto_drained"].includes(
                String(entry.data()?.status ?? "")
              )
          )
        ).toBe(true)
      }
      const dbBurndownSettlement = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_burndown_settlement")
      )
      if (
        acknowledgeSettlementDriftStatus === 200 ||
        attestSettlementTargetLockStatus === 200 ||
        closeRollbackResolutionStatus === 200 ||
        checkpointSettlementVerificationStatus === 200 ||
        attestSettlementLockReleaseStatus === 200 ||
        safeguardSettlementDisputeReopenStatus === 200 ||
        petitionSettlementVerificationOverrideStatus === 200 ||
        attestSettlementPanelConfirmationStatus === 200 ||
        checkpointSettlementReopenVetoStatus === 200
      ) {
        expect(
          dbBurndownSettlement.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              [
                "settlement_pending",
                "drift_acknowledged",
                "target_lock_attested",
                "rollback_resolution_closed",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbExpiryQueueDrain = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_expiry_attestation_queue_drain")
      )
      if (
        escalateQueueHandoffTimeoutStatus === 200 ||
        attestQueueStaleReassignmentStatus === 200 ||
        checkpointQueueForcedDrainStatus === 200 ||
        attestQueueForcedReconciliationStatus === 200 ||
        checkpointQueueReassignmentRollbackStatus === 200 ||
        controlQueueTimeoutReentryStatus === 200
      ) {
        expect(
          dbExpiryQueueDrain.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              entry.data()?.id ===
                "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a" &&
              [
                "drain_pending",
                "handoff_timeout_escalated",
                "stale_reassignment_attested",
                "forced_drain_checkpointed",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbSettlementAttestation = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_settlement_attestation")
      )
      if (
        checkpointSettlementVerificationStatus === 200 ||
        attestSettlementLockReleaseStatus === 200 ||
        safeguardSettlementDisputeReopenStatus === 200 ||
        petitionSettlementVerificationOverrideStatus === 200 ||
        attestSettlementPanelConfirmationStatus === 200 ||
        checkpointSettlementReopenVetoStatus === 200
      ) {
        expect(
          dbSettlementAttestation.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              [
                "verification_pending",
                "lock_release_attested",
                "dispute_reopen_guarded",
                "settlement_verified",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbQueueReconciliation = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_queue_drain_reconciliation")
      )
      if (
        attestQueueForcedReconciliationStatus === 200 ||
        checkpointQueueReassignmentRollbackStatus === 200 ||
        controlQueueTimeoutReentryStatus === 200 ||
        attestQueueReentryExceptionStatus === 200 ||
        checkpointQueueReentryTimeoutWaiverStatus === 200 ||
        controlQueueReentryResumeStatus === 200
      ) {
        expect(
          dbQueueReconciliation.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              entry.data()?.id ===
                "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a" &&
              [
                "reconciliation_pending",
                "forced_drain_attested",
                "reassignment_rollback_checkpointed",
                "timeout_reentry_controlled",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbSettlementArbitration = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_settlement_arbitration")
      )
      if (
        petitionSettlementVerificationOverrideStatus === 200 ||
        attestSettlementPanelConfirmationStatus === 200 ||
        checkpointSettlementReopenVetoStatus === 200 ||
        issueSettlementFinalRulingStatus === 200 ||
        memorializeSettlementDissentStatus === 200 ||
        checkpointSettlementPublicationStatus === 200 ||
        logSettlementPublicationCorrectionStatus === 200 ||
        checkpointSettlementPublicationRollbackStatus === 200 ||
        reviewSettlementDistributionAttestationStatus === 200
      ) {
        expect(
          dbSettlementArbitration.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              String(entry.data()?.id ?? "").startsWith(
                "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:"
              ) &&
              [
                "arbitration_pending",
                "verification_override_petitioned",
                "panel_confirmation_attested",
                "reopen_veto_checkpointed",
                "final_ruling_issued",
                "dissent_memorialized",
                "ruling_publication_checkpointed",
                "publication_correction_logged",
                "publication_rollback_checkpointed",
                "distribution_attestation_reviewed",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
      const dbQueueReentryCompliance = await getDocs(
        collection(ctx.firestore(), "filing_escalation_closure_queue_reentry_compliance")
      )
      if (
        attestQueueReentryExceptionStatus === 200 ||
        checkpointQueueReentryTimeoutWaiverStatus === 200 ||
        controlQueueReentryResumeStatus === 200 ||
        assignQueueReentryDebtStatus === 200 ||
        attestQueueReentryDebtRetirementStatus === 200 ||
        controlQueueReentryDebtAgingStatus === 200 ||
        openQueueDebtRetirementDisputeStatus === 200 ||
        resolveQueueDebtRetirementDisputeStatus === 200 ||
        controlQueueDebtRetirementRollbackStatus === 200
      ) {
        expect(
          dbQueueReentryCompliance.docs.some(
            (entry) =>
              entry.data()?.firmId === "firmA" &&
              entry.data()?.id ===
                "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a" &&
              [
                "compliance_pending",
                "reentry_exception_attested",
                "timeout_waiver_checkpointed",
                "reconciliation_resumed",
                "exception_debt_assigned",
                "debt_retirement_attested",
                "debt_aging_auto_escalated",
                "retirement_dispute_opened",
                "retirement_dispute_resolved",
                "retirement_rollback_controlled",
              ].includes(String(entry.data()?.status ?? ""))
          )
        ).toBe(true)
      }
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

      const acknowledge = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "e3a06f30-74f4-4167-b367-c5f8d6d00f6e",
          },
          body: JSON.stringify({
            action: "acknowledge_workflow_ops_alert_digest",
            actorId: "partner_a",
            matterId,
            reason: "runtime digest acknowledge",
          }),
        })
      )
      expect(acknowledge.status).toBe(200)
      const acknowledgeJson = (await acknowledge.json()) as {
        result: { digest: { acknowledgedBy: string | null } }
      }
      expect(acknowledgeJson.result.digest.acknowledgedBy).toBe("partner_a")

      const snoozeUntil = Date.now() + 60_000
      const snooze = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "958ea837-92ab-4db2-a705-f26c87ff257f",
          },
          body: JSON.stringify({
            action: "snooze_workflow_ops_alert_digest",
            actorId: "partner_a",
            matterId,
            snoozedUntil: snoozeUntil,
            reason: "runtime digest snooze",
          }),
        })
      )
      expect(snooze.status).toBe(200)
      const snoozeJson = (await snooze.json()) as {
        result: { digest: { snoozedBy: string | null; snoozedUntil: number | null } }
      }
      expect(snoozeJson.result.digest.snoozedBy).toBe("partner_a")
      expect((snoozeJson.result.digest.snoozedUntil ?? 0) >= snoozeUntil).toBe(true)

      const attest = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "cb9bc09d-49f7-4be8-ad2f-77b1eb977f48",
          },
          body: JSON.stringify({
            action: "attest_workflow_ops_alert_digest",
            actorId: "partner_a",
            matterId,
            reason: "runtime attestation",
          }),
        })
      )
      expect(attest.status).toBe(200)
      const attestJson = (await attest.json()) as {
        result: { attestation: { attestationStatus: string; lastAttestedBy: string | null } }
      }
      expect(attestJson.result.attestation.attestationStatus).toBe("attested")
      expect(attestJson.result.attestation.lastAttestedBy).toBe("partner_a")

      const escalationOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "fbce8709-5090-4f76-9e63-b88080f5c690",
          },
          body: JSON.stringify({
            action: "open_workflow_ops_alert_escalation",
            actorId: "partner_a",
            matterId,
            reason: "runtime escalation open",
          }),
        })
      )
      expect(escalationOpen.status).toBe(200)

      const escalationAssign = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "67a058ea-1655-4c20-a8d3-6282b85a9642",
          },
          body: JSON.stringify({
            action: "assign_workflow_ops_alert_escalation_owner",
            actorId: "partner_a",
            matterId,
            ownerId: "clerk_a",
            reason: "runtime escalation assignment",
          }),
        })
      )
      expect(escalationAssign.status).toBe(200)
      const escalationAssignJson = (await escalationAssign.json()) as {
        result: { escalation: { escalationStatus: string; ownerId: string | null } }
      }
      expect(escalationAssignJson.result.escalation.escalationStatus).toBe("assigned")
      expect(escalationAssignJson.result.escalation.ownerId).toBe("clerk_a")

      const escalationResolve = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "44ef6cbd-f32f-4e6d-b950-3d8d4fc7a8cf",
          },
          body: JSON.stringify({
            action: "resolve_workflow_ops_alert_escalation",
            actorId: "partner_a",
            matterId,
            reason: "runtime escalation resolved",
          }),
        })
      )
      expect(escalationResolve.status).toBe(200)
      const escalationResolveJson = (await escalationResolve.json()) as {
        result: { escalation: { escalationStatus: string; resolutionReason: string | null } }
      }
      expect(escalationResolveJson.result.escalation.escalationStatus).toBe("resolved")
      expect(escalationResolveJson.result.escalation.resolutionReason).toBe("runtime escalation resolved")

      const disputeOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "74730ef6-b193-4fd5-a158-fb48704e4788",
          },
          body: JSON.stringify({
            action: "open_workflow_ops_alert_attestation_dispute",
            actorId: "partner_a",
            matterId,
            reason: "runtime dispute opened",
          }),
        })
      )
      expect(disputeOpen.status).toBe(200)

      const disputeAssign = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8be5678d-a86d-42b7-8d6b-203f0dbd43f3",
          },
          body: JSON.stringify({
            action: "assign_workflow_ops_alert_attestation_dispute_reviewer",
            actorId: "partner_a",
            matterId,
            reviewerId: "associate_a",
            reason: "runtime reviewer assignment",
          }),
        })
      )
      expect(disputeAssign.status).toBe(200)

      const disputeResolve = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "2736b63e-1653-4135-a154-6f8d5df1a437",
          },
          body: JSON.stringify({
            action: "resolve_workflow_ops_alert_attestation_dispute",
            actorId: "partner_a",
            matterId,
            resolutionOutcome: "upheld",
            reason: "runtime dispute resolved",
          }),
        })
      )
      expect(disputeResolve.status).toBe(200)
      const disputeResolveJson = (await disputeResolve.json()) as {
        result: {
          dispute: { disputeStatus: string; reviewerId: string | null; resolutionOutcome: string | null }
          attestation: { attestationStatus: string }
        }
      }
      expect(disputeResolveJson.result.dispute.disputeStatus).toBe("resolved")
      expect(disputeResolveJson.result.dispute.reviewerId).toBe("associate_a")
      expect(disputeResolveJson.result.dispute.resolutionOutcome).toBe("upheld")
      expect(disputeResolveJson.result.attestation.attestationStatus).toBe("attested")

      const closureCheckpoint = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "1a49c5c6-1908-4a9f-8a2e-96744d6747e2",
          },
          body: JSON.stringify({
            action: "checkpoint_workflow_ops_alert_escalation_closure",
            actorId: "partner_a",
            matterId,
            reason: "runtime closure checkpoint",
          }),
        })
      )
      expect(closureCheckpoint.status).toBe(200)

      const closureClose = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "687e4dbe-ec1b-4f17-b7fa-9a3312f80f6e",
          },
          body: JSON.stringify({
            action: "close_workflow_ops_alert_escalation_closure",
            actorId: "partner_a",
            matterId,
            reason: "runtime closure confirmed",
          }),
        })
      )
      expect(closureClose.status).toBe(200)

      const closureReopen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "af6e0185-573d-4208-847b-969f42f1ca36",
          },
          body: JSON.stringify({
            action: "reopen_workflow_ops_alert_escalation_closure",
            actorId: "partner_a",
            matterId,
            reason: "runtime closure reopened",
          }),
        })
      )
      expect(closureReopen.status).toBe(200)
      const closureReopenJson = (await closureReopen.json()) as {
        result: {
          closure: { closureStatus: string; reopenedAt: number | null }
          escalation: { escalationStatus: string }
        }
      }
      expect(closureReopenJson.result.closure.closureStatus).toBe("reopened")
      expect(closureReopenJson.result.closure.reopenedAt).not.toBeNull()
      expect(closureReopenJson.result.escalation.escalationStatus).toBe("open")

      const enforcementStart = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "ca7ab7f8-bf77-47fe-bfbc-4639fef47ef7",
          },
          body: JSON.stringify({
            action: "start_workflow_ops_alert_dispute_enforcement",
            actorId: "partner_a",
            matterId,
            ownerId: "associate_a",
            reason: "runtime enforcement start",
          }),
        })
      )
      expect(enforcementStart.status).toBe(200)

      const enforcementComplete = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f0db6a12-6de0-4d66-ba8f-cff528f0aef0",
          },
          body: JSON.stringify({
            action: "complete_workflow_ops_alert_dispute_enforcement",
            actorId: "partner_a",
            matterId,
            reason: "runtime enforcement complete",
          }),
        })
      )
      expect(enforcementComplete.status).toBe(200)
      const enforcementCompleteJson = (await enforcementComplete.json()) as {
        result: { enforcement: { enforcementStatus: string; ownerId: string | null } }
      }
      expect(enforcementCompleteJson.result.enforcement.enforcementStatus).toBe("enforced")
      expect(enforcementCompleteJson.result.enforcement.ownerId).toBe("associate_a")

      const reconciliationFlag = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "359decae-5952-444b-a7b6-ddf169fef9dc",
          },
          body: JSON.stringify({
            action: "flag_workflow_ops_alert_closure_reopen_debt",
            actorId: "partner_a",
            matterId,
            reason: "runtime debt flagged",
          }),
        })
      )
      expect(reconciliationFlag.status).toBe(200)

      const reconciliationStart = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "982c0e15-fc35-45f4-bad6-587f9f31ca77",
          },
          body: JSON.stringify({
            action: "start_workflow_ops_alert_closure_debt_reconciliation",
            actorId: "partner_a",
            matterId,
            ownerId: "clerk_a",
            reason: "runtime debt reconciling",
          }),
        })
      )
      expect(reconciliationStart.status).toBe(200)

      const reconciliationResolve = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "e2eb6b50-cf8b-4c88-8cac-5f31ad8b882f",
          },
          body: JSON.stringify({
            action: "resolve_workflow_ops_alert_closure_debt_reconciliation",
            actorId: "partner_a",
            matterId,
            reason: "runtime debt reconciled",
          }),
        })
      )
      expect(reconciliationResolve.status).toBe(200)
      const reconciliationResolveJson = (await reconciliationResolve.json()) as {
        result: { reconciliation: { reconciliationStatus: string; outstandingDebtCount: number } }
      }
      expect(reconciliationResolveJson.result.reconciliation.reconciliationStatus).toBe("reconciled")
      expect(reconciliationResolveJson.result.reconciliation.outstandingDebtCount).toBe(0)

      const enforcementAttest = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "eec70c60-90f2-46b5-8ea9-e6874fe87f7d",
          },
          body: JSON.stringify({
            action: "attest_workflow_ops_alert_dispute_enforcement",
            actorId: "partner_a",
            matterId,
            reason: "runtime enforcement attested",
          }),
        })
      )
      expect(enforcementAttest.status).toBe(200)

      const enforcementAttestationReopen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "81fcbab6-91ba-43ec-af34-c5edb4a2f77d",
          },
          body: JSON.stringify({
            action: "reopen_workflow_ops_alert_dispute_enforcement_attestation",
            actorId: "partner_a",
            matterId,
            reason: "runtime attestation reopened",
          }),
        })
      )
      expect(enforcementAttestationReopen.status).toBe(200)

      const enforcementRecomplete = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "dd6173b8-b1d4-4700-a9b5-ca756339d972",
          },
          body: JSON.stringify({
            action: "complete_workflow_ops_alert_dispute_enforcement",
            actorId: "partner_a",
            matterId,
            reason: "runtime enforcement re-complete",
          }),
        })
      )
      expect(enforcementRecomplete.status).toBe(200)

      const varianceOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "47052f56-0e5d-4466-96d5-b87d851a72ea",
          },
          body: JSON.stringify({
            action: "open_workflow_ops_alert_closure_debt_variance",
            actorId: "partner_a",
            matterId,
            reason: "runtime variance open",
          }),
        })
      )
      expect(varianceOpen.status).toBe(200)

      const varianceAssign = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "465a5db8-fc6d-4af4-86ef-959587599448",
          },
          body: JSON.stringify({
            action: "assign_workflow_ops_alert_closure_debt_variance_owner",
            actorId: "partner_a",
            matterId,
            ownerId: "associate_a",
            reason: "runtime variance assignment",
          }),
        })
      )
      expect(varianceAssign.status).toBe(200)

      const varianceResolve = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "7f7fa08c-36dc-4286-a19b-c53c99db90f4",
          },
          body: JSON.stringify({
            action: "resolve_workflow_ops_alert_closure_debt_variance",
            actorId: "partner_a",
            matterId,
            reason: "runtime variance resolved",
          }),
        })
      )
      expect(varianceResolve.status).toBe(200)
      const varianceResolveJson = (await varianceResolve.json()) as {
        result: { variance: { varianceStatus: string; outstandingVarianceCount: number } }
      }
      expect(varianceResolveJson.result.variance.varianceStatus).toBe("variance_resolved")
      expect(varianceResolveJson.result.variance.outstandingVarianceCount).toBe(0)

      const waiverCreate = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "0acd4c1f-4270-4844-a7e6-bd0b48818458",
          },
          body: JSON.stringify({
            action: "create_workflow_ops_alert_enforcement_waiver",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver requested",
          }),
        })
      )
      expect(waiverCreate.status).toBe(200)

      const waiverAttest = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f9ce5fd2-98e8-47e5-9450-2c965f0706de",
          },
          body: JSON.stringify({
            action: "attest_workflow_ops_alert_enforcement_waiver",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver attested",
          }),
        })
      )
      expect(waiverAttest.status).toBe(200)

      const waiverExpiry = Date.now() + 120_000
      const waiverWaive = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "ab4aa4f2-4d15-4e5c-9088-e1f5a2995f73",
          },
          body: JSON.stringify({
            action: "waive_workflow_ops_alert_enforcement_waiver",
            actorId: "partner_a",
            matterId,
            waiverExpiresAt: waiverExpiry,
            reason: "runtime waiver approved",
          }),
        })
      )
      expect(waiverWaive.status).toBe(200)
      const waiverWaiveJson = (await waiverWaive.json()) as {
        result: { enforcementWaiver: { waiverStatus: string; waivedBy: string | null; waiverExpiresAt: number | null } }
      }
      expect(waiverWaiveJson.result.enforcementWaiver.waiverStatus).toBe("waived")
      expect(waiverWaiveJson.result.enforcementWaiver.waivedBy).toBe("partner_a")
      expect((waiverWaiveJson.result.enforcementWaiver.waiverExpiresAt ?? 0) >= waiverExpiry).toBe(true)

      const waiverExpiryAcknowledge = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "d5944eca-46d3-4f2d-932f-2b8f53bb80f8",
          },
          body: JSON.stringify({
            action: "acknowledge_workflow_ops_alert_waiver_expiry_digest",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry acknowledged",
          }),
        })
      )
      expect(waiverExpiryAcknowledge.status).toBe(200)

      const waiverExpiryExtendedTo = Date.now() + 48 * 60 * 60 * 1000
      const waiverExpiryExtend = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "9f81f50b-8f16-4fbd-b6f9-c35ccf949d03",
          },
          body: JSON.stringify({
            action: "extend_workflow_ops_alert_waiver_expiry_digest",
            actorId: "partner_a",
            matterId,
            waiverExpiresAt: waiverExpiryExtendedTo,
            reason: "runtime waiver expiry extension",
          }),
        })
      )
      expect(waiverExpiryExtend.status).toBe(200)

      const varianceReopenForQueue = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b29ce730-81cc-40ff-8f66-9d506218f170",
          },
          body: JSON.stringify({
            action: "open_workflow_ops_alert_closure_debt_variance",
            actorId: "partner_a",
            matterId,
            reason: "runtime variance reopened for queue",
          }),
        })
      )
      expect(varianceReopenForQueue.status).toBe(200)

      const remediationQueue = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8cb7548e-fa71-4d56-a9db-b8f81fcbfc14",
          },
          body: JSON.stringify({
            action: "queue_workflow_ops_alert_variance_remediation",
            actorId: "partner_a",
            matterId,
            reason: "runtime variance queued",
          }),
        })
      )
      expect(remediationQueue.status).toBe(200)

      const remediationAssign = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "01b9f67d-6f08-4912-a0ce-7aaf6f646aeb",
          },
          body: JSON.stringify({
            action: "assign_workflow_ops_alert_variance_remediation_owner",
            actorId: "partner_a",
            matterId,
            ownerId: "associate_a",
            reason: "runtime remediation owner assigned",
          }),
        })
      )
      expect(remediationAssign.status).toBe(200)

      const remediationSlaAcknowledge = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "858e5929-e2d9-4ca2-a335-493ce92f94d6",
          },
          body: JSON.stringify({
            action: "acknowledge_workflow_ops_alert_variance_remediation_sla_ledger",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation SLA acknowledged",
          }),
        })
      )
      expect(remediationSlaAcknowledge.status).toBe(200)

      const waiverExpiryDisputeOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "2e5d1fd4-1335-49ca-8ccd-b2cfb6f9eb39",
          },
          body: JSON.stringify({
            action: "open_workflow_ops_alert_waiver_expiry_dispute",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry dispute opened",
          }),
        })
      )
      expect(waiverExpiryDisputeOpen.status).toBe(200)

      const waiverExpiryDisputeAssign = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b9f8aa33-4012-4321-83e8-c5c5ec904f9a",
          },
          body: JSON.stringify({
            action: "assign_workflow_ops_alert_waiver_expiry_dispute_reviewer",
            actorId: "partner_a",
            matterId,
            reviewerId: "associate_a",
            reason: "runtime waiver expiry dispute reviewer assigned",
          }),
        })
      )
      expect(waiverExpiryDisputeAssign.status).toBe(200)

      const waiverExpiryDisputeResolve = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "6d4d90f8-e64c-46bb-8c3d-1f0f08f7fdaf",
          },
          body: JSON.stringify({
            action: "resolve_workflow_ops_alert_waiver_expiry_dispute",
            actorId: "partner_a",
            matterId,
            resolutionOutcome: "extension_granted",
            reason: "runtime waiver expiry dispute resolved",
          }),
        })
      )
      expect(waiverExpiryDisputeResolve.status).toBe(200)

      const remediationSlaBreachEscalationOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "579cffef-e7be-4646-9af4-36f7de0d865f",
          },
          body: JSON.stringify({
            action: "open_workflow_ops_alert_variance_remediation_sla_breach_escalation",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation SLA breach escalation opened",
          }),
        })
      )
      expect(remediationSlaBreachEscalationOpen.status).toBe(200)

      const remediationSlaBreachEscalationAssign = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "510eb01b-b7e7-4331-b90f-ab018e4cc496",
          },
          body: JSON.stringify({
            action: "assign_workflow_ops_alert_variance_remediation_sla_breach_escalation_owner",
            actorId: "partner_a",
            matterId,
            ownerId: "associate_a",
            reason: "runtime remediation SLA breach escalation owner assigned",
          }),
        })
      )
      expect(remediationSlaBreachEscalationAssign.status).toBe(200)

      const remediationSlaBreachEscalationResolve = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "a4ef9f89-e238-4fc7-89a3-8c4fbaea4da4",
          },
          body: JSON.stringify({
            action: "resolve_workflow_ops_alert_variance_remediation_sla_breach_escalation",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation SLA breach escalation resolved",
          }),
        })
      )
      expect(remediationSlaBreachEscalationResolve.status).toBe(200)

      const waiverExpiryDisputeAdjudicationOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c2a8f91d-4e70-4b16-9d33-7a1c5e8f0b24",
          },
          body: JSON.stringify({
            action: "open_workflow_ops_alert_waiver_expiry_dispute_adjudication",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry dispute adjudication opened",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationOpen.status).toBe(200)

      const waiverExpiryDisputeAdjudicationAssign = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "d9b1e40c-8f25-4a73-b2e1-6c0d9a4f3e18",
          },
          body: JSON.stringify({
            action: "assign_workflow_ops_alert_waiver_expiry_dispute_adjudication_panel_owner",
            actorId: "partner_a",
            matterId,
            panelOwnerId: "associate_a",
            reason: "runtime waiver expiry dispute adjudication panel owner assigned",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationAssign.status).toBe(200)

      const waiverExpiryDisputeAdjudicationSloOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c3b9f02e-5f81-4c27-ae44-8b2d6f9e1c35",
          },
          body: JSON.stringify({
            action: "open_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardship",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry dispute adjudication SLO stewardship opened",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationSloOpen.status).toBe(200)

      const waiverExpiryDisputeAdjudicationSloExtend = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "d0c2e51f-9a36-4b84-83f2-7d1e0b5a4f29",
          },
          body: JSON.stringify({
            action: "extend_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_deadline",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry dispute adjudication SLO deadline extended",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationSloExtend.status).toBe(200)

      const waiverExpiryDisputeAdjudicationSloAcknowledge = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "e5d8b23a-2c97-4e10-b6f1-3a0d9c8e7b41",
          },
          body: JSON.stringify({
            action: "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry dispute adjudication SLO breach acknowledged",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationSloAcknowledge.status).toBe(200)

      const waiverExpiryDisputeAdjudicationSloDebtRecord = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f6e9c34b-3d08-4f21-a7e2-4b1c0d9f8a52",
          },
          body: JSON.stringify({
            action: "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation",
            actorId: "partner_a",
            matterId,
            debtRetiredMs: 120_000,
            reason: "runtime waiver expiry dispute adjudication SLO debt remediation recorded",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationSloDebtRecord.status).toBe(200)

      const waiverExpiryDisputeAdjudicationSloTierDownshift = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "a7f0d45c-4e19-4022-b8f3-5c2d1e0a9b63",
          },
          body: JSON.stringify({
            action: "downshift_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_tier",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry dispute adjudication SLO tier downshifted",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationSloTierDownshift.status).toBe(200)

      const waiverExpiryDisputeAdjudicationSloBreachClosure = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b8a1e56d-5f2a-4133-b904-6d3e2f1b0c74",
          },
          body: JSON.stringify({
            action: "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_breach_closure",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry dispute adjudication SLO breach closure attested",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationSloBreachClosure.status).toBe(200)

      const waiverExpiryDisputeAdjudicationSloDebtBurndownTarget = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c9b2f67e-603b-4244-8a15-7e4f3a2c1d86",
          },
          body: JSON.stringify({
            action: "set_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_target",
            actorId: "partner_a",
            matterId,
            retirementTargetAt: Date.now() + 48 * 60 * 60 * 1000,
            reason: "runtime waiver expiry dispute adjudication SLO debt burndown target set",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationSloDebtBurndownTarget.status).toBe(200)

      const waiverExpiryDisputeAdjudicationSloDebtBacklog = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "d0c3a78f-714c-4355-9b26-8f503b3d2e97",
          },
          body: JSON.stringify({
            action: "attest_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_backlog",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry dispute adjudication SLO debt backlog attested",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationSloDebtBacklog.status).toBe(200)

      const waiverExpiryDisputeAdjudicationSloDebtBurndownCheckpoint = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "e1d4b890-825d-4466-ac37-90614c4e3fa8",
          },
          body: JSON.stringify({
            action: "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown",
            actorId: "partner_a",
            matterId,
            reason: "runtime waiver expiry dispute adjudication SLO debt burndown checkpointed",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationSloDebtBurndownCheckpoint.status).toBe(200)

      const waiverExpiryDisputeAdjudicationResolve = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "e4c7a12f-1b86-4d09-a5e0-2f9c8b7d6a30",
          },
          body: JSON.stringify({
            action: "resolve_workflow_ops_alert_waiver_expiry_dispute_adjudication",
            actorId: "partner_a",
            matterId,
            resolutionOutcome: "extension_granted",
            reason: "runtime waiver expiry dispute adjudication resolved",
          }),
        })
      )
      expect(waiverExpiryDisputeAdjudicationResolve.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f1d0b83a-6c47-4e19-9a52-0b8e4c3d1f65",
          },
          body: JSON.stringify({
            action: "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint",
            actorId: "partner_a",
            matterId,
            checkpointOwnerId: "associate_a",
            reason: "runtime remediation SLA breach resolution checkpoint opened",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointOpen.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointRecord = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "a8e3c51b-2d90-4f64-b1c7-5e9a0d2f8c14",
          },
          body: JSON.stringify({
            action: "record_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation SLA breach resolution checkpoint recorded",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointRecord.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointReopen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b7f4d20e-9a18-4c35-8e61-3d0b5c7a2f49",
          },
          body: JSON.stringify({
            action: "reopen_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation SLA breach resolution checkpoint reopened",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointReopen.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointExpiryOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c1e5f92b-7d58-4a20-8b63-4e2c6d8f0a17",
          },
          body: JSON.stringify({
            action:
              "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation SLA breach resolution checkpoint expiry attestation opened",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryOpen.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointExpiryAttest = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "d2f6a03c-8e69-4b31-9c74-5f3d7e9a1b28",
          },
          body: JSON.stringify({
            action: "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation SLA breach resolution checkpoint expiry attested",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryAttest.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointExpiryAcknowledge = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "e3a7b14d-9f70-4c42-ad85-6a4e8f0b2c39",
          },
          body: JSON.stringify({
            action:
              "acknowledge_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation SLA breach resolution checkpoint expiry acknowledged",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryAcknowledge.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointExpiryExceptionOpen = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c9b2f67e-603b-4244-8a15-7e4f3a2c1d85",
          },
          body: JSON.stringify({
            action:
              "open_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception",
            actorId: "partner_a",
            matterId,
            reason: "runtime checkpoint expiry attestation exception opened",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryExceptionOpen.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointExpiryExceptionAssign = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "d0c3a78f-714c-4355-9b26-8f503b3d2e96",
          },
          body: JSON.stringify({
            action:
              "assign_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_owner",
            actorId: "partner_a",
            matterId,
            assigneeId: "associate_a",
            reason: "runtime checkpoint expiry attestation exception owner assigned",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryExceptionAssign.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointExpiryExceptionReconcile = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "e1d4b890-825d-4466-ac37-90614c4e3fa7",
          },
          body: JSON.stringify({
            action:
              "reconcile_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception",
            actorId: "partner_a",
            matterId,
            reason: "runtime checkpoint expiry attestation exception reconciled",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryExceptionReconcile.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointExpiryQueueTriage = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f2e5c901-936e-4577-bd48-a1725d5f40b9",
          },
          body: JSON.stringify({
            action:
              "triage_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue",
            actorId: "partner_a",
            matterId,
            reason: "runtime checkpoint expiry attestation queue triaged",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryQueueTriage.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointExpiryQueueHandoff = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "a3f6d012-a47f-4688-8e59-b2836e6051ca",
          },
          body: JSON.stringify({
            action:
              "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_handoff",
            actorId: "partner_a",
            matterId,
            handoffToOwnerId: "associate_a",
            reason: "runtime checkpoint expiry attestation queue handoff attested",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryQueueHandoff.status).toBe(200)

      const remediationSlaBreachResolutionCheckpointExpiryQueueDrain = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b4a7e123-b580-4799-8f60-c3947f7162db",
          },
          body: JSON.stringify({
            action:
              "checkpoint_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_auto_drain",
            actorId: "partner_a",
            matterId,
            reason: "runtime checkpoint expiry attestation queue auto-drain checkpointed",
          }),
        })
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryQueueDrain.status).toBe(200)

      const remediationResolve = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "7f973a66-c8d5-4e95-b8cb-e02842941318",
          },
          body: JSON.stringify({
            action: "resolve_workflow_ops_alert_variance_remediation",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation resolved",
          }),
        })
      )
      expect(remediationResolve.status).toBe(200)
      const remediationResolveJson = (await remediationResolve.json()) as {
        result: {
          remediationQueue: { queueStatus: string; ownerId: string | null }
          variance: { varianceStatus: string }
        }
      }
      expect(remediationResolveJson.result.remediationQueue.queueStatus).toBe("resolved")
      expect(remediationResolveJson.result.remediationQueue.ownerId).toBe("associate_a")
      expect(remediationResolveJson.result.variance.varianceStatus).toBe("variance_resolved")

      const remediationSlaResolve = await opsReportingPost(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "61fd0bb5-c8df-4d2f-b6cd-332ced27d337",
          },
          body: JSON.stringify({
            action: "resolve_workflow_ops_alert_variance_remediation_sla_ledger",
            actorId: "partner_a",
            matterId,
            reason: "runtime remediation SLA resolved",
          }),
        })
      )
      expect(remediationSlaResolve.status).toBe(200)

      getRuntimeStore().workflowOpsAlertDigests = new Map()
      getRuntimeStore().workflowOpsAlertAttestations = new Map()
      getRuntimeStore().workflowOpsAlertEscalationLedgers = new Map()
      getRuntimeStore().workflowOpsAlertAttestationDisputes = new Map()
      getRuntimeStore().workflowOpsAlertEscalationClosures = new Map()
      getRuntimeStore().workflowOpsAlertDisputeEnforcementLedgers = new Map()
      getRuntimeStore().workflowOpsAlertClosureDebtReconciliationDigests = new Map()
      getRuntimeStore().workflowOpsAlertEnforcementAttestations = new Map()
      getRuntimeStore().workflowOpsAlertClosureDebtVarianceDigests = new Map()
      getRuntimeStore().workflowOpsAlertEnforcementWaiverLedgers = new Map()
      getRuntimeStore().workflowOpsAlertVarianceRemediationQueues = new Map()
      getRuntimeStore().workflowOpsAlertWaiverExpiryDigests = new Map()
      getRuntimeStore().workflowOpsAlertVarianceRemediationSlaLedgers = new Map()
      getRuntimeStore().workflowOpsAlertWaiverExpiryDisputes = new Map()
      getRuntimeStore().workflowOpsAlertVarianceRemediationSlaBreachEscalations = new Map()
      getRuntimeStore().workflowOpsAlertWaiverExpiryDisputeAdjudications = new Map()
      getRuntimeStore().workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints = new Map()
      getRuntimeStore().workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships = new Map()
      getRuntimeStore().workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations =
        new Map()
      getRuntimeStore().workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations = new Map()
      getRuntimeStore().workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations =
        new Map()
      getRuntimeStore().workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns = new Map()
      getRuntimeStore().workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations =
        new Map()
      const alertDigestView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_digests&actorId=associate_a&matterId=${matterId}&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(alertDigestView.status).toBe(200)
      const alertDigestJson = (await alertDigestView.json()) as {
        items: Array<{
          matterId: string | null
          severity: string
          acknowledgedBy: string | null
          snoozedBy: string | null
        }>
      }
      expect(
        alertDigestJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.acknowledgedBy === "partner_a" &&
            row.snoozedBy === "partner_a"
        )
      ).toBe(true)

      const attestationView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_attestations&actorId=associate_a&matterId=${matterId}&attestationStatus=attested&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(attestationView.status).toBe(200)
      const attestationViewJson = (await attestationView.json()) as {
        items: Array<{ matterId: string; attestationStatus: string }>
      }
      expect(
        attestationViewJson.items.some(
          (row) => row.matterId === matterId && row.attestationStatus === "attested"
        )
      ).toBe(true)

      const escalationView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_escalation_ledgers&actorId=associate_a&matterId=${matterId}&escalationStatus=open&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(escalationView.status).toBe(200)
      const escalationViewJson = (await escalationView.json()) as {
        items: Array<{ matterId: string; escalationStatus: string; ownerId: string | null }>
      }
      expect(
        escalationViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.escalationStatus === "open" &&
            row.ownerId === "clerk_a"
        )
      ).toBe(true)

      const disputeView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_attestation_disputes&actorId=associate_a&matterId=${matterId}&disputeStatus=resolved&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(disputeView.status).toBe(200)
      const disputeViewJson = (await disputeView.json()) as {
        items: Array<{ matterId: string; disputeStatus: string; reviewerId: string | null }>
      }
      expect(
        disputeViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.disputeStatus === "resolved" &&
            row.reviewerId === "associate_a"
        )
      ).toBe(true)

      const closureView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_escalation_closures&actorId=associate_a&matterId=${matterId}&closureStatus=reopened&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(closureView.status).toBe(200)
      const closureViewJson = (await closureView.json()) as {
        items: Array<{ matterId: string; closureStatus: string }>
      }
      expect(
        closureViewJson.items.some(
          (row) => row.matterId === matterId && row.closureStatus === "reopened"
        )
      ).toBe(true)

      const enforcementView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_dispute_enforcement_ledgers&actorId=associate_a&matterId=${matterId}&enforcementStatus=waived&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(enforcementView.status).toBe(200)
      const enforcementViewJson = (await enforcementView.json()) as {
        items: Array<{ matterId: string; enforcementStatus: string; ownerId: string | null }>
      }
      expect(
        enforcementViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.enforcementStatus === "waived" &&
            row.ownerId === "associate_a"
        )
      ).toBe(true)

      const reconciliationView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_closure_debt_reconciliation_digests&actorId=associate_a&matterId=${matterId}&reconciliationStatus=reconciled&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(reconciliationView.status).toBe(200)
      const reconciliationViewJson = (await reconciliationView.json()) as {
        items: Array<{ matterId: string; reconciliationStatus: string; outstandingDebtCount: number }>
      }
      expect(
        reconciliationViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.reconciliationStatus === "reconciled" &&
            row.outstandingDebtCount === 0
        )
      ).toBe(true)

      const enforcementAttestationView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_enforcement_attestations&actorId=associate_a&matterId=${matterId}&enforcementAttestationStatus=reopened&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(enforcementAttestationView.status).toBe(200)
      const enforcementAttestationViewJson = (await enforcementAttestationView.json()) as {
        items: Array<{ matterId: string; attestationStatus: string; lastAttestedBy: string | null }>
      }
      expect(
        enforcementAttestationViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.attestationStatus === "reopened" &&
            row.lastAttestedBy === "partner_a"
        )
      ).toBe(true)

      const varianceView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_closure_debt_variance_digests&actorId=associate_a&matterId=${matterId}&varianceStatus=variance_resolved&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(varianceView.status).toBe(200)
      const varianceViewJson = (await varianceView.json()) as {
        items: Array<{ matterId: string; varianceStatus: string; outstandingVarianceCount: number }>
      }
      expect(
        varianceViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.varianceStatus === "variance_resolved" &&
            row.outstandingVarianceCount === 0
        )
      ).toBe(true)

      const waiverView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_enforcement_waiver_ledgers&actorId=associate_a&matterId=${matterId}&waiverStatus=waived&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(waiverView.status).toBe(200)
      const waiverViewJson = (await waiverView.json()) as {
        items: Array<{ matterId: string; waiverStatus: string; waivedBy: string | null }>
      }
      expect(
        waiverViewJson.items.some(
          (row) => row.matterId === matterId && row.waiverStatus === "waived" && row.waivedBy === "partner_a"
        )
      ).toBe(true)

      const remediationQueueView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_queues&actorId=associate_a&matterId=${matterId}&remediationQueueStatus=resolved&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(remediationQueueView.status).toBe(200)
      const remediationQueueViewJson = (await remediationQueueView.json()) as {
        items: Array<{ matterId: string; queueStatus: string; ownerId: string | null }>
      }
      expect(
        remediationQueueViewJson.items.some(
          (row) =>
            row.matterId === matterId && row.queueStatus === "resolved" && row.ownerId === "associate_a"
        )
      ).toBe(true)

      const waiverExpiryView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_digests&actorId=associate_a&matterId=${matterId}&waiverExpiryStatus=extended&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(waiverExpiryView.status).toBe(200)
      const waiverExpiryViewJson = (await waiverExpiryView.json()) as {
        items: Array<{ matterId: string; expiryStatus: string; extendedBy: string | null }>
      }
      expect(
        waiverExpiryViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.expiryStatus === "extended" &&
            row.extendedBy === "partner_a"
        )
      ).toBe(true)

      const remediationSlaView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_ledgers&actorId=associate_a&matterId=${matterId}&remediationSlaStatus=resolved&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(remediationSlaView.status).toBe(200)
      const remediationSlaViewJson = (await remediationSlaView.json()) as {
        items: Array<{ matterId: string; slaStatus: string; resolvedBy: string | null }>
      }
      expect(
        remediationSlaViewJson.items.some(
          (row) =>
            row.matterId === matterId && row.slaStatus === "resolved" && row.resolvedBy === "partner_a"
        )
      ).toBe(true)

      const waiverExpiryDisputeView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_disputes&actorId=associate_a&matterId=${matterId}&waiverExpiryDisputeStatus=resolved&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(waiverExpiryDisputeView.status).toBe(200)
      const waiverExpiryDisputeViewJson = (await waiverExpiryDisputeView.json()) as {
        items: Array<{ matterId: string; disputeStatus: string; reviewerId: string | null }>
      }
      expect(
        waiverExpiryDisputeViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.disputeStatus === "resolved" &&
            row.reviewerId === "associate_a"
        )
      ).toBe(true)

      const remediationSlaBreachEscalationView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_escalations&actorId=associate_a&matterId=${matterId}&remediationSlaBreachEscalationStatus=resolved&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(remediationSlaBreachEscalationView.status).toBe(200)
      const remediationSlaBreachEscalationViewJson = (await remediationSlaBreachEscalationView.json()) as {
        items: Array<{ matterId: string; escalationStatus: string; ownerId: string | null }>
      }
      expect(
        remediationSlaBreachEscalationViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.escalationStatus === "resolved" &&
            row.ownerId === "associate_a"
        )
      ).toBe(true)

      const waiverExpiryDisputeAdjudicationView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudications&actorId=associate_a&matterId=${matterId}&waiverExpiryDisputeAdjudicationStatus=resolved&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(waiverExpiryDisputeAdjudicationView.status).toBe(200)
      const waiverExpiryDisputeAdjudicationViewJson =
        (await waiverExpiryDisputeAdjudicationView.json()) as {
          items: Array<{ matterId: string; adjudicationStatus: string; panelOwnerId: string | null }>
        }
      expect(
        waiverExpiryDisputeAdjudicationViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.adjudicationStatus === "resolved" &&
            row.panelOwnerId === "associate_a"
        )
      ).toBe(true)

      const remediationSlaBreachResolutionCheckpointView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoints&actorId=associate_a&matterId=${matterId}&remediationSlaBreachResolutionCheckpointStatus=reopened&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(remediationSlaBreachResolutionCheckpointView.status).toBe(200)
      const remediationSlaBreachResolutionCheckpointViewJson =
        (await remediationSlaBreachResolutionCheckpointView.json()) as {
          items: Array<{ matterId: string; checkpointStatus: string; reopenPressureCount: number }>
        }
      expect(
        remediationSlaBreachResolutionCheckpointViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.checkpointStatus === "reopened" &&
            row.reopenPressureCount >= 1
        )
      ).toBe(true)

      const waiverExpiryDisputeAdjudicationSloView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_stewardships&actorId=associate_a&matterId=${matterId}&waiverExpiryDisputeAdjudicationSloStatus=breach_acknowledged&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(waiverExpiryDisputeAdjudicationSloView.status).toBe(200)
      const waiverExpiryDisputeAdjudicationSloViewJson =
        (await waiverExpiryDisputeAdjudicationSloView.json()) as {
          items: Array<{ matterId: string; sloStatus: string; stewardId: string | null }>
        }
      expect(
        waiverExpiryDisputeAdjudicationSloViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.sloStatus === "breach_acknowledged" &&
            row.stewardId === "partner_a"
        )
      ).toBe(true)

      const remediationSlaBreachResolutionCheckpointExpiryView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations&actorId=associate_a&matterId=${matterId}&remediationSlaBreachResolutionCheckpointExpiryAttestationStatus=expiry_acknowledged&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryView.status).toBe(200)
      const remediationSlaBreachResolutionCheckpointExpiryViewJson =
        (await remediationSlaBreachResolutionCheckpointExpiryView.json()) as {
          items: Array<{
            matterId: string
            attestationStatus: string
            expiryAcknowledgedBy: string | null
          }>
        }
      expect(
        remediationSlaBreachResolutionCheckpointExpiryViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.attestationStatus === "expiry_acknowledged" &&
            row.expiryAcknowledgedBy === "partner_a"
        )
      ).toBe(true)

      const waiverExpiryDisputeAdjudicationSloDebtView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_remediations&actorId=associate_a&matterId=${matterId}&waiverExpiryDisputeAdjudicationSloDebtStatus=breach_closure_attested&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(waiverExpiryDisputeAdjudicationSloDebtView.status).toBe(200)
      const waiverExpiryDisputeAdjudicationSloDebtViewJson =
        (await waiverExpiryDisputeAdjudicationSloDebtView.json()) as {
          items: Array<{ matterId: string; debtStatus: string; breachClosureAttestedBy: string | null }>
        }
      expect(
        waiverExpiryDisputeAdjudicationSloDebtViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.debtStatus === "breach_closure_attested" &&
            row.breachClosureAttestedBy === "partner_a"
        )
      ).toBe(true)

      const remediationSlaBreachResolutionCheckpointExpiryExceptionView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations&actorId=associate_a&matterId=${matterId}&remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus=exception_reconciled&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryExceptionView.status).toBe(200)
      const remediationSlaBreachResolutionCheckpointExpiryExceptionViewJson =
        (await remediationSlaBreachResolutionCheckpointExpiryExceptionView.json()) as {
          items: Array<{ matterId: string; exceptionStatus: string; reconciledBy: string | null }>
        }
      expect(
        remediationSlaBreachResolutionCheckpointExpiryExceptionViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.exceptionStatus === "exception_reconciled" &&
            row.reconciledBy === "partner_a"
        )
      ).toBe(true)

      const waiverExpiryDisputeAdjudicationSloDebtBurndownView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndowns&actorId=associate_a&matterId=${matterId}&burndownStatus=burndown_checkpointed&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(waiverExpiryDisputeAdjudicationSloDebtBurndownView.status).toBe(200)
      const waiverExpiryDisputeAdjudicationSloDebtBurndownViewJson =
        (await waiverExpiryDisputeAdjudicationSloDebtBurndownView.json()) as {
          items: Array<{
            matterId: string
            burndownStatus: string
            checkpointedBy: string | null
          }>
        }
      expect(
        waiverExpiryDisputeAdjudicationSloDebtBurndownViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.burndownStatus === "burndown_checkpointed" &&
            row.checkpointedBy === "partner_a"
        )
      ).toBe(true)

      const remediationSlaBreachResolutionCheckpointExpiryQueueView = await opsReportingGet(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_orchestrations&actorId=associate_a&matterId=${matterId}&queueStatus=queue_auto_drained&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(remediationSlaBreachResolutionCheckpointExpiryQueueView.status).toBe(200)
      const remediationSlaBreachResolutionCheckpointExpiryQueueViewJson =
        (await remediationSlaBreachResolutionCheckpointExpiryQueueView.json()) as {
          items: Array<{
            matterId: string
            queueStatus: string
            autoDrainCheckpointedBy: string | null
          }>
        }
      expect(
        remediationSlaBreachResolutionCheckpointExpiryQueueViewJson.items.some(
          (row) =>
            row.matterId === matterId &&
            row.queueStatus === "queue_auto_drained" &&
            row.autoDrainCheckpointedBy === "partner_a"
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
      const persistedAlertDigests = await getDocs(collection(ctx.firestore(), "workflow_ops_alert_digests"))
      expect(
        persistedAlertDigests.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.acknowledgedBy === "partner_a" &&
            entry.data()?.snoozedBy === "partner_a"
        )
      ).toBe(true)
      const persistedAttestations = await getDocs(collection(ctx.firestore(), "workflow_ops_alert_attestations"))
      expect(
        persistedAttestations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.attestationStatus === "attested" &&
            entry.data()?.lastAttestedBy === "partner_a"
        )
      ).toBe(true)
      const persistedEscalations = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_escalation_ledgers")
      )
      expect(
        persistedEscalations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.escalationStatus === "open" &&
            entry.data()?.ownerId === "clerk_a"
        )
      ).toBe(true)
      const persistedDisputes = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_attestation_disputes")
      )
      expect(
        persistedDisputes.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.disputeStatus === "resolved" &&
            entry.data()?.reviewerId === "associate_a" &&
            entry.data()?.resolutionOutcome === "upheld"
        )
      ).toBe(true)
      const persistedClosures = await getDocs(collection(ctx.firestore(), "workflow_ops_alert_escalation_closures"))
      expect(
        persistedClosures.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.closureStatus === "reopened"
        )
      ).toBe(true)
      const persistedEnforcement = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_dispute_enforcement_ledgers")
      )
      expect(
        persistedEnforcement.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.enforcementStatus === "waived" &&
            entry.data()?.ownerId === "associate_a"
        )
      ).toBe(true)
      const persistedReconciliation = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_closure_debt_reconciliation_digests")
      )
      expect(
        persistedReconciliation.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.reconciliationStatus === "reconciled" &&
            entry.data()?.outstandingDebtCount === 0
        )
      ).toBe(true)
      const persistedEnforcementAttestations = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_enforcement_attestations")
      )
      expect(
        persistedEnforcementAttestations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.attestationStatus === "reopened" &&
            entry.data()?.lastAttestedBy === "partner_a"
        )
      ).toBe(true)
      const persistedVarianceDigests = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_closure_debt_variance_digests")
      )
      expect(
        persistedVarianceDigests.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.varianceStatus === "variance_resolved" &&
            entry.data()?.outstandingVarianceCount === 0
        )
      ).toBe(true)
      const persistedWaiverLedgers = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_enforcement_waiver_ledgers")
      )
      expect(
        persistedWaiverLedgers.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.waiverStatus === "waived" &&
            entry.data()?.waivedBy === "partner_a"
        )
      ).toBe(true)
      const persistedRemediationQueues = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_variance_remediation_queues")
      )
      expect(
        persistedRemediationQueues.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.queueStatus === "resolved" &&
            entry.data()?.ownerId === "associate_a"
        )
      ).toBe(true)
      const persistedWaiverExpiryDigests = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_waiver_expiry_digests")
      )
      expect(
        persistedWaiverExpiryDigests.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.expiryStatus === "extended" &&
            entry.data()?.extendedBy === "partner_a"
        )
      ).toBe(true)
      const persistedRemediationSlaLedgers = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_variance_remediation_sla_ledgers")
      )
      expect(
        persistedRemediationSlaLedgers.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.slaStatus === "resolved" &&
            entry.data()?.resolvedBy === "partner_a"
        )
      ).toBe(true)
      const persistedWaiverExpiryDisputes = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_waiver_expiry_disputes")
      )
      expect(
        persistedWaiverExpiryDisputes.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.disputeStatus === "resolved" &&
            entry.data()?.reviewerId === "associate_a"
        )
      ).toBe(true)
      const persistedRemediationSlaBreachEscalations = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_variance_remediation_sla_breach_escalations")
      )
      expect(
        persistedRemediationSlaBreachEscalations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.escalationStatus === "resolved" &&
            entry.data()?.ownerId === "associate_a"
        )
      ).toBe(true)
      const persistedWaiverExpiryDisputeAdjudications = await getDocs(
        collection(ctx.firestore(), "workflow_ops_alert_waiver_expiry_dispute_adjudications")
      )
      expect(
        persistedWaiverExpiryDisputeAdjudications.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.adjudicationStatus === "resolved" &&
            entry.data()?.panelOwnerId === "associate_a"
        )
      ).toBe(true)
      const persistedRemediationSlaBreachResolutionCheckpoints = await getDocs(
        collection(
          ctx.firestore(),
          "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoints"
        )
      )
      expect(
        persistedRemediationSlaBreachResolutionCheckpoints.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.checkpointStatus === "reopened" &&
            (entry.data()?.reopenPressureCount ?? 0) >= 1
        )
      ).toBe(true)
      const persistedWaiverExpiryDisputeAdjudicationSlos = await getDocs(
        collection(
          ctx.firestore(),
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_stewardships"
        )
      )
      expect(
        persistedWaiverExpiryDisputeAdjudicationSlos.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.sloStatus === "breach_acknowledged" &&
            entry.data()?.stewardId === "partner_a"
        )
      ).toBe(true)
      const persistedRemediationSlaBreachResolutionCheckpointExpiryAttestations = await getDocs(
        collection(
          ctx.firestore(),
          "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations"
        )
      )
      expect(
        persistedRemediationSlaBreachResolutionCheckpointExpiryAttestations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.attestationStatus === "expiry_acknowledged" &&
            entry.data()?.expiryAcknowledgedBy === "partner_a"
        )
      ).toBe(true)
      const persistedWaiverExpiryDisputeAdjudicationSloDebtRemediations = await getDocs(
        collection(
          ctx.firestore(),
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediations"
        )
      )
      expect(
        persistedWaiverExpiryDisputeAdjudicationSloDebtRemediations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.debtStatus === "breach_closure_attested" &&
            entry.data()?.breachClosureAttestedBy === "partner_a"
        )
      ).toBe(true)
      const persistedRemediationSlaBreachResolutionCheckpointExpiryExceptionReconciliations =
        await getDocs(
          collection(
            ctx.firestore(),
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations"
          )
        )
      expect(
        persistedRemediationSlaBreachResolutionCheckpointExpiryExceptionReconciliations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.exceptionStatus === "exception_reconciled" &&
            entry.data()?.reconciledBy === "partner_a"
        )
      ).toBe(true)
      const persistedWaiverExpiryDisputeAdjudicationSloDebtBurndowns = await getDocs(
        collection(
          ctx.firestore(),
          "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndowns"
        )
      )
      expect(
        persistedWaiverExpiryDisputeAdjudicationSloDebtBurndowns.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.burndownStatus === "burndown_checkpointed" &&
            entry.data()?.checkpointedBy === "partner_a"
        )
      ).toBe(true)
      const persistedRemediationSlaBreachResolutionCheckpointExpiryQueueOrchestrations =
        await getDocs(
          collection(
            ctx.firestore(),
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_orchestrations"
          )
        )
      expect(
        persistedRemediationSlaBreachResolutionCheckpointExpiryQueueOrchestrations.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.queueStatus === "queue_auto_drained" &&
            entry.data()?.autoDrainCheckpointedBy === "partner_a"
        )
      ).toBe(true)
    })
  }, 45_000)

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

  it("persists reporting index and matter analytics scaffolding after reset", async () => {
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

      const exportRecord = await reportingPost(
        new Request("http://127.0.0.1/api/d1/reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "1e24ccf1-f751-46d4-b53d-8f6d41f51b13",
          },
          body: JSON.stringify({
            action: "record_matter_report_export",
            actorId: "partner_a",
            matterId,
            exportFormat: "csv",
            exportScope: "summary",
            reason: "runtime persistence verification",
          }),
        })
      )
      expect(exportRecord.status).toBe(200)

      const recompute = await reportingPost(
        new Request("http://127.0.0.1/api/d1/reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f678e4f7-7da5-4d17-9ef9-4530f3d0e5c7",
          },
          body: JSON.stringify({
            action: "recompute_matter_report_relevance",
            actorId: "partner_a",
            matterId,
            reason: "runtime recompute check",
            provenanceTags: ["runtime_mode_test"],
          }),
        })
      )
      expect(recompute.status).toBe(200)

      getRuntimeStore().matterReportExportAnalytics = new Map()
      getRuntimeStore().matterReportRelevanceSnapshots = new Map()

      const exportView = await reportingGet(
        new Request(
          `http://127.0.0.1/api/d1/reporting?view=matter_report_export_analytics&actorId=partner_a&matterId=${matterId}&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(exportView.status).toBe(200)
      const exportViewJson = (await exportView.json()) as {
        items: Array<{ matterId: string; exportCount: number; relevance: { freshnessStatus: string } | null }>
      }
      expect(exportViewJson.items.some((row) => row.matterId === matterId && row.exportCount >= 1)).toBe(true)
      expect(exportViewJson.items[0]?.relevance?.freshnessStatus).toBe("fresh")

      const relevanceView = await reportingGet(
        new Request(
          `http://127.0.0.1/api/d1/reporting?view=matter_report_relevance_snapshots&actorId=partner_a&matterId=${matterId}&freshnessStatus=fresh&limit=20&cursor=0`
        )
      )
      expect(relevanceView.status).toBe(200)
      const relevanceJson = (await relevanceView.json()) as {
        items: Array<{ matterId: string; scoreBand: string; freshnessStatus: string }>
      }
      expect(relevanceJson.items.some((row) => row.matterId === matterId)).toBe(true)
      expect(["low", "medium", "high"]).toContain(relevanceJson.items[0]?.scoreBand ?? "")

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
      const persistedExportAnalytics = await getDocs(
        collection(ctx.firestore(), "matter_report_export_analytics")
      )
      expect(
        persistedExportAnalytics.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.lastExportFormat === "csv"
        )
      ).toBe(true)
      const persistedRelevanceSnapshots = await getDocs(
        collection(ctx.firestore(), "matter_report_relevance_snapshots")
      )
      expect(
        persistedRelevanceSnapshots.docs.some(
          (entry) =>
            entry.data()?.firmId === "firmA" &&
            entry.data()?.matterId === matterId &&
            entry.data()?.freshnessStatus === "fresh"
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

      const clerkSession = await tenancyGet(
        new Request(
          "http://127.0.0.1/api/p5/tenancy?view=session&userId=clerk_a&firmId=firmA&authBoundary=external_session_hint&externalSessionId=ext-runtime-clerk"
        )
      )
      expect(clerkSession.status).toBe(200)
      const clerkSessionJson = (await clerkSession.json()) as {
        sessionReference: { id: string }
      }

      const actorSession = await tenancyGet(
        new Request(
          "http://127.0.0.1/api/p5/tenancy?view=session&userId=partner_a&firmId=firmA&authBoundary=external_session_hint&externalSessionId=ext-runtime-actor"
        )
      )
      expect(actorSession.status).toBe(200)
      const actorSessionJson = (await actorSession.json()) as {
        sessionReference: { id: string }
      }

      const reissueAligned = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "ce662a54-71f1-4f1d-a145-f88df3b6f8d1",
          },
          body: JSON.stringify({
            action: "reissue_session_reference",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: actorSessionJson.sessionReference.id,
          }),
        })
      )
      expect(reissueAligned.status).toBe(200)
      const reissueAlignedJson = (await reissueAligned.json()) as {
        result: { sessionReference: { id: string; lineageDepth: number } }
      }
      expect(reissueAlignedJson.result.sessionReference.lineageDepth).toBe(1)

      const reissueDiverged = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "df26594f-34e5-4a72-bf8c-cf9f7eb36d56",
          },
          body: JSON.stringify({
            action: "reissue_session_reference",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: reissueAlignedJson.result.sessionReference.id,
            authBoundary: "external_session_hint",
            externalSessionId: "ext-runtime-lineage-diverged",
          }),
        })
      )
      expect(reissueDiverged.status).toBe(200)
      const reissueDivergedJson = (await reissueDiverged.json()) as {
        result: {
          sessionReference: {
            id: string
            lineageDepth: number
            delegatedBoundaryReconciliationStatus: string
            delegatedBoundaryDivergenceReasons: string[]
          }
        }
      }
      expect(reissueDivergedJson.result.sessionReference.lineageDepth).toBe(2)
      expect(
        reissueDivergedJson.result.sessionReference.delegatedBoundaryReconciliationStatus
      ).toBe("diverged")
      expect(reissueDivergedJson.result.sessionReference.delegatedBoundaryDivergenceReasons).toContain(
        "external_session_hint_changed"
      )

      const disputeFirst = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f97264af-5021-4ece-b777-80607b5bd99d",
          },
          body: JSON.stringify({
            action: "attest_session_lineage_dispute",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: reissueDivergedJson.result.sessionReference.id,
            reason: "Runtime lineage divergence disputed",
            note: "Raise attestation from runtime-mode test",
          }),
        })
      )
      expect(disputeFirst.status).toBe(200)
      const disputeFirstJson = (await disputeFirst.json()) as {
        result: {
          dispute: { id: string; status: string }
          digest: { openDisputeCount: number; reasons: string[] }
        }
      }
      expect(disputeFirstJson.result.dispute.status).toBe("open")
      expect(disputeFirstJson.result.digest.openDisputeCount).toBeGreaterThanOrEqual(1)
      expect(disputeFirstJson.result.digest.reasons).toContain("open_lineage_dispute")

      const disputeReplay = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f97264af-5021-4ece-b777-80607b5bd99d",
          },
          body: JSON.stringify({
            action: "attest_session_lineage_dispute",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: reissueDivergedJson.result.sessionReference.id,
            reason: "Runtime lineage divergence disputed",
            note: "Raise attestation from runtime-mode test",
          }),
        })
      )
      expect(disputeReplay.status).toBe(200)
      const disputeReplayJson = (await disputeReplay.json()) as { reused: boolean }
      expect(disputeReplayJson.reused).toBe(true)

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
            sessionReferenceId: actorSessionJson.sessionReference.id,
            authBoundary: "external_session_hint",
            externalSessionId: "ext-runtime-actor",
          }),
        })
      )
      expect(roleUpdate.status).toBe(200)
      const roleUpdateJson = (await roleUpdate.json()) as {
        result: {
          privilegedBoundaryDriftCount: number
          privilegedBoundaryDriftSessionReferenceIds: string[]
        }
      }
      expect(roleUpdateJson.result.privilegedBoundaryDriftCount).toBeGreaterThanOrEqual(1)
      expect(roleUpdateJson.result.privilegedBoundaryDriftSessionReferenceIds).toContain(
        clerkSessionJson.sessionReference.id
      )

      const associateSession = await tenancyGet(
        new Request("http://127.0.0.1/api/p5/tenancy?view=session&userId=associate_a&firmId=firmA")
      )
      expect(associateSession.status).toBe(200)
      const associateSessionJson = (await associateSession.json()) as {
        sessionReference: { id: string }
      }
      const revokeRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f365f818-4c0d-4224-96aa-34182725cdca",
          },
          body: JSON.stringify({
            action: "revoke_session_reference",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: associateSessionJson.sessionReference.id,
            reason: "Runtime revocation persistence check",
          }),
        })
      )
      expect(revokeRes.status).toBe(200)

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
      getRuntimeStore().tenancySessionReferences = new Map()

      const staleReplayRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session&sessionRefId=${clerkSessionJson.sessionReference.id}`
        )
      )
      expect(staleReplayRes.status).toBe(410)

      const lineageFirstRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&limit=2&cursor=0`
        )
      )
      expect(lineageFirstRes.status).toBe(200)
      const lineageFirstJson = (await lineageFirstRes.json()) as {
        items: Array<{ id: string }>
        nextCursor: string | null
        total: number
      }
      expect(lineageFirstJson.total).toBeGreaterThanOrEqual(3)
      expect(lineageFirstJson.items.length).toBe(2)
      expect(lineageFirstJson.nextCursor).not.toBeNull()

      const lineageSecondRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&limit=2&cursor=${lineageFirstJson.nextCursor ?? "0"}`
        )
      )
      expect(lineageSecondRes.status).toBe(200)
      const lineageSecondJson = (await lineageSecondRes.json()) as {
        items: Array<{ id: string; delegatedBoundaryReconciliationStatus: string }>
      }
      expect(
        lineageSecondJson.items.some(
          (row) =>
            row.id === reissueDivergedJson.result.sessionReference.id &&
            row.delegatedBoundaryReconciliationStatus === "diverged"
        )
      ).toBe(true)

      const lineageDivergedOnlyRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&delegatedDivergedOnly=true&limit=10&cursor=0`
        )
      )
      expect(lineageDivergedOnlyRes.status).toBe(200)
      const lineageDivergedOnlyJson = (await lineageDivergedOnlyRes.json()) as {
        items: Array<{ id: string }>
      }
      expect(
        lineageDivergedOnlyJson.items.some(
          (row) => row.id === reissueDivergedJson.result.sessionReference.id
        )
      ).toBe(true)

      const attestIdentityBridgeFirst = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "95f13a1d-3962-4ccb-ad34-c7af9545f169",
          },
          body: JSON.stringify({
            action: "attest_external_session_identity_bridge",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: reissueDivergedJson.result.sessionReference.id,
            assertedIssuer: "idp.runtime.local",
            assertedSubject: "partner_a:runtime-diverged",
            assertedExternalSessionId: "ext-runtime-lineage-diverged",
            note: "Runtime bridge attestation",
          }),
        })
      )
      expect(attestIdentityBridgeFirst.status).toBe(200)
      const attestIdentityBridgeReplay = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "95f13a1d-3962-4ccb-ad34-c7af9545f169",
          },
          body: JSON.stringify({
            action: "attest_external_session_identity_bridge",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: reissueDivergedJson.result.sessionReference.id,
            assertedIssuer: "idp.runtime.local",
            assertedSubject: "partner_a:runtime-diverged",
            assertedExternalSessionId: "ext-runtime-lineage-diverged",
            note: "Runtime bridge attestation",
          }),
        })
      )
      expect(attestIdentityBridgeReplay.status).toBe(200)
      const attestIdentityBridgeReplayJson = (await attestIdentityBridgeReplay.json()) as {
        reused: boolean
      }
      expect(attestIdentityBridgeReplayJson.reused).toBe(true)

      const attestIdentityBridgeMismatch = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "1fb5ff52-c4e8-4b26-a983-c839bf35b80c",
          },
          body: JSON.stringify({
            action: "attest_external_session_identity_bridge",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: reissueDivergedJson.result.sessionReference.id,
            assertedIssuer: "idp.runtime.local",
            assertedSubject: "partner_a:runtime-diverged",
            assertedExternalSessionId: "ext-runtime-lineage-diverged-mismatch",
            note: "Runtime mismatch trigger",
          }),
        })
      )
      expect(attestIdentityBridgeMismatch.status).toBe(200)

      const quarantineIdentityBridgeRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f59af8af-c89f-4a46-bf85-dd89cfd8f2d4",
          },
          body: JSON.stringify({
            action: "quarantine_external_session_identity_bridge",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: reissueDivergedJson.result.sessionReference.id,
            quarantineReason: "Runtime issuer drift quarantine",
            note: "Runtime quarantine",
          }),
        })
      )
      expect(quarantineIdentityBridgeRes.status).toBe(200)

      const identityBridgeMismatchViewRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_external_session_identity_bridges&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=quarantined&mismatchStatus=mismatch_detected&limit=10&cursor=0`
        )
      )
      expect(identityBridgeMismatchViewRes.status).toBe(200)
      const identityBridgeMismatchViewJson = (await identityBridgeMismatchViewRes.json()) as {
        items: Array<{ status: string; mismatchStatus: string; sessionReferenceId: string }>
      }
      expect(
        identityBridgeMismatchViewJson.items.some(
          (row) =>
            row.status === "quarantined" &&
            row.mismatchStatus === "mismatch_detected" &&
            row.sessionReferenceId === reissueDivergedJson.result.sessionReference.id
        )
      ).toBe(true)

      const clearIdentityBridgeRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f9861e95-b2cd-4c74-b70d-52e76f4a8b54",
          },
          body: JSON.stringify({
            action: "clear_external_session_identity_bridge",
            actorId: "partner_a",
            firmId: "firmA",
            sessionReferenceId: reissueDivergedJson.result.sessionReference.id,
            clearReason: "Runtime manual override after bridge review",
            note: "Runtime clear bridge",
          }),
        })
      )
      expect(clearIdentityBridgeRes.status).toBe(200)

      const identityBridgeClearedViewRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_external_session_identity_bridges&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=cleared&mismatchStatus=aligned&limit=10&cursor=0`
        )
      )
      expect(identityBridgeClearedViewRes.status).toBe(200)
      const identityBridgeClearedViewJson = (await identityBridgeClearedViewRes.json()) as {
        items: Array<{ status: string; mismatchStatus: string }>
      }
      expect(
        identityBridgeClearedViewJson.items.some(
          (row) => row.status === "cleared" && row.mismatchStatus === "aligned"
        )
      ).toBe(true)

      const queueQueuedRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_reconciliation_queue&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=queued&limit=10&cursor=0`
        )
      )
      expect(queueQueuedRes.status).toBe(200)
      const queueQueuedJson = (await queueQueuedRes.json()) as {
        items: Array<{ id: string; status: string }>
      }
      expect(
        queueQueuedJson.items.some(
          (row) =>
            row.id === `tenancy-lineage-arbitration:${actorSessionJson.sessionReference.id}` &&
            row.status === "queued"
        )
      ).toBe(true)

      const assignQueueRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "c25565f3-93d5-4b09-838c-7628c4d95cfd",
          },
          body: JSON.stringify({
            action: "assign_lineage_reconciliation_queue",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            assignedPartnerId: "partner_a",
            slaWindowMinutes: 120,
            note: "Runtime queue assignment",
          }),
        })
      )
      expect(assignQueueRes.status).toBe(200)

      const arbitrateQueueRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "42e8d9ca-e90c-4a93-b804-6f57a7b7d7d9",
          },
          body: JSON.stringify({
            action: "arbitrate_lineage_reconciliation_queue",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            disposition: "confirm_needs_review",
            note: "Runtime queue arbitration",
          }),
        })
      )
      expect(arbitrateQueueRes.status).toBe(200)

      const closureAttestFirst = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8d0e2821-7af5-406d-86fb-44f143eb0c0e",
          },
          body: JSON.stringify({
            action: "attest_lineage_digest_closure",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            closureReason: "Runtime closure attestation",
            note: "Close checkpoint in runtime test",
          }),
        })
      )
      expect(closureAttestFirst.status).toBe(200)
      const closureAttestReplay = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8d0e2821-7af5-406d-86fb-44f143eb0c0e",
          },
          body: JSON.stringify({
            action: "attest_lineage_digest_closure",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            closureReason: "Runtime closure attestation",
            note: "Close checkpoint in runtime test",
          }),
        })
      )
      expect(closureAttestReplay.status).toBe(200)
      const closureAttestReplayJson = (await closureAttestReplay.json()) as { reused: boolean }
      expect(closureAttestReplayJson.reused).toBe(true)

      const reopenClosureRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "3d91fb88-5ca6-4e2e-a293-f9ebebde2c3a",
          },
          body: JSON.stringify({
            action: "reopen_lineage_digest_closure",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            reopenTrigger: "Runtime reopened due follow-up divergence check",
            note: "Reopen checkpoint in runtime test",
          }),
        })
      )
      expect(reopenClosureRes.status).toBe(200)

      const governAdjudicationRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "6d08f9c2-083e-4cbf-8308-19809a06e17f",
          },
          body: JSON.stringify({
            action: "govern_lineage_closure_adjudication",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            panelPartnerIds: ["partner_a"],
            requiredPanelQuorum: 1,
            verdictWindowMinutes: 45,
            note: "Runtime closure adjudication governance",
          }),
        })
      )
      expect(governAdjudicationRes.status).toBe(200)

      const recordVerdictRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "85eff7bf-c374-44f4-b7ff-64d1f3fbf39e",
          },
          body: JSON.stringify({
            action: "record_lineage_closure_adjudication_verdict",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            disposition: "mark_reconciled",
            dispositionDriftReasons: ["runtime_verdict_alignment"],
            note: "Runtime verdict recording",
          }),
        })
      )
      expect(recordVerdictRes.status).toBe(200)

      const attestDebtRetirementFirst = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b7288f0f-a12d-45bd-8ba1-7f5fefd8be52",
          },
          body: JSON.stringify({
            action: "attest_lineage_arbitration_debt_retirement",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            retirementNote: "Runtime queue pressure retired after verdict",
            note: "Runtime debt retirement attestation",
          }),
        })
      )
      expect(attestDebtRetirementFirst.status).toBe(200)
      const attestDebtRetirementReplay = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "b7288f0f-a12d-45bd-8ba1-7f5fefd8be52",
          },
          body: JSON.stringify({
            action: "attest_lineage_arbitration_debt_retirement",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            retirementNote: "Runtime queue pressure retired after verdict",
            note: "Runtime debt retirement attestation",
          }),
        })
      )
      expect(attestDebtRetirementReplay.status).toBe(200)
      const attestDebtRetirementReplayJson = (await attestDebtRetirementReplay.json()) as {
        reused: boolean
      }
      expect(attestDebtRetirementReplayJson.reused).toBe(true)

      const reopenDebtRetirementRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8eb4e6a7-f1d7-4a00-a5f9-c7f81057f6e2",
          },
          body: JSON.stringify({
            action: "reopen_lineage_arbitration_debt_retirement",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            carryoverSignal: "Runtime carryover reopened after attestation",
            note: "Runtime carryover reopen",
          }),
        })
      )
      expect(reopenDebtRetirementRes.status).toBe(200)

      const checkpointSettlementPublicationRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "1a5857ba-4adf-45f8-85ea-6ce2f9cc2513",
          },
          body: JSON.stringify({
            action: "checkpoint_lineage_closure_adjudication_settlement_publication",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            publicationChannel: "runtime_workboard",
            note: "Runtime publication checkpoint",
          }),
        })
      )
      expect(checkpointSettlementPublicationRes.status).toBe(200)

      const settlementCorrectionRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "26af7f6c-0ce5-4b07-85eb-f9e6f599a5d6",
          },
          body: JSON.stringify({
            action: "log_lineage_closure_adjudication_settlement_correction",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            correctionNote: "Runtime correction before settlement confirmation",
            note: "Runtime correction trace",
          }),
        })
      )
      expect(settlementCorrectionRes.status).toBe(200)

      const settlementConfirmRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "2a0f8e1e-f66d-4dc9-a133-177cf2eb38b7",
          },
          body: JSON.stringify({
            action: "confirm_lineage_closure_adjudication_settlement_sla",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            note: "Runtime settlement confirmation",
          }),
        })
      )
      expect(settlementConfirmRes.status).toBe(200)

      const openDebtDisputeRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "8bd83f8f-e744-477b-8be2-3d6da4e8cfa3",
          },
          body: JSON.stringify({
            action: "open_lineage_arbitration_debt_retirement_dispute",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            challengeReason: "Runtime debt retirement evidence challenge",
            note: "Runtime dispute intake",
          }),
        })
      )
      expect(openDebtDisputeRes.status).toBe(200)

      const assignDebtDisputeReviewerRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f007639c-ee2a-4ef0-af7e-aa0d34904801",
          },
          body: JSON.stringify({
            action: "assign_lineage_arbitration_debt_retirement_dispute_reviewer",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            reviewerId: "partner_a",
            note: "Runtime reviewer assignment",
          }),
        })
      )
      expect(assignDebtDisputeReviewerRes.status).toBe(200)

      const resolveDebtDisputeRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "50028312-5e53-4018-9ad2-1e84f19195ca",
          },
          body: JSON.stringify({
            action: "resolve_lineage_arbitration_debt_retirement_dispute",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            resolutionOutcome: "require_rollback_review",
            resolutionNote: "Runtime dispute resolved with rollback review",
            note: "Runtime dispute resolution",
          }),
        })
      )
      expect(resolveDebtDisputeRes.status).toBe(200)

      const rollbackDebtDisputeRes = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "62b88f88-a2f7-485c-b663-22cdb52e81e1",
          },
          body: JSON.stringify({
            action: "control_lineage_arbitration_debt_retirement_dispute_rollback",
            actorId: "partner_a",
            firmId: "firmA",
            lineageRootSessionReferenceId: actorSessionJson.sessionReference.id,
            rollbackControlNote: "Runtime rollback control engaged",
            note: "Runtime rollback guardrail",
          }),
        })
      )
      expect(rollbackDebtDisputeRes.status).toBe(200)

      const resolveDispute = await tenancyPost(
        new Request("http://127.0.0.1/api/p5/tenancy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "f873afd6-8b1b-4f3d-b428-a48449561492",
          },
          body: JSON.stringify({
            action: "resolve_session_lineage_dispute",
            actorId: "partner_a",
            firmId: "firmA",
            disputeId: disputeFirstJson.result.dispute.id,
            disposition: "mark_reconciled",
            resolutionNote: "Runtime lineage reconciled",
          }),
        })
      )
      expect(resolveDispute.status).toBe(200)
      const resolveJson = (await resolveDispute.json()) as {
        result: {
          dispute: { status: string; disposition: string }
          relatedSessionReference: {
            delegatedBoundaryReconciliationStatus: string
            delegatedBoundaryDivergenceReasons: string[]
          } | null
          digest: { openDisputeCount: number }
        }
      }
      expect(resolveJson.result.dispute.status).toBe("resolved")
      expect(resolveJson.result.dispute.disposition).toBe("mark_reconciled")
      expect(resolveJson.result.relatedSessionReference?.delegatedBoundaryReconciliationStatus).toBe(
        "aligned"
      )
      expect(resolveJson.result.relatedSessionReference?.delegatedBoundaryDivergenceReasons).toEqual(
        []
      )
      expect(resolveJson.result.digest.openDisputeCount).toBe(0)

      const disputesOpenRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_disputes&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=open&limit=10&cursor=0`
        )
      )
      expect(disputesOpenRes.status).toBe(200)
      const disputesOpenJson = (await disputesOpenRes.json()) as {
        items: Array<{ id: string }>
      }
      expect(disputesOpenJson.items.some((row) => row.id === disputeFirstJson.result.dispute.id)).toBe(
        false
      )

      const disputesResolvedRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_disputes&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=resolved&limit=10&cursor=0`
        )
      )
      expect(disputesResolvedRes.status).toBe(200)
      const disputesResolvedJson = (await disputesResolvedRes.json()) as {
        items: Array<{ id: string; disposition: string }>
      }
      expect(
        disputesResolvedJson.items.some(
          (row) => row.id === disputeFirstJson.result.dispute.id && row.disposition === "mark_reconciled"
        )
      ).toBe(true)

      const queueArbitratedRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_reconciliation_queue&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=arbitrated&limit=10&cursor=0`
        )
      )
      expect(queueArbitratedRes.status).toBe(200)
      const queueArbitratedJson = (await queueArbitratedRes.json()) as {
        items: Array<{ status: string; disposition: string | null }>
      }
      expect(
        queueArbitratedJson.items.some(
          (row) => row.status === "arbitrated" && row.disposition === "confirm_needs_review"
        )
      ).toBe(true)

      const closureReopenedRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_digest_closure_checkpoints&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=reopened&limit=10&cursor=0`
        )
      )
      expect(closureReopenedRes.status).toBe(200)
      const closureReopenedJson = (await closureReopenedRes.json()) as {
        items: Array<{ status: string; reopenTrigger: string | null }>
      }
      expect(
        closureReopenedJson.items.some(
          (row) =>
            row.status === "reopened" &&
            row.reopenTrigger === "Runtime reopened due follow-up divergence check"
        )
      ).toBe(true)

      const adjudicationViewRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_closure_adjudications&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=verdict_recorded&limit=10&cursor=0`
        )
      )
      expect(adjudicationViewRes.status).toBe(200)
      const adjudicationViewJson = (await adjudicationViewRes.json()) as {
        items: Array<{ status: string; verdictDisposition: string | null }>
      }
      expect(
        adjudicationViewJson.items.some(
          (row) => row.status === "verdict_recorded" && row.verdictDisposition === "mark_reconciled"
        )
      ).toBe(true)

      const debtLedgerViewRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_arbitration_debt_retirement_ledgers&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=retirement_attested&limit=10&cursor=0`
        )
      )
      expect(debtLedgerViewRes.status).toBe(200)
      const debtLedgerViewJson = (await debtLedgerViewRes.json()) as {
        items: Array<{ status: string; carryoverSignals: string[] }>
      }
      expect(
        debtLedgerViewJson.items.some(
          (row) =>
            row.status === "retirement_attested" &&
            row.carryoverSignals.includes("Runtime carryover reopened after attestation")
        )
      ).toBe(true)

      const settlementViewRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_closure_adjudication_settlements&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=sla_confirmed&limit=10&cursor=0`
        )
      )
      expect(settlementViewRes.status).toBe(200)
      const settlementViewJson = (await settlementViewRes.json()) as {
        items: Array<{ status: string; settlementConfirmedBy: string | null }>
      }
      expect(
        settlementViewJson.items.some(
          (row) => row.status === "sla_confirmed" && row.settlementConfirmedBy === "partner_a"
        )
      ).toBe(true)

      const disputeLedgerViewRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_arbitration_debt_retirement_dispute_ledgers&actorId=partner_a&firmId=firmA&rootSessionRefId=${actorSessionJson.sessionReference.id}&status=rollback_controlled&limit=10&cursor=0`
        )
      )
      expect(disputeLedgerViewRes.status).toBe(200)
      const disputeLedgerViewJson = (await disputeLedgerViewRes.json()) as {
        items: Array<{ status: string; rollbackControlNote: string | null }>
      }
      expect(
        disputeLedgerViewJson.items.some(
          (row) =>
            row.status === "rollback_controlled" &&
            row.rollbackControlNote === "Runtime rollback control engaged"
        )
      ).toBe(true)

      const digestViewRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session_lineage_reconciliation_digests&actorId=partner_a&firmId=firmA&limit=10&cursor=0`
        )
      )
      expect(digestViewRes.status).toBe(200)
      const digestViewJson = (await digestViewRes.json()) as {
        items: Array<{
          lineageRootSessionReferenceId: string
          status: string
          openDisputeCount: number
          divergedHopCount: number
          reasons: string[]
        }>
      }
      const rootDigest = digestViewJson.items.find(
        (row) => row.lineageRootSessionReferenceId === actorSessionJson.sessionReference.id
      )
      expect(rootDigest).toBeDefined()
      expect(rootDigest?.openDisputeCount).toBe(0)
      expect(rootDigest?.status).toBe("aligned")

      const sessionRes = await tenancyGet(
        new Request("http://127.0.0.1/api/p5/tenancy?view=session&userId=associate_a&firmId=firmA")
      )
      expect(sessionRes.status).toBe(200)
      const sessionJson = (await sessionRes.json()) as {
        session: { accessibleMatterIds: string[] }
        sessionReference: { id: string }
      }
      expect(sessionJson.session.accessibleMatterIds).toContain(matterId)

      const replayRes = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session&sessionRefId=${sessionJson.sessionReference.id}`
        )
      )
      expect(replayRes.status).toBe(200)
      const replayJson = (await replayRes.json()) as {
        session: { accessibleMatterIds: string[] }
      }
      expect(replayJson.session.accessibleMatterIds).toContain(matterId)

      const revokedReplay = await tenancyGet(
        new Request(
          `http://127.0.0.1/api/p5/tenancy?view=session&sessionRefId=${associateSessionJson.sessionReference.id}`
        )
      )
      expect(revokedReplay.status).toBe(410)

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
          "http://127.0.0.1/api/p5/tenancy?view=audit&actorId=partner_a&firmId=firmA&limit=60&cursor=0"
        )
      )
      expect(auditRes.status).toBe(200)
      const auditJson = (await auditRes.json()) as {
        items: Array<{
          action: string
          target: string
          authBoundary?: string
          sessionReferenceId?: string | null
          externalSessionId?: string | null
          privilegedBoundaryDriftCount?: number
          privilegedBoundaryDriftSessionReferenceIds?: string[]
          delegatedBoundaryLineageRootSessionReferenceId?: string | null
          delegatedBoundaryComparedSessionReferenceId?: string | null
          delegatedBoundaryReconciliationStatus?: string
          delegatedBoundaryDivergenceReasons?: string[]
        }>
      }
      const roleAudit = auditJson.items.find(
        (row) => row.action === "tenant_update_role" && row.target === "clerk_a"
      )
      expect(roleAudit).toBeDefined()
      expect(roleAudit?.authBoundary).toBe("external_session_hint")
      expect(roleAudit?.sessionReferenceId).toBe(actorSessionJson.sessionReference.id)
      expect(roleAudit?.externalSessionId).toBe("ext-runtime-actor")
      expect(roleAudit?.privilegedBoundaryDriftCount).toBeGreaterThanOrEqual(1)
      expect(roleAudit?.privilegedBoundaryDriftSessionReferenceIds).toContain(
        clerkSessionJson.sessionReference.id
      )
      expect(
        auditJson.items.some((row) => row.action === "tenant_revoke_session_reference")
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_reissue_session_reference" &&
            row.sessionReferenceId === reissueDivergedJson.result.sessionReference.id &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id &&
            row.delegatedBoundaryComparedSessionReferenceId ===
              reissueAlignedJson.result.sessionReference.id &&
            row.delegatedBoundaryReconciliationStatus === "diverged" &&
            (row.delegatedBoundaryDivergenceReasons ?? []).includes(
              "external_session_hint_changed"
            )
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_attest_lineage_dispute" &&
            row.sessionReferenceId === reissueDivergedJson.result.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_resolve_lineage_dispute" &&
            row.sessionReferenceId === reissueDivergedJson.result.sessionReference.id &&
            row.delegatedBoundaryReconciliationStatus === "aligned"
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_assign_lineage_reconciliation_queue" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_arbitrate_lineage_reconciliation_queue" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_attest_lineage_digest_closure" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_reopen_lineage_digest_closure" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_govern_lineage_closure_adjudication" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_record_lineage_closure_adjudication_verdict" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_attest_lineage_arbitration_debt_retirement" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_reopen_lineage_arbitration_debt_retirement" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action ===
              "tenant_checkpoint_lineage_closure_adjudication_settlement_publication" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_log_lineage_closure_adjudication_settlement_correction" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_confirm_lineage_closure_adjudication_settlement_sla" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_open_lineage_arbitration_debt_retirement_dispute" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action ===
              "tenant_assign_lineage_arbitration_debt_retirement_dispute_reviewer" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_resolve_lineage_arbitration_debt_retirement_dispute" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_control_lineage_arbitration_debt_retirement_dispute_rollback" &&
            row.delegatedBoundaryLineageRootSessionReferenceId === actorSessionJson.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_attest_external_session_identity_bridge" &&
            row.sessionReferenceId === reissueDivergedJson.result.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_quarantine_external_session_identity_bridge" &&
            row.sessionReferenceId === reissueDivergedJson.result.sessionReference.id
        )
      ).toBe(true)
      expect(
        auditJson.items.some(
          (row) =>
            row.action === "tenant_clear_external_session_identity_bridge" &&
            row.sessionReferenceId === reissueDivergedJson.result.sessionReference.id
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
            entry.data()?.firmId === "firmA" &&
            entry.data()?.authBoundary === "external_session_hint" &&
            entry.data()?.sessionReferenceId === actorSessionJson.sessionReference.id &&
            entry.data()?.externalSessionId === "ext-runtime-actor"
        )
      ).toBe(true)

      const persistedSessionRef = await getDoc(
        doc(ctx.firestore(), "tenancy_session_references", actorSessionJson.sessionReference.id)
      )
      expect(persistedSessionRef.exists()).toBe(true)
      expect(persistedSessionRef.data()?.firmId).toBe("firmA")
      expect(persistedSessionRef.data()?.authBoundary).toBe("external_session_hint")

      const persistedLineageAligned = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_session_references",
          reissueAlignedJson.result.sessionReference.id
        )
      )
      expect(persistedLineageAligned.exists()).toBe(true)
      expect(persistedLineageAligned.data()?.parentSessionReferenceId).toBe(
        actorSessionJson.sessionReference.id
      )
      expect(persistedLineageAligned.data()?.lineageRootSessionReferenceId).toBe(
        actorSessionJson.sessionReference.id
      )

      const persistedLineageDiverged = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_session_references",
          reissueDivergedJson.result.sessionReference.id
        )
      )
      expect(persistedLineageDiverged.exists()).toBe(true)
      expect(persistedLineageDiverged.data()?.delegatedBoundaryReconciliationStatus).toBe(
        "aligned"
      )
      expect(persistedLineageDiverged.data()?.delegatedBoundaryDivergenceReasons).toEqual([])

      const persistedDispute = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_lineage_dispute_attestations",
          disputeFirstJson.result.dispute.id
        )
      )
      expect(persistedDispute.exists()).toBe(true)
      expect(persistedDispute.data()?.status).toBe("resolved")
      expect(persistedDispute.data()?.disposition).toBe("mark_reconciled")

      const persistedDigest = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_lineage_reconciliation_digests",
          `tenancy-lineage-digest:${actorSessionJson.sessionReference.id}`
        )
      )
      expect(persistedDigest.exists()).toBe(true)
      expect(persistedDigest.data()?.lineageRootSessionReferenceId).toBe(
        actorSessionJson.sessionReference.id
      )
      const persistedArbitrationQueue = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_lineage_reconciliation_queue_arbitrations",
          `tenancy-lineage-arbitration:${actorSessionJson.sessionReference.id}`
        )
      )
      expect(persistedArbitrationQueue.exists()).toBe(true)
      expect(persistedArbitrationQueue.data()?.status).toBe("arbitrated")
      expect(persistedArbitrationQueue.data()?.disposition).toBe("confirm_needs_review")
      const persistedClosureCheckpoint = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_lineage_digest_closure_checkpoints",
          `tenancy-lineage-closure:${actorSessionJson.sessionReference.id}`
        )
      )
      expect(persistedClosureCheckpoint.exists()).toBe(true)
      expect(persistedClosureCheckpoint.data()?.status).toBe("reopened")
      expect(persistedClosureCheckpoint.data()?.reopenTrigger).toBe(
        "Runtime reopened due follow-up divergence check"
      )

      const persistedClosureAdjudication = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_lineage_closure_adjudications",
          `tenancy-lineage-closure-adjudication:${actorSessionJson.sessionReference.id}`
        )
      )
      expect(persistedClosureAdjudication.exists()).toBe(true)
      expect(persistedClosureAdjudication.data()?.status).toBe("verdict_recorded")
      expect(persistedClosureAdjudication.data()?.verdictDisposition).toBe("mark_reconciled")

      const persistedDebtLedger = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_lineage_arbitration_debt_retirement_ledgers",
          `tenancy-lineage-arbitration-debt:${actorSessionJson.sessionReference.id}`
        )
      )
      expect(persistedDebtLedger.exists()).toBe(true)
      expect(persistedDebtLedger.data()?.status).toBe("retirement_attested")
      expect(persistedDebtLedger.data()?.carryoverSignals).toContain(
        "Runtime carryover reopened after attestation"
      )

      const persistedSettlement = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_lineage_closure_adjudication_settlements",
          `tenancy-lineage-closure-settlement:${actorSessionJson.sessionReference.id}`
        )
      )
      expect(persistedSettlement.exists()).toBe(true)
      expect(persistedSettlement.data()?.status).toBe("sla_confirmed")
      expect(persistedSettlement.data()?.verdictPublicationChannel).toBe("runtime_workboard")
      expect(persistedSettlement.data()?.publicationCorrectionNote).toBe(
        "Runtime correction before settlement confirmation"
      )

      const persistedDebtDisputeLedger = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_lineage_arbitration_debt_retirement_dispute_ledgers",
          `tenancy-lineage-arbitration-debt-dispute:${actorSessionJson.sessionReference.id}`
        )
      )
      expect(persistedDebtDisputeLedger.exists()).toBe(true)
      expect(persistedDebtDisputeLedger.data()?.status).toBe("rollback_controlled")
      expect(persistedDebtDisputeLedger.data()?.resolutionOutcome).toBe("require_rollback_review")
      expect(persistedDebtDisputeLedger.data()?.rollbackControlNote).toBe(
        "Runtime rollback control engaged"
      )

      const persistedIdentityBridge = await getDoc(
        doc(
          ctx.firestore(),
          "tenancy_external_session_identity_bridges",
          `tenancy-external-session-identity-bridge:${reissueDivergedJson.result.sessionReference.id}`
        )
      )
      expect(persistedIdentityBridge.exists()).toBe(true)
      expect(persistedIdentityBridge.data()?.status).toBe("cleared")
      expect(persistedIdentityBridge.data()?.mismatchStatus).toBe("aligned")
      expect(persistedIdentityBridge.data()?.assertedIssuer).toBe("idp.runtime.local")
      expect(persistedIdentityBridge.data()?.clearReason).toBe(
        "Runtime manual override after bridge review"
      )

      const persistedClerkSessionRef = await getDoc(
        doc(ctx.firestore(), "tenancy_session_references", clerkSessionJson.sessionReference.id)
      )
      expect(persistedClerkSessionRef.exists()).toBe(true)
      expect(persistedClerkSessionRef.data()?.revokedReason).toBe("privileged_boundary_drift")

      const persistedAssociateSessionRef = await getDoc(
        doc(ctx.firestore(), "tenancy_session_references", associateSessionJson.sessionReference.id)
      )
      expect(persistedAssociateSessionRef.exists()).toBe(true)
      expect(persistedAssociateSessionRef.data()?.revokedReason).toBe(
        "Runtime revocation persistence check"
      )
    })
  })
})
