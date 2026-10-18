/**
 * The citation and temporal gate as a pure function of a draft and an authority store (spec P4-6; E-22, E-39); its one
 * side effect is a log line when a run spends its authority budget (D24). It reports and never edits the body. Persistence, the draft's current version and the audit row belong to the
 * route, not here. It reports what it assessed (F06): a run with no citation and no temporal check is NOT_ASSESSED.
 *
 * Citations come from the one extractor the Next.js gate uses, de-duplicated as verifyCitations does (by judgment
 * id when found, else by canonical ref), and are judged by the one verdict rule (P4-2).
 */
import { logger } from "firebase-functions"
import { extractCitations, isUnrecognisedRef, normaliseCitation } from "@/services/d4-2/citations"
import { verdictFromTreatments, type Bench } from "@/services/d4-2/citationVerdict"
import { normaliseDraftBody } from "@/services/d4-2/draftCharset"
import type { AuthorityStore } from "./authority"
import { AuthorityUnavailableError } from "./authorityErrors"
import {
  GATE_SEVERITY,
  type CitationFinding,
  type CitationStatus,
  type GateEvaluation,
  type GateScope,
  type GateStatus,
  type TemporalCheck,
  type TemporalFinding,
} from "./types"

/**
 * The authority time one gate run may spend (#51 R1 D-7, plan D24): half the function timeout (120 s), so a long draft
 * against a slow corpus still returns a recorded, fail-closed result.
 */
export const AUTHORITY_BUDGET_MS = 60_000

/** Options for one run. `budgetMs` replaces AUTHORITY_BUDGET_MS (tests use a short one); `now` is the clock. */
export type GateRunOptions = { budgetMs?: number; now?: () => number }

/**
 * `store`, with its calls counted against one run's authority budget (D24). The time each call takes is added up. A
 * call still running when the budget runs out, and every call after it, throws AuthorityUnavailableError("budget"),
 * which the gate reads as any unavailable store: every remaining citation is UNVERIFIED and every remaining temporal
 * check TEMPORAL_UNAVAILABLE. A call cut off this way is not awaited: it settles on its own, within the adapter's
 * connect and statement timeouts, and its answer is dropped. The run logs `d4.authority_unavailable {reason: budget}`
 * once. Any other error from the store passes through unchanged. Exported (audit F17, spec ruling 2): committee-output
 * grounding resolves its citations under the same budget mechanism.
 */
export function budgetedStore(store: AuthorityStore, budgetMs: number, now: () => number): AuthorityStore {
  let used = 0
  let logged = false
  // Set when the budget timer fires: Date.now() can lag a timer by a millisecond or so, so `used` alone may still show
  // budget left after the cut-off, and a later call would reach the store.
  let exhausted = false
  const spent = (): AuthorityUnavailableError => {
    if (!logged) {
      logged = true
      logger.warn("d4.authority_unavailable", { reason: "budget" })
    }
    return new AuthorityUnavailableError("budget")
  }
  const call = async <T>(lookup: () => Promise<T>): Promise<T> => {
    const left = budgetMs - used
    if (exhausted || left <= 0) throw spent()
    const started = now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const work = (async () => lookup())()
    // A lookup the budget cut off may still fail later; that failure has nobody left to tell.
    work.catch(() => undefined)
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        exhausted = true
        reject(spent())
      }, left)
    })
    try {
      return await Promise.race([work, expiry])
    } finally {
      clearTimeout(timer)
      used += Math.max(0, now() - started)
    }
  }
  return {
    findJudgment: (canonical) => call(() => store.findJudgment(canonical)),
    listTreatments: (judgmentId) => call(() => store.listTreatments(judgmentId)),
    getSectionAsAt: (sectionId, asAtDate, jurisdiction) => call(() => store.getSectionAsAt(sectionId, asAtDate, jurisdiction)),
  }
}

/**
 * `lookup()`, or `fallback` when the store throws AuthorityUnavailableError (F05): an authority that cannot answer has
 * proven nothing, so the finding fails closed. Any other error is not caught: it is a bug and fails the request.
 */
async function orUnavailable<T, F>(lookup: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await lookup()
  } catch (e) {
    if (e instanceof AuthorityUnavailableError) return fallback
    throw e
  }
}

