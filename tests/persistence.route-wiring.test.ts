import { describe, expect, it, vi } from "vitest"
import { TB_ACK_RECON_LINEAGE_ISOLATION_GET_URL as LATTICE_U } from "./ops.pr-tb-ack-recon-lattice-urls"

const baseStore = {
  users: new Map([
    [
      "associate_a",
      {
        id: "associate_a",
        firmId: "firmA",
        role: "associate",
        clearanceLevel: "privileged",
      },
    ],
  ]),
  matters: new Map([
    [
      "mat_1",
      {
        id: "mat_1",
        firmId: "firmA",
        clientId: "client_a",
        title: "Matter",
        courtId: "SHC",
        caseNumber: null,
        caseNumberStatus: "pending",
        status: "engagement_unconfirmed",
        classification: "internal",
      },
    ],
  ]),
  entities: new Map(),
  links: [],
  members: new Map([["mat_1_associate_a", { matterId: "mat_1", userId: "associate_a", firmId: "firmA" }]]),
  jobs: [],
  documents: new Map(),
  filingPackages: new Map(),
  filingPacketArtifacts: new Map(),
  filingDispatchQueue: new Map(),
  filingAnnexures: new Map(),
  filingSubmissionReceipts: new Map(),
  filingSubmissionReconciliation: new Map(),
  filingSubmissionExceptions: new Map(),
  filingTransportExecutionEvidence: new Map(),
  filingSubmissionSlaDigests: new Map(),
  filingEscalationOwnerRota: new Map(),
  filingEscalationWorkloadDigests: new Map(),
  filingEscalationPolicyBaselines: new Map(),
  filingEscalationBreachWaivers: new Map(),
  filingEscalationPolicyVarianceDigests: new Map(),
  filingEscalationWaiverExpiryDigests: new Map(),
  filingEscalationVarianceRemediations: new Map(),
  filingEscalationWaiverRolloverAttestations: new Map(),
  filingEscalationRemediationExpiryDigests: new Map(),
  filingEscalationRolloverBreachWatches: new Map(),
  filingEscalationRemediationLifecycles: new Map(),
  filingEscalationRolloverReaffirmationSlas: new Map(),
  filingEscalationClosureComplianceDigests: new Map(),
  filingEscalationClosureFollowupQueues: new Map(),
  filingEscalationClosureSlaWindowConfigs: new Map(),
  filingEscalationClosureAutoAssignmentRules: new Map(),
  filingEscalationClosureSlaWindows: new Map(),
  filingEscalationClosureAttestations: new Map(),
  filingEscalationClosureSlaExceptionDigests: new Map(),
  filingEscalationClosureAttestationDisputes: new Map(),
  filingEscalationClosureSlaExceptionEnforcement: new Map(),
  filingEscalationClosureAdjudicationQueue: new Map(),
  filingEscalationClosureEnforcementRebalance: new Map(),
  filingEscalationClosureAdjudicationQuorum: new Map(),
  filingEscalationClosureRebalanceExecution: new Map(),
  filingEscalationClosureAdjudicationSlo: new Map(),
  filingEscalationClosureRebalanceSafeguards: new Map(),
  filingEscalationClosureAdjudicationSloDebtRemediation: new Map(),
  filingEscalationClosureRebalanceSafeguardExpiry: new Map(),
  filingEscalationClosureAdjudicationDebtBurndown: new Map(),
  filingEscalationClosureSafeguardExpiryAttestations: new Map(),
  filingEscalationClosureBurndownRecalibration: new Map(),
  filingEscalationClosureExpiryAttestationQueue: new Map(),
  filingEscalationClosureBurndownSettlement: new Map(),
  filingEscalationClosureExpiryAttestationQueueDrain: new Map(),
  filingEscalationClosureSettlementAttestation: new Map(),
  filingEscalationClosureQueueDrainReconciliation: new Map(),
  filingEscalationClosureSettlementArbitration: new Map(),
  filingEscalationClosureQueueReentryCompliance: new Map(),
  matterClientSearchIndex: new Map(),
  draftTemplateAnalytics: new Map(),
  matterReportExportAnalytics: new Map(),
  matterReportRelevanceSnapshots: new Map(),
  workflowOpsActivity: new Map(),
  workflowOpsAlertDigests: new Map(),
  workflowOpsAlertAttestations: new Map(),
  workflowOpsAlertEscalationLedgers: new Map(),
  workflowOpsAlertAttestationDisputes: new Map(),
  workflowOpsAlertEscalationClosures: new Map(),
  workflowOpsAlertDisputeEnforcementLedgers: new Map(),
  workflowOpsAlertClosureDebtReconciliationDigests: new Map(),
  workflowOpsAlertEnforcementAttestations: new Map(),
  workflowOpsAlertClosureDebtVarianceDigests: new Map(),
  workflowOpsAlertEnforcementWaiverLedgers: new Map(),
  workflowOpsAlertVarianceRemediationQueues: new Map(),
  workflowOpsAlertWaiverExpiryDigests: new Map(),
  workflowOpsAlertVarianceRemediationSlaLedgers: new Map(),
  workflowOpsAlertWaiverExpiryDisputes: new Map(),
  workflowOpsAlertVarianceRemediationSlaBreachEscalations: new Map(),
  workflowOpsAlertWaiverExpiryDisputeAdjudications: new Map(),
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints: new Map(),
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships: new Map(),
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations: new Map(),
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations: new Map(),
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations:
    new Map(),
  workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns: new Map(),
  workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations:
    new Map(),
  memberKey(matterId: string, userId: string) {
    return `${matterId}_${userId}`
  },
}

vi.mock("@/platform/spine/runtimeStore", () => ({
  getRuntimeStore: () => baseStore,
}))

