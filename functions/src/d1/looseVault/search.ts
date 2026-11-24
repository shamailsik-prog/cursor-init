import type { Classification } from "@/platform/p1/types"
import { HttpError } from "../../http/errors"
import type { Caller } from "../../p5/auth"
import { assertLooseVaultActor, canonicalLoose, firmDocumentDocs, looseReader } from "./flag"
import { looseTagMatches, readLooseTags, type LooseTags } from "./tags"

/** One loose file the actor may see. Holder is `uploadedBy` on the document row. */
export type HeldFile = {
  docId: string
  holderId: string
  classification: Classification
  looseTags: LooseTags
}

async function heldFiles(actor: Caller, match: (tags: LooseTags) => boolean): Promise<{ items: HeldFile[] }> {
  const readable = looseReader(actor)
  const items: HeldFile[] = []
  for (const doc of await firmDocumentDocs(actor.firmId)) {
    const data = doc.data()
    const record = canonicalLoose(doc.id, data)
    if (!record || record.matterId !== null || record.firmId !== actor.firmId) continue
    if (!readable(record)) continue
    const looseTags = readLooseTags(data.looseTags)
    if (!match(looseTags)) continue
    items.push({ docId: doc.id, holderId: record.uploadedBy, classification: record.classification, looseTags })
  }
  items.sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0))
  return { items }
}

/** Firm-scoped recall by any tag. E-18 roles only. Reads, and writes nothing. */
export async function searchLooseFiles(actor: Caller, query: string): Promise<{ items: HeldFile[] }> {
  assertLooseVaultActor(actor)
  if (typeof query !== "string" || query.length > 200) throw new HttpError(400, "invalid_query")
  const folded = query.normalize("NFKC").trim()
  if (folded.length === 0) throw new HttpError(400, "invalid_query")
  return heldFiles(actor, (tags) => looseTagMatches(tags, query))
}

/** Who holds which loose file in the actor's firm. E-18 roles only. Writes nothing. */
export async function listHeldFiles(actor: Caller): Promise<{ items: HeldFile[] }> {
  assertLooseVaultActor(actor)
  return heldFiles(actor, () => true)
}
