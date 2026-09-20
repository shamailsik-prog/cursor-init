import { NextResponse } from "next/server"
import {
  IdempotencyCache,
  IdempotencyError,
  requireIdempotencyKey,
} from "@/platform/http/idempotency"
import { isClassification } from "@/platform/p1/types"
import { rankOf } from "@/platform/spine/store"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { syncFirmMembers } from "@/platform/persistence/memberSync"
import { persistAuditEntriesSince } from "@/platform/persistence/auditWriteThrough"
import { buildFilingPacketArtifactRow } from "@/platform/persistence/filingPacketArtifacts"
import {
  buildFilingDispatchQueueRow,
  filingDispatchQueueId,
  isFilingDispatchQueueStatus,
} from "@/platform/persistence/filingDispatchQueue"
import {
  annexureReadyForTransport,
  buildFilingAnnexureRow,
  filingAnnexureId,
  isFilingAnnexureGenerationStatus,
} from "@/platform/persistence/filingAnnexures"
import {
  buildFilingSubmissionReceiptRow,
  buildFilingSubmissionReconciliationRow,
  filingSubmissionReconciliationId,
  isFilingSubmissionCourtChannel,
  isFilingSubmissionDispatchOutcome,
  isFilingSubmissionReconciliationStatus,
} from "@/platform/persistence/filingSubmissionReceipts"
import {
  buildSubmissionExceptionRowFromFailure,
  filingSubmissionExceptionId,
  isFilingSubmissionExceptionSeverity,
  isFilingSubmissionExceptionStatus,
} from "@/platform/persistence/filingSubmissionExceptions"
import {
  buildFilingTransportExecutionEvidenceRow,
  isFilingTransportExecutionChannel,
  isFilingTransportExecutionOutcome,
} from "@/platform/persistence/filingTransportExecutionEvidence"
import {
  buildSubmissionSlaDigestRow,
  filingSubmissionSlaDigestId,
  isFilingSubmissionSlaDigestStatus,
} from "@/platform/persistence/filingSubmissionSlaDigests"
import {
  buildFilingEscalationOwnerRotaRow,
  filingEscalationOwnerRotaId,
  isFilingEscalationOwnerRotaStatus,
} from "@/platform/persistence/filingEscalationOwnerRota"
import {
  buildFilingEscalationWorkloadDigestRow,
  filingEscalationWorkloadDigestId,
  isFilingEscalationHandoffLagBucket,
  isFilingEscalationWorkloadDigestStatus,
} from "@/platform/persistence/filingEscalationWorkloadDigests"
import {
  buildFilingEscalationPolicyBaselineRow,
  buildFilingEscalationWaiverLedgerRow,
  DEFAULT_ESCALATION_HANDOFF_SLA_MS,
  DEFAULT_ESCALATION_OWNER_LOAD_THRESHOLD,
  DEFAULT_ESCALATION_WAIVER_WINDOW_MS,
  filingEscalationPolicyBaselineId,
  isFilingEscalationPolicyBaselineScope,
  isFilingEscalationWaiverStatus,
} from "@/platform/persistence/filingEscalationPolicyWaivers"
import {
  buildFilingEscalationPolicyVarianceDigestRow,
  buildFilingEscalationWaiverExpiryDigestRow,
  filingEscalationPolicyVarianceDigestId,
  filingEscalationWaiverExpiryDigestId,
  isFilingEscalationPolicyVarianceDigestStatus,
  isFilingEscalationWaiverExpiryDigestStatus,
} from "@/platform/persistence/filingEscalationGovernanceDigests"
import {
  buildFilingEscalationVarianceRemediationRow,
  buildFilingEscalationWaiverRolloverAttestationRow,
  isFilingEscalationVarianceRemediationDecision,
  isFilingEscalationVarianceRemediationStatus,
  isFilingEscalationWaiverRolloverStatus,
} from "@/platform/persistence/filingEscalationRemediationLedger"
import {
  buildFilingEscalationRemediationLifecycleRow,
  buildFilingEscalationRolloverReaffirmationSlaRow,
  filingEscalationRolloverReaffirmationSlaId,
  isFilingEscalationRemediationClosureOutcome,
  isFilingEscalationRemediationLifecycleStatus,
  isFilingEscalationRolloverReaffirmationSlaStatus,
  remediationStatusFromClosureOutcome,
  requiresSecondApproverForRemediationDecision,
} from "@/platform/persistence/filingEscalationLifecycleAndReaffirmation"
import {
  buildFilingEscalationRemediationExpiryDigestRow,
  buildFilingEscalationRolloverBreachWatchRow,
  filingEscalationRemediationExpiryDigestId,
  filingEscalationRolloverBreachWatchId,
  isFilingEscalationRemediationExpiryDigestStatus,
  isFilingEscalationRolloverBreachWatchStatus,
} from "@/platform/persistence/filingEscalationExpiryAndWatchDigests"
import { checkPermission } from "@/platform/p5/checkPermission"
import {
  createFilingPackage,
  decideFilingPackage,
} from "@/services/d4-3/filingPackage"

const idempotency = new IdempotencyCache<unknown>(24 * 60 * 60 * 1000, 1000)
const HOUR_MS = 60 * 60 * 1000

type CreateBody = {
  action: "create_package"
  actorId?: string
  matterId?: string
  draftId?: string
  classification?: string
  citedJudgmentIds?: string[]
  temporalCitations?: Array<{
    sectionId: string
    offenceDate: string
    usedText: string
  }>
  partnerOverride?: {
    partnerId?: string
    reason?: string
  }
}

type DecideBody = {
  action: "decide_package"
  actorId?: string
  packageId?: string
  decision?: "approve" | "reject"
  reason?: string
}

type DispatchUpdateBody = {
  action: "dispatch_update"
  actorId?: string
  packageId?: string
  nextStatus?: "queued" | "in_progress" | "retry_pending" | "handoff_ready" | "blocked"
  assigneeId?: string | null
  note?: string
  markAttempt?: boolean
}

type AnnexureCheckpointBody = {
  action: "annexure_checkpoint"
  actorId?: string
  packageId?: string
  checkpoint?:
    | "mark_assembling"
    | "mark_artifact_ready"
    | "record_partner_signoff"
    | "record_clerk_verification"
    | "mark_ready_for_transport"
  artifactId?: string
  note?: string
}

type RecordSubmissionReceiptBody = {
  action: "record_submission_receipt"
  actorId?: string
  packageId?: string
  courtChannel?: "efiling_portal_stub" | "physical_counter_stub" | "courier_stub"
  dispatchOutcome?: "accepted" | "rejected" | "retry_scheduled"
  submissionReference?: string
  failureReason?: string
  retryHint?: string
  note?: string
}

type ReconcileSubmissionBody = {
  action: "reconcile_submission"
  actorId?: string
  packageId?: string
  status?: "open" | "reconciled" | "needs_retry"
  note?: string
}

type ClaimSubmissionExceptionBody = {
  action: "claim_submission_exception"
  actorId?: string
  packageId?: string
  note?: string
}

type EscalateSubmissionExceptionBody = {
  action: "escalate_submission_exception"
  actorId?: string
  packageId?: string
  escalationOwnerId?: string
  severity?: "medium" | "high" | "critical"
  slaHours?: number
  note?: string
}

type ResolveSubmissionExceptionBody = {
  action: "resolve_submission_exception"
  actorId?: string
  packageId?: string
  note?: string
}

type ReopenSubmissionExceptionBody = {
  action: "reopen_submission_exception"
  actorId?: string
  packageId?: string
  severity?: "medium" | "high" | "critical"
  note?: string
}

type MarkTransportBlockedBody = {
  action: "mark_transport_blocked"
  actorId?: string
  packageId?: string
  transportChannel?:
    | "efiling_portal_stub"
    | "physical_counter_stub"
    | "courier_stub"
    | "operator_followup_stub"
  channelPayloadHash?: string
  blockerTags?: string[]
  attachmentPointers?: string[]
  severity?: "medium" | "high" | "critical"
  note?: string
}

type AttachRetryPlanBody = {
  action: "attach_retry_plan"
  actorId?: string
  packageId?: string
  transportChannel?:
    | "efiling_portal_stub"
    | "physical_counter_stub"
    | "courier_stub"
    | "operator_followup_stub"
  channelPayloadHash?: string
  attachmentPointers?: string[]
  note?: string
}

type ConfirmDeliveredBody = {
  action: "confirm_delivered"
  actorId?: string
  packageId?: string
  transportChannel?:
    | "efiling_portal_stub"
    | "physical_counter_stub"
    | "courier_stub"
    | "operator_followup_stub"
  channelPayloadHash?: string
  attachmentPointers?: string[]
  relatedReceiptId?: string
  note?: string
}

type AcknowledgeBreachBody = {
  action: "acknowledge_breach"
  actorId?: string
  packageId?: string
  note?: string
}

type DeferWindowBody = {
  action: "defer_window"
  actorId?: string
  packageId?: string
  deferHours?: number
  note?: string
}

type ClearDigestBody = {
  action: "clear_digest"
  actorId?: string
  packageId?: string
  note?: string
}

type AssignPrimaryOwnerBody = {
  action: "assign_primary_owner"
  actorId?: string
  packageId?: string
  primaryOwnerId?: string
  activeWindowHours?: number
  note?: string
}

type SetBackupOwnerBody = {
  action: "set_backup_owner"
  actorId?: string
  packageId?: string
  backupOwnerId?: string
  note?: string
}

type AcknowledgeHandoffBody = {
  action: "acknowledge_handoff"
  actorId?: string
  packageId?: string
  note?: string
}

type RevokeAssignmentBody = {
  action: "revoke_assignment"
  actorId?: string
  packageId?: string
  note?: string
}

type AcknowledgeOwnerDriftBody = {
  action: "acknowledge_owner_drift"
  actorId?: string
  packageId?: string
  note?: string
}

type RebalanceAssignmentBody = {
  action: "rebalance_assignment"
  actorId?: string
  packageId?: string
  newPrimaryOwnerId?: string
  note?: string
}

type SnoozeWorkloadAlertBody = {
  action: "snooze_workload_alert"
  actorId?: string
  packageId?: string
  snoozeHours?: number
  note?: string
}

type SetPolicyBaselineBody = {
  action: "set_policy_baseline"
  actorId?: string
  packageId?: string
  ownerLoadThreshold?: number
  handoffSlaHours?: number
  waiverWindowHours?: number
  note?: string
}

type GrantBreachWaiverBody = {
  action: "grant_breach_waiver"
  actorId?: string
  packageId?: string
  durationHours?: number
  reason?: string
  note?: string
}

type RevokeBreachWaiverBody = {
  action: "revoke_breach_waiver"
  actorId?: string
  packageId?: string
  waiverId?: string
  note?: string
}

type AcknowledgePolicyVarianceBody = {
  action: "acknowledge_policy_variance"
  actorId?: string
  packageId?: string
  note?: string
}

type SnoozePolicyVarianceBody = {
  action: "snooze_policy_variance"
  actorId?: string
  packageId?: string
  snoozeHours?: number
  note?: string
}

type AcknowledgeWaiverExpiryBody = {
  action: "acknowledge_waiver_expiry"
  actorId?: string
  packageId?: string
  note?: string
}

type ExtendBreachWaiverBody = {
  action: "extend_breach_waiver"
  actorId?: string
  packageId?: string
  waiverId?: string
  extendHours?: number
  secondApproverId?: string
  rolloverJustification?: string
  rolloverNote?: string
  note?: string
}

type RecordVarianceRemediationBody = {
  action: "record_variance_remediation"
  actorId?: string
  packageId?: string
  decision?: string
  justification?: string
  expiresInHours?: number
  secondApproverId?: string
  note?: string
}

type AcknowledgeRemediationExpiryBody = {
  action: "acknowledge_remediation_expiry"
  actorId?: string
  packageId?: string
  note?: string
}

type SnoozeRemediationExpiryBody = {
  action: "snooze_remediation_expiry"
  actorId?: string
  packageId?: string
  snoozeHours?: number
  note?: string
}

type AcknowledgeRolloverBreachBody = {
  action: "acknowledge_rollover_breach"
  actorId?: string
  packageId?: string
  note?: string
}

type ReaffirmRolloverAttestationBody = {
  action: "reaffirm_rollover_attestation"
  actorId?: string
  packageId?: string
  waiverId?: string
  note?: string
}

type AttestRemediationClosureBody = {
  action: "attest_remediation_closure"
  actorId?: string
  packageId?: string
  remediationId?: string
  closureOutcome?: string
  note?: string
}

type AcknowledgeRolloverReaffirmationSlaBody = {
  action: "acknowledge_rollover_reaffirmation_sla"
  actorId?: string
  packageId?: string
  note?: string
}

type Body =
  | CreateBody
  | DecideBody
  | DispatchUpdateBody
  | AnnexureCheckpointBody
  | RecordSubmissionReceiptBody
  | ReconcileSubmissionBody
  | ClaimSubmissionExceptionBody
  | EscalateSubmissionExceptionBody
  | ResolveSubmissionExceptionBody
  | ReopenSubmissionExceptionBody
  | MarkTransportBlockedBody
  | AttachRetryPlanBody
  | ConfirmDeliveredBody
  | AcknowledgeBreachBody
  | DeferWindowBody
  | ClearDigestBody
  | AssignPrimaryOwnerBody
  | SetBackupOwnerBody
  | AcknowledgeHandoffBody
  | RevokeAssignmentBody
  | AcknowledgeOwnerDriftBody
  | RebalanceAssignmentBody
  | SnoozeWorkloadAlertBody
  | SetPolicyBaselineBody
  | GrantBreachWaiverBody
  | RevokeBreachWaiverBody
  | AcknowledgePolicyVarianceBody
  | SnoozePolicyVarianceBody
  | AcknowledgeWaiverExpiryBody
  | ExtendBreachWaiverBody
  | RecordVarianceRemediationBody
  | AcknowledgeRemediationExpiryBody
  | SnoozeRemediationExpiryBody
  | AcknowledgeRolloverBreachBody
  | ReaffirmRolloverAttestationBody
  | AttestRemediationClosureBody
  | AcknowledgeRolloverReaffirmationSlaBody

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 25
  if (!Number.isFinite(parsed) || parsed < 1) return 25
  return Math.min(parsed, 100)
}

function parseCursor(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 0
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

function parseReadiness(value: string | null): "ready" | "blocked" | undefined {
  if (value === "ready" || value === "blocked") return value
  return undefined
}

function parseFilingsView(
  value: string | null
):
  | "packages"
  | "dispatch"
  | "annexures"
  | "submission_receipts"
  | "submission_reconciliation"
  | "submission_exceptions"
  | "transport_execution"
  | "submission_sla_digests"
  | "escalation_owner_rota"
  | "escalation_workload_digests"
  | "escalation_policy_baselines"
  | "breach_waiver_ledger"
  | "policy_variance_digests"
  | "waiver_expiry_digests"
  | "variance_remediation_ledger"
  | "waiver_rollover_attestations"
  | "remediation_expiry_digests"
  | "rollover_breach_watches"
  | "remediation_lifecycle"
  | "rollover_reaffirmation_sla" {
  if (value === "dispatch") return "dispatch"
  if (value === "annexures") return "annexures"
  if (value === "submission_receipts") return "submission_receipts"
  if (value === "submission_reconciliation") return "submission_reconciliation"
  if (value === "submission_exceptions") return "submission_exceptions"
  if (value === "transport_execution") return "transport_execution"
  if (value === "submission_sla_digests") return "submission_sla_digests"
  if (value === "escalation_owner_rota") return "escalation_owner_rota"
  if (value === "escalation_workload_digests") return "escalation_workload_digests"
  if (value === "escalation_policy_baselines") return "escalation_policy_baselines"
  if (value === "breach_waiver_ledger") return "breach_waiver_ledger"
  if (value === "policy_variance_digests") return "policy_variance_digests"
  if (value === "waiver_expiry_digests") return "waiver_expiry_digests"
  if (value === "variance_remediation_ledger") return "variance_remediation_ledger"
  if (value === "waiver_rollover_attestations") return "waiver_rollover_attestations"
  if (value === "remediation_expiry_digests") return "remediation_expiry_digests"
  if (value === "rollover_breach_watches") return "rollover_breach_watches"
  if (value === "remediation_lifecycle") return "remediation_lifecycle"
  if (value === "rollover_reaffirmation_sla") return "rollover_reaffirmation_sla"
  return "packages"
}

function buildOwnerActiveLoadCounts(
  rows: Array<{ status: string; primaryOwnerId: string | null }>
): Map<string, number> {
  const byOwner = new Map<string, number>()
  for (const row of rows) {
    if (row.status === "revoked") continue
    if (!row.primaryOwnerId) continue
    byOwner.set(row.primaryOwnerId, (byOwner.get(row.primaryOwnerId) ?? 0) + 1)
  }
  return byOwner
}

type EffectiveEscalationPolicy = {
  ownerLoadThreshold: number
  handoffSlaMs: number
  waiverWindowMs: number
  sourcePolicyId: string | null
}

function resolveEffectiveEscalationPolicy(
  packageId: string,
  packagePolicies: Map<string, EscalationPolicyOverrideShape>,
  defaultPolicy: EscalationPolicyOverrideShape | null
): EffectiveEscalationPolicy {
  const scoped = packagePolicies.get(packageId)
  if (scoped) {
    return {
      ownerLoadThreshold: scoped.ownerLoadThreshold,
      handoffSlaMs: scoped.handoffSlaMs,
      waiverWindowMs: scoped.waiverWindowMs,
      sourcePolicyId: scoped.id,
    }
  }
  if (defaultPolicy) {
    return {
      ownerLoadThreshold: defaultPolicy.ownerLoadThreshold,
      handoffSlaMs: defaultPolicy.handoffSlaMs,
      waiverWindowMs: defaultPolicy.waiverWindowMs,
      sourcePolicyId: defaultPolicy.id,
    }
  }
  return {
    ownerLoadThreshold: DEFAULT_ESCALATION_OWNER_LOAD_THRESHOLD,
    handoffSlaMs: DEFAULT_ESCALATION_HANDOFF_SLA_MS,
    waiverWindowMs: DEFAULT_ESCALATION_WAIVER_WINDOW_MS,
    sourcePolicyId: null,
  }
}

function latestByUpdatedAt<T extends { updatedAt: number }>(rows: T[]): T | null {
  if (rows.length === 0) return null
  return [...rows].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
}

type EscalationPolicyOverrideShape = {
  ownerLoadThreshold: number
  handoffSlaMs: number
  waiverWindowMs: number
  id: string
  updatedAt: number
}

function buildEscalationPolicyMaps(
  rows: Array<{
    id: string
    packageId: string | null
    scope: string
    ownerLoadThreshold: number
    handoffSlaMs: number
    waiverWindowMs: number
    updatedAt: number
  }>
): {
  defaultPolicy: EscalationPolicyOverrideShape | null
  packageOverrides: Map<string, EscalationPolicyOverrideShape>
} {
  const packageOverrides = new Map<string, EscalationPolicyOverrideShape>()
  const defaultRow = latestByUpdatedAt(rows.filter((row) => row.scope === "firm_default"))
  for (const row of rows) {
    if (row.scope !== "package_override" || !row.packageId) continue
    const existing = packageOverrides.get(row.packageId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      packageOverrides.set(row.packageId, {
        ownerLoadThreshold: row.ownerLoadThreshold,
        handoffSlaMs: row.handoffSlaMs,
        waiverWindowMs: row.waiverWindowMs,
        id: row.id,
        updatedAt: row.updatedAt,
      })
    }
  }
  return {
    defaultPolicy: defaultRow
      ? {
          ownerLoadThreshold: defaultRow.ownerLoadThreshold,
          handoffSlaMs: defaultRow.handoffSlaMs,
          waiverWindowMs: defaultRow.waiverWindowMs,
          id: defaultRow.id,
          updatedAt: defaultRow.updatedAt,
        }
      : null,
    packageOverrides,
  }
}

function latestActiveRemediationByPackage<T extends {
    packageId: string
    status: string
    expiresAt: number
    updatedAt: number
  }>(
  rows: T[],
  now: number
): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    if (row.status !== "active") continue
    if (row.expiresAt <= now) continue
    const existing = result.get(row.packageId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      result.set(row.packageId, row)
    }
  }
  return result
}

function latestRolloverAttestationByWaiver<T extends { waiverId: string; updatedAt: number }>(
  rows: T[]
): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    const existing = result.get(row.waiverId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      result.set(row.waiverId, row)
    }
  }
  return result
}

function latestOpenRemediationLifecycleByPackage<
  T extends { packageId: string; status: string; updatedAt: number }
