import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Behavioural dispatch coverage for /api/d2/ops-reporting (not a source grep):
// - every allowlisted POST action reaches a handler without a programming error,
// - every not-implemented action answers 501,
// - actions that reach a write, write their own collection with a parent row of the same matter,
// - no action other than an escalation action changes the matter's escalation status,
// - every accepted GET view reaches a handler that answers with that same view name.
process.env.SIKANDER_AUTH_MODE = process.env.SIKANDER_AUTH_MODE ?? "insecure-dev"

import { GET, POST } from "@/app/api/d2/ops-reporting/route"
import {
  OPS_GET_VIEWS,
  OPS_NOT_IMPLEMENTED_ACTIONS,
  OPS_POST_ACTIONS,
  opsReportingDiagnostics,
} from "@/app/api/d2/ops-reporting/dispatch"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"

type Json = Record<string, unknown>

function label(i: number, name: string) {
  return `#${i} ${name.length > 72 ? `${name.slice(0, 72)}…(${name.length})` : name}`
}

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
  // Same seed as tests/api.ops-reporting.test.ts: workflow activity so the POST preamble
  // can build the matter's alert digest and governance rows and reach the action handlers.
  const doc = uploadDocument(store, {
    firmId: "firmA",
    matterId: matter.id,
    bytes: Buffer.from(`%PDF-${title}%`),
    sourceChannel: "web",
    classification: "internal",
    idempotencyKey: crypto.randomUUID(),
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
  return { res, body: (await res.json()) as { error?: string; action?: string; result?: Json } }
}

function storeMaps(): Array<[string, Map<string, Json>]> {
  const store = getRuntimeStore() as unknown as Record<string, unknown>
  return Object.keys(store)
    .filter((k) => store[k] instanceof Map)
    .map((k) => [k, store[k] as Map<string, Json>])
}

function escalationStatuses(matterId: string, only?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of getRuntimeStore().workflowOpsAlertEscalationLedgers.values()) {
    if (row.matterId === matterId && (!only || row.id in only)) out[row.id] = row.escalationStatus
  }
  return out
}

// Programming errors are detected through the route's server-side error hook, not through
// the response text (which the auth stream sanitises).
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

beforeAll(() => {
  resetRuntimeStoreForTests()
})

afterAll(() => {
  resetRuntimeStoreForTests()
})

describe("ops-reporting dispatch tables", () => {
  it("have no duplicate entries and do not overlap", () => {
    expect(new Set(OPS_POST_ACTIONS).size).toBe(OPS_POST_ACTIONS.length)
    expect(new Set(OPS_GET_VIEWS).size).toBe(OPS_GET_VIEWS.length)
    expect(new Set(OPS_NOT_IMPLEMENTED_ACTIONS).size).toBe(OPS_NOT_IMPLEMENTED_ACTIONS.length)
    const allowed = new Set<string>(OPS_POST_ACTIONS)
    expect(OPS_NOT_IMPLEMENTED_ACTIONS.filter((a) => allowed.has(a))).toEqual([])
  })

  it("still rejects actions outside both tables with 400 unknown action", async () => {
    const { res, body } = await postAction("not_a_real_ops_action", "matter_does_not_matter")
    expect(res.status).toBe(400)
    expect(body.error).toBe("unknown action")
  })

  it("still rejects views outside the view table with 400", async () => {
    const res = await GET(
      new Request("http://127.0.0.1/api/d2/ops-reporting?view=not_a_real_ops_view&actorId=associate_a")
    )
    expect(res.status).toBe(400)
  })
})

describe("POST /api/d2/ops-reporting: not-implemented actions answer 501", () => {
  let matterId = ""
  beforeAll(async () => {
    matterId = await seedMatter("ops-dispatch-not-implemented")
  })

  it.each(OPS_NOT_IMPLEMENTED_ACTIONS.map((action, i) => [label(i, action), action] as const))(
    "%s",
    async (_label, action) => {
      const before = escalationStatuses(matterId)
      const { res, body } = await postAction(action, matterId)
      expect(res.status).toBe(501)
      expect(body).toEqual({ error: "not_implemented", action })
      expect(escalationStatuses(matterId, before)).toEqual(before)
    }
  )
})

