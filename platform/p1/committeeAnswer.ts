/**
 * The committee answer contract (audit F17; spec docs/superpowers/specs/2026-10-17-f17-grounded-committee-output-design.md,
 * ruling 1). The committee-brain policy (platform/p1/systemPolicy.ts, version f17.1) asks the model for exactly one JSON
 * object:
 *
 *   { "sections": [ { "heading", "text", "claims": [ { "statement", "authorities": [ { "kind", "citation", "pinpoint"? } ] } ] } ],
 *     "caveats": [ string ] }
 *
 * `parseCommitteeAnswer` reads a (masked) answer against it. The reader is strict so that what is graded is exactly what
 * is shown: the whole text is one JSON object with nothing around it but whitespace (no code fence, no prose); no
 * object repeats a key (a later duplicate cannot hide an earlier claim from grading); no string uses a `\u` escape (an
 * escape cannot carry text the response mask did not see: every character is written as itself); nesting and size are
 * bounded. Then a zod `.strict()` schema with bounded sizes: an unknown key anywhere (`"verified": true`) breaks the
 * contract. A refusal is a fixed reason code, never text from the answer.
 *
 * An answer that fails is not an error: the caller stores and returns it as `unstructured` and advisory (ruling 1).
 */

import { z } from "zod"

export const AUTHORITY_KINDS = ["judgment", "statute", "rule", "other"] as const
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number]

/** The contract's bounds (UTF-16 code units, like `String.length`, and counts). */
export const COMMITTEE_ANSWER_LIMITS = Object.freeze({
  /** The whole answer; a 4,096-token answer is far below it. */
  maxChars: 65_536,
  /** The contract nests seven deep (root, sections, section, claims, claim, authorities, authority). */
  maxDepth: 8,
  sections: 20,
  heading: 300,
  text: 20_000,
  claimsPerSection: 30,
  statement: 4_000,
  authoritiesPerClaim: 10,
  authorities: 200,
  citation: 300,
  pinpoint: 200,
  caveats: 20,
  caveat: 2_000,
})

const L = COMMITTEE_ANSWER_LIMITS

const AuthoritySchema = z
  .object({
    kind: z.enum(AUTHORITY_KINDS),
    citation: z.string().min(1).max(L.citation),
    pinpoint: z.string().min(1).max(L.pinpoint).optional(),
  })
  .strict()

const ClaimSchema = z
  .object({
    statement: z.string().min(1).max(L.statement),
    authorities: z.array(AuthoritySchema).max(L.authoritiesPerClaim),
  })
  .strict()

const SectionSchema = z
  .object({
    heading: z.string().min(1).max(L.heading),
    text: z.string().max(L.text),
    claims: z.array(ClaimSchema).max(L.claimsPerSection),
  })
  .strict()

const CommitteeAnswerSchema = z
  .object({
    sections: z.array(SectionSchema).min(1).max(L.sections),
    caveats: z.array(z.string().min(1).max(L.caveat)).max(L.caveats),
  })
  .strict()
  .refine((a) => a.sections.reduce((n, s) => n + s.claims.reduce((m, c) => m + c.authorities.length, 0), 0) <= L.authorities)

export type CommitteeAuthority = z.infer<typeof AuthoritySchema>
export type CommitteeClaim = z.infer<typeof ClaimSchema>
export type CommitteeAnswer = z.infer<typeof CommitteeAnswerSchema>

/** Why an answer is not the contract: fixed codes, never answer text. */
export type AnswerRefusal = "too_long" | "not_json" | "not_object" | "duplicate_key" | "unicode_escape" | "too_deep" | "contract"

export type StrictJsonResult = { ok: true; value: unknown } | { ok: false; reason: Exclude<AnswerRefusal, "too_long" | "not_object" | "contract"> }

class Refused extends Error {
  constructor(readonly reason: Exclude<AnswerRefusal, "too_long" | "not_object" | "contract">) {
    super(reason)
  }
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y

/**
 * RFC 8259 JSON, stricter: a `\u` escape is refused (`unicode_escape`), a key repeated in one object is refused
 * (`duplicate_key`), nesting deeper than COMMITTEE_ANSWER_LIMITS.maxDepth is refused (`too_deep`), and anything else
 * that is not exactly one JSON value surrounded by whitespace is `not_json`. Objects have no prototype, and each key is
 * an own property, so `__proto__` is an ordinary key.
 */
export function readStrictJson(text: string): StrictJsonResult {
  let i = 0
  const fail = (): never => {
    throw new Refused("not_json")
  }
  const ws = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++
  }
  const literal = (word: string, value: unknown): unknown => {
    if (!text.startsWith(word, i)) fail()
    i += word.length
    return value
  }
  const string = (): string => {
    if (text[i] !== '"') fail()
    i++
    let out = ""
    for (;;) {
      if (i >= text.length) fail()
      const ch = text[i]!
      if (ch === '"') {
        i++
        return out
      }
      if (ch === "\\") {
        const next = text[i + 1]
        if (next === "u") throw new Refused("unicode_escape")
        if (next === undefined || !Object.hasOwn(SIMPLE_ESCAPES, next)) fail()
        out += SIMPLE_ESCAPES[next!]
        i += 2
        continue
      }
      if (ch.charCodeAt(0) < 0x20) fail()
      out += ch
      i++
    }
  }
  const value = (depth: number): unknown => {
    ws()
    const ch = text[i]
    if (ch === "{" || ch === "[") {
      if (depth + 1 > L.maxDepth) throw new Refused("too_deep")
      i++
      ws()
      if (ch === "[") {
        const arr: unknown[] = []
        if (text[i] === "]") {
          i++
          return arr
        }
        for (;;) {
          arr.push(value(depth + 1))
          ws()
          if (text[i] === ",") {
            i++
            continue
          }
          if (text[i] === "]") {
            i++
            return arr
          }
          fail()
        }
      }
      const obj = Object.create(null) as Record<string, unknown>
      if (text[i] === "}") {
        i++
        return obj
      }
      for (;;) {
        ws()
        const key = string()
        if (Object.hasOwn(obj, key)) throw new Refused("duplicate_key")
        ws()
        if (text[i] !== ":") fail()
        i++
        Object.defineProperty(obj, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true })
        ws()
        if (text[i] === ",") {
          i++
          continue
        }
        if (text[i] === "}") {
          i++
          return obj
        }
        fail()
      }
    }
    if (ch === '"') return string()
    if (ch === "t") return literal("true", true)
    if (ch === "f") return literal("false", false)
    if (ch === "n") return literal("null", null)
    NUMBER.lastIndex = i
    const m = NUMBER.exec(text)
    if (m === null) return fail()
    i += m[0].length
    return Number(m[0])
  }
  try {
    const v = value(0)
    ws()
    if (i !== text.length) fail()
    return { ok: true, value: v }
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason }
    throw err
  }
}

/** The answer read against the contract (ruling 1): the answer, or why it is not one. */
export function parseCommitteeAnswer(text: string): { ok: true; answer: CommitteeAnswer } | { ok: false; reason: AnswerRefusal } {
  if (typeof text !== "string" || text.length > L.maxChars) return { ok: false, reason: "too_long" }
  const read = readStrictJson(text)
  if (!read.ok) return read
  if (read.value === null || typeof read.value !== "object" || Array.isArray(read.value)) return { ok: false, reason: "not_object" }
  const parsed = CommitteeAnswerSchema.safeParse(read.value)
  return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: "contract" }
}
