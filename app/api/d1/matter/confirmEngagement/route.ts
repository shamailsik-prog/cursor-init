import { withIdempotency } from "@/platform/http/respond"
import { getStore } from "@/platform/spine/session"
import { confirmEngagement } from "@/services/d1-2/matters"
import { escalateSilence, intimationsFor } from "@/platform/p4/intimation"

export async function POST(request: Request) {
  return withIdempotency(request, async () => {
    const body = (await request.json()) as {
      matterId?: string
      advanceHours?: number
    }
    if (!body.matterId) throw new Error("matterId is required")
    const store = getStore()
    const now = Date.now()
    confirmEngagement(store, body.matterId, now)
    if (body.advanceHours && body.advanceHours >= 24) {
      escalateSilence(store, body.matterId, now + body.advanceHours * 60 * 60 * 1000)
    }
    return {
      intimations: intimationsFor(store, body.matterId),
      followUps: store.followUps.filter((f) => f.matterId === body.matterId),
      matter: store.matters.get(body.matterId),
    }
  })
}
