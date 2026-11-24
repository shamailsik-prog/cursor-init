import { generateDocket } from "@/layers/L5_5_DocketGenerator/service"
import type { DocketFilingSet, GenerateDocketResult } from "@/layers/L5_5_DocketGenerator/types"

/**
 * Not mounted. Q12a does not register an /api route and does not call
 * ingestion or the drafting factory. Do not mount this helper until a P5
 * decide() guard stands in front of the route, and the flag is on.
 */
export function docketGeneratorRoute(input: DocketFilingSet): Promise<GenerateDocketResult> {
  return generateDocket(input)
}
