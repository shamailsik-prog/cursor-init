import { describe, expect, it, vi } from "vitest"
import { TB_ACK_RECON_LINEAGE_ISOLATION_GET_URL as U } from "./ops.pr-tb-ack-recon-lattice-urls"

/**
 * PR260-MAJOR-1 regression: lattice pairs 493/505, 494/506, 495/507, 496/508 must use
 * separate backing stores. Seed one row per lineage; each GET must return only its row.
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

describe("tb ack-recon lattice dedicated collection lineage isolation (493–496 vs 505–508)", () => {
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
})
