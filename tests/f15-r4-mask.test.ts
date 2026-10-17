import { describe, expect, it } from "vitest"
import * as mask from "@/platform/p1/maskOutboundPII"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { residualPII } from "@/platform/p1/residualPII"

/**
 * Audit F15, re-audit round 3 (FAIL 8/10): the mask. Spec rulings R4-1 (main's patterns on the raw text too, so the
 * mask never masks less than main, Unicode glue included) and R4-5 (pins for the surviving mutants T03 and T05). The
 * differential generator is the re-auditor's (zz-r3-diff.test.ts), adopted as ruled. Every name is invented; every
 * number is synthetic.
 */

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: main's mask (origin/main 0844ed8, platform/p1/maskOutboundPII.ts), verbatim. Its email regex backtracks
// quadratically, so it only ever runs here, on short generated inputs.
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

const TOKEN_RE = /\[(?:CNIC|PHONE|PARTY|EMAIL|IBAN|NTN|PASSPORT)\]/g

/**
 * The code units of `s` that `m` replaced, or null when `m` is not `s` with spans replaced by tokens (greedy
 * alignment, the re-auditor's).
 */
function replaced(s: string, m: string): Set<number> | null {
  const segs = m.split(TOKEN_RE)
  const out = new Set<number>()
  if (segs.length === 1) return m === s ? out : null
  if (!s.startsWith(segs[0]!)) return null
  let at = segs[0]!.length
  const last = segs[segs.length - 1]!
  const lastAt = s.length - last.length
  if (!s.endsWith(last)) return null
  for (let i = 1; i < segs.length - 1; i++) {
    const found = s.indexOf(segs[i]!, at + 1)
    if (found < 0 || found >= lastAt) return null
    for (let k = at; k < found; k++) out.add(k)
    at = found + segs[i]!.length
  }
  if (lastAt < at + 1) return null
  for (let k = at; k < lastAt; k++) out.add(k)
  return out
}

type Spans = ReadonlyArray<{ start: number; end: number; kind: string }>
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
 * same length (a blank is, like main's token brackets, no word character and no separator). Each input checks that
 * these spans written as tokens give main's own output, so the emulation is main.
 */
function mainSpans(s: string, partyNames: string[]): Spans {
  const spans: Array<{ start: number; end: number; kind: string }> = []
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
  return spans
}

const unitsOf = (spans: Spans) => new Set(spans.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, k) => start + k)))

/**
 * The units main replaced that the mask kept. Exact when the mask exports its spans (`outboundPIISpans`): both span
 * sets are checked against the outputs they produce. On a mask without that export (round 3's head), the re-auditor's
 * greedy alignment of the outputs is the measure; it can attribute a unit to the wrong token when a literal segment
 * also occurs inside a replaced region, so it is used only there.
 */
function lostUnits(s: string, partyNames: string[] = []): string | null {
  const spansOf = (mask as Record<string, unknown>).outboundPIISpans as ((t: string, o: { partyNames: string[] }) => Spans) | undefined
  if (spansOf === undefined) {
    const a = replaced(s, maskMain(s, partyNames))
    const b = replaced(s, maskOutboundPII(s, { partyNames }).masked)
    if (a === null || b === null) return null
    return [...a].filter((p) => !b.has(p)).map((p) => s[p]).join("")
  }
  const main = mainSpans(s, partyNames)
  const ours = spansOf(s, { partyNames })
  if (render(s, main) !== maskMain(s, partyNames)) return null
  if (render(s, ours) !== maskOutboundPII(s, { partyNames }).masked) return null
  const kept = unitsOf(ours)
  return [...unitsOf(main)].filter((p) => !kept.has(p)).sort((x, y) => x - y).map((p) => s[p]).join("")
}

const SEVEN_DIGITS = /\p{Nd}(?:[^\p{L}\p{Nd}]{0,3}\p{Nd}){6}/u

