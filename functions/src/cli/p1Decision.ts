import { Timestamp, type Firestore } from "firebase-admin/firestore"
import { adminDb } from "../admin"
import { reconstructP1Decision, type Reconstruction } from "../p1/decisionRecord"

/**
 * `npm --prefix functions run p1:decision -- --trace <traceId>` or `-- --usage <usageLogId>` (audit F34, spec ruling R13):
 * the operator's reconstruction of one P1 attempt from durable data alone. It prints the joined record as JSON (the
 * decision record, the usage row, the reservation with its provider attempt, the committee output by reference and the
 * call's event, with `checks`), Timestamps as ISO strings. No prompt or answer text is read into the output.
 *
 * Admin-only by construction: it runs with the operator's own credentials (`GOOGLE_APPLICATION_CREDENTIALS` or ADC, and
 * `GCLOUD_PROJECT`), and it is neither deployed nor routed. Exit 0 found, 2 not found, 64 for a usage error.
 */

export type DecisionCliDeps = {
  argv: readonly string[]
  out: (line: string) => void
  db: () => Firestore
}

export const USAGE = "usage: p1:decision -- --trace <traceId> | --usage <usageLogId>"

/** The key the arguments name: exactly one of `--trace <id>` and `--usage <id>`; null otherwise. */
export function parseDecisionArgs(argv: readonly string[]): { traceId: string } | { usageLogId: string } | null {
  if (argv.length !== 2 || typeof argv[1] !== "string" || argv[1] === "") return null
  if (argv[0] === "--trace") return { traceId: argv[1] }
  if (argv[0] === "--usage") return { usageLogId: argv[1] }
  return null
}

/** JSON with Timestamps as ISO strings. */
export function renderReconstruction(r: Reconstruction): string {
  return JSON.stringify(r, (_key, value: unknown) => (value instanceof Timestamp ? value.toDate().toISOString() : value), 2)
}

export async function runDecisionCli(deps: DecisionCliDeps): Promise<number> {
  const key = parseDecisionArgs(deps.argv)
  if (key === null) {
    deps.out(USAGE)
    return 64
  }
  const r = await reconstructP1Decision(deps.db(), key)
  if (r === null) {
    deps.out(`NOT FOUND: no P1 record for ${"traceId" in key ? `trace ${key.traceId}` : `usage row ${key.usageLogId}`}`)
    return 2
  }
  deps.out(renderReconstruction(r))
  return 0
}

async function main(): Promise<void> {
  process.exitCode = await runDecisionCli({ argv: process.argv.slice(2), out: (line) => console.log(line), db: adminDb })
}

if (require.main === module) void main()
