import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const REQUIRED_BATCH_F_ACTIONS = [
  "acknowledge_remediation_expiry",
  "snooze_remediation_expiry",
  "acknowledge_rollover_breach",
  "reaffirm_rollover_attestation",
  "acknowledge_rollover_reaffirmation_sla",
  "attest_remediation_closure",
  "assign_closure_followup",
  "claim_closure_followup",
  "resolve_closure_followup",
  "set_closure_sla_window_config",
  "set_closure_auto_assignment_rule",
  "auto_assign_closure_followup",
  "record_closure_attestation",
  "review_closure_attestation",
  "waive_closure_sla_exception",
  "open_closure_attestation_dispute",
  "resolve_closure_attestation_dispute",
  "tick_closure_sla_exception_enforcement",
  "escalate_closure_dispute_to_panel",
  "record_closure_adjudication_verdict",
  "rebalance_closure_enforcement_queue",
  "govern_closure_adjudication_quorum",
  "execute_closure_rebalance_owner_transfer",
  "execute_closure_rebalance_throttle_release",
  "extend_closure_adjudication_slo_deadline",
  "escalate_closure_adjudication_slo_tier",
  "acknowledge_closure_adjudication_slo_breach",
  "configure_closure_rebalance_auto_execution_safeguard",
  "attest_closure_rebalance_auto_execution_override",
  "record_closure_adjudication_slo_debt_remediation",
  "downshift_closure_adjudication_slo_tier",
  "attest_closure_adjudication_slo_breach_closure",
  "set_closure_rebalance_safeguard_override_expiry",
  "auto_clear_closure_rebalance_safeguard_suppression",
  "cleanup_stale_closure_rebalance_safeguard_lock",
] as const

const REQUIRED_BATCH_F_VIEWS = [
  "remediation_expiry_digests",
  "rollover_breach_watches",
  "remediation_lifecycle",
  "rollover_reaffirmation_sla",
  "closure_compliance_digests",
  "closure_followup_queue",
  "closure_sla_window_configs",
  "closure_auto_assignment_rules",
  "closure_sla_windows",
  "closure_attestations",
  "closure_sla_exception_digests",
  "closure_attestation_disputes",
  "closure_sla_exception_enforcement",
  "closure_adjudication_queue",
  "closure_enforcement_rebalance",
  "closure_adjudication_quorum",
  "closure_rebalance_execution",
  "closure_adjudication_slo",
  "closure_rebalance_safeguards",
  "closure_adjudication_slo_debt_remediation",
  "closure_rebalance_safeguard_expiry",
] as const

describe("Batch F frontend_real call-site coverage in /ops UI", () => {
  it("keeps Batch F #60-#69 action lattice wired", () => {
    const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

    for (const action of REQUIRED_BATCH_F_ACTIONS) {
      expect(source).toContain(`action: "${action}"`)
    }
  })

  it("keeps Batch F #60-#69 governance views wired", () => {
    const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

    for (const view of REQUIRED_BATCH_F_VIEWS) {
      expect(source).toContain(`view: "${view}"`)
    }
    expect(source).toContain("Run Batch F #60-#69 governance lattice")
  })
})
