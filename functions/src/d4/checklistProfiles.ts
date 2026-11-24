/**
 * Filing-checklist derivation for L5.4 (spec lines 3865–3899).
 *
 * Each item is taken from that document type's own row in the verified catalogue
 * (`doctypes.ts`: posture, `annexureRule`, `checklist`). A row that names none of
 * the filing accompaniments yields no items. The caller then returns `{ known: false }`
 * rather than a generic suit list. Court fee is a manual tick copied from the row.
 * This module does not price it, and it does not read a docket.
 */
import type { DocumentType } from "./doctypes"

export const FILING_POSTURES = new Set(["writ", "application", "appeal", "originating_pleading", "responsive_pleading"])

const AFFIDAVIT = /\baffidavits?\b|\bverification\b/i
const ANNEXURE = /\bannexures?\b/i
const EXHIBIT = /\bexhibits?\b/i
const VAKALATNAMA = /\bvakalatnama\b/i
const INDEX = /\bindex(?:ed|ing)?\b|\bdocket\b/i
const COURT_FEE = /\bcourt fee\b/i
const CONDITIONAL = /\bif\b/i

export type ChecklistItemKind =
  | "pleading"
  | "annexures"
  | "verification"
  | "vakalatnama"
  | "index_docket"
  | "court_fee"
  | "type_specific"

export type ChecklistCompletion = "manual" | "affidavit" | "annexures" | "docket"

export type ChecklistItem = {
  id: string
  kind: ChecklistItemKind
  label: string
  mandatory: boolean
  completion: ChecklistCompletion
  /** Annexure ids and the affidavit id tick those items. The docket id does not, until L5.5. */
  autoTickWired: boolean
  sourceLines: string[]
}

function unique(lines: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

function mandatoryFrom(checklistLines: readonly string[], rule: string | null): boolean {
  if (checklistLines.length > 0) return checklistLines.some((line) => !CONDITIONAL.test(line))
  return rule !== null && !CONDITIONAL.test(rule)
}

function ruleIf(type: DocumentType, pattern: RegExp): string | null {
  return pattern.test(type.annexureRule) ? type.annexureRule : null
}

function linesMatching(lines: readonly string[], pattern: RegExp): string[] {
  return lines.filter((line) => pattern.test(line))
}

function sources(checklistLines: readonly string[], rule: string | null): string[] {
  return unique([...checklistLines, ...(rule === null ? [] : [rule])])
}

function specificId(line: string, used: Set<string>): string {
  const slug = line.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "item"
  let id = `specific:${slug}`
  let n = 2
  while (used.has(id)) {
    id = `specific:${slug}_${n}`
    n += 1
  }
  used.add(id)
  return id
}

function consumed(line: string): boolean {
  return AFFIDAVIT.test(line) || ANNEXURE.test(line) || EXHIBIT.test(line) || VAKALATNAMA.test(line) || INDEX.test(line) || COURT_FEE.test(line)
}

/**
 * The filing items for one verified row, in the spec's order, then the row's other
 * checklist lines. Conditional evidence ("if", "if any") is not mandatory: the row
 * itself makes that accompaniment conditional. Lines that are not one of the filing
 * slots stay on the list so the row is not dropped, and they do not block filing.
 * Blocking on them would re-do the citation gate and the F06 review checklist.
 */
export function itemsForDocumentType(type: DocumentType): ChecklistItem[] {
  const lines = unique(type.checklist)
  const items: ChecklistItem[] = []
  const used = new Set<string>()

  if (FILING_POSTURES.has(type.posture)) {
    items.push({
      id: "pleading",
      kind: "pleading",
      label: `Pleading: ${type.name}`,
      mandatory: true,
      completion: "manual",
      autoTickWired: false,
      sourceLines: [type.name],
    })
    used.add("pleading")
  }

  const annexLines = linesMatching(lines, ANNEXURE)
  const exhibitLines = linesMatching(lines, EXHIBIT)
  const annexChecklist = unique([...annexLines, ...exhibitLines])
  const annexRule = ruleIf(type, ANNEXURE) ?? ruleIf(type, EXHIBIT)
  if (annexChecklist.length > 0 || annexRule !== null) {
    items.push({
      id: "annexures",
      kind: "annexures",
      label: annexChecklist[0] ?? annexRule ?? type.annexureRule,
      mandatory: mandatoryFrom(annexChecklist, annexRule),
      completion: "annexures",
      autoTickWired: true,
      sourceLines: sources(annexChecklist, annexRule),
    })
    used.add("annexures")
  }

  const affidavitLines = linesMatching(lines, AFFIDAVIT)
  const affidavitRule = ruleIf(type, AFFIDAVIT)
  if (affidavitLines.length > 0 || affidavitRule !== null) {
    items.push({
      id: "verification",
      kind: "verification",
      label: affidavitLines[0] ?? affidavitRule ?? "Verification",
      mandatory: mandatoryFrom(affidavitLines, affidavitRule),
      completion: "affidavit",
      autoTickWired: true,
      sourceLines: sources(affidavitLines, affidavitRule),
    })
    used.add("verification")
  }

  const vakalatnamaLines = linesMatching(lines, VAKALATNAMA)
  if (vakalatnamaLines.length > 0) {
    items.push({
      id: "vakalatnama",
      kind: "vakalatnama",
      label: vakalatnamaLines[0] ?? "Vakalatnama",
      mandatory: mandatoryFrom(vakalatnamaLines, null),
      completion: "manual",
      autoTickWired: false,
      sourceLines: vakalatnamaLines,
    })
    used.add("vakalatnama")
  }

  const indexLines = linesMatching(lines, INDEX)
  const indexRule = ruleIf(type, INDEX)
  if (indexLines.length > 0 || indexRule !== null) {
    items.push({
      id: "index_docket",
      kind: "index_docket",
      label: indexLines[0] ?? indexRule ?? "Index",
      mandatory: mandatoryFrom(indexLines, indexRule),
      completion: "docket",
      autoTickWired: false,
      sourceLines: sources(indexLines, indexRule),
    })
    used.add("index_docket")
  }

  const feeLines = linesMatching(lines, COURT_FEE)
  if (feeLines.length > 0) {
    items.push({
      id: "court_fee",
      kind: "court_fee",
      label: feeLines[0] ?? "Court fee",
      mandatory: mandatoryFrom(feeLines, null),
      completion: "manual",
      autoTickWired: false,
      sourceLines: feeLines,
    })
    used.add("court_fee")
  }

  // Leftover lines do not by themselves make a filing profile. A notice or a memo
  // whose row names no slot stays unknown, instead of becoming a generic list.
  if (items.length === 0) return []

  for (const line of lines) {
    if (consumed(line)) continue
    const id = specificId(line, used)
    items.push({
      id,
      kind: "type_specific",
      label: line,
      mandatory: false,
      completion: "manual",
      autoTickWired: false,
      sourceLines: [line],
    })
  }

  return items
}
