import { describe, expect, it } from "vitest"
import { detectionView, foldName, nameView, type TextView } from "@/platform/p1/piiText"

/**
 * Audit F15, spec ruling 1 and ruling 3: the detection view and its index map, and the folded name view.
 * docs/superpowers/specs/2026-10-16-f15-pii-mask-normalisation-design.md
 */

/** The original span of each unit of a view, as [start, end) pairs. */
const spans = (v: TextView): Array<[number, number]> => v.start.map((s, i) => [s, v.end[i]!])
const range = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i)).join("")

describe("detectionView (ruling 1)", () => {
  it("maps ASCII text to itself, unit for unit", () => {
    const v = detectionView("CNIC 35202-1")
    expect(v.text).toBe("CNIC 35202-1")
    expect(spans(v)).toEqual(Array.from({ length: 12 }, (_, i) => [i, i + 1]))
  })

  it("keeps tabs and line breaks", () => {
    expect(detectionView("a\tb\nc\r\n").text).toBe("a\tb\nc\r\n")
  })

  it.each([
    ["full-width", 0xff10],
    ["Arabic-Indic", 0x0660],
    ["Extended Arabic-Indic (Urdu, Persian)", 0x06f0],
    ["Devanagari", 0x0966],
    ["Bengali", 0x09e6],
    ["Gurmukhi", 0x0a66],
    ["Adlam", 0x1e950],
  ])("maps every %s digit to its ASCII digit", (_label, zero) => {
    expect(detectionView(range(zero, zero + 9)).text).toBe("0123456789")
  })

  it("maps mathematical digits (one unit per surrogate pair) and keeps each digit's original span", () => {
    // U+1D7CE MATHEMATICAL BOLD DIGIT ZERO .. U+1D7FF: five contiguous runs of ten.
    const v = detectionView("\u{1D7CE}\u{1D7D7}\u{1D7FF}")
    expect(v.text).toBe("099")
    expect(spans(v)).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ])
  })

  it("maps dash variants to a hyphen-minus", () => {
    expect(detectionView("‐‑‒–—―−﹘﹣－⸺").text).toBe("-".repeat(11))
  })

  it("maps space separators to a space", () => {
    expect(detectionView("     　 ").text).toBe(" ".repeat(7))
  })

  it("drops invisible format characters and maps around them", () => {
    const raw = "3​5‌2‍0‎2‏1­2﻿3؜4⁦5‮6⁩"
    const v = detectionView(raw)
    expect(v.text).toBe("35202123456")
    // Each digit keeps its own position in the original; the dropped characters have no unit.
    expect(v.start).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
    expect(v.end).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21])
  })

  it("gives every unit of an NFKC expansion the span of the code point it came from", () => {
    const v = detectionView("⑴x₨5")
    // U+2474 PARENTHESIZED DIGIT ONE is "(1)"; U+20A8 RUPEE SIGN is "Rs".
    expect(v.text).toBe("(1)xRs5")
    expect(spans(v)).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
      [1, 2],
      [2, 3],
      [2, 3],
      [3, 4],
    ])
  })

  it("maps the audit's counterexample to ASCII", () => {
    expect(detectionView("３５２０２－１２３４５６７－１ ۰۳۰۰-۱۲۳۴۵۶۷").text).toBe("35202-1234567-1 0300-1234567")
  })

  it("leaves letters in other scripts as they are", () => {
    expect(detectionView("طارق زروانی").text).toBe("طارق زروانی")
  })
})

describe("nameView and foldName (ruling 3)", () => {
  it("folds case, Latin diacritics and whitespace runs", () => {
    expect(foldName("  Ṭāriq   ZARVĀNI ")).toBe("tariq zarvani")
    expect(foldName("İlyas")).toBe("ilyas")
  })

  it("folds Arabic letter variants, harakat, hamza and madda carriers, and tatweel", () => {
    const urdu = foldName("طارق زروانی")
    expect(foldName("طارق زرواني")).toBe(urdu) // Arabic yeh
    expect(foldName("طارق زروانى")).toBe(urdu) // alef maksura
    expect(foldName("طَارِق زَرْوَانی")).toBe(urdu) // harakat
    expect(foldName("طـارق زروانی")).toBe(urdu) // tatweel
    expect(foldName("نورة كلباني")).toBe(foldName("نورہ کلبانی")) // teh marbuta, Arabic kaf, Arabic yeh
    expect(foldName("نوره")).toBe(foldName("نورہ")) // Arabic heh
    expect(foldName("نورۃ")).toBe(foldName("نورہ")) // teh marbuta goal
    expect(foldName("آ")).toBe("ا")
    expect(foldName("أ")).toBe("ا")
    expect(foldName("إ")).toBe("ا")
    expect(foldName("ئ")).toBe("ی")
    expect(foldName("ٰا")).toBe("ا") // superscript alef
  })

  it("does not fold letters that are different letters in Urdu", () => {
    expect(foldName("ھ")).not.toBe(foldName("ہ")) // do-chashmi he
    expect(foldName("ے")).not.toBe(foldName("ی")) // yeh barree
  })

  it("a name of marks and invisible characters folds to nothing", () => {
    expect(foldName("ً​ ")).toBe("")
  })

  it("maps each name-view unit back to the original span", () => {
    const original = "Ä​b́C"
    const v = nameView(detectionView(original))
    expect(v.text).toBe("abc")
    expect(spans(v)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ])
  })
})
