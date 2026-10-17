import { defineTool } from "eve/tools"
import { NORMALISE_CASE_NUMBER_INPUT, NORMALISE_CASE_NUMBER_OUTPUT, runContractTool } from "../../platform/p1/eveToolContracts"
import { normaliseCaseNumber } from "../../platform/p1/eveTools"

/** Read-only. Strict, bounded input (a seeded court id only) and a typed output contract (audit F16, spec ruling 5). */
export default defineTool({
  description:
    "Normalise a cause-list string against the seeded court prefix table. Do not invent prefixes. Court fee is MANUAL — this tool does not compute fees.",
  inputSchema: NORMALISE_CASE_NUMBER_INPUT,
  outputSchema: NORMALISE_CASE_NUMBER_OUTPUT,
  label: {
    start: ({ courtId }) => `Normalise cause-list string for ${courtId}`,
  },
  async execute(input) {
    return runContractTool(NORMALISE_CASE_NUMBER_INPUT, NORMALISE_CASE_NUMBER_OUTPUT, normaliseCaseNumber, input)
  },
})
