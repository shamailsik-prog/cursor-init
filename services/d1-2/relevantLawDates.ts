import { PublicError } from "@/platform/http/publicError"
import type { SpineStore } from "@/platform/spine/store"

declare module "@/platform/spine/store" {
  interface Matter {
    /** L17.1 accrual date stored by D1-2. */
    relevant_law_dates?: Array<{ name: "accrual"; date: string; article: string; forum: string }>
  }
}

/** D1-2 stores the accrual date the limitation check used. One row per article and forum. */
export function recordAccrualLawDate(
  store: SpineStore,
  matterId: string,
  entry: { date: string; article: string; forum: string }
): void {
  const matter = store.matters.get(matterId)
  if (!matter) throw new PublicError("unknown matter")
  const rest = (matter.relevant_law_dates ?? []).filter(
    (row) => !(row.name === "accrual" && row.article === entry.article && row.forum === entry.forum)
  )
  matter.relevant_law_dates = [...rest, { name: "accrual", date: entry.date, article: entry.article, forum: entry.forum }]
}
