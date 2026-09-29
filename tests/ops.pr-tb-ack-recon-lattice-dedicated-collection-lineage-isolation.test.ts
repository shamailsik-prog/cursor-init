import { describe, expect, it, vi } from "vitest"
import { TB_ACK_RECON_LINEAGE_ISOLATION_GET_URL as U } from "./ops.pr-tb-ack-recon-lattice-urls"

/**
 * PR260-MAJOR-1 regression: lattice pairs 493/505, 494/506, 495/507, 496/508 must use
 * separate backing stores. PR LATTICE-MAJOR-2: pairs 489/501 and 490/502 likewise.
 * Seed one row per lineage; each GET must return only its row.
 */
const spineState = vi.hoisted(() => ({ store: null as import("@/platform/spine/store").SpineStore | null }))

vi.mock("@/platform/spine/runtimeStore", async () => {
  const { SpineStore } = await import("@/platform/spine/store")
  const store = new SpineStore()
  store.users.set("associate_a", {
    id: "associate_a",
    firmId: "firmA",
    role: "associate",
    clearanceLevel: "privileged",
  })
  store.matters.set("mat_1", {
    id: "mat_1",
    firmId: "firmA",
    clientId: "client_a",
    title: "Matter",
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "engagement_unconfirmed",
    classification: "internal",
  })
  store.members.set("mat_1_associate_a", {
    matterId: "mat_1",
    userId: "associate_a",
    firmId: "firmA",
  })
  spineState.store = store
  return {
    getRuntimeStore: () => spineState.store!,
  }
})

