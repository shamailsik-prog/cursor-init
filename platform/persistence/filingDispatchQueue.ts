import type {
  FilingDispatchQueueRow,
  FilingDispatchQueueStatus,
  FilingPackage,
} from "@/platform/spine/store"

export function filingDispatchQueueId(packageId: string): string {
  return `dispatch:${packageId}`
}

export function isFilingDispatchQueueStatus(
  value: string | null
): value is FilingDispatchQueueStatus {
  return (
    value === "queued" ||
    value === "in_progress" ||
    value === "retry_pending" ||
    value === "handoff_ready" ||
    value === "blocked"
  )
}

export function buildFilingDispatchQueueRow(
  filingPackage: FilingPackage,
  opts?: { now?: number }
): FilingDispatchQueueRow {
  const now = opts?.now ?? Date.now()
  const approved = filingPackage.status === "approved"
  return {
    id: filingDispatchQueueId(filingPackage.id),
    firmId: filingPackage.firmId,
    packageId: filingPackage.id,
    matterId: filingPackage.matterId,
    classification: filingPackage.classification,
    status: approved ? "queued" : "blocked",
    assigneeId: null,
    retryCount: 0,
    lastAttemptAt: null,
    operatorNotes: approved
      ? ["TODO(firm): external court submission transport is not enabled in this environment"]
      : ["package is not approved for dispatch handoff"],
    externalDispatchState: approved ? "blocked_todo_firm" : "blocked_todo_firm",
    updatedAt: now,
  }
}
