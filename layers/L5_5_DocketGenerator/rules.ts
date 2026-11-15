/**
 * Annexure-rule table for the 11 distinct annexureRule strings in
 * data/documentTypes.json (159 types). Matching is exact. An unknown string
 * is not given a scheme.
 *
 * Page size and pagination (L5.5, architecture set p. 121):
 * legal size is a court document and uses odd-number pagination (1, 3, 5,
 * one number per leaf). A4 is correspondence and uses sequential pagination.
 * "odd pagination" in the rule states the same court convention. "page size
 * per forum" is not a size until forumPageSize is supplied.
 */
export type PageSizeSpec = "legal" | "a4" | "forum"
export type PaginationSpec = "odd" | "sequential" | "follow-page-size"

export type SchemeSpec =
  | { kind: "letters"; requireReferenceOrder: boolean }
  | { kind: "enclosures"; requireReferenceOrder: boolean }
  | { kind: "single-a" }
  | { kind: "manual"; requireReferenceOrder: boolean }
  | { kind: "ambiguous"; detail: string }

export type ClassifiedRule = {
  pageSize: PageSizeSpec
  pagination: PaginationSpec
  scheme: SchemeSpec
}

const PETITION =
  "Annexures A, B, C … in the order referred to in the petition; indexed; odd pagination; legal size"
const APPLICATION = "Annexures A, B, C … to the application; affidavit in support; legal size"
const IMPUGNED =
  "Certified copy of the impugned order as Annexure A; then the record relied on; paper-book indexed and paginated; legal size"
const OR_P =
  "Documents relied on as Annexures A, B, C … (or P/1, P/2 … per court practice); indexed; legal size"
const OR_R = "Documents relied on as Annexures D/1, D/2 … (or R/1 …); indexed; legal size"
const SOURCES = "Sources listed at the end; A4"
const SCHEDULES = "Schedules I, II … and annexures for title documents, plans and approvals; A4"
const ATTENDANCE = "Attendance sheet and any papers tabled as annexures; A4"
const EXHIBITS = "Exhibits, if any, marked and referred to in the paragraphs; page size per forum"
const ENCLOSURES = "Enclosures 1, 2 … referenced in the numbered paragraphs; A4"
const SOURCE_DOCUMENT = "Source document attached; A4"

const RULES: Readonly<Record<string, ClassifiedRule>> = {
  [PETITION]: {
    pageSize: "legal",
    pagination: "odd",
    scheme: { kind: "letters", requireReferenceOrder: true },
  },
  [APPLICATION]: {
    pageSize: "legal",
    pagination: "odd",
    scheme: { kind: "letters", requireReferenceOrder: false },
  },
  [IMPUGNED]: {
    pageSize: "legal",
    pagination: "odd",
    scheme: { kind: "single-a" },
  },
  [OR_P]: {
    pageSize: "legal",
    pagination: "odd",
    scheme: {
      kind: "ambiguous",
      detail: "annexure rule states both A, B, C and P/1, P/2",
    },
  },
  [OR_R]: {
    pageSize: "legal",
    pagination: "odd",
    scheme: {
      kind: "ambiguous",
      detail: "annexure rule states both D/1, D/2 and R/1",
    },
  },
  [SOURCES]: {
    pageSize: "a4",
    pagination: "sequential",
    scheme: { kind: "manual", requireReferenceOrder: false },
  },
  [SCHEDULES]: {
    pageSize: "a4",
    pagination: "sequential",
    scheme: {
      kind: "ambiguous",
      detail: "annexure rule states both Schedules I, II and annexures",
    },
  },
  [ATTENDANCE]: {
    pageSize: "a4",
    pagination: "sequential",
    scheme: { kind: "manual", requireReferenceOrder: false },
  },
  [EXHIBITS]: {
    pageSize: "forum",
    pagination: "follow-page-size",
    scheme: { kind: "manual", requireReferenceOrder: true },
  },
  [ENCLOSURES]: {
    pageSize: "a4",
    pagination: "sequential",
    scheme: { kind: "enclosures", requireReferenceOrder: true },
  },
  [SOURCE_DOCUMENT]: {
    pageSize: "a4",
    pagination: "sequential",
    scheme: { kind: "manual", requireReferenceOrder: false },
  },
}

export function knownAnnexureRules(): readonly string[] {
  return Object.keys(RULES)
}

export function classifyAnnexureRule(rule: string): ClassifiedRule | null {
  return RULES[rule.trim()] ?? null
}

export function letterToken(index: number): string | null {
  if (index < 0 || index > 25) return null
  return String.fromCharCode(65 + index)
}
