import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing"
import { createFirestoreRepositories } from "@/platform/persistence/firestoreSpineRepositories"

const RULES = readFileSync("firestore.rules", "utf8")

let env: RulesTestEnvironment

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "sikander-persistence-adapters",
    firestore: { rules: RULES },
  })
})

afterAll(async () => {
  await env.cleanup()
})

describe("Firestore repository adapters", () => {
  it("round-trips matters/documents/drafts/workflow/filings without secrets (emulator)", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore()
      const repos = createFirestoreRepositories(db)

      await repos.users.upsert({
        id: "associate_a",
        firmId: "firmA",
        role: "associate",
        clearanceLevel: "privileged",
      })
      const persistedUser = await repos.users.get("associate_a")
      expect(persistedUser?.role).toBe("associate")
      const firmUsers = await repos.users.listByFirm("firmA")
      expect(firmUsers.some((row) => row.id === "associate_a")).toBe(true)
      await repos.audit.append({
        id: "aud_1",
        firmId: "firmA",
        action: "tenant_update_role",
        actorId: "partner_a",
        target: "associate_a",
        classification: "internal",
        reason: "Audit parity",
        at: 11,
      })
      const auditRows = await repos.audit.listByFirm("firmA")
      expect(auditRows.some((row) => row.id === "aud_1" && row.action === "tenant_update_role")).toBe(
        true
      )
      await repos.committeeOutputs.create({
        id: "cbo_1",
        firmId: "firmA",
        actorId: "partner_a",
        classification: "internal",
        purpose: "committee-brain",
        blocked: true,
        reason: "phase0-no-credentials",
        outbound: {
          body: "[REDACTED]",
          metadata: {
            classification: "internal",
            provider: "ai-gateway",
            purpose: "committee-brain",
            redactionCounts: {},
          },
        },
        createdAt: 123,
      })
      const committeeOutput = await repos.committeeOutputs.get("cbo_1")
      expect(committeeOutput?.purpose).toBe("committee-brain")
      const committeeRows = await repos.committeeOutputs.listByFirm("firmA")
      expect(committeeRows.some((row) => row.id === "cbo_1" && row.actorId === "partner_a")).toBe(
        true
      )
      await repos.reportingIndex.upsert({
        id: "idx_1",
        firmId: "firmA",
        rowType: "matter",
        referenceId: "mat_1",
        classification: "internal",
        label: "Indexed Matter",
        detail: "SHC",
        linkedMatterId: "mat_1",
        linkedClientId: "client_a",
        status: "engagement_unconfirmed:pending",
        tags: ["indexed", "matter"],
        updatedAt: 12,
      })
      const indexRow = await repos.reportingIndex.get("idx_1")
      expect(indexRow?.label).toBe("Indexed Matter")
      const indexRows = await repos.reportingIndex.listByFirm("firmA")
      expect(indexRows.some((row) => row.id === "idx_1" && row.rowType === "matter")).toBe(true)
      await repos.draftTemplateAnalytics.upsert({
        id: "template:motion_template",
        firmId: "firmA",
        templateId: "motion_template",
        templateName: "Motion Template",
        templatePosture: "motion",
        templateCategory: "drafting",
        composeCount: 4,
        templateSearchCount: 7,
        lastComposedAt: 40,
        lastTemplateSearchAt: 41,
        lastTemplateSearchQuery: "motion",
        updatedAt: 42,
      })
      const draftTemplateAnalytics = await repos.draftTemplateAnalytics.get(
        "template:motion_template"
      )
      expect(draftTemplateAnalytics?.composeCount).toBe(4)
      const analyticsRows = await repos.draftTemplateAnalytics.listByFirm("firmA")
      expect(
        analyticsRows.some(
          (row) => row.templateId === "motion_template" && row.templateSearchCount === 7
        )
      ).toBe(true)
      await repos.workflowOpsActivity.upsert({
        id: "ops:workflow_event:wfe_1",
        firmId: "firmA",
        source: "workflow_event",
        action: "workflow_transition",
        actorId: "associate_a",
        classification: "internal",
        matterId: "mat_1",
        documentId: "doc_1",
        followUpId: null,
        queueType: null,
        status: "processing",
        detail: "moved to processing",
        tags: ["workflow", "processing", "mat_1"],
        createdAt: 44,
      })
      const opsRow = await repos.workflowOpsActivity.get("ops:workflow_event:wfe_1")
      expect(opsRow?.action).toBe("workflow_transition")
      const opsRows = await repos.workflowOpsActivity.listByFirm("firmA")
      expect(opsRows.some((row) => row.id === "ops:workflow_event:wfe_1")).toBe(true)
      await repos.entities.create({
        id: "ent_1",
        firmId: "firmA",
        canonicalName: "Client One",
        cnic: "4220112345678",
        phone: "+923001112233",
        classification: "internal",
      })
      const entity = await repos.entities.get("ent_1")
      expect(entity?.canonicalName).toBe("Client One")
      await repos.entityLinks.upsert({
        firmId: "firmA",
        leftId: "ent_1",
        rightId: "ent_2",
        identityBasis: "cnic",
        band: "confirmed-candidate",
        score: 0.99,
      })
      const links = await repos.entityLinks.listByFirm("firmA")
      expect(links.some((row) => row.leftId === "ent_1" && row.rightId === "ent_2")).toBe(true)

      await repos.matters.create({
        id: "mat_1",
        firmId: "firmA",
        clientId: "client_a",
        title: "Persisted matter",
        courtId: "SHC",
        caseNumber: null,
        caseNumberStatus: "pending",
        status: "engagement_unconfirmed",
        classification: "internal",
      })
      const matter = await repos.matters.get("mat_1")
      expect(matter?.title).toBe("Persisted matter")
      const matterRows = await repos.matters.listByFirm("firmA")
      expect(matterRows.some((row) => row.id === "mat_1")).toBe(true)
      await repos.members.upsert({
        matterId: "mat_1",
        userId: "associate_a",
        firmId: "firmA",
      })
      const member = await repos.members.get("mat_1", "associate_a")
      expect(member?.firmId).toBe("firmA")
      const members = await repos.members.listByMatter("mat_1")
      expect(members.some((row) => row.userId === "associate_a")).toBe(true)

      await repos.documents.create({
        id: "doc_1",
        firmId: "firmA",
        matterId: "mat_1",
        contentHash: "hash-1",
        sourceChannel: "web",
        classification: "internal",
      })
      const doc = await repos.documents.get("doc_1")
      expect(doc?.contentHash).toBe("hash-1")
      await repos.jobs.create({
        id: "job_1",
        firmId: "firmA",
        jobType: "ocr",
        documentId: "doc_1",
        classification: "internal",
        idempotencyKey: "idem-1",
      })
      const docJobs = await repos.jobs.listByDocument("doc_1")
      expect(docJobs.some((row) => row.id === "job_1")).toBe(true)

      await repos.drafts.create({
        id: "drf_1",
        firmId: "firmA",
        matterId: "mat_1",
        templateId: "motion",
        title: "Draft 1",
        body: "Body",
        classification: "internal",
        createdBy: "associate_a",
        createdAt: 1,
        status: "draft",
      })
      const draft = await repos.drafts.get("drf_1")
      expect(draft?.title).toBe("Draft 1")

      await repos.workflow.createOrUpdate({
        documentId: "doc_1",
        firmId: "firmA",
        matterId: "mat_1",
        status: "review_required",
        reviewerId: "associate_a",
        updatedAt: 2,
      })
      const workflow = await repos.workflow.get("doc_1")
      expect(workflow?.status).toBe("review_required")
      await repos.workflowEvents.append({
        id: "wfe_1",
        documentId: "doc_1",
        firmId: "firmA",
        matterId: "mat_1",
        actorId: "associate_a",
        action: "status_transition",
        status: "review_required",
        classification: "internal",
        reason: "moved to review",
        at: 4,
      })
      const events = await repos.workflowEvents.listByFirm("firmA")
      expect(events.some((row) => row.id === "wfe_1")).toBe(true)

      await repos.followUps.upsert({
        id: "fu_1",
        firmId: "firmA",
        matterId: "mat_1",
        courtId: "SHC",
        raw: "CP 1234",
        kind: "case_number_reject",
        status: "open",
      })
      const followUp = await repos.followUps.get("fu_1")
      expect(followUp?.kind).toBe("case_number_reject")
      await repos.followUps.upsert({
        ...(followUp as NonNullable<typeof followUp>),
        status: "resolved",
        resolvedBy: "associate_a",
        resolvedAt: 5,
      })
      const followUps = await repos.followUps.listByFirm("firmA")
      expect(followUps.some((row) => row.id === "fu_1" && row.status === "resolved")).toBe(true)

      await repos.intimations.upsert({
        id: "int_1",
        firmId: "firmA",
        matterId: "mat_1",
        notifiedAt: 10,
        confirmedAt: null,
      })
      const intimation = await repos.intimations.get("int_1")
      expect(intimation?.matterId).toBe("mat_1")
      const matterIntimations = await repos.intimations.listByMatter("mat_1")
      expect(matterIntimations.some((row) => row.id === "int_1")).toBe(true)

      await repos.filings.create({
        id: "pkg_1",
        firmId: "firmA",
        matterId: "mat_1",
        draftId: "drf_1",
        classification: "internal",
        citationStatus: "OK",
        temporalAllOk: true,
        status: "pending_partner_approval",
        createdBy: "associate_a",
        createdAt: 3,
        approvedBy: null,
        approvalReason: null,
      })
      const filing = await repos.filings.get("pkg_1")
      expect(filing?.status).toBe("pending_partner_approval")
      const filings = await repos.filings.listByFirm("firmA")
      expect(filings.some((row) => row.id === "pkg_1")).toBe(true)
      await repos.filingPacketArtifacts.upsert({
        id: "packet:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        draftId: "drf_1",
        classification: "internal",
        readiness: "blocked",
        blockedReasons: ["partner_approval_pending"],
        components: [
          {
            componentId: "draft_body",
            label: "Draft body",
            required: true,
            status: "ready",
            sourceRef: "drf_1",
          },
        ],
        updatedAt: 20,
      })
      const packetArtifact = await repos.filingPacketArtifacts.get("packet:pkg_1")
      expect(packetArtifact?.packageId).toBe("pkg_1")
      const packetArtifactsByFirm = await repos.filingPacketArtifacts.listByFirm("firmA")
      expect(packetArtifactsByFirm.some((row) => row.id === "packet:pkg_1")).toBe(true)
      const packetArtifactsByPackage = await repos.filingPacketArtifacts.listByPackageId("pkg_1")
      expect(packetArtifactsByPackage.some((row) => row.id === "packet:pkg_1")).toBe(true)
      await repos.filingDispatchQueue.upsert({
        id: "dispatch:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "queued",
        assigneeId: "clerk_a",
        retryCount: 1,
        lastAttemptAt: 21,
        operatorNotes: ["handoff staged"],
        externalDispatchState: "blocked_todo_firm",
        updatedAt: 22,
      })
      const dispatchRow = await repos.filingDispatchQueue.get("dispatch:pkg_1")
      expect(dispatchRow?.packageId).toBe("pkg_1")
      const dispatchByFirm = await repos.filingDispatchQueue.listByFirm("firmA")
      expect(dispatchByFirm.some((row) => row.id === "dispatch:pkg_1")).toBe(true)
      const dispatchByPackage = await repos.filingDispatchQueue.listByPackageId("pkg_1")
      expect(dispatchByPackage.some((row) => row.id === "dispatch:pkg_1")).toBe(true)
      await repos.filingAnnexures.upsert({
        id: "annexure:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        generationStatus: "assembling",
        manifest: [
          {
            artifactId: "annexure_draft_pdf",
            label: "Final draft PDF",
            required: true,
            status: "ready",
            sourceRef: "drf_1",
          },
        ],
        signerRequirements: {
          partnerSignoffBy: "partner_a",
          partnerSignoffAt: 23,
          clerkVerificationBy: null,
          clerkVerificationAt: null,
        },
        operatorNotes: ["manifest generated"],
        submissionTransportBoundary: "todo_firm_external_transport_blocked",
        updatedAt: 24,
      })
      const annexure = await repos.filingAnnexures.get("annexure:pkg_1")
      expect(annexure?.packageId).toBe("pkg_1")
      const annexuresByFirm = await repos.filingAnnexures.listByFirm("firmA")
      expect(annexuresByFirm.some((row) => row.id === "annexure:pkg_1")).toBe(true)
      const annexuresByPackage = await repos.filingAnnexures.listByPackageId("pkg_1")
      expect(annexuresByPackage.some((row) => row.id === "annexure:pkg_1")).toBe(true)
      await repos.filingSubmissionReceipts.upsert({
        id: "receipt:pkg_1:1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        attemptNo: 1,
        courtChannel: "efiling_portal_stub",
        dispatchOutcome: "retry_scheduled",
        submissionReference: "ref-001",
        failureReason: "timeout",
        retryHint: "retry in 1h",
        recordedBy: "clerk_a",
        recordedAt: 25,
        submissionTransportBoundary: "todo_firm_external_transport_blocked",
      })
      const receipt = await repos.filingSubmissionReceipts.get("receipt:pkg_1:1")
      expect(receipt?.dispatchOutcome).toBe("retry_scheduled")
      const receiptsByFirm = await repos.filingSubmissionReceipts.listByFirm("firmA")
      expect(receiptsByFirm.some((row) => row.id === "receipt:pkg_1:1")).toBe(true)
      const receiptsByPackage = await repos.filingSubmissionReceipts.listByPackageId("pkg_1")
      expect(receiptsByPackage.some((row) => row.id === "receipt:pkg_1:1")).toBe(true)
      await repos.filingSubmissionReconciliation.upsert({
        id: "reconcile:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        totalAttempts: 1,
        latestReceiptId: "receipt:pkg_1:1",
        latestSubmissionReference: "ref-001",
        latestDispatchOutcome: "retry_scheduled",
        status: "open",
        notes: ["awaiting retry"],
        updatedAt: 26,
      })
      const reconciliation = await repos.filingSubmissionReconciliation.get("reconcile:pkg_1")
      expect(reconciliation?.latestReceiptId).toBe("receipt:pkg_1:1")
      const reconciliationByFirm = await repos.filingSubmissionReconciliation.listByFirm("firmA")
      expect(reconciliationByFirm.some((row) => row.id === "reconcile:pkg_1")).toBe(true)
      const reconciliationByPackage = await repos.filingSubmissionReconciliation.listByPackageId("pkg_1")
      expect(reconciliationByPackage.some((row) => row.id === "reconcile:pkg_1")).toBe(true)
      await repos.filingSubmissionExceptions.upsert({
        id: "exception:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "open",
        severity: "high",
        source: "reconciliation_needs_retry",
        latestReceiptId: "receipt:pkg_1:1",
        latestReconciliationId: "reconcile:pkg_1",
        escalationOwnerId: "partner_a",
        firstRaisedAt: 27,
        lastRaisedAt: 28,
        slaTargetAt: 29,
        claimedBy: null,
        claimedAt: null,
        escalatedBy: null,
        escalatedAt: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: ["escalation opened"],
        updatedAt: 30,
      })
      const exception = await repos.filingSubmissionExceptions.get("exception:pkg_1")
      expect(exception?.severity).toBe("high")
      const exceptionByFirm = await repos.filingSubmissionExceptions.listByFirm("firmA")
      expect(exceptionByFirm.some((row) => row.id === "exception:pkg_1")).toBe(true)
      const exceptionByPackage = await repos.filingSubmissionExceptions.listByPackageId("pkg_1")
      expect(exceptionByPackage.some((row) => row.id === "exception:pkg_1")).toBe(true)
      await repos.filingTransportExecutionEvidence.upsert({
        id: "transport:pkg_1:1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        sequenceNo: 1,
        dispatchQueueId: "dispatch:pkg_1",
        outcome: "transport_blocked",
        transportOperatorId: "clerk_a",
        transportChannel: "efiling_portal_stub",
        channelPayloadHash: "hash-transport-001",
        deterministicBlockerTags: ["portal_timeout"],
        attachmentPointers: ["ops://retry-plan/1"],
        relatedReceiptId: "receipt:pkg_1:1",
        relatedReconciliationId: "reconcile:pkg_1",
        relatedExceptionId: "exception:pkg_1",
        note: "transport blocked during deterministic submission",
        createdAt: 31,
      })
      const transportEvidence = await repos.filingTransportExecutionEvidence.get("transport:pkg_1:1")
      expect(transportEvidence?.outcome).toBe("transport_blocked")
      const transportEvidenceByFirm = await repos.filingTransportExecutionEvidence.listByFirm("firmA")
      expect(transportEvidenceByFirm.some((row) => row.id === "transport:pkg_1:1")).toBe(true)
      const transportEvidenceByPackage = await repos.filingTransportExecutionEvidence.listByPackageId("pkg_1")
      expect(transportEvidenceByPackage.some((row) => row.id === "transport:pkg_1:1")).toBe(true)
      await repos.filingSubmissionSlaDigests.upsert({
        id: "digest:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "open_breach",
        breachReasons: ["sla_overdue"],
        staleRetryPlan: false,
        outstandingOwnerId: "partner_a",
        linkedExceptionId: "exception:pkg_1",
        linkedEvidenceId: "transport:pkg_1:1",
        breachWindowStartedAt: 32,
        deferUntil: null,
        acknowledgedBy: null,
        acknowledgedAt: null,
        deferredBy: null,
        deferredAt: null,
        clearedBy: null,
        clearedAt: null,
        notes: ["digest opened"],
        lastEvaluatedAt: 33,
        updatedAt: 33,
      })
      const digest = await repos.filingSubmissionSlaDigests.get("digest:pkg_1")
      expect(digest?.status).toBe("open_breach")
      const digestsByFirm = await repos.filingSubmissionSlaDigests.listByFirm("firmA")
      expect(digestsByFirm.some((row) => row.id === "digest:pkg_1")).toBe(true)
      const digestsByPackage = await repos.filingSubmissionSlaDigests.listByPackageId("pkg_1")
      expect(digestsByPackage.some((row) => row.id === "digest:pkg_1")).toBe(true)
      await repos.filingEscalationOwnerRota.upsert({
        id: "rota:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "active",
        primaryOwnerId: "partner_a",
        backupOwnerId: "partner_b",
        activeWindowStartAt: 34,
        activeWindowEndAt: 35,
        handoffRequired: true,
        handoffAcknowledgedBy: null,
        handoffAcknowledgedAt: null,
        lastAssignedBy: "partner_a",
        lastAssignedAt: 34,
        revokedBy: null,
        revokedAt: null,
        linkedExceptionId: "exception:pkg_1",
        linkedDigestId: "digest:pkg_1",
        notes: ["handoff pending"],
        updatedAt: 36,
      })
      const rota = await repos.filingEscalationOwnerRota.get("rota:pkg_1")
      expect(rota?.primaryOwnerId).toBe("partner_a")
      const rotaByFirm = await repos.filingEscalationOwnerRota.listByFirm("firmA")
      expect(rotaByFirm.some((row) => row.id === "rota:pkg_1")).toBe(true)
      const rotaByPackage = await repos.filingEscalationOwnerRota.listByPackageId("pkg_1")
      expect(rotaByPackage.some((row) => row.id === "rota:pkg_1")).toBe(true)
      await repos.filingEscalationWorkloadDigests.upsert({
        id: "workload:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "open_alert",
        alertReasons: ["overloaded_owner"],
        ownerId: "partner_a",
        ownerLoadCount: 4,
        ownerLoadThreshold: 3,
        handoffLagMs: 3600000,
        handoffLagBucket: "lt_4h",
        snoozeUntil: null,
        acknowledgedBy: null,
        acknowledgedAt: null,
        rebalancedBy: null,
        rebalancedAt: null,
        linkedRotaId: "rota:pkg_1",
        linkedDigestId: "digest:pkg_1",
        notes: ["owner overload detected"],
        lastEvaluatedAt: 37,
        updatedAt: 37,
      })
      const workload = await repos.filingEscalationWorkloadDigests.get("workload:pkg_1")
      expect(workload?.status).toBe("open_alert")
      const workloadByFirm = await repos.filingEscalationWorkloadDigests.listByFirm("firmA")
      expect(workloadByFirm.some((row) => row.id === "workload:pkg_1")).toBe(true)
      const workloadByPackage = await repos.filingEscalationWorkloadDigests.listByPackageId("pkg_1")
      expect(workloadByPackage.some((row) => row.id === "workload:pkg_1")).toBe(true)
    })
  })
})
