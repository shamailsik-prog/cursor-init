import { describe, expect, it } from "vitest"
import {
  nameForms,
  normaliseCnic,
  normaliseNtn,
  normalisePhone,
  normaliseSecp
} from "../src/d1/conflict/normalise"

describe("normaliseCnic", () => {
  it("strips dashes and spaces", () => {
    expect(normaliseCnic("42101-1234567-1")).toBe("4210112345671")
    expect(normaliseCnic("4210112345671 ")).toBe("4210112345671")
    expect(normaliseCnic(" 42101 1234567 1")).toBe("4210112345671")
  })
  it("rejects anything that is not exactly 13 digits", () => {
    expect(normaliseCnic("421011234567")).toBeNull()
    expect(normaliseCnic("42101123456712")).toBeNull()
    expect(normaliseCnic("42101-123456a-1")).toBeNull()
    expect(normaliseCnic("")).toBeNull()
  })
})

describe("normalisePhone", () => {
  it("returns E.164 for 03xx, 92 and +92 forms", () => {
    expect(normalisePhone("0300-1234567")).toBe("+923001234567")
    expect(normalisePhone("+92 300 1234567")).toBe("+923001234567")
    expect(normalisePhone("923001234567")).toBe("+923001234567")
    expect(normalisePhone("(0300) 123 4567")).toBe("+923001234567")
  })
  it("rejects everything else", () => {
    expect(normalisePhone("12345")).toBeNull()
    expect(normalisePhone("")).toBeNull()
    expect(normalisePhone("+1 202 555 0100")).toBeNull()
    expect(normalisePhone("0300-12345678")).toBeNull()
    expect(normalisePhone("0300-12345ab")).toBeNull()
  })
})

describe("normaliseNtn / normaliseSecp", () => {
  it("uppercases and strips spaces and dashes", () => {
    expect(normaliseNtn("1234567-8")).toBe("12345678")
    expect(normaliseNtn(" ab 12-34 ")).toBe("AB1234")
    expect(normaliseSecp("0012 345-a")).toBe("0012345A")
  })
  it("returns null when empty", () => {
    expect(normaliseNtn(" - ")).toBeNull()
    expect(normaliseSecp("")).toBeNull()
  })
})

describe("nameForms", () => {
  it("drops honorifics when other tokens remain", () => {
    expect(nameForms("Mr. Muhammad Ali")).toContainEqual(["muhammad", "ali"])
    expect(nameForms("Dr Syed Ahmad Khan")).toContainEqual(["ahmed", "khan"])
  })
  it("keeps a name that is only an honorific", () => {
    expect(nameForms("Syed")).toContainEqual(["syed"])
  })
  it("canonicalises variants to the first spelling of the group", () => {
    expect(nameForms("Mohd. Hussein Shaikh")).toContainEqual(["muhammad", "hussain", "shaikh"])
    expect(nameForms("M Aly Sheikh")).toContainEqual(["muhammad", "ali", "shaikh"])
    expect(nameForms("Ahmad Husain")).toContainEqual(["ahmed", "hussain"])
  })
  it("transliterates Urdu and Sindhi script through the seed table", () => {
    expect(nameForms("محمد علی")).toContainEqual(["muhammad", "ali"])
    expect(nameForms("محمد علي")).toContainEqual(["muhammad", "ali"])
    expect(nameForms("احمد حسین شیخ")).toContainEqual(["ahmed", "hussain", "shaikh"])
    expect(nameForms("بھٹو")).toContainEqual(["bhutto"])
    expect(nameForms("ذوالفقار علی بھٹو").at(0)?.at(-1)).toBe("bhutto")
    for (const [word, roman] of [
      ["خان", "khan"],
      ["میمن", "memon"],
      ["سومرو", "soomro"],
      ["بلوچ", "baloch"],
      ["جوکھیو", "jokhio"]
    ]) {
      expect(nameForms(word)).toContainEqual([roman])
    }
  })
  it("is insensitive to Arabic/Urdu code point variants and diacritics", () => {
    // Arabic kaf + Arabic yeh + heh-doachashmee variants, plus a fatha
    expect(nameForms("شَيخ")).toContainEqual(["shaikh"])
    expect(nameForms("بهٹو")).toContainEqual(["bhutto"])
    expect(nameForms("بھٹو")).toEqual(nameForms("بہٹو"))
  })
  it("falls back to per-character transliteration for unmapped words", () => {
    const forms = nameForms("بابر")
    expect(forms).toHaveLength(1)
    expect(forms[0]).toHaveLength(1)
    expect(forms[0][0]).toMatch(/^[a-z]+$/)
  })
  it("lets the firm map override the fallback and add alternatives", () => {
    const firm = new Map<string, string[]>([["بابر", ["babar"]]])
    expect(nameForms("بابر", firm)).toContainEqual(["babar"])
    const multi = new Map<string, string[]>([["بابر", ["babar", "babur"]]])
    const forms = nameForms("بابر خان", multi)
    expect(forms).toContainEqual(["babar", "khan"])
    expect(forms).toContainEqual(["babur", "khan"])
  })
  it("treats punctuation and case as separators", () => {
    expect(nameForms("MUHAMMAD-ALI, Soomro")).toContainEqual(["muhammad", "ali", "soomro"])
  })
  it("returns no forms for an empty name", () => {
    expect(nameForms("  ")).toEqual([])
  })
})
