import courtsSeed from "@/data/courts.json"
import { PublicError } from "@/platform/http/publicError"
import { loadCourts, normalise } from "@/core/case-number-normaliser"
import type { SpineStore } from "@/platform/spine/store"

const courts = loadCourts(courtsSeed)

export function recordCaseNumber(
  store: SpineStore,
  matterId: string,
  raw: string,
  courtId: string
): { status: "OK" | "AMBIGUOUS" | "REJECT"; canonical?: string } {
  const matter = store.matters.get(matterId)
  if (!matter) throw new PublicError("unknown matter")
  const result = normalise(raw, courtId, courts)
  if (result.status === "REJECT") {
    store.followUps.push({
      id: store.id("fu"),
      firmId: matter.firmId,
      matterId,
      courtId,
      raw,
      kind: "case_number_reject",
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
    })
    return { status: "REJECT" }
  }
  matter.caseNumber = result.canonical
  matter.caseNumberStatus = "recorded"
  return { status: result.status, canonical: result.canonical }
}

export function followUpsFor(store: SpineStore, matterId: string) {
  return store.followUps.filter((f) => f.matterId === matterId)
}
