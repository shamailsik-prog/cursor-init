import courtsSeed from "@/data/courts.json"
import { loadCourts, normalise } from "@/core/case-number-normaliser"
import type { ClassifyInput, ClassifyOutput, ClientType, CourtView, FollowUpReason, IntakeClassifier, Urgency } from "./types"
import { CLIENT_TYPES } from "./types"

/**
 * Deterministic practice-area and urgency rules, plus the POL-7 court rule:
 * only the seeded prefix table is consulted, and an ambiguous or unknown
 * prefix is a follow-up. It is never mapped to a practice area.
 */

const courts = loadCourts(courtsSeed as Parameters<typeof loadCourts>[0])

const PRACTICE: ReadonlyArray<{ area: string; pattern: RegExp }> = [
  { area: "nab", pattern: /\bnab\b|national accountability/i },
  { area: "criminal", pattern: /\b(bail|fir|challan|criminal|penal)\b/i },
  { area: "constitutional", pattern: /\b(writ|constitution|fundamental right)\b|article\s*199/i },
  { area: "corporate", pattern: /\b(secp|company|shares|director)\b/i },
  { area: "land", pattern: /\b(khasra|mutation|patwari)\b|\bland\b|revenue record/i },
  { area: "family", pattern: /\b(divorce|khula|custody|guardianship|maintenance)\b/i },
  { area: "tax", pattern: /income tax|sales tax|\bfbr\b/i },
  { area: "civil", pattern: /\b(suit|recovery|contract|injunction|damages|civil)\b/i },
]

const COMPANY = /\b(pvt|ltd|limited|llc|inc|company)\b/i
const PERSON = /^(mr|mrs|ms|miss|dr)\.?\s+\S/i

function practiceAreaOf(text: string): string | null {
  return PRACTICE.find((rule) => rule.pattern.test(text))?.area ?? null
}

function urgencyOf(text: string): Urgency {
  if (/\b(right now|immediately)\b/i.test(text)) return "immediate"
  if (/\b(urgent|stay|injunction|bail)\b/i.test(text)) return "urgent"
  return "routine"
}

export function isClientType(value: unknown): value is ClientType {
  return typeof value === "string" && (CLIENT_TYPES as readonly string[]).includes(value)
}

/** A supplied type is kept. Otherwise a clear marker is used. Anything else stays unknown. */
export function resolveEntityType(name: string, supplied: ClientType | null): ClientType | null {
  if (supplied) return supplied
  if (COMPANY.test(name)) return "company"
  if (PERSON.test(name)) return "individual"
  return null
}

function courtOf(ref: { raw: string; courtId: string } | undefined): CourtView | null {
  if (!ref) return null
  // Own keys only: "constructor" is not a seeded court and must not be read off the prototype.
  if (!Object.hasOwn(courts, ref.courtId)) return { raw: ref.raw, courtId: ref.courtId, status: "rejected" }
  const result = normalise(ref.raw, ref.courtId, courts)
  if (result.status === "REJECT") return { raw: ref.raw, courtId: ref.courtId, status: "rejected" }
  const view: CourtView = { raw: ref.raw, courtId: ref.courtId, status: result.status === "AMBIGUOUS" ? "ambiguous" : "ok", prefix: result.prefix }
  if (result.status === "OK") view.canonical = result.canonical
  return view
}

export const keywordIntakeClassifier: IntakeClassifier = {
  classify(input: ClassifyInput): ClassifyOutput {
    const prospectType = resolveEntityType(input.prospectName, input.prospectType)
    const court = courtOf(input.courtRef)
    const reasons: FollowUpReason[] = []
    if (court?.status === "ambiguous") reasons.push("ambiguous_court_prefix")
    if (court?.status === "rejected") reasons.push("unknown_court_prefix")
    if (prospectType === null) reasons.push("ambiguous_entity")
    return {
      // Keywords on the enquiry text only. The court prefix is not an input to this.
      practiceArea: practiceAreaOf(input.text),
      urgency: urgencyOf(input.text),
      followUp: reasons.length > 0,
      followUpReasons: reasons,
      prospectType,
      court,
    }
  },
}
