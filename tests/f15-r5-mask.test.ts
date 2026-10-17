import { describe, expect, it } from "vitest"
import * as mask from "@/platform/p1/maskOutboundPII"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"

/**
 * Audit F15, re-audit round 4 (FAIL 7/10): the mask. Spec ruling R5-1: three or more emails joined by ".", "-" or "_"
 * made stage 0 (and stages 1 and 2) resume after the first email instead of after the chain, so overlapping matches were
 * chained again after every "@". Stage 0 then blanked overlapping spans, its working text grew longer than the input,
 * and later patterns reported shifted positions: NTN and passport digits leaked, a stray token was written past the end,
 * a recorded name was dropped, and the scan was quadratic in time and memory. The drift rows are the re-auditor's
 * (r4-drift, r4-drift2, r4-oom2); the differential generator is round 4's, taught to join 3 to 8 emails. Every name is
 * invented; every number is synthetic.
 */

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: main's mask (origin/main 0844ed8, platform/p1/maskOutboundPII.ts), verbatim. Its email regex backtracks
// quadratically, so it only ever runs here, on short inputs.
// ---------------------------------------------------------------------------------------------------------------------

const MAIN_CNIC_SEPARATED = /\b\d{5}[.\-\s]+\d{7}[.\-\s]+\d\b/g
const MAIN_CNIC_PLAIN = /\b\d{13}\b/g
const MAIN_PK_MOBILE = /(?:\+92|92|0)[.\s-]?3\d{2}[.\s-]?\d{7}\b/g
const MAIN_PK_MOBILE_PAREN = /\(0?3\d{2}\)[.\s-]?\d{7}\b/g
const MAIN_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const MAIN_PK_IBAN = /\bPK\s*\d{2}\s*[A-Z]{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\b/gi
const MAIN_NTN = /\bNTN[:\s-]*\d{7}-\d\b/gi
const MAIN_PASSPORT = /\b(?:passport|ppt\.?)[:\s-]*[A-Z]{2}\d{7}\b/gi
const mainEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function maskMain(text: string, partyNames: string[] = []): string {
  let masked = text
  masked = masked.replace(MAIN_CNIC_SEPARATED, "[CNIC]")
  masked = masked.replace(MAIN_CNIC_PLAIN, "[CNIC]")
  masked = masked.replace(MAIN_PK_MOBILE_PAREN, "[PHONE]")
  masked = masked.replace(MAIN_PK_MOBILE, "[PHONE]")
  masked = masked.replace(MAIN_EMAIL, "[EMAIL]")
  masked = masked.replace(MAIN_PK_IBAN, "[IBAN]")
  masked = masked.replace(MAIN_NTN, "[NTN]")
  masked = masked.replace(MAIN_PASSPORT, "[PASSPORT]")
  for (const name of partyNames) {
    const trimmed = name.trim()
    if (!trimmed) continue
    masked = masked.replace(new RegExp(mainEscape(trimmed), "gi"), "[PARTY]")
  }
  return masked
}

type Span = { start: number; end: number; kind: string }
type Spans = ReadonlyArray<Span>
const TOKEN: Readonly<Record<string, string>> = {
  cnic: "[CNIC]", phone: "[PHONE]", party: "[PARTY]", email: "[EMAIL]", iban: "[IBAN]", ntn: "[NTN]", passport: "[PASSPORT]",
}
const render = (s: string, spans: Spans) => {
  let out = ""
  let at = 0
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += s.slice(at, span.start) + TOKEN[span.kind]
    at = span.end
  }
  return out + s.slice(at)
}

/**
 * Main's replaced spans, exactly: main's regexes in main's order over the text with each earlier match blanked to the
 * same length. `render(s, mainSpansOf(s))` is checked against main's own output for every input.
 */
function mainSpansOf(s: string, partyNames: string[]): Span[] {
  const spans: Span[] = []
  let work = s
  const run = (re: RegExp, kind: string) => {
    let out = ""
    let at = 0
    for (const m of work.matchAll(re)) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind })
      out += work.slice(at, m.index) + "\uE000".repeat(m[0].length)
      at = m.index + m[0].length
    }
    work = out + work.slice(at)
  }
  run(MAIN_CNIC_SEPARATED, "cnic")
  run(MAIN_CNIC_PLAIN, "cnic")
  run(MAIN_PK_MOBILE_PAREN, "phone")
  run(MAIN_PK_MOBILE, "phone")
  run(MAIN_EMAIL, "email")
  run(MAIN_PK_IBAN, "iban")
  run(MAIN_NTN, "ntn")
  run(MAIN_PASSPORT, "passport")
  for (const name of partyNames) if (name.trim() !== "") run(new RegExp(mainEscape(name.trim()), "gi"), "party")
  return spans.sort((a, b) => a.start - b.start)
}

