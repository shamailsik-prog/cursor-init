/** Parse helpers for F32 TTL static rules checks (R116-001 / R116-002). */

export const TTL_ONLY_RULE = "allow read, write: if false;"

export function stripRulesComments(rules: string): string {
  let out = ""
  let i = 0
  while (i < rules.length) {
    if (rules[i] === "/" && rules[i + 1] === "/") {
      i += 2
      while (i < rules.length && rules[i] !== "\n") i++
      continue
    }
    if (rules[i] === "/" && rules[i + 1] === "*") {
      i += 2
      while (i < rules.length && !(rules[i] === "*" && rules[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += rules[i]
    i++
  }
  return out
}

export function normalizeRuleBody(body: string): string {
  return stripRulesComments(body).replace(/\s+/g, " ").trim()
}

export type RulesMatchBlock = { path: string; body: string }

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

/** True when a rules path could apply to documents in this collection group. */
export function matchPathAppliesToCollectionGroup(path: string, collectionGroup: string): boolean {
  if (path.includes("{document=**}")) return true
  const segments = path.split("/").filter(Boolean)
  for (const seg of segments) {
    if (seg === collectionGroup) return true
    if (seg === `{${collectionGroup}}`) return true
    const recur = seg.match(/^\{([^=]+)=\*\*\}$/)
    if (recur && recur[1] === collectionGroup) return true
  }
  if (path.includes(`{path=**}/${collectionGroup}/`)) return true
  const wildcard = `{${collectionGroup}=**}`
  if (path.includes(wildcard)) return true
  return false
}

export function matchBlocksForCollectionGroup(rules: string, collectionGroup: string): RulesMatchBlock[] {
  return extractMatchBlocks(rules).filter((b) => matchPathAppliesToCollectionGroup(b.path, collectionGroup))
}

const FORBIDDEN_CLIENT_ALLOW_RE =
  /allow\s+(?:read|write|get|list|create|update|delete)[^;]*:\s*if\s+(?!false\b)/i

export function assertTtlCollectionServerDenyOnly(rules: string, collectionGroup: string): void {
  const blocks = matchBlocksForCollectionGroup(rules, collectionGroup)
  if (blocks.length === 0) {
    throw new Error(`no rules match blocks apply to TTL collection ${collectionGroup}`)
  }
  for (const block of blocks) {
    const normalized = normalizeRuleBody(block.body)
    if (normalized !== TTL_ONLY_RULE) {
      throw new Error(
        `TTL collection ${collectionGroup} block ${block.path} must be only "${TTL_ONLY_RULE}" (got "${normalized}")`,
      )
    }
    if (FORBIDDEN_CLIENT_ALLOW_RE.test(stripRulesComments(block.body))) {
      throw new Error(`TTL collection ${collectionGroup} block ${block.path} has conditional client allow`)
    }
    const raw = stripRulesComments(block.body)
    if (/platformAdmin/i.test(raw) || /victim/i.test(raw) || /request\.auth\.uid\s*==/i.test(raw)) {
      throw new Error(`TTL collection ${collectionGroup} block ${block.path} contains mutant bypass pattern`)
    }
  }
}
