import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Behaviour fixes for /api/d2/ops-reporting defects found while typing the route
// (integration step 4). Each block failed before its fix.
process.env.SIKANDER_AUTH_MODE = process.env.SIKANDER_AUTH_MODE ?? "insecure-dev"

import { GET, POST } from "@/app/api/d2/ops-reporting/route"
import { opsReportingDiagnostics } from "@/app/api/d2/ops-reporting/dispatch"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"

type Json = Record<string, unknown>
type Row = Json & { id: string; matterId: string; provenanceTags?: string[] }

async function seedMatter(title: string): Promise<string> {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title,
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  const doc = await uploadDocument(store, {
    firmId: "firmA",
    matterId: matter.id,
    bytes: Buffer.from(`%PDF-${title}%`),
    sourceChannel: "web",
    classification: "internal",
    idempotencyKey: crypto.randomUUID(),
      uploadedBy: "partner_a",
  })
  recordCaseNumber(store, matter.id, "CP 1234", "SHC")
  const transition = await workflowPost(
    new Request("http://127.0.0.1/api/d1/document-workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        action: "transition",
        actorId: "associate_a",
        documentId: doc.docId,
        nextStatus: "processing",
      }),
    })
  )
  expect(transition.status).toBe(200)
  return matter.id
}

async function postAction(action: string, matterId: string, extra: Json = {}) {
  const res = await POST(
    new Request("http://127.0.0.1/api/d2/ops-reporting", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action, actorId: "partner_a", matterId, ...extra }),
    })
  )
  return { res, body: (await res.json()) as { error?: string; code?: string; result?: Json } }
}

function collection(name: string): Map<string, Row> {
  const map = (getRuntimeStore() as unknown as Record<string, unknown>)[name]
  if (!(map instanceof Map)) throw new Error(`no store collection ${name.slice(0, 60)}`)
  return map as Map<string, Row>
}

function rowsFor(name: string, matterId: string): Row[] {
  return [...collection(name).values()].filter((row) => row.matterId === matterId)
}

let onError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  onError = vi.spyOn(opsReportingDiagnostics, "onError").mockImplementation(() => {})
})
afterEach(() => {
  const crashes = onError.mock.calls
    .map(([err]) => err)
    .filter((err) => err instanceof TypeError || err instanceof ReferenceError)
  onError.mockRestore()
  expect(crashes).toEqual([])
})
beforeAll(() => resetRuntimeStoreForTests())
afterAll(() => resetRuntimeStoreForTests())

