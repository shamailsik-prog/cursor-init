/**
 * P1 outbound mask (Job F / Erratum O-13).
 * The masked body is the only text that may leave the firm toward a provider.
 * Classification never appears in the provider prompt.
 */

export type MaskOptions = {
  partyNames?: string[]
}

export type MaskResult = {
  masked: string
  redactions: { kind: "cnic" | "phone" | "party"; count: number }[]
}

const CNIC_DASHED = /\b\d{5}-\d{7}-\d\b/g
const CNIC_PLAIN = /\b\d{13}\b/g
// Pakistani mobile: 03XXXXXXXXX / +923XXXXXXXXX / 923XXXXXXXXX
const PK_MOBILE = /(?:\+92|92|0)3\d{9}\b/g

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function maskOutboundPII(text: string, options: MaskOptions = {}): MaskResult {
  let masked = text
  let cnic = 0
  let phone = 0
  let party = 0

  masked = masked.replace(CNIC_DASHED, () => {
    cnic += 1
    return "[CNIC]"
  })
  masked = masked.replace(CNIC_PLAIN, () => {
    cnic += 1
    return "[CNIC]"
  })
  masked = masked.replace(PK_MOBILE, () => {
    phone += 1
    return "[PHONE]"
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
    ],
  }
}
