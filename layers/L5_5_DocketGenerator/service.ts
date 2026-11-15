import { resolveFilingSet } from "@/layers/L5_5_DocketGenerator/ambiguity"
import { buildDocx } from "@/layers/L5_5_DocketGenerator/docx"
import { DOCKET_GENERATOR_FLAG, isDocketGeneratorEnabled } from "@/layers/L5_5_DocketGenerator/flag"
import { buildPdf } from "@/layers/L5_5_DocketGenerator/pdf"
import type { AmbiguityItem, DocketFilingSet, GenerateDocketResult } from "@/layers/L5_5_DocketGenerator/types"

function refused(enabled: boolean, queue: AmbiguityItem[]): GenerateDocketResult {
  return {
    flag: DOCKET_GENERATOR_FLAG,
    enabled,
    ok: false,
    queue,
    pdf: null,
    docx: null,
    pageCount: null,
    index: null,
  }
}

/**
 * Pure court-format docket generator (L5.5). In-memory filing set only.
 * With the flag off, or when order, label or reference cannot be resolved,
 * it returns no PDF and no DOCX.
 */
export async function generateDocket(input: DocketFilingSet): Promise<GenerateDocketResult> {
  if (!isDocketGeneratorEnabled()) return refused(false, [])
  const resolved = resolveFilingSet(input)
  if (!resolved.ok) return refused(true, resolved.queue)
  try {
    const pdf = await buildPdf(resolved.docket)
    if ("error" in pdf) {
      return refused(true, [{ code: "ref_unresolved", artifactId: null, detail: pdf.error }])
    }
    const docx = await buildDocx(pdf.plan)
    return {
      flag: DOCKET_GENERATOR_FLAG,
      enabled: true,
      ok: true,
      queue: [],
      pdf: pdf.bytes,
      docx,
      pageCount: pdf.plan.pageCount,
      index: pdf.plan.index,
    }
  } catch (_error) {
    return refused(true, [
      {
        code: "label_unresolved",
        artifactId: null,
        detail: "text cannot be encoded for the court docket without substitution",
      },
    ])
  }
}