/** What `orUnavailable` falls back to in the citation steps below, when the store cannot answer. */
const UNAVAILABLE: unique symbol = Symbol("authority unavailable")

/**
 * The first step of resolving one extracted ref (audit F17, spec ruling 2: shared with committee-output grounding):
 * what it is, and the key the gate de-duplicates it by (`j:<judgmentId>` when found, else `r:<ref>`).
 * - `unrecognised`: a suspect the extractor could not read exactly; never looked up, never resolvable (E-22).
 * - `not_normalised`: a ref that is not exactly one reported citation. The store is asked for the canonical form
 *   only, so it is never looked up.
 * - `unavailable`: the store could not answer (AuthorityUnavailableError, F05).
 * - `not_found` / `found`: the store's answer for the canonical form; `ref` is the canonical citation.
 * Null for a blank ref. Any other store error is not caught: it is a bug and fails the request.
 */
export type CitationLookup =
  | { kind: "unrecognised" | "not_normalised" | "unavailable" | "not_found"; ref: string; key: string }
  | { kind: "found"; ref: string; key: string; judgmentId: string; benchType: Bench }

export async function lookUpCitation(raw: string, store: AuthorityStore): Promise<CitationLookup | null> {
  const ref = raw.trim()
  if (!ref) return null
  if (isUnrecognisedRef(ref)) return { kind: "unrecognised", ref, key: `r:${ref}` }
  const canonical = normaliseCitation(ref)
  if (!canonical) return { kind: "not_normalised", ref, key: `r:${ref}` }
  const found = await orUnavailable(() => store.findJudgment(canonical), UNAVAILABLE)
  if (found === UNAVAILABLE) return { kind: "unavailable", ref: canonical, key: `r:${canonical}` }
  if (!found) return { kind: "not_found", ref: canonical, key: `r:${canonical}` }
  return { kind: "found", ref: canonical, key: `j:${found.judgmentId}`, judgmentId: found.judgmentId, benchType: found.benchType }
}

/**
 * The second step, for a found judgment (audit F17, spec ruling 2): the verdict rule (P4-2) over the store's
 * treatments. Treatments it cannot list (unreachable, or an overruling still pending review) leave the judgment
 * UNVERIFIED, never VERIFIED (F05); `treatmentsUnavailable` says that the store could not list them.
 */
export async function verdictOfJudgment(
  found: { judgmentId: string; benchType: Bench },
  store: AuthorityStore
): Promise<{ status: CitationStatus; treatmentsUnavailable: boolean }> {
  const treatments = await orUnavailable(() => store.listTreatments(found.judgmentId), UNAVAILABLE)
  if (treatments === UNAVAILABLE) return { status: "UNVERIFIED", treatmentsUnavailable: true }
  return { status: verdictFromTreatments(found.benchType, treatments), treatmentsUnavailable: false }
}

async function checkCitations(text: string, store: AuthorityStore): Promise<CitationFinding[]> {
  const findings: CitationFinding[] = []
  const seen = new Set<string>()
  for (const raw of extractCitations(text)) {
    const lookup = await lookUpCitation(raw, store)
    if (lookup === null || seen.has(lookup.key)) continue
    seen.add(lookup.key)
    // A suspect, a ref that does not normalise, an unavailable store and an absent judgment are each UNVERIFIED with
    // no judgment id (E-22, F05); a found judgment takes the verdict rule's status.
    if (lookup.kind !== "found") {
      findings.push({ ref: lookup.ref, judgmentId: null, status: "UNVERIFIED" })
      continue
    }
    findings.push({ ref: lookup.ref, judgmentId: lookup.judgmentId, status: (await verdictOfJudgment(lookup, store)).status })
  }
  return findings
}

