import { generateDocket } from "@/layers/L5_5_DocketGenerator/service"
import type { DocketFilingSet, GenerateDocketResult } from "@/layers/L5_5_DocketGenerator/types"

/**
 * Not mounted. Q12a does not register an /api route and does not call
 * ingestion or the drafting factory. A later slice can mount this helper
 * behind the same flag.
 */
export function docketGeneratorRoute(input: DocketFilingSet): Promise<GenerateDocketResult> {
  return generateDocket(input)
}
