import { isClassification, type Classification } from "@/platform/p1/types"
import { PublicError } from "@/platform/http/publicError"
import type { SpineStore } from "@/platform/spine/store"

const CNIC = /^\d{13}$|^\d{5}-\d{7}-\d$/

function normaliseCnic(raw: string): string {
  return raw.replace(/\D/g, "")
}

export function createClient(
  store: SpineStore,
  input: {
    firmId: string
    canonicalName: string
    cnic: string
    phone: string
    classification: Classification
  }
) {
  if (!isClassification(input.classification)) {
    throw new PublicError("artefact write omitted classification")
  }
  const cnic = normaliseCnic(input.cnic)
  if (cnic.length !== 13) throw new PublicError("CNIC must be 13 digits")
  void CNIC
  const id = store.id("ent")
  const entity = {
    id,
    firmId: input.firmId,
    canonicalName: input.canonicalName,
    cnic,
    phone: input.phone,
    classification: input.classification,
  }
  store.entities.set(id, entity)

  for (const other of store.entities.values()) {
    if (other.id === id || other.firmId !== input.firmId) continue
    if (other.cnic === cnic) {
      const exists = store.links.some(
        (row) =>
          row.firmId === input.firmId &&
          row.leftId === other.id &&
          row.rightId === id &&
          row.identityBasis === "cnic"
      )
      if (!exists) {
        store.links.push({
          firmId: input.firmId,
          leftId: other.id,
          rightId: id,
          identityBasis: "cnic",
          band: "confirmed-candidate",
          score: 0.99,
        })
      }
    }
  }
  return entity
}

export function conflictCheck(
  store: SpineStore,
  firmId: string,
  namedEntityId: string
): { status: "CLEAR" | "POSSIBLE_CANDIDATE_REVIEW"; identityBasis?: "cnic" } {
  const named = store.entities.get(namedEntityId)
  if (!named || named.firmId !== firmId) {
    throw new PublicError("unknown entity")
  }
  const linked = store.links.find(
    (l) => l.leftId === namedEntityId || l.rightId === namedEntityId
  )
  if (linked) {
    return { status: "POSSIBLE_CANDIDATE_REVIEW", identityBasis: "cnic" }
  }
  return { status: "CLEAR" }
}
