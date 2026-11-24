/**
 * Fail-closed label scan. Every label-like token in the draft has to be one
 * of the filing set's own tokens. A token with two readings is ambiguous.
 * The only text removed before the scan is the citation allowlist below.
 */

export const PROVED_INDEX_HEADINGS = [
  "LIST OF ANNEXURES",
  "LIST OF EXHIBITS",
  "LIST OF DOCUMENTS",
  "LIST OF ANNEXURE",
  "LIST OF ENCLOSURES",
  "INDEX",
  "INDEX OF ANNEXURES",
  "INDEX OF DOCUMENTS",
] as const

const LABEL_WORD = String.raw`annex(?:ure)?s?|exhibits?|exh|marks?|enclosures?|encl|documents?|docs?`
const EXHIBIT_WORD = String.raw`annex(?:ure)?s?|exhibits?|exh|marks?`

const ALLOWLIST = [
  new RegExp(String.raw`(?<!(?:${LABEL_WORD})\.?\s+)\bC\.?\s*P\.?\s*No\.?\s*[A-Za-z]-\d+\s+of\s+\d{4}\b`, "gi"),
  /\bSuit\s+No\.?\s+\d+\s+of\s+\d{4}\b/gi,
  /\bu\s*\/\s*s\s+\d+\s+(?:CPC|PPC)\b/gi,
  /\bEx\s+parte\b/gi,
]

const TOKEN =
  /[A-Za-z]+(?:-[A-Za-z]+)*\/[A-Za-z](?:\/\d+|-\d+)(?:\/[A-Za-z]|\([A-Za-z]\))?(?![A-Za-z0-9])|(?<![A-Za-z])[A-Z][-./]\d+(?:[A-Za-z]|\([A-Za-z]\)|\/[A-Za-z]|\/\d+)?(?![A-Za-z0-9])|(?<![A-Za-z])[a-z][-/]\d+(?:[A-Za-z]|\([A-Za-z]\)|\/[A-Za-z]|\/\d+)?(?![A-Za-z0-9])|(?<![A-Za-z])[A-Z][ \t]*-[ \t]*[A-Za-z](?![A-Za-z])|(?<![A-Za-z])[A-Z][ \t]+to[ \t]+[A-Za-z](?![A-Za-z])|(?<![A-Za-z0-9])[A-Z](?![A-Za-z0-9])/g

const HEADINGS_BY_LENGTH = [...PROVED_INDEX_HEADINGS].sort((left, right) => right.length - left.length)

export type UnfiledFinding = {
  code: "unfiled_label" | "ambiguous_label"
  detail: string
}

export function isProvedIndexHeading(line: string): boolean {
  const bare = line
    .replace(/[*_#>"'`()]+/g, " ")
    .replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "")
    .replace(/[.:]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
  return PROVED_INDEX_HEADINGS.some((heading) => bare === heading)
}

function prepare(input: string): string {
  return input.normalize("NFKC").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\r\n/g, "\n")
}

function maskAllowlist(input: string): string {
  let text = input
  for (const pattern of ALLOWLIST) {
    text = text.replace(pattern, (match) => " ".repeat(match.length))
  }
  return text
}

function markKey(surface: string): string | null {
  const compact = surface.replace(/\s+/g, "")
  const path = compact.match(/\/([A-Za-z])[/-](\d+)$/)
  if (path) return `${path[1]!.toUpperCase()}/${path[2]}`
  const glued = compact.match(/^([A-Za-z])(\d+)$/)
  if (glued) return `${glued[1]!.toUpperCase()}/${glued[2]}`
  const mark = compact.match(/^([A-Za-z])[-./](\d+)(?:([A-Za-z])|\(([A-Za-z])\)|\/([A-Za-z])|\/(\d+))?$/)
  if (!mark) return null
  if (mark[6]) return `${mark[1]!.toUpperCase()}/${mark[2]}/${mark[6]}`
  const suffix = (mark[3] || mark[4] || mark[5] || "").toUpperCase()
  return `${mark[1]!.toUpperCase()}/${mark[2]}${suffix}`
}

function hasSecondReading(surface: string): boolean {
  return /[-./]\d+(?:[A-Za-z]|\([A-Za-z]\)|\/[A-Za-z])/.test(surface.replace(/\s+/g, ""))
}

function expandRange(surface: string): string[] | null {
  const match = surface.match(/^([A-Z])\s*(?:-|to)\s*([A-Za-z])$/)
  if (!match) return null
  const left = match[1]!.charCodeAt(0)
  const right = match[2]!.toUpperCase().charCodeAt(0)
  if (right < 65 || right > 90 || right < left || right - left > 25) return null
  const letters: string[] = []
  for (let code = left; code <= right; code += 1) letters.push(String.fromCharCode(code))
  return letters
}

function provedKeys(tokens: readonly string[]): Set<string> {
  const keys = new Set<string>()
  for (const token of tokens) {
    const mark = markKey(token.trim())
    // A mark's first letter is not itself a filed token. P-1 does not authorise P.
    keys.add(mark ?? token.trim().toUpperCase())
  }
  return keys
}

export function citationExclusionMatches(text: string): { cp: boolean; suit: boolean; section: boolean; exParte: boolean } {
  const hit = (pattern: RegExp) => new RegExp(pattern.source, pattern.flags).test(text)
  return {
    cp: hit(ALLOWLIST[0]!),
    suit: hit(ALLOWLIST[1]!),
    section: hit(ALLOWLIST[2]!),
    exParte: hit(ALLOWLIST[3]!),
  }
}

function headingEnd(line: string): number | null {
  const upper = line.toUpperCase()
  for (const heading of HEADINGS_BY_LENGTH) {
    let from = 0
    while (from < upper.length) {
      const at = upper.indexOf(heading, from)
      if (at < 0) break
      const before = line.slice(0, at)
      const after = line[at + heading.length] ?? ""
      const okBefore = before.trim() === "" || /[.?!]\s*$/.test(before)
      const okAfter = after === "" || /[^A-Za-z]/.test(after)
      if (okBefore && okAfter) return at + heading.length
      from = at + heading.length
    }
  }
  return null
}

function scanLooseLetters(fragment: string, filed: Set<string>, push: (finding: UnfiledFinding) => void) {
  for (const match of fragment.matchAll(/(?<![A-Za-z])([A-Za-z])(?![A-Za-z0-9]|[-./]\s*\d)/g)) {
    const folded = match[1]!.toUpperCase()
    if (!filed.has(folded)) push({ code: "unfiled_label", detail: `unfiled label "${folded}"` })
  }
}

function scanIndex(text: string, filed: Set<string>, push: (finding: UnfiledFinding) => void) {
  const lines = text.split("\n")
  let inIndex = false
  for (const line of lines) {
    if (line.trim() === "") {
      inIndex = false
      continue
    }
    const end = headingEnd(line)
    if (end !== null) {
      inIndex = true
      scanLooseLetters(line.slice(end).replace(/^\s*:\s*/, ""), filed, push)
      continue
    }
    if (inIndex) {
      scanLooseLetters(line, filed, push)
      continue
    }
    const lead = line.match(/^\s*\d+[.)]\s+([A-Za-z])(?![A-Za-z0-9]|[-./]\s*\d)/)
    if (lead) {
      const folded = lead[1]!.toUpperCase()
      if (!filed.has(folded)) push({ code: "unfiled_label", detail: `unfiled label "${folded}"` })
    }
  }
}

