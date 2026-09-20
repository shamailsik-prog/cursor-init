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
          `http://127.0.0.1/api/d4/filings?view=escalation_workload_digests&userId=associate_a&matterId=${matterId}&packageId=${packageId}&workloadStatus=cleared&limit=10&cursor=0`
        )
      )
      expect(rehydratedWorkload.status).toBe(200)
      const rehydratedWorkloadJson = (await rehydratedWorkload.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedWorkloadJson.items.some(
          (item) => item.packageId === packageId && item.status === "cleared"
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
          `http://127.0.0.1/api/d4/filings?view=rollover_reaffirmation_sla&userId=associate_a&matterId=${matterId}&packageId=${packageId}&status=within_sla&limit=10&cursor=0`
        )
      )
      expect(rehydratedReaffirmationSla.status).toBe(200)
      const rehydratedReaffirmationSlaJson = (await rehydratedReaffirmationSla.json()) as {
        items: Array<{ packageId: string; status: string }>
      }
      expect(
        rehydratedReaffirmationSlaJson.items.some(
          (item) => item.packageId === packageId && item.status === "within_sla"
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
      getRuntimeStore().audit = []
      const auditView = await tenancyGet(
        new Request(
          "http://127.0.0.1/api/p5/tenancy?view=audit&actorId=partner_a&firmId=firmA&limit=50&cursor=0"
        )
      )
      expect(auditView.status).toBe(200)
      const auditViewJson = (await auditView.json()) as {
        items: Array<{ action: string; target: string }>
      }
      expect(
        auditViewJson.items.some(
          (item) =>
            item.action === "filing_dispatch_update" && item.target === `dispatch:${packageId}`
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
            entry.data()?.status === "cleared"
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
            entry.data()?.status === "within_sla"
        )
      ).toBe(true)
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
