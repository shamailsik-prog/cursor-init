import { writeFileSync } from "node:fs"
import { generateDocket } from "@/layers/L5_5_DocketGenerator/service"
import type { DocketFilingSet } from "@/layers/L5_5_DocketGenerator/types"
import petitionFixture from "@/layers/L5_5_DocketGenerator/fixtures/petition-odd.json"

process.env.SIKANDER_FLAG_L5_5_DOCKET_GENERATOR = "true"
const out = process.env.DOCKET_TZ_OUT
if (!out) throw new Error("DOCKET_TZ_OUT is required")
void generateDocket(petitionFixture as DocketFilingSet).then((result) => {
  if (!result.docx) throw new Error("docket probe produced no docx")
  writeFileSync(out, result.docx)
})
