import { decodeCursor, encodeCursor, parsePage, type Page } from "../d1/pagination"
import { HttpError } from "../http/errors"
import type { Data, FirmOperation } from "../p5/common"
import { requirePermission } from "../p5/permission"
import { getDocumentType, listDocumentTypes, type DocumentType } from "./doctypes"

/**
 * The document-type reads behind `/api/d4/intelligence/` (spec P4-5, P4-10, E-15): `listDocumentTypes` and
 * `getTypeProfile`. The catalogue is the verified seed (`doctypes.ts`: VERIFIED rows only), the same for every firm,
 * so the permission (`doctype.read`: partner, associate, clerk) is firm-level and names no matter.
 */

const badQuery = () => new HttpError(400, "invalid_query")

const MAX_FILTER_CHARS = 100
const MAX_QUERY_CHARS = 200

/** An optional text filter of a query string: absent or empty means no filter; a longer one than `max` is 400 `invalid_query`. */
function parseFilter(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > max) throw badQuery()
  return value === "" ? undefined : value
}

/** What a list row shows of a type: enough to choose one. The whole row is `getTypeProfile`. */
export type TypeSummary = { id: string; name: string; category: string; posture: string; courtIds: string[] }

const summary = (t: DocumentType): TypeSummary => ({ id: t.id, name: t.name, category: t.category, posture: t.posture, courtIds: [...t.courtIds] })

/**
 * listDocumentTypes(?category=&courtId=&q=&limit=&cursor=) → `{ items, nextCursor }`: the verified types matching every
 * filter given, sorted by id, as summaries. `courtId` follows the court rule (a NON_FORUM type suits any court, a family
 * `X_*` admits the court `X` and every court under it); `q` is a case-insensitive part of the name.
 */
export const listDocumentTypesOp: FirmOperation<Page<TypeSummary>> = {
  auth: "firm",
  kind: "general",
  action: "doctype.read",
  target: "document_types",
  run: async ({ caller }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const category = parseFilter(data.category, MAX_FILTER_CHARS)
    const courtId = parseFilter(data.courtId, MAX_FILTER_CHARS)
    const q = parseFilter(data.q, MAX_QUERY_CHARS)
    const { limit, cursor } = parsePage(data)
    const afterId = cursor === null ? null : decodeCursor(cursor).id
    await requirePermission(caller, "doctype.read")

    const rows = listDocumentTypes({ category, courtId, q }).filter((t) => afterId === null || t.id > afterId)
    const page = rows.slice(0, limit)
    await audit.allow()
    const last = page[page.length - 1]
    return { items: page.map(summary), nextCursor: rows.length > limit && last ? encodeCursor(last.id, last.id) : null }
  },
}

/**
 * getTypeProfile(?typeId=) → the whole seed row of a verified type: its courts, temporal binding rule, first-ground
 * rule, required fields, checklist, template and annexure rule. A missing or non-string id is 400
 * `invalid_document_type`; an id that names no verified type is 404 `document_type_not_found`.
 */
export const getTypeProfileOp: FirmOperation<DocumentType> = {
  auth: "firm",
  kind: "general",
  action: "doctype.read",
  target: "document_types",
  run: async ({ caller }, data: Data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const typeId = data.typeId
    if (typeof typeId !== "string" || typeId === "") throw new HttpError(400, "invalid_document_type")
    await requirePermission(caller, "doctype.read")
    const type = getDocumentType(typeId)
    if (type === null) throw new HttpError(404, "document_type_not_found")
    await audit.allow()
    return { ...type, courtIds: [...type.courtIds], requiredFields: [...type.requiredFields], checklist: [...type.checklist] }
  },
}
