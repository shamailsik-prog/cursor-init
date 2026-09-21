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
      const repos = createFirestoreRepositories(
        db as unknown as Parameters<typeof createFirestoreRepositories>[0]
      )

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
      await repos.tenancySessionReferences.upsert({
        id: "tsr_1",
        firmId: "firmA",
        userId: "partner_a",
        roleSnapshot: "partner",
        clearanceSnapshot: "privileged-restricted",
        parentSessionReferenceId: null,
        lineageRootSessionReferenceId: "tsr_1",
        lineageDepth: 0,
        authBoundary: "external_session_hint",
        externalSessionId: "ext-repo-1",
        delegatedBoundaryComparedSessionReferenceId: null,
        delegatedBoundaryReconciliationStatus: "aligned",
        delegatedBoundaryDivergenceReasons: [],
        delegatedBoundaryReconciledAt: null,
        delegatedBoundaryReconciledBy: null,
        issuedAt: 101,
        lastSeenAt: 102,
        expiresAt: 103,
        revokedAt: null,
        revokedBy: null,
        revokedReason: null,
        privilegedBoundaryDriftedAt: null,
        privilegedBoundaryDriftedBy: null,
        privilegedBoundaryDriftReason: null,
      })
      const sessionRef = await repos.tenancySessionReferences.get("tsr_1")
      expect(sessionRef?.userId).toBe("partner_a")
      const firmSessionRefs = await repos.tenancySessionReferences.listByFirm("firmA")
      expect(firmSessionRefs.some((row) => row.id === "tsr_1")).toBe(true)
      const userSessionRefs = await repos.tenancySessionReferences.listByUserId("partner_a")
      expect(userSessionRefs.some((row) => row.id === "tsr_1")).toBe(true)
      await repos.tenancyLineageDisputeAttestations.upsert({
        id: "tld_1",
        firmId: "firmA",
        lineageRootSessionReferenceId: "tsr_1",
        sessionReferenceId: "tsr_1",
        parentSessionReferenceId: null,
        raisedBy: "partner_a",
        raisedAt: 104,
        reason: "lineage mismatch",
        notes: ["review requested"],
        status: "open",
        reviewedBy: null,
        reviewedAt: null,
        disposition: null,
        resolutionNote: null,
      })
      const dispute = await repos.tenancyLineageDisputeAttestations.get("tld_1")
      expect(dispute?.status).toBe("open")
      const disputesByFirm = await repos.tenancyLineageDisputeAttestations.listByFirm("firmA")
      expect(disputesByFirm.some((row) => row.id === "tld_1")).toBe(true)
      const disputesByRoot = await repos.tenancyLineageDisputeAttestations.listByLineageRoot("tsr_1")
      expect(disputesByRoot.some((row) => row.id === "tld_1")).toBe(true)
      await repos.tenancyLineageReconciliationDigests.upsert({
        id: "tenancy-lineage-digest:tsr_1",
        firmId: "firmA",
        lineageRootSessionReferenceId: "tsr_1",
        lineageNodeCount: 2,
        lineageDepthMax: 1,
        divergedHopCount: 1,
        openDisputeCount: 1,
        resolvedDisputeCount: 0,
        unresolvedRevocationCount: 0,
        status: "needs_review",
        reasons: ["open_lineage_dispute", "delegated_boundary_divergence"],
        updatedAt: 105,
      })
      const tenancyDigest = await repos.tenancyLineageReconciliationDigests.get(
        "tenancy-lineage-digest:tsr_1"
      )
      expect(tenancyDigest?.status).toBe("needs_review")
      const tenancyDigestsByFirm = await repos.tenancyLineageReconciliationDigests.listByFirm(
        "firmA"
      )
      expect(
        tenancyDigestsByFirm.some((row) => row.lineageRootSessionReferenceId === "tsr_1")
      ).toBe(true)
      await repos.tenancyLineageReconciliationQueueArbitrations.upsert({
        id: "tenancy-lineage-arbitration:tsr_1",
        firmId: "firmA",
        lineageRootSessionReferenceId: "tsr_1",
        digestId: "tenancy-lineage-digest:tsr_1",
        digestStatus: "needs_review",
        status: "assigned",
        assignedPartnerId: "partner_a",
        assignedBy: "partner_a",
        assignedAt: 106,
        slaWindowStartedAt: 106,
        slaWindowDueAt: 406,
        disposition: null,
        dispositionBy: null,
        dispositionAt: null,
        notes: ["queue assigned"],
        updatedAt: 106,
      })
      const tenancyQueue = await repos.tenancyLineageReconciliationQueueArbitrations.get(
        "tenancy-lineage-arbitration:tsr_1"
      )
      expect(tenancyQueue?.status).toBe("assigned")
      const tenancyQueueByFirm =
        await repos.tenancyLineageReconciliationQueueArbitrations.listByFirm("firmA")
      expect(
        tenancyQueueByFirm.some((row) => row.lineageRootSessionReferenceId === "tsr_1")
      ).toBe(true)
      const tenancyQueueByRoot =
        await repos.tenancyLineageReconciliationQueueArbitrations.listByLineageRoot("tsr_1")
      expect(tenancyQueueByRoot.some((row) => row.id === "tenancy-lineage-arbitration:tsr_1")).toBe(
        true
      )
      await repos.tenancyLineageDigestClosureCheckpoints.upsert({
        id: "tenancy-lineage-closure:tsr_1",
        firmId: "firmA",
        lineageRootSessionReferenceId: "tsr_1",
        digestId: "tenancy-lineage-digest:tsr_1",
        status: "closed_attested",
        attestedBy: "partner_a",
        attestedAt: 107,
        closureReason: "queue arbitration completed",
        reopenTrigger: null,
        reopenedBy: null,
        reopenedAt: null,
        notes: ["closure attested"],
        updatedAt: 107,
      })
      const tenancyClosure = await repos.tenancyLineageDigestClosureCheckpoints.get(
        "tenancy-lineage-closure:tsr_1"
      )
      expect(tenancyClosure?.status).toBe("closed_attested")
      const tenancyClosuresByFirm = await repos.tenancyLineageDigestClosureCheckpoints.listByFirm(
        "firmA"
      )
      expect(tenancyClosuresByFirm.some((row) => row.id === "tenancy-lineage-closure:tsr_1")).toBe(
        true
      )
      const tenancyClosuresByRoot =
        await repos.tenancyLineageDigestClosureCheckpoints.listByLineageRoot("tsr_1")
      expect(tenancyClosuresByRoot.some((row) => row.id === "tenancy-lineage-closure:tsr_1")).toBe(
        true
      )
      await repos.tenancyLineageClosureAdjudications.upsert({
        id: "tenancy-lineage-closure-adjudication:tsr_1",
        firmId: "firmA",
        lineageRootSessionReferenceId: "tsr_1",
        digestId: "tenancy-lineage-digest:tsr_1",
        arbitrationQueueId: "tenancy-lineage-arbitration:tsr_1",
        closureCheckpointId: "tenancy-lineage-closure:tsr_1",
        status: "quorum_pending",
        requiredPanelQuorum: 2,
        confirmedPanelPartnerIds: ["partner_a"],
        verdictWindowStartedAt: null,
        verdictWindowDueAt: null,
        verdictDisposition: null,
        verdictRecordedBy: null,
        verdictRecordedAt: null,
        dispositionDriftReasons: ["closure_checkpoint_reopened"],
        reopenedClosureTrigger: "digest_regressed:open_lineage_dispute",
        notes: ["quorum pending"],
        updatedAt: 108,
      })
      const tenancyAdjudication = await repos.tenancyLineageClosureAdjudications.get(
        "tenancy-lineage-closure-adjudication:tsr_1"
      )
      expect(tenancyAdjudication?.status).toBe("quorum_pending")
      const tenancyAdjudicationsByFirm = await repos.tenancyLineageClosureAdjudications.listByFirm(
        "firmA"
      )
      expect(
        tenancyAdjudicationsByFirm.some(
          (row) => row.id === "tenancy-lineage-closure-adjudication:tsr_1"
        )
      ).toBe(true)
      const tenancyAdjudicationsByRoot =
        await repos.tenancyLineageClosureAdjudications.listByLineageRoot("tsr_1")
      expect(
        tenancyAdjudicationsByRoot.some(
          (row) => row.id === "tenancy-lineage-closure-adjudication:tsr_1"
        )
      ).toBe(true)
      await repos.tenancyLineageArbitrationDebtRetirementLedgers.upsert({
        id: "tenancy-lineage-arbitration-debt:tsr_1",
        firmId: "firmA",
        lineageRootSessionReferenceId: "tsr_1",
        digestId: "tenancy-lineage-digest:tsr_1",
        arbitrationQueueId: "tenancy-lineage-arbitration:tsr_1",
        closureCheckpointId: "tenancy-lineage-closure:tsr_1",
        status: "pressure_open",
        unresolvedQueuePressureCount: 3,
        ownerAssignmentDebtCount: 1,
        assignedPartnerId: null,
        retirementAttestedBy: null,
        retirementAttestedAt: null,
        retirementNote: null,
        carryoverSignals: ["open_dispute_pressure", "owner_assignment_debt"],
        carryoverReopenedBy: null,
        carryoverReopenedAt: null,
        notes: ["queue pressure open"],
        updatedAt: 109,
      })
      const tenancyDebtLedger = await repos.tenancyLineageArbitrationDebtRetirementLedgers.get(
        "tenancy-lineage-arbitration-debt:tsr_1"
      )
      expect(tenancyDebtLedger?.status).toBe("pressure_open")
      const tenancyDebtLedgersByFirm =
        await repos.tenancyLineageArbitrationDebtRetirementLedgers.listByFirm("firmA")
      expect(
        tenancyDebtLedgersByFirm.some((row) => row.id === "tenancy-lineage-arbitration-debt:tsr_1")
      ).toBe(true)
      const tenancyDebtLedgersByRoot =
        await repos.tenancyLineageArbitrationDebtRetirementLedgers.listByLineageRoot("tsr_1")
      expect(
        tenancyDebtLedgersByRoot.some((row) => row.id === "tenancy-lineage-arbitration-debt:tsr_1")
      ).toBe(true)
      await repos.tenancyLineageClosureAdjudicationSettlements.upsert({
        id: "tenancy-lineage-closure-settlement:tsr_1",
        firmId: "firmA",
        lineageRootSessionReferenceId: "tsr_1",
        digestId: "tenancy-lineage-digest:tsr_1",
        adjudicationId: "tenancy-lineage-closure-adjudication:tsr_1",
        status: "publication_checkpointed",
        verdictPublicationCheckpointedBy: "partner_a",
        verdictPublicationCheckpointedAt: 110,
        verdictPublicationChannel: "partner_workboard",
        publicationCorrectionNote: null,
        publicationCorrectionBy: null,
        publicationCorrectionAt: null,
        settlementConfirmationSlaStartedAt: 111,
        settlementConfirmationSlaDueAt: 211,
        settlementConfirmedBy: null,
        settlementConfirmedAt: null,
        settlementSlaBreached: false,
        notes: ["publication logged"],
        updatedAt: 112,
      })
      const tenancySettlement = await repos.tenancyLineageClosureAdjudicationSettlements.get(
        "tenancy-lineage-closure-settlement:tsr_1"
      )
      expect(tenancySettlement?.status).toBe("publication_checkpointed")
      const tenancySettlementsByFirm =
        await repos.tenancyLineageClosureAdjudicationSettlements.listByFirm("firmA")
      expect(
        tenancySettlementsByFirm.some((row) => row.id === "tenancy-lineage-closure-settlement:tsr_1")
      ).toBe(true)
      const tenancySettlementsByRoot =
        await repos.tenancyLineageClosureAdjudicationSettlements.listByLineageRoot("tsr_1")
      expect(
        tenancySettlementsByRoot.some((row) => row.id === "tenancy-lineage-closure-settlement:tsr_1")
      ).toBe(true)
      await repos.tenancyLineageArbitrationDebtRetirementDisputeLedgers.upsert({
        id: "tenancy-lineage-arbitration-debt-dispute:tsr_1",
        firmId: "firmA",
        lineageRootSessionReferenceId: "tsr_1",
        digestId: "tenancy-lineage-digest:tsr_1",
        debtLedgerId: "tenancy-lineage-arbitration-debt:tsr_1",
        status: "reviewer_assigned",
        challengeReason: "retirement packet incomplete",
        challengeOpenedBy: "partner_a",
        challengeOpenedAt: 113,
        reviewerId: "partner_a",
        reviewerAssignedBy: "partner_a",
        reviewerAssignedAt: 114,
        resolutionOutcome: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        rollbackControlBy: null,
        rollbackControlAt: null,
        rollbackControlNote: null,
        notes: ["review pending"],
        updatedAt: 115,
      })
      const tenancyDebtDispute =
        await repos.tenancyLineageArbitrationDebtRetirementDisputeLedgers.get(
          "tenancy-lineage-arbitration-debt-dispute:tsr_1"
        )
      expect(tenancyDebtDispute?.status).toBe("reviewer_assigned")
      const tenancyDebtDisputesByFirm =
        await repos.tenancyLineageArbitrationDebtRetirementDisputeLedgers.listByFirm("firmA")
      expect(
        tenancyDebtDisputesByFirm.some(
          (row) => row.id === "tenancy-lineage-arbitration-debt-dispute:tsr_1"
        )
      ).toBe(true)
      const tenancyDebtDisputesByRoot =
        await repos.tenancyLineageArbitrationDebtRetirementDisputeLedgers.listByLineageRoot("tsr_1")
      expect(
        tenancyDebtDisputesByRoot.some(
          (row) => row.id === "tenancy-lineage-arbitration-debt-dispute:tsr_1"
        )
      ).toBe(true)
      await repos.tenancyExternalSessionIdentityBridges.upsert({
        id: "tenancy-external-session-identity-bridge:tsr_1_child",
        firmId: "firmA",
        lineageRootSessionReferenceId: "tsr_1",
        sessionReferenceId: "tsr_1_child",
        authBoundary: "external_session_hint",
        sessionExternalSessionId: "ext-tsr-1-child",
        status: "attested",
        mismatchStatus: "aligned",
        mismatchReasons: [],
        assertedIssuer: "idp.local",
        assertedSubject: "subject:partner_a",
        assertedExternalSessionId: "ext-tsr-1-child",
        attestedBy: "partner_a",
        attestedAt: 116,
        quarantinedBy: null,
        quarantinedAt: null,
        quarantineReason: null,
        clearedBy: null,
        clearedAt: null,
        clearReason: null,
        notes: ["initial bridge attestation"],
        updatedAt: 117,
      })
      const tenancyIdentityBridge = await repos.tenancyExternalSessionIdentityBridges.get(
        "tenancy-external-session-identity-bridge:tsr_1_child"
      )
      expect(tenancyIdentityBridge?.status).toBe("attested")
      const tenancyIdentityBridgesByFirm =
        await repos.tenancyExternalSessionIdentityBridges.listByFirm("firmA")
      expect(
        tenancyIdentityBridgesByFirm.some(
          (row) => row.id === "tenancy-external-session-identity-bridge:tsr_1_child"
        )
      ).toBe(true)
      const tenancyIdentityBridgesByRoot =
        await repos.tenancyExternalSessionIdentityBridges.listByLineageRoot("tsr_1")
      expect(
        tenancyIdentityBridgesByRoot.some(
          (row) => row.id === "tenancy-external-session-identity-bridge:tsr_1_child"
        )
      ).toBe(true)
      const tenancyIdentityBridgesBySession =
        await repos.tenancyExternalSessionIdentityBridges.listBySessionReference("tsr_1_child")
      expect(
        tenancyIdentityBridgesBySession.some(
          (row) => row.id === "tenancy-external-session-identity-bridge:tsr_1_child"
        )
      ).toBe(true)
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
      await repos.matterReportExportAnalytics.upsert({
        id: "matter_report_export:mat_1",
        firmId: "firmA",
        matterId: "mat_1",
        classification: "internal",
        exportCount: 2,
        lastExportedAt: 45,
        lastExportedBy: "partner_a",
        lastExportFormat: "csv",
        lastExportScope: "summary",
        lastExportReason: "weekly_export",
        updatedAt: 45,
      })
      const exportAnalytics = await repos.matterReportExportAnalytics.get("matter_report_export:mat_1")
      expect(exportAnalytics?.exportCount).toBe(2)
      const exportAnalyticsByFirm = await repos.matterReportExportAnalytics.listByFirm("firmA")
      expect(exportAnalyticsByFirm.some((row) => row.matterId === "mat_1")).toBe(true)
      const exportAnalyticsByMatter = await repos.matterReportExportAnalytics.listByMatter("mat_1")
      expect(
        exportAnalyticsByMatter.some(
          (row) => row.lastExportFormat === "csv" && row.lastExportScope === "summary"
        )
      ).toBe(true)
      await repos.matterReportRelevanceSnapshots.upsert({
        id: "matter_report_relevance:mat_1",
        firmId: "firmA",
        matterId: "mat_1",
        classification: "internal",
        relevanceScore: 72,
        scoreBand: "medium",
        freshnessStatus: "fresh",
        provenanceTags: ["matter_status:live", "case_number_status:recorded"],
        recomputedAt: 46,
        recomputedBy: "partner_a",
        recomputeReason: "manual_recompute",
        updatedAt: 46,
      })
      const relevanceSnapshot = await repos.matterReportRelevanceSnapshots.get("matter_report_relevance:mat_1")
      expect(relevanceSnapshot?.scoreBand).toBe("medium")
      const relevanceByFirm = await repos.matterReportRelevanceSnapshots.listByFirm("firmA")
      expect(relevanceByFirm.some((row) => row.matterId === "mat_1")).toBe(true)
      const relevanceByMatter = await repos.matterReportRelevanceSnapshots.listByMatter("mat_1")
      expect(relevanceByMatter.some((row) => row.recomputeReason === "manual_recompute")).toBe(true)
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
      await repos.workflowOpsAlertDigests.upsert({
        id: "workflow_ops_alert:mat_1",
        firmId: "firmA",
        matterId: "mat_1",
        classification: "internal",
        severity: "high",
        backlogPressureCount: 5,
        unresolvedFollowUpDebtCount: 2,
        staleQueueWindowCount: 1,
        freshnessStatus: "fresh",
        provenanceTags: ["workflow", "follow_up", "pressure"],
        recomputedAt: 47,
        recomputedBy: "partner_a",
        recomputeReason: "ops_runtime_check",
        acknowledgedAt: null,
        acknowledgedBy: null,
        acknowledgedReason: null,
        snoozedUntil: null,
        snoozedBy: null,
        snoozedReason: null,
        updatedAt: 48,
      })
      const alertDigest = await repos.workflowOpsAlertDigests.get("workflow_ops_alert:mat_1")
      expect(alertDigest?.severity).toBe("high")
      const alertDigestsByFirm = await repos.workflowOpsAlertDigests.listByFirm("firmA")
      expect(alertDigestsByFirm.some((row) => row.matterId === "mat_1")).toBe(true)
      const alertDigestsByMatter = await repos.workflowOpsAlertDigests.listByMatter("mat_1")
      expect(alertDigestsByMatter.some((row) => row.recomputeReason === "ops_runtime_check")).toBe(true)
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
      await repos.filingEscalationClosureAdjudicationQueue.upsert({
        id: "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        disputeId:
          "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        attestationId: "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1",
        exceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "panel_in_review",
        panelMemberIds: ["partner_a", "partner_b"],
        escalatedBy: "partner_b",
        escalatedAt: 58,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        dissentNotes: ["panel note immutable"],
        linkedEnforcementRebalanceId:
          "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        notes: ["adjudication escalated"],
        updatedAt: 58,
      })
      const closureAdjudication = await repos.filingEscalationClosureAdjudicationQueue.get(
        "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureAdjudication?.status).toBe("panel_in_review")
      const closureAdjudicationByFirm =
        await repos.filingEscalationClosureAdjudicationQueue.listByFirm("firmA")
      expect(closureAdjudicationByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureEnforcementRebalance.upsert({
        id: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        digestId: "closure-compliance:firmA:partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        enforcementId: "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "owner_reassignment_recommended",
        triggeredByEscalationCount: 2,
        cooldownUntil: null,
        recommendedOwnerId: "partner_b",
        reopenThrottleUntil: null,
        lastRebalancedBy: "partner_a",
        lastRebalancedAt: 59,
        linkedAdjudicationQueueId:
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        notes: ["owner reassignment hint"],
        lastEvaluatedAt: 59,
        updatedAt: 59,
      })
      const closureRebalance = await repos.filingEscalationClosureEnforcementRebalance.get(
        "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureRebalance?.status).toBe("owner_reassignment_recommended")
      const closureRebalanceByFirm = await repos.filingEscalationClosureEnforcementRebalance.listByFirm(
        "firmA"
      )
      expect(
        closureRebalanceByFirm.some(
          (row) =>
            row.id ===
            "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
        )
      ).toBe(true)
      await repos.filingEscalationClosureAdjudicationQuorum.upsert({
        id: "closure-adjudication-quorum:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        adjudicationId:
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "quorum_pending",
        requiredPanelCount: 3,
        confirmedPanelCount: 2,
        quorumMetAt: null,
        quorumDeadlineAt: 60,
        verdictDueAt: 3600,
        verdictRecordedAt: null,
        breachFlags: ["quorum_unmet"],
        lastGovernedBy: "partner_a",
        lastGovernedAt: 60,
        notes: ["quorum unmet"],
        lastEvaluatedAt: 60,
        updatedAt: 60,
      })
      const closureQuorum = await repos.filingEscalationClosureAdjudicationQuorum.get(
        "closure-adjudication-quorum:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureQuorum?.status).toBe("quorum_pending")
      const closureQuorumByFirm = await repos.filingEscalationClosureAdjudicationQuorum.listByFirm(
        "firmA"
      )
      expect(closureQuorumByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureRebalanceExecution.upsert({
        id: "closure-rebalance-execution:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        mode: "owner_transfer",
        status: "completed",
        targetOwnerId: "partner_b",
        appliedOwnerId: "partner_b",
        throttleReleased: false,
        queueReopened: false,
        executedBy: "partner_a",
        executedAt: 61,
        churnCount: 1,
        notes: ["owner transfer completed"],
        lastEvaluatedAt: 61,
        updatedAt: 61,
      })
      const closureExecution = await repos.filingEscalationClosureRebalanceExecution.get(
        "closure-rebalance-execution:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureExecution?.status).toBe("completed")
      const closureExecutionByFirm = await repos.filingEscalationClosureRebalanceExecution.listByFirm(
        "firmA"
      )
      expect(closureExecutionByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureAdjudicationSlo.upsert({
        id: "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        adjudicationId:
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "breach_open",
        escalationTier: "tier_1_partner_watch",
        baseVerdictDueAt: 62,
        effectiveVerdictDueAt: 63,
        extensionCount: 1,
        lastExtendedBy: "partner_a",
        lastExtendedAt: 61,
        breachOpenedAt: 64,
        breachAcknowledgedBy: null,
        breachAcknowledgedAt: null,
        breachDebtHours: 1,
        notes: ["slo breach open"],
        lastEvaluatedAt: 64,
        updatedAt: 64,
      })
      const closureSlo = await repos.filingEscalationClosureAdjudicationSlo.get(
        "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureSlo?.status).toBe("breach_open")
      const closureSloByFirm = await repos.filingEscalationClosureAdjudicationSlo.listByFirm("firmA")
      expect(closureSloByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureRebalanceSafeguards.upsert({
        id: "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "cooldown_locked",
        cooldownLockUntil: 80,
        duplicateSuppressionUntil: 90,
        overrideAttestedBy: null,
        overrideAttestedAt: null,
        overrideReason: null,
        lastAutoExecutedAt: null,
        autoExecutionEligible: false,
        suppressionReasons: ["cooldown_lockout_active"],
        notes: ["safeguard cooldown lock active"],
        lastEvaluatedAt: 65,
        updatedAt: 65,
      })
      const closureSafeguard = await repos.filingEscalationClosureRebalanceSafeguards.get(
        "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureSafeguard?.status).toBe("cooldown_locked")
      const closureSafeguardByFirm =
        await repos.filingEscalationClosureRebalanceSafeguards.listByFirm("firmA")
      expect(closureSafeguardByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureAdjudicationSloDebtRemediation.upsert({
        id: "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        adjudicationId:
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        adjudicationSloId:
          "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "debt_retirement_pending",
        debtAgeHours: 2,
        debtRetiredHours: 0,
        retirementNotedBy: "partner_a",
        retirementNotedAt: 66,
        tierDownshiftedTo: "tier_1_partner_watch",
        tierDownshiftedBy: "partner_a",
        tierDownshiftedAt: 67,
        breachClosureAttestedBy: null,
        breachClosureAttestedAt: null,
        notes: ["debt remediation noted"],
        lastEvaluatedAt: 67,
        updatedAt: 67,
      })
      const closureDebtRemediation = await repos.filingEscalationClosureAdjudicationSloDebtRemediation.get(
        "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureDebtRemediation?.status).toBe("debt_retirement_pending")
      const closureDebtRemediationByFirm =
        await repos.filingEscalationClosureAdjudicationSloDebtRemediation.listByFirm("firmA")
      expect(closureDebtRemediationByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureRebalanceSafeguardExpiry.upsert({
        id: "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        safeguardId:
          "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "override_expired",
        suppressionExpiresAt: 68,
        overrideExpiresAt: 69,
        autoClearedAt: 69,
        staleLockCleanedBy: null,
        staleLockCleanedAt: null,
        expiryDebtHours: 1,
        notes: ["override expiry recorded"],
        lastEvaluatedAt: 69,
        updatedAt: 69,
      })
      const closureSafeguardExpiry = await repos.filingEscalationClosureRebalanceSafeguardExpiry.get(
        "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureSafeguardExpiry?.status).toBe("override_expired")
      const closureSafeguardExpiryByFirm =
        await repos.filingEscalationClosureRebalanceSafeguardExpiry.listByFirm("firmA")
      expect(closureSafeguardExpiryByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureAdjudicationDebtBurndown.upsert({
        id: "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        adjudicationId:
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        remediationId:
          "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "burndown_checkpoint_due",
        retirementTargetAt: 72,
        checkpointAt: 72,
        backlogAttestedBy: "partner_a",
        backlogAttestedAt: 70,
        tierNormalizedBy: "partner_a",
        tierNormalizedAt: 71,
        tierNormalizedTo: "tier_1_partner_watch",
        debtVelocityPerDay: 3,
        projectedBurndownHours: 2,
        forecastBreachHours: 1,
        notes: ["burndown target breached by one hour"],
        lastEvaluatedAt: 73,
        updatedAt: 73,
      })
      const closureDebtBurndown = await repos.filingEscalationClosureAdjudicationDebtBurndown.get(
        "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureDebtBurndown?.status).toBe("burndown_checkpoint_due")
      const closureDebtBurndownByFirm =
        await repos.filingEscalationClosureAdjudicationDebtBurndown.listByFirm("firmA")
      expect(closureDebtBurndownByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureSafeguardExpiryAttestations.upsert({
        id: "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        expiryId:
          "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "attestation_overdue",
        acknowledgedBy: "partner_a",
        acknowledgedAt: 74,
        overdueExceptionQueuedBy: "partner_a",
        overdueExceptionQueuedAt: 75,
        overrideReconciledBy: null,
        overrideReconciledAt: null,
        latestReconciliationNote: null,
        openBacklogHours: 2,
        notes: ["overdue exception queued"],
        lastEvaluatedAt: 75,
        updatedAt: 75,
      })
      const closureSafeguardAttestation =
        await repos.filingEscalationClosureSafeguardExpiryAttestations.get(
          "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
        )
      expect(closureSafeguardAttestation?.status).toBe("attestation_overdue")
      const closureSafeguardAttestationByFirm =
        await repos.filingEscalationClosureSafeguardExpiryAttestations.listByFirm("firmA")
      expect(closureSafeguardAttestationByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureBurndownRecalibration.upsert({
        id: "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        adjudicationId:
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        burndownId:
          "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "confidence_band_overridden",
        rebaselineTargetAt: 76,
        confidenceBandLowerHours: 1,
        confidenceBandUpperHours: 4,
        confidenceOverriddenBy: "partner_a",
        confidenceOverriddenAt: 76,
        rollbackNotedBy: null,
        rollbackNotedAt: null,
        rollbackReason: null,
        settledBy: null,
        settledAt: null,
        confidenceDriftHours: 1,
        notes: ["confidence band overridden for recalibration"],
        lastEvaluatedAt: 76,
        updatedAt: 76,
      })
      const closureBurndownRecalibration = await repos.filingEscalationClosureBurndownRecalibration.get(
        "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureBurndownRecalibration?.status).toBe("confidence_band_overridden")
      const closureBurndownRecalibrationByFirm =
        await repos.filingEscalationClosureBurndownRecalibration.listByFirm("firmA")
      expect(closureBurndownRecalibrationByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureExpiryAttestationQueue.upsert({
        id: "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        attestationId:
          "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "handoff_attested",
        triagedBy: "partner_a",
        triagedAt: 77,
        handoffAttestedBy: "partner_a",
        handoffAttestedAt: 78,
        handoffToOwnerId: "partner_b",
        autoDrainCheckpointAt: null,
        queueAgingHours: 2,
        openExceptionCount: 1,
        reconciliationCarryoverNote: "handoff carryover reconciliation note",
        notes: ["queue handoff attested"],
        lastEvaluatedAt: 78,
        updatedAt: 78,
      })
      const closureExpiryAttestationQueue = await repos.filingEscalationClosureExpiryAttestationQueue.get(
        "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureExpiryAttestationQueue?.status).toBe("handoff_attested")
      const closureExpiryAttestationQueueByFirm =
        await repos.filingEscalationClosureExpiryAttestationQueue.listByFirm("firmA")
      expect(closureExpiryAttestationQueueByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureBurndownSettlement.upsert({
        id: "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        adjudicationId:
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        recalibrationId:
          "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "target_lock_attested",
        driftAcknowledgedBy: "partner_a",
        driftAcknowledgedAt: 79,
        targetLockAttestedBy: "partner_a",
        targetLockAttestedAt: 80,
        rollbackResolutionClosedBy: null,
        rollbackResolutionClosedAt: null,
        rollbackResolutionNote: null,
        settlementLatencyHours: 2,
        notes: ["target lock attested for settlement"],
        lastEvaluatedAt: 80,
        updatedAt: 80,
      })
      const closureBurndownSettlement = await repos.filingEscalationClosureBurndownSettlement.get(
        "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureBurndownSettlement?.status).toBe("target_lock_attested")
      const closureBurndownSettlementByFirm =
        await repos.filingEscalationClosureBurndownSettlement.listByFirm("firmA")
      expect(closureBurndownSettlementByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureExpiryAttestationQueueDrain.upsert({
        id: "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        queueItemId:
          "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "stale_reassignment_attested",
        handoffTimeoutEscalatedBy: "partner_a",
        handoffTimeoutEscalatedAt: 81,
        staleReassignmentAttestedBy: "partner_a",
        staleReassignmentAttestedAt: 82,
        reassignedOwnerId: "partner_b",
        forcedDrainCheckpointedBy: null,
        forcedDrainCheckpointedAt: null,
        forcedDrainOverrideNote: null,
        drainThroughputPerDay: 3,
        openQueueAgingHours: 2,
        notes: ["stale queue reassignment attested"],
        lastEvaluatedAt: 82,
        updatedAt: 82,
      })
      const closureQueueDrain = await repos.filingEscalationClosureExpiryAttestationQueueDrain.get(
        "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureQueueDrain?.status).toBe("stale_reassignment_attested")
      const closureQueueDrainByFirm =
        await repos.filingEscalationClosureExpiryAttestationQueueDrain.listByFirm("firmA")
      expect(closureQueueDrainByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureSettlementAttestation.upsert({
        id: "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        adjudicationId:
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        settlementId:
          "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "settlement_verified",
        postResolutionCheckpointedBy: "partner_a",
        postResolutionCheckpointedAt: 83,
        lockReleaseAttestedBy: "partner_a",
        lockReleaseAttestedAt: 84,
        disputeReopenGuardedBy: null,
        disputeReopenGuardedAt: null,
        disputeReopenGuardNote: null,
        settlementVerificationLagHours: 1,
        notes: ["settlement verification attestation recorded"],
        lastEvaluatedAt: 84,
        updatedAt: 84,
      })
      const closureSettlementAttestation = await repos.filingEscalationClosureSettlementAttestation.get(
        "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureSettlementAttestation?.status).toBe("settlement_verified")
      const closureSettlementAttestationByFirm =
        await repos.filingEscalationClosureSettlementAttestation.listByFirm("firmA")
      expect(closureSettlementAttestationByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureQueueDrainReconciliation.upsert({
        id: "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        queueDrainId:
          "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "timeout_reentry_controlled",
        forcedDrainAttestedBy: "partner_a",
        forcedDrainAttestedAt: 85,
        reassignmentRollbackCheckpointedBy: "partner_a",
        reassignmentRollbackCheckpointedAt: 86,
        rollbackToOwnerId: "partner_b",
        timeoutReentryControlledBy: "partner_a",
        timeoutReentryControlledAt: 87,
        timeoutReentryWindowHours: 12,
        drainReopenPressureCount: 1,
        notes: ["queue drain re-entry controlled"],
        lastEvaluatedAt: 87,
        updatedAt: 87,
      })
      const closureQueueDrainReconciliation = await repos.filingEscalationClosureQueueDrainReconciliation.get(
        "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureQueueDrainReconciliation?.status).toBe("timeout_reentry_controlled")
      const closureQueueDrainReconciliationByFirm =
        await repos.filingEscalationClosureQueueDrainReconciliation.listByFirm("firmA")
      expect(closureQueueDrainReconciliationByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureSettlementArbitration.upsert({
        id: "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        adjudicationId:
          "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        settlementAttestationId:
          "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "distribution_attestation_reviewed",
        verificationOverridePetitionedBy: "partner_a",
        verificationOverridePetitionedAt: 88,
        panelConfirmationAttestedBy: "partner_a",
        panelConfirmationAttestedAt: 89,
        reopenVetoCheckpointedBy: "partner_a",
        reopenVetoCheckpointedAt: 90,
        reopenVetoNote: "panel vetoed reopen motion",
        finalRulingIssuedBy: "partner_a",
        finalRulingIssuedAt: 91,
        finalRulingSummary: "ruling issued after panel confirmation",
        dissentMemorializedBy: "partner_b",
        dissentMemorializedAt: 92,
        dissentMemorializedNote: "dissent memorialized for staffing record",
        rulingPublicationCheckpointedBy: "partner_a",
        rulingPublicationCheckpointedAt: 93,
        rulingPublicationChannel: "internal_panel_registry",
        publicationCorrectionLoggedBy: "partner_a",
        publicationCorrectionLoggedAt: 94,
        publicationCorrectionNote: "publication correction logged",
        publicationRollbackCheckpointedBy: "partner_a",
        publicationRollbackCheckpointedAt: 95,
        publicationRollbackReason: "distribution rollback checkpointed",
        distributionAttestationReviewedBy: "partner_a",
        distributionAttestationReviewedAt: 96,
        distributionAttestationDecision: "revision_required",
        settlementArbitrationLeadTimeHours: 2,
        arbitrationRulingAgingHours: 1,
        arbitrationPublicationExceptionBacklogCount: 3,
        notes: ["settlement verification override petitioned and panel attested"],
        lastEvaluatedAt: 96,
        updatedAt: 96,
      })
      const closureSettlementArbitration = await repos.filingEscalationClosureSettlementArbitration.get(
        "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
      )
      expect(closureSettlementArbitration?.status).toBe("distribution_attestation_reviewed")
      expect(closureSettlementArbitration?.rulingPublicationChannel).toBe("internal_panel_registry")
      expect(closureSettlementArbitration?.arbitrationPublicationExceptionBacklogCount).toBe(3)
      const closureSettlementArbitrationByFirm =
        await repos.filingEscalationClosureSettlementArbitration.listByFirm("firmA")
      expect(closureSettlementArbitrationByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
      await repos.filingEscalationClosureQueueReentryCompliance.upsert({
        id: "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        firmId: "firmA",
        ownerId: "partner_a",
        queueId: "closure-followup:closure-compliance:firmA:partner_a",
        rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        queueReconciliationId:
          "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
        classification: "internal",
        packageIds: ["pkg_1"],
        status: "retirement_rollback_controlled",
        reentryExceptionAttestedBy: "partner_a",
        reentryExceptionAttestedAt: 90,
        timeoutWaiverCheckpointedBy: "partner_a",
        timeoutWaiverCheckpointedAt: 91,
        timeoutWaiverHours: 24,
        reconciliationResumedBy: null,
        reconciliationResumedAt: null,
        exceptionDebtAssignedBy: "partner_a",
        exceptionDebtAssignedAt: 92,
        debtAssigneeId: "partner_b",
        debtRetirementAttestedBy: "partner_a",
        debtRetirementAttestedAt: 93,
        debtRetiredCount: 2,
        debtAgingAutoEscalatedBy: "partner_a",
        debtAgingAutoEscalatedAt: 94,
        debtAgingEscalationHours: 6,
        retirementDisputeOpenedBy: "partner_a",
        retirementDisputeOpenedAt: 95,
        retirementDisputeReason: "retirement dispute opened",
        retirementDisputeResolvedBy: "partner_a",
        retirementDisputeResolvedAt: 96,
        retirementDisputeResolution: "reopen_debt",
        retirementRollbackControlledBy: "partner_a",
        retirementRollbackControlledAt: 97,
        retirementRollbackCount: 1,
        queueReentryExceptionDebtCount: 1,
        queueReentryRetirementBurnCount: 1,
        queueReentryRetirementReconciliationDriftCount: 2,
        notes: ["queue re-entry timeout waiver checkpointed"],
        lastEvaluatedAt: 97,
        updatedAt: 97,
      })
      const closureQueueReentryCompliance = await repos.filingEscalationClosureQueueReentryCompliance.get(
        "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
      )
      expect(closureQueueReentryCompliance?.status).toBe("retirement_rollback_controlled")
      expect(closureQueueReentryCompliance?.debtAssigneeId).toBe("partner_b")
      expect(closureQueueReentryCompliance?.queueReentryRetirementReconciliationDriftCount).toBe(2)
      const closureQueueReentryComplianceByFirm =
        await repos.filingEscalationClosureQueueReentryCompliance.listByFirm("firmA")
      expect(closureQueueReentryComplianceByFirm.some((row) => row.ownerId === "partner_a")).toBe(true)
    })
  })
})
