/**
 * Case-number normaliser — Layer 18 §6 as corrected by Erratum Set No. 1 (Job B).
 * Must stay behaviourally identical to ci_gates/case_number_normaliser.py.
 */

export type CourtRecord = {
  id: string
  name: string
  jurisdiction: string
  allowed_prefixes: string[]
  bench_letters: string[]
  synonyms: Record<string, string>
  ambiguous_prefixes?: Record<string, string>
  examples?: [string, string, string][]
}

export type NormaliseResult =
  | {
      status: "OK" | "AMBIGUOUS"
      canonical: string
      prefix: string
      bench: string | null
      number: string
      year: string
      flags: string[]
      note?: string
    }
  | { status: "REJECT"; reason: string; input?: string }

const YEAR = /^(19|20)\d{2}$/
const TAIL = /(?:([A-Z])-)?(\d{1,6})(?:-([A-Z]))?\/(\d{4})$/

function clean(raw: string): string {
  let s = raw.toUpperCase().trim()
  s = s.replace(/\./g, "")
  s = s.replace(/\b(NO|NUMBER)\b/g, " ")
  s = s.replace(/\s+OF\s+/g, "/")
  s = s.replace(/\s*\/\s*/g, "/")
  s = s.replace(/\s+/g, " ").trim()
  return s
}

export function loadCourts(data: {
  courts: Array<{
    id: string
    name: string
    jurisdiction: string
    allowed_prefixes: string[]
    bench_letters: string[]
    synonyms: Record<string, string | undefined>
    ambiguous_prefixes?: Record<string, string>
    examples?: string[][]
  }>
}): Record<string, CourtRecord> {
  return Object.fromEntries(
    data.courts.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        jurisdiction: c.jurisdiction,
        allowed_prefixes: c.allowed_prefixes,
        bench_letters: c.bench_letters,
        synonyms: Object.fromEntries(
          Object.entries(c.synonyms).filter((entry): entry is [string, string] => Boolean(entry[1]))
        ),
        ambiguous_prefixes: c.ambiguous_prefixes,
        examples: (c.examples ?? []) as [string, string, string][],
      },
    ])
  )
}

export function normalise(
  raw: string,
  courtId: string,
  courts: Record<string, CourtRecord>
): NormaliseResult {
  const court = courts[courtId]
  if (!court) {
    return { status: "REJECT", reason: `unknown court ${courtId}` }
  }
  const s = clean(raw)
  const m = TAIL.exec(s)
  if (!m) {
    return {
      status: "REJECT",
      reason: "no NUMBER/YEAR found — open L17.8 follow-up",
      input: raw,
    }
  }
  const bench1 = m[1]
  const num = m[2]
  const bench2 = m[3]
  const year = m[4]
  if (!YEAR.test(year)) {
    return { status: "REJECT", reason: "year out of range", input: raw }
  }
  const bench = bench1 || bench2 || null
  let head = s.slice(0, m.index).trim().replace(/[-\s]+$/, "")
  const syn: Record<string, string> = {}
  for (const [k, v] of Object.entries(court.synonyms ?? {})) {
    syn[k.toUpperCase()] = v
  }
  let prefix: string | undefined
  const tokens = head.split(" ").filter(Boolean)
  for (let n = tokens.length; n > 0; n--) {
    const phrase = tokens.slice(0, n).join(" ")
    if (phrase in syn) {
      prefix = syn[phrase]
      break
    }
  }
  if (prefix === undefined) {
    const compact = head.replace(/ /g, "")
    if (compact in syn) prefix = syn[compact]
  }
  if (prefix === undefined || !court.allowed_prefixes.includes(prefix)) {
    return {
      status: "REJECT",
      reason: `prefix '${head}' not allowed for ${courtId} — confirm under O-9`,
      input: raw,
    }
  }
  if (bench && court.bench_letters.length && !court.bench_letters.includes(bench)) {
    return {
      status: "REJECT",
      reason: `bench letter ${bench} not known for ${courtId}`,
      input: raw,
    }
  }
  if (bench && court.bench_letters.length === 0) {
    return {
      status: "REJECT",
      reason: `${courtId} has no bench letters`,
      input: raw,
    }
  }
  const canonical = `${prefix} ${bench ? `${bench}-` : ""}${num}/${year}`
  const flags: string[] = []
  const ambiguous = court.ambiguous_prefixes ?? {}
  if (prefix in ambiguous) flags.push("AMBIGUOUS")
  return {
    status: flags.length ? "AMBIGUOUS" : "OK",
    canonical,
    prefix,
    bench,
    number: num,
    year,
    flags,
    note: ambiguous[prefix] ?? "",
  }
}
