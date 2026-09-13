import { withIdempotency } from "@/platform/http/respond"
import { getStore } from "@/platform/spine/session"
import { DEMO } from "@/platform/spine/seed"
import { conflictCheck, createClient } from "@/services/d1-1/clients"

export async function POST(request: Request) {
  return withIdempotency(request, async () => {
    const body = (await request.json()) as {
      canonicalName?: string
      cnic?: string
      phone?: string
    }
    if (!body.canonicalName || !body.cnic || !body.phone) {
      throw new Error("canonicalName, cnic and phone are required")
    }
    const store = getStore()
    const entity = createClient(store, {
      firmId: DEMO.firmId,
      canonicalName: body.canonicalName,
      cnic: body.cnic,
      phone: body.phone,
    })
    const conflict = conflictCheck(store, DEMO.firmId, entity.id)
    return { entity, conflict, links: store.links }
  })
}