vi.mock("@/platform/persistence/runtimeRepositories", () => ({
  getRuntimeRepositories: vi.fn(async () => ({
    matters: {
      listByFirm: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
    },
    users: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    entities: {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "ent_repo",
          firmId: "firmA",
          canonicalName: "Repo Entity",
          cnic: "4220112345678",
          phone: "+923001112233",
          classification: "internal",
        },
      ]),
    },
    entityLinks: {
      upsert: vi.fn(),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    members: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        { matterId: "mat_1", userId: "associate_a", firmId: "firmA" },
      ]),
      listByMatter: vi.fn().mockResolvedValue([
        { matterId: "mat_1", userId: "associate_a", firmId: "firmA" },
      ]),
    },
    documents: {
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "doc_repo",
          firmId: "firmA",
          matterId: "mat_1",
          contentHash: "repo-hash",
          sourceChannel: "web",
          classification: "internal",
        },
      ]),
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
    },
    drafts: {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    workflow: {
      createOrUpdate: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    filings: {
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "pkg_repo",
          firmId: "firmA",
          matterId: "mat_1",
          draftId: "drf_1",
          classification: "internal",
          citationStatus: "OK",
          temporalAllOk: true,
          status: "pending_partner_approval",
          createdBy: "associate_a",
          createdAt: 1,
          approvedBy: null,
          approvalReason: null,
        },
      ]),
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
    },
    filingPacketArtifacts: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "packet:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
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
          updatedAt: 1,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingDispatchQueue: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "dispatch:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "queued",
          assigneeId: "clerk_a",
          retryCount: 0,
          lastAttemptAt: null,
          operatorNotes: ["queued for handoff"],
          externalDispatchState: "blocked_todo_firm",
          updatedAt: 2,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingAnnexures: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "annexure:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          generationStatus: "pending",
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
            partnerSignoffBy: null,
            partnerSignoffAt: null,
            clerkVerificationBy: null,
            clerkVerificationAt: null,
          },
          operatorNotes: ["repo annexure row"],
          submissionTransportBoundary: "todo_firm_external_transport_blocked",
          updatedAt: 3,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingSubmissionReceipts: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "receipt:pkg_repo:1",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          attemptNo: 1,
          courtChannel: "efiling_portal_stub",
          dispatchOutcome: "retry_scheduled",
          submissionReference: "ref-repo-1",
          failureReason: "gateway timeout",
          retryHint: "retry after review",
          recordedBy: "clerk_a",
          recordedAt: 4,
          submissionTransportBoundary: "todo_firm_external_transport_blocked",
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingSubmissionReconciliation: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "reconcile:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          totalAttempts: 1,
          latestReceiptId: "receipt:pkg_repo:1",
          latestSubmissionReference: "ref-repo-1",
          latestDispatchOutcome: "retry_scheduled",
          status: "open",
          notes: ["repo reconciliation row"],
          updatedAt: 5,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingSubmissionExceptions: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "exception:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "open",
          severity: "high",
          source: "reconciliation_needs_retry",
          latestReceiptId: "receipt:pkg_repo:1",
          latestReconciliationId: "reconcile:pkg_repo",
          escalationOwnerId: "partner_a",
          firstRaisedAt: 6,
          lastRaisedAt: 7,
          slaTargetAt: 8,
          claimedBy: null,
          claimedAt: null,
          escalatedBy: null,
          escalatedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNotes: ["repo exception row"],
          updatedAt: 9,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingTransportExecutionEvidence: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "transport:pkg_repo:1",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          sequenceNo: 1,
          dispatchQueueId: "dispatch:pkg_repo",
          outcome: "transport_blocked",
          transportOperatorId: "clerk_a",
          transportChannel: "efiling_portal_stub",
          channelPayloadHash: "hash-repo-1",
          deterministicBlockerTags: ["portal_timeout"],
          attachmentPointers: ["ops://retry-plan/1"],
          relatedReceiptId: "receipt:pkg_repo:1",
          relatedReconciliationId: "reconcile:pkg_repo",
          relatedExceptionId: "exception:pkg_repo",
          note: "repo transport evidence row",
          createdAt: 10,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingSubmissionSlaDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "digest:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "open_breach",
          breachReasons: ["sla_overdue"],
          staleRetryPlan: false,
          outstandingOwnerId: "partner_a",
          linkedExceptionId: "exception:pkg_repo",
          linkedEvidenceId: "transport:pkg_repo:1",
          breachWindowStartedAt: 11,
          deferUntil: null,
          acknowledgedBy: null,
          acknowledgedAt: null,
          deferredBy: null,
          deferredAt: null,
          clearedBy: null,
          clearedAt: null,
          notes: ["repo digest row"],
          lastEvaluatedAt: 12,
          updatedAt: 12,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationOwnerRota: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "rota:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "active",
          primaryOwnerId: "partner_a",
          backupOwnerId: "partner_b",
          activeWindowStartAt: 13,
          activeWindowEndAt: 14,
          handoffRequired: true,
          handoffAcknowledgedBy: null,
          handoffAcknowledgedAt: null,
          lastAssignedBy: "partner_a",
          lastAssignedAt: 13,
          revokedBy: null,
          revokedAt: null,
          linkedExceptionId: "exception:pkg_repo",
          linkedDigestId: "digest:pkg_repo",
          notes: ["repo rota row"],
          updatedAt: 13,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationWorkloadDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workload:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "open_alert",
          alertReasons: ["handoff_lag"],
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
          linkedRotaId: "rota:pkg_repo",
          linkedDigestId: "digest:pkg_repo",
          notes: ["repo workload digest row"],
          lastEvaluatedAt: 14,
          updatedAt: 14,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationPolicyBaselines: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
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
          setAt: 15,
          notes: ["repo policy row"],
          updatedAt: 15,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationBreachWaivers: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "waiver:pkg_repo:1",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "active",
          reason: "temporary rebalance pending",
          grantedBy: "partner_a",
          grantedAt: Date.now(),
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          revokedBy: null,
          revokedAt: null,
          linkedSlaDigestId: "digest:pkg_repo",
          linkedWorkloadDigestId: "workload:pkg_repo",
          notes: ["repo waiver row"],
          updatedAt: Date.now(),
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationPolicyVarianceDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "policy-variance:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "open_alert",
          varianceReasons: ["owner_load_threshold_override"],
          firmDefaultPolicyId: "policy:firmA:default",
          packagePolicyId: "policy:pkg_repo:override",
          ownerLoadThresholdDefault: 3,
          ownerLoadThresholdEffective: 1,
          handoffSlaMsDefault: 0,
          handoffSlaMsEffective: 0,
          waiverWindowMsDefault: 24 * 60 * 60 * 1000,
          waiverWindowMsEffective: 6 * 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          snoozeUntil: null,
          notes: ["repo policy variance row"],
          lastEvaluatedAt: 16,
          updatedAt: 16,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationWaiverExpiryDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "waiver-expiry:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "open_expiry",
          reasons: ["expires_lte_4h"],
          linkedWaiverId: "waiver:pkg_repo:1",
          linkedPolicyId: "policy:firmA:default",
          waiverExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
          msUntilExpiry: 2 * 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          extendedBy: null,
          extendedAt: null,
          notes: ["repo waiver expiry row"],
          lastEvaluatedAt: 17,
          updatedAt: 17,
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationVarianceRemediations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "remediation:pkg_repo:1",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          decision: "temporary_override",
          status: "active",
          linkedPolicyVarianceDigestId: "policy-variance:pkg_repo",
          linkedPolicyId: "policy:pkg_repo:override",
          justification: "Controlled override for known filing backlog",
          decidedBy: "partner_a",
          decidedAt: Date.now(),
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          secondApproverId: "partner_b",
          notes: ["repo remediation row"],
          updatedAt: Date.now(),
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationWaiverRolloverAttestations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "rollover:pkg_repo:1",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          waiverId: "waiver:pkg_repo:1",
          status: "attested",
          extensionHours: 8,
          previousExpiresAt: Date.now(),
          newExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
          policyCapExpiresAt: Date.now() + 4 * 60 * 60 * 1000,
          attestedBy: "partner_a",
          secondApproverId: "partner_b",
          justification: "Court closure extends beyond baseline waiver window",
          attestedAt: Date.now(),
          notes: ["repo rollover row"],
          updatedAt: Date.now(),
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationRemediationExpiryDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "remediation-expiry:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "open_expiry",
          reasons: ["expires_lte_4h"],
          linkedRemediationId: "remediation:pkg_repo:1",
          linkedLifecycleId: "remediation-lifecycle:remediation:pkg_repo:1",
          linkedPolicyVarianceDigestId: "policy-variance:pkg_repo",
          linkedPolicyId: "policy:pkg_repo:override",
          remediationExpiresAt: Date.now() + 2 * 60 * 60 * 1000,
          msUntilExpiry: 2 * 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          snoozeUntil: null,
          notes: ["repo remediation expiry row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationRolloverBreachWatches: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "rollover-breach:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "open_breach",
          reasons: ["reaffirmation_note_stale"],
          linkedWaiverId: "waiver:pkg_repo:1",
          linkedAttestationId: "rollover:pkg_repo:1",
          linkedPolicyId: "policy:pkg_repo:override",
          policyCapExpiresAt: Date.now() + 4 * 60 * 60 * 1000,
          waiverExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
          attestationUpdatedAt: Date.now() - 25 * 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          notes: ["repo rollover watch row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationRemediationLifecycles: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "remediation-lifecycle:remediation:pkg_repo:1",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          remediationId: "remediation:pkg_repo:1",
          remediationDecision: "temporary_override",
          status: "open",
          linkedPolicyVarianceDigestId: "policy-variance:pkg_repo",
          linkedPolicyId: "policy:pkg_repo:override",
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
          openedBy: "partner_a",
          openedAt: Date.now(),
          closureOutcome: null,
          closureAttestedBy: null,
          closureAttestedAt: null,
          notes: ["repo remediation lifecycle row"],
          updatedAt: Date.now(),
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationRolloverReaffirmationSlas: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "rollover-reaffirmation-sla:pkg_repo",
          firmId: "firmA",
          packageId: "pkg_repo",
          matterId: "mat_1",
          classification: "internal",
          status: "warning",
          reasons: ["cap_crossed_reaffirmation_warning"],
          linkedWaiverId: "waiver:pkg_repo:1",
          linkedAttestationId: "rollover:pkg_repo:1",
          linkedPolicyId: "policy:pkg_repo:override",
          policyCapExpiresAt: Date.now() + 4 * 60 * 60 * 1000,
          waiverExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
          lastReaffirmedAt: Date.now() - 4 * 60 * 60 * 1000,
          elapsedSinceReaffirmationMs: 4 * 60 * 60 * 1000,
          warningThresholdMs: 3 * 60 * 60 * 1000,
          breachThresholdMs: 6 * 60 * 60 * 1000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          notes: ["repo reaffirmation SLA row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByPackageId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureComplianceDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          classification: "internal",
          status: "open_alert",
          pendingLifecycleCount: 1,
          breachedReaffirmationCount: 1,
          linkedPackageIds: ["pkg_repo"],
          linkedLifecycleIds: ["remediation-lifecycle:remediation:pkg_repo:1"],
          linkedReaffirmationSlaIds: ["rollover-reaffirmation-sla:pkg_repo"],
          linkedFollowupQueueId: "closure-followup:closure-compliance:firmA:partner_a",
          acknowledgedBy: null,
          acknowledgedAt: null,
          notes: ["repo closure compliance digest row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureFollowupQueues: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          digestId: "closure-compliance:firmA:partner_a",
          classification: "internal",
          status: "open",
          packageIds: ["pkg_repo"],
          pendingLifecycleCount: 1,
          breachedReaffirmationCount: 1,
          assignedPartnerId: "partner_a",
          claimedBy: null,
          claimedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          notes: ["repo closure follow-up queue row"],
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureSlaWindowConfigs: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-sla-window-config:firmA:default",
          firmId: "firmA",
          ownerId: null,
          classification: "internal",
          scope: "firm_default",
          ackDeadlineMs: 2 * 60 * 60 * 1000,
          clearDeadlineMs: 8 * 60 * 60 * 1000,
          autoEscalationMs: 12 * 60 * 60 * 1000,
          setBy: "partner_a",
          setAt: 1,
          notes: ["repo closure SLA window config row"],
          updatedAt: 1,
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureAutoAssignmentRules: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-auto-assignment-rule:firmA:default",
          firmId: "firmA",
          ownerId: null,
          classification: "internal",
          mode: "owner_rota",
          enabled: true,
          maxActiveClaimsPerPartner: 6,
          setBy: "partner_a",
          setAt: 1,
          notes: ["repo closure auto-assignment rule row"],
          updatedAt: 1,
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureSlaWindows: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-sla-window:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          digestId: "closure-compliance:firmA:partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          status: "ack_breached",
          pressureLevel: "elevated",
          openedAt: Date.now() - 3 * 60 * 60 * 1000,
          acknowledgedAt: null,
          clearedAt: null,
          ackDeadlineAt: Date.now() - 60 * 60 * 1000,
          clearDeadlineAt: Date.now() + 4 * 60 * 60 * 1000,
          autoEscalateAt: Date.now() + 8 * 60 * 60 * 1000,
          breachedAt: Date.now() - 60 * 60 * 1000,
          autoEscalationTriggeredAt: null,
          autoEscalatedToPartnerId: null,
          linkedConfigId: "closure-sla-window-config:firmA:default",
          linkedAutoAssignmentRuleId: "closure-auto-assignment-rule:firmA:default",
          notes: ["repo closure SLA window row"],
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureAttestations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1",
          sequenceNo: 1,
          firmId: "firmA",
          ownerId: "partner_a",
          digestId: "closure-compliance:firmA:partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          linkedSlaWindowId: "closure-sla-window:closure-compliance:firmA:partner_a",
          linkedExceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "pending_second_review",
          claimPartnerId: "partner_a",
          claimAt: Date.now() - 60 * 60 * 1000,
          resolutionPartnerId: "partner_a",
          resolutionAt: Date.now() - 15 * 60 * 1000,
          attestedBy: "partner_a",
          attestedAt: Date.now() - 10 * 60 * 1000,
          secondReviewerId: "partner_b",
          secondReviewedBy: null,
          secondReviewedAt: null,
          partnerConcurrence: true,
          evidenceNote: "claim and resolution evidence attached",
          notes: ["repo closure attestation row"],
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureSlaExceptionDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          digestId: "closure-compliance:firmA:partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
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
          notes: ["repo closure SLA exception row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureAttestationDisputes: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          sequenceNo: 1,
          firmId: "firmA",
          ownerId: "partner_a",
          digestId: "closure-compliance:firmA:partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          attestationId: "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1",
          exceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "open_dispute",
          conflictReason: "conflicting chronology",
          openedBy: "partner_b",
          openedAt: Date.now() - 20 * 60 * 1000,
          reviewerChainIds: ["partner_a", "partner_b"],
          reviewerChainSnapshot: "partner_a -> partner_b",
          underReviewBy: null,
          underReviewAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
          notes: ["repo closure dispute row"],
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByAttestationId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureSlaExceptionEnforcement: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          digestId: "closure-compliance:firmA:partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          exceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "reminder_sent",
          waiverExpiresAt: Date.now() + 30 * 60 * 1000,
          msUntilExpiry: 30 * 60 * 1000,
          reminderCount: 1,
          escalationCount: 0,
          lastReminderAt: Date.now() - 10 * 60 * 1000,
          lastEscalatedAt: null,
          linkedAttestationDisputeId:
            "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          notes: ["repo closure enforcement row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureAdjudicationQueue: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          disputeId:
            "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          attestationId: "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1",
          exceptionDigestId: "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "panel_in_review",
          panelMemberIds: ["partner_a", "partner_b"],
          escalatedBy: "partner_b",
          escalatedAt: Date.now() - 15 * 60 * 1000,
          verdict: null,
          verdictBy: null,
          verdictAt: null,
          dissentNotes: ["panel dissent preserved"],
          linkedEnforcementRebalanceId:
            "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          notes: ["repo closure adjudication row"],
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByDisputeId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureEnforcementRebalance: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          digestId: "closure-compliance:firmA:partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          enforcementId: "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "owner_reassignment_recommended",
          triggeredByEscalationCount: 2,
          cooldownUntil: null,
          recommendedOwnerId: "partner_b",
          reopenThrottleUntil: null,
          lastRebalancedBy: "partner_a",
          lastRebalancedAt: Date.now() - 5 * 60 * 1000,
          linkedAdjudicationQueueId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          notes: ["repo closure rebalance row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureAdjudicationQuorum: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-adjudication-quorum:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          classification: "internal",
          packageIds: ["pkg_repo"],
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
          notes: ["repo quorum row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByAdjudicationId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureRebalanceExecution: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-rebalance-execution:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          mode: "owner_transfer",
          status: "completed",
          targetOwnerId: "partner_b",
          appliedOwnerId: "partner_b",
          throttleReleased: false,
          queueReopened: false,
          executedBy: "partner_a",
          executedAt: Date.now() - 60 * 1000,
          churnCount: 2,
          notes: ["repo rebalance execution row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByRebalanceId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureAdjudicationSlo: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "breach_open",
          escalationTier: "tier_1_partner_watch",
          baseVerdictDueAt: Date.now() - 60 * 60 * 1000,
          effectiveVerdictDueAt: Date.now() - 30 * 60 * 1000,
          extensionCount: 1,
          lastExtendedBy: "partner_a",
          lastExtendedAt: Date.now() - 2 * 60 * 60 * 1000,
          breachOpenedAt: Date.now() - 30 * 60 * 1000,
          breachAcknowledgedBy: null,
          breachAcknowledgedAt: null,
          breachDebtHours: 1,
          notes: ["repo slo row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByAdjudicationId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureRebalanceSafeguards: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "cooldown_locked",
          cooldownLockUntil: Date.now() + 60 * 60 * 1000,
          duplicateSuppressionUntil: null,
          overrideAttestedBy: null,
          overrideAttestedAt: null,
          overrideReason: null,
          lastAutoExecutedAt: null,
          autoExecutionEligible: false,
          suppressionReasons: ["cooldown_lockout_active"],
          notes: ["repo safeguard row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByRebalanceId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureAdjudicationSloDebtRemediation: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          adjudicationSloId:
            "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "debt_retirement_pending",
          debtAgeHours: 2,
          debtRetiredHours: 0,
          retirementNotedBy: "partner_a",
          retirementNotedAt: Date.now() - 30 * 60 * 1000,
          tierDownshiftedTo: "tier_1_partner_watch",
          tierDownshiftedBy: "partner_a",
          tierDownshiftedAt: Date.now() - 30 * 60 * 1000,
          breachClosureAttestedBy: null,
          breachClosureAttestedAt: null,
          notes: ["repo debt remediation row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByAdjudicationId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureRebalanceSafeguardExpiry: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          safeguardId:
            "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "override_expired",
          suppressionExpiresAt: Date.now() - 30 * 60 * 1000,
          overrideExpiresAt: Date.now() - 5 * 60 * 1000,
          autoClearedAt: Date.now() - 30 * 60 * 1000,
          staleLockCleanedBy: null,
          staleLockCleanedAt: null,
          expiryDebtHours: 1,
          notes: ["repo safeguard expiry row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByRebalanceId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureAdjudicationDebtBurndown: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          remediationId:
            "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "burndown_checkpoint_due",
          retirementTargetAt: Date.now() - 60 * 60 * 1000,
          checkpointAt: Date.now() - 60 * 60 * 1000,
          backlogAttestedBy: "partner_a",
          backlogAttestedAt: Date.now() - 30 * 60 * 1000,
          tierNormalizedBy: "partner_a",
          tierNormalizedAt: Date.now() - 15 * 60 * 1000,
          tierNormalizedTo: "tier_1_partner_watch",
          debtVelocityPerDay: 2.5,
          projectedBurndownHours: 3,
          forecastBreachHours: 1,
          notes: ["repo debt burndown row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByAdjudicationId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureSafeguardExpiryAttestations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          expiryId:
            "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "attestation_overdue",
          acknowledgedBy: "partner_a",
          acknowledgedAt: Date.now() - 45 * 60 * 1000,
          overdueExceptionQueuedBy: "partner_a",
          overdueExceptionQueuedAt: Date.now() - 30 * 60 * 1000,
          overrideReconciledBy: null,
          overrideReconciledAt: null,
          latestReconciliationNote: null,
          openBacklogHours: 2,
          notes: ["repo safeguard attestation row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByRebalanceId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureBurndownRecalibration: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          burndownId:
            "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "confidence_band_overridden",
          rebaselineTargetAt: Date.now() + 60 * 60 * 1000,
          confidenceBandLowerHours: 1,
          confidenceBandUpperHours: 4,
          confidenceOverriddenBy: "partner_a",
          confidenceOverriddenAt: Date.now() - 30 * 60 * 1000,
          rollbackNotedBy: null,
          rollbackNotedAt: null,
          rollbackReason: null,
          settledBy: null,
          settledAt: null,
          confidenceDriftHours: 1,
          notes: ["repo burndown recalibration row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByAdjudicationId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureExpiryAttestationQueue: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          attestationId:
            "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "queue_triaged",
          triagedBy: "partner_a",
          triagedAt: Date.now() - 45 * 60 * 1000,
          handoffAttestedBy: null,
          handoffAttestedAt: null,
          handoffToOwnerId: null,
          autoDrainCheckpointAt: null,
          queueAgingHours: 2,
          openExceptionCount: 1,
          reconciliationCarryoverNote: null,
          notes: ["repo expiry attestation queue row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByRebalanceId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureBurndownSettlement: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          recalibrationId:
            "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "drift_acknowledged",
          driftAcknowledgedBy: "partner_a",
          driftAcknowledgedAt: Date.now() - 50 * 60 * 1000,
          targetLockAttestedBy: null,
          targetLockAttestedAt: null,
          rollbackResolutionClosedBy: null,
          rollbackResolutionClosedAt: null,
          rollbackResolutionNote: null,
          settlementLatencyHours: 2,
          notes: ["repo burndown settlement row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByAdjudicationId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureExpiryAttestationQueueDrain: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          queueItemId:
            "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "handoff_timeout_escalated",
          handoffTimeoutEscalatedBy: "partner_a",
          handoffTimeoutEscalatedAt: Date.now() - 40 * 60 * 1000,
          staleReassignmentAttestedBy: null,
          staleReassignmentAttestedAt: null,
          reassignedOwnerId: null,
          forcedDrainCheckpointedBy: null,
          forcedDrainCheckpointedAt: null,
          forcedDrainOverrideNote: null,
          drainThroughputPerDay: 2,
          openQueueAgingHours: 2,
          notes: ["repo queue drain row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByRebalanceId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureSettlementAttestation: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          settlementId:
            "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "lock_release_attested",
          postResolutionCheckpointedBy: "partner_a",
          postResolutionCheckpointedAt: Date.now() - 30 * 60 * 1000,
          lockReleaseAttestedBy: "partner_a",
          lockReleaseAttestedAt: Date.now() - 20 * 60 * 1000,
          disputeReopenGuardedBy: null,
          disputeReopenGuardedAt: null,
          disputeReopenGuardNote: null,
          settlementVerificationLagHours: 1,
          notes: ["repo settlement attestation row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByAdjudicationId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureQueueDrainReconciliation: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          queueDrainId:
            "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "forced_drain_attested",
          forcedDrainAttestedBy: "partner_a",
          forcedDrainAttestedAt: Date.now() - 25 * 60 * 1000,
          reassignmentRollbackCheckpointedBy: null,
          reassignmentRollbackCheckpointedAt: null,
          rollbackToOwnerId: null,
          timeoutReentryControlledBy: null,
          timeoutReentryControlledAt: null,
          timeoutReentryWindowHours: null,
          drainReopenPressureCount: 1,
          notes: ["repo queue drain reconciliation row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByRebalanceId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureSettlementArbitration: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          adjudicationId:
            "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          settlementAttestationId:
            "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "panel_confirmation_attested",
          verificationOverridePetitionedBy: "partner_a",
          verificationOverridePetitionedAt: Date.now() - 22 * 60 * 1000,
          panelConfirmationAttestedBy: "partner_a",
          panelConfirmationAttestedAt: Date.now() - 18 * 60 * 1000,
          reopenVetoCheckpointedBy: null,
          reopenVetoCheckpointedAt: null,
          reopenVetoNote: null,
          settlementArbitrationLeadTimeHours: 2,
          notes: ["repo settlement arbitration row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByAdjudicationId: vi.fn().mockResolvedValue([]),
    },
    filingEscalationClosureQueueReentryCompliance: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          firmId: "firmA",
          ownerId: "partner_a",
          queueId: "closure-followup:closure-compliance:firmA:partner_a",
          rebalanceId: "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          queueReconciliationId:
            "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a",
          classification: "internal",
          packageIds: ["pkg_repo"],
          status: "timeout_waiver_checkpointed",
          reentryExceptionAttestedBy: "partner_a",
          reentryExceptionAttestedAt: Date.now() - 16 * 60 * 1000,
          timeoutWaiverCheckpointedBy: "partner_a",
          timeoutWaiverCheckpointedAt: Date.now() - 12 * 60 * 1000,
          timeoutWaiverHours: 24,
          reconciliationResumedBy: null,
          reconciliationResumedAt: null,
          queueReentryExceptionDebtCount: 1,
          notes: ["repo queue reentry compliance row"],
          lastEvaluatedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
      listByOwnerId: vi.fn().mockResolvedValue([]),
      listByQueueId: vi.fn().mockResolvedValue([]),
      listByRebalanceId: vi.fn().mockResolvedValue([]),
    },
    jobs: {
      create: vi.fn(),
      listByFirm: vi.fn().mockResolvedValue([]),
      listByDocument: vi.fn().mockResolvedValue([]),
    },
    workflowEvents: {
      append: vi.fn(),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    followUps: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    intimations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    audit: {
      append: vi.fn(),
      listByFirm: vi.fn().mockResolvedValue([]),
    },
    committeeOutputs: {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "cbo_repo",
          firmId: "firmA",
          actorId: "associate_a",
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
          createdAt: 1,
        },
      ]),
    },
    reportingIndex: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "idx_repo",
          firmId: "firmA",
          rowType: "matter",
          referenceId: "mat_1",
          classification: "internal",
          label: "Repo Indexed Matter",
          detail: "SHC",
          linkedMatterId: "mat_1",
          linkedClientId: "client_a",
          status: "engagement_unconfirmed:pending",
          tags: ["repo", "indexed", "matter"],
          updatedAt: 1,
        },
      ]),
    },
    draftTemplateAnalytics: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "template:constitutional_petition_199",
          firmId: "firmA",
          templateId: "constitutional_petition_199",
          templateName: "Constitutional Petition (Art. 199)",
          templatePosture: "writ",
          templateCategory: "constitutional",
          composeCount: 2,
          templateSearchCount: 5,
          lastComposedAt: 10,
          lastTemplateSearchAt: 11,
          lastTemplateSearchQuery: "petition",
          updatedAt: 12,
        },
      ]),
    },
    matterReportExportAnalytics: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "matter_report_export:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          classification: "internal",
          exportCount: 3,
          lastExportedAt: 90,
          lastExportedBy: "partner_a",
          lastExportFormat: "csv",
          lastExportScope: "summary",
          lastExportReason: "repo mock",
          updatedAt: 91,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    matterReportRelevanceSnapshots: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "matter_report_relevance:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          classification: "internal",
          relevanceScore: 68,
          scoreBand: "medium",
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "relevance"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 92,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsActivity: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "ops_repo",
          firmId: "firmA",
          source: "workflow_event",
          action: "workflow_transition",
          actorId: "associate_a",
          classification: "internal",
          matterId: "mat_1",
          documentId: "doc_repo",
          followUpId: null,
          queueType: null,
          status: "processing",
          detail: "repo transition",
          tags: ["repo", "workflow"],
          createdAt: 3,
        },
      ]),
    },
    workflowOpsAlertDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          classification: "internal",
          severity: "high",
          backlogPressureCount: 5,
          unresolvedFollowUpDebtCount: 2,
          staleQueueWindowCount: 1,
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "alert"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          acknowledgedAt: null,
          acknowledgedBy: null,
          acknowledgedReason: null,
          snoozedUntil: null,
          snoozedBy: null,
          snoozedReason: null,
          updatedAt: 4,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertAttestations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_attestation:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          alertDigestId: "workflow_ops_alert:mat_1",
          classification: "internal",
          attestationStatus: "pending_attestation",
          lastAttestedAt: null,
          lastAttestedBy: null,
          attestationReason: null,
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "attestation"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 5,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertEscalationLedgers: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_escalation:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          alertDigestId: "workflow_ops_alert:mat_1",
          classification: "internal",
          escalationStatus: "open",
          severity: "high",
          ownerId: null,
          openedAt: Date.now(),
          lastStatusChangedAt: Date.now(),
          resolvedAt: null,
          resolutionReason: null,
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "escalation"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 6,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertAttestationDisputes: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_attestation_dispute:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          alertAttestationId: "workflow_ops_alert_attestation:mat_1",
          classification: "internal",
          disputeStatus: "open",
          reviewerId: null,
          openedAt: Date.now(),
          lastStatusChangedAt: Date.now(),
          resolvedAt: null,
          resolutionOutcome: null,
          resolutionReason: null,
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "attestation_dispute"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 7,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertEscalationClosures: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_escalation_closure:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          alertEscalationLedgerId: "workflow_ops_alert_escalation:mat_1",
          classification: "internal",
          closureStatus: "pending_closure",
          checkpointAt: null,
          closedAt: null,
          reopenedAt: null,
          closureReason: null,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "escalation_closure"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 8,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertDisputeEnforcementLedgers: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_dispute_enforcement:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          alertAttestationDisputeId: "workflow_ops_alert_attestation_dispute:mat_1",
          classification: "internal",
          enforcementStatus: "pending_enforcement",
          requiredOutcome: "upheld",
          ownerId: null,
          checkpointAt: Date.now(),
          enforcedAt: null,
          waivedAt: null,
          waiverReason: null,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "dispute_enforcement"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 9,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertClosureDebtReconciliationDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_closure_debt_reconciliation:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          alertEscalationClosureId: "workflow_ops_alert_escalation_closure:mat_1",
          classification: "internal",
          reconciliationStatus: "debt_open",
          reopenDebtCount: 1,
          outstandingDebtCount: 1,
          lastReopenedAt: Date.now(),
          reconcilingOwnerId: null,
          reconciliationCheckpointAt: null,
          reconciledAt: null,
          reconciliationReason: null,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "closure_debt"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 10,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertEnforcementAttestations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_enforcement_attestation:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          disputeEnforcementLedgerId: "workflow_ops_alert_dispute_enforcement:mat_1",
          classification: "internal",
          attestationStatus: "pending_attestation",
          requiredOutcome: "upheld",
          enforcementStatusSnapshot: "enforced",
          lastAttestedAt: null,
          lastAttestedBy: null,
          attestationReason: null,
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "enforcement_attestation"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 11,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertClosureDebtVarianceDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_closure_debt_variance:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          closureDebtReconciliationDigestId: "workflow_ops_alert_closure_debt_reconciliation:mat_1",
          classification: "internal",
          varianceStatus: "variance_open",
          outstandingVarianceCount: 1,
          varianceDelta: 1,
          reviewOwnerId: null,
          varianceOpenedAt: Date.now(),
          varianceResolvedAt: null,
          varianceReason: null,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "variance"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 12,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertEnforcementWaiverLedgers: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_enforcement_waiver:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          enforcementAttestationId: "workflow_ops_alert_enforcement_attestation:mat_1",
          classification: "internal",
          waiverStatus: "pending_attestation",
          requestedBy: "partner_a",
          requestedAt: Date.now(),
          attestedBy: null,
          attestedAt: null,
          waivedBy: null,
          waivedAt: null,
          waiverReason: "waiver requested",
          waiverExpiresAt: null,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "waiver"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 13,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationQueues: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_variance_remediation_queue:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          closureDebtVarianceDigestId: "workflow_ops_alert_closure_debt_variance:mat_1",
          classification: "internal",
          queueStatus: "queued",
          queueReason: "queued for remediation",
          queuedAt: Date.now(),
          ownerId: null,
          assignedAt: null,
          resolvedAt: null,
          resolutionReason: null,
          outstandingVarianceCountSnapshot: 1,
          varianceDeltaSnapshot: 1,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "variance_queue"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 14,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertWaiverExpiryDigests: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_waiver_expiry_digest:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          enforcementWaiverLedgerId: "workflow_ops_alert_enforcement_waiver:mat_1",
          classification: "internal",
          expiryStatus: "expires_lte_24h",
          waiverStatusSnapshot: "waived",
          waiverExpiresAt: Date.now() + 60_000,
          msUntilExpiry: 60_000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          extendedBy: null,
          extendedAt: null,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "waiver_expiry"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 15,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationSlaLedgers: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_variance_remediation_sla:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          remediationQueueId: "workflow_ops_alert_variance_remediation_queue:mat_1",
          classification: "internal",
          slaStatus: "warning",
          queueStatusSnapshot: "queued",
          ownerIdSnapshot: "associate_a",
          slaStartedAt: Date.now() - 10_000,
          warningThresholdMs: 14_400_000,
          breachThresholdMs: 43_200_000,
          warningDueAt: Date.now() + 1000,
          breachDueAt: Date.now() + 2000,
          elapsedMs: 10_000,
          acknowledgedBy: null,
          acknowledgedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionReason: null,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "variance_sla"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 16,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertWaiverExpiryDisputes: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_waiver_expiry_dispute:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          waiverExpiryDigestId: "workflow_ops_alert_waiver_expiry_digest:mat_1",
          classification: "internal",
          disputeStatus: "open",
          contestedExpiryStatusSnapshot: "expires_lte_24h",
          waiverExpiresAtSnapshot: Date.now() + 60_000,
          openedBy: "partner_a",
          openedAt: Date.now(),
          reviewerId: null,
          reviewAssignedAt: null,
          resolvedBy: null,
          resolvedAt: null,
          resolutionOutcome: null,
          resolutionReason: null,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "waiver_expiry_dispute"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 17,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationSlaBreachEscalations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_variance_remediation_sla_breach_escalation:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          remediationSlaLedgerId: "workflow_ops_alert_variance_remediation_sla:mat_1",
          classification: "internal",
          escalationStatus: "open",
          slaStatusSnapshot: "breached",
          queueStatusSnapshot: "assigned",
          ownerId: "associate_a",
          openedAt: Date.now(),
          resolvedAt: null,
          resolutionReason: null,
          breachDueAtSnapshot: Date.now() + 2000,
          elapsedMsSnapshot: 20_000,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "variance_sla_breach_escalation"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 18,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudications: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_waiver_expiry_dispute_adjudication:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          waiverExpiryDisputeId: "workflow_ops_alert_waiver_expiry_dispute:mat_1",
          classification: "internal",
          adjudicationStatus: "panel_assigned",
          disputeStatusSnapshot: "review_assigned",
          requestedOutcome: null,
          panelOwnerId: "partner_a",
          openedAt: Date.now(),
          dueAt: Date.now() + 60_000,
          resolvedAt: null,
          resolutionOutcome: null,
          resolutionReason: null,
          reopenPressureCount: 1,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "waiver_expiry_dispute_adjudication"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 19,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          remediationSlaBreachEscalationId:
            "workflow_ops_alert_variance_remediation_sla_breach_escalation:mat_1",
          classification: "internal",
          checkpointStatus: "reopened",
          escalationStatusSnapshot: "assigned",
          ownerIdSnapshot: "associate_a",
          checkpointOwnerId: "partner_a",
          openedAt: Date.now() - 30_000,
          dueAt: Date.now() + 30_000,
          checkpointRecordedAt: null,
          reopenedAt: Date.now(),
          resolutionNote: "repo checkpoint reopened",
          reopenPressureCount: 2,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "variance_sla_breach_resolution_checkpoint"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 20,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          waiverExpiryDisputeAdjudicationId:
            "workflow_ops_alert_waiver_expiry_dispute_adjudication:mat_1",
          classification: "internal",
          sloStatus: "breach_acknowledged",
          adjudicationStatusSnapshot: "panel_assigned",
          panelOwnerIdSnapshot: "partner_a",
          dueAtSnapshot: Date.now() + 60_000,
          dueWindowDebtMs: 0,
          stewardId: "partner_a",
          openedAt: Date.now(),
          deadlineExtendedAt: Date.now(),
          extendedDueAt: Date.now() + 120_000,
          breachAcknowledgedAt: Date.now(),
          sloNote: "repo slo stewardship",
          reopenPressureCount: 1,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "waiver_expiry_dispute_adjudication_slo"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 21,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          remediationSlaBreachResolutionCheckpointId:
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint:mat_1",
          classification: "internal",
          attestationStatus: "expiry_acknowledged",
          checkpointStatusSnapshot: "reopened",
          dueAtSnapshot: Date.now() + 30_000,
          expiryRiskStatus: "expires_soon",
          attestedBy: "partner_a",
          attestedAt: Date.now(),
          expiryAcknowledgedBy: "partner_a",
          expiryAcknowledgedAt: Date.now(),
          attestationNote: "repo checkpoint expiry attested",
          reopenPressureCount: 2,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "variance_sla_breach_resolution_checkpoint_expiry_attestation"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 22,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          waiverExpiryDisputeAdjudicationSloStewardshipId:
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo:mat_1",
          classification: "internal",
          debtStatus: "breach_closure_attested",
          sloStatusSnapshot: "breach_acknowledged",
          dueWindowDebtMsSnapshot: 0,
          debtRetiredMs: 120_000,
          remediationRecordedBy: "partner_a",
          remediationRecordedAt: Date.now(),
          tierDownshiftedBy: "partner_a",
          tierDownshiftedAt: Date.now(),
          breachClosureAttestedBy: "partner_a",
          breachClosureAttestedAt: Date.now(),
          remediationNote: "repo slo debt remediation",
          reopenPressureCount: 1,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "waiver_expiry_dispute_adjudication_slo_debt"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 23,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliation:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            expiryAttestationId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation:mat_1",
            classification: "internal",
            exceptionStatus: "exception_reconciled",
            attestationStatusSnapshot: "expiry_acknowledged",
            expiryRiskStatusSnapshot: "expires_soon",
            exceptionOpenedBy: "partner_a",
            exceptionOpenedAt: Date.now(),
            assigneeId: "associate_a",
            assigneeAssignedAt: Date.now(),
            reconciledBy: "partner_a",
            reconciledAt: Date.now(),
            overdueExceptionCount: 1,
            reconciliationNote: "repo checkpoint expiry exception",
            reopenPressureCount: 2,
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: [
              "repo",
              "variance_remediation_sla_breach_resolution_checkpoint_expiry_exception",
            ],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 24,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          waiverExpiryDisputeAdjudicationSloDebtRemediationId:
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation:mat_1",
          classification: "internal",
          burndownStatus: "burndown_checkpointed",
          debtStatusSnapshot: "breach_closure_attested",
          remainingDebtMs: 0,
          debtVelocityPerDay: 120_000,
          projectedBurndownHours: 0,
          forecastBreachHours: 0,
          retirementTargetAt: Date.now() + 86_400_000,
          targetSetBy: "partner_a",
          targetSetAt: Date.now(),
          backlogAttestedBy: "partner_a",
          backlogAttestedAt: Date.now(),
          checkpointedBy: "partner_a",
          checkpointedAt: Date.now(),
          burndownNote: "repo slo debt burndown",
          reopenPressureCount: 1,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "waiver_expiry_dispute_adjudication_slo_debt_burndown"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 25,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            expiryAttestationExceptionReconciliationId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliation:mat_1",
            classification: "internal",
            queueStatus: "queue_auto_drained",
            exceptionStatusSnapshot: "exception_reconciled",
            overdueExceptionCountSnapshot: 1,
            queueAgingHours: 2,
            openExceptionCount: 0,
            drainVelocityPerDay: 1,
            triagedBy: "partner_a",
            triagedAt: Date.now(),
            handoffAttestedBy: "partner_a",
            handoffAttestedAt: Date.now(),
            handoffToOwnerId: "associate_a",
            autoDrainCheckpointedBy: "partner_a",
            autoDrainCheckpointedAt: Date.now(),
            orchestrationNote: "repo checkpoint expiry queue",
            reopenPressureCount: 2,
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: [
              "repo",
              "variance_remediation_sla_breach_resolution_checkpoint_expiry_queue",
            ],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 26,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          waiverExpiryDisputeAdjudicationSloDebtBurndownId:
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown:mat_1",
          classification: "internal",
          settlementStatus: "rollback_resolution_closed",
          burndownStatusSnapshot: "burndown_checkpointed",
          settlementLatencyHours: 3,
          driftAcknowledgedBy: "partner_a",
          driftAcknowledgedAt: Date.now(),
          targetLockAttestedBy: "partner_a",
          targetLockAttestedAt: Date.now(),
          rollbackResolutionClosedBy: "partner_a",
          rollbackResolutionClosedAt: Date.now(),
          rollbackResolutionNote: "repo slo debt burndown settlement closed",
          settlementNote: "repo slo debt burndown settlement",
          reopenPressureCount: 1,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: ["repo", "waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement"],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 27,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id: "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          expiryAttestationQueueOrchestrationId:
            "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue:mat_1",
          classification: "internal",
          drainStatus: "forced_drain_checkpointed",
          queueStatusSnapshot: "queue_auto_drained",
          openQueueAgingHours: 0,
          drainThroughputPerDay: 2,
          handoffTimeoutEscalatedBy: "partner_a",
          handoffTimeoutEscalatedAt: Date.now(),
          staleReassignmentAttestedBy: "partner_a",
          staleReassignmentAttestedAt: Date.now(),
          reassignedOwnerId: "associate_a",
          forcedDrainCheckpointedBy: "partner_a",
          forcedDrainCheckpointedAt: Date.now(),
          forcedDrainOverrideNote: "repo checkpoint expiry queue drain",
          drainNote: "repo checkpoint expiry queue drain",
          reopenPressureCount: 2,
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: [
            "repo",
            "variance_remediation_sla_breach_resolution_checkpoint_expiry_queue_drain",
          ],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 28,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id:
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementId:
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
          classification: "internal",
          settlementAttestationStatus: "settlement_verified",
          settlementStatusSnapshot: "rollback_resolution_closed",
          postResolutionCheckpointedBy: "partner_a",
          postResolutionCheckpointedAt: Date.now(),
          lockReleaseAttestedBy: "partner_a",
          lockReleaseAttestedAt: Date.now(),
          disputeReopenGuardedBy: null,
          disputeReopenGuardedAt: null,
          disputeReopenGuardNote: null,
          settlementVerificationLagHours: 2,
          reopenPressureCount: 1,
          attestationNote: "repo slo debt burndown settlement attestation",
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: [
            "repo",
            "waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation",
          ],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 29,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            expiryAttestationQueueDrainId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            classification: "internal",
            reconciliationStatus: "timeout_reentry_controlled",
            drainStatusSnapshot: "forced_drain_checkpointed",
            forcedDrainAttestedBy: "partner_a",
            forcedDrainAttestedAt: Date.now(),
            reassignmentRollbackCheckpointedBy: null,
            reassignmentRollbackCheckpointedAt: null,
            rollbackToOwnerId: null,
            timeoutReentryControlledBy: "partner_a",
            timeoutReentryControlledAt: Date.now(),
            timeoutReentryWindowHours: 6,
            drainReopenPressureCount: 0,
            reopenPressureCount: 1,
            reconciliationNote: "repo checkpoint expiry queue drain reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: [
              "repo",
              "variance_remediation_sla_breach_resolution_checkpoint_expiry_queue_drain_reconciliation",
            ],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 30,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations: {
      upsert: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      listByFirm: vi.fn().mockResolvedValue([
        {
          id:
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
          firmId: "firmA",
          matterId: "mat_1",
          settlementAttestationId:
            "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
          classification: "internal",
          settlementArbitrationStatus: "panel_confirmation_attested",
          settlementAttestationStatusSnapshot: "settlement_verified",
          verificationOverridePetitionedBy: "partner_a",
          verificationOverridePetitionedAt: Date.now(),
          panelConfirmationAttestedBy: "partner_a",
          panelConfirmationAttestedAt: Date.now(),
          reopenVetoCheckpointedBy: null,
          reopenVetoCheckpointedAt: null,
          reopenVetoNote: null,
          settlementArbitrationLeadTimeHours: 3,
          arbitrationNote: "repo slo debt burndown settlement arbitration",
          lastStatusChangedAt: Date.now(),
          freshnessStatus: "fresh",
          provenanceTags: [
            "repo",
            "waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration",
          ],
          recomputedAt: Date.now(),
          recomputedBy: "partner_a",
          recomputeReason: "repo mock",
          updatedAt: 31,
        },
      ]),
      listByMatter: vi.fn().mockResolvedValue([]),
    },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            queueDrainReconciliationId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            classification: "internal",
            complianceStatus: "reentry_exception_attested",
            reconciliationStatusSnapshot: "timeout_reentry_controlled",
            reentryExceptionAttestedBy: "partner_a",
            reentryExceptionAttestedAt: Date.now(),
            timeoutWaiverCheckpointedBy: null,
            timeoutWaiverCheckpointedAt: null,
            timeoutWaiverHours: null,
            reconciliationResumedBy: null,
            reconciliationResumedAt: null,
            queueReentryExceptionDebtCount: 1,
            complianceNote: "repo checkpoint expiry queue reentry compliance",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: [
              "repo",
              "variance_remediation_sla_breach_resolution_checkpoint_expiry_queue_reentry_compliance",
            ],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 32,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            settlementArbitrationId:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            classification: "internal",
            dispositionFinalizationStatus: "ruling_publication_checkpointed",
            settlementArbitrationStatusSnapshot: "panel_confirmation_attested",
            finalRulingIssuedBy: "partner_a",
            finalRulingIssuedAt: Date.now(),
            finalRulingSummary: "repo final ruling",
            dissentMemorializedBy: "partner_a",
            dissentMemorializedAt: Date.now(),
            dissentMemorializedNote: "repo dissent",
            rulingPublicationCheckpointedBy: "partner_a",
            rulingPublicationCheckpointedAt: Date.now(),
            rulingPublicationChannel: "internal_panel_registry",
            arbitrationRulingAgingHours: 2,
            dispositionNote: "repo disposition finalization",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: [
              "repo",
              "waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization",
            ],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 33,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            queueReentryComplianceId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            classification: "internal",
            debtRetirementStatus: "debt_aging_auto_escalated",
            complianceStatusSnapshot: "reconciliation_resumed",
            exceptionDebtAssignedBy: "partner_a",
            exceptionDebtAssignedAt: Date.now(),
            debtAssigneeId: "associate_a",
            debtRetirementAttestedBy: "partner_a",
            debtRetirementAttestedAt: Date.now(),
            debtRetiredCount: 1,
            debtAgingAutoEscalatedBy: "partner_a",
            debtAgingAutoEscalatedAt: Date.now(),
            debtAgingEscalationHours: 12,
            queueReentryExceptionDebtCountSnapshot: 1,
            queueReentryRetirementBurnCount: 1,
            retirementNote: "repo queue reentry debt retirement",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: [
              "repo",
              "variance_remediation_sla_breach_resolution_checkpoint_expiry_queue_reentry_debt_retirement",
            ],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 34,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            dispositionFinalizationId:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            classification: "internal",
            publicationGovernanceStatus: "publication_correction_logged",
            dispositionFinalizationStatusSnapshot: "ruling_publication_checkpointed",
            publicationCorrectionLoggedBy: "partner_a",
            publicationCorrectionLoggedAt: Date.now(),
            publicationCorrectionNote: "repo publication correction",
            publicationRollbackCheckpointedBy: null,
            publicationRollbackCheckpointedAt: null,
            publicationRollbackReason: null,
            distributionAttestationReviewedBy: null,
            distributionAttestationReviewedAt: null,
            distributionAttestationDecision: null,
            arbitrationPublicationExceptionBacklogCount: 1,
            arbitrationRulingAgingHoursSnapshot: 2,
            publicationGovernanceNote: "repo publication governance",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "disposition_publication_governance"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 35,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            debtRetirementId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            classification: "internal",
            disputeReconciliationStatus: "retirement_dispute_opened",
            debtRetirementStatusSnapshot: "debt_retirement_attested",
            retirementDisputeOpenedBy: "partner_a",
            retirementDisputeOpenedAt: Date.now(),
            retirementDisputeReason: "repo retirement dispute",
            retirementDisputeResolvedBy: null,
            retirementDisputeResolvedAt: null,
            retirementDisputeResolution: null,
            retirementRollbackControlledBy: null,
            retirementRollbackControlledAt: null,
            retirementRollbackCount: 0,
            queueReentryRetirementReconciliationDriftCount: 1,
            reconciliationNote: "repo debt retirement dispute reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "debt_retirement_dispute_reconciliation"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 36,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            publicationGovernanceId:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            classification: "internal",
            externalDistributionAuditLedgerStatus: "distribution_channel_registered",
            publicationGovernanceStatusSnapshot: "publication_correction_logged",
            distributionChannelRegistry: "partner_portal_stub",
            distributionChannelRegisteredBy: "partner_a",
            distributionChannelRegisteredAt: Date.now(),
            attestationSignerRoster: null,
            attestationSignerRosterRecordedBy: null,
            attestationSignerRosterRecordedAt: null,
            publicationFreezeCheckpointedBy: null,
            publicationFreezeCheckpointedAt: null,
            publicationFreezeReason: null,
            distributionAttestationBacklogCount: 1,
            arbitrationPublicationExceptionBacklogCountSnapshot: 1,
            auditLedgerNote: "repo external distribution audit ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "external_distribution_audit_ledger"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 37,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            disputeReconciliationId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            classification: "internal",
            closureVerificationStatus: "reconciliation_closure_attested",
            disputeReconciliationStatusSnapshot: "retirement_dispute_resolved",
            reconciliationClosureAttestedBy: "partner_a",
            reconciliationClosureAttestedAt: Date.now(),
            rollbackVerificationCheckpointedBy: null,
            rollbackVerificationCheckpointedAt: null,
            rollbackVerificationNote: null,
            disputeArchiveCheckpointedBy: null,
            disputeArchiveCheckpointedAt: null,
            disputeArchiveReference: null,
            reconciliationClosureLagHours: 2,
            reconciliationClosureLagCount: 0,
            queueReentryRetirementReconciliationDriftCountSnapshot: 1,
            closureVerificationNote: "repo dispute reconciliation closure verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "dispute_reconciliation_closure_verification"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 38,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            externalDistributionAuditLedgerId:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            classification: "internal",
            partnerHandoffAttestationStatus: "outbound_registry_registered",
            externalDistributionAuditLedgerStatusSnapshot: "publication_freeze_checkpointed",
            outboundPartnerHandoffRegistry: "partner_handoff_registry_stub",
            outboundRegistryRegisteredBy: "partner_a",
            outboundRegistryRegisteredAt: Date.now(),
            partnerHandoffAttestedBy: null,
            partnerHandoffAttestedAt: null,
            partnerHandoffReference: null,
            outboundRegistryFreezeOverrideCheckpointedBy: null,
            outboundRegistryFreezeOverrideCheckpointedAt: null,
            outboundRegistryFreezeOverrideReason: null,
            partnerHandoffBacklogCount: 1,
            distributionAttestationBacklogCountSnapshot: 0,
            partnerHandoffAttestationNote: "repo partner handoff attestation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "partner_handoff_attestation"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 39,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            closureVerificationId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            classification: "internal",
            archivalExportStatus: "archival_export_checkpointed",
            closureVerificationStatusSnapshot: "dispute_archive_checkpointed",
            archivalExportCheckpointedBy: "partner_a",
            archivalExportCheckpointedAt: Date.now(),
            archivalExportReference: "archival-export-ref-stub",
            closureVerificationSlaBreachDigestedBy: null,
            closureVerificationSlaBreachDigestedAt: null,
            closureVerificationSlaBreachDigest: null,
            archivalExportFinalizedBy: null,
            archivalExportFinalizedAt: null,
            closureArchivalLagHours: 3,
            closureArchivalLagCount: 0,
            reconciliationClosureLagCountSnapshot: 0,
            archivalExportNote: "repo closure verification archival export",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "closure_verification_archival_export"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 40,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgers:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            partnerHandoffAttestationId:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus: "outbound_attestation_ledger_checkpointed",
            partnerHandoffAttestationStatusSnapshot: "partner_handoff_attested",
            outboundAttestationLedgerCheckpointedBy: "partner_a",
            outboundAttestationLedgerCheckpointedAt: Date.now(),
            outboundAttestationLedgerReference: "outbound-attestation-ledger-stub",
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            partnerDeliveryBacklogCount: 1,
            partnerHandoffBacklogCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote: "repo outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "outbound_registry_attestation_ledger"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 41,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceipts:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipt:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            archivalExportId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            classification: "internal",
            partnerDeliveryReceiptStatus: "partner_delivery_sla_breach_digested",
            archivalExportStatusSnapshot: "archival_export_finalized",
            partnerDeliverySlaBreachDigestedBy: "partner_a",
            partnerDeliverySlaBreachDigestedAt: Date.now(),
            partnerDeliverySlaBreachDigest: "partner-delivery-sla-breach-stub",
            archivalExportTransportBoundaryAttestedBy: null,
            archivalExportTransportBoundaryAttestedAt: null,
            archivalExportTransportBoundaryReference: null,
            partnerDeliveryReceiptFinalizedBy: null,
            partnerDeliveryReceiptFinalizedAt: null,
            archivalTransportLagHours: 2,
            archivalTransportLagCount: 0,
            closureArchivalLagCountSnapshot: 0,
            partnerDeliveryReceiptNote: "repo archival export partner delivery receipt",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "archival_export_partner_delivery_receipt"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 42,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerId:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_checkpointed",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: "partner_a",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: Date.now(),
            partnerDeliveryReceiptFreezeOverrideSealReference: "seal-verification-stub",
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote: "repo seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "freeze_override_seal_verification"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 43,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipt:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            firmId: "firmA",
            matterId: "mat_1",
            partnerDeliveryReceiptId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipt:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "archival_export_transport_boundary_receipt_reconciled",
            partnerDeliveryReceiptStatusSnapshot: "partner_delivery_receipt_finalized",
            archivalExportTransportBoundaryReceiptReconciledBy: "partner_a",
            archivalExportTransportBoundaryReceiptReconciledAt: Date.now(),
            archivalExportTransportBoundaryReceiptReconciliationDigest: "reconciliation-stub",
            transportBoundaryReceiptReconciliationFinalizedBy: null,
            transportBoundaryReceiptReconciliationFinalizedAt: null,
            transportBoundaryReceiptReconciliationReference: null,
            archivalTransportReconciliationLagHours: 3,
            archivalTransportReconciliationLagCount: 0,
            archivalTransportLagCountSnapshot: 0,
            partnerDeliveryTransportBoundaryReceiptReconciliationNote: "repo transport boundary reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_boundary_receipt_reconciliation"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 44,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffs:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "9d597dfb71e405c8f3eebc98ce5e8a74ec1a6145b7d6588ebadc37394f4fd422",
            firmId: "firmA",
            matterId: "mat_1",
            partnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1",
            classification: "internal",
            archivalExportCustodyHandoffStatus: "archival_export_custody_handoff_checkpointed",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verified",
            archivalExportCustodyHandoffCheckpointedBy: "partner_a",
            archivalExportCustodyHandoffCheckpointedAt: Date.now(),
            archivalExportCustodyHandoffReference: "custody-handoff-stub",
            archivalExportCustodyHandedOffBy: null,
            archivalExportCustodyHandedOffAt: null,
            archivalExportCustodyHandoffDigest: null,
            sealVerificationCustodyBacklogCount: 1,
            partnerDeliverySealBacklogCountSnapshot: 0,
            archivalExportCustodyHandoffNote: "repo custody handoff",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "archival_export_custody_handoff"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 45,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestations:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "e7a6499493b94450bfe195714aa0f484329785b98a1b5537c362518bb250349a",
            firmId: "firmA",
            matterId: "mat_1",
            partnerDeliveryTransportBoundaryReceiptReconciliationId:
              "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipt:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_digest_checkpointed",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatusSnapshot:
              "partner_delivery_transport_boundary_receipt_reconciliation_finalized",
            transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy: "partner_a",
            transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedAt: Date.now(),
            transportBoundaryReceiptReconciliationClosureAttestationDigest: "closure-attestation-stub",
            transportBoundaryReceiptReconciliationClosureAttestedBy: null,
            transportBoundaryReceiptReconciliationClosureAttestedAt: null,
            transportBoundaryReceiptReconciliationClosureAttestationReference: null,
            reconciliationClosureLagHours: 2,
            reconciliationClosureLagCount: 0,
            archivalTransportReconciliationLagCountSnapshot: 0,
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationNote:
              "repo closure attestation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_boundary_receipt_reconciliation_closure_attestation"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 46,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgments:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "custody-handoff-external-transport-receipt-ack:9d597dfb71e405c8",
            firmId: "firmA",
            matterId: "mat_1",
            archivalExportCustodyHandoffId: "9d597dfb71e405c8f3eebc98ce5e8a74ec1a6145b7d6588ebadc37394f4fd422",
            classification: "internal",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus:
              "archival_export_custody_handoff_external_transport_receipt_acknowledgment_pending",
            archivalExportCustodyHandoffStatusSnapshot: "archival_export_custody_handoff_finalized",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedBy: null,
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointedAt: null,
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentCheckpointReference: null,
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedBy: null,
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgedAt: null,
            externalTransportReceiptReference: null,
            externalTransportChannel: "blocked_todo_firm",
            custodyHandoffExternalTransportReceiptBacklogCount: 1,
            sealVerificationCustodyBacklogCountSnapshot: 1,
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentNote: "repo external transport receipt ack",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 47,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgments:
      {
        upsert: vi.fn(),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "closure-attestation-external-transport-receipt-ack:e7a6499493b94450",
            firmId: "firmA",
            matterId: "mat_1",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationId:
              "e7a6499493b94450bfe195714aa0f484329785b98a1b5537c362518bb250349a",
            classification: "internal",
            closureAttestationExternalTransportReceiptAcknowledgmentStatus:
              "closure_attestation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_closure_attested",
            closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedBy: null,
            closureAttestationExternalTransportReceiptAcknowledgmentDigestCheckpointedAt: null,
            closureAttestationExternalTransportReceiptAcknowledgmentDigestReference: null,
            closureAttestationExternalTransportReceiptAcknowledgedBy: null,
            closureAttestationExternalTransportReceiptAcknowledgedAt: null,
            externalTransportReceiptReference: null,
            externalTransportChannel: "blocked_todo_firm",
            closureAttestationExternalTransportReceiptBacklogCount: 1,
            transportBoundaryReceiptReconciliationClosureBacklogCountSnapshot: 0,
            closureAttestationExternalTransportReceiptAcknowledgmentNote: "repo closure external transport ack",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 48,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_handoff_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentId: "repo_custody_handoff_external_transport_receipt_ack",
            closureAttestationExternalTransportReceiptAcknowledgmentId: "repo_closure_external_transport_receipt_ack",
            classification: "internal",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_pending",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "archival_export_custody_handoff_external_transport_receipt_acknowledgment_pending",
            closureAttestationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "closure_attestation_external_transport_receipt_acknowledgment_pending",
            custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy: null,
            custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt: null,
            custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationDigest: null,
            custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledBy: null,
            custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationReconciledAt: null,
            custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy: null,
            custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 1,
            custodyHandoffExternalTransportReceiptBacklogCountSnapshot: 1,
            closureAttestationExternalTransportReceiptBacklogCountSnapshot: 1,
            custodyHandoffExternalTransportReceiptAcknowledgmentReconciliationNote: "repo custody ack reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 49,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            closureAttestationExternalTransportReceiptAcknowledgmentId: "repo_closure_external_transport_receipt_ack",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentId: "repo_custody_handoff_external_transport_receipt_ack",
            classification: "internal",
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_pending",
            closureAttestationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "closure_attestation_external_transport_receipt_acknowledgment_pending",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "archival_export_custody_handoff_external_transport_receipt_acknowledgment_pending",
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy: null,
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt: null,
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationDigest: null,
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy: null,
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt: null,
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy: null,
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 1,
            closureAttestationExternalTransportReceiptBacklogCountSnapshot: 1,
            custodyHandoffExternalTransportReceiptBacklogCountSnapshot: 1,
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationNote: "repo closure ack reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 50,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_external_distribution_audit_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationId:
              "repo_custody_handoff_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            externalDistributionAuditLedgerStatus:
              "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_pending",
            reconciliationFinalizedDigestAnchoredBy: null,
            reconciliationFinalizedDigestAnchoredAt: null,
            reconciliationFinalizedDigestAnchor: null,
            externalDistributionAuditLedgerEntryRecordedBy: null,
            externalDistributionAuditLedgerEntryRecordedAt: null,
            externalDistributionAuditLedgerEntryReference: null,
            externalDistributionAuditLedgerFinalizedBy: null,
            externalDistributionAuditLedgerFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            externalDistributionAuditLedgerBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 1,
            externalDistributionAuditLedgerNote: "repo custody ack recon audit ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 51,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_partner_handoff_attestation",
            firmId: "firmA",
            matterId: "mat_1",
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationId:
              "repo_closure_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            partnerHandoffAttestationStatus:
              "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_pending",
            outboundPartnerHandoffRegistry: null,
            outboundRegistryRegisteredBy: null,
            outboundRegistryRegisteredAt: null,
            partnerHandoffAttestedBy: null,
            partnerHandoffAttestedAt: null,
            partnerHandoffReference: null,
            partnerHandoffAttestationFinalizedBy: null,
            partnerHandoffAttestationFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerHandoffAttestationBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 1,
            partnerHandoffAttestationNote: "repo closure ack recon partner handoff",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 52,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_audit_ledger_partner_handoff_attestation",
            firmId: "firmA",
            matterId: "mat_1",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId:
              "repo_custody_ack_recon_external_distribution_audit_ledger",
            classification: "internal",
            partnerHandoffAttestationStatus:
              "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending",
            externalDistributionAuditLedgerStatusSnapshot:
              "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
            outboundPartnerHandoffRegistry: null,
            outboundRegistryRegisteredBy: null,
            outboundRegistryRegisteredAt: null,
            partnerHandoffAttestedBy: null,
            partnerHandoffAttestedAt: null,
            partnerHandoffReference: null,
            outboundRegistryFreezeOverrideCheckpointedBy: null,
            outboundRegistryFreezeOverrideCheckpointedAt: null,
            outboundRegistryFreezeOverrideReason: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerHandoffAttestationBacklogCount: 1,
            externalDistributionAuditLedgerBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 1,
            partnerHandoffAttestationNote: "repo custody ack recon audit ledger partner handoff",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 53,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgers:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_partner_handoff_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 1,
            outboundRegistryAttestationLedgerNote: "repo closure ack recon outbound registry ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 54,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_partner_handoff_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationId:
              "repo_custody_ack_recon_audit_ledger_partner_handoff_attestation",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            partnerHandoffAttestationStatusSnapshot:
              "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 1,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack recon partner handoff seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 55,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_outbound_registry_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_partner_handoff_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 1,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack recon outbound registry seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 56,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_seal_verification_transport_boundary_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_custody_ack_recon_partner_handoff_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "archival_export_transport_boundary_receipt_reconciled",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verified",
            archivalExportTransportBoundaryReceiptReconciledBy: "partner_a",
            archivalExportTransportBoundaryReceiptReconciledAt: Date.now(),
            archivalExportTransportBoundaryReceiptReconciliationDigest: "transport-boundary-stub",
            transportBoundaryReceiptReconciliationFinalizedBy: null,
            transportBoundaryReceiptReconciliationFinalizedAt: null,
            transportBoundaryReceiptReconciliationReference: null,
            archivalTransportReconciliationLagHours: 2,
            archivalTransportReconciliationLagCount: 0,
            partnerDeliverySealBacklogCountSnapshot: 0,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryTransportBoundaryReceiptReconciliationNote:
              "repo custody ack recon seal verification transport boundary reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 57,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_seal_verification_transport_boundary_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_closure_ack_recon_outbound_registry_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_digest_checkpointed",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verified",
            transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedBy: "partner_a",
            transportBoundaryReceiptReconciliationClosureAttestationDigestCheckpointedAt: Date.now(),
            transportBoundaryReceiptReconciliationClosureAttestationDigest: "closure-digest-stub",
            transportBoundaryReceiptReconciliationClosureAttestedBy: null,
            transportBoundaryReceiptReconciliationClosureAttestedAt: null,
            transportBoundaryReceiptReconciliationClosureAttestationReference: null,
            reconciliationClosureLagHours: 1,
            reconciliationClosureLagCount: 0,
            partnerDeliverySealBacklogCountSnapshot: 0,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationNote:
              "repo closure ack recon seal verification transport boundary reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 58,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgments:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_external_transport_receipt_ack",
            firmId: "firmA",
            matterId: "mat_1",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId:
              "repo_custody_ack_recon_seal_verification_transport_boundary_reconciliation",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatusSnapshot:
              "partner_delivery_transport_boundary_receipt_reconciliation_finalized",
            externalTransportChannel: "blocked_todo_firm",
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCount: 1,
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            updatedAt: 59,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgments:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_external_transport_receipt_ack",
            firmId: "firmA",
            matterId: "mat_1",
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId:
              "repo_closure_ack_recon_seal_verification_transport_boundary_reconciliation",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_closure_attested",
            externalTransportChannel: "blocked_todo_firm",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCount: 1,
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            updatedAt: 60,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_external_transport_receipt_ack",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_external_transport_receipt_ack",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledged",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledged",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo custody ack-recon external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 61,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_external_transport_receipt_ack",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_external_transport_receipt_ack",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledged",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledged",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy: null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt: null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest: null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy: null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt: null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy: null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo closure ack-recon external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 62,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_external_distribution_audit_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationId:
              "repo_custody_ack_recon_tb_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            externalDistributionAuditLedgerStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            reconciliationFinalizedDigestAnchoredBy: null,
            reconciliationFinalizedDigestAnchoredAt: null,
            reconciliationFinalizedDigestAnchor: null,
            externalDistributionAuditLedgerEntryRecordedBy: null,
            externalDistributionAuditLedgerEntryRecordedAt: null,
            externalDistributionAuditLedgerEntryReference: null,
            externalDistributionAuditLedgerFinalizedBy: null,
            externalDistributionAuditLedgerFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            externalDistributionAuditLedgerBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            externalDistributionAuditLedgerNote: "repo custody ack-recon TB external distribution audit ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 63,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_outbound_registry_partner_handoff_attestation",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId:
              "repo_custody_ack_recon_tb_external_distribution_audit_ledger",
            classification: "internal",
            partnerHandoffAttestationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending",
            externalTransportChannel: "blocked_todo_firm",
            partnerHandoffAttestationBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationNote: "repo custody ack-recon TB outbound registry partner handoff attestation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 65,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgers:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote: "repo closure ack-recon TB outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 66,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_partner_handoff_attestation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationId:
              "repo_closure_ack_recon_tb_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            partnerHandoffAttestationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            outboundPartnerHandoffRegistry: null,
            outboundRegistryRegisteredBy: null,
            outboundRegistryRegisteredAt: null,
            partnerHandoffAttestedBy: null,
            partnerHandoffAttestedAt: null,
            partnerHandoffReference: null,
            partnerHandoffAttestationFinalizedBy: null,
            partnerHandoffAttestationFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerHandoffAttestationBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationNote: "repo closure ack-recon TB partner handoff attestation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 64,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_partner_handoff_attestation_492_parent",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_seal_verifications_ack_reconciliation_partner_handoff_attestation",
            classification: "internal",
            partnerHandoffAttestationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundPartnerHandoffRegistry: null,
            outboundRegistryRegisteredBy: null,
            outboundRegistryRegisteredAt: null,
            partnerHandoffAttestedBy: null,
            partnerHandoffAttestedAt: null,
            partnerHandoffReference: null,
            partnerHandoffAttestationFinalizedBy: null,
            partnerHandoffAttestationFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerHandoffAttestationBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationNote:
              "repo closure ack-recon TB seal-verifications ack reconciliation partner handoff attestation (492 parent)",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_outbound_registry_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationId:
              "repo_custody_ack_recon_tb_external_distribution_audit_ledger_partner_handoff_attestation",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            partnerHandoffAttestationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_outbound_registry_freeze_override_checkpointed",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 0,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB outbound registry seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 67,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_outbound_registry_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 0,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB outbound registry seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 68,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verification_transport_boundary_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            partnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_custody_ack_recon_tb_outbound_registry_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 69,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            firmId: "firmA",
            matterId: "mat_1",
            archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId:
              "repo_custody_ack_recon_tb_seal_verification_transport_boundary_reconciliation",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatusSnapshot:
              "partner_delivery_transport_boundary_receipt_reconciliation_finalized",
            externalTransportChannel: "blocked_todo_firm",
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCount: 1,
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            updatedAt: 71,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            firmId: "firmA",
            matterId: "mat_1",
            closureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId:
              "repo_closure_ack_recon_tb_seal_verification_transport_boundary_reconciliation",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_closure_attested",
            externalTransportChannel: "blocked_todo_firm",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCount: 1,
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            updatedAt: 72,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy:
              null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt:
              null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo custody ack-recon TB seal-verifications external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 73,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView501:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_501_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy:
              null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt:
              null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo pd freeze seal 501 custody ack-recon TB seal-verifications external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 73,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationId:
              "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            externalDistributionAuditLedgerStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            reconciliationFinalizedDigestAnchoredBy: null,
            reconciliationFinalizedDigestAnchoredAt: null,
            reconciliationFinalizedDigestAnchor: null,
            externalDistributionAuditLedgerEntryRecordedBy: null,
            externalDistributionAuditLedgerEntryRecordedAt: null,
            externalDistributionAuditLedgerEntryReference: null,
            externalDistributionAuditLedgerFinalizedBy: null,
            externalDistributionAuditLedgerFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            externalDistributionAuditLedgerBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            externalDistributionAuditLedgerNote:
              "repo custody ack-recon TB seal-verifications ack reconciliation external distribution audit ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 74,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgers:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo custody ack-recon TB seal-verifications external distribution audit ledger outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 75,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView505:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_505_outbound_registry_attestation_ledger_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo custody ack-recon TB seal-verifications external distribution audit ledger outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 75,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView533:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_533_waiver_reconciliation_closure_seal_verification_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationId:
              "repo_pd_freeze_seal_531_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_reconciliation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_reconciliation_closure_seal_verification_pending",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            externalDistributionAuditLedgerReconciliationClosureSealBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo pd freeze seal 533 waiver reconciliation closure seal verification outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:533"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 87,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView517:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_517_outbound_registry_attestation_ledger_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo custody ack-recon TB seal-verifications external distribution audit ledger outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 75,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgers:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo closure ack-recon TB partner handoff attestation outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView506:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_506_partner_handoff_attestation_outbound_registry_attestation_ledger_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo closure ack-recon TB partner handoff attestation outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView518:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_518_partner_handoff_attestation_outbound_registry_attestation_ledger_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo closure ack-recon TB partner handoff attestation outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB seal-verifications outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 77,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView507:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_507_partner_delivery_receipt_freeze_override_seal_verification_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB seal-verifications outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 77,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB seal-verifications partner handoff attestation outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 78,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView519:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_519_partner_delivery_receipt_freeze_override_seal_verification_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB seal-verifications outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 77,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView508:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_508_partner_delivery_receipt_freeze_override_seal_verification_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB seal-verifications partner handoff attestation outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 78,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_520_partner_delivery_receipt_freeze_override_seal_verification_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB seal-verifications partner handoff attestation outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 78,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView521:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_521_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_519_partner_delivery_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:521"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 79.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView522:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_522_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_520_partner_delivery_receipt_freeze_override_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:522"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 80.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView509:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_509_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_507_partner_delivery_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:509"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 79.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 79,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 80,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView510:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_510_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_508_partner_delivery_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:510"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 80.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView535:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_535_waiver_reconciliation_closure_seal_verification_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationOutboundRegistryAttestationLedgerId:
              "repo_pd_freeze_seal_531_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_reconciliation",
            classification: "internal",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
            outboundRegistryAttestationLedgerStatusSnapshot: "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_reconciliation_closure_seal_verification_pending",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            externalDistributionAuditLedgerReconciliationClosureSealBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo pd freeze seal 535 waiver reconciliation closure seal verification outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:535"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 87,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView517:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_517_outbound_registry_attestation_ledger_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo custody ack-recon TB seal-verifications external distribution audit ledger outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 75,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgers:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo closure ack-recon TB partner handoff attestation outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView506:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_506_partner_handoff_attestation_outbound_registry_attestation_ledger_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo closure ack-recon TB partner handoff attestation outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView518:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_518_partner_handoff_attestation_outbound_registry_attestation_ledger_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo closure ack-recon TB partner handoff attestation outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB seal-verifications outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 77,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView507:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_507_partner_delivery_receipt_freeze_override_seal_verification_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB seal-verifications outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 77,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB seal-verifications partner handoff attestation outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 78,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView519:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_519_partner_delivery_receipt_freeze_override_seal_verification_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB seal-verifications outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 77,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView508:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_508_partner_delivery_receipt_freeze_override_seal_verification_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB seal-verifications partner handoff attestation outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 78,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_520_partner_delivery_receipt_freeze_override_seal_verification_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB seal-verifications partner handoff attestation outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 78,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView521:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_521_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_519_partner_delivery_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:521"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 79.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView522:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_522_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_520_partner_delivery_receipt_freeze_override_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:522"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 80.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView509:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_509_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_507_partner_delivery_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:509"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 79.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 79,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 80,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView510:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_510_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_508_partner_delivery_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:510"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 80.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView537:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_537_waiver_reconciliation_closure_seal_verification_outbound_registry_attestation_ledgers_external_distribution_audit_ledger_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationOutboundRegistryAttestationLedgerId:
              "repo_pd_freeze_seal_535_waiver_reconciliation_closure_seal_verification_outbound_registry_attestation_ledger",
            classification: "internal",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerReconciliationDigestCheckpointedBy: null,
            externalDistributionAuditLedgerReconciliationDigestCheckpointedAt: null,
            externalDistributionAuditLedgerReconciliationDigest: null,
            externalDistributionAuditLedgerReconciliationReconciledBy: null,
            externalDistributionAuditLedgerReconciliationReconciledAt: null,
            externalDistributionAuditLedgerReconciliationFinalizedBy: null,
            externalDistributionAuditLedgerReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryBacklogCountSnapshot: 1,
            externalDistributionAuditLedgerReconciliationBacklogCount: 1,
            externalDistributionAuditLedgerReconciliationNote:
              "repo pd freeze seal 537 waiver reconciliation closure seal verification outbound registry attestation ledgers external distribution audit ledger reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:537"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 89,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView517:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_517_outbound_registry_attestation_ledger_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo custody ack-recon TB seal-verifications external distribution audit ledger outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 75,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgers:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo closure ack-recon TB partner handoff attestation outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView506:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_506_partner_handoff_attestation_outbound_registry_attestation_ledger_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo closure ack-recon TB partner handoff attestation outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView518:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_518_partner_handoff_attestation_outbound_registry_attestation_ledger_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation",
            classification: "internal",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_finalized",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo closure ack-recon TB partner handoff attestation outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 76,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB seal-verifications outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 77,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView507:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_507_partner_delivery_receipt_freeze_override_seal_verification_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB seal-verifications outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 77,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB seal-verifications partner handoff attestation outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 78,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView519:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_519_partner_delivery_receipt_freeze_override_seal_verification_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerOutboundRegistryAttestationLedgerId:
              "repo_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerDeliveryBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo custody ack-recon TB seal-verifications outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 77,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView508:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_508_partner_delivery_receipt_freeze_override_seal_verification_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB seal-verifications partner handoff attestation outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 78,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_520_partner_delivery_receipt_freeze_override_seal_verification_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerId:
              "repo_closure_ack_recon_tb_partner_handoff_attestation_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_delivery_receipt_freeze_override_digested",
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealCheckpointedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealReference: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedBy: null,
            partnerDeliveryReceiptFreezeOverrideSealVerifiedAt: null,
            partnerDeliveryReceiptFreezeOverrideSealVerificationDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliverySealBacklogCount: 1,
            partnerHandoffAttestationBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryReceiptFreezeOverrideSealVerificationNote:
              "repo closure ack-recon TB seal-verifications partner handoff attestation outbound registry attestation ledger partner-delivery receipt freeze-override seal verification",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 78,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView521:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_521_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_519_partner_delivery_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:521"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 79.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView522:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_522_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_520_partner_delivery_receipt_freeze_override_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:522"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 80.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView509:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_509_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_507_partner_delivery_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:509"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 79.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 79,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 80,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView510:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_510_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_pd_freeze_seal_508_partner_delivery_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:510"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 80.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },

    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView511:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_509_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId:
              "repo_pd_freeze_seal_507_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            partnerDeliveryTransportBoundaryReceiptReconciliationId:
              "repo_pd_freeze_seal_507_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:511"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 81.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView523:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_521_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId:
              "repo_pd_freeze_seal_507_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            partnerDeliveryTransportBoundaryReceiptReconciliationId:
              "repo_pd_freeze_seal_507_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:523"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 81.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView512:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_510_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId:
              "repo_pd_freeze_seal_508_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            partnerDeliveryTransportBoundaryReceiptReconciliationId:
              "repo_pd_freeze_seal_508_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:512"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 82.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView524:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_522_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment",
            firmId: "firmA",
            matterId: "mat_1",
            outboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationId:
              "repo_pd_freeze_seal_508_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            partnerDeliveryTransportBoundaryReceiptReconciliationId:
              "repo_pd_freeze_seal_508_partner_delivery_seal_verification_transport_boundary_receipt_reconciliation",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:524"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 82.1,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView525:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_525_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy:
              null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt:
              null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo pd freeze seal 501 custody ack-recon TB seal-verifications external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 73,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView514:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_514_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt:
              null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo pd freeze seal 502 closure ack-recon TB seal-verifications external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 74,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView526:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_526_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt:
              null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo pd freeze seal 502 closure ack-recon TB seal-verifications external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 74,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView513:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_513_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy:
              null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt:
              null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy: null,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo pd freeze seal 501 custody ack-recon TB seal-verifications external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 73,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView515:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_515_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationId:
              "repo_pd_freeze_seal_513_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            externalDistributionAuditLedgerStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            reconciliationFinalizedDigestAnchoredBy: null,
            reconciliationFinalizedDigestAnchoredAt: null,
            reconciliationFinalizedDigestAnchor: null,
            externalDistributionAuditLedgerEntryRecordedBy: null,
            externalDistributionAuditLedgerEntryRecordedAt: null,
            externalDistributionAuditLedgerEntryReference: null,
            externalDistributionAuditLedgerFinalizedBy: null,
            externalDistributionAuditLedgerFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            externalDistributionAuditLedgerBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            externalDistributionAuditLedgerNote:
              "repo pd freeze seal 515 custody ack-recon external distribution audit ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:515"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 85,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView516:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_516_closure_ack_recon_tb_partner_handoff_attestation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationId:
              "repo_pd_freeze_seal_514_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            partnerHandoffAttestationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            partnerHandoffAttestationDigestCheckpointedBy: null,
            partnerHandoffAttestationDigestCheckpointedAt: null,
            partnerHandoffAttestationDigest: null,
            partnerHandoffAttestationAttestedBy: null,
            partnerHandoffAttestationAttestedAt: null,
            partnerHandoffAttestationFinalizedBy: null,
            partnerHandoffAttestationFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerHandoffAttestationBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationNote: "repo pd freeze seal 516 closure ack-recon partner handoff attestation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:516"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 86,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView527:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_527_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationId:
              "repo_pd_freeze_seal_525_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            externalDistributionAuditLedgerStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            reconciliationFinalizedDigestAnchoredBy: null,
            reconciliationFinalizedDigestAnchoredAt: null,
            reconciliationFinalizedDigestAnchor: null,
            externalDistributionAuditLedgerEntryRecordedBy: null,
            externalDistributionAuditLedgerEntryRecordedAt: null,
            externalDistributionAuditLedgerEntryReference: null,
            externalDistributionAuditLedgerFinalizedBy: null,
            externalDistributionAuditLedgerFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            externalDistributionAuditLedgerBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            externalDistributionAuditLedgerNote:
              "repo pd freeze seal 527 custody ack-recon external distribution audit ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:527"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 85,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView528:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_528_closure_ack_recon_tb_partner_handoff_attestation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationId:
              "repo_pd_freeze_seal_526_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            partnerHandoffAttestationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            partnerHandoffAttestationDigestCheckpointedBy: null,
            partnerHandoffAttestationDigestCheckpointedAt: null,
            partnerHandoffAttestationDigest: null,
            partnerHandoffAttestationAttestedBy: null,
            partnerHandoffAttestationAttestedAt: null,
            partnerHandoffAttestationFinalizedBy: null,
            partnerHandoffAttestationFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerHandoffAttestationBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationNote: "repo pd freeze seal 528 closure ack-recon partner handoff attestation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:528"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 86,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView529:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_529_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerId:
              "repo_pd_freeze_seal_525_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            reconciliationFinalizedDigestAnchoredBy: null,
            reconciliationFinalizedDigestAnchoredAt: null,
            reconciliationFinalizedDigestAnchor: null,
            externalDistributionAuditLedgerEntryRecordedBy: null,
            externalDistributionAuditLedgerEntryRecordedAt: null,
            externalDistributionAuditLedgerEntryReference: null,
            externalDistributionAuditLedgerFinalizedBy: null,
            externalDistributionAuditLedgerFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            externalDistributionAuditLedgerBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            externalDistributionAuditLedgerNote:
              "repo pd freeze seal 529 custody ack-recon external distribution audit ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:529"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 85,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView530:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_530_closure_ack_recon_tb_partner_handoff_attestation_acknowledgement",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationId:
              "repo_pd_freeze_seal_526_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            partnerHandoffAttestationDigestCheckpointedBy: null,
            partnerHandoffAttestationDigestCheckpointedAt: null,
            partnerHandoffAttestationDigest: null,
            partnerHandoffAttestationAttestedBy: null,
            partnerHandoffAttestationAttestedAt: null,
            partnerHandoffAttestationFinalizedBy: null,
            partnerHandoffAttestationFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerHandoffAttestationBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationNote: "repo pd freeze seal 530 closure ack-recon partner handoff attestation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:530"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 86,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsTbAckReconPdFreezeSealView531:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_531_custody_ack_recon_tb_seal_verifications_ack_reconciliation_external_distribution_audit_ledger_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            externalDistributionAuditLedgerReconciliationId:
              "repo_pd_freeze_seal_525_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_reconciliation_closure_seal_verification_pending",
            externalDistributionAuditLedgerReconciliationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            reconciliationFinalizedDigestAnchoredBy: null,
            reconciliationFinalizedDigestAnchoredAt: null,
            reconciliationFinalizedDigestAnchor: null,
            externalDistributionAuditLedgerEntryRecordedBy: null,
            externalDistributionAuditLedgerEntryRecordedAt: null,
            externalDistributionAuditLedgerEntryReference: null,
            externalDistributionAuditLedgerFinalizedBy: null,
            externalDistributionAuditLedgerFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            externalDistributionAuditLedgerBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            externalDistributionAuditLedgerNote:
              "repo pd freeze seal 531 custody ack-recon external distribution audit ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:531"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 85,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsTbAckReconPdFreezeSealView532:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_532_closure_ack_recon_tb_partner_handoff_attestation_acknowledgement",
            firmId: "firmA",
            matterId: "mat_1",
            partnerHandoffAttestationAcknowledgementSealVerificationId:
              "repo_pd_freeze_seal_526_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            classification: "internal",
            partnerHandoffAttestationAcknowledgementSealVerificationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_acknowledgement_seal_verification_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            partnerHandoffAttestationDigestCheckpointedBy: null,
            partnerHandoffAttestationDigestCheckpointedAt: null,
            partnerHandoffAttestationDigest: null,
            partnerHandoffAttestationAttestedBy: null,
            partnerHandoffAttestationAttestedAt: null,
            partnerHandoffAttestationFinalizedBy: null,
            partnerHandoffAttestationFinalizedAt: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerHandoffAttestationBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationNote: "repo pd freeze seal 532 closure ack-recon partner handoff attestation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:532"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 86,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView534:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_534_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            partnerHandoffAttestationAcknowledgementSealVerificationId:
              "repo_pd_freeze_seal_532_closure_ack_recon_tb_partner_handoff_attestation_acknowledgement",
            classification: "internal",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationAcknowledgementSealVerificationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_acknowledgement_seal_verification_pending",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            partnerHandoffAttestationAcknowledgementSealBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo pd freeze seal 534 variance partner handoff attestation acknowledgement seal verification outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:534"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 88,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment",
            firmId: "firmA",
            matterId: "mat_1",
            partnerDeliveryTransportBoundaryReceiptReconciliationId:
              "repo_custody_ack_recon_tb_seal_verifications_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation",
            classification: "internal",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 81,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment",
            firmId: "firmA",
            matterId: "mat_1",
            partnerDeliveryTransportBoundaryReceiptReconciliationId:
              "repo_closure_ack_recon_tb_seal_verifications_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatusSnapshot:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 82,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt:
              null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo closure ack-recon TB seal-verifications external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 74,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView502:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_502_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_closure_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentId:
              "repo_custody_ack_recon_tb_seal_verifications_transport_boundary_external_transport_receipt_ack",
            classification: "internal",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatusSnapshot:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigestCheckpointedAt:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationDigest:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationReconciledAt:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedBy:
              null,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationFinalizedAt:
              null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCount: 0,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            transportBoundaryReceiptReconciliationExternalTransportReceiptBacklogCountSnapshot: 1,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationNote:
              "repo pd freeze seal 502 closure ack-recon TB seal-verifications external transport receipt acknowledgment reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 74,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_closure_ack_recon_tb_seal_verification_transport_boundary_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            partnerDeliveryReceiptFreezeOverrideSealVerificationId:
              "repo_closure_ack_recon_tb_outbound_registry_seal_verification",
            classification: "internal",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatusSnapshot:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
            externalTransportChannel: "blocked_todo_firm",
            provenanceTags: ["repo", "transport_stub:true"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 70,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView536:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_536_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledger",
            firmId: "firmA",
            matterId: "mat_1",
            partnerHandoffAttestationAcknowledgementSealVerificationId:
              "repo_pd_freeze_seal_532_closure_ack_recon_tb_partner_handoff_attestation_acknowledgement",
            classification: "internal",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
            partnerHandoffAttestationAcknowledgementSealVerificationStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_acknowledgement_seal_verification_pending",
            outboundAttestationLedgerCheckpointedBy: null,
            outboundAttestationLedgerCheckpointedAt: null,
            outboundAttestationLedgerReference: null,
            partnerDeliveryReceiptFreezeOverrideDigestedBy: null,
            partnerDeliveryReceiptFreezeOverrideDigestedAt: null,
            partnerDeliveryReceiptFreezeOverrideDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCount: 1,
            partnerHandoffAttestationAcknowledgementSealBacklogCountSnapshot: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            outboundRegistryAttestationLedgerNote:
              "repo pd freeze seal 536 variance partner handoff attestation acknowledgement seal verification outbound registry attestation ledger",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:536"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 88,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView538:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_538_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledgers_partner_handoff_attestation_acknowledgement",
            firmId: "firmA",
            matterId: "mat_1",
            partnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgerId:
              "repo_pd_freeze_seal_536_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationAcknowledgementDigestCheckpointedBy: null,
            partnerHandoffAttestationAcknowledgementDigestCheckpointedAt: null,
            partnerHandoffAttestationAcknowledgementDigest: null,
            partnerHandoffAttestationAcknowledgedBy: null,
            partnerHandoffAttestationAcknowledgedAt: null,
            partnerHandoffAttestationAcknowledgementReference: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCountSnapshot: 1,
            partnerHandoffAttestationAcknowledgementBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationAcknowledgementNote:
              "repo pd freeze seal 538 variance partner handoff attestation acknowledgement seal verification outbound registry attestation ledgers partner handoff attestation acknowledgement",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:538"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 90,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView540:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_538_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledgers_partner_handoff_attestation_acknowledgement",
            firmId: "firmA",
            matterId: "mat_1",
            partnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgerId:
              "repo_pd_freeze_seal_536_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationAcknowledgementDigestCheckpointedBy: null,
            partnerHandoffAttestationAcknowledgementDigestCheckpointedAt: null,
            partnerHandoffAttestationAcknowledgementDigest: null,
            partnerHandoffAttestationAcknowledgedBy: null,
            partnerHandoffAttestationAcknowledgedAt: null,
            partnerHandoffAttestationAcknowledgementReference: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCountSnapshot: 1,
            partnerHandoffAttestationAcknowledgementBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationAcknowledgementNote:
              "repo pd freeze seal 538 variance partner handoff attestation acknowledgement seal verification outbound registry attestation ledgers partner handoff attestation acknowledgement",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:538"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 90,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView541:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_541_waiver_reconciliation_closure_seal_verification_outbound_registry_attestation_ledgers_external_distribution_audit_ledger_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationOutboundRegistryAttestationLedgerId:
              "repo_pd_freeze_seal_539_waiver_reconciliation_closure_seal_verification_outbound_registry_attestation_ledger",
            classification: "internal",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerReconciliationDigestCheckpointedBy: null,
            externalDistributionAuditLedgerReconciliationDigestCheckpointedAt: null,
            externalDistributionAuditLedgerReconciliationDigest: null,
            externalDistributionAuditLedgerReconciliationReconciledBy: null,
            externalDistributionAuditLedgerReconciliationReconciledAt: null,
            externalDistributionAuditLedgerReconciliationFinalizedBy: null,
            externalDistributionAuditLedgerReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryBacklogCountSnapshot: 1,
            externalDistributionAuditLedgerReconciliationBacklogCount: 1,
            externalDistributionAuditLedgerReconciliationNote:
              "repo pd freeze seal 541 waiver reconciliation closure seal verification outbound registry attestation ledgers external distribution audit ledger reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:541"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 89,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView542:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_540_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledgers_partner_handoff_attestation_acknowledgement",
            firmId: "firmA",
            matterId: "mat_1",
            partnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgerId:
              "repo_pd_freeze_seal_538_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationAcknowledgementDigestCheckpointedBy: null,
            partnerHandoffAttestationAcknowledgementDigestCheckpointedAt: null,
            partnerHandoffAttestationAcknowledgementDigest: null,
            partnerHandoffAttestationAcknowledgedBy: null,
            partnerHandoffAttestationAcknowledgedAt: null,
            partnerHandoffAttestationAcknowledgementReference: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCountSnapshot: 1,
            partnerHandoffAttestationAcknowledgementBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationAcknowledgementNote:
              "repo pd freeze seal 538 variance partner handoff attestation acknowledgement seal verification outbound registry attestation ledgers partner handoff attestation acknowledgement",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:542"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 90,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView543:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_541_waiver_reconciliation_closure_seal_verification_outbound_registry_attestation_ledgers_external_distribution_audit_ledger_reconciliation",
            firmId: "firmA",
            matterId: "mat_1",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationOutboundRegistryAttestationLedgerId:
              "repo_pd_freeze_seal_541_waiver_reconciliation_closure_seal_verification_outbound_registry_attestation_ledger",
            classification: "internal",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "outbound_registry_attestation_ledger_pending",
            externalDistributionAuditLedgerReconciliationDigestCheckpointedBy: null,
            externalDistributionAuditLedgerReconciliationDigestCheckpointedAt: null,
            externalDistributionAuditLedgerReconciliationDigest: null,
            externalDistributionAuditLedgerReconciliationReconciledBy: null,
            externalDistributionAuditLedgerReconciliationReconciledAt: null,
            externalDistributionAuditLedgerReconciliationFinalizedBy: null,
            externalDistributionAuditLedgerReconciliationFinalizedAt: null,
            externalTransportReceiptReferenceParityDigest: null,
            externalTransportChannel: "blocked_todo_firm",
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerDeliveryBacklogCountSnapshot: 1,
            externalDistributionAuditLedgerReconciliationBacklogCount: 1,
            externalDistributionAuditLedgerReconciliationNote:
              "repo pd freeze seal 541 waiver reconciliation closure seal verification outbound registry attestation ledgers external distribution audit ledger reconciliation",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:543"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 89,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
    workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView544:
      {
        upsert: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        listByFirm: vi.fn().mockResolvedValue([
          {
            id: "repo_pd_freeze_seal_542_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledgers_partner_handoff_attestation_acknowledgement",
            firmId: "firmA",
            matterId: "mat_1",
            partnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgerId:
              "repo_pd_freeze_seal_538_variance_partner_handoff_attestation_acknowledgement_seal_verification_outbound_registry_attestation_ledger",
            classification: "internal",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
            outboundRegistryAttestationLedgerStatusSnapshot:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
            partnerHandoffAttestationAcknowledgementDigestCheckpointedBy: null,
            partnerHandoffAttestationAcknowledgementDigestCheckpointedAt: null,
            partnerHandoffAttestationAcknowledgementDigest: null,
            partnerHandoffAttestationAcknowledgedBy: null,
            partnerHandoffAttestationAcknowledgedAt: null,
            partnerHandoffAttestationAcknowledgementReference: null,
            externalTransportChannel: "blocked_todo_firm",
            partnerDeliveryBacklogCountSnapshot: 1,
            partnerHandoffAttestationAcknowledgementBacklogCount: 1,
            crossTrackExternalTransportReceiptAcknowledgmentMismatchCountSnapshot: 0,
            partnerHandoffAttestationAcknowledgementNote:
              "repo pd freeze seal 542 variance partner handoff attestation acknowledgement seal verification outbound registry attestation ledgers partner handoff attestation acknowledgement",
            lastStatusChangedAt: Date.now(),
            freshnessStatus: "fresh",
            provenanceTags: ["repo", "transport_stub:true", "tb_ack_recon_lattice:544"],
            recomputedAt: Date.now(),
            recomputedBy: "partner_a",
            recomputeReason: "repo mock",
            updatedAt: 91,
          },
        ]),
        listByMatter: vi.fn().mockResolvedValue([]),
      },
  })),
}))