>(rows: T[]): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    if (row.status !== "open") continue
    const existing = result.get(row.packageId)
    if (!existing || row.updatedAt > existing.updatedAt) {
      result.set(row.packageId, row)
    }
  }
  return result
}

export async function GET(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  const url = new URL(request.url)
  const view = parseFilingsView(url.searchParams.get("view"))
  const userId = url.searchParams.get("userId")
  const matterId = url.searchParams.get("matterId") ?? undefined
  const readiness = parseReadiness(url.searchParams.get("readiness"))
  const dispatchStatus = url.searchParams.get("dispatchStatus")
  const assigneeId = url.searchParams.get("assigneeId")
  const limit = parseLimit(url.searchParams.get("limit"))
  const cursor = parseCursor(url.searchParams.get("cursor"))
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  try {
    const user = store.users.get(userId)
    if (!user) {
      return NextResponse.json({ error: "unknown user" }, { status: 404 })
    }
    await syncFirmMembers(store, repos, user.firmId)
    const firmPackages = await repos.filings.listByFirm(user.firmId)
    const artifactRows = await repos.filingPacketArtifacts.listByFirm(user.firmId)
    const artifactByPackage = new Map(artifactRows.map((row) => [row.packageId, row]))
    for (const filingPackage of firmPackages) {
      if (artifactByPackage.has(filingPackage.id)) continue
      const draft =
        store.drafts.get(filingPackage.draftId) ?? (await repos.drafts.get(filingPackage.draftId))
      const artifact = buildFilingPacketArtifactRow(filingPackage, draft)
      await repos.filingPacketArtifacts.upsert(artifact)
      store.filingPacketArtifacts.set(artifact.id, artifact)
      artifactByPackage.set(filingPackage.id, artifact)
    }
    const queueRows = await repos.filingDispatchQueue.listByFirm(user.firmId)
    const queueByPackage = new Map(queueRows.map((row) => [row.packageId, row]))
    for (const filingPackage of firmPackages) {
      if (filingPackage.status !== "approved" || queueByPackage.has(filingPackage.id)) continue
      const queueRow = buildFilingDispatchQueueRow(filingPackage)
      await repos.filingDispatchQueue.upsert(queueRow)
      store.filingDispatchQueue.set(queueRow.id, queueRow)
      queueByPackage.set(filingPackage.id, queueRow)
    }
    if (view === "dispatch") {
      const visible = [...queueByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .filter((row) => {
          if (!dispatchStatus || !isFilingDispatchQueueStatus(dispatchStatus)) return true
          return row.status === dispatchStatus
        })
        .filter((row) => (assigneeId ? row.assigneeId === assigneeId : true))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "annexures") {
      const annexureStatus = url.searchParams.get("annexureStatus")
      const packageId = url.searchParams.get("packageId")
      const annexureRows = await repos.filingAnnexures.listByFirm(user.firmId)
      const annexureByPackage = new Map(annexureRows.map((row) => [row.packageId, row]))
      for (const filingPackage of firmPackages) {
        if (filingPackage.status !== "approved" || annexureByPackage.has(filingPackage.id)) continue
        const queueRow = queueByPackage.get(filingPackage.id) ?? null
        if (!queueRow || queueRow.status === "blocked") continue
        const annexure = buildFilingAnnexureRow(filingPackage, queueRow)
        await repos.filingAnnexures.upsert(annexure)
        store.filingAnnexures.set(annexure.id, annexure)
        annexureByPackage.set(filingPackage.id, annexure)
      }
      const visible = [...annexureByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .filter((row) => {
          if (!annexureStatus || !isFilingAnnexureGenerationStatus(annexureStatus)) return true
          return row.generationStatus === annexureStatus
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "submission_receipts") {
      const packageId = url.searchParams.get("packageId")
      const dispatchOutcome = url.searchParams.get("dispatchOutcome")
      const receiptRows = await repos.filingSubmissionReceipts.listByFirm(user.firmId)
      const visible = receiptRows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!dispatchOutcome || !isFilingSubmissionDispatchOutcome(dispatchOutcome)) return true
          return row.dispatchOutcome === dispatchOutcome
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.recordedAt - a.recordedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "submission_reconciliation") {
      const packageId = url.searchParams.get("packageId")
      const reconciliationStatus = url.searchParams.get("reconciliationStatus")
      const annexureRows = await repos.filingAnnexures.listByFirm(user.firmId)
      const readyAnnexureByPackage = new Map(
        annexureRows
          .filter((row) => row.generationStatus === "ready")
          .map((row) => [row.packageId, row])
      )
      const receiptRows = await repos.filingSubmissionReceipts.listByFirm(user.firmId)
      const receiptsByPackage = new Map<string, typeof receiptRows>()
      for (const receipt of receiptRows) {
        const current = receiptsByPackage.get(receipt.packageId) ?? []
        current.push(receipt)
        receiptsByPackage.set(receipt.packageId, current)
      }
      const persistedRows = await repos.filingSubmissionReconciliation.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      for (const filingPackage of firmPackages) {
        if (filingPackage.status !== "approved") continue
        if (!readyAnnexureByPackage.has(filingPackage.id)) continue
        const receipts = receiptsByPackage.get(filingPackage.id) ?? []
        const existing = rowsByPackage.get(filingPackage.id)
        const computed = buildFilingSubmissionReconciliationRow(filingPackage, receipts, {
          notes: existing?.notes ?? [],
        })
        const hasNewAttempt =
          !existing ||
          existing.totalAttempts !== computed.totalAttempts ||
          existing.latestReceiptId !== computed.latestReceiptId
        const changed =
          !existing ||
          existing.totalAttempts !== computed.totalAttempts ||
          existing.latestReceiptId !== computed.latestReceiptId ||
          existing.latestSubmissionReference !== computed.latestSubmissionReference ||
          existing.latestDispatchOutcome !== computed.latestDispatchOutcome
        const next = changed
          ? existing
            ? {
                ...computed,
                status: hasNewAttempt ? computed.status : existing.status,
                notes: existing.notes,
                updatedAt: Date.now(),
              }
            : computed
          : existing
        if (changed || !existing) {
          await repos.filingSubmissionReconciliation.upsert(next)
        }
        store.filingSubmissionReconciliation.set(next.id, next)
        rowsByPackage.set(filingPackage.id, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (
            !reconciliationStatus ||
            !isFilingSubmissionReconciliationStatus(reconciliationStatus)
          ) {
            return true
          }
          return row.status === reconciliationStatus
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "submission_exceptions") {
      const packageId = url.searchParams.get("packageId")
      const exceptionStatus = url.searchParams.get("exceptionStatus")
      const severity = url.searchParams.get("severity")
      const escalationOwnerId = url.searchParams.get("escalationOwnerId")
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const persistedRows = await repos.filingSubmissionExceptions.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const receiptRows = await repos.filingSubmissionReceipts.listByFirm(user.firmId)
      const receiptById = new Map(receiptRows.map((row) => [row.id, row]))
      const latestFailingReceiptByPackage = new Map<string, (typeof receiptRows)[number]>()
      for (const row of receiptRows) {
        if (row.dispatchOutcome === "accepted") continue
        const current = latestFailingReceiptByPackage.get(row.packageId)
        if (!current || row.attemptNo > current.attemptNo) {
          latestFailingReceiptByPackage.set(row.packageId, row)
        }
      }
      const reconciliationRows = await repos.filingSubmissionReconciliation.listByFirm(user.firmId)
      const reconciliationByPackage = new Map(
        reconciliationRows.map((row) => [row.packageId, row])
      )
      const needsRetryReconciliationByPackage = new Map(
        reconciliationRows
          .filter((row) => row.status === "needs_retry")
          .map((row) => [row.packageId, row])
      )
      for (const [pkgId, reconciliation] of needsRetryReconciliationByPackage.entries()) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const linkedReceipt =
          (reconciliation.latestReceiptId && receiptById.get(reconciliation.latestReceiptId)) ?? null
        const next = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source: "reconciliation_needs_retry",
            receipt: linkedReceipt,
            reconciliation,
            actorId: "system_sync",
            now: reconciliation.updatedAt,
          },
          existing
        )
        const changed =
          !existing ||
          existing.source !== next.source ||
          existing.latestReceiptId !== next.latestReceiptId ||
          existing.latestReconciliationId !== next.latestReconciliationId ||
          existing.lastRaisedAt !== next.lastRaisedAt ||
          existing.status === "resolved"
        if (changed) {
          await repos.filingSubmissionExceptions.upsert(next)
        }
        store.filingSubmissionExceptions.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      for (const [pkgId, receipt] of latestFailingReceiptByPackage.entries()) {
        if (needsRetryReconciliationByPackage.has(pkgId)) continue
        if (reconciliationByPackage.get(pkgId)?.status === "reconciled") continue
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const source =
          receipt.dispatchOutcome === "rejected"
            ? ("receipt_rejected" as const)
            : ("receipt_retry_scheduled" as const)
        const next = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source,
            receipt,
            reconciliation: null,
            actorId: "system_sync",
            now: receipt.recordedAt,
          },
          existing
        )
        const changed =
          !existing ||
          existing.source !== next.source ||
          existing.latestReceiptId !== next.latestReceiptId ||
          existing.lastRaisedAt !== next.lastRaisedAt ||
          existing.status === "resolved"
        if (changed) {
          await repos.filingSubmissionExceptions.upsert(next)
        }
        store.filingSubmissionExceptions.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingSubmissionExceptionStatus(exceptionStatus)) return true
          return row.status === exceptionStatus
        })
        .filter((row) => {
          if (!isFilingSubmissionExceptionSeverity(severity)) return true
          return row.severity === severity
        })
        .filter((row) => (escalationOwnerId ? row.escalationOwnerId === escalationOwnerId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => a.slaTargetAt - b.slaTargetAt || b.updatedAt - a.updatedAt)
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "transport_execution") {
      const packageId = url.searchParams.get("packageId")
      const outcome = url.searchParams.get("outcome")
      const blockerTag = url.searchParams.get("blockerTag")?.trim().toLowerCase()
      const rows = await repos.filingTransportExecutionEvidence.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingTransportExecutionOutcome(outcome)) return true
          return row.outcome === outcome
        })
        .filter((row) => {
          if (!blockerTag) return true
          return row.deterministicBlockerTags.includes(blockerTag)
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "submission_sla_digests") {
      const packageId = url.searchParams.get("packageId")
      const digestStatus = url.searchParams.get("digestStatus")
      const ownerId = url.searchParams.get("ownerId")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const exceptionRows = await repos.filingSubmissionExceptions.listByFirm(user.firmId)
      const exceptionByPackage = new Map(exceptionRows.map((row) => [row.packageId, row]))
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByFirm(user.firmId)
      const evidenceByPackage = new Map<string, typeof evidenceRows>()
      for (const row of evidenceRows) {
        const current = evidenceByPackage.get(row.packageId) ?? []
        current.push(row)
        evidenceByPackage.set(row.packageId, current)
      }
      const persistedDigestRows = await repos.filingSubmissionSlaDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedDigestRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...exceptionByPackage.keys(),
        ...evidenceByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const evidence = (evidenceByPackage.get(pkgId) ?? []).sort(
          (a, b) => a.createdAt - b.createdAt || a.sequenceNo - b.sequenceNo
        )
        const latestEvidence = evidence[evidence.length - 1] ?? null
        const deliveredEvidenceAt = evidence
          .filter((row) => row.outcome === "confirm_delivered")
          .reduce((max, row) => (row.createdAt > max ? row.createdAt : max), 0)
        const computed = buildSubmissionSlaDigestRow(filingPackage, {
          exception: exceptionByPackage.get(pkgId) ?? null,
          latestEvidence,
          deliveredEvidenceAt: deliveredEvidenceAt > 0 ? deliveredEvidenceAt : null,
          now,
          existing,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.staleRetryPlan !== computed.staleRetryPlan ||
          existing.outstandingOwnerId !== computed.outstandingOwnerId ||
          existing.linkedExceptionId !== computed.linkedExceptionId ||
          existing.linkedEvidenceId !== computed.linkedEvidenceId ||
          existing.deferUntil !== computed.deferUntil ||
          JSON.stringify(existing.breachReasons) !== JSON.stringify(computed.breachReasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingSubmissionSlaDigests.upsert(next)
        }
        store.filingSubmissionSlaDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingSubmissionSlaDigestStatus(digestStatus)) return true
          return row.status === digestStatus
        })
        .filter((row) => (ownerId ? row.outstandingOwnerId === ownerId : true))
        .filter((row) => (reason ? row.breachReasons.includes(reason as typeof row.breachReasons[number]) : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => a.status.localeCompare(b.status) || a.breachWindowStartedAt - b.breachWindowStartedAt)
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "escalation_owner_rota") {
      const packageId = url.searchParams.get("packageId")
      const ownerId = url.searchParams.get("ownerId")
      const rotaStatus = url.searchParams.get("rotaStatus")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const exceptionRows = await repos.filingSubmissionExceptions.listByFirm(user.firmId)
      const exceptionByPackage = new Map(exceptionRows.map((row) => [row.packageId, row]))
      const digestRows = await repos.filingSubmissionSlaDigests.listByFirm(user.firmId)
      const digestByPackage = new Map(digestRows.map((row) => [row.packageId, row]))
      const persistedRows = await repos.filingEscalationOwnerRota.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...exceptionByPackage.keys(),
        ...digestByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const exception = exceptionByPackage.get(pkgId) ?? null
        const digest = digestByPackage.get(pkgId) ?? null
        const existing = rowsByPackage.get(pkgId) ?? null
        const seedPrimary =
          existing?.primaryOwnerId ?? exception?.escalationOwnerId ?? digest?.outstandingOwnerId ?? null
        const seedBackup = existing?.backupOwnerId ?? null
        if (!existing && !seedPrimary && !seedBackup) continue
        const computed = buildFilingEscalationOwnerRotaRow(filingPackage, {
          now,
          existing,
          primaryOwnerId: seedPrimary,
          backupOwnerId: seedBackup,
          linkedExceptionId: exception?.id ?? null,
          linkedDigestId: digest?.id ?? null,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.primaryOwnerId !== computed.primaryOwnerId ||
          existing.backupOwnerId !== computed.backupOwnerId ||
          existing.activeWindowEndAt !== computed.activeWindowEndAt ||
          existing.linkedExceptionId !== computed.linkedExceptionId ||
          existing.linkedDigestId !== computed.linkedDigestId ||
          existing.handoffRequired !== computed.handoffRequired ||
          existing.handoffAcknowledgedBy !== computed.handoffAcknowledgedBy ||
          existing.handoffAcknowledgedAt !== computed.handoffAcknowledgedAt
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationOwnerRota.upsert(next)
        }
        store.filingEscalationOwnerRota.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationOwnerRotaStatus(rotaStatus)) return true
          return row.status === rotaStatus
        })
        .filter((row) => {
          if (!ownerId) return true
          return row.primaryOwnerId === ownerId || row.backupOwnerId === ownerId
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "escalation_workload_digests") {
      const packageId = url.searchParams.get("packageId")
      const ownerId = url.searchParams.get("ownerId")
      const workloadStatus = url.searchParams.get("workloadStatus")
      const reason = url.searchParams.get("reason")
      const handoffLagBucket = url.searchParams.get("handoffLagBucket")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const rotaRows = await repos.filingEscalationOwnerRota.listByFirm(user.firmId)
      const rotaByPackage = new Map(rotaRows.map((row) => [row.packageId, row]))
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(rotaRows)
      const slaRows = await repos.filingSubmissionSlaDigests.listByFirm(user.firmId)
      const slaByPackage = new Map(slaRows.map((row) => [row.packageId, row]))
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides: policyOverridesByPackage } =
        buildEscalationPolicyMaps(policyRows)
      const waiverRows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const activeWaiverByPackage = new Map<string, (typeof waiverRows)[number]>()
      for (const row of waiverRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = {
            ...row,
            status: "expired" as const,
            updatedAt: now,
          }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          continue
        }
        if (row.status !== "active" || row.expiresAt <= now) continue
        const current = activeWaiverByPackage.get(row.packageId)
        if (!current || row.updatedAt > current.updatedAt) {
          activeWaiverByPackage.set(row.packageId, row)
        }
      }
      const policyVarianceRows = await repos.filingEscalationPolicyVarianceDigests.listByFirm(user.firmId)
      const policyVarianceByPackage = new Map(policyVarianceRows.map((row) => [row.packageId, row]))
      const waiverExpiryRows = await repos.filingEscalationWaiverExpiryDigests.listByFirm(user.firmId)
      const waiverExpiryByPackage = new Map(waiverExpiryRows.map((row) => [row.packageId, row]))
      const remediationExpiryRows = await repos.filingEscalationRemediationExpiryDigests.listByFirm(
        user.firmId
      )
      const remediationExpiryByPackage = new Map(
        remediationExpiryRows.map((row) => [row.packageId, row])
      )
      const rolloverWatchRows = await repos.filingEscalationRolloverBreachWatches.listByFirm(user.firmId)
      const rolloverWatchByPackage = new Map(rolloverWatchRows.map((row) => [row.packageId, row]))
      const remediationRows = await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId)
      for (const row of remediationRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
        }
      }
      const activeRemediationByPackage = latestActiveRemediationByPackage(
        await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId),
        now
      )
      const lifecycleRows = await repos.filingEscalationRemediationLifecycles.listByFirm(user.firmId)
      const openLifecycleByPackage = latestOpenRemediationLifecycleByPackage(lifecycleRows)
      const rolloverRows = await repos.filingEscalationWaiverRolloverAttestations.listByFirm(user.firmId)
      const rolloverByWaiverId = latestRolloverAttestationByWaiver(rolloverRows)
      const reaffirmationRows = await repos.filingEscalationRolloverReaffirmationSlas.listByFirm(
        user.firmId
      )
      const reaffirmationByPackage = new Map(reaffirmationRows.map((row) => [row.packageId, row]))
      const persistedRows = await repos.filingEscalationWorkloadDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...rotaByPackage.keys(),
        ...slaByPackage.keys(),
        ...policyOverridesByPackage.keys(),
        ...activeWaiverByPackage.keys(),
        ...policyVarianceByPackage.keys(),
        ...waiverExpiryByPackage.keys(),
        ...activeRemediationByPackage.keys(),
        ...remediationExpiryByPackage.keys(),
        ...rolloverWatchByPackage.keys(),
        ...openLifecycleByPackage.keys(),
        ...reaffirmationByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const rota = rotaByPackage.get(pkgId) ?? null
        const slaDigest = slaByPackage.get(pkgId) ?? null
        const existing = rowsByPackage.get(pkgId) ?? null
        if (!rota && !slaDigest && !existing) continue
        const ownerLoadCount =
          rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
        const policy = resolveEffectiveEscalationPolicy(
          pkgId,
          policyOverridesByPackage,
          defaultPolicy
        )
        const activeWaiver = activeWaiverByPackage.get(pkgId) ?? null
        const defaultPolicyRow =
          policyRows.find((row) => row.id === defaultPolicy?.id) ?? null
        const packagePolicyRow = latestByUpdatedAt(
          policyRows.filter((row) => row.scope === "package_override" && row.packageId === pkgId)
        )
        const existingPolicyVariance = policyVarianceByPackage.get(pkgId) ?? null
        const computedPolicyVariance = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
          firmDefaultPolicy: defaultPolicyRow,
          packagePolicy: packagePolicyRow,
          existing: existingPolicyVariance,
          now,
        })
        const policyVarianceChanged =
          !existingPolicyVariance ||
          existingPolicyVariance.status !== computedPolicyVariance.status ||
          existingPolicyVariance.firmDefaultPolicyId !== computedPolicyVariance.firmDefaultPolicyId ||
          existingPolicyVariance.packagePolicyId !== computedPolicyVariance.packagePolicyId ||
          existingPolicyVariance.ownerLoadThresholdDefault !==
            computedPolicyVariance.ownerLoadThresholdDefault ||
          existingPolicyVariance.ownerLoadThresholdEffective !==
            computedPolicyVariance.ownerLoadThresholdEffective ||
          existingPolicyVariance.handoffSlaMsDefault !== computedPolicyVariance.handoffSlaMsDefault ||
          existingPolicyVariance.handoffSlaMsEffective !== computedPolicyVariance.handoffSlaMsEffective ||
          existingPolicyVariance.waiverWindowMsDefault !== computedPolicyVariance.waiverWindowMsDefault ||
          existingPolicyVariance.waiverWindowMsEffective !== computedPolicyVariance.waiverWindowMsEffective ||
          existingPolicyVariance.snoozeUntil !== computedPolicyVariance.snoozeUntil ||
          JSON.stringify(existingPolicyVariance.varianceReasons) !==
            JSON.stringify(computedPolicyVariance.varianceReasons)
        const nextPolicyVariance = policyVarianceChanged ? computedPolicyVariance : existingPolicyVariance
        if (policyVarianceChanged && nextPolicyVariance) {
          await repos.filingEscalationPolicyVarianceDigests.upsert(nextPolicyVariance)
        }
        if (nextPolicyVariance) {
          store.filingEscalationPolicyVarianceDigests.set(nextPolicyVariance.id, nextPolicyVariance)
          policyVarianceByPackage.set(pkgId, nextPolicyVariance)
        }
        const existingWaiverExpiry = waiverExpiryByPackage.get(pkgId) ?? null
        const computedWaiverExpiry = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
          activeWaiver,
          linkedPolicyId: policy.sourcePolicyId,
          existing: existingWaiverExpiry,
          now,
        })
        const waiverExpiryChanged =
          !existingWaiverExpiry ||
          existingWaiverExpiry.status !== computedWaiverExpiry.status ||
          existingWaiverExpiry.linkedWaiverId !== computedWaiverExpiry.linkedWaiverId ||
          existingWaiverExpiry.linkedPolicyId !== computedWaiverExpiry.linkedPolicyId ||
          existingWaiverExpiry.waiverExpiresAt !== computedWaiverExpiry.waiverExpiresAt ||
          existingWaiverExpiry.msUntilExpiry !== computedWaiverExpiry.msUntilExpiry ||
          JSON.stringify(existingWaiverExpiry.reasons) !== JSON.stringify(computedWaiverExpiry.reasons)
        const nextWaiverExpiry = waiverExpiryChanged ? computedWaiverExpiry : existingWaiverExpiry
        if (waiverExpiryChanged && nextWaiverExpiry) {
          await repos.filingEscalationWaiverExpiryDigests.upsert(nextWaiverExpiry)
        }
        if (nextWaiverExpiry) {
          store.filingEscalationWaiverExpiryDigests.set(nextWaiverExpiry.id, nextWaiverExpiry)
          waiverExpiryByPackage.set(pkgId, nextWaiverExpiry)
        }
        const activeRemediation = activeRemediationByPackage.get(pkgId) ?? null
        const existingRemediationExpiry = remediationExpiryByPackage.get(pkgId) ?? null
        const computedRemediationExpiry = buildFilingEscalationRemediationExpiryDigestRow(
          filingPackage,
          {
            activeRemediation,
            pendingClosureLifecycle: openLifecycleByPackage.get(pkgId) ?? null,
            linkedPolicyId: policy.sourcePolicyId,
            existing: existingRemediationExpiry,
            now,
          }
        )
        const remediationExpiryChanged =
          !existingRemediationExpiry ||
          existingRemediationExpiry.status !== computedRemediationExpiry.status ||
          existingRemediationExpiry.linkedRemediationId !== computedRemediationExpiry.linkedRemediationId ||
          existingRemediationExpiry.linkedLifecycleId !== computedRemediationExpiry.linkedLifecycleId ||
          existingRemediationExpiry.linkedPolicyVarianceDigestId !==
            computedRemediationExpiry.linkedPolicyVarianceDigestId ||
          existingRemediationExpiry.linkedPolicyId !== computedRemediationExpiry.linkedPolicyId ||
          existingRemediationExpiry.remediationExpiresAt !==
            computedRemediationExpiry.remediationExpiresAt ||
          existingRemediationExpiry.msUntilExpiry !== computedRemediationExpiry.msUntilExpiry ||
          existingRemediationExpiry.snoozeUntil !== computedRemediationExpiry.snoozeUntil ||
          JSON.stringify(existingRemediationExpiry.reasons) !==
            JSON.stringify(computedRemediationExpiry.reasons)
        const nextRemediationExpiry = remediationExpiryChanged
          ? computedRemediationExpiry
          : existingRemediationExpiry
        if (remediationExpiryChanged && nextRemediationExpiry) {
          await repos.filingEscalationRemediationExpiryDigests.upsert(nextRemediationExpiry)
        }
        if (nextRemediationExpiry) {
          store.filingEscalationRemediationExpiryDigests.set(
            nextRemediationExpiry.id,
            nextRemediationExpiry
          )
          remediationExpiryByPackage.set(pkgId, nextRemediationExpiry)
        }
        const activeWaiverPolicyCapExpiresAt = activeWaiver
          ? activeWaiver.grantedAt + policy.waiverWindowMs
          : null
        const latestRolloverAttestation = activeWaiver
          ? rolloverByWaiverId.get(activeWaiver.id) ?? null
          : null
        const reaffirmationWarningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
        const reaffirmationBreachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
        const existingReaffirmation = reaffirmationByPackage.get(pkgId) ?? null
        const computedReaffirmation = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
          activeWaiver,
          policyCapExpiresAt: activeWaiverPolicyCapExpiresAt,
          latestAttestation: latestRolloverAttestation,
          linkedPolicyId: policy.sourcePolicyId,
          warningThresholdMs: reaffirmationWarningThresholdMs,
          breachThresholdMs: reaffirmationBreachThresholdMs,
          existing: existingReaffirmation,
          now,
        })
        const reaffirmationChanged =
          !existingReaffirmation ||
          existingReaffirmation.status !== computedReaffirmation.status ||
          existingReaffirmation.linkedWaiverId !== computedReaffirmation.linkedWaiverId ||
          existingReaffirmation.linkedAttestationId !== computedReaffirmation.linkedAttestationId ||
          existingReaffirmation.linkedPolicyId !== computedReaffirmation.linkedPolicyId ||
          existingReaffirmation.policyCapExpiresAt !== computedReaffirmation.policyCapExpiresAt ||
          existingReaffirmation.waiverExpiresAt !== computedReaffirmation.waiverExpiresAt ||
          existingReaffirmation.lastReaffirmedAt !== computedReaffirmation.lastReaffirmedAt ||
          existingReaffirmation.elapsedSinceReaffirmationMs !==
            computedReaffirmation.elapsedSinceReaffirmationMs ||
          existingReaffirmation.warningThresholdMs !== computedReaffirmation.warningThresholdMs ||
          existingReaffirmation.breachThresholdMs !== computedReaffirmation.breachThresholdMs ||
          JSON.stringify(existingReaffirmation.reasons) !== JSON.stringify(computedReaffirmation.reasons)
        const nextReaffirmation = reaffirmationChanged ? computedReaffirmation : existingReaffirmation
        if (reaffirmationChanged && nextReaffirmation) {
          await repos.filingEscalationRolloverReaffirmationSlas.upsert(nextReaffirmation)
        }
        if (nextReaffirmation) {
          store.filingEscalationRolloverReaffirmationSlas.set(nextReaffirmation.id, nextReaffirmation)
          reaffirmationByPackage.set(pkgId, nextReaffirmation)
        }
        const existingRolloverWatch = rolloverWatchByPackage.get(pkgId) ?? null
        const computedRolloverWatch = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
          activeWaiver,
          policyCapExpiresAt: activeWaiverPolicyCapExpiresAt,
          latestAttestation: latestRolloverAttestation,
          linkedPolicyId: policy.sourcePolicyId,
          existing: existingRolloverWatch,
          now,
        })
        const rolloverWatchChanged =
          !existingRolloverWatch ||
          existingRolloverWatch.status !== computedRolloverWatch.status ||
          existingRolloverWatch.linkedWaiverId !== computedRolloverWatch.linkedWaiverId ||
          existingRolloverWatch.linkedAttestationId !== computedRolloverWatch.linkedAttestationId ||
          existingRolloverWatch.linkedPolicyId !== computedRolloverWatch.linkedPolicyId ||
          existingRolloverWatch.policyCapExpiresAt !== computedRolloverWatch.policyCapExpiresAt ||
          existingRolloverWatch.waiverExpiresAt !== computedRolloverWatch.waiverExpiresAt ||
          existingRolloverWatch.attestationUpdatedAt !== computedRolloverWatch.attestationUpdatedAt ||
          JSON.stringify(existingRolloverWatch.reasons) !==
            JSON.stringify(computedRolloverWatch.reasons)
        const nextRolloverWatch = rolloverWatchChanged
          ? computedRolloverWatch
          : existingRolloverWatch
        if (rolloverWatchChanged && nextRolloverWatch) {
          await repos.filingEscalationRolloverBreachWatches.upsert(nextRolloverWatch)
        }
        if (nextRolloverWatch) {
          store.filingEscalationRolloverBreachWatches.set(nextRolloverWatch.id, nextRolloverWatch)
          rolloverWatchByPackage.set(pkgId, nextRolloverWatch)
        }
        const computedBase = buildFilingEscalationWorkloadDigestRow(filingPackage, {
          rota,
          slaDigest,
          ownerLoadCount,
          ownerLoadThreshold: policy.ownerLoadThreshold,
          handoffSlaMs: policy.handoffSlaMs,
          now,
          existing,
        })
        const waiverExpiringCritical =
          !!nextWaiverExpiry &&
          nextWaiverExpiry.status !== "cleared" &&
          (nextWaiverExpiry.reasons.includes("already_expired") ||
            nextWaiverExpiry.reasons.includes("expires_lte_4h"))
        const policyVarianceCritical =
          !!nextPolicyVariance &&
          nextPolicyVariance.status !== "cleared" &&
          nextPolicyVariance.varianceReasons.includes("handoff_sla_override")
        const remediationExpiryCritical =
          !!nextRemediationExpiry &&
          nextRemediationExpiry.status !== "cleared" &&
          (nextRemediationExpiry.reasons.includes("already_expired") ||
            nextRemediationExpiry.reasons.includes("expires_lte_4h") ||
            nextRemediationExpiry.reasons.includes("closure_attestation_pending")) &&
          !(
            nextRemediationExpiry.status === "snoozed" &&
            nextRemediationExpiry.snoozeUntil &&
            nextRemediationExpiry.snoozeUntil > now
          )
        const reaffirmationSlaBreachCritical =
          !!nextReaffirmation &&
          (nextReaffirmation.status === "breached" ||
            nextReaffirmation.reasons.includes("cap_crossed_reaffirmation_breached"))
        const reaffirmationSlaWarning =
          !!nextReaffirmation &&
          (nextReaffirmation.status === "warning" ||
            nextReaffirmation.reasons.includes("cap_crossed_reaffirmation_warning"))
        const rolloverBreachCritical =
          !!nextRolloverWatch &&
          nextRolloverWatch.status !== "cleared" &&
          nextRolloverWatch.reasons.length > 0
        const noActiveRemediationForVariance =
          !!nextPolicyVariance &&
          nextPolicyVariance.status !== "cleared" &&
          !activeRemediation
        const longLivedTemporaryOverride =
          !!activeRemediation &&
          activeRemediation.decision === "temporary_override" &&
          activeRemediation.expiresAt - activeRemediation.decidedAt > policy.waiverWindowMs
        const severityTier: "baseline" | "elevated" | "critical" =
          reaffirmationSlaBreachCritical ||
          rolloverBreachCritical ||
          remediationExpiryCritical ||
          longLivedTemporaryOverride ||
          noActiveRemediationForVariance
            ? "critical"
            : waiverExpiringCritical || policyVarianceCritical || reaffirmationSlaWarning
              ? "elevated"
              : "baseline"
        let computed =
          activeWaiver && computedBase.alertReasons.length > 0
            ? {
                ...computedBase,
                status: "snoozed" as const,
                snoozeUntil: activeWaiver.expiresAt,
                updatedAt: now,
                lastEvaluatedAt: now,
              }
            : computedBase
        if (severityTier === "critical" && computed.status !== "open_alert") {
          computed = {
            ...computed,
            status: "open_alert",
            snoozeUntil: null,
            updatedAt: now,
            lastEvaluatedAt: now,
          }
        } else if (severityTier === "elevated" && computed.status === "snoozed") {
          computed = {
            ...computed,
            status: "open_alert",
            snoozeUntil: null,
            updatedAt: now,
            lastEvaluatedAt: now,
          }
        }
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.ownerId !== computed.ownerId ||
          existing.ownerLoadCount !== computed.ownerLoadCount ||
          existing.ownerLoadThreshold !== computed.ownerLoadThreshold ||
          existing.snoozeUntil !== computed.snoozeUntil ||
          existing.handoffLagBucket !== computed.handoffLagBucket ||
          existing.handoffLagMs !== computed.handoffLagMs ||
          existing.linkedRotaId !== computed.linkedRotaId ||
          existing.linkedDigestId !== computed.linkedDigestId ||
          JSON.stringify(existing.alertReasons) !== JSON.stringify(computed.alertReasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationWorkloadDigests.upsert(next)
        }
        store.filingEscalationWorkloadDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => (ownerId ? row.ownerId === ownerId : true))
        .filter((row) => {
          if (!isFilingEscalationWorkloadDigestStatus(workloadStatus)) return true
          return row.status === workloadStatus
        })
        .filter((row) =>
          reason
            ? row.alertReasons.includes(reason as (typeof row.alertReasons)[number])
            : true
        )
        .filter((row) => {
          if (!isFilingEscalationHandoffLagBucket(handoffLagBucket)) return true
          return row.handoffLagBucket === handoffLagBucket
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "escalation_policy_baselines") {
      const scope = url.searchParams.get("scope")
      const packageId = url.searchParams.get("packageId")
      const rows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationPolicyBaselineScope(scope)) return true
          return row.scope === scope
        })
        .filter((row) => {
          if (!matterId) return true
          if (!row.matterId) return true
          return row.matterId === matterId
        })
        .filter((row) => {
          if (row.matterId) {
            const permission = checkPermission(store, user.id, "draft", row.matterId)
            if (!permission.allow) return false
          }
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "breach_waiver_ledger") {
      const packageId = url.searchParams.get("packageId")
      const waiverStatus = url.searchParams.get("waiverStatus")
      const now = Date.now()
      const rows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const normalized: typeof rows = []
      for (const row of rows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          normalized.push(expired)
          continue
        }
        normalized.push(row)
      }
      const visible = normalized
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationWaiverStatus(waiverStatus)) return true
          return row.status === waiverStatus
        })
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.grantedAt - a.grantedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "policy_variance_digests") {
      const packageId = url.searchParams.get("packageId")
      const varianceStatus = url.searchParams.get("varianceStatus")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const persistedRows = await repos.filingEscalationPolicyVarianceDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...packageOverrides.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const defaultPolicyRow = defaultPolicy
          ? policyRows.find((row) => row.id === defaultPolicy.id) ?? null
          : null
        const packagePolicyRow = latestByUpdatedAt(
          policyRows.filter((row) => row.scope === "package_override" && row.packageId === pkgId)
        )
        const computed = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
          firmDefaultPolicy: defaultPolicyRow,
          packagePolicy: packagePolicyRow,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.firmDefaultPolicyId !== computed.firmDefaultPolicyId ||
          existing.packagePolicyId !== computed.packagePolicyId ||
          existing.ownerLoadThresholdDefault !== computed.ownerLoadThresholdDefault ||
          existing.ownerLoadThresholdEffective !== computed.ownerLoadThresholdEffective ||
          existing.handoffSlaMsDefault !== computed.handoffSlaMsDefault ||
          existing.handoffSlaMsEffective !== computed.handoffSlaMsEffective ||
          existing.waiverWindowMsDefault !== computed.waiverWindowMsDefault ||
          existing.waiverWindowMsEffective !== computed.waiverWindowMsEffective ||
          existing.snoozeUntil !== computed.snoozeUntil ||
          JSON.stringify(existing.varianceReasons) !== JSON.stringify(computed.varianceReasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationPolicyVarianceDigests.upsert(next)
        }
        store.filingEscalationPolicyVarianceDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationPolicyVarianceDigestStatus(varianceStatus)) return true
          return row.status === varianceStatus
        })
        .filter((row) =>
          reason
            ? row.varianceReasons.includes(reason as (typeof row.varianceReasons)[number])
            : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "waiver_expiry_digests") {
      const packageId = url.searchParams.get("packageId")
      const expiryStatus = url.searchParams.get("expiryStatus")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const waiverRows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const activeWaiverByPackage = new Map<string, (typeof waiverRows)[number]>()
      for (const row of waiverRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          continue
        }
        if (row.status !== "active" || row.expiresAt <= now) continue
        const current = activeWaiverByPackage.get(row.packageId)
        if (!current || row.updatedAt > current.updatedAt) {
          activeWaiverByPackage.set(row.packageId, row)
        }
      }
      const persistedRows = await repos.filingEscalationWaiverExpiryDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...activeWaiverByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const policy = resolveEffectiveEscalationPolicy(pkgId, packageOverrides, defaultPolicy)
        const computed = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
          activeWaiver: activeWaiverByPackage.get(pkgId) ?? null,
          linkedPolicyId: policy.sourcePolicyId,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.linkedWaiverId !== computed.linkedWaiverId ||
          existing.linkedPolicyId !== computed.linkedPolicyId ||
          existing.waiverExpiresAt !== computed.waiverExpiresAt ||
          existing.msUntilExpiry !== computed.msUntilExpiry ||
          JSON.stringify(existing.reasons) !== JSON.stringify(computed.reasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationWaiverExpiryDigests.upsert(next)
        }
        store.filingEscalationWaiverExpiryDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationWaiverExpiryDigestStatus(expiryStatus)) return true
          return row.status === expiryStatus
        })
        .filter((row) =>
          reason ? row.reasons.includes(reason as (typeof row.reasons)[number]) : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "variance_remediation_ledger") {
      const packageId = url.searchParams.get("packageId")
      const remediationStatus = url.searchParams.get("remediationStatus")
      const decision = url.searchParams.get("decision")
      const now = Date.now()
      const rows = await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId)
      const normalized: typeof rows = []
      for (const row of rows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
          normalized.push(expired)
          continue
        }
        normalized.push(row)
      }
      const visible = normalized
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationVarianceRemediationStatus(remediationStatus)) return true
          return row.status === remediationStatus
        })
        .filter((row) => {
          if (!isFilingEscalationVarianceRemediationDecision(decision)) return true
          return row.decision === decision
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "waiver_rollover_attestations") {
      const packageId = url.searchParams.get("packageId")
      const rolloverStatus = url.searchParams.get("rolloverStatus")
      const waiverId = url.searchParams.get("waiverId")
      const rows = await repos.filingEscalationWaiverRolloverAttestations.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => (waiverId ? row.waiverId === waiverId : true))
        .filter((row) => {
          if (!isFilingEscalationWaiverRolloverStatus(rolloverStatus)) return true
          return row.status === rolloverStatus
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "remediation_expiry_digests") {
      const packageId = url.searchParams.get("packageId")
      const expiryStatus = url.searchParams.get("expiryStatus")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const remediationRows = await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId)
      for (const row of remediationRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
        }
      }
      const activeRemediationByPackage = latestActiveRemediationByPackage(
        await repos.filingEscalationVarianceRemediations.listByFirm(user.firmId),
        now
      )
      const lifecycleRows = await repos.filingEscalationRemediationLifecycles.listByFirm(user.firmId)
      const openLifecycleByPackage = latestOpenRemediationLifecycleByPackage(lifecycleRows)
      const persistedRows = await repos.filingEscalationRemediationExpiryDigests.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...activeRemediationByPackage.keys(),
        ...openLifecycleByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const policy = resolveEffectiveEscalationPolicy(pkgId, packageOverrides, defaultPolicy)
        const computed = buildFilingEscalationRemediationExpiryDigestRow(filingPackage, {
          activeRemediation: activeRemediationByPackage.get(pkgId) ?? null,
          pendingClosureLifecycle: openLifecycleByPackage.get(pkgId) ?? null,
          linkedPolicyId: policy.sourcePolicyId,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.linkedRemediationId !== computed.linkedRemediationId ||
          existing.linkedLifecycleId !== computed.linkedLifecycleId ||
          existing.linkedPolicyVarianceDigestId !== computed.linkedPolicyVarianceDigestId ||
          existing.linkedPolicyId !== computed.linkedPolicyId ||
          existing.remediationExpiresAt !== computed.remediationExpiresAt ||
          existing.msUntilExpiry !== computed.msUntilExpiry ||
          existing.snoozeUntil !== computed.snoozeUntil ||
          JSON.stringify(existing.reasons) !== JSON.stringify(computed.reasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationRemediationExpiryDigests.upsert(next)
        }
        store.filingEscalationRemediationExpiryDigests.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationRemediationExpiryDigestStatus(expiryStatus)) return true
          return row.status === expiryStatus
        })
        .filter((row) =>
          reason ? row.reasons.includes(reason as (typeof row.reasons)[number]) : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "remediation_lifecycle") {
      const packageId = url.searchParams.get("packageId")
      const lifecycleStatus = url.searchParams.get("lifecycleStatus")
      const closureOutcome = url.searchParams.get("closureOutcome")
      const rows = await repos.filingEscalationRemediationLifecycles.listByFirm(user.firmId)
      const visible = rows
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationRemediationLifecycleStatus(lifecycleStatus)) return true
          return row.status === lifecycleStatus
        })
        .filter((row) => {
          if (!isFilingEscalationRemediationClosureOutcome(closureOutcome)) return true
          return row.closureOutcome === closureOutcome
        })
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "rollover_reaffirmation_sla") {
      const packageId = url.searchParams.get("packageId")
      const statusFilter = url.searchParams.get("status")
      const reason = url.searchParams.get("reason")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const waiverRows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const activeWaiverByPackage = new Map<string, (typeof waiverRows)[number]>()
      for (const row of waiverRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          continue
        }
        if (row.status !== "active" || row.expiresAt <= now) continue
        const current = activeWaiverByPackage.get(row.packageId)
        if (!current || row.updatedAt > current.updatedAt) {
          activeWaiverByPackage.set(row.packageId, row)
        }
      }
      const rolloverRows = await repos.filingEscalationWaiverRolloverAttestations.listByFirm(user.firmId)
      const rolloverByWaiverId = latestRolloverAttestationByWaiver(rolloverRows)
      const persistedRows = await repos.filingEscalationRolloverReaffirmationSlas.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...activeWaiverByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const policy = resolveEffectiveEscalationPolicy(pkgId, packageOverrides, defaultPolicy)
        const activeWaiver = activeWaiverByPackage.get(pkgId) ?? null
        const latestAttestation = activeWaiver ? rolloverByWaiverId.get(activeWaiver.id) ?? null : null
        const policyCapExpiresAt = activeWaiver ? activeWaiver.grantedAt + policy.waiverWindowMs : null
        const warningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
        const breachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
        const existing = rowsByPackage.get(pkgId) ?? null
        const computed = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
          activeWaiver,
          policyCapExpiresAt,
          latestAttestation,
          linkedPolicyId: policy.sourcePolicyId,
          warningThresholdMs,
          breachThresholdMs,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.linkedWaiverId !== computed.linkedWaiverId ||
          existing.linkedAttestationId !== computed.linkedAttestationId ||
          existing.linkedPolicyId !== computed.linkedPolicyId ||
          existing.policyCapExpiresAt !== computed.policyCapExpiresAt ||
          existing.waiverExpiresAt !== computed.waiverExpiresAt ||
          existing.lastReaffirmedAt !== computed.lastReaffirmedAt ||
          existing.elapsedSinceReaffirmationMs !== computed.elapsedSinceReaffirmationMs ||
          existing.warningThresholdMs !== computed.warningThresholdMs ||
          existing.breachThresholdMs !== computed.breachThresholdMs ||
          JSON.stringify(existing.reasons) !== JSON.stringify(computed.reasons)
        const next = changed ? computed : existing
        if (!next) continue
        if (changed) {
          await repos.filingEscalationRolloverReaffirmationSlas.upsert(next)
        }
        store.filingEscalationRolloverReaffirmationSlas.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => {
          if (!isFilingEscalationRolloverReaffirmationSlaStatus(statusFilter)) return true
          return row.status === statusFilter
        })
        .filter((row) =>
          reason ? row.reasons.includes(reason as (typeof row.reasons)[number]) : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }
    if (view === "rollover_breach_watches") {
      const packageId = url.searchParams.get("packageId")
      const watchStatus = url.searchParams.get("watchStatus")
      const reason = url.searchParams.get("reason")
      const waiverId = url.searchParams.get("waiverId")
      const now = Date.now()
      const packageById = new Map(firmPackages.map((row) => [row.id, row]))
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(user.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const waiverRows = await repos.filingEscalationBreachWaivers.listByFirm(user.firmId)
      const activeWaiverByPackage = new Map<string, (typeof waiverRows)[number]>()
      for (const row of waiverRows) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
          continue
        }
        if (row.status !== "active" || row.expiresAt <= now) continue
        const current = activeWaiverByPackage.get(row.packageId)
        if (!current || row.updatedAt > current.updatedAt) {
          activeWaiverByPackage.set(row.packageId, row)
        }
      }
      const rolloverRows = await repos.filingEscalationWaiverRolloverAttestations.listByFirm(user.firmId)
      const rolloverByWaiverId = latestRolloverAttestationByWaiver(rolloverRows)
      const persistedRows = await repos.filingEscalationRolloverBreachWatches.listByFirm(user.firmId)
      const rowsByPackage = new Map(persistedRows.map((row) => [row.packageId, row]))
      const candidatePackageIds = new Set<string>([
        ...rowsByPackage.keys(),
        ...activeWaiverByPackage.keys(),
      ])
      for (const pkgId of candidatePackageIds) {
        const filingPackage = packageById.get(pkgId)
        if (!filingPackage) continue
        const existing = rowsByPackage.get(pkgId) ?? null
        const policy = resolveEffectiveEscalationPolicy(pkgId, packageOverrides, defaultPolicy)
        const activeWaiver = activeWaiverByPackage.get(pkgId) ?? null
        const latestAttestation = activeWaiver ? rolloverByWaiverId.get(activeWaiver.id) ?? null : null
        const policyCapExpiresAt = activeWaiver ? activeWaiver.grantedAt + policy.waiverWindowMs : null
        const computed = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
          activeWaiver,
          policyCapExpiresAt,
          latestAttestation,
          linkedPolicyId: policy.sourcePolicyId,
          existing,
          now,
        })
        const changed =
          !existing ||
          existing.status !== computed.status ||
          existing.linkedWaiverId !== computed.linkedWaiverId ||
          existing.linkedAttestationId !== computed.linkedAttestationId ||
          existing.linkedPolicyId !== computed.linkedPolicyId ||
          existing.policyCapExpiresAt !== computed.policyCapExpiresAt ||
          existing.waiverExpiresAt !== computed.waiverExpiresAt ||
          existing.attestationUpdatedAt !== computed.attestationUpdatedAt ||
          JSON.stringify(existing.reasons) !== JSON.stringify(computed.reasons)
        const next = changed ? computed : existing
        if (changed) {
          await repos.filingEscalationRolloverBreachWatches.upsert(next)
        }
        store.filingEscalationRolloverBreachWatches.set(next.id, next)
        rowsByPackage.set(pkgId, next)
      }
      const visible = [...rowsByPackage.values()]
        .filter((row) => (matterId ? row.matterId === matterId : true))
        .filter((row) => (packageId ? row.packageId === packageId : true))
        .filter((row) => (waiverId ? row.linkedWaiverId === waiverId : true))
        .filter((row) => {
          if (!isFilingEscalationRolloverBreachWatchStatus(watchStatus)) return true
          return row.status === watchStatus
        })
        .filter((row) =>
          reason ? row.reasons.includes(reason as (typeof row.reasons)[number]) : true
        )
        .filter((row) => {
          const permission = checkPermission(store, user.id, "draft", row.matterId)
          if (!permission.allow) return false
          return rankOf(user.clearanceLevel) >= rankOf(row.classification)
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      const items = visible.slice(cursor, cursor + limit)
      const nextCursor =
        cursor + items.length < visible.length ? String(cursor + items.length) : null
      return NextResponse.json({
        view,
        items,
        total: visible.length,
        limit,
        cursor,
        nextCursor,
      })
    }

    const visible = firmPackages
      .filter((row) => (matterId ? row.matterId === matterId : true))
      .filter((row) => {
        const permission = checkPermission(store, user.id, "draft", row.matterId)
        if (!permission.allow) return false
        return rankOf(user.clearanceLevel) >= rankOf(row.classification)
      })
      .filter((row) => {
        if (!readiness) return true
        const artifact = artifactByPackage.get(row.id)
        if (!artifact) return readiness === "blocked"
        return artifact.readiness === readiness
      })
      .map((row) => ({
        ...row,
        packetArtifact: artifactByPackage.get(row.id) ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const items = visible.slice(cursor, cursor + limit)
    const nextCursor =
      cursor + items.length < visible.length ? String(cursor + items.length) : null
    return NextResponse.json({
      view,
      items,
      total: visible.length,
      limit,
      cursor,
      nextCursor,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "filings read failed"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function POST(request: Request) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  let key: string
  try {
    key = requireIdempotencyKey(request)
  } catch (err) {
    const message =
      err instanceof IdempotencyError ? err.message : "Idempotency-Key header required"
    return NextResponse.json({ error: message }, { status: 400 })
  }

  let parsed: Body
  try {
    parsed = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!parsed.action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }

  const fingerprint = JSON.stringify({
    route: "/api/d4/filings",
    action: parsed.action,
    body: parsed,
  })
  const replay = idempotency.getReplay(key, fingerprint)
  if (replay.conflict) {
    return NextResponse.json(
      { error: "Idempotency-Key reused with a different request payload" },
      { status: 409 }
    )
  }
  if (replay.body !== undefined) {
    return NextResponse.json({ result: replay.body, idempotencyKey: key, reused: true })
  }

  try {
    if (parsed.action === "create_package") {
      if (
        !parsed.actorId ||
        !parsed.matterId ||
        !parsed.draftId ||
        !isClassification(parsed.classification)
      ) {
        return NextResponse.json(
          { error: "actorId, matterId, draftId, and classification are required" },
          { status: 400 }
        )
      }
      const partnerOverride =
        parsed.partnerOverride?.partnerId || parsed.partnerOverride?.reason
          ? {
              partnerId: parsed.partnerOverride?.partnerId ?? "",
              reason: parsed.partnerOverride?.reason ?? "",
            }
          : undefined
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      const created = createFilingPackage(store, {
        actorId: parsed.actorId,
        matterId: parsed.matterId,
        draftId: parsed.draftId,
        preflight: {
          actorId: parsed.actorId,
          matterId: parsed.matterId,
          classification: parsed.classification,
          citedJudgmentIds: parsed.citedJudgmentIds ?? [],
          temporalCitations: parsed.temporalCitations ?? [],
          partnerOverride,
        },
      })
      await repos.filings.create(created.filingPackage)
      const draft =
        store.drafts.get(created.filingPackage.draftId) ??
        (await repos.drafts.get(created.filingPackage.draftId))
      const packetArtifact = buildFilingPacketArtifactRow(created.filingPackage, draft)
      await repos.filingPacketArtifacts.upsert(packetArtifact)
      store.filingPacketArtifacts.set(packetArtifact.id, packetArtifact)
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "create_package",
        filingPackage:
          (await repos.filings.get(created.filingPackage.id)) ?? created.filingPackage,
        packetArtifact: (await repos.filingPacketArtifacts.get(packetArtifact.id)) ?? packetArtifact,
        preflight: created.preflight,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "decide_package") {
      if (!parsed.actorId || !parsed.packageId || !parsed.decision || !parsed.reason) {
        return NextResponse.json(
          { error: "actorId, packageId, decision, and reason are required" },
          { status: 400 }
        )
      }
      const filingPackage = decideFilingPackage(store, {
        actorId: parsed.actorId,
        packageId: parsed.packageId,
        decision: parsed.decision,
        reason: parsed.reason,
      })
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const priorAuditCount = store.audit.length
      const persisted = await repos.filings.get(filingPackage.id)
      if (persisted) {
        await repos.filings.update(filingPackage.id, {
          status: filingPackage.status,
          approvedBy: filingPackage.approvedBy,
          approvalReason: filingPackage.approvalReason,
        })
      } else {
        await repos.filings.create(filingPackage)
      }
      const draft =
        store.drafts.get(filingPackage.draftId) ?? (await repos.drafts.get(filingPackage.draftId))
      const packetArtifact = buildFilingPacketArtifactRow(filingPackage, draft)
      await repos.filingPacketArtifacts.upsert(packetArtifact)
      store.filingPacketArtifacts.set(packetArtifact.id, packetArtifact)
      const dispatchQueueRow =
        filingPackage.status === "approved" ? buildFilingDispatchQueueRow(filingPackage) : null
      const annexureRow =
        dispatchQueueRow && dispatchQueueRow.status !== "blocked"
          ? buildFilingAnnexureRow(filingPackage, dispatchQueueRow)
          : null
      if (dispatchQueueRow) {
        await repos.filingDispatchQueue.upsert(dispatchQueueRow)
        store.filingDispatchQueue.set(dispatchQueueRow.id, dispatchQueueRow)
      }
      if (annexureRow) {
        await repos.filingAnnexures.upsert(annexureRow)
        store.filingAnnexures.set(annexureRow.id, annexureRow)
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "decide_package",
        filingPackage: (await repos.filings.get(filingPackage.id)) ?? filingPackage,
        packetArtifact: (await repos.filingPacketArtifacts.get(packetArtifact.id)) ?? packetArtifact,
        dispatchQueue:
          dispatchQueueRow &&
          ((await repos.filingDispatchQueue.get(dispatchQueueRow.id)) ?? dispatchQueueRow),
        annexure: annexureRow && ((await repos.filingAnnexures.get(annexureRow.id)) ?? annexureRow),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "dispatch_update") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      if (parsed.nextStatus && !isFilingDispatchQueueStatus(parsed.nextStatus)) {
        return NextResponse.json({ error: "invalid dispatch status" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "associate", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "dispatch queue updates require partner, associate, or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm dispatch update denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      if (filingPackage.status !== "approved") {
        return NextResponse.json(
          { error: "dispatch queue can only be updated for approved filing packages" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const existing =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      if (parsed.assigneeId !== undefined && parsed.assigneeId !== null) {
        const assignee =
          store.users.get(parsed.assigneeId) ?? (await repos.users.get(parsed.assigneeId))
        if (!assignee || assignee.firmId !== actor.firmId) {
          return NextResponse.json({ error: "unknown assignee in actor firm" }, { status: 404 })
        }
      }
      const now = Date.now()
      const note = parsed.note?.trim()
      const nextStatus = parsed.nextStatus ?? existing.status
      const updated = {
        ...existing,
        status: nextStatus,
        assigneeId: parsed.assigneeId === undefined ? existing.assigneeId : parsed.assigneeId,
        retryCount: existing.retryCount + (parsed.markAttempt ? 1 : 0),
        lastAttemptAt: parsed.markAttempt ? now : existing.lastAttemptAt,
        operatorNotes: note
          ? [...existing.operatorNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`]
          : existing.operatorNotes,
        externalDispatchState:
          nextStatus === "handoff_ready" ? "ready_for_firm_dispatch" : "blocked_todo_firm",
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updated)
      store.filingDispatchQueue.set(updated.id, updated)
      const existingAnnexure =
        (await repos.filingAnnexures.get(filingAnnexureId(filingPackage.id))) ??
        buildFilingAnnexureRow(filingPackage, updated)
      const annexure = {
        ...existingAnnexure,
        generationStatus:
          nextStatus === "blocked"
            ? ("blocked" as const)
            : existingAnnexure.generationStatus === "blocked"
              ? ("pending" as const)
              : existingAnnexure.generationStatus,
        operatorNotes:
          nextStatus === "blocked"
            ? [...existingAnnexure.operatorNotes, "dispatch queue moved to blocked status"]
            : existingAnnexure.operatorNotes,
        updatedAt: now,
      }
      await repos.filingAnnexures.upsert(annexure)
      store.filingAnnexures.set(annexure.id, annexure)
      store.audit.push({
        action: "filing_dispatch_update",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: parsed.note?.trim() || parsed.nextStatus || "dispatch queue update",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "dispatch_update",
        dispatchQueue: (await repos.filingDispatchQueue.get(updated.id)) ?? updated,
        annexure: (await repos.filingAnnexures.get(annexure.id)) ?? annexure,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "annexure_checkpoint") {
      if (!parsed.actorId || !parsed.packageId || !parsed.checkpoint) {
        return NextResponse.json(
          { error: "actorId, packageId, and checkpoint are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "associate", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "annexure checkpoints require partner, associate, or clerk role" },
          { status: 403 }
        )
      }
      if (parsed.checkpoint === "record_partner_signoff" && actor.role !== "partner") {
        return NextResponse.json({ error: "partner role required for partner signoff checkpoint" }, { status: 403 })
      }
      if (parsed.checkpoint === "record_clerk_verification" && !["clerk", "partner"].includes(actor.role)) {
        return NextResponse.json({ error: "clerk or partner role required for clerk verification checkpoint" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm annexure checkpoint denied" }, { status: 403 })
      }
      if (filingPackage.status !== "approved") {
        return NextResponse.json(
          { error: "annexure checkpoints require approved filing package" },
          { status: 422 }
        )
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const persistedQueue = await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))
      const queueRow = persistedQueue ?? buildFilingDispatchQueueRow(filingPackage)
      if (!persistedQueue) {
        await repos.filingDispatchQueue.upsert(queueRow)
        store.filingDispatchQueue.set(queueRow.id, queueRow)
      }
      if (queueRow.status === "blocked") {
        return NextResponse.json(
          { error: "annexure checkpoints require non-blocked dispatch queue state" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const existing =
        (await repos.filingAnnexures.get(filingAnnexureId(filingPackage.id))) ??
        buildFilingAnnexureRow(filingPackage, queueRow)
      const now = Date.now()
      const trimmedNote = parsed.note?.trim()
      const nextManifest = [...existing.manifest]
      let generationStatus = existing.generationStatus
      const signerRequirements = { ...existing.signerRequirements }
      if (parsed.checkpoint === "mark_assembling") {
        generationStatus = "assembling"
      } else if (parsed.checkpoint === "mark_artifact_ready") {
        if (!parsed.artifactId) {
          return NextResponse.json({ error: "artifactId is required for mark_artifact_ready" }, { status: 400 })
        }
        const idx = nextManifest.findIndex((item) => item.artifactId === parsed.artifactId)
        if (idx < 0) {
          return NextResponse.json({ error: "unknown annexure artifactId" }, { status: 404 })
        }
        const { note: _ignoredNote, ...withoutNote } = nextManifest[idx]
        nextManifest[idx] = { ...withoutNote, status: "ready" }
      } else if (parsed.checkpoint === "record_partner_signoff") {
        signerRequirements.partnerSignoffBy = actor.id
        signerRequirements.partnerSignoffAt = now
      } else if (parsed.checkpoint === "record_clerk_verification") {
        signerRequirements.clerkVerificationBy = actor.id
        signerRequirements.clerkVerificationAt = now
      } else if (parsed.checkpoint === "mark_ready_for_transport") {
        const candidate = {
          ...existing,
          manifest: nextManifest,
          signerRequirements,
        }
        if (!annexureReadyForTransport(candidate)) {
          return NextResponse.json(
            { error: "annexure is not ready: required artifacts/signoffs missing" },
            { status: 422 }
          )
        }
        generationStatus = "ready"
      }
      const checkpointNote = trimmedNote
        ? `${new Date(now).toISOString()} ${actor.id}: ${parsed.checkpoint} (${trimmedNote})`
        : `${new Date(now).toISOString()} ${actor.id}: ${parsed.checkpoint}`
      const updated = {
        ...existing,
        generationStatus,
        manifest: nextManifest,
        signerRequirements,
        operatorNotes: [...existing.operatorNotes, checkpointNote],
        submissionTransportBoundary: "todo_firm_external_transport_blocked" as const,
        updatedAt: now,
      }
      await repos.filingAnnexures.upsert(updated)
      store.filingAnnexures.set(updated.id, updated)
      store.audit.push({
        action: "filing_annexure_checkpoint",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: parsed.checkpoint,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "annexure_checkpoint",
        annexure: (await repos.filingAnnexures.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_submission_receipt") {
      if (
        !parsed.actorId ||
        !parsed.packageId ||
        !parsed.courtChannel ||
        !parsed.dispatchOutcome ||
        !parsed.submissionReference
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, packageId, courtChannel, dispatchOutcome, and submissionReference are required",
          },
          { status: 400 }
        )
      }
      if (!isFilingSubmissionCourtChannel(parsed.courtChannel)) {
        return NextResponse.json({ error: "invalid courtChannel" }, { status: 400 })
      }
      if (!isFilingSubmissionDispatchOutcome(parsed.dispatchOutcome)) {
        return NextResponse.json({ error: "invalid dispatchOutcome" }, { status: 400 })
      }
      if (parsed.dispatchOutcome === "rejected" && !parsed.failureReason?.trim()) {
        return NextResponse.json(
          { error: "failureReason is required when dispatchOutcome is rejected" },
          { status: 400 }
        )
      }
      if (parsed.dispatchOutcome === "retry_scheduled" && !parsed.retryHint?.trim()) {
        return NextResponse.json(
          { error: "retryHint is required when dispatchOutcome is retry_scheduled" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "record_submission_receipt requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm receipt record denied" }, { status: 403 })
      }
      if (filingPackage.status !== "approved") {
        return NextResponse.json(
          { error: "submission receipt can only be recorded for approved filing packages" },
          { status: 422 }
        )
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const annexure =
        (await repos.filingAnnexures.get(filingAnnexureId(filingPackage.id))) ??
        store.filingAnnexures.get(filingAnnexureId(filingPackage.id))
      if (!annexure || annexure.generationStatus !== "ready") {
        return NextResponse.json(
          { error: "submission receipt requires annexure generationStatus=ready" },
          { status: 422 }
        )
      }
      const priorAuditCount = store.audit.length
      const existingReceipts = await repos.filingSubmissionReceipts.listByPackageId(filingPackage.id)
      const highestAttempt = existingReceipts.reduce(
        (max, row) => (row.attemptNo > max ? row.attemptNo : max),
        0
      )
      const receipt = buildFilingSubmissionReceiptRow(
        filingPackage,
        {
          attemptNo: highestAttempt + 1,
          courtChannel: parsed.courtChannel,
          dispatchOutcome: parsed.dispatchOutcome,
          submissionReference: parsed.submissionReference.trim(),
          failureReason: parsed.failureReason?.trim() || null,
          retryHint: parsed.retryHint?.trim() || null,
          actorId: actor.id,
        },
        { now: Date.now() }
      )
      await repos.filingSubmissionReceipts.upsert(receipt)
      store.filingSubmissionReceipts.set(receipt.id, receipt)
      const existingReconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const note = parsed.note?.trim()
      const reconciliation = buildFilingSubmissionReconciliationRow(
        filingPackage,
        [...existingReceipts, receipt],
        {
          notes: note
            ? [
                ...(existingReconciliation?.notes ?? []),
                `${new Date(receipt.recordedAt).toISOString()} ${actor.id}: ${note}`,
              ]
            : existingReconciliation?.notes ?? [],
        }
      )
      await repos.filingSubmissionReconciliation.upsert(reconciliation)
      store.filingSubmissionReconciliation.set(reconciliation.id, reconciliation)
      let submissionException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (parsed.dispatchOutcome !== "accepted") {
        const source =
          parsed.dispatchOutcome === "rejected"
            ? ("receipt_rejected" as const)
            : ("receipt_retry_scheduled" as const)
        const nextException = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source,
            receipt,
            reconciliation,
            actorId: actor.id,
            note: note ? `auto-raised from receipt outcome ${parsed.dispatchOutcome}: ${note}` : undefined,
            now: receipt.recordedAt,
          },
          submissionException
        )
        await repos.filingSubmissionExceptions.upsert(nextException)
        store.filingSubmissionExceptions.set(nextException.id, nextException)
        submissionException = nextException
      }
      const dispatchQueue = await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))
      const dispatchStatus =
        parsed.dispatchOutcome === "accepted" ? "handoff_ready" : "retry_pending"
      const updatedDispatchQueue = dispatchQueue
        ? {
            ...dispatchQueue,
            status: dispatchStatus,
            operatorNotes: [
              ...dispatchQueue.operatorNotes,
              `${new Date(receipt.recordedAt).toISOString()} ${actor.id}: receipt ${receipt.id} (${parsed.dispatchOutcome})`,
            ],
            updatedAt: Date.now(),
          }
        : null
      if (updatedDispatchQueue) {
        await repos.filingDispatchQueue.upsert(updatedDispatchQueue)
        store.filingDispatchQueue.set(updatedDispatchQueue.id, updatedDispatchQueue)
      }
      store.audit.push({
        action: "filing_submission_receipt_record",
        actorId: actor.id,
        target: receipt.id,
        classification: filingPackage.classification,
        reason: parsed.dispatchOutcome,
      })
      store.audit.push({
        action: "filing_submission_reconciliation_update",
        actorId: actor.id,
        target: reconciliation.id,
        classification: filingPackage.classification,
        reason: reconciliation.status,
      })
      if (submissionException && parsed.dispatchOutcome !== "accepted") {
        store.audit.push({
          action: "filing_submission_exception_raise",
          actorId: actor.id,
          target: submissionException.id,
          classification: filingPackage.classification,
          reason: `${submissionException.source}:${submissionException.severity}`,
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "record_submission_receipt",
        receipt: (await repos.filingSubmissionReceipts.get(receipt.id)) ?? receipt,
        reconciliation:
          (await repos.filingSubmissionReconciliation.get(reconciliation.id)) ?? reconciliation,
        submissionException:
          submissionException &&
          ((await repos.filingSubmissionExceptions.get(submissionException.id)) ?? submissionException),
        dispatchQueue: updatedDispatchQueue
          ? (await repos.filingDispatchQueue.get(updatedDispatchQueue.id)) ?? updatedDispatchQueue
          : null,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reconcile_submission") {
      if (!parsed.actorId || !parsed.packageId || !parsed.status) {
        return NextResponse.json(
          { error: "actorId, packageId, and status are required" },
          { status: 400 }
        )
      }
      if (!isFilingSubmissionReconciliationStatus(parsed.status)) {
        return NextResponse.json({ error: "invalid reconciliation status" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "reconcile_submission requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm reconciliation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const receipts = await repos.filingSubmissionReceipts.listByPackageId(filingPackage.id)
      const current =
        (await repos.filingSubmissionReconciliation.get(
          filingSubmissionReconciliationId(filingPackage.id)
        )) ?? buildFilingSubmissionReconciliationRow(filingPackage, receipts)
      const note = parsed.note?.trim()
      const updated = {
        ...current,
        status: parsed.status,
        notes: note
          ? [...current.notes, `${new Date().toISOString()} ${actor.id}: ${note}`]
          : current.notes,
        updatedAt: Date.now(),
      }
      await repos.filingSubmissionReconciliation.upsert(updated)
      store.filingSubmissionReconciliation.set(updated.id, updated)
      let submissionException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (parsed.status === "needs_retry") {
        const latestReceipt =
          (updated.latestReceiptId &&
            (await repos.filingSubmissionReceipts.get(updated.latestReceiptId))) ||
          null
        const nextException = buildSubmissionExceptionRowFromFailure(
          filingPackage,
          {
            source: "reconciliation_needs_retry",
            receipt: latestReceipt,
            reconciliation: updated,
            actorId: actor.id,
            note: note ? `auto-raised from reconciliation: ${note}` : undefined,
            now: updated.updatedAt,
          },
          submissionException
        )
        await repos.filingSubmissionExceptions.upsert(nextException)
        store.filingSubmissionExceptions.set(nextException.id, nextException)
        submissionException = nextException
      } else if (parsed.status === "reconciled" && submissionException) {
        const now = Date.now()
        const resolved = {
          ...submissionException,
          status: "resolved" as const,
          resolvedBy: actor.id,
          resolvedAt: now,
          resolutionNotes: [
            ...submissionException.resolutionNotes,
            `${new Date(now).toISOString()} ${actor.id}: auto-resolved from reconciliation`,
          ],
          updatedAt: now,
        }
        await repos.filingSubmissionExceptions.upsert(resolved)
        store.filingSubmissionExceptions.set(resolved.id, resolved)
        submissionException = resolved
      }
      store.audit.push({
        action: "filing_submission_reconcile",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: parsed.status,
      })
      if (submissionException && parsed.status === "needs_retry") {
        store.audit.push({
          action: "filing_submission_exception_raise",
          actorId: actor.id,
          target: submissionException.id,
          classification: filingPackage.classification,
          reason: `${submissionException.source}:${submissionException.severity}`,
        })
      }
      if (submissionException && parsed.status === "reconciled") {
        store.audit.push({
          action: "filing_submission_exception_resolve",
          actorId: actor.id,
          target: submissionException.id,
          classification: filingPackage.classification,
          reason: "auto_reconciled",
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "reconcile_submission",
        reconciliation: (await repos.filingSubmissionReconciliation.get(updated.id)) ?? updated,
        submissionException:
          submissionException &&
          ((await repos.filingSubmissionExceptions.get(submissionException.id)) ?? submissionException),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "claim_submission_exception") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "claim_submission_exception requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm exception claim denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim()
      const updated = {
        ...existing,
        status: "claimed" as const,
        escalationOwnerId: existing.escalationOwnerId ?? actor.id,
        claimedBy: actor.id,
        claimedAt: now,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: note
          ? [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`]
          : existing.resolutionNotes,
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_claim",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "claim_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "escalate_submission_exception") {
      if (!parsed.actorId || !parsed.packageId || !parsed.escalationOwnerId) {
        return NextResponse.json(
          { error: "actorId, packageId, and escalationOwnerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "escalate_submission_exception requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm exception escalation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const escalationOwner =
        store.users.get(parsed.escalationOwnerId) ?? (await repos.users.get(parsed.escalationOwnerId))
      if (!escalationOwner || escalationOwner.firmId !== actor.firmId || escalationOwner.role !== "partner") {
        return NextResponse.json(
          { error: "escalationOwnerId must be a partner in actor firm" },
          { status: 422 }
        )
      }
      if (parsed.severity && !isFilingSubmissionExceptionSeverity(parsed.severity)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 })
      }
      if (parsed.slaHours !== undefined) {
        const parsedHours = Number(parsed.slaHours)
        if (!Number.isFinite(parsedHours) || parsedHours < 1 || parsedHours > 168) {
          return NextResponse.json(
            { error: "slaHours must be between 1 and 168" },
            { status: 400 }
          )
        }
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim()
      const updated = {
        ...existing,
        status: "escalated" as const,
        severity: parsed.severity ?? existing.severity,
        escalationOwnerId: escalationOwner.id,
        escalatedBy: actor.id,
        escalatedAt: now,
        slaTargetAt: parsed.slaHours ? now + parsed.slaHours * 60 * 60 * 1000 : existing.slaTargetAt,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNotes: note
          ? [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`]
          : existing.resolutionNotes,
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_escalate",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: `${updated.severity}:${updated.escalationOwnerId}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "escalate_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "resolve_submission_exception") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "resolve_submission_exception requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm exception resolution denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim() || "exception resolved by operator"
      const updated = {
        ...existing,
        status: "resolved" as const,
        resolvedBy: actor.id,
        resolvedAt: now,
        resolutionNotes: [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_resolve",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.status,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "resolve_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reopen_submission_exception") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json(
          { error: "actorId and packageId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "reopen_submission_exception requires partner or clerk role" },
          { status: 403 }
        )
      }
      if (parsed.severity && !isFilingSubmissionExceptionSeverity(parsed.severity)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm exception reopen denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const existing = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "submission exception not found for package" }, { status: 404 })
      }
      const now = Date.now()
      const note = parsed.note?.trim() || "exception reopened by operator"
      const updatedSeverity = parsed.severity ?? existing.severity
      const updated = {
        ...existing,
        status: "open" as const,
        severity: updatedSeverity,
        resolvedBy: null,
        resolvedAt: null,
        lastRaisedAt: now,
        slaTargetAt: now + (updatedSeverity === "critical" ? 2 : updatedSeverity === "high" ? 8 : 24) * 60 * 60 * 1000,
        resolutionNotes: [...existing.resolutionNotes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(updated)
      store.filingSubmissionExceptions.set(updated.id, updated)
      store.audit.push({
        action: "filing_submission_exception_reopen",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.severity,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "reopen_submission_exception",
        submissionException: (await repos.filingSubmissionExceptions.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "mark_transport_blocked") {
      if (!parsed.actorId || !parsed.packageId || !parsed.transportChannel || !parsed.channelPayloadHash) {
        return NextResponse.json(
          { error: "actorId, packageId, transportChannel, and channelPayloadHash are required" },
          { status: 400 }
        )
      }
      if (!isFilingTransportExecutionChannel(parsed.transportChannel)) {
        return NextResponse.json({ error: "invalid transportChannel" }, { status: 400 })
      }
      if (parsed.severity && !isFilingSubmissionExceptionSeverity(parsed.severity)) {
        return NextResponse.json({ error: "invalid severity" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "mark_transport_blocked requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm transport block denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const nextSequenceNo = evidenceRows.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const currentException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const reconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const nextException = buildSubmissionExceptionRowFromFailure(
        filingPackage,
        {
          source: "dispatch_transport_blocked",
          receipt: null,
          reconciliation,
          actorId: actor.id,
          note: parsed.note ?? "transport blocked during deterministic handoff",
          now,
        },
        currentException
      )
      const normalizedException = {
        ...nextException,
        severity: parsed.severity ?? nextException.severity,
      }
      await repos.filingSubmissionExceptions.upsert(normalizedException)
      store.filingSubmissionExceptions.set(normalizedException.id, normalizedException)
      const existingQueue =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      const updatedQueue = {
        ...existingQueue,
        status: "blocked" as const,
        externalDispatchState: "blocked_todo_firm" as const,
        operatorNotes: [
          ...existingQueue.operatorNotes,
          `${new Date(now).toISOString()} ${actor.id}: transport blocked`,
        ],
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updatedQueue)
      store.filingDispatchQueue.set(updatedQueue.id, updatedQueue)
      const evidence = buildFilingTransportExecutionEvidenceRow(
        filingPackage,
        {
          sequenceNo: nextSequenceNo,
          outcome: "transport_blocked",
          transportOperatorId: actor.id,
          transportChannel: parsed.transportChannel,
          channelPayloadHash: parsed.channelPayloadHash,
          deterministicBlockerTags: parsed.blockerTags,
          attachmentPointers: parsed.attachmentPointers,
          relatedReconciliationId: reconciliation?.id ?? null,
          relatedExceptionId: normalizedException.id,
          note: parsed.note,
        },
        { now }
      )
      await repos.filingTransportExecutionEvidence.upsert(evidence)
      store.filingTransportExecutionEvidence.set(evidence.id, evidence)
      store.audit.push({
        action: "filing_transport_execution_evidence_record",
        actorId: actor.id,
        target: evidence.id,
        classification: filingPackage.classification,
        reason: evidence.outcome,
      })
      store.audit.push({
        action: "filing_dispatch_closure_update",
        actorId: actor.id,
        target: updatedQueue.id,
        classification: filingPackage.classification,
        reason: "transport_blocked",
      })
      store.audit.push({
        action: "filing_submission_exception_raise",
        actorId: actor.id,
        target: normalizedException.id,
        classification: filingPackage.classification,
        reason: `${normalizedException.source}:${normalizedException.severity}`,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "mark_transport_blocked",
        evidence: (await repos.filingTransportExecutionEvidence.get(evidence.id)) ?? evidence,
        dispatchQueue: (await repos.filingDispatchQueue.get(updatedQueue.id)) ?? updatedQueue,
        submissionException:
          (await repos.filingSubmissionExceptions.get(normalizedException.id)) ?? normalizedException,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attach_retry_plan") {
      if (!parsed.actorId || !parsed.packageId || !parsed.transportChannel || !parsed.channelPayloadHash) {
        return NextResponse.json(
          { error: "actorId, packageId, transportChannel, and channelPayloadHash are required" },
          { status: 400 }
        )
      }
      if (!isFilingTransportExecutionChannel(parsed.transportChannel)) {
        return NextResponse.json({ error: "invalid transportChannel" }, { status: 400 })
      }
      if (!parsed.attachmentPointers?.some((entry) => entry.trim().length > 0)) {
        return NextResponse.json({ error: "attachmentPointers must include at least one entry" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "attach_retry_plan requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm retry plan attach denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const nextSequenceNo = evidenceRows.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const currentException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const reconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const nextException = buildSubmissionExceptionRowFromFailure(
        filingPackage,
        {
          source: "dispatch_retry_plan",
          receipt: null,
          reconciliation,
          actorId: actor.id,
          note: parsed.note ?? "retry plan attached",
          now,
        },
        currentException
      )
      const normalizedException = {
        ...nextException,
        status: "escalated" as const,
        escalationOwnerId:
          actor.role === "partner" ? actor.id : (currentException?.escalationOwnerId ?? nextException.escalationOwnerId),
        escalatedBy: actor.id,
        escalatedAt: now,
      }
      await repos.filingSubmissionExceptions.upsert(normalizedException)
      store.filingSubmissionExceptions.set(normalizedException.id, normalizedException)
      const existingQueue =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      const updatedQueue = {
        ...existingQueue,
        status: "retry_pending" as const,
        externalDispatchState: "blocked_todo_firm" as const,
        operatorNotes: [
          ...existingQueue.operatorNotes,
          `${new Date(now).toISOString()} ${actor.id}: retry plan attached`,
        ],
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updatedQueue)
      store.filingDispatchQueue.set(updatedQueue.id, updatedQueue)
      const evidence = buildFilingTransportExecutionEvidenceRow(
        filingPackage,
        {
          sequenceNo: nextSequenceNo,
          outcome: "retry_plan_attached",
          transportOperatorId: actor.id,
          transportChannel: parsed.transportChannel,
          channelPayloadHash: parsed.channelPayloadHash,
          attachmentPointers: parsed.attachmentPointers,
          relatedReconciliationId: reconciliation?.id ?? null,
          relatedExceptionId: normalizedException.id,
          note: parsed.note,
        },
        { now }
      )
      await repos.filingTransportExecutionEvidence.upsert(evidence)
      store.filingTransportExecutionEvidence.set(evidence.id, evidence)
      store.audit.push({
        action: "filing_transport_execution_evidence_record",
        actorId: actor.id,
        target: evidence.id,
        classification: filingPackage.classification,
        reason: evidence.outcome,
      })
      store.audit.push({
        action: "filing_dispatch_closure_update",
        actorId: actor.id,
        target: updatedQueue.id,
        classification: filingPackage.classification,
        reason: "retry_plan_attached",
      })
      store.audit.push({
        action: "filing_submission_exception_escalate",
        actorId: actor.id,
        target: normalizedException.id,
        classification: filingPackage.classification,
        reason: normalizedException.severity,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attach_retry_plan",
        evidence: (await repos.filingTransportExecutionEvidence.get(evidence.id)) ?? evidence,
        dispatchQueue: (await repos.filingDispatchQueue.get(updatedQueue.id)) ?? updatedQueue,
        submissionException:
          (await repos.filingSubmissionExceptions.get(normalizedException.id)) ?? normalizedException,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "confirm_delivered") {
      if (!parsed.actorId || !parsed.packageId || !parsed.transportChannel || !parsed.channelPayloadHash) {
        return NextResponse.json(
          { error: "actorId, packageId, transportChannel, and channelPayloadHash are required" },
          { status: 400 }
        )
      }
      if (!isFilingTransportExecutionChannel(parsed.transportChannel)) {
        return NextResponse.json({ error: "invalid transportChannel" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (!["partner", "clerk"].includes(actor.role)) {
        return NextResponse.json(
          { error: "confirm_delivered requires partner or clerk role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm delivery confirm denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const evidenceRows = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const nextSequenceNo = evidenceRows.reduce((max, row) => Math.max(max, row.sequenceNo), 0) + 1
      const reconciliation = await repos.filingSubmissionReconciliation.get(
        filingSubmissionReconciliationId(filingPackage.id)
      )
      const currentException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const resolvedException = currentException
        ? {
            ...currentException,
            status: "resolved" as const,
            resolvedBy: actor.id,
            resolvedAt: now,
            resolutionNotes: [
              ...currentException.resolutionNotes,
              `${new Date(now).toISOString()} ${actor.id}: deterministic delivery confirmed`,
            ],
            updatedAt: now,
          }
        : null
      if (resolvedException) {
        await repos.filingSubmissionExceptions.upsert(resolvedException)
        store.filingSubmissionExceptions.set(resolvedException.id, resolvedException)
      }
      if (reconciliation) {
        const nextReconciliation = {
          ...reconciliation,
          status: "reconciled" as const,
          notes: [
            ...reconciliation.notes,
            `${new Date(now).toISOString()} ${actor.id}: deterministic delivery confirmed`,
          ],
          updatedAt: now,
        }
        await repos.filingSubmissionReconciliation.upsert(nextReconciliation)
        store.filingSubmissionReconciliation.set(nextReconciliation.id, nextReconciliation)
      }
      const existingQueue =
        (await repos.filingDispatchQueue.get(filingDispatchQueueId(filingPackage.id))) ??
        buildFilingDispatchQueueRow(filingPackage)
      const updatedQueue = {
        ...existingQueue,
        status: "handoff_ready" as const,
        externalDispatchState: "ready_for_firm_dispatch" as const,
        operatorNotes: [
          ...existingQueue.operatorNotes,
          `${new Date(now).toISOString()} ${actor.id}: deterministic delivery confirmed`,
        ],
        updatedAt: now,
      }
      await repos.filingDispatchQueue.upsert(updatedQueue)
      store.filingDispatchQueue.set(updatedQueue.id, updatedQueue)
      const evidence = buildFilingTransportExecutionEvidenceRow(
        filingPackage,
        {
          sequenceNo: nextSequenceNo,
          outcome: "confirm_delivered",
          transportOperatorId: actor.id,
          transportChannel: parsed.transportChannel,
          channelPayloadHash: parsed.channelPayloadHash,
          attachmentPointers: parsed.attachmentPointers,
          relatedReceiptId: parsed.relatedReceiptId?.trim() || null,
          relatedReconciliationId: reconciliation?.id ?? null,
          relatedExceptionId: resolvedException?.id ?? null,
          note: parsed.note,
        },
        { now }
      )
      await repos.filingTransportExecutionEvidence.upsert(evidence)
      store.filingTransportExecutionEvidence.set(evidence.id, evidence)
      store.audit.push({
        action: "filing_transport_execution_evidence_record",
        actorId: actor.id,
        target: evidence.id,
        classification: filingPackage.classification,
        reason: evidence.outcome,
      })
      store.audit.push({
        action: "filing_dispatch_closure_update",
        actorId: actor.id,
        target: updatedQueue.id,
        classification: filingPackage.classification,
        reason: "confirm_delivered",
      })
      if (resolvedException) {
        store.audit.push({
          action: "filing_submission_exception_resolve",
          actorId: actor.id,
          target: resolvedException.id,
          classification: filingPackage.classification,
          reason: "confirm_delivered",
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "confirm_delivered",
        evidence: (await repos.filingTransportExecutionEvidence.get(evidence.id)) ?? evidence,
        dispatchQueue: (await repos.filingDispatchQueue.get(updatedQueue.id)) ?? updatedQueue,
        submissionException:
          resolvedException &&
          ((await repos.filingSubmissionExceptions.get(resolvedException.id)) ?? resolvedException),
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_breach") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "acknowledge_breach requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm digest acknowledge denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existingDigest =
        (await repos.filingSubmissionSlaDigests.get(filingSubmissionSlaDigestId(filingPackage.id))) ??
        null
      const exception = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const evidence = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const latestEvidence = [...evidence].sort((a, b) => b.createdAt - a.createdAt || b.sequenceNo - a.sequenceNo)[0] ?? null
      const deliveredEvidenceAt = evidence
        .filter((row) => row.outcome === "confirm_delivered")
        .reduce((max, row) => (row.createdAt > max ? row.createdAt : max), 0)
      const digest = buildSubmissionSlaDigestRow(filingPackage, {
        exception,
        latestEvidence,
        deliveredEvidenceAt: deliveredEvidenceAt > 0 ? deliveredEvidenceAt : null,
        existing: existingDigest,
        now,
      })
      if (digest.breachReasons.length === 0) {
        return NextResponse.json({ error: "no active SLA breach to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "breach acknowledged by partner"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        deferUntil: null,
        deferredBy: null,
        deferredAt: null,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingSubmissionSlaDigests.upsert(updated)
      store.filingSubmissionSlaDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_sla_digest_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.breachReasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_breach",
        digest: (await repos.filingSubmissionSlaDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "defer_window") {
      if (!parsed.actorId || !parsed.packageId || parsed.deferHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and deferHours are required" },
          { status: 400 }
        )
      }
      const deferHours = Number(parsed.deferHours)
      if (!Number.isFinite(deferHours) || deferHours < 1 || deferHours > 168) {
        return NextResponse.json({ error: "deferHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "defer_window requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm digest defer denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const persistedDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const exception = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const evidence = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const latestEvidence = [...evidence].sort((a, b) => b.createdAt - a.createdAt || b.sequenceNo - a.sequenceNo)[0] ?? null
      const deliveredEvidenceAt = evidence
        .filter((row) => row.outcome === "confirm_delivered")
        .reduce((max, row) => (row.createdAt > max ? row.createdAt : max), 0)
      const existingDigest = buildSubmissionSlaDigestRow(filingPackage, {
        exception,
        latestEvidence,
        deliveredEvidenceAt: deliveredEvidenceAt > 0 ? deliveredEvidenceAt : null,
        existing: persistedDigest,
        now,
      })
      if (!existingDigest) {
        return NextResponse.json({ error: "sla digest not found for package" }, { status: 404 })
      }
      if (existingDigest.breachReasons.length === 0) {
        return NextResponse.json({ error: "cannot defer a cleared digest" }, { status: 422 })
      }
      const note = parsed.note?.trim() || `breach deferred by ${deferHours}h`
      const updated = {
        ...existingDigest,
        status: "deferred" as const,
        deferUntil: now + deferHours * 60 * 60 * 1000,
        deferredBy: actor.id,
        deferredAt: now,
        notes: [...existingDigest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingSubmissionSlaDigests.upsert(updated)
      store.filingSubmissionSlaDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_sla_digest_defer",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: String(deferHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "defer_window",
        digest: (await repos.filingSubmissionSlaDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "clear_digest") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "clear_digest requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm digest clear denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const persistedDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const exception = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const evidence = await repos.filingTransportExecutionEvidence.listByPackageId(filingPackage.id)
      const latestEvidence = [...evidence].sort((a, b) => b.createdAt - a.createdAt || b.sequenceNo - a.sequenceNo)[0] ?? null
      const deliveredEvidenceAt = evidence
        .filter((row) => row.outcome === "confirm_delivered")
        .reduce((max, row) => (row.createdAt > max ? row.createdAt : max), 0)
      const existingDigest = buildSubmissionSlaDigestRow(filingPackage, {
        exception,
        latestEvidence,
        deliveredEvidenceAt: deliveredEvidenceAt > 0 ? deliveredEvidenceAt : null,
        existing: persistedDigest,
        now,
      })
      if (!existingDigest) {
        return NextResponse.json({ error: "sla digest not found for package" }, { status: 404 })
      }
      const note = parsed.note?.trim() || "digest cleared by partner"
      const updated = {
        ...existingDigest,
        status: "cleared" as const,
        breachReasons: [],
        staleRetryPlan: false,
        deferUntil: null,
        clearedBy: actor.id,
        clearedAt: now,
        notes: [...existingDigest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingSubmissionSlaDigests.upsert(updated)
      store.filingSubmissionSlaDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_sla_digest_clear",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: "cleared",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "clear_digest",
        digest: (await repos.filingSubmissionSlaDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "assign_primary_owner") {
      if (!parsed.actorId || !parsed.packageId || !parsed.primaryOwnerId) {
        return NextResponse.json(
          { error: "actorId, packageId, and primaryOwnerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "assign_primary_owner requires partner role" },
          { status: 403 }
        )
      }
      const primaryOwner = store.users.get(parsed.primaryOwnerId)
      if (!primaryOwner) {
        return NextResponse.json({ error: "unknown primary owner" }, { status: 404 })
      }
      if (primaryOwner.firmId !== actor.firmId || primaryOwner.role !== "partner") {
        return NextResponse.json(
          { error: "primary owner must be a partner in the same firm" },
          { status: 403 }
        )
      }
      const activeWindowHours =
        parsed.activeWindowHours === undefined ? 24 : Number(parsed.activeWindowHours)
      if (!Number.isFinite(activeWindowHours) || activeWindowHours < 1 || activeWindowHours > 336) {
        return NextResponse.json(
          { error: "activeWindowHours must be between 1 and 336" },
          { status: 400 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rota assignment denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existing =
        (await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))) ??
        null
      const linkedException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const linkedDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const note = parsed.note?.trim() || `primary owner assigned to ${primaryOwner.id}`
      const reassignedPrimary = !!existing && existing.primaryOwnerId !== primaryOwner.id
      const base = buildFilingEscalationOwnerRotaRow(filingPackage, {
        now,
        existing,
        primaryOwnerId: primaryOwner.id,
        backupOwnerId: existing?.backupOwnerId ?? null,
        linkedExceptionId: linkedException?.id ?? null,
        linkedDigestId: linkedDigest?.id ?? null,
        activeWindowMs: activeWindowHours * 60 * 60 * 1000,
        actorId: actor.id,
        note,
      })
      const updated = {
        ...base,
        status: "active" as const,
        activeWindowStartAt: now,
        activeWindowEndAt: now + activeWindowHours * 60 * 60 * 1000,
        handoffRequired: reassignedPrimary && existing?.primaryOwnerId !== null,
        handoffAcknowledgedBy:
          reassignedPrimary && existing?.primaryOwnerId !== null ? null : base.handoffAcknowledgedBy,
        handoffAcknowledgedAt:
          reassignedPrimary && existing?.primaryOwnerId !== null ? null : base.handoffAcknowledgedAt,
        lastAssignedBy: actor.id,
        lastAssignedAt: now,
        revokedBy: null,
        revokedAt: null,
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updated)
      store.filingEscalationOwnerRota.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_rota_assign_primary",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: primaryOwner.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "assign_primary_owner",
        rota: (await repos.filingEscalationOwnerRota.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "set_backup_owner") {
      if (!parsed.actorId || !parsed.packageId || !parsed.backupOwnerId) {
        return NextResponse.json(
          { error: "actorId, packageId, and backupOwnerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "set_backup_owner requires partner role" }, { status: 403 })
      }
      const backupOwner = store.users.get(parsed.backupOwnerId)
      if (!backupOwner) {
        return NextResponse.json({ error: "unknown backup owner" }, { status: 404 })
      }
      if (backupOwner.firmId !== actor.firmId || backupOwner.role !== "partner") {
        return NextResponse.json(
          { error: "backup owner must be a partner in the same firm" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rota backup denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existing =
        (await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))) ??
        null
      const linkedException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const linkedDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const note = parsed.note?.trim() || `backup owner set to ${backupOwner.id}`
      const backupChanged = !existing || existing.backupOwnerId !== backupOwner.id
      const base = buildFilingEscalationOwnerRotaRow(filingPackage, {
        now,
        existing,
        primaryOwnerId:
          existing?.primaryOwnerId ?? linkedException?.escalationOwnerId ?? linkedDigest?.outstandingOwnerId ?? null,
        backupOwnerId: backupOwner.id,
        linkedExceptionId: linkedException?.id ?? null,
        linkedDigestId: linkedDigest?.id ?? null,
        actorId: actor.id,
        note,
      })
      const handoffRequired = backupChanged && !!base.primaryOwnerId
      const updated = {
        ...base,
        status: "active" as const,
        handoffRequired,
        handoffAcknowledgedBy: handoffRequired ? null : base.handoffAcknowledgedBy,
        handoffAcknowledgedAt: handoffRequired ? null : base.handoffAcknowledgedAt,
        lastAssignedBy: actor.id,
        lastAssignedAt: now,
        revokedBy: null,
        revokedAt: null,
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updated)
      store.filingEscalationOwnerRota.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_rota_set_backup",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: backupOwner.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "set_backup_owner",
        rota: (await repos.filingEscalationOwnerRota.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_handoff") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_handoff requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm handoff acknowledge denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const existing = await repos.filingEscalationOwnerRota.get(
        filingEscalationOwnerRotaId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "escalation rota not found for package" }, { status: 404 })
      }
      if (existing.status === "revoked") {
        return NextResponse.json({ error: "cannot acknowledge a revoked assignment" }, { status: 422 })
      }
      if (existing.primaryOwnerId !== actor.id && existing.backupOwnerId !== actor.id) {
        return NextResponse.json({ error: "actor must be assigned in rota to acknowledge handoff" }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const note = parsed.note?.trim() || "handoff acknowledged"
      const updated = {
        ...existing,
        status: "handoff_acknowledged" as const,
        handoffRequired: false,
        handoffAcknowledgedBy: actor.id,
        handoffAcknowledgedAt: now,
        notes: [...existing.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updated)
      store.filingEscalationOwnerRota.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_rota_acknowledge_handoff",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: "handoff_acknowledged",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_handoff",
        rota: (await repos.filingEscalationOwnerRota.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "revoke_assignment") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "revoke_assignment requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rota revoke denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const existing = await repos.filingEscalationOwnerRota.get(
        filingEscalationOwnerRotaId(filingPackage.id)
      )
      if (!existing) {
        return NextResponse.json({ error: "escalation rota not found for package" }, { status: 404 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const note = parsed.note?.trim() || "assignment revoked"
      const updated = {
        ...existing,
        status: "revoked" as const,
        primaryOwnerId: null,
        backupOwnerId: null,
        activeWindowEndAt: now,
        handoffRequired: false,
        handoffAcknowledgedBy: null,
        handoffAcknowledgedAt: null,
        revokedBy: actor.id,
        revokedAt: now,
        notes: [...existing.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updated)
      store.filingEscalationOwnerRota.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_rota_revoke_assignment",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: "revoked",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "revoke_assignment",
        rota: (await repos.filingEscalationOwnerRota.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_owner_drift") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_owner_drift requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json(
          { error: "cross-firm workload acknowledgement denied" },
          { status: 403 }
        )
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const rota = await repos.filingEscalationOwnerRota.get(
        filingEscalationOwnerRotaId(filingPackage.id)
      )
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existing = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const digest = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        existing,
        now,
      })
      if (digest.alertReasons.length === 0) {
        return NextResponse.json({ error: "no active workload alert to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "owner drift acknowledged"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        snoozeUntil: null,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationWorkloadDigests.upsert(updated)
      store.filingEscalationWorkloadDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_workload_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.alertReasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_owner_drift",
        workloadDigest: (await repos.filingEscalationWorkloadDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "rebalance_assignment") {
      if (!parsed.actorId || !parsed.packageId || !parsed.newPrimaryOwnerId) {
        return NextResponse.json(
          { error: "actorId, packageId, and newPrimaryOwnerId are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "rebalance_assignment requires partner role" }, { status: 403 })
      }
      const newPrimary = store.users.get(parsed.newPrimaryOwnerId)
      if (!newPrimary) {
        return NextResponse.json({ error: "unknown new primary owner" }, { status: 404 })
      }
      if (newPrimary.firmId !== actor.firmId || newPrimary.role !== "partner") {
        return NextResponse.json(
          { error: "newPrimaryOwnerId must be a partner in the same firm" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm workload rebalance denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const existingRota =
        (await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))) ??
        null
      const linkedException = await repos.filingSubmissionExceptions.get(
        filingSubmissionExceptionId(filingPackage.id)
      )
      const linkedSlaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const changedOwner = existingRota?.primaryOwnerId !== newPrimary.id
      const note = parsed.note?.trim() || `workload rebalanced to ${newPrimary.id}`
      const baseRota = buildFilingEscalationOwnerRotaRow(filingPackage, {
        now,
        existing: existingRota,
        primaryOwnerId: newPrimary.id,
        backupOwnerId: existingRota?.backupOwnerId ?? null,
        linkedExceptionId: linkedException?.id ?? null,
        linkedDigestId: linkedSlaDigest?.id ?? null,
        actorId: actor.id,
        note,
      })
      const updatedRota = {
        ...baseRota,
        status: "active" as const,
        handoffRequired: changedOwner && existingRota?.primaryOwnerId !== null,
        handoffAcknowledgedBy: null,
        handoffAcknowledgedAt: null,
        lastAssignedBy: actor.id,
        lastAssignedAt: now,
        revokedBy: null,
        revokedAt: null,
        updatedAt: now,
      }
      await repos.filingEscalationOwnerRota.upsert(updatedRota)
      store.filingEscalationOwnerRota.set(updatedRota.id, updatedRota)
      const allRotaRows = await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(allRotaRows)
      const existingDigest = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadCount =
        updatedRota.primaryOwnerId ? (ownerLoadByOwner.get(updatedRota.primaryOwnerId) ?? 0) : 0
      const computedDigest = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota: updatedRota,
        slaDigest: linkedSlaDigest,
        ownerLoadCount,
        existing: existingDigest,
        now,
      })
      const digestNote = `assignment rebalanced to ${newPrimary.id}`
      const updatedDigest = {
        ...computedDigest,
        status: computedDigest.alertReasons.length === 0 ? ("cleared" as const) : ("acknowledged" as const),
        snoozeUntil: null,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        rebalancedBy: actor.id,
        rebalancedAt: now,
        notes: [...computedDigest.notes, `${new Date(now).toISOString()} ${actor.id}: ${digestNote}`],
        updatedAt: now,
      }
      await repos.filingEscalationWorkloadDigests.upsert(updatedDigest)
      store.filingEscalationWorkloadDigests.set(updatedDigest.id, updatedDigest)
      store.audit.push({
        action: "filing_escalation_workload_rebalance",
        actorId: actor.id,
        target: updatedDigest.id,
        classification: filingPackage.classification,
        reason: newPrimary.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "rebalance_assignment",
        rota: (await repos.filingEscalationOwnerRota.get(updatedRota.id)) ?? updatedRota,
        workloadDigest:
          (await repos.filingEscalationWorkloadDigests.get(updatedDigest.id)) ?? updatedDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "snooze_workload_alert") {
      if (!parsed.actorId || !parsed.packageId || parsed.snoozeHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and snoozeHours are required" },
          { status: 400 }
        )
      }
      const snoozeHours = Number(parsed.snoozeHours)
      if (!Number.isFinite(snoozeHours) || snoozeHours < 1 || snoozeHours > 168) {
        return NextResponse.json({ error: "snoozeHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "snooze_workload_alert requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage =
        store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm workload snooze denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const rota = await repos.filingEscalationOwnerRota.get(
        filingEscalationOwnerRotaId(filingPackage.id)
      )
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existing = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const digest = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        existing,
        now,
      })
      if (digest.alertReasons.length === 0) {
        return NextResponse.json({ error: "no active workload alert to snooze" }, { status: 422 })
      }
      const note = parsed.note?.trim() || `workload alert snoozed for ${snoozeHours}h`
      const updated = {
        ...digest,
        status: "snoozed" as const,
        snoozeUntil: now + snoozeHours * 60 * 60 * 1000,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWorkloadDigests.upsert(updated)
      store.filingEscalationWorkloadDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_escalation_workload_snooze",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: String(snoozeHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "snooze_workload_alert",
        workloadDigest: (await repos.filingEscalationWorkloadDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "set_policy_baseline") {
      if (!parsed.actorId) {
        return NextResponse.json({ error: "actorId is required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "set_policy_baseline requires partner role" }, { status: 403 })
      }
      const ownerLoadThreshold =
        parsed.ownerLoadThreshold === undefined ? undefined : Number(parsed.ownerLoadThreshold)
      const handoffSlaHours =
        parsed.handoffSlaHours === undefined ? undefined : Number(parsed.handoffSlaHours)
      const waiverWindowHours =
        parsed.waiverWindowHours === undefined ? undefined : Number(parsed.waiverWindowHours)
      if (
        ownerLoadThreshold !== undefined &&
        (!Number.isFinite(ownerLoadThreshold) || ownerLoadThreshold < 1 || ownerLoadThreshold > 20)
      ) {
        return NextResponse.json({ error: "ownerLoadThreshold must be between 1 and 20" }, { status: 400 })
      }
      if (
        handoffSlaHours !== undefined &&
        (!Number.isFinite(handoffSlaHours) || handoffSlaHours < 1 || handoffSlaHours > 72)
      ) {
        return NextResponse.json({ error: "handoffSlaHours must be between 1 and 72" }, { status: 400 })
      }
      if (
        waiverWindowHours !== undefined &&
        (!Number.isFinite(waiverWindowHours) || waiverWindowHours < 1 || waiverWindowHours > 168)
      ) {
        return NextResponse.json({ error: "waiverWindowHours must be between 1 and 168" }, { status: 400 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      let filingPackage: Awaited<ReturnType<typeof repos.filings.get>> | null = null
      if (parsed.packageId) {
        filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
        if (!filingPackage) {
          return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
        }
        if (filingPackage.firmId !== actor.firmId) {
          return NextResponse.json({ error: "cross-firm policy baseline denied" }, { status: 403 })
        }
        const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
        if (!permission.allow) {
          return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
        }
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const id = filingEscalationPolicyBaselineId({ firmId: actor.firmId, packageId: parsed.packageId ?? null })
      const existing = await repos.filingEscalationPolicyBaselines.get(id)
      const policy = buildFilingEscalationPolicyBaselineRow({
        firmId: actor.firmId,
        actorId: actor.id,
        packageId: filingPackage?.id ?? null,
        matterId: filingPackage?.matterId ?? null,
        classification: filingPackage?.classification ?? "internal",
        ownerLoadThreshold: ownerLoadThreshold === undefined ? undefined : ownerLoadThreshold,
        handoffSlaMs: handoffSlaHours === undefined ? undefined : handoffSlaHours * 60 * 60 * 1000,
        waiverWindowMs: waiverWindowHours === undefined ? undefined : waiverWindowHours * 60 * 60 * 1000,
        now,
        existing,
        note: parsed.note ?? null,
      })
      await repos.filingEscalationPolicyBaselines.upsert(policy)
      store.filingEscalationPolicyBaselines.set(policy.id, policy)
      store.audit.push({
        action: "filing_escalation_policy_set",
        actorId: actor.id,
        target: policy.id,
        classification: policy.classification,
        reason: policy.scope,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "set_policy_baseline",
        policy: (await repos.filingEscalationPolicyBaselines.get(policy.id)) ?? policy,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "grant_breach_waiver") {
      if (!parsed.actorId || !parsed.packageId || !parsed.reason?.trim()) {
        return NextResponse.json(
          { error: "actorId, packageId, and reason are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "grant_breach_waiver requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm waiver grant denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(
        filingPackage.id,
        packageOverrides,
        defaultPolicy
      )
      const durationHours =
        parsed.durationHours === undefined ? policy.waiverWindowMs / (60 * 60 * 1000) : Number(parsed.durationHours)
      if (!Number.isFinite(durationHours) || durationHours < 1 || durationHours > 168) {
        return NextResponse.json({ error: "durationHours must be between 1 and 168" }, { status: 400 })
      }
      const existingWaivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const activeWaiver = existingWaivers.find((row) => row.status === "active" && row.expiresAt > now) ?? null
      if (activeWaiver) {
        return NextResponse.json({ error: "an active waiver already exists for this package" }, { status: 409 })
      }
      const sequenceNo = existingWaivers.length + 1
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existingWorkload = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const rota = await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const baseWorkload = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        ownerLoadThreshold: policy.ownerLoadThreshold,
        handoffSlaMs: policy.handoffSlaMs,
        existing: existingWorkload,
        now,
      })
      const waiver = buildFilingEscalationWaiverLedgerRow(filingPackage, {
        actorId: actor.id,
        sequenceNo,
        reason: parsed.reason,
        durationMs: durationHours * 60 * 60 * 1000,
        now,
        linkedSlaDigestId: slaDigest?.id ?? null,
        linkedWorkloadDigestId: baseWorkload.id,
        note: parsed.note ?? null,
      })
      await repos.filingEscalationBreachWaivers.upsert(waiver)
      store.filingEscalationBreachWaivers.set(waiver.id, waiver)
      const existingExpiryDigest = await repos.filingEscalationWaiverExpiryDigests.get(
        filingEscalationWaiverExpiryDigestId(filingPackage.id)
      )
      const waiverExpiryComputed = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
        activeWaiver: waiver,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingExpiryDigest,
        now,
      })
      const waiverExpiryDigest = {
        ...waiverExpiryComputed,
        status: waiverExpiryComputed.status,
        extendedBy: null,
        extendedAt: null,
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWaiverExpiryDigests.upsert(waiverExpiryDigest)
      store.filingEscalationWaiverExpiryDigests.set(waiverExpiryDigest.id, waiverExpiryDigest)
      const workloadDigest =
        baseWorkload.alertReasons.length > 0
          ? {
              ...baseWorkload,
              status: "snoozed" as const,
              snoozeUntil: waiver.expiresAt,
              notes: [
                ...baseWorkload.notes,
                `${new Date(now).toISOString()} ${actor.id}: waiver granted (${waiver.id})`,
              ],
              updatedAt: now,
              lastEvaluatedAt: now,
            }
          : baseWorkload
      await repos.filingEscalationWorkloadDigests.upsert(workloadDigest)
      store.filingEscalationWorkloadDigests.set(workloadDigest.id, workloadDigest)
      store.audit.push({
        action: "filing_escalation_waiver_grant",
        actorId: actor.id,
        target: waiver.id,
        classification: filingPackage.classification,
        reason: waiver.reason,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "grant_breach_waiver",
        waiver: (await repos.filingEscalationBreachWaivers.get(waiver.id)) ?? waiver,
        waiverExpiryDigest:
          (await repos.filingEscalationWaiverExpiryDigests.get(waiverExpiryDigest.id)) ??
          waiverExpiryDigest,
        workloadDigest:
          (await repos.filingEscalationWorkloadDigests.get(workloadDigest.id)) ?? workloadDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "revoke_breach_waiver") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) {
        return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      }
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "revoke_breach_waiver requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm waiver revoke denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const target =
        (parsed.waiverId
          ? waivers.find((row) => row.id === parsed.waiverId)
          : [...waivers]
              .filter((row) => row.status === "active" && row.expiresAt > now)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]) ?? null
      if (!target) {
        return NextResponse.json({ error: "no matching active waiver found for package" }, { status: 404 })
      }
      const revoked = {
        ...target,
        status: "revoked" as const,
        revokedBy: actor.id,
        revokedAt: now,
        notes: [
          ...target.notes,
          `${new Date(now).toISOString()} ${actor.id}: ${parsed.note?.trim() || "waiver revoked"}`,
        ],
        updatedAt: now,
      }
      await repos.filingEscalationBreachWaivers.upsert(revoked)
      store.filingEscalationBreachWaivers.set(revoked.id, revoked)
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(
        filingPackage.id,
        packageOverrides,
        defaultPolicy
      )
      const rota = await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existingWorkload = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const recomputed = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        ownerLoadThreshold: policy.ownerLoadThreshold,
        handoffSlaMs: policy.handoffSlaMs,
        existing: existingWorkload,
        now,
      })
      const workloadDigest = {
        ...recomputed,
        status:
          recomputed.alertReasons.length === 0
            ? ("cleared" as const)
            : ("open_alert" as const),
        snoozeUntil: null,
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWorkloadDigests.upsert(workloadDigest)
      store.filingEscalationWorkloadDigests.set(workloadDigest.id, workloadDigest)
      const remainingActiveWaiver =
        [...waivers]
          .filter(
            (row) =>
              row.id !== revoked.id &&
              row.status === "active" &&
              row.expiresAt > now
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const existingExpiryDigest = await repos.filingEscalationWaiverExpiryDigests.get(
        filingEscalationWaiverExpiryDigestId(filingPackage.id)
      )
      const waiverExpiryDigest = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
        activeWaiver: remainingActiveWaiver,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingExpiryDigest,
        now,
      })
      await repos.filingEscalationWaiverExpiryDigests.upsert(waiverExpiryDigest)
      store.filingEscalationWaiverExpiryDigests.set(waiverExpiryDigest.id, waiverExpiryDigest)
      store.audit.push({
        action: "filing_escalation_waiver_revoke",
        actorId: actor.id,
        target: revoked.id,
        classification: filingPackage.classification,
        reason: revoked.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "revoke_breach_waiver",
        waiver: (await repos.filingEscalationBreachWaivers.get(revoked.id)) ?? revoked,
        waiverExpiryDigest:
          (await repos.filingEscalationWaiverExpiryDigests.get(waiverExpiryDigest.id)) ??
          waiverExpiryDigest,
        workloadDigest:
          (await repos.filingEscalationWorkloadDigests.get(workloadDigest.id)) ?? workloadDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "record_variance_remediation") {
      if (
        !parsed.actorId ||
        !parsed.packageId ||
        !parsed.justification?.trim() ||
        !isFilingEscalationVarianceRemediationDecision(parsed.decision ?? null) ||
        parsed.expiresInHours === undefined
      ) {
        return NextResponse.json(
          {
            error:
              "actorId, packageId, decision, justification, and expiresInHours are required",
          },
          { status: 400 }
        )
      }
      const expiresInHours = Number(parsed.expiresInHours)
      if (!Number.isFinite(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
        return NextResponse.json({ error: "expiresInHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "record_variance_remediation requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm remediation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const secondApprover =
        parsed.secondApproverId !== undefined ? store.users.get(parsed.secondApproverId) : null
      if (parsed.secondApproverId && !secondApprover) {
        return NextResponse.json({ error: "unknown second approver" }, { status: 404 })
      }
      if (secondApprover) {
        if (
          secondApprover.firmId !== actor.firmId ||
          secondApprover.role !== "partner"
        ) {
          return NextResponse.json(
            { error: "second approver must be a partner in the same firm" },
            { status: 403 }
          )
        }
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      if (requiresSecondApproverForRemediationDecision(parsed.decision) && !secondApprover) {
        return NextResponse.json(
          { error: "temporary_override remediation requires a second approver" },
          { status: 422 }
        )
      }
      const existingRemediations = await repos.filingEscalationVarianceRemediations.listByPackageId(
        filingPackage.id
      )
      for (const row of existingRemediations) {
        if (row.status !== "active") continue
        const superseded = { ...row, status: "superseded" as const, updatedAt: now }
        await repos.filingEscalationVarianceRemediations.upsert(superseded)
        store.filingEscalationVarianceRemediations.set(superseded.id, superseded)
      }
      const policyVarianceDigest = await repos.filingEscalationPolicyVarianceDigests.get(
        filingEscalationPolicyVarianceDigestId(filingPackage.id)
      )
      const remediation = buildFilingEscalationVarianceRemediationRow(filingPackage, {
        sequenceNo: existingRemediations.length + 1,
        decision: parsed.decision,
        justification: parsed.justification,
        actorId: actor.id,
        expiresAt: now + expiresInHours * 60 * 60 * 1000,
        now,
        linkedPolicyVarianceDigestId: policyVarianceDigest?.id ?? null,
        linkedPolicyId: policy.sourcePolicyId,
        secondApproverId: secondApprover?.id ?? null,
        note: parsed.note ?? null,
      })
      await repos.filingEscalationVarianceRemediations.upsert(remediation)
      store.filingEscalationVarianceRemediations.set(remediation.id, remediation)
      const lifecycle = buildFilingEscalationRemediationLifecycleRow(filingPackage, remediation, {
        actorId: actor.id,
        now,
        note: "remediation lifecycle opened",
      })
      await repos.filingEscalationRemediationLifecycles.upsert(lifecycle)
      store.filingEscalationRemediationLifecycles.set(lifecycle.id, lifecycle)
      if (parsed.decision === "rollback") {
        const rollbackOwnerLoad = defaultPolicy?.ownerLoadThreshold ?? DEFAULT_ESCALATION_OWNER_LOAD_THRESHOLD
        const rollbackHandoffSla = defaultPolicy?.handoffSlaMs ?? DEFAULT_ESCALATION_HANDOFF_SLA_MS
        const rollbackWaiverWindow = defaultPolicy?.waiverWindowMs ?? DEFAULT_ESCALATION_WAIVER_WINDOW_MS
        const rollbackPolicy = buildFilingEscalationPolicyBaselineRow({
          firmId: actor.firmId,
          actorId: actor.id,
          packageId: filingPackage.id,
          matterId: filingPackage.matterId,
          classification: filingPackage.classification,
          ownerLoadThreshold: rollbackOwnerLoad,
          handoffSlaMs: rollbackHandoffSla,
          waiverWindowMs: rollbackWaiverWindow,
          note: "rollback remediation recorded",
          now,
        })
        await repos.filingEscalationPolicyBaselines.upsert(rollbackPolicy)
        store.filingEscalationPolicyBaselines.set(rollbackPolicy.id, rollbackPolicy)
      }
      const recomputedVariance = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
        firmDefaultPolicy:
          defaultPolicy ? policyRows.find((row) => row.id === defaultPolicy.id) ?? null : null,
        packagePolicy: latestByUpdatedAt(
          policyRows.filter((row) => row.scope === "package_override" && row.packageId === filingPackage.id)
        ),
        existing: policyVarianceDigest,
        now,
      })
      const varianceDigest =
        remediation.decision === "accepted_risk" || remediation.decision === "temporary_override"
          ? {
              ...recomputedVariance,
              status: "snoozed" as const,
              snoozeUntil: remediation.expiresAt,
              updatedAt: now,
              lastEvaluatedAt: now,
              notes: [
                ...recomputedVariance.notes,
                `${new Date(now).toISOString()} ${actor.id}: remediation recorded (${remediation.id})`,
              ],
            }
          : recomputedVariance
      await repos.filingEscalationPolicyVarianceDigests.upsert(varianceDigest)
      store.filingEscalationPolicyVarianceDigests.set(varianceDigest.id, varianceDigest)
      store.audit.push({
        action: "filing_variance_remediation_record",
        actorId: actor.id,
        target: remediation.id,
        classification: filingPackage.classification,
        reason: remediation.decision,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "record_variance_remediation",
        remediation:
          (await repos.filingEscalationVarianceRemediations.get(remediation.id)) ?? remediation,
        remediationLifecycle:
          (await repos.filingEscalationRemediationLifecycles.get(lifecycle.id)) ?? lifecycle,
        policyVarianceDigest:
          (await repos.filingEscalationPolicyVarianceDigests.get(varianceDigest.id)) ??
          varianceDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "attest_remediation_closure") {
      if (
        !parsed.actorId ||
        !parsed.packageId ||
        !isFilingEscalationRemediationClosureOutcome(parsed.closureOutcome ?? null) ||
        !parsed.note?.trim()
      ) {
        return NextResponse.json(
          { error: "actorId, packageId, closureOutcome, and note are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "attest_remediation_closure requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm remediation closure denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const lifecycles = await repos.filingEscalationRemediationLifecycles.listByPackageId(filingPackage.id)
      const targetLifecycle =
        (parsed.remediationId
          ? lifecycles.find(
              (row) => row.remediationId === parsed.remediationId && row.status === "open"
            )
          : [...lifecycles]
              .filter((row) => row.status === "open")
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]) ?? null
      if (!targetLifecycle) {
        return NextResponse.json({ error: "no open remediation lifecycle found" }, { status: 404 })
      }
      const closureNote = parsed.note.trim()
      const closedLifecycle = {
        ...targetLifecycle,
        status: "closure_attested" as const,
        closureOutcome: parsed.closureOutcome,
        closureAttestedBy: actor.id,
        closureAttestedAt: now,
        notes: [
          ...targetLifecycle.notes,
          `${new Date(now).toISOString()} ${actor.id}: closure ${parsed.closureOutcome} ${closureNote}`,
        ],
        updatedAt: now,
      }
      await repos.filingEscalationRemediationLifecycles.upsert(closedLifecycle)
      store.filingEscalationRemediationLifecycles.set(closedLifecycle.id, closedLifecycle)
      const remediation = await repos.filingEscalationVarianceRemediations.get(targetLifecycle.remediationId)
      if (remediation) {
        const updatedRemediation = {
          ...remediation,
          status: remediationStatusFromClosureOutcome(parsed.closureOutcome),
          updatedAt: now,
        }
        await repos.filingEscalationVarianceRemediations.upsert(updatedRemediation)
        store.filingEscalationVarianceRemediations.set(updatedRemediation.id, updatedRemediation)
      }
      const activeRemediation =
        [...(await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id))]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const pendingClosureLifecycle = latestByUpdatedAt(
        (await repos.filingEscalationRemediationLifecycles.listByPackageId(filingPackage.id)).filter(
          (row) => row.status === "open"
        )
      )
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existingDigest = await repos.filingEscalationRemediationExpiryDigests.get(
        filingEscalationRemediationExpiryDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationRemediationExpiryDigestRow(filingPackage, {
        activeRemediation,
        pendingClosureLifecycle,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingDigest,
        now,
      })
      await repos.filingEscalationRemediationExpiryDigests.upsert(digest)
      store.filingEscalationRemediationExpiryDigests.set(digest.id, digest)
      store.audit.push({
        action: "filing_remediation_closure_attest",
        actorId: actor.id,
        target: closedLifecycle.id,
        classification: filingPackage.classification,
        reason: parsed.closureOutcome,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "attest_remediation_closure",
        remediationLifecycle:
          (await repos.filingEscalationRemediationLifecycles.get(closedLifecycle.id)) ??
          closedLifecycle,
        remediationExpiryDigest:
          (await repos.filingEscalationRemediationExpiryDigests.get(digest.id)) ?? digest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_remediation_expiry") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_remediation_expiry requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm remediation expiry denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const remediations = await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id)
      for (const row of remediations) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
        }
      }
      const activeRemediation =
        [...(await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id))]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const pendingClosureLifecycle = latestByUpdatedAt(
        (await repos.filingEscalationRemediationLifecycles.listByPackageId(filingPackage.id)).filter(
          (row) => row.status === "open"
        )
      )
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existing = await repos.filingEscalationRemediationExpiryDigests.get(
        filingEscalationRemediationExpiryDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationRemediationExpiryDigestRow(filingPackage, {
        activeRemediation,
        pendingClosureLifecycle,
        linkedPolicyId: policy.sourcePolicyId,
        existing,
        now,
      })
      if (digest.reasons.length === 0) {
        return NextResponse.json({ error: "no remediation expiry alert to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "remediation expiry acknowledged"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        snoozeUntil: null,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationRemediationExpiryDigests.upsert(updated)
      store.filingEscalationRemediationExpiryDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_remediation_expiry_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.reasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_remediation_expiry",
        remediationExpiryDigest:
          (await repos.filingEscalationRemediationExpiryDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "snooze_remediation_expiry") {
      if (!parsed.actorId || !parsed.packageId || parsed.snoozeHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and snoozeHours are required" },
          { status: 400 }
        )
      }
      const snoozeHours = Number(parsed.snoozeHours)
      if (!Number.isFinite(snoozeHours) || snoozeHours < 1 || snoozeHours > 168) {
        return NextResponse.json({ error: "snoozeHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "snooze_remediation_expiry requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm remediation expiry snooze denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const remediations = await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id)
      for (const row of remediations) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationVarianceRemediations.upsert(expired)
          store.filingEscalationVarianceRemediations.set(expired.id, expired)
        }
      }
      const activeRemediation =
        [...(await repos.filingEscalationVarianceRemediations.listByPackageId(filingPackage.id))]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const pendingClosureLifecycle = latestByUpdatedAt(
        (await repos.filingEscalationRemediationLifecycles.listByPackageId(filingPackage.id)).filter(
          (row) => row.status === "open"
        )
      )
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existing = await repos.filingEscalationRemediationExpiryDigests.get(
        filingEscalationRemediationExpiryDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationRemediationExpiryDigestRow(filingPackage, {
        activeRemediation,
        pendingClosureLifecycle,
        linkedPolicyId: policy.sourcePolicyId,
        existing,
        now,
      })
      if (digest.reasons.length === 0) {
        return NextResponse.json({ error: "no remediation expiry alert to snooze" }, { status: 422 })
      }
      const note = parsed.note?.trim() || `remediation expiry snoozed for ${snoozeHours}h`
      const updated = {
        ...digest,
        status: "snoozed" as const,
        snoozeUntil: now + snoozeHours * 60 * 60 * 1000,
        acknowledgedBy: null,
        acknowledgedAt: null,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationRemediationExpiryDigests.upsert(updated)
      store.filingEscalationRemediationExpiryDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_remediation_expiry_snooze",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: String(snoozeHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "snooze_remediation_expiry",
        remediationExpiryDigest:
          (await repos.filingEscalationRemediationExpiryDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_rollover_breach") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "acknowledge_rollover_breach requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rollover breach denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      for (const row of waivers) {
        if (row.status === "active" && row.expiresAt <= now) {
          const expired = { ...row, status: "expired" as const, updatedAt: now }
          await repos.filingEscalationBreachWaivers.upsert(expired)
          store.filingEscalationBreachWaivers.set(expired.id, expired)
        }
      }
      const activeWaiver =
        [...(await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id))]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const latestAttestation = activeWaiver
        ? latestByUpdatedAt(
            (await repos.filingEscalationWaiverRolloverAttestations.listByPackageId(filingPackage.id)).filter(
              (row) => row.waiverId === activeWaiver.id
            )
          )
        : null
      const existing = await repos.filingEscalationRolloverBreachWatches.get(
        filingEscalationRolloverBreachWatchId(filingPackage.id)
      )
      const watch = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
        activeWaiver,
        policyCapExpiresAt: activeWaiver ? activeWaiver.grantedAt + policy.waiverWindowMs : null,
        latestAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        existing,
        now,
      })
      if (watch.reasons.length === 0) {
        return NextResponse.json({ error: "no rollover breach watch to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "rollover breach acknowledged"
      const updated = {
        ...watch,
        status: "acknowledged" as const,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...watch.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationRolloverBreachWatches.upsert(updated)
      store.filingEscalationRolloverBreachWatches.set(updated.id, updated)
      store.audit.push({
        action: "filing_rollover_breach_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.reasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_rollover_breach",
        rolloverBreachWatch:
          (await repos.filingEscalationRolloverBreachWatches.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "reaffirm_rollover_attestation") {
      if (!parsed.actorId || !parsed.packageId || !parsed.note?.trim()) {
        return NextResponse.json(
          { error: "actorId, packageId, and note are required" },
          { status: 400 }
        )
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "reaffirm_rollover_attestation requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm rollover reaffirmation denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const activeWaiver =
        (parsed.waiverId
          ? waivers.find((row) => row.id === parsed.waiverId && row.status === "active" && row.expiresAt > now)
          : [...waivers]
              .filter((row) => row.status === "active" && row.expiresAt > now)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]) ?? null
      if (!activeWaiver) {
        return NextResponse.json({ error: "no active waiver found for reaffirmation" }, { status: 404 })
      }
      const attestations = await repos.filingEscalationWaiverRolloverAttestations.listByPackageId(
        filingPackage.id
      )
      const latestAttestation =
        [...attestations]
          .filter((row) => row.waiverId === activeWaiver.id)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      if (!latestAttestation) {
        return NextResponse.json({ error: "no rollover attestation found to reaffirm" }, { status: 404 })
      }
      const reaffirmationText = parsed.note.trim()
      const updatedAttestation = {
        ...latestAttestation,
        notes: [
          ...latestAttestation.notes,
          `${new Date(now).toISOString()} ${actor.id}: reaffirmation ${reaffirmationText}`,
        ],
        updatedAt: now,
      }
      await repos.filingEscalationWaiverRolloverAttestations.upsert(updatedAttestation)
      store.filingEscalationWaiverRolloverAttestations.set(updatedAttestation.id, updatedAttestation)
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existingWatch = await repos.filingEscalationRolloverBreachWatches.get(
        filingEscalationRolloverBreachWatchId(filingPackage.id)
      )
      const watch = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
        activeWaiver,
        policyCapExpiresAt: activeWaiver.grantedAt + policy.waiverWindowMs,
        latestAttestation: updatedAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingWatch,
        now,
      })
      await repos.filingEscalationRolloverBreachWatches.upsert(watch)
      store.filingEscalationRolloverBreachWatches.set(watch.id, watch)
      const warningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
      const breachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
      const existingSla = await repos.filingEscalationRolloverReaffirmationSlas.get(
        filingEscalationRolloverReaffirmationSlaId(filingPackage.id)
      )
      const reaffirmationSla = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
        activeWaiver,
        policyCapExpiresAt: activeWaiver.grantedAt + policy.waiverWindowMs,
        latestAttestation: updatedAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        warningThresholdMs,
        breachThresholdMs,
        existing: existingSla,
        now,
      })
      await repos.filingEscalationRolloverReaffirmationSlas.upsert(reaffirmationSla)
      store.filingEscalationRolloverReaffirmationSlas.set(reaffirmationSla.id, reaffirmationSla)
      store.audit.push({
        action: "filing_rollover_reaffirmation_record",
        actorId: actor.id,
        target: updatedAttestation.id,
        classification: filingPackage.classification,
        reason: activeWaiver.id,
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "reaffirm_rollover_attestation",
        rolloverAttestation:
          (await repos.filingEscalationWaiverRolloverAttestations.get(updatedAttestation.id)) ??
          updatedAttestation,
        rolloverBreachWatch:
          (await repos.filingEscalationRolloverBreachWatches.get(watch.id)) ?? watch,
        rolloverReaffirmationSla:
          (await repos.filingEscalationRolloverReaffirmationSlas.get(reaffirmationSla.id)) ??
          reaffirmationSla,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_rollover_reaffirmation_sla") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_rollover_reaffirmation_sla requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm reaffirmation SLA denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const activeWaiver =
        [...waivers]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const latestAttestation = activeWaiver
        ? latestByUpdatedAt(
            (await repos.filingEscalationWaiverRolloverAttestations.listByPackageId(filingPackage.id)).filter(
              (row) => row.waiverId === activeWaiver.id
            )
          )
        : null
      const warningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
      const breachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
      const existing = await repos.filingEscalationRolloverReaffirmationSlas.get(
        filingEscalationRolloverReaffirmationSlaId(filingPackage.id)
      )
      const row = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
        activeWaiver,
        policyCapExpiresAt: activeWaiver ? activeWaiver.grantedAt + policy.waiverWindowMs : null,
        latestAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        warningThresholdMs,
        breachThresholdMs,
        existing,
        now,
      })
      if (row.reasons.length === 0) {
        return NextResponse.json({ error: "no reaffirmation SLA alert to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "rollover reaffirmation SLA acknowledged"
      const updated = {
        ...row,
        status: "acknowledged" as const,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...row.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationRolloverReaffirmationSlas.upsert(updated)
      store.filingEscalationRolloverReaffirmationSlas.set(updated.id, updated)
      store.audit.push({
        action: "filing_rollover_reaffirmation_sla_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.reasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_rollover_reaffirmation_sla",
        rolloverReaffirmationSla:
          (await repos.filingEscalationRolloverReaffirmationSlas.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_policy_variance") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_policy_variance requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm policy variance denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy } = buildEscalationPolicyMaps(policyRows)
      const defaultPolicyRow = defaultPolicy
        ? policyRows.find((row) => row.id === defaultPolicy.id) ?? null
        : null
      const packagePolicyRow = latestByUpdatedAt(
        policyRows.filter(
          (row) => row.scope === "package_override" && row.packageId === filingPackage.id
        )
      )
      const existing = await repos.filingEscalationPolicyVarianceDigests.get(
        filingEscalationPolicyVarianceDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
        firmDefaultPolicy: defaultPolicyRow,
        packagePolicy: packagePolicyRow,
        existing,
        now,
      })
      if (digest.varianceReasons.length === 0) {
        return NextResponse.json({ error: "no active policy variance to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "policy variance acknowledged"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        snoozeUntil: null,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationPolicyVarianceDigests.upsert(updated)
      store.filingEscalationPolicyVarianceDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_policy_variance_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.varianceReasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_policy_variance",
        policyVarianceDigest:
          (await repos.filingEscalationPolicyVarianceDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "snooze_policy_variance") {
      if (!parsed.actorId || !parsed.packageId || parsed.snoozeHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and snoozeHours are required" },
          { status: 400 }
        )
      }
      const snoozeHours = Number(parsed.snoozeHours)
      if (!Number.isFinite(snoozeHours) || snoozeHours < 1 || snoozeHours > 168) {
        return NextResponse.json({ error: "snoozeHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "snooze_policy_variance requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm policy variance snooze denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy } = buildEscalationPolicyMaps(policyRows)
      const defaultPolicyRow = defaultPolicy
        ? policyRows.find((row) => row.id === defaultPolicy.id) ?? null
        : null
      const packagePolicyRow = latestByUpdatedAt(
        policyRows.filter(
          (row) => row.scope === "package_override" && row.packageId === filingPackage.id
        )
      )
      const existing = await repos.filingEscalationPolicyVarianceDigests.get(
        filingEscalationPolicyVarianceDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationPolicyVarianceDigestRow(filingPackage, {
        firmDefaultPolicy: defaultPolicyRow,
        packagePolicy: packagePolicyRow,
        existing,
        now,
      })
      if (digest.varianceReasons.length === 0) {
        return NextResponse.json({ error: "no active policy variance to snooze" }, { status: 422 })
      }
      const note = parsed.note?.trim() || `policy variance snoozed for ${snoozeHours}h`
      const updated = {
        ...digest,
        status: "snoozed" as const,
        snoozeUntil: now + snoozeHours * 60 * 60 * 1000,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationPolicyVarianceDigests.upsert(updated)
      store.filingEscalationPolicyVarianceDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_policy_variance_snooze",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: String(snoozeHours),
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "snooze_policy_variance",
        policyVarianceDigest:
          (await repos.filingEscalationPolicyVarianceDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "acknowledge_waiver_expiry") {
      if (!parsed.actorId || !parsed.packageId) {
        return NextResponse.json({ error: "actorId and packageId are required" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json(
          { error: "acknowledge_waiver_expiry requires partner role" },
          { status: 403 }
        )
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm waiver expiry denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const priorAuditCount = store.audit.length
      const now = Date.now()
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const activeWaiver =
        [...waivers]
          .filter((row) => row.status === "active" && row.expiresAt > now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const existing = await repos.filingEscalationWaiverExpiryDigests.get(
        filingEscalationWaiverExpiryDigestId(filingPackage.id)
      )
      const digest = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
        activeWaiver,
        linkedPolicyId: policy.sourcePolicyId,
        existing,
        now,
      })
      if (digest.reasons.length === 0) {
        return NextResponse.json({ error: "no waiver expiry alert to acknowledge" }, { status: 422 })
      }
      const note = parsed.note?.trim() || "waiver expiry acknowledged"
      const updated = {
        ...digest,
        status: "acknowledged" as const,
        acknowledgedBy: actor.id,
        acknowledgedAt: now,
        notes: [...digest.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWaiverExpiryDigests.upsert(updated)
      store.filingEscalationWaiverExpiryDigests.set(updated.id, updated)
      store.audit.push({
        action: "filing_waiver_expiry_acknowledge",
        actorId: actor.id,
        target: updated.id,
        classification: filingPackage.classification,
        reason: updated.reasons.join(",") || "none",
      })
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "acknowledge_waiver_expiry",
        waiverExpiryDigest:
          (await repos.filingEscalationWaiverExpiryDigests.get(updated.id)) ?? updated,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    if (parsed.action === "extend_breach_waiver") {
      if (!parsed.actorId || !parsed.packageId || parsed.extendHours === undefined) {
        return NextResponse.json(
          { error: "actorId, packageId, and extendHours are required" },
          { status: 400 }
        )
      }
      const extendHours = Number(parsed.extendHours)
      if (!Number.isFinite(extendHours) || extendHours < 1 || extendHours > 168) {
        return NextResponse.json({ error: "extendHours must be between 1 and 168" }, { status: 400 })
      }
      const actor = store.users.get(parsed.actorId)
      if (!actor) return NextResponse.json({ error: "unknown actor" }, { status: 404 })
      if (actor.role !== "partner") {
        return NextResponse.json({ error: "extend_breach_waiver requires partner role" }, { status: 403 })
      }
      await syncFirmMembers(store, repos, actor.firmId)
      const filingPackage = store.filingPackages.get(parsed.packageId) ?? (await repos.filings.get(parsed.packageId))
      if (!filingPackage) {
        return NextResponse.json({ error: "unknown filing package" }, { status: 404 })
      }
      if (filingPackage.firmId !== actor.firmId) {
        return NextResponse.json({ error: "cross-firm waiver extension denied" }, { status: 403 })
      }
      const permission = checkPermission(store, actor.id, "draft", filingPackage.matterId)
      if (!permission.allow) {
        return NextResponse.json({ error: `permission denied: ${permission.reason}` }, { status: 403 })
      }
      const now = Date.now()
      const priorAuditCount = store.audit.length
      const waivers = await repos.filingEscalationBreachWaivers.listByPackageId(filingPackage.id)
      const target =
        (parsed.waiverId
          ? waivers.find((row) => row.id === parsed.waiverId)
          : [...waivers]
              .filter((row) => row.status === "active" && row.expiresAt > now)
              .sort((a, b) => b.updatedAt - a.updatedAt)[0]) ?? null
      if (!target || target.status !== "active" || target.expiresAt <= now) {
        return NextResponse.json({ error: "no matching active waiver found for extension" }, { status: 404 })
      }
      const note = parsed.note?.trim() || `waiver extended by ${extendHours}h`
      const policyRows = await repos.filingEscalationPolicyBaselines.listByFirm(actor.firmId)
      const { defaultPolicy, packageOverrides } = buildEscalationPolicyMaps(policyRows)
      const policy = resolveEffectiveEscalationPolicy(filingPackage.id, packageOverrides, defaultPolicy)
      const previousExpiresAt = target.expiresAt
      const nextExpiresAt = target.expiresAt + extendHours * 60 * 60 * 1000
      const policyCapExpiresAt = target.grantedAt + policy.waiverWindowMs
      const rolloverCrossesCap = nextExpiresAt > policyCapExpiresAt
      let secondApprover: (typeof actor) | null = null
      if (rolloverCrossesCap) {
        if (!parsed.secondApproverId || !parsed.rolloverJustification?.trim()) {
          return NextResponse.json(
            {
              error:
                "secondApproverId and rolloverJustification are required when extension exceeds policy cap window",
            },
            { status: 422 }
          )
        }
        secondApprover = store.users.get(parsed.secondApproverId) ?? null
        if (!secondApprover) {
          return NextResponse.json({ error: "unknown second approver" }, { status: 404 })
        }
        if (
          secondApprover.firmId !== actor.firmId ||
          secondApprover.role !== "partner"
        ) {
          return NextResponse.json(
            { error: "second approver must be a partner in the same firm" },
            { status: 403 }
          )
        }
      }
      const extendedWaiver = {
        ...target,
        expiresAt: nextExpiresAt,
        notes: [...target.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
      }
      await repos.filingEscalationBreachWaivers.upsert(extendedWaiver)
      store.filingEscalationBreachWaivers.set(extendedWaiver.id, extendedWaiver)
      let rolloverAttestation: Awaited<
        ReturnType<typeof repos.filingEscalationWaiverRolloverAttestations.get>
      > | null = null
      if (rolloverCrossesCap && secondApprover) {
        const existingAttestations = await repos.filingEscalationWaiverRolloverAttestations.listByPackageId(
          filingPackage.id
        )
        const attestation = buildFilingEscalationWaiverRolloverAttestationRow(filingPackage, {
          sequenceNo: existingAttestations.length + 1,
          waiverId: extendedWaiver.id,
          extensionHours: extendHours,
          previousExpiresAt,
          newExpiresAt: nextExpiresAt,
          policyCapExpiresAt,
          actorId: actor.id,
          secondApproverId: secondApprover.id,
          justification: parsed.rolloverJustification ?? "",
          now,
          note: parsed.rolloverNote ?? null,
        })
        await repos.filingEscalationWaiverRolloverAttestations.upsert(attestation)
        store.filingEscalationWaiverRolloverAttestations.set(attestation.id, attestation)
        rolloverAttestation = attestation
      }
      const existingExpiry = await repos.filingEscalationWaiverExpiryDigests.get(
        filingEscalationWaiverExpiryDigestId(filingPackage.id)
      )
      const computedExpiry = buildFilingEscalationWaiverExpiryDigestRow(filingPackage, {
        activeWaiver: extendedWaiver,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingExpiry,
        now,
      })
      const expiryDigest = {
        ...computedExpiry,
        status: "extended" as const,
        extendedBy: actor.id,
        extendedAt: now,
        notes: [...computedExpiry.notes, `${new Date(now).toISOString()} ${actor.id}: ${note}`],
        updatedAt: now,
        lastEvaluatedAt: now,
      }
      await repos.filingEscalationWaiverExpiryDigests.upsert(expiryDigest)
      store.filingEscalationWaiverExpiryDigests.set(expiryDigest.id, expiryDigest)
      const existingRolloverWatch = await repos.filingEscalationRolloverBreachWatches.get(
        filingEscalationRolloverBreachWatchId(filingPackage.id)
      )
      const rolloverWatch = buildFilingEscalationRolloverBreachWatchRow(filingPackage, {
        activeWaiver: extendedWaiver,
        policyCapExpiresAt,
        latestAttestation: rolloverAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        existing: existingRolloverWatch,
        now,
      })
      await repos.filingEscalationRolloverBreachWatches.upsert(rolloverWatch)
      store.filingEscalationRolloverBreachWatches.set(rolloverWatch.id, rolloverWatch)
      const warningThresholdMs = Math.max(HOUR_MS, Math.floor(policy.waiverWindowMs / 2))
      const breachThresholdMs = Math.max(2 * HOUR_MS, policy.waiverWindowMs)
      const existingReaffirmationSla = await repos.filingEscalationRolloverReaffirmationSlas.get(
        filingEscalationRolloverReaffirmationSlaId(filingPackage.id)
      )
      const reaffirmationSla = buildFilingEscalationRolloverReaffirmationSlaRow(filingPackage, {
        activeWaiver: extendedWaiver,
        policyCapExpiresAt,
        latestAttestation: rolloverAttestation,
        linkedPolicyId: policy.sourcePolicyId,
        warningThresholdMs,
        breachThresholdMs,
        existing: existingReaffirmationSla,
        now,
      })
      await repos.filingEscalationRolloverReaffirmationSlas.upsert(reaffirmationSla)
      store.filingEscalationRolloverReaffirmationSlas.set(reaffirmationSla.id, reaffirmationSla)
      const rota = await repos.filingEscalationOwnerRota.get(filingEscalationOwnerRotaId(filingPackage.id))
      const slaDigest = await repos.filingSubmissionSlaDigests.get(
        filingSubmissionSlaDigestId(filingPackage.id)
      )
      const existingWorkload = await repos.filingEscalationWorkloadDigests.get(
        filingEscalationWorkloadDigestId(filingPackage.id)
      )
      const ownerLoadByOwner = buildOwnerActiveLoadCounts(
        await repos.filingEscalationOwnerRota.listByFirm(actor.firmId)
      )
      const ownerLoadCount =
        rota?.primaryOwnerId ? (ownerLoadByOwner.get(rota.primaryOwnerId) ?? 0) : 0
      const baseWorkload = buildFilingEscalationWorkloadDigestRow(filingPackage, {
        rota,
        slaDigest,
        ownerLoadCount,
        ownerLoadThreshold: policy.ownerLoadThreshold,
        handoffSlaMs: policy.handoffSlaMs,
        existing: existingWorkload,
        now,
      })
      const workloadDigest =
        baseWorkload.alertReasons.length > 0
          ? {
              ...baseWorkload,
              status: "snoozed" as const,
              snoozeUntil: extendedWaiver.expiresAt,
              updatedAt: now,
              lastEvaluatedAt: now,
            }
          : baseWorkload
      const normalizedWorkloadDigest =
        ((rolloverWatch.status !== "cleared" && rolloverWatch.reasons.length > 0) ||
          reaffirmationSla.status === "breached" ||
          reaffirmationSla.reasons.includes("cap_crossed_reaffirmation_breached")) &&
        workloadDigest.status === "snoozed"
          ? {
              ...workloadDigest,
              status: "open_alert" as const,
              snoozeUntil: null,
              updatedAt: now,
              lastEvaluatedAt: now,
            }
          : workloadDigest
      await repos.filingEscalationWorkloadDigests.upsert(normalizedWorkloadDigest)
      store.filingEscalationWorkloadDigests.set(normalizedWorkloadDigest.id, normalizedWorkloadDigest)
      store.audit.push({
        action: "filing_escalation_waiver_extend",
        actorId: actor.id,
        target: extendedWaiver.id,
        classification: filingPackage.classification,
        reason: String(extendHours),
      })
      if (rolloverAttestation) {
        store.audit.push({
          action: "filing_waiver_rollover_attest",
          actorId: actor.id,
          target: rolloverAttestation.id,
          classification: filingPackage.classification,
          reason: rolloverAttestation.secondApproverId,
        })
      }
      await persistAuditEntriesSince(store, repos, priorAuditCount)
      const payload = {
        action: "extend_breach_waiver",
        waiver: (await repos.filingEscalationBreachWaivers.get(extendedWaiver.id)) ?? extendedWaiver,
        waiverExpiryDigest:
          (await repos.filingEscalationWaiverExpiryDigests.get(expiryDigest.id)) ?? expiryDigest,
        rolloverAttestation:
          rolloverAttestation
            ? (await repos.filingEscalationWaiverRolloverAttestations.get(rolloverAttestation.id)) ??
              rolloverAttestation
            : null,
        rolloverBreachWatch:
          (await repos.filingEscalationRolloverBreachWatches.get(rolloverWatch.id)) ?? rolloverWatch,
        rolloverReaffirmationSla:
          (await repos.filingEscalationRolloverReaffirmationSlas.get(reaffirmationSla.id)) ??
          reaffirmationSla,
        workloadDigest:
          (await repos.filingEscalationWorkloadDigests.get(normalizedWorkloadDigest.id)) ??
          normalizedWorkloadDigest,
      }
      idempotency.set(key, payload, fingerprint)
      return NextResponse.json({ result: payload, idempotencyKey: key, reused: false })
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : "filing package write failed"
    const status = /preflight blocked/.test(message) ? 422 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
