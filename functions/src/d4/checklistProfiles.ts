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
  /**
   * A conditional stays open, and blocks filing, until the document is produced
   * or an explicit not-applicable tick records who and when.
   */
  conditional: boolean
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

/** A judgment or warrant does not stand in for the certified copy of the impugned order. */
function coversImpugned(items: readonly ChecklistItem[]): boolean {
  return items.some((item) => /\bcertified\b/i.test(item.label) && /\bimpugned\b/i.test(item.label) && !COMPUTATION.test(item.label))
}

/** An explicit conditional may be closed with a not-applicable tick. A bare limitation line may not. */
const NOT_APPLICABLE = /\bif any\b|\bwhere applicable\b|\bas applicable\b|\bif counsel\b|\bif delayed\b/i
const LIMITATION = /\blimitation\b/i

function allowsNotApplicable(line: string): boolean {
  return NOT_APPLICABLE.test(line)
}

/**
 * A named-document line that lists more than one document becomes one item per
 * document. Commas, " and ", and " / " are separators.
 * PARTNER-RULING-PENDING: may become judgment | (warrant OR jail roll)
 * A trailing "annexed" applies to each part. "annexed and indexed" is one bundle.
 * "and of the appellate court" keeps the document noun from the previous part,
 * so the label names that document and not the court. A shared "Certified copy of"
 * or "Certified copies of" is copied onto each real document. A fragment is never
 * dropped: it takes the inherited document label when one exists, and otherwise
 * the fragment text itself, and the item stays mandatory.
 */
function splitNamedLine(line: string): string[] {
  const annexed = /\bannexed\b/i.test(line)
  const body = line.replace(/\s+and indexed\s*$/i, "").replace(/\s+annexed\s*$/i, "").trim()
  const pieces = body
    .split(/\s*,\s*|\s+\/\s+|\s+and\s+/i)
    .map((part) => part.trim())
    .filter((part) => part !== "")
  if (pieces.length <= 1) return [line]
  const suffix = annexed ? " annexed" : ""
  return withSharedCertifiedCopy(line, pieces).map((part) => `${part.replace(/\s+annexed\s*$/i, "").trim()}${suffix}`)
}

function isForumPhrase(value: string): boolean {
  const text = value.trim()
  if (text === "") return false
  if (/\b(?:judgments?|judgements?|orders?|decrees?|awards?|warrants?|petitions?|plaints?|complaints?|charges?|sentences?|certificates?|records?|notices?|memos?|statements?|copies|copy|fir|bails?)\b/i.test(text)) {
    return false
  }
  return /\b(?:courts?|tribunals?)\b/i.test(text)
}

function leadingFragment(part: string): boolean {
  return /^(?:of|for|to|in|on|with|under|from)\b/i.test(part)
}

/** The previous document, with its last "of the …" possessor replaced by this continuation. */
function inheritCourt(prior: string, court: string): string | null {
  const match = /^(.*)\s+of\s+the\s+\S.*$/i.exec(prior)
  if (match === null) return null
  const stem = match[1]
  if (!/\b(?:judgments?|judgements?|orders?|decrees?|awards?|warrants?|petitions?|plaints?|complaints?|charges?|sentences?|certificates?|records?|notices?|memos?|fir|bails?)\b/i.test(stem)) {
    return null
  }
  return `${stem} of the ${court}`
}

