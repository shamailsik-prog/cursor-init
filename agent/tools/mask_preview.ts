import { defineTool } from "eve/tools"
import { z } from "zod"
import { maskPreview } from "../../platform/p1/eveTools"

export default defineTool({
  description:
    "Preview P1 outbound masking. Does not call a provider. Party names redact only when supplied.",
  inputSchema: z.object({
    text: z.string().min(1),
    partyNames: z.array(z.string()).optional(),
  }),
  label: {
    start: () => "Preview P1 outbound mask",
  },
  async execute(input) {
    return maskPreview(input)
  },
})
