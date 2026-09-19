import type { Classification } from "@/platform/p1/types"
import type { WorkflowEvent, WorkflowOpsActivityRow } from "@/platform/spine/store"

type WorkflowOpsSource = WorkflowOpsActivityRow["source"]

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
}

function uniqueTokens(values: string[]): string[] {
  return [...new Set(values)]
}

export function buildWorkflowEventActivityRow(
  event: WorkflowEvent,
  opts?: { sourceAction?: string; source?: WorkflowOpsSource }
): WorkflowOpsActivityRow {
  const source = opts?.source ?? "workflow_event"
  const action = opts?.sourceAction ?? event.action
  return {
    id: `ops:${source}:${event.id}`,
    firmId: event.firmId,
    source,
    action,
    actorId: event.actorId,
    classification: event.classification,
    matterId: event.matterId,
    documentId: event.documentId,
    followUpId: null,
    queueType: null,
    status: event.status,
    detail: event.reason ?? action,
    tags: uniqueTokens(
      tokenize(
        [
          source,
          action,
          event.actorId,
          event.documentId,
          event.matterId ?? "",
          event.status,
          event.reason ?? "",
        ].join(" ")
      )
    ),
    createdAt: event.at,
  }
}

export function buildCourtOpsActivityRow(input: {
  id: string
  firmId: string
  action: string
  actorId: string
  classification: Classification
  matterId: string | null
  documentId: string | null
  followUpId: string | null
  queueType: "follow_up" | "workflow" | null
  status: string | null
  detail: string
  createdAt?: number
}): WorkflowOpsActivityRow {
  const createdAt = input.createdAt ?? Date.now()
  return {
    id: input.id,
    firmId: input.firmId,
    source: "court_ops",
    action: input.action,
    actorId: input.actorId,
    classification: input.classification,
    matterId: input.matterId,
    documentId: input.documentId,
    followUpId: input.followUpId,
    queueType: input.queueType,
    status: input.status,
    detail: input.detail,
    tags: uniqueTokens(
      tokenize(
        [
          "court_ops",
          input.action,
          input.actorId,
          input.matterId ?? "",
          input.documentId ?? "",
          input.followUpId ?? "",
          input.queueType ?? "",
          input.status ?? "",
          input.detail,
        ].join(" ")
      )
    ),
    createdAt,
  }
}
