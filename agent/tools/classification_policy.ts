import { defineTool } from "eve/tools"
import { CLASSIFICATION_POLICY_INPUT, CLASSIFICATION_POLICY_OUTPUT, runContractTool } from "../../platform/p1/eveToolContracts"
import { classificationPolicy } from "../../platform/p1/eveTools"

/** Read-only. Strict, bounded input and a typed output contract (audit F16, spec ruling 5). */
export default defineTool({
  description:
    "Ask whether a classification rank may leave to the AI Gateway. Does not call a provider. DPA table is empty until TODO(firm).",
  inputSchema: CLASSIFICATION_POLICY_INPUT,
  outputSchema: CLASSIFICATION_POLICY_OUTPUT,
  label: {
    start: ({ classification }) => `Check P1 policy for ${classification}`,
  },
  async execute(input) {
    return runContractTool(CLASSIFICATION_POLICY_INPUT, CLASSIFICATION_POLICY_OUTPUT, classificationPolicy, input)
  },
})