function withSharedCertifiedCopy(original: string, parts: string[]): string[] {
  const plural = /\bcertified copies of\b/i.test(original)
  const singular = /\bcertified copy of\b/i.test(original)
  const certified = plural || singular
  const head = plural ? "Certified copies of" : "Certified copy of"
  const withThe = plural || /\bcertified copy of the\b/i.test(original)
  const labeled: string[] = []
  for (const part of parts) {
    if (certified && /\bcertified cop(?:y|ies)\b/i.test(part)) {
      labeled.push(part)
      continue
    }
    if (!leadingFragment(part)) {
      if (!certified) {
        labeled.push(part)
        continue
      }
      const rest = part.replace(/^the\s+/i, "")
      labeled.push(withThe ? `${head} the ${rest}` : `${head} ${rest}`)
      continue
    }
    const rest = part.replace(/^(?:of|for|to|in|on|with|under|from)\s+/i, "").replace(/^the\s+/i, "")
    const prior = labeled[labeled.length - 1]
    const inherited = prior === undefined ? null : inheritCourt(prior, rest)
    if (isForumPhrase(rest) && inherited !== null) {
      labeled.push(inherited)
      continue
    }
    if (certified && !isForumPhrase(rest)) {
      labeled.push(withThe ? `${head} the ${rest}` : `${head} ${rest}`)
      continue
    }
    if (!isForumPhrase(rest) && inherited !== null) {
      labeled.push(inherited)
      continue
    }
    labeled.push(part)
  }
  return labeled
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

function annexureItem(id: string, label: string, mandatory: boolean, sourceLines: string[], conditional = false): ChecklistItem {
  return {
    id,
    kind: "annexures",
    label,
    mandatory,
    completion: "annexures",
    autoTickWired: true,
    sourceLines,
    conditional,
  }
}

/**
 * The filing items for one verified row, in the spec's order, then the row's other
 * checklist lines. Each mandatory annexure is its own item. An annexure id ticks
 * only the item whose id it is. "if any", "where applicable", "as applicable",
 * "if counsel" and "if delayed" stay conditional. A not-applicable tick closes
 * only those explicit conditionals. An unconditional limitation line still
 * blocks, and a not-applicable tick does not close it. A certified copy,
 * impugned order, judgment, decree or annexed document is mandatory without
 * those phrases. "Affidavit if facts asserted" is mandatory.
 * "judgment and warrant / jail roll" is three documents. One annexure id ticks one item.
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
      conditional: false,
    })
    used.add("pleading")
  }

  for (const line of lines) {
    if (!isSeparateDocument(line)) continue
    for (const part of splitNamedLine(line)) {
      const id = annexureItemId(part, used)
      items.push(annexureItem(id, part, true, [line]))
    }
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
    const unconditional =
      genericLines.some((line) => !EXPLICIT.test(line)) || (genericLines.length === 0 && genericClauses.length > 0)
    const conditional = !unconditional && (conditionalClauses.length > 0 || genericLines.some((line) => allowsNotApplicable(line)))
    const label =
      genericLines.find((line) => !EXPLICIT.test(line)) ??
      genericLines[0] ??
      genericClauses[0] ??
      conditionalClauses[0] ??
      type.annexureRule
    const ruleOnItem = genericClauses.length > 0 || conditionalClauses.length > 0 ? type.annexureRule : null
    items.push(annexureItem("annexures", label, unconditional || conditional, sources(genericLines, ruleOnItem), conditional))
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
      conditional: false,
    })
    used.add("verification")
  }

  const vakalatnamaLines = linesMatching(lines, VAKALATNAMA)
  if (vakalatnamaLines.length > 0) {
    const conditional = vakalatnamaLines.every((line) => allowsNotApplicable(line))
    items.push({
      id: "vakalatnama",
      kind: "vakalatnama",
      label: vakalatnamaLines[0] ?? "Vakalatnama",
      mandatory: conditional || mandatoryFrom(vakalatnamaLines, null, LOOSE),
      completion: "manual",
      autoTickWired: false,
      sourceLines: vakalatnamaLines,
      conditional,
    })
    used.add("vakalatnama")
  }

  const indexLines = linesMatching(lines, INDEX)
  const indexRule = ruleIf(type, INDEX)
  const indexClause = type.annexureRule
    .split(";")
    .map((clause) => clause.replace(/^\s*then\s+/i, "").trim())
    .find((clause) => INDEX.test(clause))
  if (indexLines.length > 0 || indexRule !== null) {
    items.push({
      id: "index_docket",
      kind: "index_docket",
      label: indexLines[0] ?? indexClause ?? "Index",
      mandatory: mandatoryFrom(indexLines, indexRule, LOOSE),
      completion: "docket",
      autoTickWired: false,
      sourceLines: sources(indexLines, indexRule),
      conditional: false,
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
      conditional: false,
    })
    used.add("court_fee")
  }

  // Leftover lines do not by themselves make a filing profile. A notice or a memo
  // whose row names no slot stays unknown, instead of becoming a generic list.
  if (items.length === 0) return []

  for (const line of lines) {
    if (consumed(line)) continue
    const id = specificId(line, used)
    const conditional = allowsNotApplicable(line)
    items.push({
      id,
      kind: "type_specific",
      label: line,
      mandatory: conditional || LIMITATION.test(line),
      completion: "manual",
      autoTickWired: false,
      sourceLines: [line],
      conditional,
    })
  }

  return items
}
