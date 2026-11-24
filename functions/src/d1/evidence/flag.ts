/**
 * Module 4 evidence register (architecture lines 1189–1209).
 *
 * Env-only, same rule as `services/d2-1/grammar.ts`: an unset value is off.
 * There is no registry row. `platform/flags/featureFlags.ts` is not edited.
 */

import { EvidenceError } from "./types"

export const D1_EVIDENCE_FLAG = "D1_EVIDENCE"

export function isD1EvidenceEnabled(): boolean {
  return process.env[`SIKANDER_FLAG_${D1_EVIDENCE_FLAG}`]?.trim().toLowerCase() === "true"
}

export function requireD1Evidence(): void {
  if (!isD1EvidenceEnabled()) throw new EvidenceError("feature_disabled")
}
