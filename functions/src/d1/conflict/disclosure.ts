import type { Classification } from "@/platform/p1/types"
import { isKnownClassification, rankOf } from "../../p5/classification"
import type { Hit, IdentityBasis, Outcome, Subject } from "./match"

/**
 * Disclosure of a conflict check to one reader (spec P2-15, R-2). The full check is stored;
 * every response goes through `discloseFor`. A non-partner sees a hit's matter (`matterId`,
 * `matterNo`, `matterClassification`) only for a matter they are a member of and cleared for;
 * a partner sees it when their clearance covers the matter's classification. Otherwise those
 * fields read "restricted". Outcome, hit count, subject, hit role, conflict type, identity
 * basis and matched name are always shown. No rule number is ever part of a check.
 */

export const RESTRICTED = "restricted"

/** A `conflict_checks` row as stored (plus its id). */
export type StoredCheck = {
  checkId: string
  firmId: string
  requestedBy: string
  subjects: Subject[]
  hits: Hit[]
  result: Outcome
  identityBasis: IdentityBasis
  classification: string
  decision: "pending" | "cleared"
  boundMatterId: string | null
  stale: boolean
  createdAt?: string | null
}

export type DisclosedHit = Omit<Hit, "matterId" | "matterNo" | "matterClassification"> & {
  matterId: string | null
  matterNo: string | null
  matterClassification: string
}

export type DisclosedCheck = {
  checkId: string
  requestedBy: string
  result: Outcome
  identityBasis: IdentityBasis
  decision: "pending" | "cleared"
  stale: boolean
  boundMatterId: string | null
  hitCount: number
  subjects: Subject[]
  hits: DisclosedHit[]
  createdAt: string | null
}

export type Reader = { role: string; clearanceLevel: Classification | string }

/** The reader is cleared for `classification`; an unreadable label on either side fails closed. */
function cleared(reader: Reader, classification: unknown): boolean {
  if (!isKnownClassification(classification) || !isKnownClassification(reader.clearanceLevel)) return false
  return rankOf(classification) <= rankOf(reader.clearanceLevel)
}

/** May `reader` see the details of matter `matterId` (classified `classification`)? */
function maySee(reader: Reader, matterId: string, classification: unknown, memberMatterIds: ReadonlySet<string>): boolean {
  if (!cleared(reader, classification)) return false
  return reader.role === "partner" || memberMatterIds.has(matterId)
}

/** The check as `reader` may see it; `memberMatterIds` are the matters the reader is a member of. */
export function discloseFor(reader: Reader, check: StoredCheck, memberMatterIds: ReadonlySet<string>): DisclosedCheck {
  const hits = check.hits.map((hit): DisclosedHit => {
    if (hit.matterId === null || maySee(reader, hit.matterId, hit.matterClassification, memberMatterIds)) return { ...hit }
    return { ...hit, matterId: RESTRICTED, matterNo: RESTRICTED, matterClassification: RESTRICTED }
  })
  const bound = check.boundMatterId
  // The bound matter's classification is not on the check; a non-member non-partner never sees its id.
  const boundVisible = bound === null || reader.role === "partner" || memberMatterIds.has(bound)
  return {
    checkId: check.checkId,
    requestedBy: check.requestedBy,
    result: check.result,
    identityBasis: check.identityBasis,
    decision: check.decision,
    stale: check.stale,
    boundMatterId: boundVisible ? bound : RESTRICTED,
    hitCount: hits.length,
    subjects: check.subjects,
    hits,
    createdAt: check.createdAt ?? null,
  }
}

/** The matter ids named by a check (hits and binding), for the reader's membership lookup. */
export function matterIdsOf(check: Pick<StoredCheck, "hits" | "boundMatterId">): string[] {
  const ids = new Set<string>()
  for (const hit of check.hits) if (hit.matterId !== null) ids.add(hit.matterId)
  if (check.boundMatterId !== null) ids.add(check.boundMatterId)
  return [...ids]
}
