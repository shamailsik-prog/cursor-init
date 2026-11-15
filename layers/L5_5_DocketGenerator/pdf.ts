import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import type { ResolvedDocket } from "@/layers/L5_5_DocketGenerator/ambiguity"
import { contentBox, lineBaselines, planDocket, type DocketPlan, type PlanLine } from "@/layers/L5_5_DocketGenerator/layout"

export const FIXED_DOCKET_TIMESTAMP = "2026-01-01T00:00:00.000Z"

const FIXED_DATE = new Date(FIXED_DOCKET_TIMESTAMP)

function drawLine(
  page: PDFPage,
  line: PlanLine,
  baseline: number,
  boxLeft: number,
  boxWidth: number,
  fonts: { regular: PDFFont; bold: PDFFont },
): void {
  if (!line.text) return
  const font = line.bold ? fonts.bold : fonts.regular
  const width = font.widthOfTextAtSize(line.text, line.size)
  let x = boxLeft
  if (line.align === "center") x = boxLeft + (boxWidth - width) / 2
  if (line.align === "right") x = boxLeft + boxWidth - width
  page.drawText(line.text, { x, y: baseline, size: line.size, font, color: rgb(0, 0, 0) })
}

function drawPlan(pdf: PDFDocument, plan: DocketPlan, fonts: { regular: PDFFont; bold: PDFFont }): void {
  const box = contentBox(plan.pageSize)
  for (const planned of plan.pages) {
    const page = pdf.addPage([plan.pageSize.width, plan.pageSize.height])
    const baselines = lineBaselines(planned.lines, box)
    planned.lines.forEach((line, index) => {
      const baseline = baselines[index]
      if (baseline === undefined) return
      drawLine(page, line, baseline, box.left, box.width, fonts)
    })
  }
}

export async function buildPdf(
  docket: ResolvedDocket,
): Promise<{ bytes: Uint8Array; plan: DocketPlan } | { error: string }> {
  const pdf = await PDFDocument.create()
  pdf.setTitle("Court-format docket")
  pdf.setAuthor("Sikander AI")
  pdf.setSubject("L5.5 annexure docket")
  pdf.setCreator("Sikander AI L5.5")
  pdf.setProducer("Sikander AI L5.5")
  pdf.setCreationDate(FIXED_DATE)
  pdf.setModificationDate(FIXED_DATE)
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.TimesRoman),
    bold: await pdf.embedFont(StandardFonts.TimesRomanBold),
  }
  const plan = planDocket(docket)
  if ("error" in plan) return plan
  drawPlan(pdf, plan, fonts)
  return { bytes: await pdf.save({ useObjectStreams: false }), plan }
}
