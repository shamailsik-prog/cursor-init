import { withIdempotency } from "@/platform/http/respond"
import { getStore } from "@/platform/spine/session"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"

export async function POST(request: Request) {
  return withIdempotency(request, async () => {
    const body = (await request.json()) as {
      matterId?: string
      raw?: string
      courtId?: string
    }
    if (!body.matterId || !body.raw) throw new Error("matterId and raw are required")
    const store = getStore()
    const result = recordCaseNumber(
      store,
      body.matterId,
      body.raw,
      body.courtId ?? "SHC"
    )
    return {
      ...result,
      matter: store.matters.get(body.matterId),
      followUps: store.followUps.filter((f) => f.matterId === body.matterId),
    }
  })
}
