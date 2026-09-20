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
      await repos.filingEscalationPolicyBaselines.upsert({
        id: "policy:firmA:default",
        firmId: "firmA",
        packageId: null,
        matterId: null,
        classification: "internal",
        scope: "firm_default",
        ownerLoadThreshold: 3,
        handoffSlaMs: 4 * 60 * 60 * 1000,
        waiverWindowMs: 24 * 60 * 60 * 1000,
        setBy: "partner_a",
        setAt: 38,
        notes: ["firm policy baseline"],
        updatedAt: 38,
      })
      const policy = await repos.filingEscalationPolicyBaselines.get("policy:firmA:default")
      expect(policy?.scope).toBe("firm_default")
      const policiesByFirm = await repos.filingEscalationPolicyBaselines.listByFirm("firmA")
      expect(policiesByFirm.some((row) => row.id === "policy:firmA:default")).toBe(true)
      await repos.filingEscalationBreachWaivers.upsert({
        id: "waiver:pkg_1:1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "active",
        reason: "court closure window",
        grantedBy: "partner_a",
        grantedAt: 39,
        expiresAt: 40,
        revokedBy: null,
        revokedAt: null,
        linkedSlaDigestId: "digest:pkg_1",
        linkedWorkloadDigestId: "workload:pkg_1",
        notes: ["waiver granted"],
        updatedAt: 39,
      })
      const waiver = await repos.filingEscalationBreachWaivers.get("waiver:pkg_1:1")
      expect(waiver?.status).toBe("active")
      const waiversByFirm = await repos.filingEscalationBreachWaivers.listByFirm("firmA")
      expect(waiversByFirm.some((row) => row.id === "waiver:pkg_1:1")).toBe(true)
      const waiversByPackage = await repos.filingEscalationBreachWaivers.listByPackageId("pkg_1")
      expect(waiversByPackage.some((row) => row.id === "waiver:pkg_1:1")).toBe(true)
      await repos.filingEscalationPolicyVarianceDigests.upsert({
        id: "policy-variance:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "open_alert",
        varianceReasons: ["owner_load_threshold_override"],
        firmDefaultPolicyId: "policy:firmA:default",
        packagePolicyId: "policy:pkg_1:override",
        ownerLoadThresholdDefault: 3,
        ownerLoadThresholdEffective: 1,
        handoffSlaMsDefault: 0,
        handoffSlaMsEffective: 0,
        waiverWindowMsDefault: 24 * 60 * 60 * 1000,
        waiverWindowMsEffective: 6 * 60 * 60 * 1000,
        acknowledgedBy: null,
        acknowledgedAt: null,
        snoozeUntil: null,
        notes: ["variance detected"],
        lastEvaluatedAt: 40,
        updatedAt: 40,
      })
      const policyVariance = await repos.filingEscalationPolicyVarianceDigests.get("policy-variance:pkg_1")
      expect(policyVariance?.status).toBe("open_alert")
      const varianceByFirm = await repos.filingEscalationPolicyVarianceDigests.listByFirm("firmA")
      expect(varianceByFirm.some((row) => row.id === "policy-variance:pkg_1")).toBe(true)
      const varianceByPackage =
        await repos.filingEscalationPolicyVarianceDigests.listByPackageId("pkg_1")
      expect(varianceByPackage.some((row) => row.id === "policy-variance:pkg_1")).toBe(true)
      await repos.filingEscalationWaiverExpiryDigests.upsert({
        id: "waiver-expiry:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "open_expiry",
        reasons: ["expires_lte_4h"],
        linkedWaiverId: "waiver:pkg_1:1",
        linkedPolicyId: "policy:firmA:default",
        waiverExpiresAt: 41,
        msUntilExpiry: 2 * 60 * 60 * 1000,
        acknowledgedBy: null,
        acknowledgedAt: null,
        extendedBy: null,
        extendedAt: null,
        notes: ["expiry approaching"],
        lastEvaluatedAt: 41,
        updatedAt: 41,
      })
      const expiry = await repos.filingEscalationWaiverExpiryDigests.get("waiver-expiry:pkg_1")
      expect(expiry?.status).toBe("open_expiry")
      const expiryByFirm = await repos.filingEscalationWaiverExpiryDigests.listByFirm("firmA")
      expect(expiryByFirm.some((row) => row.id === "waiver-expiry:pkg_1")).toBe(true)
      const expiryByPackage = await repos.filingEscalationWaiverExpiryDigests.listByPackageId("pkg_1")
      expect(expiryByPackage.some((row) => row.id === "waiver-expiry:pkg_1")).toBe(true)
      await repos.filingEscalationVarianceRemediations.upsert({
        id: "remediation:pkg_1:1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        decision: "temporary_override",
        status: "active",
        linkedPolicyVarianceDigestId: "policy-variance:pkg_1",
        linkedPolicyId: "policy:pkg_1:override",
        justification: "Override accepted for constrained partner coverage window",
        decidedBy: "partner_a",
        decidedAt: 42,
        expiresAt: 48,
        secondApproverId: "partner_b",
        notes: ["remediation recorded"],
        updatedAt: 42,
      })
      const remediation = await repos.filingEscalationVarianceRemediations.get("remediation:pkg_1:1")
      expect(remediation?.decision).toBe("temporary_override")
      const remediationsByFirm = await repos.filingEscalationVarianceRemediations.listByFirm("firmA")
      expect(remediationsByFirm.some((row) => row.id === "remediation:pkg_1:1")).toBe(true)
      const remediationsByPackage =
        await repos.filingEscalationVarianceRemediations.listByPackageId("pkg_1")
      expect(remediationsByPackage.some((row) => row.id === "remediation:pkg_1:1")).toBe(true)
      await repos.filingEscalationWaiverRolloverAttestations.upsert({
        id: "rollover:pkg_1:1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        waiverId: "waiver:pkg_1:1",
        status: "attested",
        extensionHours: 8,
        previousExpiresAt: 43,
        newExpiresAt: 51,
        policyCapExpiresAt: 47,
        attestedBy: "partner_a",
        secondApproverId: "partner_b",
        justification: "Baseline cap exceeded; second approver attested controlled extension.",
        attestedAt: 44,
        notes: ["rollover attested"],
        updatedAt: 44,
      })
      const rollover = await repos.filingEscalationWaiverRolloverAttestations.get("rollover:pkg_1:1")
      expect(rollover?.status).toBe("attested")
      const rolloverByFirm = await repos.filingEscalationWaiverRolloverAttestations.listByFirm("firmA")
      expect(rolloverByFirm.some((row) => row.id === "rollover:pkg_1:1")).toBe(true)
      const rolloverByPackage =
        await repos.filingEscalationWaiverRolloverAttestations.listByPackageId("pkg_1")
      expect(rolloverByPackage.some((row) => row.id === "rollover:pkg_1:1")).toBe(true)
      await repos.filingEscalationRemediationExpiryDigests.upsert({
        id: "remediation-expiry:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "open_expiry",
        reasons: ["expires_lte_4h"],
        linkedRemediationId: "remediation:pkg_1:1",
        linkedLifecycleId: "remediation-lifecycle:remediation:pkg_1:1",
        linkedPolicyVarianceDigestId: "policy-variance:pkg_1",
        linkedPolicyId: "policy:pkg_1:override",
        remediationExpiresAt: 47,
        msUntilExpiry: 60 * 60 * 1000,
        acknowledgedBy: null,
        acknowledgedAt: null,
        snoozeUntil: null,
        notes: ["remediation expiry row"],
        lastEvaluatedAt: 45,
        updatedAt: 45,
      })
      const remediationExpiry = await repos.filingEscalationRemediationExpiryDigests.get(
        "remediation-expiry:pkg_1"
      )
      expect(remediationExpiry?.status).toBe("open_expiry")
      const remediationExpiryByFirm =
        await repos.filingEscalationRemediationExpiryDigests.listByFirm("firmA")
      expect(remediationExpiryByFirm.some((row) => row.id === "remediation-expiry:pkg_1")).toBe(true)
      const remediationExpiryByPackage =
        await repos.filingEscalationRemediationExpiryDigests.listByPackageId("pkg_1")
      expect(remediationExpiryByPackage.some((row) => row.id === "remediation-expiry:pkg_1")).toBe(
        true
      )
      await repos.filingEscalationRolloverBreachWatches.upsert({
        id: "rollover-breach:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "open_breach",
        reasons: ["reaffirmation_note_stale"],
        linkedWaiverId: "waiver:pkg_1:1",
        linkedAttestationId: "rollover:pkg_1:1",
        linkedPolicyId: "policy:pkg_1:override",
        policyCapExpiresAt: 47,
        waiverExpiresAt: 51,
        attestationUpdatedAt: 20,
        acknowledgedBy: null,
        acknowledgedAt: null,
        notes: ["rollover breach row"],
        lastEvaluatedAt: 46,
        updatedAt: 46,
      })
      const rolloverBreach = await repos.filingEscalationRolloverBreachWatches.get("rollover-breach:pkg_1")
      expect(rolloverBreach?.status).toBe("open_breach")
      const rolloverBreachByFirm = await repos.filingEscalationRolloverBreachWatches.listByFirm("firmA")
      expect(rolloverBreachByFirm.some((row) => row.id === "rollover-breach:pkg_1")).toBe(true)
      const rolloverBreachByPackage =
        await repos.filingEscalationRolloverBreachWatches.listByPackageId("pkg_1")
      expect(rolloverBreachByPackage.some((row) => row.id === "rollover-breach:pkg_1")).toBe(true)
      await repos.filingEscalationRemediationLifecycles.upsert({
        id: "remediation-lifecycle:remediation:pkg_1:1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        remediationId: "remediation:pkg_1:1",
        remediationDecision: "temporary_override",
        status: "open",
        linkedPolicyVarianceDigestId: "policy-variance:pkg_1",
        linkedPolicyId: "policy:pkg_1:override",
        expiresAt: 48,
        openedBy: "partner_a",
        openedAt: 42,
        closureOutcome: null,
        closureAttestedBy: null,
        closureAttestedAt: null,
        notes: ["lifecycle opened"],
        updatedAt: 42,
      })
      const lifecycle = await repos.filingEscalationRemediationLifecycles.get(
        "remediation-lifecycle:remediation:pkg_1:1"
      )
      expect(lifecycle?.status).toBe("open")
      const lifecycleByFirm = await repos.filingEscalationRemediationLifecycles.listByFirm("firmA")
      expect(
        lifecycleByFirm.some((row) => row.id === "remediation-lifecycle:remediation:pkg_1:1")
      ).toBe(true)
      const lifecycleByPackage = await repos.filingEscalationRemediationLifecycles.listByPackageId("pkg_1")
      expect(
        lifecycleByPackage.some((row) => row.id === "remediation-lifecycle:remediation:pkg_1:1")
      ).toBe(true)
      await repos.filingEscalationRolloverReaffirmationSlas.upsert({
        id: "rollover-reaffirmation-sla:pkg_1",
        firmId: "firmA",
        packageId: "pkg_1",
        matterId: "mat_1",
        classification: "internal",
        status: "warning",
        reasons: ["cap_crossed_reaffirmation_warning"],
        linkedWaiverId: "waiver:pkg_1:1",
        linkedAttestationId: "rollover:pkg_1:1",
        linkedPolicyId: "policy:pkg_1:override",
        policyCapExpiresAt: 47,
        waiverExpiresAt: 51,
        lastReaffirmedAt: 44,
        elapsedSinceReaffirmationMs: 5 * 60 * 60 * 1000,
        warningThresholdMs: 3 * 60 * 60 * 1000,
        breachThresholdMs: 6 * 60 * 60 * 1000,
        acknowledgedBy: null,
        acknowledgedAt: null,
        notes: ["reaffirmation warning"],
        lastEvaluatedAt: 46,
        updatedAt: 46,
      })
      const reaffirmation = await repos.filingEscalationRolloverReaffirmationSlas.get(
        "rollover-reaffirmation-sla:pkg_1"
      )
      expect(reaffirmation?.status).toBe("warning")
      const reaffirmationByFirm = await repos.filingEscalationRolloverReaffirmationSlas.listByFirm(
        "firmA"
      )
      expect(
        reaffirmationByFirm.some((row) => row.id === "rollover-reaffirmation-sla:pkg_1")
      ).toBe(true)
      const reaffirmationByPackage =
        await repos.filingEscalationRolloverReaffirmationSlas.listByPackageId("pkg_1")
      expect(
        reaffirmationByPackage.some((row) => row.id === "rollover-reaffirmation-sla:pkg_1")
      ).toBe(true)
      await repos.filingEscalationClosureComplianceDigests.upsert({
        id: "closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        classification: "internal",
        status: "open_alert",
        pendingLifecycleCount: 1,
        breachedReaffirmationCount: 1,
        linkedPackageIds: ["pkg_1"],
        linkedLifecycleIds: ["remediation-lifecycle:remediation:pkg_1:1"],
        linkedReaffirmationSlaIds: ["rollover-reaffirmation-sla:pkg_1"],
        linkedFollowupQueueId: "closure-followup:closure-compliance:firmA:partner_a",
        acknowledgedBy: null,
        acknowledgedAt: null,
        notes: ["closure compliance digest row"],
        lastEvaluatedAt: 47,
        updatedAt: 47,
      })
      const closureDigest = await repos.filingEscalationClosureComplianceDigests.get(
        "closure-compliance:firmA:partner_a"
      )
      expect(closureDigest?.status).toBe("open_alert")
      const closureDigestsByFirm =
        await repos.filingEscalationClosureComplianceDigests.listByFirm("firmA")
      expect(
        closureDigestsByFirm.some((row) => row.id === "closure-compliance:firmA:partner_a")
      ).toBe(true)
      const closureDigestsByOwner =
        await repos.filingEscalationClosureComplianceDigests.listByOwnerId("partner_a")
      expect(
        closureDigestsByOwner.some((row) => row.id === "closure-compliance:firmA:partner_a")
      ).toBe(true)
      await repos.filingEscalationClosureFollowupQueues.upsert({
        id: "closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        digestId: "closure-compliance:firmA:partner_a",
        classification: "internal",
        status: "claimed",
        packageIds: ["pkg_1"],
        pendingLifecycleCount: 1,
        breachedReaffirmationCount: 1,
        assignedPartnerId: "partner_a",
        claimedBy: "partner_a",
        claimedAt: 48,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        notes: ["closure follow-up queue row"],
        updatedAt: 48,
      })
      const closureQueue = await repos.filingEscalationClosureFollowupQueues.get(
        "closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureQueue?.status).toBe("claimed")
      const closureQueueByFirm = await repos.filingEscalationClosureFollowupQueues.listByFirm("firmA")
      expect(
        closureQueueByFirm.some(
          (row) => row.id === "closure-followup:closure-compliance:firmA:partner_a"
        )
      ).toBe(true)
      const closureQueueByOwner =
        await repos.filingEscalationClosureFollowupQueues.listByOwnerId("partner_a")
      expect(
        closureQueueByOwner.some(
          (row) => row.id === "closure-followup:closure-compliance:firmA:partner_a"
        )
      ).toBe(true)
      await repos.filingEscalationClosureSlaWindowConfigs.upsert({
        id: "closure-sla-window-config:firmA:default",
        firmId: "firmA",
        ownerId: null,
        classification: "internal",
        scope: "firm_default",
        ackDeadlineMs: 2 * 60 * 60 * 1000,
        clearDeadlineMs: 8 * 60 * 60 * 1000,
        autoEscalationMs: 12 * 60 * 60 * 1000,
        setBy: "partner_a",
        setAt: 49,
        notes: ["closure SLA config row"],
        updatedAt: 49,
      })
      const closureSlaConfig = await repos.filingEscalationClosureSlaWindowConfigs.get(
        "closure-sla-window-config:firmA:default"
      )
      expect(closureSlaConfig?.scope).toBe("firm_default")
      const closureSlaConfigByFirm =
        await repos.filingEscalationClosureSlaWindowConfigs.listByFirm("firmA")
      expect(
        closureSlaConfigByFirm.some((row) => row.id === "closure-sla-window-config:firmA:default")
      ).toBe(true)
      await repos.filingEscalationClosureAutoAssignmentRules.upsert({
        id: "closure-auto-assignment-rule:firmA:default",
        firmId: "firmA",
        ownerId: null,
        classification: "internal",
        mode: "owner_rota",
        enabled: true,
        maxActiveClaimsPerPartner: 6,
        setBy: "partner_a",
        setAt: 50,
        notes: ["closure auto-assignment rule row"],
        updatedAt: 50,
      })
      const closureAutoRule = await repos.filingEscalationClosureAutoAssignmentRules.get(
        "closure-auto-assignment-rule:firmA:default"
      )
      expect(closureAutoRule?.mode).toBe("owner_rota")
      const closureAutoRuleByFirm =
        await repos.filingEscalationClosureAutoAssignmentRules.listByFirm("firmA")
      expect(
        closureAutoRuleByFirm.some((row) => row.id === "closure-auto-assignment-rule:firmA:default")
      ).toBe(true)
      await repos.filingEscalationClosureSlaWindows.upsert({
        id: "closure-sla-window:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        digestId: "closure-compliance:firmA:partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        status: "ack_breached",
        pressureLevel: "elevated",
        openedAt: 40,
        acknowledgedAt: null,
        clearedAt: null,
        ackDeadlineAt: 42,
        clearDeadlineAt: 46,
        autoEscalateAt: 50,
        breachedAt: 43,
        autoEscalationTriggeredAt: null,
        autoEscalatedToPartnerId: null,
        linkedConfigId: "closure-sla-window-config:firmA:default",
        linkedAutoAssignmentRuleId: "closure-auto-assignment-rule:firmA:default",
        notes: ["closure SLA window row"],
        updatedAt: 51,
      })
      const closureSlaWindow = await repos.filingEscalationClosureSlaWindows.get(
        "closure-sla-window:closure-compliance:firmA:partner_a"
      )
      expect(closureSlaWindow?.status).toBe("ack_breached")
      const closureSlaWindowByFirm = await repos.filingEscalationClosureSlaWindows.listByFirm("firmA")
      expect(
        closureSlaWindowByFirm.some(
          (row) => row.id === "closure-sla-window:closure-compliance:firmA:partner_a"
        )
      ).toBe(true)
      await repos.filingEscalationClosureAttestations.upsert({
        id: "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1",
        sequenceNo: 1,
        firmId: "firmA",
        ownerId: "partner_a",
        digestId: "closure-compliance:firmA:partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        linkedSlaWindowId: "closure-sla-window:closure-compliance:firmA:partner_a",
        linkedExceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "pending_second_review",
        claimPartnerId: "partner_a",
        claimAt: 48,
        resolutionPartnerId: "partner_a",
        resolutionAt: 52,
        attestedBy: "partner_a",
        attestedAt: 53,
        secondReviewerId: "partner_b",
        secondReviewedBy: null,
        secondReviewedAt: null,
        partnerConcurrence: true,
        evidenceNote: "claim evidence attached",
        notes: ["attestation row"],
        updatedAt: 53,
      })
      const closureAttestation = await repos.filingEscalationClosureAttestations.get(
        "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1"
      )
      expect(closureAttestation?.status).toBe("pending_second_review")
      const closureAttestationsByFirm =
        await repos.filingEscalationClosureAttestations.listByFirm("firmA")
      expect(
        closureAttestationsByFirm.some(
          (row) =>
            row.id === "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1"
        )
      ).toBe(true)
      await repos.filingEscalationClosureSlaExceptionDigests.upsert({
        id: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        digestId: "closure-compliance:firmA:partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "open_exception",
        pressureLevel: "critical",
        reasons: ["ack_deadline_breached", "attestation_pending"],
        waiverReason: null,
        waivedBy: null,
        waivedAt: null,
        waiverExpiresAt: null,
        expiredAt: null,
        linkedSlaWindowId: "closure-sla-window:closure-compliance:firmA:partner_a",
        linkedAttestationId:
          "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1",
        linkedConfigId: "closure-sla-window-config:firmA:default",
        linkedAutoAssignmentRuleId: "closure-auto-assignment-rule:firmA:default",
        notes: ["exception digest row"],
        lastEvaluatedAt: 54,
        updatedAt: 54,
      })
      const closureExceptionDigest = await repos.filingEscalationClosureSlaExceptionDigests.get(
        "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureExceptionDigest?.pressureLevel).toBe("critical")
      const closureExceptionDigestsByFirm =
        await repos.filingEscalationClosureSlaExceptionDigests.listByFirm("firmA")
      expect(
        closureExceptionDigestsByFirm.some(
          (row) =>
            row.id === "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a"
        )
      ).toBe(true)
      await repos.filingEscalationClosureAttestationDisputes.upsert({
        id: "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        sequenceNo: 1,
        firmId: "firmA",
        ownerId: "partner_a",
        digestId: "closure-compliance:firmA:partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        attestationId: "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1",
        exceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "open_dispute",
        conflictReason: "conflicting evidence timing",
        openedBy: "partner_b",
        openedAt: 55,
        reviewerChainIds: ["partner_a", "partner_b"],
        reviewerChainSnapshot: "partner_a -> partner_b",
        underReviewBy: null,
        underReviewAt: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        notes: ["dispute opened"],
        updatedAt: 55,
      })
      const closureDispute = await repos.filingEscalationClosureAttestationDisputes.get(
        "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureDispute?.status).toBe("open_dispute")
      const closureDisputesByFirm =
        await repos.filingEscalationClosureAttestationDisputes.listByFirm("firmA")
      expect(
        closureDisputesByFirm.some((row) =>
          row.id.includes("closure-attestation-dispute:closure-attestation:closure-followup")
        )
      ).toBe(true)
      await repos.filingEscalationClosureSlaExceptionEnforcement.upsert({
        id: "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        digestId: "closure-compliance:firmA:partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        exceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "reminder_sent",
        waiverExpiresAt: 58,
        msUntilExpiry: 3_600_000,
        reminderCount: 2,
        escalationCount: 0,
        lastReminderAt: 56,
        lastEscalatedAt: null,
        linkedAttestationDisputeId:
          "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        notes: ["reminder sent"],
        lastEvaluatedAt: 57,
        updatedAt: 57,
      })
      const closureEnforcement = await repos.filingEscalationClosureSlaExceptionEnforcement.get(
        "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureEnforcement?.status).toBe("reminder_sent")
      const closureEnforcementByFirm =
        await repos.filingEscalationClosureSlaExceptionEnforcement.listByFirm("firmA")
      expect(
        closureEnforcementByFirm.some(
          (row) =>
            row.id ===
            "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmA:partner_a"
        )
      ).toBe(true)
    })
  })
})
