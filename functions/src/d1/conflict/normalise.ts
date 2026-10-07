import { CHAR_TABLE, HONORIFICS, VARIANT_GROUPS, WORD_SEED } from "./translit-seed"

/** Pure key and name normalisers for the conflict engine (L18 §7.2). */

export function normaliseCnic(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "")
  return /^\d{13}$/.test(s) ? s : null
}

/** E.164 for Pakistani mobiles: `03xx…`, `92…` or `+92…`, ten digits after the country code. */
export function normalisePhone(raw: string): string | null {
  const s = raw.replace(/[\s\-().]/g, "")
  const m = /^(?:\+92|92|0)(3\d{9})$/.exec(s)
  return m ? `+92${m[1]}` : null
}

const upperKey = (raw: string): string | null => {
  const s = raw.replace(/[\s-]/g, "").toUpperCase()
  return s === "" ? null : s
}

export const normaliseNtn = (raw: string): string | null => upperKey(raw)
export const normaliseSecp = (raw: string): string | null => upperKey(raw)

/** Folds code point variants and strips diacritics so table lookups are script-variant safe. */
function foldArabic(word: string): string {
  return word
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ‌‍]/g, "")
    .replace(/[يىےۓیۍێې]/g, "ی") // yeh forms -> Urdu yeh
    .replace(/ك/g, "ک") // Arabic kaf -> keheh
    .replace(/[هھہۂۃە]/g, "ہ") // heh forms -> heh goal
    .replace(/[أإٱ]/g, "ا") // hamza/wasla alef -> alef
}

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/

const SEED = new Map<string, string>(Object.entries(WORD_SEED).map(([k, v]) => [foldArabic(k), v]))

const CANON = new Map<string, string>()
for (const group of VARIANT_GROUPS) for (const v of group) CANON.set(v, group[0])

const MAX_FORMS = 32

function romanise(word: string, firmMap?: ReadonlyMap<string, string[]>): string[] {
  const folded = foldArabic(word)
  if (firmMap) {
    for (const [k, v] of firmMap) {
      if ((k === word || foldArabic(k) === folded) && v.length > 0) return v.map((x) => x.toLowerCase())
    }
  }
  const seeded = SEED.get(folded)
  if (seeded) return [seeded]
  let out = ""
  for (const ch of folded) out += CHAR_TABLE[ch] ?? (/[a-z0-9]/i.test(ch) ? ch.toLowerCase() : "")
  return out === "" ? [] : [out]
}

/**
 * Token lists for a party name: lowercase Roman tokens, honorifics dropped (only when other
 * tokens remain), spelling variants rewritten to their group's first spelling. One form per
 * input reading; a firm-map entry with several spellings adds one form per alternative.
 */
export function nameForms(name: string, firmMap?: ReadonlyMap<string, string[]>): string[][] {
  const words = name
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((w) => w !== "")
  let forms: string[][] = [[]]
  for (const word of words) {
    const alts = ARABIC.test(word) ? romanise(word, firmMap) : [word.toLowerCase()]
    if (alts.length === 0) continue
    const next: string[][] = []
    for (const f of forms) {
      for (const a of alts) {
        next.push([...f, CANON.get(a) ?? a])
        if (next.length >= MAX_FORMS) break
      }
    }
    forms = next
  }
  const result: string[][] = []
  const seen = new Set<string>()
  for (const f of forms) {
    if (f.length === 0) continue
    const kept = f.filter((t) => !HONORIFICS.has(t))
    const tokens = kept.length > 0 ? kept : f
    const key = tokens.join(" ")
    if (!seen.has(key)) {
      seen.add(key)
      result.push(tokens)
    }
  }
  return result
}
