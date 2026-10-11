/**
 * The gate's vocabulary (spec P4-6; E-22, E-39): pure types and one frozen table, with no imports, so the gate
 * runs in Cloud Functions and in tests alike.
 */

/** Per-authority status (Module 33: "VERIFIED / UNVERIFIED / OVERRULED"). */
export type CitationStatus = "VERIFIED" | "UNVERIFIED" | "OVERRULED"

/** Per-temporal-check status (P4-6). UNAVAILABLE means "verify manually", never a silent pass (L6900). */
export type TemporalStatus = "OK" | "TEMPORAL_MISMATCH" | "TEMPORAL_UNAVAILABLE"

/** Overall status. Anything but OK blocks approval (E-22). */
export type GateStatus = "OVERRULED" | "TEMPORAL_MISMATCH" | "UNVERIFIED" | "TEMPORAL_UNAVAILABLE" | "OK"

/** One authority the draft cites. `ref` is the canonical citation, or `UNRECOGNISED: ...` for a suspect the extractor could not read. */
export type CitationFinding = { ref: string; judgmentId: string | null; status: CitationStatus }

/** A caller-supplied statute check: the text the draft pleads for a section as at a date (P4-6). */
export type TemporalCheck = { sectionId: string; asAtDate: string; jurisdiction: string; usedText: string }

/** A check with its outcome. `inForceText` is the text the store holds for that date, or null when it holds none. */
export type TemporalFinding = TemporalCheck & { status: TemporalStatus; inForceText: string | null }

export type GateEvaluation = { status: GateStatus; citations: CitationFinding[]; temporal: TemporalFinding[] }

/** Overall statuses, most severe first (P4-6). */
export const GATE_SEVERITY: readonly GateStatus[] = Object.freeze<GateStatus[]>([
  "OVERRULED",
  "TEMPORAL_MISMATCH",
  "UNVERIFIED",
  "TEMPORAL_UNAVAILABLE",
  "OK",
])