const ROUTE = path.resolve(__dirname, "../app/api/d2/ops-reporting/route.ts")
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…(${s.length})` : s)

// The POST preamble resolves each lattice row as
//   store.<K>.get(id) ?? governance.<seedArray>?.find(sameMatter) ?? repos.<K>.get(id)
// so a seed array used as the fallback for collection K must only hold rows the seed
// writes to K. Two 499/500 acknowledgment arrays held the *sibling* lineage's rows
// ("seal verifications" vs "seal verification"), so finalize/acknowledge could copy a
// sibling row, id and all, into its own collection whenever K had no row yet.
describe("ops-reporting governance fallbacks read only their own collection", () => {
  it("every governance seed array used as a fallback for K holds only rows written to K", () => {
    const text = readFileSync(ROUTE, "utf8")
    const sf = ts.createSourceFile(ROUTE, text, ts.ScriptTarget.Latest, true)
    const pushed = new Map<string, Set<string>>() // array -> pushed identifiers
    const writtenTo = new Map<string, Set<string>>() // identifier -> collections
    const consumed = new Map<string, Set<string>>() // array -> collections it backs
    const add = (m: Map<string, Set<string>>, k: string, v: string) => {
      if (!m.has(k)) m.set(k, new Set())
      m.get(k)!.add(v)
    }
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const meth = n.expression.name.text
        const obj = n.expression.expression
        const arg = n.arguments[meth === "set" ? 1 : 0]
        if (meth === "push" && ts.isIdentifier(obj) && arg && ts.isIdentifier(arg)) add(pushed, obj.text, arg.text)
        if (
          (meth === "upsert" || meth === "set") &&
          ts.isPropertyAccessExpression(obj) &&
          ["store", "repos"].includes(obj.expression.getText()) &&
          arg &&
          ts.isIdentifier(arg)
        )
          add(writtenTo, arg.text, obj.name.text)
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        const chain = n.getText(sf)
        const k = /^\s*store\s*\.\s*(\w+)\s*\.\s*get\(/.exec(chain)?.[1]
        const arr = /governance\s*\.\s*(\w+)\s*\?\.\s*find\(/.exec(chain)?.[1]
        if (k && arr) add(consumed, arr, k)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(consumed.size).toBeGreaterThan(4)
    const violations: string[] = []
    for (const [arr, backs] of consumed) {
      const cols = new Set([...(pushed.get(arr) ?? [])].flatMap((id) => [...(writtenTo.get(id) ?? [])]))
      for (const k of backs)
        for (const c of cols) if (c !== k) violations.push(`${short(arr)} backs ${short(k)} but holds ${short(c)} rows`)
    }
    expect(violations).toEqual([])
  })
})

// The 535/536 GET views parse a reconciliation / acknowledgement status filter but compared
// it with row.outboundRegistryAttestationLedgerStatus, a field these rows never carry, so
// any status filter returned an empty page.
const SEED_TRIGGER_ACTION =
  "control_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_finalization"
const STATUS_FILTER_VIEWS = [
  {
    label: "535 external distribution audit ledger reconciliation",
    view:
      "alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_disposition_publication_governance_external_distribution_audit_ledger_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_attestation_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_reconciliation_closure_seal_verifications_outbound_registry_attestation_ledgers_external_distribution_audit_ledger_reconciliations",
    collection:
      "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgersOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsExternalDistributionAuditLedgerReconciliationClosureSealVerificationsOutboundRegistryAttestationLedgersExternalDistributionAuditLedgerReconciliationsTbAckReconPdFreezeSealView535",
    statusField: "externalDistributionAuditLedgerReconciliationStatus",
    query: "externalDistributionAuditLedgerReconciliationStatus",
  },
  {
    label: "536 partner handoff attestation acknowledgement",
    view:
      "alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_compliance_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestations_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_partner_handoff_attestation_acknowledgement_seal_verifications_outbound_registry_attestation_ledgers_partner_handoff_attestation_acknowledgements",
    collection:
      "workflowOpsAlertVarianceRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationClosureAttestationExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationPartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsPartnerHandoffAttestationAcknowledgementSealVerificationsOutboundRegistryAttestationLedgersPartnerHandoffAttestationAcknowledgementsTbAckReconPdFreezeSealView536",
    statusField: "partnerHandoffAttestationAcknowledgementStatus",
    query: "partnerHandoffAttestationAcknowledgementStatus",
  },
] as const

describe("535/536 GET status filters match the rows' own status field", () => {
  it.each(STATUS_FILTER_VIEWS)("$label: filtering by a row's status returns that row", async (v) => {
    const matterId = await seedMatter(`status-filter-${v.label.slice(0, 3)}`)
    await postAction(SEED_TRIGGER_ACTION, matterId) // runs the governance seed
    const rows = rowsFor(v.collection, matterId)
    expect(rows.length).toBeGreaterThan(0)
    const status = String(rows[0]![v.statusField])
    const url = new URL("http://127.0.0.1/api/d2/ops-reporting")
    url.searchParams.set("view", v.view)
    url.searchParams.set("actorId", "partner_a")
    url.searchParams.set("matterId", matterId)
    url.searchParams.set(v.query, status)
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Row[] }
    expect(body.items.map((row) => row.id)).toContain(rows[0]!.id)
  })
})

// Finalize / acknowledge actions checked the existing child row but not the parent row
// their builder dereferences, so a missing parent crashed the handler (TypeError ->
// generic 400). The POST preamble rebuilds the parent chain through the governance seed
// before these lookups, so a missing parent cannot be produced through the API in memory
// mode (it can in Firestore mode, where the repository read may miss); the six actions are
// checked on the source: each guards its parent before the builder and answers 409
// parent_missing. `tsc` (strictNullChecks, enforced in CI) rejects any other unguarded parent.
const PARENT_GUARDED_ACTIONS = [
  {
    action:
      "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt",
    parent:
      "currentWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliation",
  },
  {
    action:
      "acknowledge_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt",
    parent:
      "currentRemediationSlaBreachResolutionCheckpointExpiryAttestationQueueReentryComplianceDebtRetirementDisputeReconciliationClosureVerificationArchivalExportPartnerDeliveryTransportBoundaryReceiptReconciliationPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliation",
  },
  {
    action:
      "control_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_finalization",
    parent:
      "currentTbAckReconPdFreezeSeal507WaiverPartnerDeliveryReceiptFreezeOverrideSealVerification",
  },
  {
    action:
      "attest_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_closure",
    parent:
      "currentTbAckReconPdFreezeSeal508VariancePartnerDeliveryReceiptFreezeOverrideSealVerification",
  },
  {
    action:
      "acknowledge_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt",
    parent:
      "currentTbAckReconPdFreezeSeal509WaiverTransportBoundaryReceiptReconciliation",
  },
  {
    action:
      "acknowledge_workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_external_transport_receipt",
    parent:
      "currentTbAckReconPdFreezeSeal510VarianceTransportBoundaryReceiptReconciliation",
  },
] as const

describe("finalize/acknowledge actions guard their parent row", () => {
  it.each(PARENT_GUARDED_ACTIONS.map((c, i) => ({ ...c, i })))("action $i answers 409 parent_missing before dereferencing its parent", (c) => {
    const text = readFileSync(ROUTE, "utf8")
    const sf = ts.createSourceFile(ROUTE, text, ts.ScriptTarget.Latest, true)
    let branch: ts.IfStatement | undefined
    const walk = (n: ts.Node) => {
      if (
        !branch &&
        ts.isIfStatement(n) &&
        ts.isBinaryExpression(n.expression) &&
        n.expression.left.getText(sf) === "parsed.action" &&
        ts.isStringLiteral(n.expression.right) &&
        n.expression.right.text === c.action
      )
        branch = n
      ts.forEachChild(n, walk)
    }
    walk(sf)
    if (!branch) throw new Error(`branch ${c.i} not found`)
    const body = branch.thenStatement.getText(sf)
    const guard = body.search(new RegExp(`if \\(!${c.parent}\\) \\{\\s*return errorResponse\\(\\s*409,\\s*"parent_missing"`))
    const use = body.search(new RegExp(`:\\s*${c.parent},`))
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(use).toBeGreaterThan(guard)
  })
})

// 527 finalize compared the ledger status with a literal no builder writes
// ("…reconciliations_external_distribution_audit_ledgers_…_entry_recorded"), so it
// always answered 400. The builder writes "…_external_distribution_audit_ledger_entry_recorded".
const LEDGER_527 = {
  parentCollection:
    "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementArbitrationDispositionPublicationGovernanceExternalDistributionAuditLedgerPartnerHandoffAttestationOutboundRegistryAttestationLedgerPartnerDeliveryReceiptFreezeOverrideSealVerificationArchivalExportCustodyHandoffExternalTransportReceiptAcknowledgmentReconciliationExternalDistributionAuditLedgerPartnerHandoffAttestationPartnerDeliveryReceiptFreezeOverrideSealVerificationsTransportBoundaryReceiptReconciliationsExternalTransportReceiptAcknowledgmentReconciliationsTbAckReconPdFreezeSealView525",
  parentStatusField:
    "transportBoundaryReceiptReconciliationExternalTransportReceiptAcknowledgmentReconciliationStatus",
  parentFinalized:
    "transport_boundary_receipt_reconciliation_external_transport_receipt_acknowledgment_reconciliation_finalized",
  checkpointAction:
    "checkpoint_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger",
  recordAction:
    "record_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_entry",
  finalizeAction:
    "control_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_arbitration_external_distribution_archival_export_custody_handoff_external_transport_receipt_acknowledgment_reconciliation_external_distribution_audit_ledger_partner_handoff_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgment_reconciliations_external_distribution_audit_ledger_finalization",
} as const

describe("527 external distribution audit ledger finalize", () => {
  it("succeeds after the ledger entry is recorded", async () => {
    const matterId = await seedMatter("ledger-527")
    await postAction(LEDGER_527.checkpointAction, matterId) // runs the governance seed
    for (const row of rowsFor(LEDGER_527.parentCollection, matterId))
      row[LEDGER_527.parentStatusField] = LEDGER_527.parentFinalized
    const checkpoint = await postAction(LEDGER_527.checkpointAction, matterId)
    const record = await postAction(LEDGER_527.recordAction, matterId)
    const finalize = await postAction(LEDGER_527.finalizeAction, matterId)
    expect(checkpoint.res.status).toBe(200)
    expect(record.res.status).toBe(200)
    expect(finalize.res.status).toBe(200)
  })
})
