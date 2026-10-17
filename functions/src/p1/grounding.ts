/**
 * Grounding a committee answer (audit F17; spec docs/superpowers/specs/2026-10-17-f17-grounded-committee-output-design.md,
 * rulings 2 and 3). A provider call that succeeded says nothing about whether its content is true; this says whether
 * each authority the answer relies on exists in the firm's corpus and is still good law there.
 *
 * The answer is read against the committee answer contract (platform/p1/committeeAnswer.ts). Every authority a claim
 * cites, and every citation the D4 extractor finds in the answer's prose (headings, texts, statements, pinpoints and
 * caveats; the whole text when the answer is unstructured), is resolved through the D4 gate's own steps
 * (`lookUpCitation`, `verdictOfJudgment`, under `budgetedStore`): the same extractor, normaliser, verdict rule and
 * authority store, never a fork. The store is the one the gate uses (`activeAuthorityStore`): with no corpus configured
 * it is EMPTY (F05) and nothing is ever grounded.
 *
 * Per citation: VERIFIED and OVERRULED are the verdict rule's; PENDING_OVERRULING is a found judgment the rule leaves
 * UNVERIFIED (an overruling whose effect cannot be established); UNVERIFIED is a citation not found in the corpus, or
 * any authority a claim declares as a statute, rule or other (the port has no statute lookup by citation);
 * UNRECOGNISED is an extractor suspect, or a judgment authority that is not exactly one reported citation; UNAVAILABLE
 * is a lookup the store could not answer (F05), the budget included.
 *
 * Only an authority a claim declares `judgment` is resolved through the judgment path (rules f17.2, review round:
 * Codex P1 on PR #63). A statute, rule or other authority is never looked up, whatever its citation reads as: it is
 * UNVERIFIED, and when its citation is a reported judgment citation it is marked `kindMismatch: true`. It is recorded
 * under its own key (kind and ref), so the same citation found in the prose (resolved as a judgment, source `text`)
 * stays a separate entry: a claim is supported only by its own declared judgment authorities, never by a prose hit.
 *
 * Every prose field is also read by `proseAuthority.ts` for what the D4 extractor does not see (rules f17.3, re-audit
 * ruling R7a): a report shape that reads as one reported citation is resolved like any other; any other report shape,
 * and every case name, case number, page-only reference or "reported at/in/as" that is not bound to a VERIFIED citation
 * next to it, is an UNRECOGNISED suspect from the text (masked, then bounded), under the same cap.
 *
 * Status rules `f17.3`, in order: no text, `not_assessed`; the contract not met, `unstructured`; no citation at all,
 * `not_assessed` (F06: never OK); any OVERRULED, PENDING_OVERRULING, UNVERIFIED or UNRECOGNISED citation,
 * `partially_grounded` when some claim is supported (it cites at least one authority and every one is VERIFIED), else
 * `ungrounded`; any UNAVAILABLE citation or any omitted, `unverifiable`; otherwise `grounded` when every claim (at least
 * one) is supported, else `partially_grounded`. Everything but `grounded` is advisory.
 *
 * No answer text is recorded: a ref is a canonical citation, or at most 80 characters of a citation the extractor or
 * the contract could not read; every ref is masked again with the call's party names (a canonical citation can carry a
 * bracketed sub-series read from the text). A failure never loses the answer: an
 * unavailable store gives UNAVAILABLE citations, and any other error is logged by its code only (`p1.grounding_failed`)
 * and gives `unverifiable`.
 */
import { logger } from "firebase-functions"
import { parseCommitteeAnswer, type AuthorityKind, type CommitteeAnswer } from "@/platform/p1/committeeAnswer"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { UNRECOGNISED_PREFIX, extractCitations, normaliseCitation } from "@/services/d4-2/citations"
import type { AuthorityStore } from "../d4/authority"
import { budgetedStore, lookUpCitation, verdictOfJudgment, type CitationLookup } from "../d4/gate"
import { errorCode } from "../log"
import { authorityMentions, normaliseProse, unboundMentions, type VerifiedSpan } from "./proseAuthority"

