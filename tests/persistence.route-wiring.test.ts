import { describe, expect, it, vi } from "vitest"

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
  matterClientSearchIndex: new Map(),
  draftTemplateAnalytics: new Map(),
  workflowOpsActivity: new Map(),
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
})
