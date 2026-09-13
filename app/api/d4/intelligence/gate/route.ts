import { withIdempotency } from "@/platform/http/respond"
import { getStore } from "@/platform/spine/session"
import {
  checkTemporalConsistency,
  getSectionAsAt,
  verifyCitations,
} from "@/services/d4-2/draftingIntelligence"

export async function POST(request: Request) {
  return withIdempotency(request, async () => {
    const body = (await request.json()) as {
      cited?: string[]
      partnerReason?: string
      sectionId?: string
      offenceDate?: string
      usedText?: string
    }
    const store = getStore()
    const citations = verifyCitations(
      store,
      body.cited ?? ["j-old"],
      body.partnerReason
    )
    const asAt = body.offenceDate
      ? getSectionAsAt(store, body.sectionId ?? "ppc_302", body.offenceDate)
      : getSectionAsAt(store, "ppc_302", "2015-06-01")
    const temporal = checkTemporalConsistency(
      store,
      body.sectionId ?? "ppc_302",
      body.offenceDate ?? "2015-06-01",
      body.usedText ?? "PPC 302 text as amended 2018"
    )
    return { citations, asAt, temporal }
  })
}
