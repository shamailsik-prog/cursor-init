import type { Classification } from "@/platform/p1/types"
import { isKnownClassification, rankOf } from "../p5/classification"

/**
 * Aggregate classification for one OCR call (erratum E-20, L17.3): the maximum rank among the
 * job, the document and, when the document is on a matter, that matter. Empty input is a caller
 * bug. An unknown label is refused rather than treated as public.
 */
export function aggregateClassification(labels: readonly Classification[]): Classification {
  if (labels.length === 0) throw new Error("aggregate classification: empty")
  let best: Classification | undefined
  for (const label of labels) {
    if (!isKnownClassification(label)) throw new Error("aggregate classification: unknown")
    if (best === undefined || rankOf(label) > rankOf(best)) best = label
  }
  if (best === undefined) throw new Error("aggregate classification: empty")
  return best
}
