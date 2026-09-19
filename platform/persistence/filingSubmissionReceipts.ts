import type {
  FilingPackage,
  FilingSubmissionCourtChannel,
  FilingSubmissionDispatchOutcome,
  FilingSubmissionReceiptRow,
  FilingSubmissionReconciliationRow,
  FilingSubmissionReconciliationStatus,
} from "@/platform/spine/store"

export function filingSubmissionReceiptId(packageId: string, attemptNo: number): string {
  return `receipt:${packageId}:${attemptNo}`
}

export function filingSubmissionReconciliationId(packageId: string): string {
  return `reconcile:${packageId}`
}

export function isFilingSubmissionDispatchOutcome(
  value: string | null
): value is FilingSubmissionDispatchOutcome {
  return value === "accepted" || value === "rejected" || value === "retry_scheduled"
}

export function isFilingSubmissionCourtChannel(
  value: string | null
): value is FilingSubmissionCourtChannel {
  return (
    value === "efiling_portal_stub" ||
    value === "physical_counter_stub" ||
    value === "courier_stub"
  )
}

export function isFilingSubmissionReconciliationStatus(
  value: string | null
): value is FilingSubmissionReconciliationStatus {
  return value === "open" || value === "reconciled" || value === "needs_retry"
}

export function buildFilingSubmissionReceiptRow(
  filingPackage: FilingPackage,
  input: {
    attemptNo: number
    courtChannel: FilingSubmissionCourtChannel
    dispatchOutcome: FilingSubmissionDispatchOutcome
    submissionReference: string
    failureReason: string | null
    retryHint: string | null
    actorId: string
  },
  opts?: { now?: number }
): FilingSubmissionReceiptRow {
  const now = opts?.now ?? Date.now()
  return {
    id: filingSubmissionReceiptId(filingPackage.id, input.attemptNo),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    attemptNo: input.attemptNo,
    courtChannel: input.courtChannel,
    dispatchOutcome: input.dispatchOutcome,
    submissionReference: input.submissionReference,
    failureReason: input.failureReason,
    retryHint: input.retryHint,
    recordedBy: input.actorId,
    recordedAt: now,
    submissionTransportBoundary: "todo_firm_external_transport_blocked",
  }
}

function statusFromOutcome(outcome: FilingSubmissionDispatchOutcome): FilingSubmissionReconciliationStatus {
  if (outcome === "accepted") return "reconciled"
  if (outcome === "rejected") return "needs_retry"
  return "open"
}

export function buildFilingSubmissionReconciliationRow(
  filingPackage: FilingPackage,
  receipts: FilingSubmissionReceiptRow[],
  opts?: { now?: number; notes?: string[] }
): FilingSubmissionReconciliationRow {
  const now = opts?.now ?? Date.now()
  const ordered = [...receipts].sort((a, b) => a.attemptNo - b.attemptNo)
  const latest = ordered[ordered.length - 1] ?? null
  return {
    id: filingSubmissionReconciliationId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    totalAttempts: ordered.length,
    latestReceiptId: latest?.id ?? null,
    latestSubmissionReference: latest?.submissionReference ?? null,
    latestDispatchOutcome: latest?.dispatchOutcome ?? null,
    status: latest ? statusFromOutcome(latest.dispatchOutcome) : "open",
    notes: opts?.notes ?? [],
    updatedAt: now,
  }
}
