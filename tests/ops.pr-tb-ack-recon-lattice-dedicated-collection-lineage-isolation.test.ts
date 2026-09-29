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

  it("517/519 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView517.upsert(
          {
            ...baseRow,
            id: "lineage-row-517-only",
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView519.upsert(
          {
            ...baseRow,
            id: "lineage-row-519-only",
            updatedAt: 2,
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
          } as never
        )
      },
      U["517"],
      U["519"],
      "lineage-row-517-only",
      "lineage-row-519-only"
    )
  })

  it("518/520 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView518.upsert(
          {
            ...baseRow,
            id: "lineage-row-518-only",
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520.upsert(
          {
            ...baseRow,
            id: "lineage-row-520-only",
            updatedAt: 2,
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
          } as never
        )
      },
      U["518"],
      U["520"],
      "lineage-row-518-only",
      "lineage-row-520-only"
    )
  })

  it("519/521 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView519.upsert(
          {
            ...baseRow,
            id: "lineage-row-519-only",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView521.upsert(
          {
            ...baseRow,
            id: "lineage-row-521-only",
            updatedAt: 2,
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
          } as never
        )
      },
      U["519"],
      U["521"],
      "lineage-row-519-only",
      "lineage-row-521-only"
    )
  })

  it("520/522 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView520.upsert(
          {
            ...baseRow,
            id: "lineage-row-520-only",
            partnerDeliveryReceiptFreezeOverrideSealVerificationStatus:
              "partner_delivery_receipt_freeze_override_seal_verification_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView522.upsert(
          {
            ...baseRow,
            id: "lineage-row-522-only",
            updatedAt: 2,
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
          } as never
        )
      },
      U["520"],
      U["522"],
      "lineage-row-520-only",
      "lineage-row-522-only"
    )
  })

  it("521/523 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView521.upsert(
          {
            ...baseRow,
            id: "lineage-row-521-only",
            partnerDeliveryTransportBoundaryReceiptReconciliationStatus:
              "transport_boundary_receipt_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView523.upsert(
          {
            ...baseRow,
            id: "lineage-row-523-only",
            updatedAt: 2,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
          } as never
        )
      },
      U["521"],
      U["523"],
      "lineage-row-521-only",
      "lineage-row-523-only"
    )
  })

  it("522/524 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTbAckReconPdFreezeSealView522.upsert(
          {
            ...baseRow,
            id: "lineage-row-522-only",
            partnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationStatus:
              "transport_boundary_receipt_reconciliation_closure_attestation_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView524.upsert(
          {
            ...baseRow,
            id: "lineage-row-524-only",
            updatedAt: 2,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
          } as never
        )
      },
      U["522"],
      U["524"],
      "lineage-row-522-only",
      "lineage-row-524-only"
    )
  })
  it("523/525 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView523.upsert(
          {
            ...baseRow,
            id: "lineage-row-523-only",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView525.upsert(
          {
            ...baseRow,
            id: "lineage-row-525-only",
            updatedAt: 2,
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
      },
      U["523"],
      U["525"],
      "lineage-row-523-only",
      "lineage-row-525-only"
    )
  })

  it("524/526 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsExternalTransportReceiptAcknowledgmentsTbAckReconPdFreezeSealView524.upsert(
          {
            ...baseRow,
            id: "lineage-row-524-only",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView526.upsert(
          {
            ...baseRow,
            id: "lineage-row-526-only",
            updatedAt: 2,
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
      },
      U["524"],
      U["526"],
      "lineage-row-524-only",
      "lineage-row-526-only"
    )
  })

  it("525/527 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView525.upsert(
          {
            ...baseRow,
            id: "lineage-row-525-only",
            transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView527.upsert(
          {
            ...baseRow,
            id: "lineage-row-527-only",
            updatedAt: 2,
            externalDistributionAuditLedgerStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
          } as never
        )
      },
      U["525"],
      U["527"],
      "lineage-row-525-only",
      "lineage-row-527-only"
    )
  })

  it("526/528 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView526.upsert(
          {
            ...baseRow,
            id: "lineage-row-526-only",
            ackReconTransportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView528.upsert(
          {
            ...baseRow,
            id: "lineage-row-528-only",
            updatedAt: 2,
            partnerHandoffAttestationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
          } as never
        )
      },
      U["526"],
      U["528"],
      "lineage-row-526-only",
      "lineage-row-528-only"
    )
  })

  it("527/529 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView527.upsert(
          {
            ...baseRow,
            id: "lineage-row-527-only",
            externalDistributionAuditLedgerStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView529.upsert(
          {
            ...baseRow,
            id: "lineage-row-529-only",
            updatedAt: 2,
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
      },
      U["527"],
      U["529"],
      "lineage-row-527-only",
      "lineage-row-529-only"
    )
  })

  it("528/530 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView528.upsert(
          {
            ...baseRow,
            id: "lineage-row-528-only",
            partnerHandoffAttestationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView530.upsert(
          {
            ...baseRow,
            id: "lineage-row-530-only",
            updatedAt: 2,
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
      },
      U["528"],
      U["530"],
      "lineage-row-528-only",
      "lineage-row-530-only"
    )
  })

  it("529/531 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView529.upsert(
          {
            ...baseRow,
            id: "lineage-row-529-only",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsTbAckReconPdFreezeSealView531.upsert(
          {
            ...baseRow,
            id: "lineage-row-531-only",
            updatedAt: 2,
            externalDistributionAuditLedgerReconciliationClosureSealVerificationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_reconciliation_closure_seal_verification_pending",
          } as never
        )
      },
      U["529"],
      U["531"],
      "lineage-row-529-only",
      "lineage-row-531-only"
    )
  })

  it("530/532 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView530.upsert(
          {
            ...baseRow,
            id: "lineage-row-530-only",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsTbAckReconPdFreezeSealView532.upsert(
          {
            ...baseRow,
            id: "lineage-row-532-only",
            updatedAt: 2,
            partnerHandoffAttestationAcknowledgementSealVerificationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_acknowledgement_seal_verification_pending",
          } as never
        )
      },
      U["530"],
      U["532"],
      "lineage-row-530-only",
      "lineage-row-532-only"
    )
  })

  it("531/533 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsTbAckReconPdFreezeSealView531.upsert(
          {
            ...baseRow,
            id: "lineage-row-531-only",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_reconciliation_closure_seal_verification_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView533.upsert(
          {
            ...baseRow,
            id: "lineage-row-533-only",
            updatedAt: 2,
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
          } as never
        )
      },
      U["531"],
      U["533"],
      "lineage-row-531-only",
      "lineage-row-533-only"
    )
  })

  it("531/535 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsTbAckReconPdFreezeSealView531.upsert(
          {
            ...baseRow,
            id: "lineage-row-531-only",
            externalDistributionAuditLedgerReconciliationClosureSealVerificationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_reconciliation_closure_seal_verification_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView535.upsert(
          {
            ...baseRow,
            id: "lineage-row-535-only",
            updatedAt: 2,
            outboundRegistryAttestationLedgerStatus: "outbound_registry_attestation_ledger_pending",
          } as never
        )
      },
      U["531"],
      U["535"],
      "lineage-row-531-only",
      "lineage-row-535-only"
    )
  })

  it("535/537 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView535.upsert(
          {
            ...baseRow,
            id: "lineage-row-535-only",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView537.upsert(
          {
            ...baseRow,
            id: "lineage-row-537-only",
            updatedAt: 2,
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
      },
      U["535"],
      U["537"],
      "lineage-row-535-only",
      "lineage-row-537-only"
    )
  })

  it("537/539 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView537.upsert(
          {
            ...baseRow,
            id: "lineage-row-537-only",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView539.upsert(
          {
            ...baseRow,
            id: "lineage-row-539-only",
            updatedAt: 2,
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
      },
      U["537"],
      U["539"],
      "lineage-row-537-only",
      "lineage-row-539-only"
    )
  })

  it("532/534 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsTbAckReconPdFreezeSealView532.upsert(
          {
            ...baseRow,
            id: "lineage-row-532-only",
            partnerHandoffAttestationAcknowledgementSealVerificationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_acknowledgement_seal_verification_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersTbAckReconPdFreezeSealView534.upsert(
          {
            ...baseRow,
            id: "lineage-row-534-only",
            updatedAt: 2,
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
          } as never
        )
      },
      U["532"],
      U["534"],
      "lineage-row-532-only",
      "lineage-row-534-only"
    )
  })

  it("532/536 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsTbAckReconPdFreezeSealView532.upsert(
          {
            ...baseRow,
            id: "lineage-row-532-only",
            partnerHandoffAttestationAcknowledgementSealVerificationStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_acknowledgement_seal_verification_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView536.upsert(
          {
            ...baseRow,
            id: "lineage-row-536-only",
            updatedAt: 2,
            outboundRegistryAttestationLedgerStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_outbound_registry_attestation_ledger_pending",
          } as never
        )
      },
      U["532"],
      U["536"],
      "lineage-row-532-only",
      "lineage-row-536-only"
    )
  })

  it("536/538 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView536.upsert(
          {
            ...baseRow,
            id: "lineage-row-536-only",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView538.upsert(
          {
            ...baseRow,
            id: "lineage-row-538-only",
            updatedAt: 2,
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
      },
      U["536"],
      U["538"],
      "lineage-row-536-only",
      "lineage-row-538-only"
    )
  })

  it("538/540 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView538.upsert(
          {
            ...baseRow,
            id: "lineage-row-538-only",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView540.upsert(
          {
            ...baseRow,
            id: "lineage-row-540-only",
            updatedAt: 2,
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
      },
      U["538"],
      U["540"],
      "lineage-row-538-only",
      "lineage-row-540-only"
    )
  })

  it("539/541 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView539.upsert(
          {
            ...baseRow,
            id: "lineage-row-539-only",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView541.upsert(
          {
            ...baseRow,
            id: "lineage-row-541-only",
            updatedAt: 2,
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
      },
      U["539"],
      U["541"],
      "lineage-row-539-only",
      "lineage-row-541-only"
    )
  })

  it("540/542 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView540.upsert(
          {
            ...baseRow,
            id: "lineage-row-540-only",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView542.upsert(
          {
            ...baseRow,
            id: "lineage-row-542-only",
            updatedAt: 2,
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
      },
      U["540"],
      U["542"],
      "lineage-row-540-only",
      "lineage-row-542-only"
    )
  })

  it("541/543 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView541.upsert(
          {
            ...baseRow,
            id: "lineage-row-541-only",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView543.upsert(
          {
            ...baseRow,
            id: "lineage-row-543-only",
            updatedAt: 2,
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
      },
      U["541"],
      U["543"],
      "lineage-row-541-only",
      "lineage-row-543-only"
    )
  })

  it("542/544 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView542.upsert(
          {
            ...baseRow,
            id: "lineage-row-542-only",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView544.upsert(
          {
            ...baseRow,
            id: "lineage-row-544-only",
            updatedAt: 2,
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
      },
      U["542"],
      U["544"],
      "lineage-row-542-only",
      "lineage-row-544-only"
    )
  })

  it("543/545 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView543.upsert(
          {
            ...baseRow,
            id: "lineage-row-543-only",
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
        await repos.workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsReconciliationClosureSealVerificationOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView545.upsert(
          {
            ...baseRow,
            id: "lineage-row-545-only",
            updatedAt: 2,
            externalDistributionAuditLedgerReconciliationStatus:
              "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_reconciliation_pending",
          } as never
        )
      },
      U["543"],
      U["545"],
      "lineage-row-543-only",
      "lineage-row-545-only"
    )
  })

  it("544/546 GET returns only its lineage row", async () => {
    await seedAndGet(
      async (repos) => {
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView544.upsert(
          {
            ...baseRow,
            id: "lineage-row-544-only",
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
        await repos.workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsPartnerHandoffAttestationAcknowledgementSealVerificationOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView546.upsert(
          {
            ...baseRow,
            id: "lineage-row-546-only",
            updatedAt: 2,
            partnerHandoffAttestationAcknowledgementStatus:
              "ack_recon_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_acknowledgement_pending",
          } as never
        )
      },
      U["544"],
      U["546"],
      "lineage-row-544-only",
      "lineage-row-546-only"
    )
  })

})
