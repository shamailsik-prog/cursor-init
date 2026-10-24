/** Parse helpers for F32 TTL static rules checks (R116 / R117). */

export type RulesMatchBlock = { path: string; body: string }

type QuoteState = "'" | '"' | null

export function stripRulesComments(rules: string): string {
  let out = ""
  let i = 0
  let quote: QuoteState = null
  let escape = false
  while (i < rules.length) {
    const ch = rules[i]
    const next = rules[i + 1]

    if (quote) {
      out += ch
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === quote) {
        quote = null
      }
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i++
      continue
    }

    if (ch === "/" && next === "/") {
      i += 2
      while (i < rules.length && rules[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < rules.length && !(rules[i] === "*" && rules[i + 1] === "/")) i++
      i += 2
      continue
    }

    out += ch
    i++
  }
  return out
}

export function normalizeRuleBody(body: string): string {
  return stripRulesComments(body).replace(/\s+/g, " ").trim()
}

export function extractMatchBlocks(rules: string): RulesMatchBlock[] {
  const cleaned = stripRulesComments(rules)
  const blocks: RulesMatchBlock[] = []
  const re = /match\s+(\S+)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    const path = m[1]
    let depth = 1
    let j = m.index + m[0].length
    let body = ""
    while (j < cleaned.length && depth > 0) {
      const ch = cleaned[j]
      if (ch === "{") depth++
      else if (ch === "}") depth--
      if (depth > 0) body += ch
      j++
    }
    blocks.push({ path, body })
  }
  return blocks
}

function isPlainVariableSegment(segment: string): boolean {
  return /^\{[^{}=]+\}$/.test(segment)
}

export function pathIsAllPlainVariableSegments(path: string): boolean {
  const segments = path.split("/").filter(Boolean)
  return segments.length > 0 && segments.every((seg) => isPlainVariableSegment(seg))
}

function segmentHasRecursiveWildcard(segment: string): boolean {
  return segment.includes("=**")
}

function isCollectionNameSegmentIndex(index: number): boolean {
  return index % 2 === 0
}

/** True when a rules path could apply to documents in this collection group. */
export function matchPathAppliesToCollectionGroup(path: string, collectionGroup: string): boolean {
  if (path.includes("{document=**}")) return true
  if (pathIsAllPlainVariableSegments(path)) return true
  const segments = path.split("/").filter(Boolean)
  if (segments.some((seg) => segmentHasRecursiveWildcard(seg))) return true
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (seg === collectionGroup) return true
    if (seg === `{${collectionGroup}}`) return true
    const recur = seg.match(/^\{([^=]+)=\*\*\}$/)
    if (recur && recur[1] === collectionGroup) return true
    if (isCollectionNameSegmentIndex(i) && isPlainVariableSegment(seg)) return true
    if (isCollectionNameSegmentIndex(i) && recur) return true
  }
  if (path.includes(`{path=**}/${collectionGroup}/`)) return true
  const wildcard = `{${collectionGroup}=**}`
  if (path.includes(wildcard)) return true
  return false
}

export function matchBlocksForCollectionGroup(rules: string, collectionGroup: string): RulesMatchBlock[] {
  return extractMatchBlocks(rules).filter((b) => matchPathAppliesToCollectionGroup(b.path, collectionGroup))
}

export type AllowStatement = { verbs: string[]; condition: string | null }

const ALLOW_STMT_RE = /allow\s+([^;]+);/gi

export function extractAllowStatements(body: string): AllowStatement[] {
  const cleaned = stripRulesComments(body)
  const out: AllowStatement[] = []
  let m: RegExpExecArray | null
  ALLOW_STMT_RE.lastIndex = 0
  while ((m = ALLOW_STMT_RE.exec(cleaned)) !== null) {
    const chunk = m[1].trim()
    const ifMatch = chunk.match(/^(.+?)\s*:\s*if\s+(.+)$/i)
    if (ifMatch) {
      const verbs = ifMatch[1]
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
      out.push({ verbs, condition: ifMatch[2].trim() })
    } else {
      const verbs = chunk
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
      out.push({ verbs, condition: null })
    }
  }
  return out
}

function isUnconditionallyFalse(condition: string): boolean {
  const n = normalizeRuleBody(condition)
  if (n === "false") return true
  return /^\(\s*false\s*\)$/.test(n)
}

/** Every allow in the block must be `if false` only (structural; equivalent spacing/order/split allows OK). */
export function assertBlockIsServerDenyOnly(body: string): void {
  const allows = extractAllowStatements(body)
  if (allows.length === 0) {
    throw new Error("TTL block has no allow statements")
  }
  for (const { verbs, condition } of allows) {
    if (verbs.length === 0) throw new Error("TTL allow has no verbs")
    if (condition === null) {
      throw new Error(`TTL allow [${verbs.join(", ")}] must be if false (unconditional allow)`)
    }
    if (!isUnconditionallyFalse(condition)) {
      throw new Error(`TTL allow [${verbs.join(", ")}] must be if false (got if ${condition})`)
    }
  }
}

export function assertTtlCollectionServerDenyOnly(rules: string, collectionGroup: string): void {
  const blocks = matchBlocksForCollectionGroup(rules, collectionGroup)
  if (blocks.length === 0) {
    throw new Error(`no rules match blocks apply to TTL collection ${collectionGroup}`)
  }
  for (const block of blocks) {
    assertBlockIsServerDenyOnly(block.body)
  }
}
