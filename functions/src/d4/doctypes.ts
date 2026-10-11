/**
 * The verified document-type seed (data/documentTypes.json, L18 Annex C) as a read-only catalogue (spec P4-5, E-15):
 * only rows with status VERIFIED are selectable. Rows are copied and frozen at load, so no caller can change the seed.
 */
import seed from "@/data/documentTypes.json"

/** One seed row. `courtIds` may hold a family pattern such as `DSJ_KHI_*` (see courtAllowed). */
export type DocumentType = {
  id: string
  name: string
  category: string
  posture: string
  courtIds: readonly string[]
  temporalBindingRule: string
  firstGroundRule: string
  requiredFields: readonly string[]
  checklist: readonly string[]
  templateId: string
  annexureRule: string
  source: string
  status: string
  note: string
}

function freezeRow(row: DocumentType): DocumentType {
  return Object.freeze({
    ...row,
    courtIds: Object.freeze([...row.courtIds]),
    requiredFields: Object.freeze([...row.requiredFields]),
    checklist: Object.freeze([...row.checklist]),
  })
}

const byId = (a: DocumentType, b: DocumentType) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Verified rows only, sorted by id (code-unit order, so it never depends on a locale). */
const VERIFIED: readonly DocumentType[] = Object.freeze(
  (seed.types as DocumentType[]).filter((t) => t.status === "VERIFIED").map(freezeRow).sort(byId)
)
const BY_ID: ReadonlyMap<string, DocumentType> = new Map(VERIFIED.map((t) => [t.id, t]))

/** The verified type with this id, or null (unknown, or not VERIFIED). */
export function getDocumentType(id: string): DocumentType | null {
  return BY_ID.get(id) ?? null
}

/**
 * Whether a matter in `courtId` may use the type: true when the matter has no court. The seed lists a family of
 * courts as `<court>_*` (for example `DSJ_KHI_*`), which admits the court itself (`DSJ_KHI`) and any court under
 * it (`DSJ_KHI_EAST`). Every other entry, including a `*` anywhere else, is an exact court id.
 */
export function courtAllowed(type: DocumentType, courtId: string | undefined): boolean {
  if (courtId === undefined) return true
  return type.courtIds.some((entry) => {
    if (entry === courtId) return true
    if (!entry.endsWith("_*")) return false
    const family = entry.slice(0, -2)
    return family !== "" && (courtId === family || courtId.startsWith(`${family}_`))
  })
}

/** Verified types matching every filter given, sorted by id. `q` is a case-insensitive part of the name. */
export function listDocumentTypes(filter: { category?: string; courtId?: string; q?: string }): DocumentType[] {
  const q = filter.q?.trim().toLowerCase() ?? ""
  return VERIFIED.filter(
    (t) =>
      (filter.category === undefined || t.category === filter.category) &&
      courtAllowed(t, filter.courtId) &&
      (q === "" || t.name.toLowerCase().includes(q))
  )
}
