import type { Firestore } from "@/platform/persistence/firestoreDbModular"
import {
  FIRM_SCOPED_LIST_LIMIT,
  getDocs,
  queryByFirmId,
  queryByFirmIdAndField,
  validateFirmListCursor,
  withFirmQueryStartAfter,
  type FirmIdQuery,
} from "@/platform/persistence/firestoreDbModular"
import { requireCallerFirmId } from "@/platform/persistence/callerFirm"

export type FirmScopedListMeta = {
  truncated: boolean
  /** Document id to pass as `startAfterId` for the next page; null when no further page. */
  nextCursor: string | null
}

export type FirmScopedPage<T> = {
  items: T[]
  truncated: boolean
  nextCursor: string | null
}

/** Array returned from repository listByFirm with pagination metadata attached for callers. */
export type FirmScopedList<T> = T[] & { firmScopedMeta: FirmScopedListMeta }

export function asFirmScopedList<T>(page: FirmScopedPage<T>): FirmScopedList<T> {
  const items = page.items.slice() as FirmScopedList<T>
  items.firmScopedMeta = {
    truncated: page.truncated,
    nextCursor: page.nextCursor,
  }
  return items
}

export type FirmScopedListOptions = {
  limit?: number
  startAfterId?: string | null
}

async function runFirmScopedPageQuery<T extends { id?: string }>(
  db: Firestore,
  collectionName: string,
  buildBaseQuery: (fetchLimit: number) => FirmIdQuery,
  firmId: string,
  options: FirmScopedListOptions
): Promise<FirmScopedPage<T>> {
  const pageLimit = options.limit ?? FIRM_SCOPED_LIST_LIMIT
  const fetchLimit = pageLimit + 1
  let query = buildBaseQuery(fetchLimit)
  if (options.startAfterId) {
    const cursorSnap = await validateFirmListCursor(db, collectionName, firmId, options.startAfterId)
    query = withFirmQueryStartAfter(db, query, cursorSnap)
  }
  const snap = await getDocs(query)
  const raw = snap.docs.map((row) => ({ ...(row.data() as T), id: row.id }))
  const truncated = raw.length > pageLimit
  const items = truncated ? raw.slice(0, pageLimit) : raw
  const last = items[items.length - 1]
  const nextCursor = truncated && last?.id ? last.id : null
  return { items, truncated, nextCursor }
}

export async function listRowsByFirm<T extends { firmId: string; id?: string }>(
  db: Firestore,
  collectionName: string,
  firmId: string,
  options: FirmScopedListOptions = {}
): Promise<FirmScopedPage<T>> {
  const firm = requireCallerFirmId(firmId, "listRowsByFirm")
  return runFirmScopedPageQuery<T>(
    db,
    collectionName,
    (fetchLimit) => queryByFirmId(db, collectionName, firm, fetchLimit),
    firm,
    options
  )
}

export async function listRowsByFirmAndField<T extends { id?: string }>(
  db: Firestore,
  collectionName: string,
  firmId: string,
  field: string,
  fieldValue: string,
  options: FirmScopedListOptions = {}
): Promise<FirmScopedPage<T>> {
  const firm = requireCallerFirmId(firmId, "listRowsByFirmAndField")
  return runFirmScopedPageQuery<T>(
    db,
    collectionName,
    (fetchLimit) => queryByFirmIdAndField(db, collectionName, firm, field, fieldValue, fetchLimit),
    firm,
    options
  )
}
