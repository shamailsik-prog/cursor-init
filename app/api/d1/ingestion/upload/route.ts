import { withIdempotency } from "@/platform/http/respond"
import { getStore } from "@/platform/spine/session"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import type { Classification } from "@/platform/p1/types"

export async function POST(request: Request) {
  return withIdempotency(request, async (key) => {
    const body = (await request.json()) as {
      text?: string
      sourceChannel?: "web" | "team_portal" | "whatsapp" | "bulk"
      classification?: Classification
      matterId?: string | null
    }
    if (!body.text) throw new Error("text is required")
    const store = getStore()
    return uploadDocument(store, {
      firmId: "nhs-legal",
      matterId: body.matterId ?? null,
      bytes: Buffer.from(body.text),
      sourceChannel: body.sourceChannel ?? "web",
      classification: body.classification ?? "internal",
      idempotencyKey: key,
    })
  })
}
