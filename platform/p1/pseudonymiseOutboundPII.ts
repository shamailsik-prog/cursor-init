/**
 * P1 indexed pseudonymiser (E-52(c); P4B-6). Beside `maskOutboundPII`, with the same kinds and patterns, but it
 * keeps what it takes out: every value becomes an indexed token (`⟦PARTY_1⟧`, `⟦CNIC_1⟧`, ...) and the map from
 * token to value stays with the caller, in process. One map serves the request and the response: the model sees
 * and writes tokens, and `rehydrate` turns them back into the caller's own values.
 *
 * The map holds the caller's own inputs. It is returned to the in-process caller only, and is never stored,
 * traced, logged, or put in a row, an event, an audit row, an error or a response (P4B-6).
 *
 * Every replacement runs only on the text between tokens already placed, so a token is never rewritten, and a
 * pattern or a name never matches across one.
 */

import { MASK_PATTERNS, escapeRegExp, maskOutboundPII } from "@/platform/p1/maskOutboundPII"

export type PseudonymKind = "verbatim" | "cnic" | "phone" | "email" | "iban" | "ntn" | "passport" | "party"

export type Pseudonym = Readonly<{ token: string; kind: PseudonymKind; value: string }>

/** A frozen list of frozen entries: the verbatim entries, then the pattern entries, then the party entries. */
export type PseudonymMap = readonly Pseudonym[]

/**
 * An indexed token: a kind and an index from 1, in `⟦` and `⟧`. Global, so read it with `replace`, `match` or
 * `matchAll`, which start from the beginning; never `test` or `exec`, which keep a position between calls.
 */
export const INDEXED_TOKEN = /⟦(VERBATIM|CNIC|PHONE|EMAIL|IBAN|NTN|PASSPORT|PARTY)_([1-9]\d*)⟧/g

const KINDS: readonly PseudonymKind[] = ["verbatim", "cnic", "phone", "email", "iban", "ntn", "passport", "party"]

/** A run of text that is either one whole token already placed or a gap between tokens. */
type Segment = { text: string; token: boolean }

function tokenise(text: string): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const m of text.matchAll(INDEXED_TOKEN)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), token: false })
    out.push({ text: m[0], token: true })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at), token: false })
  return out
}

/** Replaces every match of `re` (global) in the gaps only; each match becomes the token `tokenFor` gives. */
function replaceInGaps(segments: Segment[], re: RegExp, tokenFor: (match: string) => string): Segment[] {
  const out: Segment[] = []
  for (const seg of segments) {
    if (seg.token) {
      out.push(seg)
      continue
    }
    let at = 0
    for (const m of seg.text.matchAll(re)) {
      if (m.index > at) out.push({ text: seg.text.slice(at, m.index), token: false })
      out.push({ text: tokenFor(m[0]), token: true })
      at = m.index + m[0].length
    }
    if (at < seg.text.length) out.push({ text: seg.text.slice(at), token: false })
  }
  return out
}

const join = (segments: Segment[]): string => segments.map((s) => s.text).join("")

/** Longest first; equal lengths keep the order given (the sort is stable). */
const longestFirst = <T extends { value: string }>(items: readonly T[]): T[] => [...items].sort((a, b) => b.value.length - a.value.length)

/** Party names as supplied, trimmed, with the empty ones skipped (as the mask does). */
const namesOf = (partyNames: readonly string[] | undefined): string[] => (partyNames ?? []).map((n) => n.trim()).filter((n) => n.length > 0)

/**
 * Replaces, in this order:
 *  1. each verbatim string (exact match, longest first) with `⟦VERBATIM_n⟧`;
 *  2. each distinct match of the mask's patterns, pattern by pattern in the mask's order, with `⟦CNIC_n⟧`,
 *     `⟦PHONE_n⟧`, `⟦EMAIL_n⟧`, `⟦IBAN_n⟧`, `⟦NTN_n⟧` or `⟦PASSPORT_n⟧`: a value found again keeps its token;
 *  3. each supplied party name (trimmed, case-insensitive, longest first) with `⟦PARTY_n⟧`, one token per name.
 *
 * n counts from 1 per kind: `VERBATIM_n` and `PARTY_n` in the order the lists are given, a pattern's in the order
 * its values are found. The map holds every supplied name and verbatim string, present in the text or not (an
 * empty verbatim string and a blank name are skipped, as the mask skips a blank name).
 * `redactionCounts` counts every replacement, not every distinct value.
 */
