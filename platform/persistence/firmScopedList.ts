import type { Firestore } from "@/platform/persistence/firestoreDbModular"
import {
  FIRM_SCOPED_LIST_LIMIT,
  getDocs,
  queryByFieldEquals,
  queryByFirmId,
  queryByFirmIdAndField,
  validateFirmListCursor,
  withFirmQueryStartAfter,
  type FirmIdQuery,
} from "@/platform/persistence/firestoreDbModular"
import { requireCallerFirmId } from "@/platform/persistence/callerFirm"
import { dropTombstonedRows } from "@/platform/persistence/matterTombstones"

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

type FirmScopedRawPage<T> = FirmScopedPage<T> & {
  /** The SDK's own snapshot of the last row kept, for a `startAfter` that needs no second read. */
  lastCursor: unknown
}

async function runFirmScopedPageQuery<T extends { id?: string }>(
  db: Firestore,
  collectionName: string,
  buildBaseQuery: (fetchLimit: number) => FirmIdQuery,
  firmId: string,
  options: FirmScopedListOptions & { startAfterCursor?: unknown }
): Promise<FirmScopedRawPage<T>> {
  const pageLimit = options.limit ?? FIRM_SCOPED_LIST_LIMIT
  const fetchLimit = pageLimit + 1
  let query = buildBaseQuery(fetchLimit)
  if (options.startAfterCursor !== undefined) {
    query = withFirmQueryStartAfter(db, query, options.startAfterCursor)
  } else if (options.startAfterId) {
    const cursorSnap = await validateFirmListCursor(db, collectionName, firmId, options.startAfterId)
    query = withFirmQueryStartAfter(db, query, cursorSnap)
  }
  const snap = await getDocs(query)
  const truncated = snap.docs.length > pageLimit
  const kept = truncated ? snap.docs.slice(0, pageLimit) : snap.docs
  // F14 R8 / F01: the document id is authoritative; it wins over any `id` in the data.
  // Audit F42: a row of a tombstoned matter is never listed (the page's cursor still moves past it).
  const items = await dropTombstonedRows(db, collectionName, firmId, kept.map((row) => ({ ...(row.data() as T), id: row.id })))
  const lastDoc = kept[kept.length - 1]
  const nextCursor = truncated && lastDoc?.id ? lastDoc.id : null
  const lastCursor = lastDoc ? ((lastDoc as { cursor?: unknown }).cursor ?? lastDoc) : undefined
  return { items, truncated, nextCursor, lastCursor }
}

/**
 * Hard ceiling on the pages a complete listing reads (F12). At the default page size this is 5,000,000 rows of ONE
 * firm; reaching it means the query is not advancing, so the listing fails loudly instead of looping or truncating.
 */
export const FIRM_SCOPED_LIST_MAX_PAGES = 10_000

/**
 * Every row of the caller's firm, read page by page through the firm-scoped query (F12): the database applies the
 * firm filter, so no other tenant's row is ever read, and no row of the firm is silently dropped. Repository
 * `listByFirm` / `listBy<Field>` callers (membership and matter syncs, conflict and permission checks) rely on a
 * complete answer; a truncated one would deny access or miss a conflict without saying so. Callers that want one
 * bounded page use `listRowsByFirm` / `listRowsByFirmAndField` with `limit` / `startAfterId`.
 */
async function listAllPages<T extends { id?: string }>(
  db: Firestore,
  collectionName: string,
  buildBaseQuery: (fetchLimit: number) => FirmIdQuery,
  firmId: string,
  pageLimit: number
): Promise<FirmScopedPage<T>> {
  const items: T[] = []
  let startAfterCursor: unknown = undefined
  for (let pages = 0; pages < FIRM_SCOPED_LIST_MAX_PAGES; pages += 1) {
    const page: FirmScopedRawPage<T> = await runFirmScopedPageQuery<T>(db, collectionName, buildBaseQuery, firmId, {
      limit: pageLimit,
      startAfterCursor,
    })
    items.push(...page.items)
    if (!page.truncated) return { items, truncated: false, nextCursor: null }
    startAfterCursor = page.lastCursor
  }
  throw new Error(`firm-scoped listing of ${collectionName} exceeded ${FIRM_SCOPED_LIST_MAX_PAGES} pages`)
}

export async function listAllRowsByFirm<T extends { firmId: string; id?: string }>(
  db: Firestore,
  collectionName: string,
  firmId: string,
  pageLimit: number = FIRM_SCOPED_LIST_LIMIT
): Promise<FirmScopedPage<T>> {
  const firm = requireCallerFirmId(firmId, "listAllRowsByFirm")
  return listAllPages<T>(
    db,
    collectionName,
    (fetchLimit) => queryByFirmId(db, collectionName, firm, fetchLimit),
    firm,
    pageLimit
  )
}

export async function listAllRowsByFirmAndField<T extends { id?: string }>(
  db: Firestore,
  collectionName: string,
  firmId: string,
  field: string,
  fieldValue: string,
  pageLimit: number = FIRM_SCOPED_LIST_LIMIT
): Promise<FirmScopedPage<T>> {
  const firm = requireCallerFirmId(firmId, "listAllRowsByFirmAndField")
  return listAllPages<T>(
    db,
    collectionName,
    (fetchLimit) => queryByFirmIdAndField(db, collectionName, firm, field, fieldValue, fetchLimit),
    firm,
    pageLimit
  )
}

/**
 * Every row whose `firmFieldPath` (for example `row.firmId`) equals the caller's firm, read page by page as
 * listAllRowsByFirm reads (F12). For stored shapes that keep the firm elsewhere than top-level `firmId`: audit F11 reads
 * the dead letters stored before the fix through it. The database applies the firm filter.
 */
export async function listAllRowsByFirmField<T extends { id?: string }>(
  db: Firestore,
  collectionName: string,
  firmId: string,
  firmFieldPath: string,
  pageLimit: number = FIRM_SCOPED_LIST_LIMIT
): Promise<FirmScopedPage<T>> {
  const firm = requireCallerFirmId(firmId, "listAllRowsByFirmField")
  return listAllPages<T>(
    db,
    collectionName,
    (fetchLimit) => queryByFieldEquals(db, collectionName, firmFieldPath, firm, fetchLimit),
    firm,
    pageLimit
  )
}

export async function listRowsByFirm<T extends { firmId: string; id?: string }>(
  db: Firestore,
  collectionName: string,
  firmId: string,
  options: FirmScopedListOptions = {}
): Promise<FirmScopedPage<T>> {
  const firm = requireCallerFirmId(firmId, "listRowsByFirm")
  const { items, truncated, nextCursor } = await runFirmScopedPageQuery<T>(
    db,
    collectionName,
    (fetchLimit) => queryByFirmId(db, collectionName, firm, fetchLimit),
    firm,
    { limit: options.limit, startAfterId: options.startAfterId }
  )
  return { items, truncated, nextCursor }
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
  const { items, truncated, nextCursor } = await runFirmScopedPageQuery<T>(
    db,
    collectionName,
    (fetchLimit) => queryByFirmIdAndField(db, collectionName, firm, field, fieldValue, fetchLimit),
    firm,
    { limit: options.limit, startAfterId: options.startAfterId }
  )
  return { items, truncated, nextCursor }
}