async function checkTemporal(check: TemporalCheck, store: AuthorityStore): Promise<TemporalFinding> {
  // An unavailable store reads as no history: TEMPORAL_UNAVAILABLE (F05).
  const inForce = await orUnavailable(() => store.getSectionAsAt(check.sectionId, check.asAtDate, check.jurisdiction), "no_history" as const)
  // No history is "verify manually", never a silent pass (L6900, E-39(2)). A null from an adapter reads the same way.
  // The finding is built from the four check fields and the outcome only, never by spreading the input: nothing
  // else a caller sent (an extra property, a forged status) can reach the stored result.
  const asked = { sectionId: check.sectionId, asAtDate: check.asAtDate, jurisdiction: check.jurisdiction, usedText: check.usedText }
  if (inForce === "no_history" || !inForce) return { ...asked, status: "TEMPORAL_UNAVAILABLE", inForceText: null }
  // Exact after NFC on both sides, so the same text typed in a decomposed form still matches (P4-6).
  const same = inForce.text.normalize("NFC") === check.usedText.normalize("NFC")
  return { ...asked, status: same ? "OK" : "TEMPORAL_MISMATCH", inForceText: inForce.text }
}

/**
 * Text as the pleading rule compares it (F06 ruling C): the draft body's own normalisation (`normaliseDraftBody`: paste
 * artefacts removed, CRLF as LF, NFC, ASCII digits and dashes), then every run of whitespace folded to one space.
 */
function pleadedForm(text: string): string {
  return normaliseDraftBody(text).replace(/\s+/gu, " ").trim()
}

/**
 * The checks that do not apply to this draft (F06 ruling C): those whose `usedText`, in `pleadedForm`, does not occur in
 * the title and body as `runGate` reads them (`title + "\n" + body`, in `pleadedForm`). A check the draft does not plead
 * verifies nothing the draft says, so it must not count as assessed scope: gateDraft refuses it (422
 * `temporal_check_not_in_draft`). The order of `checks` is kept; a blank usedText is never pleaded.
 */
export function unpleadedChecks(input: { title: string; body: string }, checks: readonly TemporalCheck[]): TemporalCheck[] {
  const text = pleadedForm(`${input.title}\n${input.body}`)
  return checks.filter((c) => {
    const used = pleadedForm(c.usedText)
    return used === "" || !text.includes(used)
  })
}

/**
 * What a run assessed (F06): the citation findings (an UNRECOGNISED suspect counts) and the temporal checks, and
 * whether at least one ran. Derived from the findings alone.
 */
export function scopeOf(citations: readonly unknown[], temporal: readonly unknown[]): GateScope {
  return { citations: citations.length, temporalChecks: temporal.length, assessed: citations.length + temporal.length > 0 }
}

/**
 * The most severe status across the findings; a VERIFIED citation and an OK check both count as OK. No finding at
 * all, no citation and no temporal check, is NOT_ASSESSED, never OK (F06): an empty list proves that nothing legal was
 * checked, not that the draft is sound. It fails closed: a status outside the domain (which the typed code cannot
 * produce today) counts as UNVERIFIED, so it can never pass as OK, and it never hides a more severe status.
 */
function overall(citations: readonly CitationFinding[], temporal: readonly TemporalFinding[]): GateStatus {
  if (!scopeOf(citations, temporal).assessed) return "NOT_ASSESSED"
  const present = new Set<string>()
  for (const c of citations) present.add(c.status === "VERIFIED" ? "OK" : c.status)
  for (const t of temporal) present.add(t.status)
  if ([...present].some((s) => !GATE_SEVERITY.includes(s as GateStatus))) present.add("UNVERIFIED")
  return GATE_SEVERITY.find((s) => present.has(s)) ?? "UNVERIFIED"
}

/**
 * One gate run: the findings, the overall status and the assessed scope (F06). Every authority lookup of the run shares
 * one budget (D24).
 */
export async function runGate(
  input: { title: string; body: string; temporalChecks: readonly TemporalCheck[] },
  authority: AuthorityStore,
  options: GateRunOptions = {}
): Promise<GateEvaluation> {
  const store = budgetedStore(authority, options.budgetMs ?? AUTHORITY_BUDGET_MS, options.now ?? Date.now)
  const citations = await checkCitations(`${input.title}\n${input.body}`, store)
  const temporal: TemporalFinding[] = []
  for (const check of input.temporalChecks) temporal.push(await checkTemporal(check, store))
  return { status: overall(citations, temporal), citations, temporal, scope: scopeOf(citations, temporal) }
}