type SpansOf = (t: string, o: { partyNames: string[] }) => Spans
const outboundSpans = (s: string, partyNames: string[]): Spans => ((mask as Record<string, unknown>).outboundPIISpans as SpansOf)(s, { partyNames })
/** Stage 0 alone (R5-1): main's algorithm on the raw text, exported so its spans can be compared with main's. */
const stageZero = (s: string, partyNames: string[]): Spans => {
  const f = (mask as Record<string, unknown>).mainAlgorithmSpans as ((t: string, names: readonly string[]) => Spans) | undefined
  if (f === undefined) throw new Error("mainAlgorithmSpans is not exported")
  return f(s, partyNames)
}

/** Sorted, disjoint, non-empty and inside the text: blanking never moved a position (R5-1). */
function wellFormed(s: string, spans: Spans): boolean {
  let at = 0
  for (const span of spans) {
    if (span.start < at || span.end <= span.start || span.end > s.length) return false
    at = span.end
  }
  return true
}

const unitsOf = (spans: Spans) => new Set(spans.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, k) => start + k)))

/** The units main replaced that the mask kept, exactly (both span sets checked against the outputs they produce). */
function lostUnits(s: string, partyNames: string[] = []): string | null {
  const main = mainSpansOf(s, partyNames)
  const ours = outboundSpans(s, partyNames)
  if (render(s, main) !== maskMain(s, partyNames)) return null
  if (!wellFormed(s, ours) || render(s, ours) !== maskOutboundPII(s, { partyNames }).masked) return null
  const kept = unitsOf(ours)
  return [...unitsOf(main)].filter((p) => !kept.has(p)).sort((x, y) => x - y).map((p) => s[p]).join("")
}

const SEVEN_DIGITS = /\p{Nd}(?:[^\p{L}\p{Nd}]{0,3}\p{Nd}){6}/u

