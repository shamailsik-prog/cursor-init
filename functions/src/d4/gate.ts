/**
 * The citation and temporal gate as a pure function of a draft and an authority store (spec P4-6; E-22, E-39).
 * It reports and never edits the body. Persistence, the draft's current version and the audit row belong to the
 * route, not here. It reports what it assessed (F06): a run with no citation and no temporal check is NOT_ASSESSED.
 *
 * Citations come from the one extractor the Next.js gate uses, de-duplicated as verifyCitations does (by judgment
 * id when found, else by canonical ref), and are judged by the one verdict rule (P4-2).
 */
import { extractCitations, isUnrecognisedRef, normaliseCitation } from "@/services/d4-2/citations"
import { verdictFromTreatments } from "@/services/d4-2/citationVerdict"
import { normaliseDraftBody } from "@/services/d4-2/draftCharset"
import type { AuthorityStore } from "./authority"
import {
  GATE_SEVERITY,
  type CitationFinding,
  type GateEvaluation,
  type GateScope,
  type GateStatus,
  type TemporalCheck,
  type TemporalFinding,
} from "./types"

async function checkCitations(text: string, store: AuthorityStore): Promise<CitationFinding[]> {
  const findings: CitationFinding[] = []
  const seen = new Set<string>()
  for (const raw of extractCitations(text)) {
    const ref = raw.trim()
    if (!ref) continue
    if (isUnrecognisedRef(ref)) {
      // A suspected authority the extractor could not read exactly: never looked up, never resolvable (E-22).
      if (seen.has(`r:${ref}`)) continue
      seen.add(`r:${ref}`)
      findings.push({ ref, judgmentId: null, status: "UNVERIFIED" })
      continue
    }
    // The store is asked for the canonical form only. A ref that does not normalise cannot be resolved.
    const canonical = normaliseCitation(ref)
    const displayRef = canonical ?? ref
    const found = canonical ? await store.findJudgment(canonical) : null
    const key = found ? `j:${found.judgmentId}` : `r:${displayRef}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({
      ref: displayRef,
      judgmentId: found?.judgmentId ?? null,
      status: found ? verdictFromTreatments(found.benchType, await store.listTreatments(found.judgmentId)) : "UNVERIFIED",
    })
  }
  return findings
}

async function checkTemporal(check: TemporalCheck, store: AuthorityStore): Promise<TemporalFinding> {
  const inForce = await store.getSectionAsAt(check.sectionId, check.asAtDate, check.jurisdiction)
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

/** One gate run: the findings, the overall status and the assessed scope (F06). */
export async function runGate(
  input: { title: string; body: string; temporalChecks: readonly TemporalCheck[] },
  store: AuthorityStore
): Promise<GateEvaluation> {
  const citations = await checkCitations(`${input.title}\n${input.body}`, store)
  const temporal: TemporalFinding[] = []
  for (const check of input.temporalChecks) temporal.push(await checkTemporal(check, store))
  return { status: overall(citations, temporal), citations, temporal, scope: scopeOf(citations, temporal) }
}