/**
 * The status rules above. A change to them changes the evaluation's outcomes: the CI gate requires a new record.
 * f17.1 (PR #63 round 1); f17.2 (review round): a statute, rule or other authority is never resolved as a judgment;
 * f17.3 (re-audit round, ruling R7a): an authority-like mention in the prose that is not bound to a VERIFIED citation is
 * an UNRECOGNISED suspect.
 */
export const GROUNDING_RULES_VERSION = "f17.4"

/**
 * The authority time one grounding run may spend (ruling 6, refinement R6a). It runs while the call records its attempt
 * outcome, exports its trace and commits, so ops.ts holds it within those phases at import: it adds nothing to the
 * request's worst case.
 */
export const GROUNDING_BUDGET_MS = 20_000

/** Distinct citations looked up per answer; any beyond are counted in `omitted`, never looked up. */
export const MAX_GROUNDED_CITATIONS = 100

/** The most of an unreadable citation a ref keeps (code points), as the extractor keeps of a suspect. */
const MAX_REF_CHARS = 80

export const GROUNDING_STATUSES = ["grounded", "partially_grounded", "ungrounded", "unverifiable", "unstructured", "not_assessed"] as const
export type GroundingStatus = (typeof GROUNDING_STATUSES)[number]

export const CITATION_GROUNDING_STATUSES = ["VERIFIED", "OVERRULED", "PENDING_OVERRULING", "UNVERIFIED", "UNRECOGNISED", "UNAVAILABLE"] as const
export type CitationGroundingStatus = (typeof CITATION_GROUNDING_STATUSES)[number]

export type CitationSource = "claim" | "text" | "both"
/**
 * One cited authority. `kindMismatch: true` (present only then) marks a statute, rule or other authority whose citation
 * reads as a reported judgment citation: it was not looked up (rules f17.2).
 */
export type GroundedCitation = {
  ref: string
  kind: AuthorityKind
  source: CitationSource
  status: CitationGroundingStatus
  judgmentId: string | null
  kindMismatch?: true
}

/** The system policy the answer was asked under, by reference (F16); null for an answer recorded before F16. */
export type GroundingPolicy = { policyId: string; version: string }

export type Grounding = {
  status: GroundingStatus
  rules: string
  policy: GroundingPolicy | null
  claims: { total: number; supported: number }
  citations: GroundedCitation[]
  omitted: number
}

export type GroundInput = { text: string | undefined; policy: GroundingPolicy | null; partyNames: readonly string[] }
export type GroundOptions = { budgetMs?: number; now?: () => number }

/** True unless the answer is grounded (ruling 3): advisory content needs a lawyer's check before it is relied on. */
export function isAdvisory(grounding: Pick<Grounding, "status">): boolean {
  return grounding.status !== "grounded"
}

/** The record of a grounding run that failed before it could resolve anything (ruling 6): unverifiable, nothing resolved. */
export function unverifiableGrounding(policy: GroundingPolicy | null, claimsTotal = 0): Grounding {
  return { status: "unverifiable", rules: GROUNDING_RULES_VERSION, policy, claims: { total: claimsTotal, supported: 0 }, citations: [], omitted: 0 }
}

const DEFINITE_FAILURES: ReadonlySet<CitationGroundingStatus> = new Set(["OVERRULED", "PENDING_OVERRULING", "UNVERIFIED", "UNRECOGNISED"])

type Authority = CommitteeAnswer["sections"][number]["claims"][number]["authorities"][number]
/** One prose field; a pinpoint carries the authority it is the pinpoint of. */
type ProseField = { text: string; pinpointOf?: Authority }