// Actions that get past validation to a write with a minimal body. Each must write its row
// into exactly this collection (and nowhere else), under the seeded matter, and every parent
// link on the row must point at an existing row of the same matter.
const WRITE_TARGETS: ReadonlyArray<readonly [action: string, resultKey: string, collection: string, parentField: string | null]> = [
  ["acknowledge_workflow_ops_alert_digest", "digest", "workflowOpsAlertDigests", null],
  ["attest_workflow_ops_alert_digest", "attestation", "workflowOpsAlertAttestations", "alertDigestId"],
  ["open_workflow_ops_alert_escalation", "escalation", "workflowOpsAlertEscalationLedgers", "alertDigestId"],
  ["resolve_workflow_ops_alert_escalation", "escalation", "workflowOpsAlertEscalationLedgers", "alertDigestId"],
  ["open_workflow_ops_alert_attestation_dispute", "attestation", "workflowOpsAlertAttestations", "alertDigestId"],
  ["checkpoint_workflow_ops_alert_escalation_closure", "closure", "workflowOpsAlertEscalationClosures", "alertEscalationLedgerId"],
  ["close_workflow_ops_alert_escalation_closure", "escalation", "workflowOpsAlertEscalationLedgers", "alertDigestId"],
  ["reopen_workflow_ops_alert_escalation_closure", "escalation", "workflowOpsAlertEscalationLedgers", "alertDigestId"],
  ["waive_workflow_ops_alert_dispute_enforcement", "dispute", "workflowOpsAlertAttestationDisputes", "alertAttestationId"],
  ["flag_workflow_ops_alert_closure_reopen_debt", "closure", "workflowOpsAlertEscalationClosures", "alertEscalationLedgerId"],
  ["resolve_workflow_ops_alert_closure_debt_reconciliation", "closure", "workflowOpsAlertEscalationClosures", "alertEscalationLedgerId"],
  ["attest_workflow_ops_alert_dispute_enforcement", "enforcement", "workflowOpsAlertDisputeEnforcementLedgers", "alertAttestationDisputeId"],
  ["reopen_workflow_ops_alert_dispute_enforcement_attestation", "enforcement", "workflowOpsAlertDisputeEnforcementLedgers", "alertAttestationDisputeId"],
  ["open_workflow_ops_alert_closure_debt_variance", "reconciliation", "workflowOpsAlertClosureDebtReconciliationDigests", "alertEscalationClosureId"],
  ["resolve_workflow_ops_alert_closure_debt_variance", "reconciliation", "workflowOpsAlertClosureDebtReconciliationDigests", "alertEscalationClosureId"],
  ["waive_workflow_ops_alert_enforcement_waiver", "enforcement", "workflowOpsAlertDisputeEnforcementLedgers", "alertAttestationDisputeId"],
  ["queue_workflow_ops_alert_variance_remediation", "variance", "workflowOpsAlertClosureDebtVarianceDigests", "closureDebtReconciliationDigestId"],
  ["resolve_workflow_ops_alert_variance_remediation", "variance", "workflowOpsAlertClosureDebtVarianceDigests", "closureDebtReconciliationDigestId"],
  ["resolve_workflow_ops_alert_variance_remediation_sla_ledger", "remediationQueue", "workflowOpsAlertVarianceRemediationQueues", "closureDebtVarianceDigestId"],
  [
    "safeguard_workflow_ops_alert_waiver_expiry_dispute_adjudication_slo_debt_burndown_settlement_dispute_reopen",
    "waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestation",
    "workflowOpsAlertWaiverExpiryDisputeAdjudicationSloDebtBurndownSettlementAttestations",
    "waiverExpiryDisputeAdjudicationSloDebtBurndownSettlementId",
  ],
]