describe("R5-1: emails joined by '.', '-' or '_' no longer shift the positions of what follows (the re-auditor's drift rows)", () => {
  it.each([
    ["an NTN and a recorded name after three dot-joined emails", "a@b.pk.a@b.pk.a@b.pk then NTN 1234567-8 and Tariq Zarvani end", ["Tariq Zarvani"]],
    ["a passport after six dot-joined emails", "x@y.pk.x@y.pk.x@y.pk.x@y.pk.x@y.pk.x@y.pk passport AB1234567 ok", []],
    ["an NTN glued to an accented letter after three emails", "Emails a@b.pk.a@b.pk.a@b.pk then \u00E9ntn: 1739403-5 and more words follow here.", []],
    ["a bracketed phone before a ligature after three emails", "Emails a@b.pk.a@b.pk.a@b.pk then call (371) 6656495\uFB01le soon, nothing else here at all.", []],
    ["a CNIC before a zero-width space after three emails", "Emails a@b.pk.a@b.pk.a@b.pk then CNIC 3520212345671\u200Bx and some more trailing words here.", []],
    ["four dot-joined emails and a full stop", "a@b.pk.a@b.pk.a@b.pk.a@b.pk.", []],
    ["three named emails joined by dots, then an NTN", "tariq1990@qalvo.pk.nura22@qalvo.pk.haris7@qalvo.pk then NTN 1234567-8 ok", []],
  ])("%s: the mask writes main's output exactly, and stage 0 is main's spans", (_label, text, names) => {
    const masked = maskOutboundPII(text, { partyNames: names }).masked
    expect(masked).toBe(maskMain(text, names))
    expect(SEVEN_DIGITS.test(masked)).toBe(false)
    const zero = stageZero(text, names)
    expect(wellFormed(text, zero)).toBe(true)
    expect(zero).toEqual(mainSpansOf(text, names))
    expect(wellFormed(text, outboundSpans(text, names))).toBe(true)
  })

  it.each([
    ["emails joined by dashes, then an NTN", "tariq1990@qalvo.pk-nura22@qalvo.pk-haris7@qalvo.pk then NTN 1234567-8 ok"],
    ["emails joined by underscores, then a passport", "a@b.pk_a@b.pk_a@b.pk_a@b.pk passport AB1234567 ok"],
    ["a dotted local part joined by dots, then an NTN", "a.b@c.de.a.b@c.de.a.b@c.de.a.b@c.de NTN 1234567-8 ok"],
  ])("%s: nothing main replaced is kept, no address is left, and no seven-digit run", (_label, text) => {
    expect(lostUnits(text)).toBe("")
    const masked = maskOutboundPII(text).masked
    // An address needs a domain after its "@": "_a@[EMAIL]" leaves a local-part fragment, not an address.
    expect(/@[\p{L}\p{N}]/u.test(masked)).toBe(false)
    expect(SEVEN_DIGITS.test(masked)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The differential (R4-1's generator, the re-auditor's), taught to join 3 to 8 emails with ".", "-" or "_" (R5-1).
// ---------------------------------------------------------------------------------------------------------------------

function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const digits = (r: () => number, n: number) => Array.from({ length: n }, () => String(Math.floor(r() * 10))).join("")
const sepRun = (r: () => number, cls: string, max: number) => Array.from({ length: 1 + Math.floor(r() * max) }, () => pick(r, [...cls])).join("")
const email = (r: () => number) => `${pick(r, ["nura", "a.b", "x_y", "K9", "-q", "%z", "a", "tariq1990"])}@${pick(r, ["qalvo", "a-b", "x9", "b"])}.${pick(r, ["pk", "com", "Org", "de"])}`

function identifier(r: () => number): string {
  switch (Math.floor(r() * 10)) {
    case 0: return `${digits(r, 5)}${sepRun(r, ".- \n\t\u00A0", 8)}${digits(r, 7)}${sepRun(r, ".- \n\t\u00A0", 8)}${digits(r, 1)}`
    case 1: return digits(r, 13)
    case 2: return `${pick(r, ["+92", "92", "0"])}${pick(r, ["", " ", ".", "-"])}3${digits(r, 2)}${pick(r, ["", " ", ".", "-"])}${digits(r, 7)}`
    case 3: return `(${pick(r, ["0", ""])}3${digits(r, 2)})${pick(r, ["", " ", ".", "-"])}${digits(r, 7)}`
    case 4: return email(r)
    case 5: return `PK${sepRun(r, " \t\n", 3).slice(r() < 0.5 ? 0 : 9)}${digits(r, 2)}${pick(r, ["", " ", "  "])}SCBL${[0, 1, 2, 3].map(() => pick(r, ["", " ", "    "]) + digits(r, 4)).join("")}`
    case 6: return `${pick(r, ["NTN", "ntn", "Ntn"])}${pick(r, ["", ":", " ", ": ", " - ", ":\t\t", "-    "])}${digits(r, 7)}-${digits(r, 1)}`
    case 7: return `${pick(r, ["passport", "Passport", "ppt", "ppt."])}${pick(r, ["", ":", " ", " - ", ":   "])}${pick(r, ["AB", "ab", "Xy"])}${digits(r, 7)}`
    // R5-1: 3 to 8 emails joined by ".", "-" or "_"
    case 8: {
      const joint = pick(r, [".", "-", "_"])
      return Array.from({ length: 3 + Math.floor(r() * 6) }, () => email(r)).join(joint)
    }
    default: return "Tariq Zarvani"
  }
}
const GLUE = ["", "", "", " ", "x", "_", "7", "\u200B", "\u0301", "\uE000", "\u034F", "\uFE0F", "\u00A0", "ط", "\uFF41", "\uFB01", "\u2066", "\u00E9", "e\u0301", ".", "-", "(", ")", "+", "@", "\n"]
const FILL = ["the", "No.", "dated", "Rs.", "|", "Mobile:", "CNIC", "موبائل", "NTN", "2021", "x", "Qalvo", "##", "۳۵"]

describe("R5-1: the differential with joined emails, 4 seeds x 6,000 inputs: the mask never masks less than main, and stage 0 is main", () => {
  it.each([[1017], [2026], [4242], [99991]])(
    "seed %i",
    (seed) => {
      const r = rng(seed)
      const misses: Array<{ s: string; main: string; mask: string; lost: string | null }> = []
      const inputs: Array<[string, string[]]> = []
      let joined = 0
      for (let n = 0; n < 6000; n++) {
        const parts: string[] = []
        const k = 1 + Math.floor(r() * 4)
        for (let i = 0; i < k; i++) {
          if (r() < 0.4) parts.push(pick(r, FILL))
          parts.push(pick(r, GLUE) + identifier(r) + pick(r, GLUE))
        }
        const s = parts.join(pick(r, [" ", "", "\n", "  "]))
        if ((s.match(/@/g) ?? []).length >= 3) joined += 1
        const names = r() < 0.3 ? ["Tariq Zarvani"] : []
        inputs.push([s, names])
        const lost = lostUnits(s, names)
        if (lost !== "") misses.push({ s, main: maskMain(s, names), mask: maskOutboundPII(s, { partyNames: names }).masked, lost })
      }
      expect(joined).toBeGreaterThan(500)
      expect({ count: misses.length, first: misses.slice(0, 3) }).toEqual({ count: 0, first: [] })
      // Stage 0 alone is main's algorithm: its spans lie in the text and write main's output exactly.
      const stageZeroMisses = inputs.filter(([s, names]) => {
        const zero = stageZero(s, names)
        return !wellFormed(s, zero) || render(s, zero) !== maskMain(s, names)
      })
      expect(stageZeroMisses.slice(0, 5)).toEqual([])
    },
    120_000
  )
})