/** The prose of a structured answer, field by field (each read on its own, so no citation spans two fields). */
function proseOf(answer: CommitteeAnswer): ProseField[] {
  const out: ProseField[] = []
  for (const s of answer.sections) {
    out.push({ text: s.heading }, { text: s.text })
    for (const c of s.claims) {
      out.push({ text: c.statement })
      for (const a of c.authorities) if (a.pinpoint !== undefined) out.push({ text: a.pinpoint, pinpointOf: a })
    }
  }
  for (const caveat of answer.caveats) out.push({ text: caveat })
  return out
}

/** Lower case, blanks collapsed: how a mention is compared with the text of a D4 extractor suspect. */
const comparable = (s: string): string => s.replace(/\s+/gu, " ").trim().toLowerCase()

/**
 * At most MAX_REF_CHARS code points, cut at the last blank before the limit (re-audit round 2: never half a word, so
 * never part of a name; never half a surrogate pair). A first word longer than the limit is cut at the limit.
 */
const bounded = (s: string): string => {
  const points = [...s]
  if (points.length <= MAX_REF_CHARS) return s
  const cut = points.slice(0, MAX_REF_CHARS + 1).join("")
  const blank = cut.search(/\s\S*$/u)
  return blank > 0 ? cut.slice(0, blank).trimEnd() : points.slice(0, MAX_REF_CHARS).join("")
}

export async function groundAnswer(input: GroundInput, store: AuthorityStore, options: GroundOptions = {}): Promise<Grounding> {
  const base = { rules: GROUNDING_RULES_VERSION, policy: input.policy }
  if (input.text === undefined) return { status: "not_assessed", ...base, claims: { total: 0, supported: 0 }, citations: [], omitted: 0 }
  const parsed = parseCommitteeAnswer(input.text)
  const claims = parsed.ok ? parsed.answer.sections.flatMap((s) => s.claims) : []
  try {
    return await ground(input, parsed.ok ? parsed.answer : null, store, options)
  } catch (err) {
    // A bug-class failure (anything but AuthorityUnavailableError, which the steps read as UNAVAILABLE): the answer is
    // still published, as unverifiable; the log carries the error's code only, never its text.
    logger.warn("p1.grounding_failed", { code: errorCode(err) })
    return unverifiableGrounding(input.policy, claims.length)
  }
}