describe("POST /api/d2/ops-reporting: writes land in the handler's own collection", () => {
  let matterId = ""
  beforeAll(async () => {
    matterId = await seedMatter("ops-dispatch-write-targets")
  })

  it("covers only allowlisted actions, in dispatch order", () => {
    const order = WRITE_TARGETS.map(([action]) => (OPS_POST_ACTIONS as readonly string[]).indexOf(action))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it.each(WRITE_TARGETS.map(([action, ...rest], i) => [label(i, action), action, ...rest] as const))(
    "%s",
    async (_label, action, resultKey, collection, parentField) => {
      const sets: Array<[string, string]> = []
      const spies = storeMaps().map(([name, map]) => {
        const original = map.set.bind(map)
        const spy = vi.spyOn(map, "set").mockImplementation((key: string, value: Json) => {
          sets.push([name, key])
          return original(key, value)
        })
        return spy
      })
      let res: Response
      let body: { error?: string; result?: Json }
      try {
        ;({ res, body } = await postAction(action, matterId))
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
      expect(body.error).toBeUndefined()
      expect(res.status).toBe(200)
      const row = body.result?.[resultKey] as Json | undefined
      expect(row).toBeDefined()
      expect(row!.matterId).toBe(matterId)
      const writtenTo = [...new Set(sets.filter(([, key]) => key === row!.id).map(([name]) => name))]
      expect(writtenTo).toEqual([collection])

      const parentFields = Object.keys(row!).filter(
        (k) => /Id$/.test(k) && k !== "id" && k !== "firmId" && k !== "matterId" && !/owner|reviewer/i.test(k)
      )
      expect(parentFields).toEqual(parentField ? [parentField] : [])
      if (parentField) {
        const parentId = row![parentField]
        const holders = storeMaps().filter(([, map]) => map.has(parentId as string))
        expect(holders.length).toBe(1)
        expect(holders[0]![1].get(parentId as string)!.matterId).toBe(matterId)
      }
    }
  )
})

describe("POST /api/d2/ops-reporting: every allowlisted action reaches a handler without crashing", () => {
  let matterId = ""
  beforeAll(async () => {
    matterId = await seedMatter("ops-dispatch-sweep")
  })

  it.each(OPS_POST_ACTIONS.map((action, i) => [label(i, action), action] as const))(
    "%s",
    async (_label, action) => {
      const before = escalationStatuses(matterId)
      const { res, body } = await postAction(action, matterId)
      expect(res.status).toBeLessThan(500)
      expect(body.error).not.toBe("unknown action")
      // The shared preamble must let the request through to the action handler.
      expect(body.error).not.toBe("no alert digest exists for matter")
      expect(body.error).not.toBe("alert governance rows are unavailable for matter")
      if (!/_escalation(_|$)/.test(action)) {
        expect(escalationStatuses(matterId, before)).toEqual(before)
      }
    },
    30_000
  )
})

// Regression for the stray escalation-resolve block on 303caae: the three plural
// "...seal_verifications..." closure actions sent by the /ops console fell through to
// code that resolved the matter's escalation ledger.
describe("POST /api/d2/ops-reporting: plural closure actions never touch the escalation ledger", () => {
  const SHARED =
    "workflow_ops_alert_variance_remediation_sla_breach_resolution_checkpoint_expiry_attestation_queue_reentry_debt_retirement_dispute_reconciliation_closure_verification_archival_export_partner_delivery_transport_boundary_receipt_reconciliation_closure_attestation_external_transport_receipt_acknowledgment_reconciliation_partner_handoff_attestation_outbound_registry_attestation_ledger_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliation_closure"
  const PLURAL_ACTIONS = [
    `checkpoint_${SHARED}_attestation_digest`,
    `attest_${SHARED}`,
    `control_${SHARED}_attestation_finalization`,
  ]

  it.each(PLURAL_ACTIONS.map((action, i) => [label(i, action), action] as const))(
    "%s",
    async (_label, action) => {
      const known = new Set<string>([...OPS_POST_ACTIONS, ...OPS_NOT_IMPLEMENTED_ACTIONS])
      expect(known.has(action)).toBe(true)
      const matterId = await seedMatter(`ops-dispatch-plural-${action.slice(0, 8)}`)
      const opened = await postAction("open_workflow_ops_alert_escalation", matterId)
      expect(opened.res.status).toBe(200)
      const before = escalationStatuses(matterId)
      expect(Object.values(before)).not.toContain("resolved")

      const { body } = await postAction(action, matterId)
      expect(body.result?.escalation).toBeUndefined()
      expect(escalationStatuses(matterId, before)).toEqual(before)
    },
    30_000
  )
})

describe("GET /api/d2/ops-reporting: every accepted view reaches its own handler", () => {
  beforeAll(async () => {
    await seedMatter("ops-dispatch-get")
  })

  it.each(OPS_GET_VIEWS.map((view, i) => [label(i, view), view] as const))(
    "%s",
    async (_label, view) => {
      const params = new URLSearchParams({ view, actorId: "associate_a", limit: "5", cursor: "0" })
      const res = await GET(new Request(`http://127.0.0.1/api/d2/ops-reporting?${params.toString()}`))
      const body = (await res.json()) as { view?: string; error?: string }
      expect(res.status).toBe(200)
      expect(body.view).toBe(view)
    },
    30_000
  )
})
