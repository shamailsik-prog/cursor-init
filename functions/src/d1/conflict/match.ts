import { skeleton } from "./normalise"

/**
 * Pure Module 6 conflict matching (spec P2-3, P2-4, P2-5, P2-16; L18 §7). No I/O: the caller
 * loads candidates, resolves link states and normalises names and keys before calling `screen`.
 */

export type Role = "client" | "opposing"
export type Keys = { cnic?: string; ntn?: string; secp?: string; phone?: string }
export type Subject = { role: Role; name: string; keys: Keys; clientId?: string }
export type Outcome = "CLEAR" | "FLAG" | "POSSIBLE_CANDIDATE_REVIEW"
export type IdentityBasis = "confirmed_identity" | "candidate_only"
export type ConflictType = "direct_adverse" | "former_client" | "adverse_history" | "informational"
export type Hit = {
  subjectIndex: number
  hitRole: Role
  type: ConflictType
  basis: "key" | "name"
  score: number
  identityBasis: IdentityBasis
  outcome: "FLAG" | "POSSIBLE_CANDIDATE_REVIEW" | "NONE"
  matchedName: string
  matterId: string | null
  matterNo: string | null
  matterClassification: string
  reliedOnLinkIds: string[]
  /** The matched candidate's unresolved entity links (P2-5), so a reviewer can find the evidence. */
  unresolvedLinkIds?: string[]
  /** The candidate's registry identity ("client:{id}" or "party:{id}"), for the re-screen at open; never disclosed. */
  candidateId?: string
  review?: { resolution: "different_person" | "same_person"; by: string; note: string; at: string }
}

/** One registry row to screen against: a firm client or an opposing `matter_parties` row. */
export type Candidate = {
  /** Registry identity: "client:{clientId}" or "party:{matter_parties id}". */
  candidateId?: string
  role: Role
  name: string
  forms: string[][]
  keys: Keys
  entityId?: string
  matterId: string | null
  matterNo: string | null
  matterClassification: string
  matterStatus: "live" | "closed" | null
  clientHasLiveMatter: boolean
  linkState: "none" | "candidate" | "confirmed"
  linkIds: string[]
  unresolvedLinkIds: string[]
}

export type ScreenOptions = {
  /** Per subject: its name went through the lossy script fallback, so also compare consonant skeletons. */
  subjectFallback?: boolean[]
  /** Per subject: the entityId of the subject's `clientId`, resolved by the caller. */
  subjectEntityIds?: (string | undefined)[]
}

export type ScreenResult = { hits: Hit[]; result: Outcome; identityBasis: IdentityBasis }

/** Name hit threshold (P2-16): token-set ratio ≥ 0.80. */
export const NAME_THRESHOLD = 0.8

const KEY_FIELDS = ["cnic", "ntn", "secp", "phone"] as const

/** Indel distance (Levenshtein with insertions and deletions only), as rapidfuzz's `ratio` uses. */
function indelDistance(a: string, b: string): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array<number>(b.length + 1).fill(0)
  let cur = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    ;[prev, cur] = [cur, prev]
  }
  return a.length + b.length - 2 * prev[b.length]
}

/** Similarity in 0..1 from a distance and the summed lengths; division keeps exact fractions exact. */
const normSim = (dist: number, lensum: number): number => (lensum === 0 ? 1 : (lensum - dist) / lensum)

/**
 * rapidfuzz `fuzz.token_set_ratio` / 100 over pre-split tokens: compares the sorted token
 * intersection with each side's intersection-plus-remainder; 1 when one set contains the other.
 */
export function tokenSetRatio(a: string[], b: string[]): number {
  const setA = new Set(a.filter((t) => t !== ""))
  const setB = new Set(b.filter((t) => t !== ""))
  if (setA.size === 0 || setB.size === 0) return 0
  const sect = [...setA].filter((t) => setB.has(t)).sort()
  const diffAB = [...setA].filter((t) => !setB.has(t)).sort()
  const diffBA = [...setB].filter((t) => !setA.has(t)).sort()
  if (sect.length > 0 && (diffAB.length === 0 || diffBA.length === 0)) return 1

  const ab = diffAB.join(" ")
  const ba = diffBA.join(" ")
  const sectLen = sect.join(" ").length
  const sep = sectLen > 0 ? 1 : 0
  const sectAbLen = sectLen + sep + ab.length
  const sectBaLen = sectLen + sep + ba.length

  // "sect ab" vs "sect ba": the shared prefix cancels, leaving the distance between the remainders.
  let best = normSim(indelDistance(ab, ba), sectAbLen + sectBaLen)
  if (sectLen === 0) return best
  best = Math.max(best, normSim(sep + ab.length, sectLen + sectAbLen))
  best = Math.max(best, normSim(sep + ba.length, sectLen + sectBaLen))
  return best
}

function bestRatio(left: string[][], right: string[][], map?: (t: string[]) => string[]): number {
  let best = 0
  for (const l of left) {
    const lt = map ? map(l) : l
    for (const r of right) {
      best = Math.max(best, tokenSetRatio(lt, map ? map(r) : r))
      if (best === 1) return 1
    }
  }
  return best
}

