function stableString(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

/** Field-wise comparison for manifest sections that are records (spec R8, R10). */
export function diffRecords(
  path: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>
): string[] {
  const lines: string[] = []
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const key of [...keys].sort()) {
    const inExp = Object.prototype.hasOwnProperty.call(expected, key)
    const inAct = Object.prototype.hasOwnProperty.call(actual, key)
    const p = path ? `${path}.${key}` : key
    if (inExp && !inAct) lines.push(`${p}: missing (expected ${stableString(expected[key])})`)
    else if (!inExp && inAct) lines.push(`${p}: unexpected (actual ${stableString(actual[key])})`)
    else if (inExp && inAct && stableString(expected[key]) !== stableString(actual[key])) {
      lines.push(`${p}: ${stableString(expected[key])} -> ${stableString(actual[key])}`)
    }
  }
  return lines
}

/** Sorted-set comparison; reports missing and unexpected lines (spec R8 definitions / roles). */
export function diffSets(path: string, expected: string[], actual: string[]): string[] {
  const exp = new Set(expected)
  const act = new Set(actual)
  const lines: string[] = []
  for (const item of [...exp].sort()) {
    if (!act.has(item)) lines.push(`${path}: missing ${item}`)
  }
  for (const item of [...act].sort()) {
    if (!exp.has(item)) lines.push(`${path}: unexpected ${item}`)
  }
  return lines
}