describe("Route wiring uses repository adapters", () => {
  it("documents route GET uses repository listByFirm", async () => {
    const { GET } = await import("@/app/api/d1/documents/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d1/documents?userId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("doc_repo")
  })

  it("ops reporting custody ack-recon TB outbound-registry partner handoff attestation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerHandoffAttestationStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending"
    )
  })

  it("ops reporting closure ack-recon TB outbound registry attestation ledger view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ outboundRegistryAttestationLedgerStatus: string }>
    }
    expect(json.items[0]?.outboundRegistryAttestationLedgerStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending"
    )
  })

  it("filings route GET uses repository listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d4/filings?userId=associate_a&matterId=mat_1&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; packetArtifact: { packageId: string } | null }>
    }
    expect(json.items.map((item) => item.id)).toContain("pkg_repo")
    expect(json.items.some((item) => item.packetArtifact?.packageId === "pkg_repo")).toBe(true)
  })

  it("filings dispatch view GET uses repository dispatch queue listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=dispatch&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("dispatch:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings annexures view GET uses repository filingAnnexures listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=annexures&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("annexure:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings submission receipts view GET uses repository filingSubmissionReceipts listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=submission_receipts&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("receipt:pkg_repo:1")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings submission reconciliation view GET uses repository filingSubmissionReconciliation listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=submission_reconciliation&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("reconcile:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings submission exceptions view GET uses repository filingSubmissionExceptions listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=submission_exceptions&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("exception:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings transport execution view GET uses repository filingTransportExecutionEvidence listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=transport_execution&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("transport:pkg_repo:1")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings submission sla digests view GET uses repository filingSubmissionSlaDigests listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=submission_sla_digests&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("digest:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings escalation owner rota view GET uses repository filingEscalationOwnerRota listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=escalation_owner_rota&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("rota:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings escalation workload digest view GET uses repository filingEscalationWorkloadDigests listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=escalation_workload_digests&userId=associate_a&matterId=mat_1&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; packageId: string }> }
    expect(json.items.map((item) => item.id)).toContain("workload:pkg_repo")
    expect(json.items.some((item) => item.packageId === "pkg_repo")).toBe(true)
  })

  it("filings escalation policy baselines view GET uses repository filingEscalationPolicyBaselines listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=escalation_policy_baselines&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("policy:firmA:default")
  })

  it("filings breach waiver ledger view GET uses repository filingEscalationBreachWaivers listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=breach_waiver_ledger&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("waiver:pkg_repo:1")
  })

  it("filings policy variance digests view GET uses repository filingEscalationPolicyVarianceDigests listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=policy_variance_digests&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("policy-variance:pkg_repo")
  })

  it("filings waiver expiry digests view GET uses repository filingEscalationWaiverExpiryDigests listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=waiver_expiry_digests&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("waiver-expiry:pkg_repo")
  })

  it("filings variance remediation ledger view GET uses repository filingEscalationVarianceRemediations listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=variance_remediation_ledger&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("remediation:pkg_repo:1")
  })

  it("filings waiver rollover attestations view GET uses repository filingEscalationWaiverRolloverAttestations listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=waiver_rollover_attestations&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("rollover:pkg_repo:1")
  })

  it("filings remediation expiry digests view GET uses repository filingEscalationRemediationExpiryDigests listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=remediation_expiry_digests&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("remediation-expiry:pkg_repo")
  })

  it("filings rollover breach watches view GET uses repository filingEscalationRolloverBreachWatches listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=rollover_breach_watches&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("rollover-breach:pkg_repo")
  })

  it("filings remediation lifecycle view GET uses repository filingEscalationRemediationLifecycles listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=remediation_lifecycle&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("remediation-lifecycle:remediation:pkg_repo:1")
  })

  it("filings rollover reaffirmation SLA view GET uses repository filingEscalationRolloverReaffirmationSlas listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=rollover_reaffirmation_sla&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("rollover-reaffirmation-sla:pkg_repo")
  })

  it("filings closure compliance digest view GET uses repository filingEscalationClosureComplianceDigests listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_compliance_digests&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("closure-compliance:firmA:partner_a")
  })

  it("filings closure follow-up queue view GET uses repository filingEscalationClosureFollowupQueues listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_followup_queue&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure SLA window configs view GET uses repository filingEscalationClosureSlaWindowConfigs listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_sla_window_configs&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("closure-sla-window-config:firmA:default")
  })

  it("filings closure auto-assignment rules view GET uses repository filingEscalationClosureAutoAssignmentRules listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_auto_assignment_rules&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("closure-auto-assignment-rule:firmA:default")
  })

  it("filings closure SLA windows view GET uses repository filingEscalationClosureSlaWindows listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_sla_windows&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-sla-window:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure attestations view GET uses repository filingEscalationClosureAttestations listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_attestations&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1"
    )
  })

  it("filings closure SLA exception digest view GET uses repository filingEscalationClosureSlaExceptionDigests listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_sla_exception_digests&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-sla-exception:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure attestation disputes view GET uses repository filingEscalationClosureAttestationDisputes listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_attestation_disputes&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure SLA exception enforcement view GET uses repository filingEscalationClosureSlaExceptionEnforcement listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_sla_exception_enforcement&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-sla-exception-enforcement:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure adjudication queue view GET uses repository filingEscalationClosureAdjudicationQueue listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_adjudication_queue&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure enforcement rebalance view GET uses repository filingEscalationClosureEnforcementRebalance listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_enforcement_rebalance&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure adjudication quorum view GET uses repository filingEscalationClosureAdjudicationQuorum listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_adjudication_quorum&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-adjudication-quorum:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure rebalance execution view GET uses repository filingEscalationClosureRebalanceExecution listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_rebalance_execution&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-rebalance-execution:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure adjudication slo view GET uses repository filingEscalationClosureAdjudicationSlo listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_adjudication_slo&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure rebalance safeguards view GET uses repository filingEscalationClosureRebalanceSafeguards listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_rebalance_safeguards&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure adjudication slo debt remediation view GET uses repository filingEscalationClosureAdjudicationSloDebtRemediation listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_adjudication_slo_debt_remediation&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure rebalance safeguard expiry view GET uses repository filingEscalationClosureRebalanceSafeguardExpiry listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_rebalance_safeguard_expiry&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure adjudication debt burndown view GET uses repository filingEscalationClosureAdjudicationDebtBurndown listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_adjudication_debt_burndown&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure safeguard expiry attestations view GET uses repository filingEscalationClosureSafeguardExpiryAttestations listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_safeguard_expiry_attestations&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure burndown recalibration view GET uses repository filingEscalationClosureBurndownRecalibration listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_burndown_recalibration&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure expiry attestation queue view GET uses repository filingEscalationClosureExpiryAttestationQueue listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_expiry_attestation_queue&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure burndown settlement view GET uses repository filingEscalationClosureBurndownSettlement listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_burndown_settlement&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure expiry attestation queue drain view GET uses repository filingEscalationClosureExpiryAttestationQueueDrain listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_expiry_attestation_queue_drain&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure settlement attestation view GET uses repository filingEscalationClosureSettlementAttestation listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_settlement_attestation&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure queue drain reconciliation view GET uses repository filingEscalationClosureQueueDrainReconciliation listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_queue_drain_reconciliation&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("filings closure settlement arbitration view GET uses repository filingEscalationClosureSettlementArbitration listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_settlement_arbitration&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-settlement-arbitration:closure-settlement-attestation:closure-burndown-settlement:closure-burndown-recalibration:closure-adjudication-debt-burndown:closure-adjudication-slo-debt-remediation:closure-adjudication-slo:closure-adjudication-queue:closure-attestation-dispute:closure-attestation:closure-followup:closure-compliance:firmA:partner_a:1:1"
    )
  })

  it("filings closure queue reentry compliance view GET uses repository filingEscalationClosureQueueReentryCompliance listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/filings/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/filings?view=closure_queue_reentry_compliance&userId=associate_a&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "closure-queue-reentry-compliance:closure-queue-drain-reconciliation:closure-expiry-attestation-queue-drain:closure-expiry-attestation-queue:closure-safeguard-expiry-attestation:closure-rebalance-safeguard-expiry:closure-rebalance-safeguard:closure-enforcement-rebalance:closure-followup:closure-compliance:firmA:partner_a"
    )
  })

  it("clients route GET uses repository entities listByFirm", async () => {
    const { GET } = await import("@/app/api/d1/clients/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d1/clients?userId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("ent_repo")
  })

  it("committee route GET uses repository committeeOutputs listByFirm", async () => {
    const { GET } = await import("@/app/api/p1/committee-brain/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/p1/committee-brain?actorId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("cbo_repo")
  })

  it("reporting route GET uses repository reportingIndex listByFirm", async () => {
    const { GET } = await import("@/app/api/d1/reporting/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d1/reporting?actorId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("idx_repo")
  })

  it("reporting route analytics view uses export/relevance repositories", async () => {
    const { GET } = await import("@/app/api/d1/reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d1/reporting?view=matter_report_export_analytics&actorId=associate_a&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ matterId: string; exportCount: number; relevance: { scoreBand: string } | null }>
    }
    expect(json.items.some((item) => item.matterId === "mat_1" && item.exportCount === 3)).toBe(true)
    expect(json.items[0]?.relevance?.scoreBand).toBe("medium")
  })

  it("draft templates route GET uses repository draftTemplateAnalytics listByFirm", async () => {
    const { GET } = await import("@/app/api/d4/drafts/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d4/drafts?view=templates&actorId=associate_a&q=petition&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ analytics?: { templateSearchCount?: number } }>
    }
    expect(json.items.some((item) => (item.analytics?.templateSearchCount ?? 0) >= 5)).toBe(true)
  })

  it("ops reporting route GET uses repository workflowOpsActivity listByFirm", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request("http://127.0.0.1/api/d2/ops-reporting?actorId=associate_a&limit=10&cursor=0")
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string }> }
    expect(json.items.map((item) => item.id)).toContain("ops_repo")
  })

  it("ops reporting alert-digest view uses repository workflowOpsAlertDigests listByFirm", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_digests&actorId=associate_a&severity=high&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; severity: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert:mat_1")
    expect(json.items[0]?.severity).toBe("high")
  })

  it("ops reporting alert-attestation view uses repository workflowOpsAlertAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_attestations&actorId=associate_a&attestationStatus=pending_attestation&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; attestationStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_attestation:mat_1")
    expect(json.items[0]?.attestationStatus).toBe("pending_attestation")
  })

  it("ops reporting escalation-ledger view uses repository workflowOpsAlertEscalationLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_escalation_ledgers&actorId=associate_a&escalationStatus=open&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; escalationStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_escalation:mat_1")
    expect(json.items[0]?.escalationStatus).toBe("open")
  })

  it("ops reporting attestation-dispute view uses repository workflowOpsAlertAttestationDisputes", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_attestation_disputes&actorId=associate_a&disputeStatus=open&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; disputeStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_attestation_dispute:mat_1")
    expect(json.items[0]?.disputeStatus).toBe("open")
  })

  it("ops reporting escalation-closure view uses repository workflowOpsAlertEscalationClosures", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_escalation_closures&actorId=associate_a&closureStatus=pending_closure&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; closureStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_escalation_closure:mat_1")
    expect(json.items[0]?.closureStatus).toBe("pending_closure")
  })

  it("ops reporting dispute-enforcement view uses repository workflowOpsAlertDisputeEnforcementLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_dispute_enforcement_ledgers&actorId=associate_a&enforcementStatus=pending_enforcement&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; enforcementStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_dispute_enforcement:mat_1")
    expect(json.items[0]?.enforcementStatus).toBe("pending_enforcement")
  })

  it("ops reporting closure-debt reconciliation view uses repository workflowOpsAlertClosureDebtReconciliationDigests", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_closure_debt_reconciliation_digests&actorId=associate_a&reconciliationStatus=debt_open&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; reconciliationStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_closure_debt_reconciliation:mat_1"
    )
    expect(json.items[0]?.reconciliationStatus).toBe("debt_open")
  })

  it("ops reporting enforcement-attestation view uses repository workflowOpsAlertEnforcementAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_enforcement_attestations&actorId=associate_a&enforcementAttestationStatus=pending_attestation&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; attestationStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_enforcement_attestation:mat_1")
    expect(json.items[0]?.attestationStatus).toBe("pending_attestation")
  })

  it("ops reporting closure-debt variance view uses repository workflowOpsAlertClosureDebtVarianceDigests", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_closure_debt_variance_digests&actorId=associate_a&varianceStatus=variance_open&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; varianceStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_closure_debt_variance:mat_1")
    expect(json.items[0]?.varianceStatus).toBe("variance_open")
  })

  it("ops reporting enforcement-waiver view uses repository workflowOpsAlertEnforcementWaiverLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_enforcement_waiver_ledgers&actorId=associate_a&waiverStatus=pending_attestation&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; waiverStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_enforcement_waiver:mat_1")
    expect(json.items[0]?.waiverStatus).toBe("pending_attestation")
  })

  it("ops reporting variance-remediation queue view uses repository workflowOpsAlertVarianceRemediationQueues", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_queues&actorId=associate_a&remediationQueueStatus=queued&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; queueStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_queue:mat_1"
    )
    expect(json.items[0]?.queueStatus).toBe("queued")
  })

  it("ops reporting waiver-expiry digest view uses repository workflowOpsAlertWaiverExpiryDigests", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_digests&actorId=associate_a&waiverExpiryStatus=expires_lte_24h&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; expiryStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_waiver_expiry_digest:mat_1")
    expect(json.items[0]?.expiryStatus).toBe("expires_lte_24h")
  })

  it("ops reporting variance-remediation SLA view uses repository workflowOpsAlertVarianceRemediationSlaLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_ledgers&actorId=associate_a&remediationSlaStatus=warning&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; slaStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_variance_remediation_sla:mat_1")
    expect(json.items[0]?.slaStatus).toBe("warning")
  })

  it("ops reporting waiver-expiry dispute view uses repository workflowOpsAlertWaiverExpiryDisputes", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_disputes&actorId=associate_a&waiverExpiryDisputeStatus=open&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; disputeStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain("workflow_ops_alert_waiver_expiry_dispute:mat_1")
    expect(json.items[0]?.disputeStatus).toBe("open")
  })

  it("ops reporting remediation-SLA breach escalation view uses repository workflowOpsAlertVarianceRemediationSlaBreachEscalations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_escalations&actorId=associate_a&remediationSlaBreachEscalationStatus=open&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; escalationStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_escalation:mat_1"
    )
    expect(json.items[0]?.escalationStatus).toBe("open")
  })

  it("ops reporting waiver-expiry dispute adjudication view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudications", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudications&actorId=associate_a&waiverExpiryDisputeAdjudicationStatus=panel_assigned&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; adjudicationStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication:mat_1"
    )
    expect(json.items[0]?.adjudicationStatus).toBe("panel_assigned")
  })

  it("ops reporting remediation-SLA breach resolution-checkpoint view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpoints", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoints&actorId=associate_a&remediationSlaBreachResolutionCheckpointStatus=reopened&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; checkpointStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint:mat_1"
    )
    expect(json.items[0]?.checkpointStatus).toBe("reopened")
  })

  it("ops reporting waiver-expiry dispute adjudication SLO stewardship view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloStewardships", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_stewardships&actorId=associate_a&waiverExpiryDisputeAdjudicationSloStatus=breach_acknowledged&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; sloStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo:mat_1"
    )
    expect(json.items[0]?.sloStatus).toBe("breach_acknowledged")
  })

  it("ops reporting remediation-SLA breach resolution-checkpoint expiry-attestation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestations&actorId=associate_a&remediationSlaBreachResolutionCheckpointExpiryAttestationStatus=expiry_acknowledged&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; attestationStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation:mat_1"
    )
    expect(json.items[0]?.attestationStatus).toBe("expiry_acknowledged")
  })

  it("ops reporting waiver-expiry dispute adjudication SLO debt-remediation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtRemediations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_remediations&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtStatus=breach_closure_attested&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; debtStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_remediation:mat_1"
    )
    expect(json.items[0]?.debtStatus).toBe("breach_closure_attested")
  })

  it("ops reporting checkpoint expiry-attestation exception-reconciliation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationExceptionReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliations&actorId=associate_a&remediationSlaBreachResolutionCheckpointExpiryAttestationExceptionStatus=exception_reconciled&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; exceptionStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_exception_reconciliation:mat_1"
    )
    expect(json.items[0]?.exceptionStatus).toBe("exception_reconciled")
  })

  it("ops reporting waiver-expiry dispute adjudication SLO debt-burndown view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndowns", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndowns&actorId=associate_a&burndownStatus=burndown_checkpointed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; burndownStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown:mat_1"
    )
    expect(json.items[0]?.burndownStatus).toBe("burndown_checkpointed")
  })

  it("ops reporting checkpoint expiry-attestation queue-orchestration view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueOrchestrations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_orchestrations&actorId=associate_a&queueStatus=queue_auto_drained&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; queueStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue:mat_1"
    )
    expect(json.items[0]?.queueStatus).toBe("queue_auto_drained")
  })

  it("ops reporting waiver-expiry dispute adjudication SLO debt-burndown settlement view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlements", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlements&actorId=associate_a&settlementStatus=rollback_resolution_closed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; settlementStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1"
    )
    expect(json.items[0]?.settlementStatus).toBe("rollback_resolution_closed")
  })

  it("ops reporting checkpoint expiry-attestation queue-drain view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrains", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drains&actorId=associate_a&drainStatus=forced_drain_checkpointed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as { items: Array<{ id: string; drainStatus: string }> }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1"
    )
    expect(json.items[0]?.drainStatus).toBe("forced_drain_checkpointed")
  })

  it("ops reporting waiver-expiry dispute adjudication SLO debt-burndown settlement attestation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestations&actorId=associate_a&settlementAttestationStatus=settlement_verified&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; settlementAttestationStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1"
    )
    expect(json.items[0]?.settlementAttestationStatus).toBe("settlement_verified")
  })

  it("ops reporting checkpoint expiry-attestation queue-drain reconciliation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueDrainReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliations&actorId=associate_a&drainReconciliationStatus=timeout_reentry_controlled&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; reconciliationStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1"
    )
    expect(json.items[0]?.reconciliationStatus).toBe("timeout_reentry_controlled")
  })

  it("ops reporting settlement arbitration view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitrations&actorId=associate_a&settlementArbitrationStatus=panel_confirmation_attested&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; settlementArbitrationStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1"
    )
    expect(json.items[0]?.settlementArbitrationStatus).toBe("panel_confirmation_attested")
  })

  it("ops reporting queue reentry compliance view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryCompliances", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliances&actorId=associate_a&queueReentryComplianceStatus=reentry_exception_attested&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; complianceStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1"
    )
    expect(json.items[0]?.complianceStatus).toBe("reentry_exception_attested")
  })

  it("ops reporting disposition finalization view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionFinalizations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalizations&actorId=associate_a&dispositionFinalizationStatus=ruling_publication_checkpointed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; dispositionFinalizationStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1"
    )
    expect(json.items[0]?.dispositionFinalizationStatus).toBe("ruling_publication_checkpointed")
  })

  it("ops reporting queue reentry debt retirement view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirements", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirements&actorId=associate_a&debtRetirementStatus=debt_aging_auto_escalated&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; debtRetirementStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1"
    )
    expect(json.items[0]?.debtRetirementStatus).toBe("debt_aging_auto_escalated")
  })

  it("ops reporting disposition publication governance view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernances", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governances&actorId=associate_a&publicationGovernanceStatus=publication_correction_logged&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; publicationGovernanceStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1"
    )
    expect(json.items[0]?.publicationGovernanceStatus).toBe("publication_correction_logged")
  })

  it("ops reporting debt retirement dispute reconciliation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliations&actorId=associate_a&disputeReconciliationStatus=retirement_dispute_opened&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; disputeReconciliationStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1"
    )
    expect(json.items[0]?.disputeReconciliationStatus).toBe("retirement_dispute_opened")
  })

  it("ops reporting external distribution audit ledger view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledgers&actorId=associate_a&externalDistributionAuditLedgerStatus=distribution_channel_registered&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; externalDistributionAuditLedgerStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1"
    )
    expect(json.items[0]?.externalDistributionAuditLedgerStatus).toBe("distribution_channel_registered")
  })

  it("ops reporting dispute reconciliation closure verification view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerifications", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verifications&actorId=associate_a&closureVerificationStatus=reconciliation_closure_attested&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; closureVerificationStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1"
    )
    expect(json.items[0]?.closureVerificationStatus).toBe("reconciliation_closure_attested")
  })

  it("ops reporting partner handoff attestation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestations&actorId=associate_a&partnerHandoffAttestationStatus=outbound_registry_registered&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; partnerHandoffAttestationStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1"
    )
    expect(json.items[0]?.partnerHandoffAttestationStatus).toBe("outbound_registry_registered")
  })

  it("ops reporting closure verification archival export view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExports", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_exports&actorId=associate_a&archivalExportStatus=archival_export_checkpointed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; archivalExportStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1"
    )
    expect(json.items[0]?.archivalExportStatus).toBe("archival_export_checkpointed")
  })

  it("ops reporting outbound registry attestation ledger view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledgers&actorId=associate_a&outboundRegistryAttestationLedgerStatus=outbound_attestation_ledger_checkpointed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; outboundRegistryAttestationLedgerStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_finalization:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_attestation:workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement:mat_1"
    )
    expect(json.items[0]?.outboundRegistryAttestationLedgerStatus).toBe(
      "outbound_attestation_ledger_checkpointed"
    )
  })

  it("ops reporting archival export partner delivery receipt view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryReceipts", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipts&actorId=associate_a&partnerDeliveryReceiptStatus=partner_delivery_sla_breach_digested&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ id: string; partnerDeliveryReceiptStatus: string }>
    }
    expect(json.items.map((item) => item.id)).toContain(
      "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_receipt:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain_reconciliation:workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_drain:mat_1"
    )
    expect(json.items[0]?.partnerDeliveryReceiptStatus).toBe("partner_delivery_sla_breach_digested")
  })

  it("ops reporting freeze override seal verification view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&partnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_checkpointed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_checkpointed"
    )
  })

  it("ops reporting transport boundary receipt reconciliation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationStatus=archival_export_transport_boundary_receipt_reconciled&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationStatus).toBe(
      "archival_export_transport_boundary_receipt_reconciled"
    )
  })

  it("ops reporting archival export custody handoff view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffs", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoffs&actorId=associate_a&archivalExportCustodyHandoffStatus=archival_export_custody_handoff_checkpointed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ archivalExportCustodyHandoffStatus: string }>
    }
    expect(json.items[0]?.archivalExportCustodyHandoffStatus).toBe(
      "archival_export_custody_handoff_checkpointed"
    )
  })

  it("ops reporting transport boundary receipt reconciliation closure attestation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_digest_checkpointed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus: string }>
    }
    expect(
      json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus
    ).toBe("transport_boundary_receipt_reconciliation_closure_attestation_digest_checkpointed")
  })

  it("ops reporting custody handoff external transport receipt acknowledgment view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgments", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgments&actorId=associate_a&archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus=archival_export_custody_handoff_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(json.items[0]?.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentStatus).toBe(
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_pending"
    )
  })

  it("ops reporting custody handoff external transport receipt acknowledgment reconciliation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus=archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus: string }>
    }
    expect(
      json.items[0]?.archivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe("archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_pending")
  })

  it("ops reporting closure attestation external transport receipt acknowledgment reconciliation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus=closure_attestation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus: string }>
    }
    expect(json.items[0]?.closureAttestationExternalTransportReceiptAcknowledgmentReconciliationStatus).toBe(
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_pending"
    )
  })

  it("ops reporting custody acknowledgment reconciliation external distribution audit ledger view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledgers&actorId=associate_a&externalDistributionAuditLedgerStatus=archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ externalDistributionAuditLedgerStatus: string }>
    }
    expect(json.items[0]?.externalDistributionAuditLedgerStatus).toBe(
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending"
    )
  })

  it("ops reporting closure acknowledgment reconciliation partner handoff attestation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestations&actorId=associate_a&partnerHandoffAttestationStatus=closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerHandoffAttestationStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationStatus).toBe(
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending"
    )
  })

  it("ops reporting custody ack-recon audit ledger partner handoff attestation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestations&actorId=associate_a&ackReconAuditLedgerPartnerHandoffAttestationStatus=archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerHandoffAttestationStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationStatus).toBe(
      "archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_pending"
    )
  })

  it("ops reporting closure ack-recon partner handoff outbound registry attestation ledger view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledgers&actorId=associate_a&ackReconPartnerHandoffOutboundRegistryAttestationLedgerStatus=closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ outboundRegistryAttestationLedgerStatus: string }>
    }
    expect(json.items[0]?.outboundRegistryAttestationLedgerStatus).toBe(
      "closure_attestation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending"
    )
  })

  it("ops reporting custody ack-recon partner handoff seal verification view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerifications", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&partnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })

  it("ops reporting custody ack-recon seal verification transport boundary receipt reconciliation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationStatus=archival_export_transport_boundary_receipt_reconciled&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationStatus).toBe(
      "archival_export_transport_boundary_receipt_reconciled"
    )
  })

  it("ops reporting closure ack-recon seal verification transport boundary receipt reconciliation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_digest_checkpointed&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{
        partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus: string
      }>
    }
    expect(
      json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus
    ).toBe("transport_boundary_receipt_reconciliation_closure_attestation_digest_checkpointed")
  })

  it("ops reporting closure ack-recon outbound registry seal verification view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&partnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })

  it("ops reporting custody ack-recon transport boundary external transport receipt acknowledgment view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgments", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(
      json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus
    ).toBe("transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending")
  })

  it("ops reporting closure ack-recon transport boundary external transport receipt acknowledgment view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgments", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(
      json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus
    ).toBe("ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending")
  })

  it("ops reporting custody ack-recon transport boundary external transport receipt acknowledgment reconciliation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{
        transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(
      json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe("transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending")
  })

  it("ops reporting closure ack-recon transport boundary external transport receipt acknowledgment reconciliation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{
        ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(
      json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe("ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending")
  })

  it("ops reporting custody ack-recon TB external distribution audit ledger view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ externalDistributionAuditLedgerStatus: string }>
    }
    expect(json.items[0]?.externalDistributionAuditLedgerStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending"
    )
  })

  it("ops reporting closure ack-recon TB partner handoff attestation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerHandoffAttestationStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending"
    )
  })

  it("ops reporting custody ack-recon TB outbound-registry seal verification view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerifications", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&partnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })

  it("ops reporting closure ack-recon TB outbound-registry seal verification view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerifications", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&partnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })

  it("ops reporting custody ack-recon TB seal verification transport boundary receipt reconciliation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationStatus=transport_boundary_receipt_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_pending"
    )
  })

  it("ops reporting closure ack-recon TB seal verification transport boundary receipt reconciliation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{
        partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus: string
      }>
    }
    expect(
      json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus
    ).toBe("transport_boundary_receipt_reconciliation_closure_attestation_pending")
  })

  it("ops reporting custody ack-recon TB seal-verifications transport boundary external transport receipt acknowledgment view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending"
    )
  })

  it("ops reporting closure ack-recon TB seal-verifications transport boundary external transport receipt acknowledgment view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending"
    )
  })

  it("ops reporting custody ack-recon TB seal-verifications transport boundary external transport receipt acknowledgment reconciliation view uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{
        transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(
      json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe("transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending")
  })

  it("ops reporting closure ack-recon TB seal-verifications transport boundary external transport receipt acknowledgment reconciliation view uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{
        ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(
      json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending"
    )
  })

  it("ops reporting closure ack-recon TB seal-verifications ack reconciliation partner handoff attestation view (492) returns parent surface not GET 494 child", async () => {
    const view492 =
      "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations"
    const view494 = `${view492}_outbound_registry_attestation_ledgers`
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        `http://127.0.0.1/api/d2/ops-reporting?view=${view492}&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0`
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationStatus: string }>
    }
    expect(json.view).toBe(view492)
    expect(json.view).not.toBe(view494)
    expect(json.items[0]?.partnerHandoffAttestationStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending"
    )
  })

  it("ops reporting custody ack-recon TB seal-verifications ack reconciliation external distribution audit ledger view (491) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ externalDistributionAuditLedgerStatus: string }>
    }
    expect(json.items[0]?.externalDistributionAuditLedgerStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending"
    )
  })

  it("ops reporting custody ack-recon TB seal-verifications ack reconciliation external distribution audit ledger outbound registry attestation ledger view (493) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ outboundRegistryAttestationLedgerStatus: string }>
    }
    expect(json.view).toContain("outbound_registry_attestation_ledgers")
    expect(json.items[0]?.outboundRegistryAttestationLedgerStatus).toBe(
      "outbound_registry_attestation_ledger_pending"
    )
  })

  it("ops reporting closure ack-recon TB seal-verifications ack reconciliation partner handoff attestation outbound registry attestation ledger view (494) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ outboundRegistryAttestationLedgerStatus: string }>
    }
    expect(json.view).toContain("partner_handoff_attestations_outbound_registry_attestation_ledgers")
    expect(json.items[0]?.outboundRegistryAttestationLedgerStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending"
    )
  })

  const TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS: Array<{ slice: number; url: string }> = [
    {
      slice: 485,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationStatus=transport_boundary_receipt_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 486,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 487,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 488,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 489,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 490,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 491,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 492,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 493,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 494,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 495,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 496,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 497,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationStatus=transport_boundary_receipt_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 498,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 499,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 500,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 501,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 502,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 503,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 504,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 505,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 506,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 507,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&partnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 508,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&partnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 509,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationStatus=transport_boundary_receipt_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 510,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 511,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 512,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 513,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 514,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 515,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0&cursor=0",
    },
    {
      slice: 516,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0&cursor=0",
    },
    {
      slice: 517,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 518,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
{
      slice: 519,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&partnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
{
      slice: 520,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&partnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 521,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&limit=10&cursor=0",
    },
    {
      slice: 523,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 524,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 525,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 526,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 527,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 528,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 529,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_reconciliations&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 530,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestation_acknowledgements&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationAcknowledgementStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 531,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_reconciliation_closure_seal_verifications&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerReconciliationClosureSealVerificationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_reconciliation_closure_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 533,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_reconciliation_closure_seal_verifications_outbound_registry_attestation_ledgers&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&outboundRegistryAttestationLedgerStatus=outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
    {
      slice: 534,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestation_acknowledgement_seal_verifications_outbound_registry_attestation_ledgers&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&ackReconPartnerHandoffOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },
{
      slice: 535,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_reconciliation_closure_seal_verifications_outbound_registry_attestation_ledgers_external_distribution_audit_ledger_reconciliations&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&externalDistributionAuditLedgerReconciliationStatus=outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },

{
      slice: 536,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestation_acknowledgement_seal_verifications_outbound_registry_attestation_ledgers_partner_handoff_attestation_acknowledgements&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&partnerHandoffAttestationAcknowledgementStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },

    {
      slice: 537,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_reconciliations_ledger_reconciliation_closure_seal_verifications&actorId=associate_a&limit=10&cursor=0&externalDistributionAuditLedgerReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending&freshnessStatus=fresh",
    },

    {
      slice: 538,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestation_acknowledgement_seal_verifications_outbound_registry_attestation_ledgers_partner_handoff_attestation_acknowledgements_partner_handoff_attestation_acknowledgement_seal_verifications&actorId=associate_a&limit=10&cursor=0&partnerHandoffAttestationAcknowledgementStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending&freshnessStatus=fresh",
    },

    {
      slice: 532,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestation_acknowledgement_seal_verifications&actorId=associate_a&limit=10&cursor=0&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationAcknowledgementSealVerificationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_acknowledgement_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0",
    },

    {
      slice: 522,
      url:
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&limit=10&cursor=0",
    },
  ]

  it.each(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS)(
    "ops reporting TB ack-recon lattice GET $slice returns json.view equal to the requested view query param",
    async ({ url }) => {
      const requestedView = new URL(url).searchParams.get("view")
      expect(requestedView).toBeTruthy()
      const { GET } = await import("@/app/api/d2/ops-reporting/route")
      const res = await GET(new Request(url))
      expect(res.status).toBe(200)
      const json = (await res.json()) as { view: string }
      expect(json.view).toBe(requestedView)
    }
  )

  it("ops reporting custody ack-recon TB seal-verifications partner-delivery receipt freeze-override seal verification on outbound registry attestation ledger view (495) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })

  it("ops reporting closure ack-recon TB seal-verifications partner-delivery receipt freeze-override seal verification on partner handoff attestation outbound registry attestation ledger view (496) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })

  it("ops reporting parseView identity: GET 492/493/494/495/496/497/498/499/500/501/502/503/504/505/506/507/508/509/510/511/512/513/514/515/516/517/518/519/520/521/522/523/524/525/526/527/528/529/530/531/532/533/534/535/536/537/538/539/540/541/542/543/544 each resolve to its own view (no parent shadowing)", async () => {
    const view492 =
      "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations"
    const view493 =
      "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers"
    const view494 = `${view492}_outbound_registry_attestation_ledgers`
    const view495 = `${view493}_partner_delivery_receipt_freeze_override_seal_verifications`
    const view496 = "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications"
    const view497 = `${view495}_transport_boundary_receipt_reconciliations`
    const view498 = `${view496}_transport_boundary_receipt_reconciliations`
    const view499 = `${view497}_external_transport_receipt_acknowledgments`
    const view500 = `${view498}_external_transport_receipt_acknowledgments`
    const view501 = `${view499}_external_transport_receipt_acknowledgment_reconciliations`
    const view502 = `${view500}_external_transport_receipt_acknowledgment_reconciliations`
    const view505 = new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 505)!.url).searchParams.get("view")!
    const view506 = new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 506)!.url).searchParams.get("view")!
    const view507 = new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 507)!.url).searchParams.get("view")!
    const view508 = new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 508)!.url).searchParams.get("view")!
    const view509 = `${view507}_transport_boundary_receipt_reconciliations`
    const view510 = `${view508}_transport_boundary_receipt_reconciliations`
    const view511 = new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 511)!.url).searchParams.get("view")!
    const view512 = new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 512)!.url).searchParams.get("view")!
    const view513 = `${view511}_external_transport_receipt_acknowledgment_reconciliations`
    const view514 = `${view512}_external_transport_receipt_acknowledgment_reconciliations`
    const view503 = `${view501}_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations`
    const view504 = `${view502}_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations`
    const view515 = `${view513}_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations`
    const view516 = `${view514}_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations`
    const view517 = `${view515}_outbound_registry_attestation_ledgers`
    const view518 = `${view516}_partner_handoff_attestations_outbound_registry_attestation_ledgers`
    const view519 = `${view517}_partner_delivery_receipt_freeze_override_seal_verifications`
    const view520 = `${view518}_partner_delivery_receipt_freeze_override_seal_verifications`
    const view521 = `${view519}_transport_boundary_receipt_reconciliations`
    const view522 = `${view520}_transport_boundary_receipt_reconciliations`
    const view523 = new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 523)!.url).searchParams.get("view")!
    const view524 = new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 524)!.url).searchParams.get("view")!
    const view525 = `${view523}_external_transport_receipt_acknowledgment_reconciliations`
    const view526 = `${view524}_external_transport_receipt_acknowledgment_reconciliations`

    const cases: Array<{ view: string; query: string }> = [
      {
        view: view492,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
      },
      {
        view: view493,
        query:
          "waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=outbound_registry_attestation_ledger_pending",
      },
      {
        view: view494,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
      },
      {
        view: view495,
        query:
          "waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending",
      },
      {
        view: view496,
        query:
          "waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending",
      },
      {
        view: view497,
        query:
          "partnerDeliveryTransportBoundaryReceiptReconciliationStatus=transport_boundary_receipt_reconciliation_pending",
      },
      {
        view: view498,
        query:
          "partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_pending",
      },
      {
        view: view499,
        query:
          "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
      },
      {
        view: view500,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
      },
      {
        view: view501,
        query:
          "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
      },
      {
        view: view502,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
      },
      {
        view: view503,
        query:
          "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
      },
      {
        view: view504,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
      },
      {
        view: view505,
        query:
          "waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=outbound_registry_attestation_ledger_pending",
      },
      {
        view: view506,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
      },
      {
        view: view507,
        query:
          "waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending",
      },
      {
        view: view508,
        query:
          "waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationStatus=partner_delivery_receipt_freeze_override_seal_verification_pending",
      },
      {
        view: view509,
        query:
          "partnerDeliveryTransportBoundaryReceiptReconciliationStatus=transport_boundary_receipt_reconciliation_pending",
      },
      {
        view: view510,
        query:
          "partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_pending",
      },
      {
        view: view511,
        query:
          "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
      },
      {
        view: view512,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
      },
      {
        view: view513,
        query:
          "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
      },
      {
        view: view514,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
      },
      {
        view: view515,
        query:
          "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
      },
      {
        view: view516,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
      },
      {
        view: view517,
        query:
          "waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=outbound_registry_attestation_ledger_pending",
      },
      {
        view: view518,
        query: "",
      },
      {
        view: view519,
        query: "",
      },
      {
        view: view520,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
      },
      {
        view: view521,
        query:
          "partnerDeliveryTransportBoundaryReceiptReconciliationStatus=transport_boundary_receipt_reconciliation_pending",
      },
      {
        view: view522,
        query:
          "partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_pending",
      },
      {
        view: view523,
        query:
          "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
      },
      {
        view: view524,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
      },
      {
        view: view525,
        query:
          "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
      },
      {
        view: view526,
        query:
          "ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
      },
    ]

    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const resolved = new Set<string>()
    for (const { view, query } of cases) {
      const res = await GET(
        new Request(
          `http://127.0.0.1/api/d2/ops-reporting?view=${view}&actorId=associate_a&${query}&freshnessStatus=fresh&limit=10&cursor=0`
        )
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as { view: string }
      expect(json.view).toBe(view)
      resolved.add(json.view)
    }
    expect(resolved.size).toBe(cases.length)
    expect(view494).not.toBe(view492)
    expect(view495.startsWith(view493)).toBe(true)
    expect(view496.startsWith(view494)).toBe(true)
    expect(view497.startsWith(view495)).toBe(true)
    expect(view498.startsWith(view496)).toBe(true)
    expect(view499.startsWith(view497)).toBe(true)
    expect(view500.startsWith(view498)).toBe(true)
    expect(view503.startsWith(view501)).toBe(true)
    expect(view504.startsWith(view502)).toBe(true)
    expect(view505.startsWith(view503)).toBe(true)
    expect(view506.startsWith(view504)).toBe(true)
    expect(view507.startsWith(view505)).toBe(true)
    expect(view508.startsWith(view506)).toBe(true)
    expect(view509.startsWith(view507)).toBe(true)
    expect(view510.startsWith(view508)).toBe(true)
    expect(view521.startsWith(view519)).toBe(true)
    expect(view522.startsWith(view520)).toBe(true)
    expect(view503).not.toBe(view501)
    expect(view504).not.toBe(view502)
    expect(view515.startsWith(view513)).toBe(true)
    expect(view516.startsWith(view514)).toBe(true)
    expect(view517.startsWith(view515)).toBe(true)
    expect(view518.startsWith(view516)).toBe(true)
    expect(view519.startsWith(view517)).toBe(true)
    expect(view520.startsWith(view518)).toBe(true)
    expect(view515).not.toBe(view513)
    expect(view516).not.toBe(view514)
  })

  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger view (503) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgers", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ externalDistributionAuditLedgerStatus: string }>
    }
    expect(json.view).toContain(
      "external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.externalDistributionAuditLedgerStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation view (504) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationStatus: string }>
    }
    expect(json.view).toContain(
      "partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.partnerHandoffAttestationStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending"
    )
  })



  it("ops reporting custody ack-recon TB PD freeze seal partner-delivery receipt freeze-override seal verification on outbound registry attestation ledger view (507) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView507", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 507)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner-delivery receipt freeze-override seal verification on partner handoff attestation outbound registry attestation ledger view (508) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView508", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 508)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })


  it("ops reporting custody ack-recon TB PD freeze seal external transport receipt acknowledgment reconciliation view (501) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView501", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 501)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{
        transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(json.view).toContain("_external_transport_receipt_acknowledgment_reconciliations")
    expect(
      json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe("transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending")
  })

  it("ops reporting closure ack-recon TB PD freeze seal external transport receipt acknowledgment reconciliation view (502) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView502", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 502)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{
        ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(json.view).toContain("_external_transport_receipt_acknowledgment_reconciliations")
    expect(
      json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal outbound registry attestation ledger view (505) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView505", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers&actorId=associate_a&waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ outboundRegistryAttestationLedgerStatus: string }>
    }
    expect(json.view).toContain("_outbound_registry_attestation_ledgers")
    expect(json.items[0]?.outboundRegistryAttestationLedgerStatus).toBe(
      "outbound_registry_attestation_ledger_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation outbound registry attestation ledger view (506) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView506", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ outboundRegistryAttestationLedgerStatus: string }>
    }
    expect(json.view).toContain("partner_handoff_attestations_outbound_registry_attestation_ledgers")
    expect(json.items[0]?.outboundRegistryAttestationLedgerStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending"
    )
  })

  it("ops reporting custody ack-recon TB seal-verifications partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliations view (497) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationStatus=transport_boundary_receipt_reconciliation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliations view (509) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const url = TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 509)!.url
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    const requestedView = new URL(url).searchParams.get("view")!
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationStatus: string }>
    }
    expect(json.view).toBe(requestedView)
    expect(json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliations view (510) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const url = TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 510)!.url
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    const requestedView = new URL(url).searchParams.get("view")!
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus: string }>
    }
    expect(json.view).toBe(requestedView)
    expect(json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus).toBe(
      "transport_boundary_receipt_reconciliation_closure_attestation_pending"
    )
  })


  it("ops reporting custody ack-recon TB PD freeze seal transport boundary receipt reconciliation external transport receipt acknowledgment view (511) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView511", async () => {
    const url = TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 511)!.url
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    const requestedView = new URL(url).searchParams.get("view")!
    const json = (await res.json()) as {
      view: string
      items: Array<{ transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(json.view).toBe(requestedView)
    expect(json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal transport boundary receipt reconciliation external transport receipt acknowledgment view (512) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView512", async () => {
    const url = TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 512)!.url
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    const requestedView = new URL(url).searchParams.get("view")!
    const json = (await res.json()) as {
      view: string
      items: Array<{ ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(json.view).toBe(requestedView)
    expect(json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal external transport receipt acknowledgment reconciliation view (513) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView513", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 513)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{
        transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(json.view).toContain("_external_transport_receipt_acknowledgment_reconciliations")
    expect(
      json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe("transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending")
  })

  it("ops reporting closure ack-recon TB PD freeze seal external transport receipt acknowledgment reconciliation view (514) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView514", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 514)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{
        ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(json.view).toContain("_external_transport_receipt_acknowledgment_reconciliations")
    expect(
      json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending"
    )
  })


  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger view (515) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView515", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 515)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ externalDistributionAuditLedgerStatus: string }>
    }
    expect(json.view).toContain(
      "external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.externalDistributionAuditLedgerStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation view (516) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView516", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 516)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationStatus: string }>
    }
    expect(json.view).toContain(
      "partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.partnerHandoffAttestationStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending"
    )
  })



  it("ops reporting custody ack-recon TB PD freeze seal outbound registry attestation ledger view (517) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView517", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 517)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ outboundRegistryAttestationLedgerStatus: string }>
    }
    expect(json.view).toBe(new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 517)!.url).searchParams.get("view"))
    expect(json.items[0]?.outboundRegistryAttestationLedgerStatus).toBe(
      "outbound_registry_attestation_ledger_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation outbound registry attestation ledger view (518) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView518", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 518)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ outboundRegistryAttestationLedgerStatus: string }>
    }
    expect(json.view).toBe(new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 518)!.url).searchParams.get("view"))
    expect(json.items[0]?.outboundRegistryAttestationLedgerStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal partner-delivery receipt freeze-override seal verification on outbound registry attestation ledger view (519) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView519", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 519)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.view).toBe(
      new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 519)!.url).searchParams.get(
        "view"
      )
    )
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner-delivery receipt freeze-override seal verification on partner handoff attestation outbound registry attestation ledger view (520) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 520)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerDeliveryReceiptFreezeOverrideSealVerificationStatus: string }>
    }
    expect(json.view).toBe(
      new URL(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 520)!.url).searchParams.get(
        "view"
      )
    )
    expect(json.items[0]?.partnerDeliveryReceiptFreezeOverrideSealVerificationStatus).toBe(
      "partner_delivery_receipt_freeze_override_seal_verification_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliations view (521) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView521", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const url = TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 521)!.url
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    const requestedView = new URL(url).searchParams.get("view")!
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationStatus: string }>
    }
    expect(json.view).toBe(requestedView)
    expect(json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliations view (522) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView522", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const url = TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 522)!.url
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    const requestedView = new URL(url).searchParams.get("view")!
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus: string }>
    }
    expect(json.view).toBe(requestedView)
    expect(json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus).toBe(
      "transport_boundary_receipt_reconciliation_closure_attestation_pending"
    )
  })

  it("ops reporting closure ack-recon TB seal-verifications partner-delivery receipt freeze-override seal verification transport boundary receipt reconciliations view (498) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations&actorId=associate_a&partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus=transport_boundary_receipt_reconciliation_closure_attestation_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus: string }>
    }
    expect(json.items[0]?.partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus).toBe(
      "transport_boundary_receipt_reconciliation_closure_attestation_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal transport boundary receipt reconciliation external transport receipt acknowledgment view (523) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView523", async () => {
    const url = TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 523)!.url
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    const requestedView = new URL(url).searchParams.get("view")!
    const json = (await res.json()) as {
      view: string
      items: Array<{ transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(json.view).toBe(requestedView)
    expect(json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending"
    )
  })


  it("ops reporting closure ack-recon TB PD freeze seal transport boundary receipt reconciliation external transport receipt acknowledgment view (524) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView524", async () => {
    const url = TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 524)!.url
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    const requestedView = new URL(url).searchParams.get("view")!
    const json = (await res.json()) as {
      view: string
      items: Array<{ ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(json.view).toBe(requestedView)
    expect(json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal external transport receipt acknowledgment reconciliation view (525) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView525", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 525)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{
        transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(json.view).toContain("_external_transport_receipt_acknowledgment_reconciliations")
    expect(
      json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe("transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending")
  })


  it("ops reporting closure ack-recon TB PD freeze seal external transport receipt acknowledgment reconciliation view (526) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView526", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 526)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{
        ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus: string
      }>
    }
    expect(json.view).toContain("_external_transport_receipt_acknowledgment_reconciliations")
    expect(
      json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus
    ).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending"
    )
  })
  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger view (527) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView527", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 527)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ externalDistributionAuditLedgerStatus: string }>
    }
    expect(json.view).toContain(
      "external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.externalDistributionAuditLedgerStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending"
    )
  })
  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation view (528) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView528", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 528)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationStatus: string }>
    }
    expect(json.view).toContain(
      "partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.partnerHandoffAttestationStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger view (529) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView529", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 529)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ externalDistributionAuditLedgerReconciliationStatus: string }>
    }
    expect(json.view).toContain(
      "external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.externalDistributionAuditLedgerReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending"
    )
  })
  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation view (530) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView530", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 530)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationAcknowledgementStatus: string }>
    }
    expect(json.view).toContain(
      "partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.partnerHandoffAttestationAcknowledgementStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger view (531) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsTbAckReconPdFreezeSealView531", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 531)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ externalDistributionAuditLedgerReconciliationClosureSealVerificationStatus: string }>
    }
    expect(json.view).toContain(
      "external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.externalDistributionAuditLedgerReconciliationClosureSealVerificationStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_reconciliation_closure_seal_verification_pending"
    )
  })
  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation view (530) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView530", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 530)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationAcknowledgementStatus: string }>
    }
    expect(json.view).toContain(
      "partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.partnerHandoffAttestationAcknowledgementStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger reconciliation closure seal verification outbound registry attestation ledger view (533) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView533", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 533)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ externalDistributionAuditLedgerReconciliationStatus: string }>
    }
    expect(json.items[0]?.externalDistributionAuditLedgerReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger reconciliation closure seal verification outbound registry attestation ledger view (539) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView539", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 537)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      total: number
      items: Array<{ externalDistributionAuditLedgerReconciliationStatus: string }>
    }
    expect(json.total).toBe(1)
    expect(json.items[0]?.externalDistributionAuditLedgerReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending"
    )
  })
  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger reconciliation closure seal verification outbound registry attestation ledger view (541) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView541", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(new Request(LATTICE_U["541"]))
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      total: number
      items: Array<{ externalDistributionAuditLedgerReconciliationStatus: string }>
    }
    expect(json.total).toBe(1)
    expect(json.items[0]?.externalDistributionAuditLedgerReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending"
    )
  })
  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger reconciliation closure seal verification outbound registry attestation ledger view (535) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView535", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 535)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ externalDistributionAuditLedgerReconciliationStatus: string }>
    }
    expect(json.items[0]?.externalDistributionAuditLedgerReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending"
    )
  })

  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger reconciliation closure seal verification outbound registry attestation ledger view (537) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView537", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 537)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      total: number
      items: Array<{ externalDistributionAuditLedgerReconciliationStatus: string }>
    }
    expect(json.total).toBe(1)
    expect(json.items[0]?.externalDistributionAuditLedgerReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation acknowledgement seal verification outbound registry attestation ledger view (534) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView534", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 534)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationAcknowledgementStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationAcknowledgementStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending"
    )
  })
  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation acknowledgement seal verification outbound registry attestation ledger view (540) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView540", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 538)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationAcknowledgementStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationAcknowledgementStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending"
    )
  })
  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation acknowledgement seal verification outbound registry attestation ledger view (542) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView542", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(new Request(LATTICE_U["542"]))
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationAcknowledgementStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationAcknowledgementStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending"
    )
  })
  it("ops reporting custody ack-recon TB PD freeze seal external distribution audit ledger reconciliation closure seal verification outbound registry attestation ledger view (543) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView543", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(new Request(LATTICE_U["543"]))
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      total: number
      items: Array<{ externalDistributionAuditLedgerReconciliationStatus: string }>
    }
    expect(json.total).toBe(1)
    expect(json.items[0]?.externalDistributionAuditLedgerReconciliationStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending"
    )
  })
  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation acknowledgement seal verification outbound registry attestation ledger view (544) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView544", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(new Request(LATTICE_U["544"]))
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationAcknowledgementStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationAcknowledgementStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending"
    )
  })
  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation acknowledgement seal verification outbound registry attestation ledger view (536) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView536", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 536)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationAcknowledgementStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationAcknowledgementStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending"
    )
  })
  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation acknowledgement seal verification outbound registry attestation ledger view (538) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView538", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 538)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationAcknowledgementStatus: string }>
    }
    expect(json.items[0]?.partnerHandoffAttestationAcknowledgementStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending"
    )
  })

  it("ops reporting closure ack-recon TB PD freeze seal partner handoff attestation view (532) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsTbAckReconPdFreezeSealView532", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS.find((r) => r.slice === 532)!.url)
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      view: string
      items: Array<{ partnerHandoffAttestationAcknowledgementSealVerificationStatus: string }>
    }
    expect(json.view).toContain(
      "partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations"
    )
    expect(json.items[0]?.partnerHandoffAttestationAcknowledgementSealVerificationStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_acknowledgement_seal_verification_pending"
    )
  })
  it("ops reporting custody ack-recon TB seal-verifications transport boundary receipt reconciliation external transport receipt acknowledgment view (499) uses repository workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(json.items[0]?.transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus).toBe(
      "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending"
    )
  })

  it("ops reporting closure ack-recon TB seal-verifications transport boundary receipt reconciliation external transport receipt acknowledgment view (500) uses repository workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgments", async () => {
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const res = await GET(
      new Request(
        "http://127.0.0.1/api/d2/ops-reporting?view=alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments&actorId=associate_a&ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus=ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending&freshnessStatus=fresh&limit=10&cursor=0"
      )
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      items: Array<{ ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus: string }>
    }
    expect(json.items[0]?.ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus).toBe(
      "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending"
    )
  })
})