describe("R4-1: Unicode glue no longer hides what main masked (the re-auditor's glue rows)", () => {
  it.each([
    ["a CNIC glued to its label by a zero-width space", "CNIC\u200B3520212345671 on file"],
    ["an IBAN glued to a word by a zero-width space", "Ref\u200BPK36SCBL0000001123456702 on file"],
    ["a passport label after a full-width letter", "\uFF41ppt AB1234567 on file"],
    ["a bracketed 3xx phone before a ligature", "(371) 6656495\uFB01le"],
    ["an email glued to a CNIC by VS16", "a.b@qalvo.Org\uFE0F3520212345671 on file"],
    ["an NTN after a decomposed accent", "Caf\u00E9\u0301NTN: 1234567-8"],
    ["a mobile after a combining mark", "e\u03010300-1234567 today"],
    ["a CNIC after a private-use character", "\uE0003520212345671 on file"],
    ["an email after a full-width letter", "\uFF41K9@x9.Org today"],
  ])("%s: every unit main replaced is replaced, and no seven-digit run is left", (_label, text) => {
    expect(lostUnits(text)).toBe("")
    expect(SEVEN_DIGITS.test(maskOutboundPII(text).masked)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The re-auditor's differential generator (zz-r3-diff.test.ts), adopted as ruled (R4-1): identifier units in every
// format main accepts, glued to words, digits and Unicode characters (format characters, marks, private use,
// default-ignorables, NBSP, Urdu and full-width letters, NFKC expanders), 4 seeds x 6,000 inputs.
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

function identifier(r: () => number): string {
  switch (Math.floor(r() * 9)) {
    case 0: return `${digits(r, 5)}${sepRun(r, ".- \n\t\u00A0", 8)}${digits(r, 7)}${sepRun(r, ".- \n\t\u00A0", 8)}${digits(r, 1)}`
    case 1: return digits(r, 13)
    case 2: return `${pick(r, ["+92", "92", "0"])}${pick(r, ["", " ", ".", "-"])}3${digits(r, 2)}${pick(r, ["", " ", ".", "-"])}${digits(r, 7)}`
    case 3: return `(${pick(r, ["0", ""])}3${digits(r, 2)})${pick(r, ["", " ", ".", "-"])}${digits(r, 7)}`
    case 4: return `${pick(r, ["nura", "a.b", "x_y", "K9", "-q", "%z"])}@${pick(r, ["qalvo", "a-b", "x9"])}.${pick(r, ["pk", "com", "Org"])}`
    case 5: return `PK${sepRun(r, " \t\n", 3).slice(r() < 0.5 ? 0 : 9)}${digits(r, 2)}${pick(r, ["", " ", "  "])}SCBL${[0, 1, 2, 3].map(() => pick(r, ["", " ", "    "]) + digits(r, 4)).join("")}`
    case 6: return `${pick(r, ["NTN", "ntn", "Ntn"])}${pick(r, ["", ":", " ", ": ", " - ", ":\t\t", "-    "])}${digits(r, 7)}-${digits(r, 1)}`
    case 7: return `${pick(r, ["passport", "Passport", "ppt", "ppt."])}${pick(r, ["", ":", " ", " - ", ":   "])}${pick(r, ["AB", "ab", "Xy"])}${digits(r, 7)}`
    default: return "Tariq Zarvani"
  }
}
const GLUE = ["", "", "", " ", "x", "_", "7", "\u200B", "\u0301", "\uE000", "\u034F", "\uFE0F", "\u00A0", "ط", "\uFF41", "\uFB01", "\u2066", "\u00E9", "e\u0301", ".", "-", "(", ")", "+", "@", "\n"]
const FILL = ["the", "No.", "dated", "Rs.", "|", "Mobile:", "CNIC", "موبائل", "NTN", "2021", "x", "Qalvo", "##", "۳۵"]

describe("R4-1: the re-auditor's differential, 4 seeds x 6,000 inputs: the mask never masks less than main", () => {
  it.each([[1017], [2026], [4242], [99991]])(
    "seed %i",
    (seed) => {
      const r = rng(seed)
      const misses: Array<{ s: string; main: string; mask: string; lost: string | null }> = []
      for (let n = 0; n < 6000; n++) {
        const parts: string[] = []
        const k = 1 + Math.floor(r() * 4)
        for (let i = 0; i < k; i++) {
          if (r() < 0.4) parts.push(pick(r, FILL))
          parts.push(pick(r, GLUE) + identifier(r) + pick(r, GLUE))
        }
        const s = parts.join(pick(r, [" ", "", "\n", "  "]))
        const names = r() < 0.3 ? ["Tariq Zarvani"] : []
        const lost = lostUnits(s, names)
        if (lost !== "") misses.push({ s, main: maskMain(s, names), mask: maskOutboundPII(s, { partyNames: names }).masked, lost })
      }
      expect(misses.slice(0, 5)).toEqual([])
    },
    120_000
  )
})

describe("R4-5: pins for the re-auditor's surviving mutants", () => {
  it.each([
    ["T03: an IBAN with dash-and-space runs", "IBAN PK36 - - SCBL - - 0000 - - 0011 - - 2345 - - 6702 on file", "IBAN [IBAN] on file"],
    ["T03: an IBAN with uneven dash-and-space runs", "IBAN PK36 -  SCBL -  0000 - 0011  -  2345 -   6702 on file", "IBAN [IBAN] on file"],
    ["T05: an NTN No. with six spaces", "NTN No.      1234567-8 on file", "[NTN] on file"],
    ["T05: N.T.N # with six spaces", "N.T.N #      1234567-8 on file", "[NTN] on file"],
    ["T05: a passport no. with six spaces", "passport no.      ab1234567 on file", "[PASSPORT] on file"],
  ])("%s", (_label, text, expected) => {
    const masked = maskOutboundPII(text).masked
    expect(masked).toBe(expected)
    expect(residualPII(masked)).toEqual({ id_digits: 0, labelled_identifier: 0, address: 0, kinship_name: 0 })
  })
})
