import { defineTool } from "eve/tools"
import { MASK_PREVIEW_INPUT, MASK_PREVIEW_OUTPUT, runContractTool } from "../../platform/p1/eveToolContracts"
import { maskPreview } from "../../platform/p1/eveTools"

/** Read-only. Strict, bounded input and a typed output contract (audit F16, spec ruling 5). */
export default defineTool({
  description:
    "Preview P1 outbound masking. Does not call a provider. Party names redact only when supplied.",
  inputSchema: MASK_PREVIEW_INPUT,
  outputSchema: MASK_PREVIEW_OUTPUT,
  label: {
    start: () => "Preview P1 outbound mask",
  },
  async execute(input) {
    return runContractTool(MASK_PREVIEW_INPUT, MASK_PREVIEW_OUTPUT, maskPreview, input)
  },
})
