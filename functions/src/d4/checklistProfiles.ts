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
const ANNEXURE = /\bannexures?\b|\bannexed\b/i
const EXHIBIT = /\bexhibits?\b/i
const VAKALATNAMA = /\bvakalatnama\b/i
const INDEX = /\bindex(?:ed|ing)?\b|\bdocket\b/i
const COURT_FEE = /\bcourt fee\b/i
/**
 * Explicit conditionals stay optional. "as applicable" is the seed's wording of
 * "where applicable" (judgment particulars as applicable). A bare "if", as in
 * "if counsel" or "if facts asserted", is not one of these phrases.
 */
const EXPLICIT = /\bif any\b|\bwhere applicable\b|\bas applicable\b/i
/** Vakalatnama, the index and the court fee still treat a bare "if" as conditional. */
const LOOSE = /\bif\b|\bwhere applicable\b|\bas applicable\b/i
const NAMED_DOCUMENT = /\bcertified copy\b|\bannexed\b|\bjudgments?\b|\bdecrees?\b|\bimpugned order\b/i
const IMPUGNED_DOCUMENT = /\bcertified copy\b|\bimpugned\b|\bjudgments?\b|\bdecrees?\b/i
const COMPUTATION = /\bdate and limitation\b|\bcomputed\b/i
const RECORD = /\brecord relied on\b/i

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

function mandatoryFrom(checklistLines: readonly string[], rule: string | null, conditional: RegExp): boolean {
  if (checklistLines.length > 0) return checklistLines.some((line) => !conditional.test(line))
  return rule !== null && !conditional.test(rule)
}

function isSeparateDocument(line: string): boolean {
  return NAMED_DOCUMENT.test(line) && !EXPLICIT.test(line) && !COMPUTATION.test(line)
}

function annexureItemId(line: string, used: Set<string>): string {
  const slug = line.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "item"
  let id = `annexure:${slug}`
  let n = 2
  while (used.has(id)) {
    id = `annexure:${slug}_${n}`
    n += 1
  }
  used.add(id)
  return id
}

function coversImpugned(items: readonly ChecklistItem[]): boolean {
  return items.some((item) => IMPUGNED_DOCUMENT.test(item.label) && !COMPUTATION.test(item.label))
}

type ClauseKind = "skip" | "conditional" | "impugned" | "record" | "generic"

function clauseKind(clause: string): ClauseKind {
  if (EXPLICIT.test(clause)) return "conditional"
  if (RECORD.test(clause)) return "record"
  if (IMPUGNED_DOCUMENT.test(clause)) return "impugned"
  if (/\baffidavits?\b/i.test(clause) && !ANNEXURE.test(clause) && !EXHIBIT.test(clause)) return "skip"
  if (/\b(legal size|page size|a4)\b/i.test(clause) && !ANNEXURE.test(clause) && !EXHIBIT.test(clause) && !/\bpaper-?book\b|\bindexed\b/i.test(clause)) {
    return "skip"
  }
  if (ANNEXURE.test(clause) || EXHIBIT.test(clause) || /\bpaper-?book\b|\bindexed\b|\bdocuments relied on\b/i.test(clause)) return "generic"
  return "skip"
}

function isGeneralDocumentBundle(label: string): boolean {
  return /\bdocuments\b/i.test(label) && /\bannexed\b/i.test(label) && !IMPUGNED_DOCUMENT.test(label)
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
  return (
    AFFIDAVIT.test(line) ||
    ANNEXURE.test(line) ||
    EXHIBIT.test(line) ||
    VAKALATNAMA.test(line) ||
    INDEX.test(line) ||
    COURT_FEE.test(line) ||
    isSeparateDocument(line)
  )
}

function annexureItem(id: string, label: string, mandatory: boolean, sourceLines: string[]): ChecklistItem {
  return {
    id,
    kind: "annexures",
    label,
    mandatory,
    completion: "annexures",
    autoTickWired: true,
    sourceLines,
  }
}

/**
 * The filing items for one verified row, in the spec's order, then the row's other
 * checklist lines. Each mandatory annexure is its own item. An annexure id ticks
 * only the item whose id it is. "if any", "where applicable" and "as applicable"
 * stay optional. A certified copy, impugned order, judgment, decree, annexed
 * document or affidavit is mandatory without those phrases. "Affidavit if facts
 * asserted" is mandatory. "Vakalatnama if counsel" stays optional. The Module 44
 * limitation line stays optional: it is the computation, not the certified copy.
 * Other non-slot lines stay visible and do not block filing.
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

  for (const line of lines) {
    if (!isSeparateDocument(line)) continue
    const id = annexureItemId(line, used)
    items.push(annexureItem(id, line, true, [line]))
  }

  const clauses = type.annexureRule
    .split(";")
    .map((clause) => clause.replace(/^\s*then\s+/i, "").trim())
    .filter((clause) => clause !== "")
  const impugnedClauses: string[] = []
  const recordClauses: string[] = []
  const genericClauses: string[] = []
  const conditionalClauses: string[] = []
  for (const clause of clauses) {
    const kind = clauseKind(clause)
    if (kind === "impugned") impugnedClauses.push(clause)
    else if (kind === "record") recordClauses.push(clause)
    else if (kind === "generic") genericClauses.push(clause)
    else if (kind === "conditional") conditionalClauses.push(clause)
  }

  if (!coversImpugned(items)) {
    for (const clause of impugnedClauses) {
      items.push(annexureItem(annexureItemId(clause, used), clause, true, [type.annexureRule]))
    }
  }
  if (!items.some((item) => RECORD.test(item.label))) {
    for (const clause of recordClauses) {
      items.push(annexureItem(annexureItemId(clause, used), clause, true, [type.annexureRule]))
    }
  }

  const genericLines = lines.filter((line) => (ANNEXURE.test(line) || EXHIBIT.test(line)) && !isSeparateDocument(line))
  const bundle = items.find((item) => isGeneralDocumentBundle(item.label))
  const markingOnly = genericClauses.length > 0 && genericLines.length === 0 && bundle !== undefined
  if (markingOnly && bundle) {
    bundle.sourceLines = unique([...bundle.sourceLines, type.annexureRule])
  } else if (genericLines.length > 0 || genericClauses.length > 0 || conditionalClauses.length > 0) {
    const mandatory =
      genericLines.some((line) => !EXPLICIT.test(line)) || (genericLines.length === 0 && genericClauses.length > 0)
    const label =
      genericLines.find((line) => !EXPLICIT.test(line)) ??
      genericLines[0] ??
      genericClauses[0] ??
      conditionalClauses[0] ??
      type.annexureRule
    const ruleOnItem = genericClauses.length > 0 || conditionalClauses.length > 0 ? type.annexureRule : null
    items.push(annexureItem("annexures", label, mandatory, sources(genericLines, ruleOnItem)))
    used.add("annexures")
  }

  const affidavitLines = linesMatching(lines, AFFIDAVIT)
  const affidavitRule = ruleIf(type, AFFIDAVIT)
  if (affidavitLines.length > 0 || affidavitRule !== null) {
    items.push({
      id: "verification",
      kind: "verification",
      label: affidavitLines[0] ?? affidavitRule ?? "Verification",
      mandatory: mandatoryFrom(affidavitLines, affidavitRule, EXPLICIT),
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
      mandatory: mandatoryFrom(vakalatnamaLines, null, LOOSE),
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
      mandatory: mandatoryFrom(indexLines, indexRule, LOOSE),
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
      mandatory: mandatoryFrom(feeLines, null, LOOSE),
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