describe("tb ack-recon lattice dedicated collection lineage isolation (493–496 vs 505–510)", () => {
  async function seedAndGet(
    seed: (repos: Awaited<ReturnType<typeof import("@/platform/persistence/runtimeRepositories").getRuntimeRepositories>>) => Promise<void>,
    url493ish: string,
    url505ish: string,
    expectLow: string,
    expectHigh: string
  ) {
    vi.resetModules()
    await import("@/platform/spine/runtimeStore")
    const { SpineStore } = await import("@/platform/spine/store")
    const store = new SpineStore()
    store.users.set("associate_a", {
      id: "associate_a",
      firmId: "firmA",
      role: "associate",
      clearanceLevel: "privileged",
    })
    store.matters.set("mat_1", {
      id: "mat_1",
      firmId: "firmA",
      clientId: "client_a",
      title: "Matter",
      courtId: "SHC",
      caseNumber: null,
      caseNumberStatus: "pending",
      status: "engagement_unconfirmed",
      classification: "internal",
    })
    store.members.set("mat_1_associate_a", {
      matterId: "mat_1",
      userId: "associate_a",
      firmId: "firmA",
    })
    spineState.store = store
    const { getRuntimeRepositories } = await import("@/platform/persistence/runtimeRepositories")
    const repos = await getRuntimeRepositories(store)
    await seed(repos)
    const { GET } = await import("@/app/api/d2/ops-reporting/route")
    const jLow = (await (await GET(new Request(url493ish))).json()) as {
      items: Array<{ id: string }>
      total?: number
    }
    const jHigh = (await (await GET(new Request(url505ish))).json()) as { items: Array<{ id: string }> }
    expect(jLow.items.map((r) => r.id)).toEqual([expectLow])
    expect(jHigh.items.map((r) => r.id)).toEqual([expectHigh])
    vi.resetModules()
  }

  const baseRow = {
    firmId: "firmA",
    matterId: "mat_1",
    classification: "internal" as const,
    recomputedAt: Date.now(),
    updatedAt: 1,
  }

  it("489/501 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations.upsert(
          {
            ...baseRow,
            id: "lineage-row-489-only",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView501.upsert(
          {
            ...baseRow,
            id: "lineage-row-501-only",
            updatedAt: 2,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
      },
      U["489"],
      U["501"],
      "lineage-row-489-only",
      "lineage-row-501-only"
    )
  })

  it("490/502 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliations.upsert(
          {
            ...baseRow,
            id: "lineage-row-490-only",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView502.upsert(
          {
            ...baseRow,
            id: "lineage-row-502-only",
            updatedAt: 2,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
      },
      U["490"],
      U["502"],
      "lineage-row-490-only",
      "lineage-row-502-only"
    )
  })

  it("493/505 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgers.upsert(
          {
            ...baseRow,
            id: "lineage-row-493-only",
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView505.upsert(
          {
            ...baseRow,
            id: "lineage-row-505-only",
            updatedAt: 2,
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
          } as never
        )
      },
      U["493"],
      U["505"],
      "lineage-row-493-only",
      "lineage-row-505-only"
    )
  })

  it("494/506 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgers.upsert(
          {
            ...baseRow,
            id: "lineage-row-494-only",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView506.upsert(
          {
            ...baseRow,
            id: "lineage-row-506-only",
            updatedAt: 2,
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
          } as never
        )
      },
      U["494"],
      U["506"],
      "lineage-row-494-only",
      "lineage-row-506-only"
    )
  })

  it("495/507 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications.upsert(
          {
            ...baseRow,
            id: "lineage-row-495-only",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView507.upsert(
          {
            ...baseRow,
            id: "lineage-row-507-only",
            updatedAt: 2,
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
          } as never
        )
      },
      U["495"],
      U["507"],
      "lineage-row-495-only",
      "lineage-row-507-only"
    )
  })

  it("496/508 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications.upsert(
          {
            ...baseRow,
            id: "lineage-row-496-only",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView508.upsert(
          {
            ...baseRow,
            id: "lineage-row-508-only",
            updatedAt: 2,
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
          } as never
        )
      },
      U["496"],
      U["508"],
      "lineage-row-496-only",
      "lineage-row-508-only"
    )
  })

  it("497/509 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations.upsert(
          {
            ...baseRow,
            id: "lineage-row-497-only",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView509.upsert(
          {
            ...baseRow,
            id: "lineage-row-509-only",
            updatedAt: 2,
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
          } as never
        )
      },
      U["497"],
      U["509"],
      "lineage-row-497-only",
      "lineage-row-509-only"
    )
  })

  it("498/510 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliations.upsert(
          {
            ...baseRow,
            id: "lineage-row-498-only",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView510.upsert(
          {
            ...baseRow,
            id: "lineage-row-510-only",
            updatedAt: 2,
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
          } as never
        )
      },
      U["498"],
      U["510"],
      "lineage-row-498-only",
      "lineage-row-510-only"
    )
  })

  it("509/511 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView509.upsert(
          {
            ...baseRow,
            id: "lineage-row-509-only",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView511.upsert(
          {
            ...baseRow,
            id: "lineage-row-511-only",
            updatedAt: 2,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
          } as never
        )
      },
      U["509"],
      U["511"],
      "lineage-row-509-only",
      "lineage-row-511-only"
    )
  })

  it("510/512 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView510.upsert(
          {
            ...baseRow,
            id: "lineage-row-510-only",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView512.upsert(
          {
            ...baseRow,
            id: "lineage-row-512-only",
            updatedAt: 2,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
          } as never
        )
      },
      U["510"],
      U["512"],
      "lineage-row-510-only",
      "lineage-row-512-only"
    )
  })
  it("511/513 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView511.upsert(
          {
            ...baseRow,
            id: "lineage-row-511-only",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView513.upsert(
          {
            ...baseRow,
            id: "lineage-row-513-only",
            updatedAt: 2,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
      },
      U["511"],
      U["513"],
      "lineage-row-511-only",
      "lineage-row-513-only"
    )
  })

  it("512/514 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView512.upsert(
          {
            ...baseRow,
            id: "lineage-row-512-only",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView514.upsert(
          {
            ...baseRow,
            id: "lineage-row-514-only",
            updatedAt: 2,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
      },
      U["512"],
      U["514"],
      "lineage-row-512-only",
      "lineage-row-514-only"
    )
  })

  it("513/515 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView513.upsert(
          {
            ...baseRow,
            id: "lineage-row-513-only",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView515.upsert(
          {
            ...baseRow,
            id: "lineage-row-515-only",
            updatedAt: 2,
            externalDistributionAuditLedgerStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
          } as never
        )
      },
      U["513"],
      U["515"],
      "lineage-row-513-only",
      "lineage-row-515-only"
    )
  })

  it("514/516 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView514.upsert(
          {
            ...baseRow,
            id: "lineage-row-514-only",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView516.upsert(
          {
            ...baseRow,
            id: "lineage-row-516-only",
            updatedAt: 2,
            partnerHandoffAttestationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
          } as never
        )
      },
      U["514"],
      U["516"],
      "lineage-row-514-only",
      "lineage-row-516-only"
    )
  })

  it("515/517 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView515.upsert(
          {
            ...baseRow,
            id: "lineage-row-515-only",
            externalDistributionAuditLedgerStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView517.upsert(
          {
            ...baseRow,
            id: "lineage-row-517-only",
            updatedAt: 2,
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
          } as never
        )
      },
      U["515"],
      U["517"],
      "lineage-row-515-only",
      "lineage-row-517-only"
    )
  })

  it("516/518 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView516.upsert(
          {
            ...baseRow,
            id: "lineage-row-516-only",
            partnerHandoffAttestationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView518.upsert(
          {
            ...baseRow,
            id: "lineage-row-518-only",
            updatedAt: 2,
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_attestation_ledger_checkpointed",
          } as never
        )
      },
      U["516"],
      U["518"],
      "lineage-row-516-only",
      "lineage-row-518-only"
    )
  })

})
