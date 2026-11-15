export type ContentUnit = { name: string; count: number; digest: string }

export const SHA256_HEX = /^[0-9a-f]{64}$/

export function checksumOk(digest: unknown): digest is string {
  return typeof digest === "string" && SHA256_HEX.test(digest)
}

/** Counts and checksums, both required. A matching count with a missing checksum is a failure. */
export function assessContentMatch(expected: ContentUnit[], actual: ContentUnit[]): string[] {
  const problems: string[] = []
  const exp = new Map(expected.map((unit) => [unit.name, unit]))
  const act = new Map(actual.map((unit) => [unit.name, unit]))
  for (const name of [...new Set([...exp.keys(), ...act.keys()])].sort()) {
    const left = exp.get(name)
    const right = act.get(name)
    if (!left) {
      problems.push(`${name}: unexpected`)
      continue
    }
    if (!right) {
      problems.push(`${name}: missing`)
      continue
    }
    if (!checksumOk(left.digest) || !checksumOk(right.digest)) {
      problems.push(`${name}: checksum missing`)
      continue
    }
    if (left.count !== right.count) problems.push(`${name}: count ${left.count} -> ${right.count}`)
    if (left.digest !== right.digest) problems.push(`${name}: checksum differs`)
  }
  return problems
}

export type PayloadInput = {
  store: string
  storeManifest: unknown
  artefacts: { name: string; plaintextBytes: number }[]
}

function artefactBytes(artefacts: PayloadInput["artefacts"], name: string): number | undefined {
  return artefacts.find((artefact) => artefact.name === name)?.plaintextBytes
}

function recordProblems(records: unknown, label: (name: string) => string, countKey: "rows" | "count"): string[] {
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    return [`backup manifest ${countKey === "rows" ? "tables" : "collections"} are missing (partial)`]
  }
  const problems: string[] = []
  for (const [name, raw] of Object.entries(records as Record<string, unknown>)) {
    const row = raw as { rows?: unknown; count?: unknown; digest?: unknown }
    const count = row?.[countKey]
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || !checksumOk(row?.digest)) {
      problems.push(label(name))
    }
  }
  return problems
}

/**
 * Refuses a bundle whose envelope may verify but whose payload is partial:
 * a store manifest without checksums, a missing artefact, or a zero-byte dump.
 */
export function backupPayloadProblems(input: PayloadInput): string[] {
  if (input.store === "postgres-logical") {
    const tables =
      input.storeManifest && typeof input.storeManifest === "object"
        ? (input.storeManifest as { tables?: unknown }).tables
        : undefined
    const problems = recordProblems(tables, (name) => `table ${name}: checksum missing`, "rows")
    if (tables && typeof tables === "object" && !Array.isArray(tables) && Object.keys(tables as object).length === 0) {
      problems.push("zero-unit restore is not success")
    }
    if (artefactBytes(input.artefacts, "globals.sql") === undefined) problems.push("globals.sql: missing (partial)")
    const dump = artefactBytes(input.artefacts, "database.dump")
    if (dump === undefined) problems.push("database.dump: missing (partial)")
    else if (dump === 0) problems.push("database.dump: truncated")
    return problems
  }
  if (input.store === "firestore-emulator") {
    const collections =
      input.storeManifest && typeof input.storeManifest === "object"
        ? (input.storeManifest as { collections?: unknown }).collections
        : undefined
    const problems = recordProblems(collections, (name) => `collections.${name}: checksum missing`, "count")
    const tar = artefactBytes(input.artefacts, "export.tar")
    if (tar === undefined) problems.push("export.tar: missing (partial)")
    else if (tar === 0) problems.push("export.tar: truncated")
    return problems
  }
  if (input.store === "postgres-pitr-base") {
    const tar = artefactBytes(input.artefacts, "base.tar.gz")
    if (tar === undefined) return ["base.tar.gz: missing (partial)"]
    if (tar === 0) return ["base.tar.gz: truncated"]
    return []
  }
  return [`backup store ${input.store || "(missing)"} is not a recognised local backup`]
}

export type RestoreChild = { code: number; stdout: string; stderr: string }

export function formatDrillContentLine(report: { ok: boolean; units: ContentUnit[]; problems: string[] }): string {
  return `DRILL_CONTENT_JSON ${JSON.stringify({ schema: "sikander-backup-drill-content/1", ...report })}`
}

/** A process exit code, including 0, is not content verification. The child must print a content line. */
export function acceptRestoreChild(child: RestoreChild): {
  ok: boolean
  problems: string[]
  units: Array<ContentUnit & { match: boolean }>
} {
  const line = child.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => entry.startsWith("DRILL_CONTENT_JSON "))
  if (!line) {
    return {
      ok: false,
      problems: ["restore output has no content report (an exit code is not verification)"],
      units: [],
    }
  }
  let parsed: { ok?: boolean; units?: ContentUnit[]; problems?: string[] }
  try {
    parsed = JSON.parse(line.slice("DRILL_CONTENT_JSON ".length)) as { ok?: boolean; units?: ContentUnit[]; problems?: string[] }
  } catch {
    return { ok: false, problems: ["content report is not valid JSON"], units: [] }
  }
  const unitsIn = Array.isArray(parsed.units) ? parsed.units : []
  const problems = [...(parsed.problems ?? [])]
  if (child.code !== 0) problems.push(`restore process exited ${child.code}`)
  for (const unit of unitsIn) {
    if (typeof unit?.count !== "number" || !checksumOk(unit?.digest)) problems.push(`${unit?.name ?? "(unnamed)"}: checksum missing`)
  }
  if (parsed.ok !== true && !problems.length) problems.push("content report is not ok")
  const match = problems.length === 0 && child.code === 0 && parsed.ok === true
  return {
    ok: match,
    problems,
    units: unitsIn.map((unit) => ({ name: unit.name, count: unit.count, digest: unit.digest, match })),
  }
}

export function pgContentUnits(manifest: { tables: Record<string, { rows: number; digest: string }> }): ContentUnit[] {
  return Object.keys(manifest.tables)
    .sort()
    .map((name) => ({ name, count: manifest.tables[name].rows, digest: manifest.tables[name].digest }))
}

export function firestoreContentUnits(manifest: {
  collections: Record<string, { count: number; digest: string }>
}): ContentUnit[] {
  return Object.keys(manifest.collections)
    .sort()
    .map((name) => ({
      name,
      count: manifest.collections[name].count,
      digest: manifest.collections[name].digest,
    }))
}
