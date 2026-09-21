import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

function sourceSliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe("Batch E frontend_real /ops lattice coverage", () => {
  it("keeps #48-#59 filing/escalation action call sites wired", () => {
    const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")
    const batchEActionSource = sourceSliceBetween(
      source,
      "async function runBatchEActionLattice()",
      "async function readBatchEGovernanceViews()"
    )

    const requiredActions = [
      "annexure_checkpoint",
      "record_submission_receipt",
      "reconcile_submission",
      "claim_submission_exception",
      "escalate_submission_exception",
      "resolve_submission_exception",
      "reopen_submission_exception",
      "mark_transport_blocked",
      "attach_retry_plan",
      "acknowledge_breach",
      "defer_window",
      "assign_primary_owner",
      "set_backup_owner",
      "acknowledge_owner_drift",
      "snooze_workload_alert",
      "rebalance_assignment",
      "set_policy_baseline",
      "grant_breach_waiver",
      "acknowledge_policy_variance",
      "snooze_policy_variance",
      "record_variance_remediation",
      "acknowledge_remediation_expiry",
      "snooze_remediation_expiry",
      "attest_remediation_closure",
      "acknowledge_waiver_expiry",
      "extend_breach_waiver",
      "acknowledge_rollover_breach",
      "reaffirm_rollover_attestation",
      "acknowledge_rollover_reaffirmation_sla",
      "acknowledge_handoff",
      "confirm_delivered",
      "clear_digest",
      "revoke_assignment",
      "revoke_breach_waiver",
    ]

    for (const action of requiredActions) {
      expect(batchEActionSource).toContain(`action: "${action}"`)
    }
  })

  it("keeps #48-#59 governance read views and buttons wired", () => {
    const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")
    const batchEViewsSource = sourceSliceBetween(
      source,
      "async function readBatchEGovernanceViews()",
      "async function runBatchFGovernanceLattice()"
    )

    const requiredViews = [
      "annexures",
      "submission_receipts",
      "submission_reconciliation",
      "submission_exceptions",
      "transport_execution",
      "submission_sla_digests",
      "escalation_owner_rota",
      "escalation_workload_digests",
      "escalation_policy_baselines",
      "breach_waiver_ledger",
      "policy_variance_digests",
      "waiver_expiry_digests",
      "variance_remediation_ledger",
      "waiver_rollover_attestations",
      "remediation_expiry_digests",
      "remediation_lifecycle",
      "rollover_breach_watches",
      "rollover_reaffirmation_sla",
    ]

    for (const view of requiredViews) {
      expect(batchEViewsSource).toContain(`view: "${view}"`)
    }

    expect(source).toContain("23) Batch E actions (#48-#59 filing/escalation lattice)")
    expect(source).toContain("24) Batch E views (#48-#59 governance reads)")
  })
})
