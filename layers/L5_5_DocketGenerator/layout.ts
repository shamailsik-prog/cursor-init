import { PageSizes, type PDFFont } from "pdf-lib"
import type { ResolvedDocket } from "@/layers/L5_5_DocketGenerator/ambiguity"
import type { DocketIndexEntry, DocketPageSizeName } from "@/layers/L5_5_DocketGenerator/types"

export const MARGIN_PT = 72
export const HEADER_PT = 36
export const FOOTER_PT = 36
export const BODY_PT = 12
export const HEADING_PT = 14

export type PlanLine = {
  text: string
  size: typeof BODY_PT | typeof HEADING_PT
  bold: boolean
  align: "left" | "center" | "right"
}

export type PlanPage = {
  physicalPage: number
  printedPage: number | null
  role: "draft" | "index" | "annexure" | "blank"
  lines: PlanLine[]
}

export type DocketPlan = {
  pages: PlanPage[]
  index: DocketIndexEntry[]
  pageCount: number
  pageSize: { width: number; height: number }
}

export type ContentBox = { left: number; width: number; top: number; bottom: number }

export function pagePoints(name: DocketPageSizeName): { width: number; height: number } {
  const pair = name === "legal" ? PageSizes.Legal : PageSizes.A4
  return { width: pair[0], height: pair[1] }
}

export function contentBox(page: { width: number; height: number }): ContentBox {
  return {
    left: MARGIN_PT,
    width: page.width - MARGIN_PT * 2,
    top: page.height - MARGIN_PT - HEADER_PT,
    bottom: MARGIN_PT + FOOTER_PT,
  }
}

export function lineBaselines(lines: readonly { size: number }[], box: ContentBox): number[] {
  const baselines: number[] = []
  let baseline = 0
  let previousSize = 0
  for (let index = 0; index < lines.length; index++) {
    const size = lines[index]?.size ?? BODY_PT
    baseline = index === 0 ? box.top - size : baseline - previousSize * 1.5
    baselines.push(baseline)
    previousSize = size
  }
  return baselines
}

function overflows(lines: readonly { size: number }[], box: ContentBox): boolean {
  return lineBaselines(lines, box).some((baseline) => baseline < box.bottom)
}

function pageNumberLine(): PlanLine {
  return { text: "", size: BODY_PT, bold: false, align: "right" }
}

function wrapParagraph(paragraph: string, font: PDFFont, size: number, width: number): string[] {
  const words = paragraph.split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return [""]
  const lines: string[] = []
  let current = ""
  const pushLong = (word: string) => {
    let piece = ""
    for (const character of word) {
      const next = piece + character
      if (piece && font.widthOfTextAtSize(next, size) > width) {
        lines.push(piece)
        piece = character
      } else {
        piece = next
      }
    }
    current = piece
  }
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    if (font.widthOfTextAtSize(word, size) > width) pushLong(word)
    else current = word
  }
  if (current) lines.push(current)
  return lines
}

function justify(text: string, font: PDFFont, size: number, width: number): string {
  const words = text.split(" ")
  if (words.length < 2) return text
  const extras = new Array<number>(words.length - 1).fill(0)
  const join = () => {
    let out = words[0] ?? ""
    for (let index = 0; index < extras.length; index++) {
      out += " ".repeat(1 + (extras[index] ?? 0)) + (words[index + 1] ?? "")
    }
    return out
  }
  for (let guard = 0; guard < 4000; guard++) {
    let slot = 0
    for (let index = 1; index < extras.length; index++) {
      if ((extras[index] ?? 0) < (extras[slot] ?? 0)) slot = index
    }
    extras[slot] = (extras[slot] ?? 0) + 1
    if (font.widthOfTextAtSize(join(), size) > width) {
      extras[slot] = (extras[slot] ?? 1) - 1
      return join()
    }
  }
  return join()
}

function textLines(
  text: string,
  font: PDFFont,
  size: typeof BODY_PT | typeof HEADING_PT,
  width: number,
  bold: boolean,
  align: PlanLine["align"],
): PlanLine[] {
  const lines: PlanLine[] = []
  for (const paragraph of text.split("\n")) {
    const wrapped = wrapParagraph(paragraph, font, size, width)
    wrapped.forEach((line, index) => {
      const last = index === wrapped.length - 1
      const canJustify = align === "left" && !last && line.includes(" ")
      lines.push({
        text: canJustify ? justify(line, font, size, width) : line,
        size,
        bold,
        align: align === "left" ? "left" : align,
      })
    })
  }
  return lines
}