export function pseudonymise(
  text: string,
  opts: { partyNames?: readonly string[]; verbatim?: readonly string[] }
): { text: string; map: PseudonymMap; redactionCounts: Record<PseudonymKind, number> } {
  const redactionCounts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<PseudonymKind, number>
  const issued = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<PseudonymKind, number>
  const map: Pseudonym[] = []
  const issue = (kind: PseudonymKind, value: string): string => {
    issued[kind] += 1
    const token = `⟦${kind.toUpperCase()}_${issued[kind]}⟧`
    map.push(Object.freeze({ token, kind, value }))
    return token
  }

  let segments = tokenise(text)

  const verbatim = (opts.verbatim ?? []).filter((v) => v.length > 0).map((value) => ({ value, token: issue("verbatim", value) }))
  for (const v of longestFirst(verbatim)) {
    segments = replaceInGaps(segments, new RegExp(escapeRegExp(v.value), "g"), () => {
      redactionCounts.verbatim += 1
      return v.token
    })
  }

  const tokenOfValue = new Map<string, string>()
  for (const { kind, re } of MASK_PATTERNS) {
    segments = replaceInGaps(segments, re, (match) => {
      const key = `${kind}\u0000${match}`
      let token = tokenOfValue.get(key)
      if (token === undefined) {
        token = issue(kind, match)
        tokenOfValue.set(key, token)
      }
      redactionCounts[kind] += 1
      return token
    })
  }

  const parties = namesOf(opts.partyNames).map((value) => ({ value, token: issue("party", value) }))
  for (const p of longestFirst(parties)) {
    segments = replaceInGaps(segments, new RegExp(escapeRegExp(p.value), "gi"), () => {
      redactionCounts.party += 1
      return p.token
    })
  }

  return { text: join(segments), map: Object.freeze(map), redactionCounts }
}

/**
 * Handles a model's answer. A mapped value becomes its token, longest first: a party value in any case, every
 * other value exactly. A token the answer already holds is left as it is, and so is text inside one. What is
 * left between tokens then gets the lossy mask, so any other pattern match becomes its lossy token (`[CNIC]`,
 * `[PHONE]`, ...), which the caller refuses. A name in `opts.partyNames` that the map does not hold becomes
 * `[PARTY]` the same way, so it never comes back in plain text; `callP1` passes the list the map was made from,
 * and then there is none.
 */
export function applyMap(text: string, map: PseudonymMap, opts: { partyNames?: readonly string[] }): string {
  let segments = tokenise(text)
  for (const p of longestFirst(map.filter((e) => e.value.length > 0))) {
    segments = replaceInGaps(segments, new RegExp(escapeRegExp(p.value), p.kind === "party" ? "gi" : "g"), () => p.token)
  }
  const held = new Set(map.filter((e) => e.kind === "party").map((e) => e.value.toLowerCase()))
  const unmapped = namesOf(opts.partyNames).filter((n) => !held.has(n.toLowerCase()))
  return segments.map((s) => (s.token ? s.text : maskOutboundPII(s.text, { partyNames: unmapped }).masked)).join("")
}

/**
 * Puts each known token's value back, in one pass: a value is inserted as it is (no replacement-pattern
 * expansion) and is never scanned again. A party name comes back as supplied. A token the map does not hold is
 * left in place, for the caller to refuse.
 */
export function rehydrate(text: string, map: PseudonymMap): string {
  const valueOf = new Map(map.map((p) => [p.token, p.value]))
  return text.replace(INDEXED_TOKEN, (token) => valueOf.get(token) ?? token)
}
