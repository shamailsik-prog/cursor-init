/**
 * Seed data for name matching (L18 §7.2): spelling-variant groups for Roman names, a word
 * table for common Urdu/Sindhi-script names, and a per-character Arabic-script to Latin
 * fallback for words the table does not know. Pure data, no behaviour.
 */

/** Each group's FIRST spelling is the canonical one every variant is rewritten to. */
export const VARIANT_GROUPS: readonly (readonly string[])[] = [
  ["muhammad", "mohammad", "mohammed", "mohd", "m"],
  ["ali", "aly"],
  ["hussain", "hussein", "husain"],
  ["ahmed", "ahmad"],
  ["shaikh", "sheikh", "shekh"]
]

/** Honorifics and titles, dropped when other tokens remain. */
export const HONORIFICS: ReadonlySet<string> = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "syed",
  "sayed",
  "haji",
  "hafiz",
  "mian",
  "ch",
  "chaudhry",
  "rana",
  "malik",
  "begum",
  "sahib",
  "sb"
])

/**
 * Arabic-script word to Roman token. Keys are written in any common spelling; the
 * normaliser folds yeh/kaf/heh variants and strips diacritics on both keys and input.
 */
export const WORD_SEED: Readonly<Record<string, string>> = {
  محمد: "muhammad",
  علی: "ali",
  علي: "ali",
  حسین: "hussain",
  احمد: "ahmed",
  شیخ: "shaikh",
  خان: "khan",
  بھٹو: "bhutto",
  میمن: "memon",
  سومرو: "soomro",
  بلوچ: "baloch",
  جوکھیو: "jokhio"
}

/** Per-character fallback, keyed by code points AFTER folding (see `foldArabic`). */
export const CHAR_TABLE: Readonly<Record<string, string>> = {
  ا: "a",
  آ: "a",
  ب: "b",
  پ: "p",
  ت: "t",
  ٹ: "t",
  ث: "s",
  ج: "j",
  چ: "ch",
  ح: "h",
  خ: "kh",
  د: "d",
  ڈ: "d",
  ذ: "z",
  ر: "r",
  ڑ: "r",
  ز: "z",
  ژ: "zh",
  س: "s",
  ش: "sh",
  ص: "s",
  ض: "z",
  ط: "t",
  ظ: "z",
  ع: "a",
  غ: "gh",
  ف: "f",
  ق: "q",
  ک: "k",
  گ: "g",
  ل: "l",
  م: "m",
  ن: "n",
  ں: "n",
  و: "w",
  ہ: "h",
  ء: "",
  ی: "y",
  // Sindhi extras
  ڄ: "j",
  ڃ: "n",
  ڇ: "ch",
  ڏ: "d",
  ڊ: "d",
  ڌ: "dh",
  ڍ: "dh",
  ڙ: "r",
  ڦ: "ph",
  ڻ: "n",
  ڱ: "ng",
  ڳ: "g",
  ڪ: "k",
  ڀ: "bh",
  ٻ: "b",
  ٺ: "th",
  ٽ: "t"
}
