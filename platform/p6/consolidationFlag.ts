/**
 * L16.3 path surface. Unset means off, same rule as services/d2-1/grammar.ts.
 * The master writer is not behind this flag: a second write path that appears
 * only when the flag is off would leave two writers in the tree.
 */
export const P6_CONSOLIDATION_FLAG = "P6_CONSOLIDATION"

export function isP6ConsolidationEnabled(): boolean {
  return process.env[`SIKANDER_FLAG_${P6_CONSOLIDATION_FLAG}`]?.trim().toLowerCase() === "true"
}

export function assertP6ConsolidationEnabled(): void {
  if (!isP6ConsolidationEnabled()) throw new Error("p6 consolidation paths are off")
}
