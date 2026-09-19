import type { DraftTemplateAnalyticsRow } from "@/platform/spine/store"
import type { TemplateSummary } from "@/services/d4-1/drafts"

export function draftTemplateAnalyticsId(templateId: string): string {
  return `template:${templateId}`
}

export function buildDraftTemplateAnalyticsRow(
  firmId: string,
  template: TemplateSummary,
  opts?: { now?: number }
): DraftTemplateAnalyticsRow {
  const now = opts?.now ?? Date.now()
  return {
    id: draftTemplateAnalyticsId(template.id),
    firmId,
    templateId: template.id,
    templateName: template.name,
    templatePosture: template.posture,
    templateCategory: template.category,
    composeCount: 0,
    templateSearchCount: 0,
    lastComposedAt: null,
    lastTemplateSearchAt: null,
    lastTemplateSearchQuery: null,
    updatedAt: now,
  }
}

export function withTemplateComposed(
  row: DraftTemplateAnalyticsRow,
  opts?: { now?: number }
): DraftTemplateAnalyticsRow {
  const now = opts?.now ?? Date.now()
  return {
    ...row,
    composeCount: row.composeCount + 1,
    lastComposedAt: now,
    updatedAt: now,
  }
}

export function withTemplateSearchSeen(
  row: DraftTemplateAnalyticsRow,
  query: string,
  opts?: { now?: number }
): DraftTemplateAnalyticsRow {
  const now = opts?.now ?? Date.now()
  return {
    ...row,
    templateSearchCount: row.templateSearchCount + 1,
    lastTemplateSearchAt: now,
    lastTemplateSearchQuery: query,
    updatedAt: now,
  }
}
