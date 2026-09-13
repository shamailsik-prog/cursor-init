import { withIdempotency } from "@/platform/http/respond"
import { requestTranslation } from "@/platform/p1/translate"
import type { Classification } from "@/platform/p1/types"

export async function POST(request: Request) {
  return withIdempotency(request, async () => {
    const body = (await request.json()) as {
      text?: string
      classification?: Classification
    }
    if (!body.text || !body.classification) {
      throw new Error("text and classification are required")
    }
    return requestTranslation({
      text: body.text,
      classification: body.classification,
    })
  })
}
