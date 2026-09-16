import { defineTool } from "eve/tools"
import { z } from "zod"
import { classificationPolicy } from "../../platform/p1/eveTools"

export default defineTool({
  description:
    "Ask whether a classification rank may leave to the AI Gateway. Does not call a provider. DPA table is empty until TODO(firm).",
  inputSchema: z.object({
    classification: z.string().min(1),
  }),
  label: {
    start: ({ classification }) => `Check P1 policy for ${classification}`,
  },
  async execute(input) {
    return classificationPolicy(input)
  },
})
