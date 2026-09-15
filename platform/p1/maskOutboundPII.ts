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

const CNIC_SEPARATED = /\b\d{5}[.\-\s]+\d{7}[.\-\s]+\d\b/g
const CNIC_PLAIN = /\b\d{13}\b/g
// Pakistani mobile: 03XXXXXXXXX / 0300-1234567 / +92 300 1234567 / (0300) 1234567
const PK_MOBILE = /(?:\+92|92|0)[\s-]?3\d{2}[\s-]?\d{7}\b/g
const PK_MOBILE_PAREN = /\(0?3\d{2}\)[\s-]?\d{7}\b/g
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const PK_IBAN = /\bPK\d{2}[A-Z]{4}\d{16}\b/gi
const NTN = /\bNTN[:\s-]*\d{7}-\d\b/gi
const PASSPORT = /\b(?:passport|ppt\.?)[:\s-]*[A-Z]{2}\d{7}\b/gi

function escapeRegExp(value: string): string {
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
