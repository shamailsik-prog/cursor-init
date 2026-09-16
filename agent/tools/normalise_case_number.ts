import { defineTool } from "eve/tools"
import { z } from "zod"
import { normaliseCaseNumber } from "../../platform/p1/eveTools"

export default defineTool({
  description:
    "Normalise a cause-list string against the seeded court prefix table. Do not invent prefixes. Court fee is MANUAL — this tool does not compute fees.",
  inputSchema: z.object({
    raw: z.string().min(1),
    courtId: z.string().min(1),
  }),
  label: {
    start: ({ courtId }) => `Normalise cause-list string for ${courtId}`,
  },
  async execute(input) {
    return normaliseCaseNumber(input)
  },
})
