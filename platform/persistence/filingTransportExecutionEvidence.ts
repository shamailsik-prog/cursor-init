import type {
  FilingPackage,
  FilingTransportExecutionChannel,
  FilingTransportExecutionEvidenceRow,
  FilingTransportExecutionOutcome,
} from "@/platform/spine/store"
import { filingDispatchQueueId } from "@/platform/persistence/filingDispatchQueue"

export function filingTransportExecutionEvidenceId(packageId: string, sequenceNo: number): string {
  return `transport:${packageId}:${sequenceNo}`
}

export function isFilingTransportExecutionOutcome(
  value: string | null
): value is FilingTransportExecutionOutcome {
  return (
    value === "confirm_delivered" ||
    value === "transport_blocked" ||
    value === "retry_plan_attached"
  )
}

export function isFilingTransportExecutionChannel(
  value: string | null
): value is FilingTransportExecutionChannel {
  return (
    value === "efiling_portal_stub" ||
    value === "physical_counter_stub" ||
    value === "courier_stub" ||
    value === "operator_followup_stub"
  )
}

function sanitizeTags(tags: string[] | undefined): string[] {
  if (!tags) return []
  const canonical = tags
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/[^a-z0-9_:-]/g, "_"))
  return [...new Set(canonical)]
}

export function buildFilingTransportExecutionEvidenceRow(
  filingPackage: FilingPackage,
  input: {
    sequenceNo: number
    outcome: FilingTransportExecutionOutcome
    transportOperatorId: string
    transportChannel: FilingTransportExecutionChannel
    channelPayloadHash: string
    deterministicBlockerTags?: string[]
    attachmentPointers?: string[]
    relatedReceiptId?: string | null
    relatedReconciliationId?: string | null
    relatedExceptionId?: string | null
    note?: string | null
  },
  opts?: { now?: number }
): FilingTransportExecutionEvidenceRow {
  const now = opts?.now ?? Date.now()
  return {
    id: filingTransportExecutionEvidenceId(filingPackage.id, input.sequenceNo),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    sequenceNo: input.sequenceNo,
    dispatchQueueId: filingDispatchQueueId(filingPackage.id),
    outcome: input.outcome,
    transportOperatorId: input.transportOperatorId,
    transportChannel: input.transportChannel,
    channelPayloadHash: input.channelPayloadHash.trim(),
    deterministicBlockerTags: sanitizeTags(input.deterministicBlockerTags),
    attachmentPointers: (input.attachmentPointers ?? []).map((entry) => entry.trim()).filter(Boolean),
    relatedReceiptId: input.relatedReceiptId ?? null,
    relatedReconciliationId: input.relatedReconciliationId ?? null,
    relatedExceptionId: input.relatedExceptionId ?? null,
    note: input.note?.trim() || null,
    createdAt: now,
  }
}
