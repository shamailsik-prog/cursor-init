import { withIdempotency } from "@/platform/http/respond"
import { getStore } from "@/platform/spine/session"
import { DEMO } from "@/platform/spine/seed"
import { addMember, createMatter } from "@/services/d1-2/matters"
import type { Classification } from "@/platform/p1/types"

export async function POST(request: Request) {
  return withIdempotency(request, async () => {
    const body = (await request.json()) as {
      title?: string
      courtId?: string
      classification?: Classification
      clientId?: string
    }
    if (!body.title) throw new Error("title is required")
    const store = getStore()
    const matter = createMatter(store, {
      firmId: DEMO.firmId,
      clientId: body.clientId ?? DEMO.clientId,
      title: body.title,
      courtId: body.courtId ?? "SHC",
      classification: body.classification ?? "internal",
    })
    addMember(store, matter.id, DEMO.clerkId, DEMO.firmId)
    addMember(store, matter.id, DEMO.partnerId, DEMO.firmId)
    return matter
  })
}
