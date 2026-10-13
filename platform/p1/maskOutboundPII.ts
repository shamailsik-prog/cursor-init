/**
 * P1 outbound (and inbound) mask (Job F / Erratum O-13).
 * The masked body is the only text that may leave the firm toward a provider.
 * Classification never appears in the provider prompt.
 *
 * Party names are redacted only when supplied. Auto-NER of "Ali"/"Khan" would
 * destroy legal prose; callers must pass partyNames.
 */

export type MaskOptions = {
  partyNames?: string[]
}

export type RedactionKind =
  | "cnic"
  | "phone"
  | "party"
  | "email"
  | "iban"
  | "ntn"
  | "passport"

export type MaskResult = {
  masked: string
  redactions: { kind: RedactionKind; count: number }[]
}

export const CNIC_SEPARATED = /\b\d{5}[.\-\s]+\d{7}[.\-\s]+\d\b/g
export const CNIC_PLAIN = /\b\d{13}\b/g
// Pakistani mobile: 03XXXXXXXXX / 0300-1234567 / +92 300 1234567 / (0300) 1234567
export const PK_MOBILE = /(?:\+92|92|0)[.\s-]?3\d{2}[.\s-]?\d{7}\b/g
export const PK_MOBILE_PAREN = /\(0?3\d{2}\)[.\s-]?\d{7}\b/g
export const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
export const PK_IBAN = /\bPK\s*\d{2}\s*[A-Z]{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\b/gi
export const NTN = /\bNTN[:\s-]*\d{7}-\d\b/gi
export const PASSPORT = /\b(?:passport|ppt\.?)[:\s-]*[A-Z]{2}\d{7}\b/gi

/**
 * The patterns above, in the order `maskOutboundPII` applies them, and so the order the indexed pseudonymiser
 * numbers its tokens in (D16: `PHONE_n` follows it). tests/p1.pseudonymise.test.ts pins this sequence, the regexes
 * themselves and not only their kinds; it does not read `maskOutboundPII`'s body, so a change of order there is
 * made here by hand, and that test is then changed with it. The regexes are global, so each carries a `lastIndex`:
 * iterate a copy (`new RegExp(re.source, re.flags)`), not the shared one. Party names are not here: they are matched
 * from the caller's own list.
 */
export const MASK_PATTERNS: ReadonlyArray<{ kind: "cnic" | "phone" | "email" | "iban" | "ntn" | "passport"; re: RegExp }> = Object.freeze([
  Object.freeze({ kind: "cnic", re: CNIC_SEPARATED } as const),
  Object.freeze({ kind: "cnic", re: CNIC_PLAIN } as const),
  Object.freeze({ kind: "phone", re: PK_MOBILE_PAREN } as const),
  Object.freeze({ kind: "phone", re: PK_MOBILE } as const),
  Object.freeze({ kind: "email", re: EMAIL } as const),
  Object.freeze({ kind: "iban", re: PK_IBAN } as const),
  Object.freeze({ kind: "ntn", re: NTN } as const),
  Object.freeze({ kind: "passport", re: PASSPORT } as const),
])

/** What the mask writes in place of a match. A model answer that still holds one has lost the value it stood for. */
export const LOSSY_TOKENS: readonly string[] = Object.freeze(["[PARTY]", "[CNIC]", "[PHONE]", "[EMAIL]", "[IBAN]", "[NTN]", "[PASSPORT]"])

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function maskOutboundPII(text: string, options: MaskOptions = {}): MaskResult {
  let masked = text
  let cnic = 0
  let phone = 0
  let party = 0
  let email = 0
  let iban = 0
  let ntn = 0
  let passport = 0

  masked = masked.replace(CNIC_SEPARATED, () => {
    cnic += 1
    return "[CNIC]"
  })
  masked = masked.replace(CNIC_PLAIN, () => {
    cnic += 1
    return "[CNIC]"
  })
  masked = masked.replace(PK_MOBILE_PAREN, () => {
    phone += 1
    return "[PHONE]"
  })
  masked = masked.replace(PK_MOBILE, () => {
    phone += 1
    return "[PHONE]"
  })
  masked = masked.replace(EMAIL, () => {
    email += 1
    return "[EMAIL]"
  })
  masked = masked.replace(PK_IBAN, () => {
    iban += 1
    return "[IBAN]"
  })
  masked = masked.replace(NTN, () => {
    ntn += 1
    return "[NTN]"
  })
  masked = masked.replace(PASSPORT, () => {
    passport += 1
    return "[PASSPORT]"
  })

  for (const name of options.partyNames ?? []) {
    const trimmed = name.trim()
    if (!trimmed) continue
    const re = new RegExp(escapeRegExp(trimmed), "gi")
    masked = masked.replace(re, () => {
      party += 1
      return "[PARTY]"
    })
  }

  return {
    masked,
    redactions: [
      { kind: "cnic", count: cnic },
      { kind: "phone", count: phone },
      { kind: "party", count: party },
      { kind: "email", count: email },
      { kind: "iban", count: iban },
      { kind: "ntn", count: ntn },
      { kind: "passport", count: passport },
    ],
  }
}