function scanCitationLetters(text: string, filed: Set<string>, push: (finding: UnfiledFinding) => void) {
  const pattern = /\b(?:relies\s+on|rely\s+on|see|refer)\s+([A-Za-z])(?![A-Za-z0-9]|[-./]\s*\d)/gi
  for (const match of text.matchAll(pattern)) {
    const folded = match[1]!.toUpperCase()
    if (!filed.has(folded)) push({ code: "unfiled_label", detail: `unfiled label "${folded}"` })
  }
}

function scanExhibitLabels(text: string, filed: Set<string>, push: (finding: UnfiledFinding) => void) {
  const glued = new RegExp(String.raw`\b(?:${EXHIBIT_WORD})\.?\s+([A-Za-z]\d+)\b`, "gi")
  for (const match of text.matchAll(glued)) {
    const surface = match[1]!
    const key = markKey(surface)
    if (!key || !filed.has(key)) push({ code: "unfiled_label", detail: `unfiled label "${surface}"` })
  }
  const number = new RegExp(String.raw`\b(?:${EXHIBIT_WORD})\.?\s+(?:no\.?\s+)?(\d+)\b`, "gi")
  for (const match of text.matchAll(number)) {
    const surface = match[1]!
    if (!filed.has(surface)) push({ code: "unfiled_label", detail: `unfiled label "${surface}"` })
  }
}

export function unfiledLabelFindings(draft: string, filedTokens: readonly string[]): UnfiledFinding[] {
  const filed = provedKeys(filedTokens)
  const text = maskAllowlist(prepare(draft))
  const findings: UnfiledFinding[] = []
  const seen = new Set<string>()
  const push = (finding: UnfiledFinding) => {
    const key = `${finding.code}\0${finding.detail}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push(finding)
  }
  for (const match of text.matchAll(TOKEN)) {
    const surface = match[0]
    const range = expandRange(surface)
    if (range) {
      for (const letter of range) {
        if (!filed.has(letter)) push({ code: "unfiled_label", detail: `unfiled label "${letter}"` })
      }
      continue
    }
    const key = markKey(surface)
    if (key && hasSecondReading(surface) && !filed.has(key)) {
      push({ code: "ambiguous_label", detail: `ambiguous label "${surface.replace(/\s+/g, "")}"` })
      continue
    }
    if (key) {
      if (!filed.has(key)) push({ code: "unfiled_label", detail: `unfiled label "${surface.replace(/\s+/g, "")}"` })
      continue
    }
    const letter = surface.toUpperCase()
    if (!filed.has(letter)) push({ code: "unfiled_label", detail: `unfiled label "${letter}"` })
  }
  scanCitationLetters(text, filed, push)
  scanExhibitLabels(text, filed, push)
  scanIndex(text, filed, push)
  return findings
}
