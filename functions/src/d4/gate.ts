/**
 * The citation and temporal gate as a pure function of a draft and an authority store (spec P4-6; E-22, E-39).
 * It reports and never edits the body. Persistence, the draft's current version and the audit row belong to the
 * route, not here.
 *
 * Citations come from the one extractor the Next.js gate uses, de-duplicated as verifyCitations does (by judgment
 * id when found, else by canonical ref), and are judged by the one verdict rule (P4-2).
 */
import { extractCitations, isUnrecognisedRef, normaliseCitation } from "@/services/d4-2/citations"
import { verdictFromTreatments } from "@/services/d4-2/citationVerdict"
import type { AuthorityStore } from "./authority"
import { GATE_SEVERITY, type CitationFinding, type GateEvaluation, type GateStatus, type TemporalCheck, type TemporalFinding } from "./types"

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
  if (inForce === "no_history" || !inForce) return { ...check, status: "TEMPORAL_UNAVAILABLE", inForceText: null }
  // Exact after NFC on both sides, so the same text typed in a decomposed form still matches (P4-6).
  const same = inForce.text.normalize("NFC") === check.usedText.normalize("NFC")
  return { ...check, status: same ? "OK" : "TEMPORAL_MISMATCH", inForceText: inForce.text }
}

/** The most severe status across the findings; a VERIFIED citation and an OK check both count as OK. */
function overall(citations: readonly CitationFinding[], temporal: readonly TemporalFinding[]): GateStatus {
  const present = new Set<GateStatus>()
  for (const c of citations) present.add(c.status === "VERIFIED" ? "OK" : c.status)
  for (const t of temporal) present.add(t.status)
  return GATE_SEVERITY.find((s) => present.has(s)) ?? "OK"
}

export async function runGate(
  input: { title: string; body: string; temporalChecks: readonly TemporalCheck[] },
  store: AuthorityStore
): Promise<GateEvaluation> {
  const citations = await checkCitations(`${input.title}\n${input.body}`, store)
  const temporal: TemporalFinding[] = []
  for (const check of input.temporalChecks) temporal.push(await checkTemporal(check, store))
  return { status: overall(citations, temporal), citations, temporal }
}