function conflictType(subjectRole: Role, c: Candidate): ConflictType {
  if (subjectRole === c.role) return "informational"
  if (subjectRole === "client") return "adverse_history"
  return c.clientHasLiveMatter ? "direct_adverse" : "former_client"
}

const RANK: Record<Hit["outcome"], number> = { NONE: 0, POSSIBLE_CANDIDATE_REVIEW: 1, FLAG: 2 }

/**
 * Screens every subject against every candidate. One hit at most per (subject, candidate):
 * basis `key` (score 1) on an equal normalised key or the subject client's own entity, else
 * basis `name` when the best token-set ratio over form pairs is ≥ 0.80. Different non-empty
 * CNICs on both sides (and no shared entity) never confirm an identity, but neither do they
 * clear it (P2-3, P2-16): a name hit or another equal key is then a basis `name` hit, a review
 * item when it crosses sides and NONE when it does not. Role-crossing hits FLAG only on a confirmed
 * identity; otherwise they, and any hit on a candidate with an unresolved link, are review items.
 * Per-subject arrays must match `subjects` in length (a mismatch throws: never a silent no-match).
 */
export function screen(
  subjects: Subject[],
  subjectForms: string[][][],
  candidates: Candidate[],
  opts?: ScreenOptions
): ScreenResult {
  if (subjectForms.length !== subjects.length) throw new Error("screen: subjectForms length differs from subjects")
  if (opts?.subjectFallback !== undefined && opts.subjectFallback.length !== subjects.length) {
    throw new Error("screen: subjectFallback length differs from subjects")
  }
  if (opts?.subjectEntityIds !== undefined && opts.subjectEntityIds.length !== subjects.length) {
    throw new Error("screen: subjectEntityIds length differs from subjects")
  }
  const hits: Hit[] = []
  subjects.forEach((subject, subjectIndex) => {
    const forms = subjectForms[subjectIndex]
    const fallback = opts?.subjectFallback?.[subjectIndex] === true
    const subjectEntity = subject.clientId ? opts?.subjectEntityIds?.[subjectIndex] : undefined

    for (const c of candidates) {
      const sameEntity = subjectEntity !== undefined && subjectEntity !== "" && subjectEntity === c.entityId
      const sc = subject.keys.cnic
      const cc = c.keys.cnic
      // Two different CNICs: no key can confirm this pair, so any match is name-basis only.
      const cnicsDiffer = !sameEntity && !!sc && !!cc && sc !== cc

      const keyEqual = KEY_FIELDS.some((k) => !!subject.keys[k] && subject.keys[k] === c.keys[k])
      const keyHit = sameEntity || (keyEqual && !cnicsDiffer)
      let score = 1
      if (!keyHit) {
        score = bestRatio(forms, c.forms)
        if (fallback && score < NAME_THRESHOLD) score = Math.max(score, bestRatio(forms, c.forms, skeleton))
        // An equal phone/NTN/SECP beside differing CNICs still asks for review (score 1: the key matched).
        if (keyEqual) score = 1
        if (score < NAME_THRESHOLD) continue
      }

      const confirmed = keyHit && (sameEntity || c.linkState === "confirmed")
      const unresolved = c.unresolvedLinkIds.length > 0
      const type = conflictType(subject.role, c)
      const outcome: Hit["outcome"] =
        type === "informational"
          ? unresolved && !cnicsDiffer
            ? "POSSIBLE_CANDIDATE_REVIEW"
            : "NONE"
          : confirmed
            ? "FLAG"
            : "POSSIBLE_CANDIDATE_REVIEW"

      hits.push({
        subjectIndex,
        hitRole: c.role,
        type,
        basis: keyHit ? "key" : "name",
        score,
        // A review item is always candidate_only: it asks a human to settle an identity.
        identityBasis: confirmed && outcome !== "POSSIBLE_CANDIDATE_REVIEW" ? "confirmed_identity" : "candidate_only",
        outcome,
        matchedName: c.name,
        matterId: c.matterId,
        matterNo: c.matterNo,
        matterClassification: c.matterClassification,
        reliedOnLinkIds: keyHit && keyEqual ? [...c.linkIds] : [],
        ...(unresolved ? { unresolvedLinkIds: [...c.unresolvedLinkIds] } : {}),
        ...(c.candidateId !== undefined ? { candidateId: c.candidateId } : {})
      })
    }
  })

  return { hits, ...summarise(hits) }
}

/** The overall result (precedence FLAG > POSSIBLE_CANDIDATE_REVIEW > CLEAR) and identity basis of `hits`. */
export function summarise(hits: readonly Hit[]): { result: Outcome; identityBasis: IdentityBasis } {
  const top = hits.reduce((m, h) => Math.max(m, RANK[h.outcome]), 0)
  const result: Outcome = top === 2 ? "FLAG" : top === 1 ? "POSSIBLE_CANDIDATE_REVIEW" : "CLEAR"
  const identityBasis: IdentityBasis = hits.some((h) => h.outcome !== "NONE" && h.identityBasis === "candidate_only")
    ? "candidate_only"
    : "confirmed_identity"
  return { result, identityBasis }
}