async function ground(input: GroundInput, answer: CommitteeAnswer | null, authority: AuthorityStore, options: GroundOptions): Promise<Grounding> {
  const store = budgetedStore(authority, options.budgetMs ?? GROUNDING_BUDGET_MS, options.now ?? Date.now)
  const partyNames = [...input.partyNames]
  const mask = (s: string): string => maskOutboundPII(s, { partyNames }).masked
  const lookups = new Map<string, CitationLookup | null>()
  const verdicts = new Map<string, Awaited<ReturnType<typeof verdictOfJudgment>>>()
  const omitted = new Set<string>()
  const citations = new Map<string, GroundedCitation>()
  /** The prose suspects recorded (ruling R7a); with the lookups, they share the MAX_GROUNDED_CITATIONS cap. */
  const suspectKeys = new Set<string>()
  const taken = (): number => lookups.size + suspectKeys.size

  const record = (key: string, entry: GroundedCitation): void => {
    const seen = citations.get(key)
    if (seen === undefined) citations.set(key, entry)
    else if (seen.source !== entry.source) seen.source = "both"
  }

  /**
   * A claim authority declared statute, rule or other (rules f17.2): never looked up, whatever its citation reads as, and
   * UNVERIFIED. A citation that reads as a reported judgment citation is shown in its canonical form and marked
   * `kindMismatch`. Its key carries the kind, so it never merges with a judgment entry of the same citation.
   */
  const declared = (raw: string, kind: Exclude<AuthorityKind, "judgment">): CitationGroundingStatus => {
    const canonical = normaliseCitation(raw)
    const ref = canonical === null ? bounded(mask(raw.replace(/\s+/gu, " ").trim())) : mask(canonical)
    record(`k:${kind}:${ref}`, { ref, kind, source: "claim", status: "UNVERIFIED", judgmentId: null, ...(canonical === null ? {} : { kindMismatch: true as const }) })
    return "UNVERIFIED"
  }

  /**
   * One cited string resolved as a judgment (a claim authority declared `judgment`, or a prose hit): looked up once,
   * recorded once per de-duplication key; its status, or null for a blank one.
   */
  const resolve = async (raw: string, source: "claim" | "text"): Promise<CitationGroundingStatus | "OMITTED" | null> => {
    const kind: AuthorityKind = "judgment"
    let lookup = lookups.get(raw)
    if (lookup === undefined && !lookups.has(raw)) {
      if (taken() >= MAX_GROUNDED_CITATIONS) {
        omitted.add(raw)
        return "OMITTED"
      }
      lookup = await lookUpCitation(raw, store)
      lookups.set(raw, lookup)
    }
    if (!lookup) return null
    let status: CitationGroundingStatus
    // A canonical citation can carry a bracketed sub-series read from the text: masked like every other ref.
    let ref = mask(lookup.ref)
    let judgmentId: string | null = null
    switch (lookup.kind) {
      case "unrecognised":
        status = "UNRECOGNISED"
        ref = UNRECOGNISED_PREFIX + bounded(mask(lookup.ref.slice(UNRECOGNISED_PREFIX.length).replace(/\s+/gu, " ").trim()))
        break
      case "not_normalised":
        // A judgment authority must be exactly one reported citation.
        status = "UNRECOGNISED"
        ref = UNRECOGNISED_PREFIX + bounded(mask(lookup.ref.replace(/\s+/gu, " ").trim()))
        break
      case "unavailable":
        status = "UNAVAILABLE"
        break
      case "not_found":
        status = "UNVERIFIED"
        break
      case "found": {
        judgmentId = lookup.judgmentId
        let verdict = verdicts.get(lookup.judgmentId)
        if (verdict === undefined) {
          verdict = await verdictOfJudgment(lookup, store)
          verdicts.set(lookup.judgmentId, verdict)
        }
        status = verdict.treatmentsUnavailable
          ? "UNAVAILABLE"
          : verdict.status === "VERIFIED"
            ? "VERIFIED"
            : verdict.status === "OVERRULED"
              ? "OVERRULED"
              : "PENDING_OVERRULING"
        break
      }
    }
    record(lookup.kind === "found" ? lookup.key : `r:${ref}`, { ref, kind, source, status, judgmentId })
    return status
  }

  /**
   * A prose mention that is not a citation the corpus can answer (ruling R7a): UNRECOGNISED, from the text, its words
   * masked with the party names and then bounded (so a name is never cut before it is masked). Counted against the cap.
   */
  const suspect = (raw: string): void => {
    // Past the cap the suspect is counted, unmasked words as its key (never recorded), before any masking work: the
    // re-auditor's 256 KB of distinct case numbers spent its time masking suspects nobody would see.
    if (taken() >= MAX_GROUNDED_CITATIONS) {
      omitted.add(`s:${comparable(raw)}`)
      return
    }
    const ref = UNRECOGNISED_PREFIX + bounded(mask(raw.replace(/\s+/gu, " ").trim()))
    const key = `r:${ref}`
    if (citations.has(key)) return
    suspectKeys.add(key)
    record(key, { ref, kind: "judgment", source: "text", status: "UNRECOGNISED", judgmentId: null })
  }
  const canonicals = new Map<string, string | null>()
  const canonicalOf = (raw: string): string | null => {
    if (!canonicals.has(raw)) canonicals.set(raw, normaliseCitation(raw))
    return canonicals.get(raw) ?? null
  }

  /**
   * One prose field (ruling R7a): every citation the D4 extractor finds, resolved as a judgment; then every
   * authority-like mention it does not see (`authorityMentions`). A report-shaped mention that reads as one reported
   * citation is resolved the same way and, VERIFIED, can bind the case name, number or page next to it; any other is a
   * suspect, as is every case name, case number, page-only reference or "reported at/in/as" not bound to a VERIFIED
   * citation (`unboundMentions`). A mention the extractor already flagged as its own suspect is not recorded twice.
   */
  const groundField = async (field: ProseField, verifiedPinpoint: boolean): Promise<void> => {
    // R7b: the field is read normalised (NFKC, format characters removed, digits and dashes folded) and masked whole
    // with the party names first, so no name is ever split by a mention's extent or cut, and every ref comes from
    // masked text. On the route the text was masked already (callP1): masking again changes nothing there.
    const view = mask(normaliseProse(field.text))
    const extracted = extractCitations(view)
    for (const raw of extracted) await resolve(raw, "text")
    const flagged = extracted.filter((r) => r.startsWith(UNRECOGNISED_PREFIX)).map((r) => comparable(r.slice(UNRECOGNISED_PREFIX.length)))
    const alreadyFlagged = (raw: string): boolean => {
      const words = comparable(raw)
      return flagged.some((f) => f.length > 0 && (f.includes(words) || words.includes(f)))
    }
    /** A mention to record as a suspect: counted past the cap; not twice when the extractor flagged it already. */
    const flag = (raw: string): void => {
      if (taken() >= MAX_GROUNDED_CITATIONS || !alreadyFlagged(raw)) suspect(raw)
    }
    const mentions = authorityMentions(view)
    const verified: VerifiedSpan[] = []
    for (const m of mentions) {
      if (m.family !== "report") continue
      // The cap is spent by `resolve` (a new lookup) and `suspect` (a new suspect) only: a citation already resolved costs nothing.
      const canonical = canonicalOf(m.raw)
      if (canonical === null) flag(m.raw)
      else if ((await resolve(canonical, "text")) === "VERIFIED") verified.push({ start: m.start, end: m.end })
    }
    for (const m of unboundMentions(view, mentions, verified, { pinpointOfVerified: verifiedPinpoint })) flag(m.raw)
  }

  const claims = answer === null ? [] : answer.sections.flatMap((s) => s.claims)
  const authorityStatus = new Map<Authority, CitationGroundingStatus | "OMITTED" | null>()
  let supported = 0
  for (const claim of claims) {
    // A claim's support is its own declared authorities' statuses only, never a prose hit of the same citation.
    const statuses: Array<CitationGroundingStatus | "OMITTED" | null> = []
    for (const a of claim.authorities) {
      const status = a.kind === "judgment" ? await resolve(a.citation, "claim") : declared(a.citation, a.kind)
      authorityStatus.set(a, status)
      statuses.push(status)
    }
    if (statuses.length > 0 && statuses.every((s) => s === "VERIFIED")) supported += 1
  }
  const fields: ProseField[] = answer === null ? [{ text: input.text ?? "" }] : proseOf(answer)
  for (const field of fields) {
    const of = field.pinpointOf
    await groundField(field, of !== undefined && of.kind === "judgment" && authorityStatus.get(of) === "VERIFIED")
  }

  const list = [...citations.values()]
  const statuses = new Set(list.map((c) => c.status))
  let status: GroundingStatus
  if (answer === null) status = "unstructured"
  else if (list.length === 0 && omitted.size === 0) status = "not_assessed"
  else if ([...statuses].some((s) => DEFINITE_FAILURES.has(s))) status = supported > 0 ? "partially_grounded" : "ungrounded"
  else if (statuses.has("UNAVAILABLE") || omitted.size > 0) status = "unverifiable"
  else status = claims.length > 0 && supported === claims.length ? "grounded" : "partially_grounded"

  return {
    status,
    rules: GROUNDING_RULES_VERSION,
    policy: input.policy,
    claims: { total: claims.length, supported },
    citations: list,
    omitted: omitted.size,
  }
}
