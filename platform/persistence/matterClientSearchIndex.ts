import type {
  Entity,
  Matter,
  MatterClientSearchIndexRow,
} from "@/platform/spine/store"

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

export function buildMatterSearchIndexRow(
  matter: Matter,
  opts?: { updatedAt?: number }
): MatterClientSearchIndexRow {
  const detail = matter.caseNumber ?? matter.courtId
  return {
    id: `matter:${matter.id}`,
    firmId: matter.firmId,
    rowType: "matter",
    referenceId: matter.id,
    classification: matter.classification,
    label: matter.title,
    detail,
    linkedMatterId: matter.id,
    linkedClientId: matter.clientId,
    status: `${matter.status}:${matter.caseNumberStatus}`,
    tags: uniqueTokens(
      tokenize([matter.title, detail, matter.courtId, matter.clientId].join(" "))
    ),
    updatedAt: opts?.updatedAt ?? Date.now(),
  }
}

export function buildClientSearchIndexRow(
  entity: Entity,
  opts?: { updatedAt?: number }
): MatterClientSearchIndexRow {
  return {
    id: `client:${entity.id}`,
    firmId: entity.firmId,
    rowType: "client",
    referenceId: entity.id,
    classification: entity.classification,
    label: entity.canonicalName,
    detail: entity.phone,
    linkedMatterId: null,
    linkedClientId: entity.id,
    status: "active",
    tags: uniqueTokens(
      tokenize([entity.canonicalName, entity.phone, entity.cnic].join(" "))
    ),
    updatedAt: opts?.updatedAt ?? Date.now(),
  }
}
