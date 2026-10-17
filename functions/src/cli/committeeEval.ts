import { readFileSync } from "node:fs"
import path from "node:path"
import { TASK_MODEL } from "../p1/costTable"
import { EVAL_SET_RELATIVE_PATH, parseEvalSet, runLiveEvaluation, worstCaseMicroUsd } from "../p1/evalSet"
import { gatewayTransport, type P1Transport } from "../p1/transport"

/**
 * `npm --prefix functions run eval:committee-live [-- <eval set path>]` (audit F17, spec ruling 5): the live evaluation of
 * the committee-brain evaluation set against the configured model (`TASK_MODEL.committee`), through the Gateway.
 *
 * It runs only when AI_GATEWAY_API_KEY is set. Without it, it prints `NOT RUN: ...`, sends nothing and exits 0: a run
 * that did not happen is reported as not run, never as a pass. With it, it prints the worst-case cost first, then sends
 * each of the set's synthetic prompts with the registry's committee-brain system message (no firm or client data: there
 * is no firm, so no firm budget applies), grades each masked answer against the set's corpus, prints the report and
 * exits 1 when any item fails. Its result goes into docs/evals/committee-brain-eval-record.json by hand, with
 * `live: true`. Nothing runs at import.
 */

export type EvalDeps = {
  env: Record<string, string | undefined>
  out: (line: string) => void
  readSet: () => unknown
  transportFor: (key: string) => P1Transport
}

export async function runCommitteeEval(deps: EvalDeps): Promise<number> {
  const set = parseEvalSet(deps.readSet())
  const key = deps.env.AI_GATEWAY_API_KEY?.trim()
  if (!key) {
    deps.out(`NOT RUN: AI_GATEWAY_API_KEY is not set; the live evaluation of the ${set.items.length} items of eval set ${set.version} did not run, and nothing was sent.`)
    return 0
  }
  const model = TASK_MODEL.committee
  deps.out(`LIVE: ${set.items.length} items of eval set ${set.version} against ${model}; worst case ${worstCaseMicroUsd(set, model) ?? "unpriced"} micro-USD`)
  const report = await runLiveEvaluation(set, deps.transportFor(key), { model })
  deps.out(JSON.stringify(report))
  deps.out(`${report.failed === 0 ? "PASS" : "FAIL"}: ${report.passed} passed, ${report.failed} failed`)
  return report.failed === 0 ? 0 : 1
}

async function main(): Promise<void> {
  const setPath = path.resolve(process.argv[2] ?? EVAL_SET_RELATIVE_PATH)
  process.exitCode = await runCommitteeEval({
    env: process.env,
    out: (line) => console.log(line),
    readSet: () => JSON.parse(readFileSync(setPath, "utf8")) as unknown,
    transportFor: (key) => gatewayTransport(key),
  })
}

if (require.main === module) void main()