function splitContent(content: readonly PlanLine[], box: ContentBox): PlanLine[][] {
  const pages: PlanLine[][] = []
  let current: PlanLine[] = [pageNumberLine()]
  for (const line of content) {
    const trial = [...current, line]
    if (overflows(trial, box) && current.length > 1) {
      pages.push(current)
      current = [pageNumberLine(), line]
      continue
    }
    current = trial
  }
  pages.push(current)
  return pages
}

function startPages(draftCount: number, indexCount: number, annexureCounts: readonly number[], odd: boolean): number[] {
  let slot = draftCount + indexCount
  return annexureCounts.map((count) => {
    const physical = odd ? slot * 2 + 1 : slot + 1
    slot += count
    return physical
  })
}

function stampPageNumbers(
  groups: readonly { role: PlanPage["role"]; pages: PlanLine[][] }[],
  odd: boolean,
): PlanPage[] {
  const content = groups.flatMap((group) => group.pages.map((lines) => ({ role: group.role, lines })))
  const pages: PlanPage[] = []
  content.forEach((part, slot) => {
    const physical = odd ? slot * 2 + 1 : slot + 1
    const lines = part.lines.map((line, index) => (index === 0 ? { ...line, text: String(physical) } : line))
    pages.push({ physicalPage: physical, printedPage: physical, role: part.role, lines })
    if (odd) pages.push({ physicalPage: physical + 1, printedPage: null, role: "blank", lines: [] })
  })
  return pages
}

export function planDocket(
  docket: ResolvedDocket,
  fonts: { regular: PDFFont; bold: PDFFont },
): DocketPlan | { error: string } {
  const pageSize = pagePoints(docket.pageSize)
  const box = contentBox(pageSize)
  const odd = docket.pagination === "odd"
  const draftPages = splitContent(textLines(docket.draftBody, fonts.regular, BODY_PT, box.width, false, "left"), box)
  const annexurePages = docket.annexures.map((annexure) =>
    splitContent(
      [
        ...textLines(annexure.heading, fonts.bold, HEADING_PT, box.width, true, "center"),
        ...textLines(annexure.description, fonts.regular, BODY_PT, box.width, false, "left"),
        ...textLines(annexure.body, fonts.regular, BODY_PT, box.width, false, "left"),
      ],
      box,
    ),
  )

  let indexPageCount = 1
  let indexPages: PlanLine[][] = []
  let starts: number[] = []
  let settled = false
  for (let attempt = 0; attempt < 12; attempt++) {
    starts = startPages(
      draftPages.length,
      indexPageCount,
      annexurePages.map((pages) => pages.length),
      odd,
    )
    const rows = docket.annexures.map(
      (annexure, index) => `${annexure.indexLabel} | ${annexure.description} | ${starts[index] ?? ""}`,
    )
    const indexLines = [
      ...textLines("INDEX OF ANNEXURES", fonts.bold, HEADING_PT, box.width, true, "center"),
      ...rows.flatMap((row) => textLines(row, fonts.regular, BODY_PT, box.width, false, "left")),
    ]
    indexPages = splitContent(indexLines, box)
    if (indexPages.length === indexPageCount) {
      settled = true
      break
    }
    indexPageCount = indexPages.length
  }
  if (!settled) return { error: "index page references did not settle" }

  const pages = stampPageNumbers(
    [
      { role: "draft", pages: draftPages },
      { role: "index", pages: indexPages },
      ...annexurePages.map((pages) => ({ role: "annexure" as const, pages })),
    ],
    odd,
  )
  const index: DocketIndexEntry[] = docket.annexures.map((annexure, index) => ({
    label: annexure.indexLabel,
    description: annexure.description,
    physicalPage: starts[index] ?? 0,
    printedPage: starts[index] ?? 0,
  }))
  return { pages, index, pageCount: pages.length, pageSize }
}
